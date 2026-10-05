# Codemode for Claude Code

A Claude Code plugin/mod that gives Claude a Pi-style JavaScript orchestration tool: batch native and MCP calls, chain their results, and return only the output the script selects.

**Requires Claude Code 2.1.289+, Node.js 22+, and macOS or Linux.** Tested against Claude Code 2.1.289. This uses the native mods API, not a second agent or an MCP proxy with its own credentials.

## Install

```sh
claude plugin marketplace add juhas96/claude-codemode
claude plugin install codemode@codemode
```

Or inside a session: `/plugin marketplace add juhas96/claude-codemode`, then `/plugin install codemode@codemode`. Start a new session or run `/reload-plugins`. No `npm install` is needed: the QuickJS runtime ships prebuilt in `dist/`.

Claude gets the agent-only tool **`mcp__codemode__execute`** automatically and chooses when to use it. Native/MCP descriptions include short batching/filtering guidance; single calls can stay direct, and user-interaction/plan tools are left alone. You give normal requests; Claude writes and executes the scripts. No user-facing run command is needed.

For an optional installation check, run `/codemode-status`.

Ask Claude to use codemode to batch or filter tool calls. Its input is `{ "code": "JavaScript source", "timeout_ms": 60000, "max_output_tokens": 10000 }`; the last two fields are optional.

### Update an existing installation

```sh
claude plugin marketplace update codemode
claude plugin update codemode@codemode
```

Restart Claude Code or run `/reload-plugins` to load the new version.

### Run from source

```sh
npm ci
npm run build
claude --plugin-dir "$PWD"
```

To use it from another project, pass this plugin's **absolute directory** to `--plugin-dir` instead. Your working directory remains that project's directory. Re-run `npm run build` after changing `runtime/` and commit the updated `dist/`.

## Scripts

The examples below show the scripts **Claude writes inside the execute tool**, not commands you need to type. The code is an async function body: top-level `await` and `return` work. Do not wrap it in a Markdown fence or an extra function.

```js
const results = await Promise.allSettled([
  tools.Read({ file_path: '/absolute/path/package.json' }),
  tools.Bash({ command: 'git status --short' }),
]);
text(results.map(r => r.status === 'fulfilled' ? r.value : r.reason.message));
```

Native tools return Claude Code's structured result. For example, `Read` exposes `result.file.content`, and `Bash` exposes `result.stdout`. Native tool output limits still apply.

### Connected MCP tools

Existing connections and authentication are reused. No duplicate MCP configuration is needed.

```js
text(await searchTools('issue search', { limit: 3 }));
```

Learn an unfamiliar tool's input before calling it:

```js
text(await describeTool('mcp__your_server__search'));
```

Then chain or parallelize calls using the exact name:

```js
const first = await tools.mcp__your_server__search({ query: 'example' });
text(first);
```

MCP tools return the structured value Claude Code exposes. When the engine returns an object or array as JSON text, codemode decodes it so cached and fresh calls behave consistently; non-JSON text stays text. This is **not guaranteed to be the original MCP `CallToolResult` envelope**.

**Schema limitation:** Claude's mods API exposes tool names/descriptions, not input schemas. `describeTool()` uses live generated TypeScript input declarations where available, with a bundled native-tool fallback from 2.1.289. If an MCP declaration is missing, it calls native `ToolSearch` to load that schema for Claude's **next model turn** and explains the limitation. Return that description, then let Claude write the following script; don't guess arguments. Marketplace installations need not have generated MCP declarations.

### Available globals

| Global | Purpose |
| --- | --- |
| `tools.<name>(args)` | Call a native or MCP tool. Tool errors and denials reject. |
| `tools[exactName](args)` / `callTool(name, args)` | Call a tool whose name is not a JavaScript identifier. |
| `ALL_TOOLS` | Initial catalog: `{name, description, mcp, method}`. |
| `searchTools(query, {limit?, namespace?})` | Refresh the catalog and rank with BM25, identifier boosts and prefix matching; default limit 8, maximum 100. |
| `describeTool(name)` | Description and input declaration when available. |
| `describeNamespace(name)` | Tools under an MCP namespace, e.g. `your_server`, or undefined if unknown. Host namespace instructions are not exposed. |
| `text(value)` / `console.log(...)` | Emit text or JSON. Other console levels work too. |
| `return value` | Emit the final value, unless undefined. |
| `image(data)` | Emit and save a base64 data URL, `{image_url}` object, or `{type:'image', data, mimeType}` block; **no await needed**. Returns undefined; validation errors throw synchronously. Remote URLs are rejected. |
| `store(key, value)` / `load(key)` | Transactional JSON state; storing undefined deletes a key. |
| `exit()` | Finish successfully without running the rest of the script. |

Names with punctuation get an underscore alias when unambiguous (`method` is null for a conflicting alias). Exact bracket names always work. `ALL_TOOLS` is a snapshot; use discovery plus `callTool()` for tools that appear after the script starts.

Only `text`, console output, images, and the top-level return are sent back to the model. Intermediate tool responses stay inside the execution. Full text output is saved privately when the selected output budget is exceeded, and its path is included in the result. Images emitted before a failure or `exit()` are saved too. Failed calls return their image paths rather than inline image blocks: Claude's custom-tool error path only accepts text; the agent can read those files afterward.

