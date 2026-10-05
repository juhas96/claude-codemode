import { getQuickJS } from 'quickjs-emscripten';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LIMITS = Object.freeze({
  code: 262144, memory: 256 * 1024 * 1024, calls: 1024,
  concurrency: 16, output: 4 * 1024 * 1024, items: 10000,
  value: 262144, store: 1048576, rpc: 4 * 1024 * 1024,
  images: 16, imageBytes: 2 * 1024 * 1024,
});

function parseJson(text) {
  try { return JSON.parse(text); }
  catch { throw new Error('Invalid JSON'); }
}

export function options(input) {
  if (!input || typeof input.code !== 'string' || input.code.length > LIMITS.code)
    throw new Error('code must be a string of at most 262144 characters');
  let header = {};
  const match = input.code.match(/^\s*\/\/\s*@options:\s*([^\n]*)/);
  if (match) header = parseJson(match[1]);
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('Invalid @options object');
  const timeout_ms = input.timeout_ms ?? header.timeout_ms ?? 60000;
  const max_output_tokens = input.max_output_tokens ?? header.max_output_tokens ?? 10000;
  if (!Number.isInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > 300000)
    throw new Error('timeout_ms must be an integer between 100 and 300000');
  if (!Number.isInteger(max_output_tokens) || max_output_tokens < 1 || max_output_tokens > 16000)
    throw new Error('max_output_tokens must be an integer between 1 and 16000');
  return { code: input.code, timeout_ms, max_output_tokens };
}

// The same bootstrap is evaluated only in QuickJS, never in the host's JS engine.
const bootstrap = `
(() => {
  const stringify = JSON.stringify.bind(JSON), parse = JSON.parse.bind(JSON);
  const rpc = globalThis.__rpc, emit = globalThis.__emit;
  const save = globalThis.__save, read = globalThis.__load, picture = globalThis.__image;
  const initial = parse(globalThis.__catalog);
  const encode = value => {
    const json = stringify(value);
    if (json === undefined) throw new Error('Expected JSON-serializable data');
    return json;
  };
  const call = (kind, name, args) => rpc(encode({ kind, name, args }));
  const print = value => emit(typeof value === 'string' ? value : encode(value));
  const invoke = (name, args = {}) => {
    if (!args || typeof args !== 'object' || Array.isArray(args))
      return Promise.reject(new Error('Tool arguments must be an object'));
    return call('call', name, args);
  };
  const tools = Object.create(null);
  for (const tool of initial) tools[tool.name] = args => invoke(tool.name, args);
  for (const tool of initial) {
    if (tool.method && !(tool.method in tools)) tools[tool.method] = args => invoke(tool.name, args);
  }
  Object.freeze(tools);
  globalThis.tools = tools;
  globalThis.callTool = invoke;
  globalThis.ALL_TOOLS = Object.freeze(initial.map(t => Object.freeze(t)));
  globalThis.text = print;
  globalThis.console = Object.freeze(Object.fromEntries(
    ['log', 'info', 'warn', 'error', 'debug'].map(name => [name, (...args) =>
      print(args.map(v => typeof v === 'string' ? v : encode(v)).join(' '))])));
  globalThis.store = (key, value) => save(key, value === undefined ? undefined : encode(value));
  globalThis.load = key => { const json = read(key); return json === undefined ? undefined : parse(json); };
  const EXIT = Object.freeze({});
  globalThis.exit = () => { throw EXIT; };
  globalThis.__isExit = error => error === EXIT;
  globalThis.image = value => picture(encode(value));
  globalThis.describeTool = name => call('describe', name);
  globalThis.describeNamespace = namespace => call('namespace', namespace);
  globalThis.searchTools = async (query, { limit = 8, namespace } = {}) => {
    if (typeof query !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        (namespace !== undefined && typeof namespace !== 'string'))
      throw new Error('searchTools expects a string, limit between 1 and 100, and optional string namespace');
    const words = value => value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[\\p{L}\\p{N}]+/gu) || [];
    const terms = [...new Set(words(query))];
    const catalog = (await call('list')).filter(t => !namespace || t.name.startsWith('mcp__' + namespace + '__'));
    if (!terms.length) return catalog.slice(0, limit);
    const docs = catalog.map(t => {
      const name = words(t.name);
      const tokens = [...name, ...name, ...name, ...words(t.description)];
      const counts = new Map();
      for (const word of tokens) counts.set(word, (counts.get(word) || 0) + 1);
      return { t, counts, length: tokens.length, score: 0 };
    });
    const average = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length) || 1;
    for (const term of terms) {
      const frequencies = docs.map(d => [...d.counts].reduce((n, [word, count]) =>
        n + (word === term || (term.length >= 3 && word.startsWith(term)) ? count : 0), 0));
      const matches = frequencies.filter(n => n > 0).length;
      const idf = Math.log(1 + (docs.length - matches + 0.5) / (matches + 0.5));
      docs.forEach((d, i) => {
        const tf = frequencies[i];
        d.score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * d.length / average));
      });
    }
    return docs.filter(d => d.score > 0).sort((a, b) => b.score - a.score)
      .slice(0, limit).map(d => d.t);
  };
})();
`;

