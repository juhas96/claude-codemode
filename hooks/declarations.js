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
