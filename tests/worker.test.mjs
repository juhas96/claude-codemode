import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { stat, rm, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { serve } from '../runtime/worker.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6PAAAAABJRU5ErkJggg==';
async function request(socketPath, token, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}` } }, async response => {
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.end(body && JSON.stringify(body));
  });
}
async function start(code) {
  const token = randomUUID(), socketPath = `/tmp/cc-codemode-${randomUUID()}/bridge.sock`;
  const result = serve({ code, timeout_ms: 1000, catalog: [{ name: 'Read', method: 'Read', description: 'Read a file', mcp: false }], token, socketPath });
  void result.catch(() => {});
  for (let i = 0; i < 100; i++) {
    try { await stat(socketPath); return { token, socketPath, result }; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw new Error('Worker did not start');
}

async function pendingCall(socketPath, token) {
  for (let i = 0; i < 30; i++) {
    const poll = await request(socketPath, token, '/poll');
    if (poll.body.requests.length) return poll.body.requests[0];
  }
  throw new Error('Worker did not request a tool');
}

test('private authenticated socket bridges tool calls and cleans itself up', async () => {
  const { token, socketPath, result } = await start('const r = await tools.Read({file_path:"example"}); return r.file.content;');
  assert.equal((await stat(dirname(socketPath))).mode & 0o777, 0o700);
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  assert.equal((await request(socketPath, 'wrong-token', '/poll')).status, 401);
  const call = await pendingCall(socketPath, token);
  assert.deepEqual(call, { id: 1, kind: 'call', name: 'Read', args: { file_path: 'example' } });
  await request(socketPath, token, '/reply', { id: 1, value: { file: { content: 'selected' } } });
  assert.equal((await result).text, 'selected');
  await assert.rejects(stat(dirname(socketPath)), { code: 'ENOENT' });
});

test('cancellation stops a worker waiting for a tool and removes its socket', async () => {
  const { token, socketPath, result } = await start('await tools.Read({});');
  await request(socketPath, token, '/poll');
  await request(socketPath, token, '/cancel', {});
  assert.equal((await result).error, 'Script cancelled');
  await assert.rejects(stat(socketPath), { code: 'ENOENT' });
});

test('cancellation preempts a CPU-bound guest without waiting for its deadline', async () => {
  const { token, socketPath, result } = await start('await tools.Read({}); text("before"); while(true){}');
  const call = await pendingCall(socketPath, token);
  await request(socketPath, token, '/reply', { id: call.id, value: {} });
  await request(socketPath, token, '/poll'); // This stays responsive while the VM is CPU-bound.
  const began = Date.now();
  await request(socketPath, token, '/cancel', {});
  const output = await result;
  assert.equal(output.error, 'Script cancelled');
  assert.equal(output.text, 'before');
  assert.ok(Date.now() - began < 500, 'Cancellation waited for the guest deadline');
});

test('images are saved privately, returned as image blocks, remote URLs rejected', async () => {
  const { token, socketPath, result } = await start(`await image('data:image/png;base64,${png}');`);
  await request(socketPath, token, '/poll').catch(() => {}); // A no-tool script may exit while the poll is open.
  const output = await result;
  assert.equal(output.ok, true);
  assert.equal(output.images[0].mimeType, 'image/png');
  assert.deepEqual(await readFile(output.images[0].path), Buffer.from(png, 'base64'));
  assert.equal((await stat(output.images[0].path)).mode & 0o777, 0o600);
  await rm(dirname(output.images[0].path), { recursive: true });
  const remote = await start('await image("https://example.com/image.png")');
  await request(remote.socketPath, remote.token, '/poll').catch(() => {});
  assert.match((await remote.result).error, /not remote URLs/);
});

test('parallel images use distinct files in a single private directory', async () => {
  const worker = await start(`const png='data:image/png;base64,${png}'; await image(png); await Promise.all([image(png),image(png)]);`);
  await request(worker.socketPath, worker.token, '/poll').catch(() => {});
  const output = await worker.result;
  assert.equal(output.ok, true);
  assert.equal(new Set(output.images.map(image => image.path)).size, 3);
  assert.equal(new Set(output.images.map(image => dirname(image.path))).size, 1);
  await rm(dirname(output.images[0].path), { recursive: true });
});

test('parallel image reservations cannot exceed the total image limit', async () => {
  const worker = await start(`const png='data:image/png;base64,${png}'; await image(png);
    const r=await Promise.allSettled(Array.from({length:16},()=>image(png)));
    text(r.filter(x=>x.status==='rejected').length);`);
  await request(worker.socketPath, worker.token, '/poll').catch(() => {});
  const output = await worker.result;
  assert.equal(output.ok, true);
  assert.equal(output.images.length, 16);
  assert.equal(output.text, '1');
  await rm(dirname(output.images[0].path), { recursive: true });
});

test('worker refuses paths outside its fresh private run directory', async () => {
  await assert.rejects(serve({ code: '', token: randomUUID(), socketPath: '/tmp/evil.sock' }), /Invalid private bridge/);
});
