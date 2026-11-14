import { CORE_TOOLS, extractDeclaration, renderCoreDeclarations } from './declarations.js';

const NAME = 'mcp__codemode__execute';
const CONTROL_TOOLS = [NAME, 'ToolSearch', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];
const SANDBOX_SETTINGS = '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true}}';
// One script at a time per agent loop: parallel subagents share the session id, so the key adds the loop's agentId.
const scopes = new Map();
let guidanceApplied = false;
// `only` mode defers these native tools behind ToolSearch, so scripts become the way to call them.
const deferred = new Set();

// The description is the guidance's single source: a higher-tier plugin can bypass prompt.compose,
// but every request carries the tool list. Claude sends at most 4,096 characters of it.
export function describeExecute(names) {
  const declarations = renderCoreDeclarations(names);
  const deferredNote = deferred.size ? ` ${[...deferred].join(', ')} are deferred: call them from scripts, not through ToolSearch, unless a script call of theirs was denied.` : '';
  return `Run JavaScript in an isolated QuickJS sandbox that calls your other tools; only what the script emits enters your context.
Use it for any step that needs more than one tool call: reading or searching several files, searching then reading the matches, applying several edits, editing then running a check. One script replaces several parallel tool calls in one message and chains of calls across turns. Emit only what you need (lines, fields, counts, diffs), never whole files or full command output. A single call whose whole output you need may stay direct.${deferredNote}
Input: {code, timeout_ms?: 60000, max_output_tokens?: 10000}, or a first line // @options: {"timeout_ms":120000}. Raise timeout_ms (at most 300000) for builds, tests and browsers. Top-level await and return work. No Node, filesystem, network, imports or timers: use tools.
Globals: tools.<name>(args) and callTool(name, args) for any tool you can call, ALL_TOOLS, searchTools(query,{limit?,namespace?}), describeTool(name), describeNamespace(ns), text(value), console.log, image(base64DataUrlOrBlock), store(key,value) and load(key) (JSON kept across this agent's scripts; committed only on success), exit().
A tool resolves to Claude Code's structured result (MCP JSON text decoded). A denied or failed call rejects, and so does Bash on a non-zero exit (grep finding nothing exits 1: add \`|| true\`), so use Promise.allSettled for independent calls; at most 16 at once. Await every call: unawaited calls are cancelled when the script ends. Calls keep Claude Code's permissions and hooks; side effects before an error are not rolled back. For an MCP tool, describeTool loads its schema for your next turn: do not guess arguments.
${declarations ? `${declarations}\n` : ''}Example:
const files = ['/abs/a.ts', '/abs/b.ts'];
const edits = await Promise.allSettled(files.map(file_path => tools.Edit({ file_path, old_string: 'oldName', new_string: 'newName', replace_all: true })));
text(edits.map((r, i) => files[i] + ': ' + (r.status === 'fulfilled' ? 'edited' : r.reason.message)));`;
}

// A pointer, not a copy: the description above holds the rules.
function guidance() {
  return `# Codemode\nWhen a step needs more than one tool call, make it one ${NAME} script (its description has the API) instead of several direct calls.`;
}

function scriptHint(tool) {
  const core = CORE_TOOLS[tool];
  return core
    ? `Codemode: \`tools.${tool}(args)\` resolves to ${core.brief}; batch, chain and filter several calls in one script.`
    : `Codemode: \`await callTool(${JSON.stringify(tool)}, args)\` in a script batches, chains and filters calls; emit only needed fields.`;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { throw new Error('Invalid JSON from codemode worker'); }
}

export function catalogOf(tools) {
  const catalog = tools.filter(t => t.name !== NAME).map(t => ({
    name: t.name, description: t.description, mcp: t.mcp,
    method: t.name.replace(/[^a-zA-Z0-9_$]/g, '_'),
  }));
  const counts = new Map();
  const names = new Set(catalog.map(t => t.name));
  for (const tool of catalog) counts.set(tool.method, (counts.get(tool.method) ?? 0) + 1);
  return catalog.map(tool => ({ ...tool, method: tool.method !== tool.name &&
    (names.has(tool.method) || counts.get(tool.method) > 1) ? null : tool.method }));
}