An optional first line sets defaults for that script:

```js
// @options: {"timeout_ms":120000,"max_output_tokens":2000}
```

Explicit tool input options take precedence.

## Permissions and sandbox

- **All native and MCP calls go through `$.tool.call()`**, keeping Claude Code's hooks, permission mode, allow/deny rules, and approval dialogs. The plugin deliberately does **not** use `$.mcp.call()`, whose API skips permission dialogs.
- Scripts run in a separate **QuickJS/WASM VM** with no Node APIs, filesystem, networking, timers, or module loader. A guest `Function` constructor cannot escape into Node. The VM runs on a worker thread so the bridge stays responsive; a shared atomic cancellation flag preempts CPU-bound scripts.
- The mod and a short-lived Node worker communicate over an authenticated Unix socket in a fresh `0700` directory; the socket is `0600`. The worker cleans up the bridge on normal completion, errors, and cooperative cancellation.
- Scripts cannot spoof the engine's `tool`, `tool_use_id`, `agentId`, or `consent` fields, and cannot recursively execute codemode. Tools requiring those as input fields cannot be called through this flat mods API.
- The Node worker is trusted plugin code running as your user; the **generated script** is isolated. Installing this plugin still means trusting its code and QuickJS dependency. Native `Bash` is as powerful as it normally is, subject to your permissions.
- Interruptions stop the worker and propagate through Claude's tool-call lifecycle. A scoped hook also cancels running native/MCP child dispatches on timeout, failure, or normal completion with outstanding calls. Real integration tests keep the session/server alive afterward to verify cancellation—not merely CLI shutdown. MCP servers must honor cancellation, and explicitly detached/background jobs may outlive their launching tool. Calls already started can have irreversible side effects. **Neither failure nor cancellation rolls back tool side effects.** Always await tool calls.

### Auto mode limitation

In auto mode, a script's tool calls that would need approval are **denied**. Auto mode's classifier judges the model's own tool calls against your request; a call issued from a script is not one, so the classifier gives no verdict and the call fails closed with `auto mode classifier gave no verdict`. Calls that need no approval still work: read-only tools such as `Read`, `Grep`, and `Glob`, and anything matching your allow rules.

To let scripts run specific commands in auto mode, allow them in your settings:

```json
{ "permissions": { "allow": ["Bash(git log:*)", "Bash(git status:*)", "Bash(npm test:*)"] } }
```

Codemode does not work around this, and scripts cannot supply approval themselves (see `consent` above). Other permission modes have not been tested with codemode yet.

## Limits and state

| Limit | Value |
| --- | --- |
| Script source | 256 Ki characters |
| Execution time | 60 seconds default; 100 ms–5 minutes |
| QuickJS heap / stack | 256 MiB / 1 MiB |
| Node VM-thread old-generation heap | 128 MiB |
| Concurrent bridge operations / total | 16 / 1024 per script |
| One RPC request/result | 4 MiB |
| Captured text | 4 Mi characters / 10000 items |
| Returned text | Approximate 10000 tokens by default; maximum 16000, estimated at four characters/token |
| Images | 16; 2 MiB base64 in total |
| One store value / total per session | 256 KiB / 1 MiB |

Store writes commit **only if the script succeeds**. State persists under the Claude session ID, survives resuming that session, and does not automatically copy to a newly forked session. Concurrent scripts in one session are rejected to avoid lost updates. Claude's own plugin store has a shared 4 MiB limit, so several large session stores can reach that host limit. Output/image files are retained under the OS temporary directory; remove them when no longer needed.

This implements the useful codemode orchestration features, not full codemode parity: `models` helpers, branch-history state restoration, raw-JavaScript tool input, configurable inline declaration budgets, and strict `codemode-only` tool hiding are not implemented. Claude still offers its ordinary tools, and managed policies can disable mods/process/network APIs. Windows, cloud-only runtimes, and non-CLI surfaces are not supported by this implementation.

## Tests

```sh
npm test                 # QuickJS isolation, limits, concurrency, store, private socket
npm run test:plugin      # Native mod test kit: registration, RPC, permissions, output shapes
npm run test:integration # Real native/MCP calls, cancellation, deny rules, images, resumed state
npm run test:all         # Build, everything above, and strict plugin validation
```

The automated suite invokes the agent tool through a test-only probe plugin and a local fixture MCP server: **no model requests, external services, or API charges**. A separate live-model smoke check was also performed during development to verify that Claude can call the registered tool and receives only the selected output.

## Implementation

- `hooks/register.js`: registration, agent guidance, discovery, permission-aware/cancellable tool bridge, session state.
- `runtime/worker.mjs`: private socket RPC, thread interruption and cleanup.
- `dist/`: `npm run build` output (bundled worker + QuickJS WASM) that installed plugins run.
- `runtime/sandbox.mjs`: QuickJS VM, BM25 discovery, synchronous image capture, limits and output artifacts.

References: [Claude Code mods API](https://code.claude.com/docs/en/plugins/mods/api), [mods reference](https://code.claude.com/docs/en/plugins/mods/reference), [plugin dependency loading](https://code.claude.com/docs/en/plugins/loading#node-js-package-dependencies), [QuickJS bindings](https://github.com/justjake/quickjs-emscripten).