export async function runSandbox(input, dispatch, { signal, isCancelled = () => false, state = {}, catalog = [] } = {}) {
  const config = options(input);
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(LIMITS.memory);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + config.timeout_ms;
  runtime.setInterruptHandler(() => signal?.aborted || isCancelled() || Date.now() >= deadline);
  const vm = runtime.newContext();
  const output = [], images = [];
  let imageBytes = 0;
  const pending = new Set();
  const controller = new AbortController();
  const values = new Map(Object.entries(state).map(([k, v]) => [k, JSON.stringify(v)]));
  let wake, closed = false, calls = 0, bytes = 0, error, root;
  const notify = () => { wake?.(); wake = undefined; };
  const abort = () => { controller.abort(signal?.reason); notify(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(notify, config.timeout_ms);

  function emit(text) {
    if (output.length >= LIMITS.items || bytes + text.length > LIMITS.output)
      throw new Error('Script output limit exceeded (4 MiB or 10000 items)');
    output.push(text);
    bytes += text.length;
  }
  function guest(value) {
    if (value === undefined) return vm.undefined;
    const result = vm.evalCode(`(${JSON.stringify(value)})`);
    return vm.unwrapResult(result);
  }
  function expose(name, fn) {
    vm.newFunction(name, fn).consume(handle => vm.setProp(vm.global, name, handle));
  }
  function checkKey(handle) {
    const key = vm.dump(handle);
    if (typeof key !== 'string' || key.length > 1024) throw new Error('Store key must be a string of at most 1024 characters');
    return key;
  }
  function schedule(request) {
    if (++calls > LIMITS.calls) throw new Error('At most 1024 bridge calls per script');
    if (pending.size >= LIMITS.concurrency) throw new Error('At most 16 concurrent bridge calls');
    const deferred = vm.newPromise();
    pending.add(deferred);
    Promise.resolve().then(() => {
      if (closed || controller.signal.aborted) throw new Error('Bridge call cancelled');
      return dispatch(request, controller.signal);
    }).then(
      value => {
        if (closed) return;
        const json = JSON.stringify(value);
        if (json && Buffer.byteLength(json, 'utf8') > LIMITS.rpc) throw new Error('Tool result exceeds the 4 MiB bridge limit; narrow the query');
        const handle = guest(value);
        try { deferred.resolve(handle); } finally { if (handle !== vm.undefined) handle.dispose(); }
      },
      failure => {
        if (closed) return;
        const handle = vm.newError(String(failure?.message ?? failure));
        deferred.reject(handle);
        handle.dispose();
      },
    ).catch(failure => {
      if (!closed) {
        const handle = vm.newError(String(failure?.message ?? failure));
        deferred.reject(handle);
        handle.dispose();
      }
    }).finally(() => {
      if (!closed) { pending.delete(deferred); deferred.dispose(); notify(); }
    });
    return deferred.handle;
  }

  try {
    expose('__emit', handle => { emit(vm.getString(handle)); return vm.undefined; });
    expose('__image', handle => {
      const value = parseJson(vm.getString(handle));
      let data = value?.data, mimeType = value?.mimeType ?? value?.media_type;
      if (typeof value === 'string' || value?.image_url) {
        const match = String(typeof value === 'string' ? value : value.image_url)
          .match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([a-zA-Z0-9+/]*={0,2})$/);
        if (!match) throw new Error('image() accepts local base64 images, not remote URLs');
        [, mimeType, data] = match;
      }
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType) ||
          typeof data !== 'string' || !/^[a-zA-Z0-9+/]*={0,2}$/.test(data))
        throw new Error('Invalid image block');
      if (images.length >= LIMITS.images || imageBytes + data.length > LIMITS.imageBytes)
        throw new Error('Image limit: 2 MiB of base64 in total, 16 images per script');
      if (!Buffer.from(data, 'base64').length) throw new Error('Invalid empty image');
      images.push({ type: 'image', data, mimeType });
      imageBytes += data.length;
      return vm.undefined;
    });
    expose('__rpc', handle => {
      const json = vm.getString(handle);
      if (Buffer.byteLength(json, 'utf8') > LIMITS.rpc) throw new Error('Bridge request exceeds 4 MiB');
      return schedule(parseJson(json));
    });
    expose('__save', (keyHandle, valueHandle) => {
      const key = checkKey(keyHandle);
      const value = vm.dump(valueHandle);
      if (value === undefined) values.delete(key);
      else {
        if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > LIMITS.value) throw new Error('Store value exceeds 256 KiB');
        parseJson(value);
        const previous = values.get(key);
        values.set(key, value);
        if (Buffer.byteLength(JSON.stringify(Object.fromEntries(values)), 'utf8') > LIMITS.store) {
          if (previous === undefined) values.delete(key); else values.set(key, previous);
          throw new Error('Total store exceeds 1 MiB');
        }
      }
      return vm.undefined;
    });
    expose('__load', keyHandle => {
      const value = values.get(checkKey(keyHandle));
      return value === undefined ? vm.undefined : vm.newString(value);
    });
    vm.newString(JSON.stringify(catalog)).consume(handle => vm.setProp(vm.global, '__catalog', handle));
    vm.unwrapResult(vm.evalCode(bootstrap)).dispose();
    root = vm.unwrapResult(vm.evalCode(`(async () => {\n${config.code}\n})().catch(error => { if (!__isExit(error)) throw error; })`, 'codemode.js'));
    while (true) {
      if (signal?.aborted || isCancelled()) throw new Error('Script cancelled');
      if (Date.now() >= deadline) throw new Error('Script timed out');
      const jobs = runtime.executePendingJobs(100);
      if (jobs.error) {
        const detail = jobs.error.context.dump(jobs.error);
        jobs.error.dispose();
        throw new Error(detail?.message ?? String(detail));
      }
      const result = vm.getPromiseState(root);
      if (result.type === 'rejected') {
        const detail = vm.dump(result.error);
        result.error.dispose();
        throw new Error(detail?.message ?? String(detail));
      }
      if (result.type === 'fulfilled') {
        const value = vm.dump(result.value);
        result.value.dispose();
        if (value !== undefined) emit(typeof value === 'string' ? value : JSON.stringify(value));
        break;
      }
      if (runtime.hasPendingJob()) { await new Promise(resolve => setImmediate(resolve)); continue; }
      if (!pending.size) throw new Error('Script is waiting on an unresolved promise with no pending tools');
      await new Promise(resolve => { wake = resolve; });
    }
  } catch (failure) {
    if (signal?.aborted || isCancelled()) error = 'Script cancelled';
    else if (Date.now() >= deadline) error = 'Script timed out';
    else error = String(failure?.message ?? failure) || 'Script failed';
  } finally {
    closed = true;
    controller.abort();
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    for (const deferred of pending) deferred.dispose();
    root?.dispose();
    vm.dispose();
    runtime.dispose();
  }
  if (images.length) {
    try {
      const dir = await mkdtemp(join(tmpdir(), 'cc-codemode-images-'));
      for (const [index, picture] of images.entries()) {
        const path = join(dir, `${index}.${picture.mimeType.split('/')[1]}`);
        await writeFile(path, Buffer.from(picture.data, 'base64'), { mode: 0o600 });
        picture.path = path;
      }
    } catch (failure) { error ??= String(failure?.message ?? failure) || 'Saving images failed'; }
  }
  const full = output.join('\n');
  const maxChars = config.max_output_tokens * 4;
  let text = full, full_output_path;
  if (full.length > maxChars) {
    const dir = await mkdtemp(join(tmpdir(), 'cc-codemode-output-'));
    full_output_path = join(dir, 'output.txt');
    await writeFile(full_output_path, full, { mode: 0o600 });
    const half = Math.floor(maxChars / 2);
    text = full.slice(0, half) + '\n… output truncated …\n' + full.slice(-half);
  }
  return {
    ok: error === undefined, text, error, images: images.filter(picture => picture.path),
    truncated: !!full_output_path, full_output_path,
    state: error !== undefined ? state : Object.fromEntries([...values].map(([k, v]) => [k, parseJson(v)])),
    wall_time_ms: config.timeout_ms - Math.max(0, deadline - Date.now()),
  };
}
