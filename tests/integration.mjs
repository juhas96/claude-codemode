// Real agent-tool smoke tests via a test-only command adapter (no model requests or API charges).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [root + 'tests/fixture-mcp.mjs'] } } });
// Fail before launching -p if a hook cannot load; unknown commands can fall through to the model.
await exec('claude', ['plugin', 'validate', '--strict', root]);
await exec('claude', ['plugin', 'validate', '--strict', root + 'tests/probe']);
const common = ['--plugin-dir', root, '--plugin-dir', root + 'tests/probe', '--permission-mode', 'dontAsk', '--strict-mcp-config'];
async function command(code, flags = [], name = 'codemode-test-probe') {
  const child = exec('claude', ['-p', '/' + name + ' ' + code, ...common, ...flags], { cwd: root, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  child.child.stdin.end();
  const { stdout, stderr } = await child;
  assert.equal(stderr, '');
  let result;
  try { result = JSON.parse(stdout.slice(stdout.indexOf(': ') + 2)); }
  catch { throw new Error(`Invalid probe response: ${stdout}`); }
  return (result.text ?? result.deny ?? '') + '\n' + JSON.stringify(result);
}

test('registered tool passes the real engine output mapper, including images and errors', async () => {
  const success = await command('text("CUSTOM_TOOL_OK"); return 42;');
  assert.match(success, /CUSTOM_TOOL_OK/);
  assert.ok(!success.includes('does not match its output shape'));
  const failed = await command('text("before"); throw Error("EXPECTED_ERROR")');
  assert.match(failed, /EXPECTED_ERROR/);
  assert.match(failed, /before/);
  assert.match(failed, /"deny":|"isError":true/);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6PAAAAABJRU5ErkJggg==';
  const image = await command(`image('data:image/png;base64,${png}');`);
  assert.match(image, /"type":"image"/);
  assert.ok(!image.includes('does not match its output shape'));
  const partial = await command(`image('data:image/png;base64,${png}'); throw Error('AFTER_IMAGE');`);
  assert.match(partial, /AFTER_IMAGE/);
  assert.match(partial, /Image saved:/);
  assert.match(partial, /"deny":|"isError":true/);
});

test('installed runtime and native tool calls return only selected output', async () => {
  const result = await command(`const r = await tools.Read({file_path:${JSON.stringify(root + 'package.json')}}); text(JSON.parse(r.file.content).name);`, ['--allowedTools', 'Read']);
  assert.match(result, /Script completed/);
  assert.match(result, /codemode-plugin/);
  assert.ok(!result.includes('dependencies'));
});

test('real connected MCP discovery, parallel calls, chaining, and errors', async () => {
  const result = await command(`
    text((await searchTools('double'))[0].name);
    const r = await Promise.all([tools.mcp__fixture__double({value:10}),tools.mcp__fixture__double({value:11})]);
    text(r.map(x=>x.value));
    text((await tools.mcp__fixture__double({value:r[0].value+r[1].value})).value);
    const failed = await Promise.allSettled([tools.mcp__fixture__fail({})]);
    text(failed[0].reason.message);
  `, ['--mcp-config', fixture, '--allowedTools', 'ToolSearch', 'mcp__fixture__double', 'mcp__fixture__fail']);
  assert.match(result, /Script completed/);
  assert.match(result, /mcp__fixture__double/);
  assert.match(result, /\[20,22\]/);
  assert.match(result, /\n84\n/);
  assert.match(result, /fixture failed/);
});

// Auto mode reviews only the model's own calls; with server-side review, script edits get no verdict.
test('auto mode script edits either run or fail with a recovery hint', async () => {
  const file = root + `tests/codemode-edit-${randomUUID()}.txt`;
  await writeFile(file, 'alpha\n');
  try {
    const result = await command(`
      await tools.Read({file_path:${JSON.stringify(file)}});
      await tools.Edit({file_path:${JSON.stringify(file)}, old_string:'alpha', new_string:'gamma'});
      text('EDITED');
    `, ['--permission-mode', 'auto']);
    if (/EDITED/.test(result)) assert.equal(await readFile(file, 'utf8'), 'gamma\n');
    else {
      assert.match(result, /make this call directly/);
      assert.equal(await readFile(file, 'utf8'), 'alpha\n');
    }
  } finally { await rm(file, { force: true }); }
});

test('auto mode runs state-changing script Bash inside the auto-allowed sandbox', async () => {
  const name = `tests/codemode-sandbox-${randomUUID()}`;
  const sandbox = JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } });
  try {
    const result = await command(`await tools.Bash({command:${JSON.stringify('touch ' + name)}}); text('TOUCHED');`,
      ['--permission-mode', 'auto', '--settings', sandbox]);
    assert.match(result, /TOUCHED/);
    await access(root + name);
  } finally { await rm(root + name, { force: true }); }
});

