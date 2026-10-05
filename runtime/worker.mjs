import http from 'node:http';
import { mkdir, chmod, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getQuickJS } from 'quickjs-emscripten';
import { LIMITS, options, runSandbox } from './sandbox.mjs';

async function jsonInput(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('Bridge input too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid bridge JSON'); }
}

async function runInThread(input, state, catalog, dispatch, signal) {
  const cancellation = new Int32Array(new SharedArrayBuffer(4));
  const thread = new Worker(fileURLToPath(import.meta.url), {
    workerData: { input, state, catalog, cancellation: cancellation.buffer },
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
  const cancel = () => { Atomics.store(cancellation, 0, 1); thread.postMessage({ kind: 'cancel' }); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    return await new Promise((resolve, reject) => {
      thread.on('message', message => {
        if (message.kind === 'done') { resolve(message.result); return; }
        if (message.kind !== 'request') return;
        Promise.resolve().then(() => dispatch(message.request, signal)).then(
          value => thread.postMessage({ kind: 'reply', id: message.id, value }),
          error => thread.postMessage({ kind: 'reply', id: message.id, error: String(error.message ?? error) }),
        ).catch(() => {}); // The thread can have ended while its last call was settling.
      });
      thread.once('error', reject);
      thread.once('exit', code => { reject(new Error(`Sandbox thread exited before a result (code ${code})`)); });
    });
  } finally {
    signal.removeEventListener('abort', cancel);
    await thread.terminate();
  }
}

async function runThread() {
  const controller = new AbortController(), pending = new Map();
  const cancellation = new Int32Array(workerData.cancellation);
  let id = 0;
  parentPort.on('message', message => {
    if (message.kind === 'cancel') { controller.abort(); return; }
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error !== undefined) call.reject(new Error(message.error)); else call.resolve(message.value);
  });
  const dispatch = (request, signal) => new Promise((resolve, reject) => {
    const number = ++id;
    const abort = () => { pending.delete(number); reject(new Error('Bridge call cancelled')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    pending.set(number, {
      resolve: value => { signal.removeEventListener('abort', abort); resolve(value); },
      reject: error => { signal.removeEventListener('abort', abort); reject(error); },
    });
    parentPort.postMessage({ kind: 'request', id: number, request });
  });
  try {
    const result = await runSandbox(workerData.input, dispatch, {
      state: workerData.state, catalog: workerData.catalog, signal: controller.signal,
      isCancelled: () => Atomics.load(cancellation, 0) === 1,
    });
    parentPort.postMessage({ kind: 'done', result });
  } catch (error) {
    parentPort.postMessage({ kind: 'done', result: { ok: false, text: '', error: error.message } });
  } finally { parentPort.close(); }
}

export async function serve(config) {
  const opts = options(config);
  if (!/^\/tmp\/cc-codemode-[a-f0-9-]{36}\/bridge\.sock$/.test(config.socketPath) ||
      !/^[a-f0-9-]{36}$/.test(config.token)) throw new Error('Invalid private bridge configuration');
  const directory = dirname(config.socketPath);
  await mkdir(directory, { mode: 0o700 }); // Fails if anything already occupies the path.
  const controller = new AbortController();
  const queue = new Map();
  const images = [];
  let id = 0, started = false, imageDirectory, imageCount = 0, imageBytes = 0;
  let resolvePoll;
  const notify = () => { resolvePoll?.(); resolvePoll = undefined; };
  const dispatch = (request, signal) => {
    if (signal.aborted) return Promise.reject(new Error('Bridge call cancelled'));
    if (request.kind === 'image') return saveImage(request.args);
    return new Promise((resolve, reject) => {
      const number = ++id;
      const abort = () => { queue.delete(number); reject(new Error('Bridge call cancelled')); };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      queue.set(number, { request: { ...request, id: number }, sent: false,
        resolve: value => { signal.removeEventListener('abort', abort); resolve(value); },
        reject: message => { signal.removeEventListener('abort', abort); reject(new Error(message)); } });
      notify();
    });
  };
  async function saveImage(value) {
    let data, mimeType;
    if (typeof value === 'string' || value?.image_url) {
      const match = String(typeof value === 'string' ? value : value.image_url).match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([a-zA-Z0-9+/]*={0,2})$/);
      if (!match) throw new Error('image() accepts local base64 images, not remote URLs');
      [, mimeType, data] = match;
    } else { data = value?.data; mimeType = value?.mimeType ?? value?.media_type; }
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType) ||
        typeof data !== 'string' || !/^[a-zA-Z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid image block');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || imageBytes + data.length > 2 * 1024 * 1024 || imageCount >= 16)
      throw new Error('Image limit: 2 MiB of base64 in total, 16 images per script');
    const index = imageCount++;
    imageBytes += data.length;
    imageDirectory ??= mkdtemp(join(tmpdir(), 'cc-codemode-images-'));
    const path = join(await imageDirectory, `${index}.${mimeType.split('/')[1]}`);
    await writeFile(path, bytes, { mode: 0o600 });
    images.push({ type: 'image', data, mimeType, path, index });
    return { path, mimeType };
  }
  const token = Buffer.from(`Bearer ${config.token}`);
  const server = http.createServer(async (request, response) => {
    const credential = Buffer.from(request.headers.authorization ?? '');
    const send = (status, value) => {
      if (!response.destroyed) {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      }
    };
    if (credential.length !== token.length || !timingSafeEqual(credential, token)) { send(401, { error: 'Unauthorized' }); return; }
    try {
      if (request.method === 'GET' && request.url === '/poll') {
        started = true;
        if (![...queue.values()].some(r => !r.sent) && !controller.signal.aborted) {
          await new Promise(resolve => {
            const timer = setTimeout(() => { resolvePoll = undefined; resolve(); }, 100);
            resolvePoll = () => { clearTimeout(timer); resolve(); };
          });
        }
        const requests = [...queue.values()].filter(r => !r.sent);
        requests.forEach(r => { r.sent = true; });
        send(200, { requests: requests.map(r => r.request) });
      } else if (request.method === 'POST' && request.url === '/reply') {
        const reply = await jsonInput(request, LIMITS.rpc + 1024);
        const pending = queue.get(reply.id);
        if (!pending) { send(410, { error: 'Call already finished' }); return; }
        queue.delete(reply.id);
        if (typeof reply.error === 'string') pending.reject(reply.error); else pending.resolve(reply.value);
        send(200, {});
      } else if (request.method === 'POST' && request.url === '/cancel') {
        controller.abort(); notify(); send(200, {});
      } else send(404, { error: 'Unknown bridge route' });
    } catch (error) { send(400, { error: error.message }); }
  });
  let lastPoll = Date.now();
  server.on('request', () => { lastPoll = Date.now(); });
  // A dead/reloaded host must not leave an orphaned execution behind.
  const watchdog = setInterval(() => {
    if (Date.now() - lastPoll > 10000) { controller.abort(); notify(); }
  }, 1000);
  const terminate = () => { controller.abort(); notify(); };
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.socketPath, resolve);
    });
    await chmod(config.socketPath, 0o600);
    // Do not execute before the host successfully reaches the authenticated socket.
    while (!started && !controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 10));
    // Keep socket handling responsive even while guest code is CPU-bound.
    const result = await runInThread(opts, config.state, config.catalog, dispatch, controller.signal);
    return { ...result, images: images.sort((a, b) => a.index - b.index) };
  } finally {
    clearInterval(watchdog);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', terminate);
    controller.abort(); notify();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

if (!isMainThread) {
  await runThread();
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes('--check')) {
      await getQuickJS();
      process.stdout.write(JSON.stringify({ ok: true, node: process.version, runtime: 'QuickJS', protocol: 1 }));
    } else {
      const config = await jsonInput(process.stdin, 8 * 1024 * 1024);
      process.stdout.write(JSON.stringify(await serve(config)));
    }
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message, text: '', images: [] }));
    process.exitCode = 1;
  }
}
