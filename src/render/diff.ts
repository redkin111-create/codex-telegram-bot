/**
 * Render a unified diff for a file edit as RAW markdown (a ```diff fenced
 * block). Escaping/splitting is handled downstream by the markdown converter.
 */
import { structuredPatch } from "diff";

export interface DiffInput {
  path: string;
  oldText: string | null | undefined;
  newText: string | null | undefined;
  maxLines: number;
}

export interface DiffResult {
  block: string; // raw ```diff fenced markdown, or ""
  added: number;
  removed: number;
}

export function renderUnifiedDiff(input: DiffInput): DiffResult {
  const oldText = input.oldText ?? "";
  const newText = input.newText ?? "";
  if (oldText === newText) return { block: "", added: 0, removed: 0 };

  const patch = structuredPatch(input.path, input.path, oldText, newText, "", "", { context: 2 });
  const lines: string[] = [];
  let added = 0;
  let removed = 0;

  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const l of hunk.lines) {
      if (l.startsWith("\\")) continue; // drop "\ No newline at end of file"
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
      lines.push(l);
    }
  }
  if (lines.length === 0) return { block: "", added, removed };

  let shown = lines;
  let note = "";
  if (lines.length > input.maxLines) {
    shown = lines.slice(0, input.maxLines);
    note = `\n… +${lines.length - input.maxLines} more lines`;
  }
  return { block: "```diff\n" + shown.join("\n") + note + "\n```", added, removed };
}

/**
 * Render an ALREADY-computed unified diff string (as produced by Codex's
 * `fileChange` items) into a ```diff fenced block, counting +/- lines and
 * truncating to `maxLines`. Codex hands us the patch text directly, so unlike
 * {@link renderUnifiedDiff} we don't recompute it from old/new content.
 */
export function renderRawUnifiedDiff(unified: string, maxLines: number): DiffResult {
  if (!unified || !unified.trim()) return { block: "", added: 0, removed: 0 };
  const all = unified.replace(/\r\n/g, "\n").split("\n");
  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  for (const l of all) {
    if (l.startsWith("\\")) continue; // "\ No newline at end of file"
    // Skip the file header lines a raw patch may carry; keep hunks + content.
    if (/^(diff --git|index |--- |\+\+\+ )/.test(l)) continue;
    if (l.startsWith("+")) added++;
    else if (l.startsWith("-")) removed++;
    lines.push(l);
  }
  if (lines.length === 0) return { block: "", added, removed };

  let shown = lines;
  let note = "";
  if (lines.length > maxLines) {
    shown = lines.slice(0, maxLines);
    note = `\n… +${lines.length - maxLines} more lines`;
  }
  return { block: "```diff\n" + shown.join("\n") + note + "\n```", added, removed };
}
