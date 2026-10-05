import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { options, runSandbox } from '../runtime/sandbox.mjs';
import { extractDeclaration } from '../hooks/declarations.js';
import { catalogOf } from '../hooks/register.js';

const catalog = [
  { name: 'Read', method: 'Read', description: 'Read a local file', mcp: false },
  { name: 'mcp__test-server__double', method: 'mcp__test_server__double', description: 'Double a number', mcp: true },
];
const run = (code, dispatch = async () => {}, extra = {}) => runSandbox({ code, timeout_ms: 1000, ...extra.input }, dispatch, { catalog, ...extra });

test('top-level await, return, console, and selected output only', async () => {
  const result = await run('const r = await tools.Read({}); console.log("count", r.length); return 42;', async () => ['secret', 'secret']);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'count 2\n42');
  assert.ok(!result.text.includes('secret'));
});

test('alias collisions never silently dispatch to a different MCP server', async () => {
  const catalog = catalogOf([
    { name: 'mcp__test-server__read', description: '', mcp: true },
    { name: 'mcp__test_server__read', description: '', mcp: true },
  ]);
  assert.equal(catalog[0].method, null);
  assert.equal(catalog[1].method, 'mcp__test_server__read');
  const called = [];
  const result = await runSandbox({ code: `await tools['mcp__test-server__read']({}); await tools.mcp__test_server__read({}); return typeof tools.null;` }, async r => { called.push(r.name); }, { catalog });
  assert.equal(result.text, 'undefined');
  assert.deepEqual(called, ['mcp__test-server__read', 'mcp__test_server__read']);
});

test('MCP aliases, exact names, and callTool resolve to the actual tool name', async () => {
  const names = [];
  const result = await run(`
    text(await tools.mcp__test_server__double({value: 2}));
    text(await tools['mcp__test-server__double']({value: 3}));
    return await callTool('mcp__test-server__double', {value: 4});
  `, async r => { names.push(r.name); return r.args.value * 2; });
  assert.equal(result.text, '4\n6\n8');
  assert.deepEqual(names, Array(3).fill('mcp__test-server__double'));
});

test('independent calls execute concurrently, errors can be caught', async () => {
  let active = 0, peak = 0;
  const result = await run(`
    const r = await Promise.allSettled([tools.Read({ok:true}), tools.Read({ok:false})]);
    text(r.map(x => x.status === 'fulfilled' ? x.value : x.reason.message));
  `, async r => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    if (!r.args.ok) throw new Error('denied');
    return 'yes';
  });
  assert.equal(peak, 2);
  assert.equal(result.text, '["yes","denied"]');
});

test('discovery and namespaces return bounded data', async () => {
  const result = await run(`text((await searchTools('double',{namespace:'test-server',limit:1}))[0].name);
    text((await describeTool('Read')).declaration);
    return (await describeNamespace('test-server')).name;`, async r => {
    if (r.kind === 'list') return catalog;
    if (r.kind === 'describe') return { declaration: 'type Input = {}' };
    return { name: r.name };
  });
  assert.equal(result.text, 'mcp__test-server__double\ntype Input = {}\ntest-server');
});

test('BM25 discovery splits identifiers, rewards rare terms, and filters namespaces', async () => {
  const tools = [
    { name: 'mcp__noise__search', description: 'Search '.repeat(40), mcp: true },
    { name: 'mcp__github__searchIssues', description: 'Search issues and pull requests', mcp: true },
    { name: 'mcp__github__openPullRequest', description: 'Open a pull request', mcp: true },
    { name: 'mcp__media__generateImages', description: 'Generate pictures from a prompt', mcp: true },
  ];
  const result = await run(`
    text((await searchTools('search issues'))[0].name);
    text((await searchTools('pull request',{namespace:'github',limit:1}))[0].name);
    text((await searchTools('image'))[0].name);
    text((await searchTools('github_searchIssues'))[0].name);
    text((await searchTools('nothing-matches')).length);
    text((await searchTools('',{limit:2})).length);
    try { await searchTools('x',{namespace:42}) } catch(e) { text(e.message) }
  `, async () => tools);
  assert.equal(result.ok, true);
  const lines = result.text.split('\n');
  assert.deepEqual(lines.slice(0, 6), [
    'mcp__github__searchIssues', 'mcp__github__openPullRequest', 'mcp__media__generateImages',
    'mcp__github__searchIssues', '0', '2',
  ]);
  assert.match(lines[6], /namespace/);
});

test('BM25 discovery handles Unicode and empty namespaces without invalid scores', async () => {
  const result = await run(`
    text((await searchTools('検索'))[0].name);
    text(await searchTools('x',{namespace:'missing'}));
  `, async () => [{ name: 'mcp__test__検索', description: '日本語の検索', mcp: true }]);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'mcp__test__検索\n[]');
});

