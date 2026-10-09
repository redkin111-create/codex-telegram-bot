/**
 * Extract screenshot references from Codex rollout tool events without
 * forwarding raw tool output (which may contain secrets or huge logs).
 * The caller further confines delivery to real files inside its workspace.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { extractImagePaths } from "./image-return.js";

export function watchImagePathsFromEvents(lines: string[], cwd: string): string[] {
  const paths = new Set<string>();
  for (const line of lines) {
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== "object") continue;
    const event = record as { type?: string; payload?: unknown };
    if (event.type !== "response_item" && event.type !== "event_msg") continue;
    if (!event.payload || typeof event.payload !== "object") continue;
    const payload = event.payload as Record<string, unknown>;
    const fields = [payload.output, payload.content, payload.arguments, payload.input, payload.text, payload.message];
    const scan = (value: unknown, depth: number): void => {
      if (depth > 4) return;
      if (typeof value === "string") {
        if (value.length > 150_000 || !/\.(?:png|jpe?g|webp|gif|bmp)/i.test(value)) return;
        for (const path of extractImagePaths(value, cwd)) paths.add(path);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 30)) scan(item, depth + 1);
      } else if (value && typeof value === "object") {
        for (const v of Object.values(value as Record<string, unknown>).slice(0, 30)) scan(v, depth + 1);
      }
    };
    for (const field of fields) scan(field, 0);
  }
  return [...paths];
}

/** Recent local screenshot references, useful when Watch is opened after a
 * Codex turn has finished. Read a bounded log tail, never the whole rollout.
 */
export function recentWatchImagePaths(jsonlPath: string, cwd: string, maxBytes = 2 * 1024 * 1024): string[] {
  let fd: number | undefined;
  try {
    const size = statSync(jsonlPath).size;
    if (size === 0) return [];
    const offset = Math.max(0, size - maxBytes);
    const len = size - offset;
    const buffer = Buffer.alloc(len);
    fd = openSync(jsonlPath, "r");
    readSync(fd, buffer, 0, len, offset);
    let text = buffer.toString("utf8");
    if (offset) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split("\n");
    if (!text.endsWith("\n")) lines.pop();
    return watchImagePathsFromEvents(lines, cwd);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