function validateInput(input) {
  if (typeof input.code !== 'string' || input.code.length > 262144) throw new Error('code must be a string of at most 262144 characters');
  for (const [key, min, max] of [['timeout_ms', 100, 300000], ['max_output_tokens', 1, 16000]]) {
    if (input[key] !== undefined && (!Number.isInteger(input[key]) || input[key] < min || input[key] > max))
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
}

async function describe($, name, catalog) {
  if (typeof name !== 'string') throw new Error('Tool name must be a string');
  const tool = catalog.find(t => t.name === name || t.method === name);
  if (!tool) return undefined;
  const files = tool.mcp
    ? ['.claude-plugin/types/claude-code-mcp/index.d.ts']
    : ['.claude-plugin/types/claude-code-tools/index.d.ts', 'runtime/builtin-inputs.txt'];
  for (const path of files) {
    try {
      const declaration = extractDeclaration(await $.fs.read(`${$.plugin.root}/${path}`), tool.name);
      if (declaration) return { ...tool, declaration };
    } catch { /* Live types exist only in development sessions; use the bundled native fallback. */ }
  }
  if (tool.mcp) {
    const result = await $.tool.call({ tool: 'ToolSearch', query: `select:${tool.name}`, max_results: 1 });
    if (typeof result.deny === 'string' || result.isError) throw new Error(result.deny || result.text || 'ToolSearch failed');
  }
  return { ...tool, declaration: null, note: tool.mcp
    ? 'Input schema loaded via ToolSearch for the next model turn; it is not exposed by the mods API.'
    : 'Input declaration unavailable; use the native tool schema for this version.' };
}

async function handleRequest($, request, catalog, loaded) {
  if (request.kind === 'list') {
    const current = catalogOf(await $.tool.list());
    catalog.splice(0, catalog.length, ...current);
    return current;
  }
  if (request.kind === 'describe') return describe($, request.name, catalog);
  if (request.kind === 'namespace') {
    if (typeof request.name !== 'string') throw new Error('Namespace must be a string');
    const tools = catalog.filter(t => t.name.startsWith(`mcp__${request.name}__`));
    return tools.length ? { name: request.name, tools } : undefined;
  }
  if (request.kind !== 'call') throw new Error('Unknown bridge operation');
  if (typeof request.name !== 'string' || !request.name) throw new Error('Tool name must be a non-empty string');
  if (request.name === NAME) throw new Error('Nested codemode execution is not allowed');
  // $.tool.list() is the session's tool pool; a subagent can hold tools outside it (WebFetch in a
  // research agent), so an unlisted name still goes to Claude Code, which checks the calling loop's tools.
  const listed = catalog.some(t => t.name === request.name);
  const args = request.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
  for (const key of ['tool', 'tool_use_id', 'agentId', 'consent']) {
    if (Object.hasOwn(args, key)) throw new Error(`Reserved bridge argument: ${key}`);
  }
  if ((request.name.startsWith('mcp__') || deferred.has(request.name)) && !loaded.has(request.name)) {
    const found = await $.tool.call({ tool: 'ToolSearch', query: `select:${request.name}`, max_results: 1 });
    if (typeof found.deny === 'string' || found.isError) throw new Error(found.deny || found.text || 'ToolSearch failed');
    loaded.add(request.name);
  }
  // Do not use $.mcp.call: that API explicitly skips the permission dialog.
  let result;
  try { result = await $.tool.call({ ...args, tool: request.name }); }
  catch (error) {
    if (listed) throw error;
    throw new Error(`Unknown tool: ${request.name} (${error.message ?? error}). ALL_TOOLS lists this session's tools`);
  }
  if (typeof result.deny === 'string' || result.isError) {
    const message = result.deny || result.text || 'Tool failed';
    // Auto mode's classifier reviews the model's own calls only; a script's call fails closed.
    if (/no verdict/i.test(message)) throw new Error(`${message}. ${request.name} needs auto-mode review, which script calls cannot get: make this call directly${request.name === 'Bash' ? `, or have the user enable the Bash sandbox (${SANDBOX_SETTINGS})` : ''}.`);
    throw new Error(message);
  }
  const value = result.result ?? result.text;
  // Claude can return a cached MCP tool's structured result as JSON text.
  if (request.name.startsWith('mcp__') && typeof value === 'string' && /^\s*[\[{]/.test(value)) {
    try { return JSON.parse(value); } catch { /* Genuine non-JSON text stays text. */ }
  }
  return value;
}

const scopeKey = (session, agentId) => agentId ? `${session}\u0000${agentId}` : session;

// A second script from the same agent waits for the first, including its draining tool calls, instead of failing.
async function acquire(key, signal) {
  while (scopes.has(key)) {
    let onAbort;
    const aborted = new Promise(resolve => { onAbort = resolve; signal.addEventListener('abort', onAbort, { once: true }); });
    try { await Promise.race([scopes.get(key).released, aborted]); }
    finally { signal.removeEventListener('abort', onAbort); }
    if (signal.aborted) throw new Error('Script cancelled');
  }
  let release;
  const scope = { lifecycle: new AbortController(), released: new Promise(resolve => { release = resolve; }) };
  scopes.set(key, scope);
  return { lifecycle: scope.lifecycle, release: () => { if (scopes.get(key) === scope) scopes.delete(key); release(); } };
}

async function runScript($, input, signal) {
  const session = await $.session.id();
  const { lifecycle, release } = await acquire(scopeKey(session, input.agentId), signal);
  // The main loop keeps the original key, so its stored state survives the upgrade.
  const stateKey = input.agentId ? `session:${session}:agent:${input.agentId}` : `session:${session}`;
  const token = crypto.randomUUID();
  const socketPath = `/tmp/cc-codemode-${crypto.randomUUID()}/bridge.sock`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const loaded = new Set();
  const pending = new Set();
  let finished = false, transportError;
  const cancel = () => { void $.http.fetch('http://codemode/cancel', { method: 'POST', socketPath, headers }).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const catalog = catalogOf(await $.tool.list());
    const state = (await $.store.get(stateKey)) ?? {};
    const { code, timeout_ms, max_output_tokens } = input;
    const worker = $.process.run(['node', `${$.plugin.root}/dist/worker.mjs`], {
      stdin: JSON.stringify({ code, timeout_ms, max_output_tokens, catalog, state, token, socketPath }), timeoutMs: 310000,
    }).then(result => { finished = true; return result; }, error => { finished = true; throw error; });
    // Attach a rejection handler immediately, including during socket startup.
    void worker.catch(() => {});
    while (!finished && !signal.aborted) {
      const poll = $.http.fetch('http://codemode/poll', { socketPath, headers });
      let response;
      try {
        response = await Promise.race([poll, worker.then(() => null)]);
        if (!response) break;
      } catch {
        if (finished || signal.aborted) break;
        // The private socket may not exist yet while Node and WASM start.
        await $.clock.sleep(25, { signal });
        continue;
      }
      if (!response.ok) throw new Error(`Private bridge returned HTTP ${response.status}`);
      for (const request of parseJson(response.text).requests) {
        const task = handleRequest($, request, catalog, loaded).then(
          value => ({ id: request.id, value }), error => ({ id: request.id, error: String(error.message ?? error) }),
        ).then(async reply => {
          if (finished || signal.aborted) return;
          let body = JSON.stringify(reply);
          if (new TextEncoder().encode(body).length > 4 * 1024 * 1024)
            body = JSON.stringify({ id: reply.id, error: 'Tool result exceeds 4 MiB; narrow the query' });
          const sent = await $.http.fetch('http://codemode/reply', { method: 'POST', socketPath, headers, body });
          if (!sent.ok && sent.status !== 410) throw new Error(`Reply failed: HTTP ${sent.status}`);
        }).catch(error => { if (!finished && !signal.aborted) { transportError = error; cancel(); } });
        pending.add(task);
        void task.finally(() => pending.delete(task));
      }
    }
    if (signal.aborted) throw new Error('Script cancelled');
    const process = await worker;
    if (transportError) throw transportError;
    if (process.isStdoutTruncated) throw new Error('Worker response exceeded Claude Code\'s process output limit');
    const result = parseJson(process.stdout);
    if (process.exitCode && result.ok) throw new Error(process.stderr || 'Worker failed');
    if (result.ok) await $.store.set(stateKey, result.state);
    delete result.state;
    return result;
  } finally {
    if (!finished) cancel();
    signal.removeEventListener('abort', cancel);
    lifecycle.abort();
    // Keep the stopped scope until queued calls see it, including delayed host hooks.
    if (pending.size) void Promise.allSettled(pending).then(release);
    else release();
  }
}

function render(result) {
  const content = [{ type: 'text', text: [
    `Script ${result.ok ? 'completed' : 'failed'} (${result.wall_time_ms ?? 0} ms)`,
    result.text, result.full_output_path ? `Full output: ${result.full_output_path}` : '',
    ...result.images.map(image => `Image saved: ${image.path}`),
    result.error ? `Script error: ${result.error}` : '',
  ].filter(Boolean).join('\n') }];
  for (const { data, mimeType } of result.images) content.push({ type: 'image', data, mimeType });
  return { content, isError: !result.ok };
}

const AUTO_MODE_NOTE = `\nAuto mode: if a script's call is denied because the classifier gave no verdict, make that call directly, or enable Claude Code's Bash sandbox so sandboxed commands run without review: ${SANDBOX_SETTINGS}`;

async function autoModeNote($) {
  try { return (await $.config.list()).some(row => row.key === 'permissionMode' && row.value === 'auto') ? AUTO_MODE_NOTE : ''; }
  catch { return ''; }
}

export function register(on, options = {}) {
  on('tool.describe', async (_, e, next) => {
    const result = await next(e);
    if (e.tool === NAME) return { ...result, isDeferred: false };
    if (CONTROL_TOOLS.includes(e.tool)) return result;
    const description = result.description + '\n' + scriptHint(e.tool);
    return deferred.has(e.tool) ? { description, isDeferred: true } : { ...result, description };
  });
  on('prompt.compose', async (_, e, next) => {
    const result = await next(e);
    if (!e.tools.includes(NAME)) return result;
    guidanceApplied = true;
    return { sections: [...result.sections, { id: 'codemode:guidance', text: guidance(), scope: 'session' }] };
  });
  on('session.start', async ($, e, next) => {
    let names;
    try { names = new Set((await $.tool.list()).map(t => t.name)); }
    catch { names = new Set(Object.keys(CORE_TOOLS)); }
    deferred.clear();
    if (options.mode === 'only') for (const name of Object.keys(CORE_TOOLS)) if (names.has(name)) deferred.add(name);
    await $.tool.register({ name: 'execute', description: describeExecute(names), inputSchema: {
      type: 'object', properties: {
        code: { type: 'string', maxLength: 262144 },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 300000 },
        max_output_tokens: { type: 'integer', minimum: 1, maximum: 16000 },
      }, required: ['code'], additionalProperties: false,
    } });
    await $.command.register({ name: 'codemode-status', description: 'Check codemode runtime and connected tools' });
    return next(e);
  });
  on('tool.call', { tool: NAME }, async ($, e, next) => {
    try { validateInput(e); }
    catch (error) { return { deny: `Codemode: ${error.message ?? error}. Nothing ran.` }; }
    try {
      const result = await runScript($, e, next.signal);
      const { content } = render(result);
      return result.ok ? { result: content } : { deny: content[0].text };
    }
    catch (error) { return { deny: `Codemode: ${error.message ?? error}. Earlier tool side effects are not rolled back.` }; }
  });
  // Returning while next(e) is pending aborts that child dispatch in Claude.
  on('tool.call', async ($, e, next) => {
    if (next.origin.plugin !== $.plugin.name) return next(e);
    const lifecycle = scopes.get(scopeKey(await $.session.id(), e.agentId))?.lifecycle;
    if (!lifecycle) return next(e);
    if (lifecycle.signal.aborted) return { deny: 'Codemode script ended; tool call cancelled' };
    let stop;
    const cancelled = new Promise(resolve => { stop = () => resolve({ deny: 'Codemode script ended; tool call cancelled' }); });
    lifecycle.signal.addEventListener('abort', stop, { once: true });
    try { return await Promise.race([next(e), cancelled]); }
    finally { lifecycle.signal.removeEventListener('abort', stop); }
  });
  on('command.run', { command: 'codemode-status' }, async ($) => {
    const tools = catalogOf(await $.tool.list());
    try {
      const check = await $.process.run(['node', `${$.plugin.root}/dist/worker.mjs`, '--check']);
      if (check.exitCode) throw new Error(check.stderr || check.stdout);
      const info = parseJson(check.stdout);
      const mode = deferred.size ? ` Mode: only (${[...deferred].join(', ')} deferred to scripts).` : ' Mode: on.';
      const prompt = guidanceApplied ? '' : '\nSystem-prompt pointer: not applied to any request yet. A higher-tier plugin can bypass codemode\'s prompt.compose hook (`claude --debug` logs "prompt.compose bypassed by <plugin>"); the execute tool description still carries the guidance.';
      return { text: `${info.runtime} ready (${info.node}). ${tools.filter(t => !t.mcp).length} native tools, ${tools.filter(t => t.mcp).length} MCP tools. The agent can use the execute tool automatically.${mode}${prompt}${await autoModeNote($)}` };
    } catch (error) { return { text: `Runtime unavailable: ${error.message ?? error}. Reinstall the plugin; Node.js 22+ and a Unix host are required.` }; }
  });
}
