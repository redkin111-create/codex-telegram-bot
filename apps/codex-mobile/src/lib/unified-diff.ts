export type DiffLineKind = "file" | "hunk" | "add" | "remove" | "context" | "meta";

export interface UnifiedDiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** Parse standard unified diff text without interpreting any part as HTML. */
export function parseUnifiedDiff(patch: string): UnifiedDiffLine[] {
  if (!patch) return [];
  const source = patch.replace(/\r\n/g, "\n").split("\n");
  if (source.at(-1) === "") source.pop();
  const result: UnifiedDiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;

  for (const text of source) {
    if (text.startsWith("diff --git ")) {
      oldLine = undefined;
      newLine = undefined;
      result.push({ kind: "file", text });
      continue;
    }
    if (text.startsWith("@@")) {
      const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      oldLine = range ? Number(range[1]) : undefined;
      newLine = range ? Number(range[2]) : undefined;
      result.push({ kind: "hunk", text });
      continue;
    }
    if (text.startsWith("\\")) {
      result.push({ kind: "meta", text });
      continue;
    }
    if (oldLine !== undefined && newLine !== undefined && text.startsWith("+") && !text.startsWith("+++")) {
      result.push({ kind: "add", text, newLine });
      newLine++;
      continue;
    }
    if (oldLine !== undefined && newLine !== undefined && text.startsWith("-") && !text.startsWith("---")) {
      result.push({ kind: "remove", text, oldLine });
      oldLine++;
      continue;
    }
    if (oldLine !== undefined && newLine !== undefined && text.startsWith(" ")) {
      result.push({ kind: "context", text, oldLine, newLine });
      oldLine++;
      newLine++;
      continue;
    }
    result.push({ kind: "meta", text });
  }
  return result;
}