test('no Node APIs, networking, timers, imports, or host constructor escape', async () => {
  const result = await run(`return [typeof process,typeof require,typeof fetch,typeof setTimeout,
    tools.Read.constructor('return typeof process')(),typeof WebAssembly];`);
  assert.equal(result.text, '["undefined","undefined","undefined","undefined","undefined","undefined"]');
  const imported = await run('await import("node:fs")');
  assert.equal(imported.ok, false);
});

test('CPU loops, microtask loops, and stalled tools obey the deadline', async () => {
  for (const code of ['while(true){}', 'while(true) await Promise.resolve()', 'await tools.Read({})']) {
    const result = await run(code, () => new Promise(() => {}), { input: { timeout_ms: 100 } });
    assert.equal(result.ok, false, code);
    assert.equal(result.error, 'Script timed out', code);
  }
});

test('an unresolved guest promise with no tools fails instead of hanging', async () => {
  const result = await run('await new Promise(()=>{})');
  assert.match(result.error, /no pending tools/);
});

test('cancellation reaches dispatch and tears down the VM', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    const result = await run('await tools.Read({})', (_r, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => { cancelled = true; resolve('too late'); });
    }), { signal: controller.signal });
    assert.equal(result.error, 'Script cancelled');
    assert.equal(cancelled, true);
  } finally { clearTimeout(timer); }
});

test('unawaited calls are discarded and never dispatched after completion', async () => {
  let called = false;
  const result = await run('tools.Read({}); return "done"', async () => { called = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.text, 'done');
  assert.equal(called, false);
});

test('store is JSON-isolated and commits only on success, including exit()', async () => {
  const initial = { x: { value: 1 } };
  const success = await run('load("x").value=9; store("y",{v:2}); text(load("x")); exit(); text("wrong");', undefined, { state: initial });
  assert.deepEqual(success.state, { x: { value: 1 }, y: { v: 2 } });
  assert.equal(success.text, '{"value":1}');
  const failed = await run('store("x",2); text("before"); throw Error("failure");', undefined, { state: initial });
  assert.deepEqual(failed.state, initial);
  assert.equal(failed.text, 'before');
  assert.equal(failed.error, 'failure');
});

test('an empty error message is still a failure and rolls back state', async () => {
  const result = await run('store("x",2); throw Error("");', undefined, { state: { x: 1 } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Script failed');
  assert.deepEqual(result.state, { x: 1 });
});

test('store deletion and prototype-looking keys stay plain JSON', async () => {
  const result = await run('store("__proto__",{safe:true}); store("removed",undefined); return load("__proto__");', undefined, { state: { removed: 1 } });
  assert.equal(result.text, '{"safe":true}');
  assert.equal(Object.hasOwn(result.state, '__proto__'), true);
  assert.equal(Object.hasOwn(result.state, 'removed'), false);
});

test('input, state, output, RPC, memory, and concurrency limits fail safely', async () => {
  assert.throws(() => options({ code: '', timeout_ms: 0 }), /timeout_ms/);
  assert.throws(() => options({ code: '// @options: nope' }), /Invalid JSON/);
  assert.throws(() => options({ code: '// @options: null' }), /object/);
  assert.throws(() => options({ code: 'x'.repeat(262145) }), /262144/);
  for (const [code, pattern] of [
    ['store("large","x".repeat(262145))', /256 KiB/],
    ['text("x".repeat(4194305))', /output limit/],
    ['await tools.Read({x:"x".repeat(4194305)})', /4 MiB/],
    ['await Promise.all(Array.from({length:17},()=>tools.Read({})))', /16 concurrent/],
    ['new ArrayBuffer(300 * 1024 * 1024)', /memory|alloc/i],
  ]) {
    const result = await run(code, () => new Promise(() => {}));
    assert.equal(result.ok, false, code);
    assert.match(result.error, pattern, code);
  }
});

test('truncated output keeps head and tail and a private full-output file', async () => {
  const result = await run('text("start" + "x".repeat(100) + "end")', undefined, { input: { max_output_tokens: 4 } });
  assert.equal(result.truncated, true);
  assert.ok(result.text.startsWith('start'));
  assert.ok(result.text.endsWith('end'));
  assert.equal(await readFile(result.full_output_path, 'utf8'), 'start' + 'x'.repeat(100) + 'end');
  await rm(dirname(result.full_output_path), { recursive: true });
});

test('options header is supported and explicit options take precedence', () => {
  const result = options({ code: '// @options: {"timeout_ms":200,"max_output_tokens":2}\nreturn 1;', max_output_tokens: 3 });
  assert.equal(result.timeout_ms, 200);
  assert.equal(result.max_output_tokens, 3);
});

test('generated declaration extraction retains nested types without adjacent tools', () => {
  const source = '  interface Inputs {\n    "mcp__x__read": {\n      nested: {\n        value: number\n      }\n    }\n    Other: {}\n  }';
  const declaration = extractDeclaration(source, 'mcp__x__read');
  assert.match(declaration, /value: number/);
  assert.ok(!declaration.includes('Other'));
  assert.equal(extractDeclaration(source, 'missing'), undefined);
});
