// Real agent-tool smoke tests via a test-only command adapter (no model requests or API charges).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [root + 'tests/fixture-mcp.mjs'] } } });
const common = ['--plugin-dir', root, '--plugin-dir', root + 'tests/probe', '--permission-mode', 'dontAsk', '--strict-mcp-config'];
async function command(code, flags = []) {
  const child = exec('claude', ['-p', '/codemode-test-probe ' + code, ...common, ...flags], { cwd: root, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  child.child.stdin.end();
  const { stdout, stderr } = await child;
  assert.equal(stderr, '');
  let result;
  try { result = JSON.parse(stdout.slice(stdout.indexOf(': ') + 2)); }
  catch { throw new Error(`Invalid probe response: ${stdout}`); }
  return (result.text ?? result.deny ?? '') + '\n' + JSON.stringify(result.result);
}

test('registered tool passes the real engine output mapper, including images and errors', async () => {
  const success = await command('text("CUSTOM_TOOL_OK"); return 42;');
  assert.match(success, /CUSTOM_TOOL_OK/);
  assert.ok(!success.includes('does not match its output shape'));
  const failed = await command('text("before"); throw Error("EXPECTED_ERROR")');
  assert.match(failed, /EXPECTED_ERROR/);
  assert.match(failed, /before/);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6PAAAAABJRU5ErkJggg==';
  const image = await command(`await image('data:image/png;base64,${png}');`);
  assert.match(image, /"type":"image"/);
  assert.ok(!image.includes('does not match its output shape'));
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

test('a real worker terminates an infinite script with partial output intact', async () => {
  const result = await command('// @options: {"timeout_ms":100}\ntext("before"); while(true){}');
  assert.match(result, /Script failed/);
  assert.match(result, /before/);
  assert.match(result, /timed out/);
});
