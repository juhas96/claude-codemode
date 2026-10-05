// Tiny stdio MCP server for integration tests; no external services or credentials.
import readline from 'node:readline';

const schema = { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false };
for await (const line of readline.createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (!Object.hasOwn(request, 'id')) continue;
  let result;
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'codemode-fixture', version: '1.0.0' } };
      break;
    case 'ping': result = {}; break;
    case 'tools/list':
      result = { tools: [
        { name: 'double', description: 'Double an integer. Input: {value: integer}.', inputSchema: schema },
        { name: 'fail', description: 'Always return an MCP error.', inputSchema: { type: 'object', properties: {} } },
      ] };
      break;
    case 'tools/call':
      if (request.params.name === 'fail') result = { isError: true, content: [{ type: 'text', text: 'fixture failed' }] };
      else if (request.params.name === 'double' && Number.isInteger(request.params.arguments?.value))
        result = { content: [{ type: 'text', text: String(request.params.arguments.value * 2) }], structuredContent: { value: request.params.arguments.value * 2 } };
      else result = { isError: true, content: [{ type: 'text', text: 'Invalid fixture arguments' }] };
      break;
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
      continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
