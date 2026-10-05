/** Conservative fallback for commandExecution items that write a named output. */
export function commandOutputPaths(command: string): string[] {
  const paths = new Set<string>();
  const add = (value: string | undefined) => {
    const path = value?.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (path && !path.startsWith("-") && !/[\r\n]/.test(path)) paths.add(path);
  };
  const captures = (pattern: RegExp, text: string) => {
    for (const match of text.matchAll(pattern)) add(match[1] || match[2] || match[3]);
  };

  // Shell redirection (including 2> and >>). The final artifact filter still
  // checks that the path is inside the workspace and has a safe file type.
  captures(/(?:^|\s)(?:\d+)?(?:>>|>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g, command);
  captures(/\b(?:Out-File|Set-Content|Add-Content)\b[^\r\n;|]{0,160}?\s-(?:FilePath|LiteralPath|Path)\s+(?:"([^"]+)"|'([^']+)'|([^\s,;&|]+))/gi, command);
  captures(/\b(?:Out-File|Set-Content|Add-Content)\s+(?:"([^"]+\.[A-Za-z0-9]{1,8})"|'([^']+\.[A-Za-z0-9]{1,8})'|([^\s,;&|]+\.[A-Za-z0-9]{1,8}))(?=\s|$)/gi, command);
  captures(/\bNew-Item\b(?=[^\r\n;|]*-ItemType\s+File\b)[^\r\n;|]{0,160}?\s-(?:LiteralPath|Path)\s+(?:"([^"]+)"|'([^']+)'|([^\s,;&|]+))/gi, command);
  captures(/\bCompress-Archive\b[^\r\n;|]{0,240}?\s-DestinationPath\s+(?:"([^"]+)"|'([^']+)'|([^\s,;&|]+))/gi, command);
  captures(/\btar(?:\.exe)?\b[^\r\n;|]{0,160}?(?:--file\s+|--file=|-[A-Za-z]*f\s*)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi, command);

  // zip's first non-option argument is the archive being written.
  for (const match of command.matchAll(/\bzip(?:\.exe)?\s+(?:-[^\s]+\s+)*(?:"([^"]+\.zip)"|'([^']+\.zip)'|([^\s;&|]+\.zip))(?=\s|$)/gi)) {
    add(match[1] || match[2] || match[3]);
  }

  return [...paths];
}