test('Claude permission deny rules still stop nested Bash calls', async () => {
  const marker = '/tmp/codemode-denial-' + randomUUID();
  const result = await command(`await callTool('Bash',{command:${JSON.stringify('touch ' + marker)}});`, ['--allowedTools', 'Bash', '--disallowedTools', 'Bash(touch *)']);
  assert.match(result, /Script failed/);
  await assert.rejects(access(marker));
});

test('persistent per-session state resumes, and failed scripts do not commit writes', async () => {
  const session = randomUUID();
  assert.match(await command('store("count",7); return load("count");', ['--session-id', session]), /\n7/);
  assert.match(await command('store("count",99); throw Error("expected");', ['--resume', session]), /Script failed/);
  assert.match(await command('return load("count");', ['--resume', session]), /\n7/);
});

test('script timeout cancels an in-flight Bash call while the Claude session stays alive', async () => {
  const dir = '/tmp/codemode-cancel-' + randomUUID();
  await mkdir(dir, { mode: 0o700 });
  try {
    const shell = `printf started > '${dir}/started'; sleep 5; printf done > '${dir}/done'`;
    const result = await command(`// @options: {"timeout_ms":3000}\nawait tools.Bash({command:${JSON.stringify(shell)}});`,
      ['--allowedTools', 'Bash'], 'codemode-test-cancel-probe');
    assert.match(result, /Script timed out/);
    assert.equal(await readFile(dir + '/started', 'utf8'), 'started');
    await assert.rejects(access(dir + '/done'), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('normal completion cancels already-started unawaited tools', async () => {
  const dir = '/tmp/codemode-cancel-' + randomUUID();
  await mkdir(dir, { mode: 0o700 });
  try {
    const shell = `printf started > '${dir}/started'; sleep 5; printf done > '${dir}/done'`;
    const wait = `while [ ! -f '${dir}/started' ]; do sleep 0.01; done`;
    const result = await command(`
      tools.Bash({command:${JSON.stringify(shell)}});
      await tools.Bash({command:${JSON.stringify(wait)},timeout:3000});
      return "finished without awaiting the first tool";
    `, ['--allowedTools', 'Bash'], 'codemode-test-cancel-probe');
    assert.match(result, /Script completed/);
    assert.equal(await readFile(dir + '/started', 'utf8'), 'started');
    await assert.rejects(access(dir + '/done'), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('script timeout cancels an in-flight MCP call while its server stays connected', async () => {
  const dir = '/tmp/codemode-cancel-' + randomUUID();
  await mkdir(dir, { mode: 0o700 });
  const config = JSON.parse(fixture);
  config.mcpServers.fixture.env = { CODEMODE_TEST_CANCEL_DIR: dir };
  try {
    const result = await command('// @options: {"timeout_ms":3000}\nawait tools.mcp__fixture__slow({});',
      ['--mcp-config', JSON.stringify(config), '--allowedTools', 'ToolSearch', 'mcp__fixture__slow'], 'codemode-test-cancel-probe');
    assert.match(result, /Script timed out/);
    assert.equal(await readFile(dir + '/started', 'utf8'), 'started');
    assert.equal(await readFile(dir + '/cancelled', 'utf8'), 'cancelled');
    await assert.rejects(access(dir + '/done'), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a real worker terminates an infinite script with partial output intact', async () => {
  const result = await command('// @options: {"timeout_ms":100}\ntext("before"); while(true){}');
  assert.match(result, /Script failed/);
  assert.match(result, /before/);
  assert.match(result, /timed out/);
});
