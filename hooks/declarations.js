// Compact signatures inlined into the execute description, so the model can call these
// without describeTool(). Results are subsets of BuiltinToolResults in Claude Code 2.1.289's
// generated tool declarations; `brief` is the per-tool hint appended to the tool's own description.
const HUNKS = '{ oldStart: number; newStart: number; lines: string[] }[]';
export const CORE_TOOLS = {
  Read: {
    args: '{ file_path: string; offset?: number; limit?: number; pages?: string }',
    result: '{ type: "text"; file: { filePath: string; content: string; numLines: number; startLine: number; totalLines: number } }',
    note: '`file.content` is the raw text, without line-number prefixes. Images, PDFs and notebooks use another `type`.',
    brief: '`{ type, file: { filePath, content, numLines, startLine, totalLines } }`',
  },
  Edit: {
    args: '{ file_path: string; old_string: string; new_string: string; replace_all?: boolean }',
    result: `{ filePath: string; structuredPatch: ${HUNKS} }`,
    note: 'As with a direct Edit, read the file first.',
    brief: '`{ filePath, structuredPatch }`',
  },
  Write: {
    args: '{ file_path: string; content: string }',
    result: `{ type: "create" | "update"; filePath: string; structuredPatch: ${HUNKS} }`,
    brief: '`{ type, filePath, structuredPatch }`',
  },
  Bash: {
    args: '{ command: string; description?: string; timeout?: number }',
    result: '{ stdout: string; stderr: string; interrupted: boolean }',
    note: 'Filter `stdout` in the script (split, match, slice) instead of returning it whole.',
    brief: '`{ stdout, stderr, interrupted }`',
  },
  Grep: {
    args: '{ pattern: string; path?: string; glob?: string; type?: string; output_mode?: "content" | "files_with_matches" | "count"; "-i"?: boolean; "-n"?: boolean; "-C"?: number; head_limit?: number; multiline?: boolean }',
    result: '{ mode: string; filenames: string[]; numFiles: number; content?: string; numMatches?: number }',
    brief: '`{ mode, filenames, numFiles, content?, numMatches? }`',
  },
  Glob: {
    args: '{ pattern: string; path?: string }',
    result: '{ filenames: string[]; numFiles: number; truncated: boolean }',
    brief: '`{ filenames, numFiles, truncated }`',
  },
  WebFetch: {
    args: '{ url: string; prompt: string }',
    result: '{ result: string; code: number; url: string }',
    brief: '`{ result, code, url }`',
  },
};

export function renderCoreDeclarations(names) {
  const members = Object.entries(CORE_TOOLS).filter(([name]) => names.has(name)).map(([name, tool]) =>
    `${tool.note ? `  /** ${tool.note} */\n` : ''}  ${name}(args: ${tool.args}): Promise<${tool.result}>;`);
  return members.length ? `declare const tools: {\n${members.join('\n')}\n};` : '';
}

// Claude's generated declarations put tool properties at exactly four spaces.
export function extractDeclaration(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => {
    const match = line.match(/^    (?:"([^"]+)"|'([^']+)'|([\w$]+)): /);
    return match && (match[1] ?? match[2] ?? match[3]) === name;
  });
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !/^    (?:["'\w$]|\/\*\*)/.test(lines[end]) && !/^  }/.test(lines[end])) end++;
  return `type Input = ${lines.slice(start, end).join('\n').replace(/^    (?:"[^"]+"|'[^']+'|[\w$]+): /, '')};`;
}
