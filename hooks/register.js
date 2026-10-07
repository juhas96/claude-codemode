import { CORE_TOOLS, extractDeclaration, renderCoreDeclarations } from './declarations.js';

const NAME = 'mcp__codemode__execute';
const CONTROL_TOOLS = [NAME, 'ToolSearch', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];
const SANDBOX_SETTINGS = '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true}}';
const active = new Map();
// `only` mode defers these native tools behind ToolSearch, so scripts become the way to call them.
const deferred = new Set();

function describeExecute(names) {
  const declarations = renderCoreDeclarations(names);
  return `Run JavaScript in an isolated QuickJS sandbox that calls Claude Code's native and connected MCP tools. Only what the script emits reaches your context, so use it for any step that needs more than one tool call: batch reads and searches, chain search → read → edit, apply several edits, and filter large output.
Input: {code: "JavaScript", timeout_ms?: 60000, max_output_tokens?: 10000}. Top-level await and return are supported. No Node, filesystem, network, imports, or timers in scripts; use tools instead.
Globals: tools.<name>(args), tools[exactName](args), callTool(name,args), ALL_TOOLS, searchTools(query,{limit?,namespace?}), describeTool(name), describeNamespace(namespace), text(value), console.log(...values), image(base64DataUrlOrImageBlock) (no await needed), store(key,value), load(key), exit(). tools return Claude Code's structured tool result; MCP object/array JSON text is decoded consistently (other text stays text). Denied/errored calls reject. Use Promise.allSettled for independent calls. Maximum 16 simultaneous calls. Await every call: outstanding calls are cancelled when the script ends.
Only text(), console, image(), and the top-level return are included in the result. Store writes commit only on success and persist per Claude session (not inherited by a new branch). Use describeTool before unfamiliar tools. If MCP input declarations are unavailable, describeTool loads its schema through native ToolSearch for your next turn; do not guess arguments. Native and MCP calls keep Claude Code's permissions and hooks. Side effects before an error are NOT rolled back.
${declarations ? `Core tools (exact arguments and results; find others with searchTools/describeTool):\n${declarations}\n` : ''}Example:
const files = ['/abs/src/a.ts', '/abs/src/b.ts'];
await Promise.all(files.map(file_path => tools.Read({ file_path })));
const edits = await Promise.allSettled(files.map(file_path => tools.Edit({ file_path, old_string: 'oldName', new_string: 'newName', replace_all: true })));
text(edits.map((r, i) => files[i] + ': ' + (r.status === 'fulfilled' ? 'edited' : r.reason.message)));
Optional first line: // @options: {"timeout_ms":60000,"max_output_tokens":2000}`;
}

function guidance() {
  const lines = [
    '# Codemode',
    `${NAME} runs a JavaScript script that calls your other tools (\`await tools.Read({ file_path })\`) and returns only what the script emits; intermediate tool results never enter your context.`,
    '- Use it whenever a step needs more than one tool call: reading or searching several files, searching and then reading the matches, applying several edits, or editing and then running a check. One script replaces several parallel tool calls in one message, and chains of calls across turns.',
    '- Emit only what you need (the lines, fields, counts or diffs), not whole files or full command output.',
    '- A single call whose whole output you need anyway may stay direct.',
    '- In auto mode the classifier cannot review calls made by scripts: Read and read-only commands work there, but Edit, Write and state-changing Bash are denied unless approval is not needed (for example, Bash runs in Claude Code\'s sandbox with auto-allow). Make those calls directly and keep using scripts for reading, searching and filtering.',
  ];
  if (deferred.size) lines.push(`- ${[...deferred].join(', ')} are deferred: call them from scripts (\`tools.Read(...)\`) instead of loading them with ToolSearch, unless a script call of theirs was denied.`);
  return lines.join('\n');
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
  if (request.name === NAME) throw new Error('Nested codemode execution is not allowed');
  if (!catalog.some(t => t.name === request.name)) throw new Error(`Unknown tool: ${request.name}`);
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
  const result = await $.tool.call({ ...args, tool: request.name });
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

async function runScript($, input, signal) {
  validateInput(input);
  const session = await $.session.id();
  if (active.has(session)) throw new Error('Only one codemode script may run per session at a time');
  const lifecycle = new AbortController();
  active.set(session, lifecycle);
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
    const state = (await $.store.get(`session:${session}`)) ?? {};
    const worker = $.process.run(['node', `${$.plugin.root}/dist/worker.mjs`], {
      stdin: JSON.stringify({ ...input, catalog, state, token, socketPath }), timeoutMs: 310000,
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
    if (result.ok) await $.store.set(`session:${session}`, result.state);
    delete result.state;
    return result;
  } finally {
    if (!finished) cancel();
    signal.removeEventListener('abort', cancel);
    lifecycle.abort();
    // Keep the stopped scope until queued calls see it, including delayed host hooks.
    if (pending.size) void Promise.allSettled(pending).then(() => active.delete(session));
    else active.delete(session);
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

const AUTO_MODE_NOTE = `\nAuto mode: scripts can read and search (Read, read-only Bash), but Edit, Write and state-changing Bash calls from scripts are denied, because the classifier only reviews the model's own calls. Enable Claude Code's Bash sandbox so sandboxed commands from scripts run without review: ${SANDBOX_SETTINGS}`;

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
    const lifecycle = active.get(await $.session.id());
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
      return { text: `${info.runtime} ready (${info.node}). ${tools.filter(t => !t.mcp).length} native tools, ${tools.filter(t => t.mcp).length} MCP tools. The agent can use the execute tool automatically.${mode}${await autoModeNote($)}` };
    } catch (error) { return { text: `Runtime unavailable: ${error.message ?? error}. Reinstall the plugin; Node.js 22+ and a Unix host are required.` }; }
  });
}
