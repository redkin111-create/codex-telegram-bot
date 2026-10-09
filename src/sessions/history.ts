/**
 * History parser — turns a session's .jsonl event log into readable entries.
 * Reads only the tail of large logs to stay fast.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { extractProgress } from "../render/progress.js";
import type { HistoryEntry, HistoryRole } from "./types.js";

const TAIL_WINDOWS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024]; // grow until entries found

/**
 * One line of a Codex rollout `.jsonl`: `{ timestamp, type, payload }`.
 * `type` is one of session_meta | response_item | event_msg | turn_context | …
 */
interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: RolloutPayload;
}

interface RolloutPayload {
  // response_item shapes
  type?: string;
  role?: string;
  content?: unknown;
  name?: string;
  tool_name?: string;
  summary?: unknown;
  // session_meta
  id?: string;
  cwd?: string;
  [k: string]: unknown;
}

/** Parse the most recent `maxEntries` history entries from a session log. */
export function readHistory(jsonlPath: string, maxEntries = 20): HistoryEntry[] {
  for (const window of TAIL_WINDOWS) {
    const entries = parseTail(jsonlPath, window, maxEntries);
    if (entries.length > 0) return entries;
  }
  return [];
}

/** Current byte size of a session log (0 if missing). */
export function jsonlSize(jsonlPath: string): number {
  try {
    return statSync(jsonlPath).size;
  } catch {
    return 0;
  }
}

/** Last-write time of a session log in epoch ms (0 if missing). */
export function jsonlMtimeMs(jsonlPath: string): number {
  try {
    return statSync(jsonlPath).mtimeMs;
  } catch {
    return 0;
  }
}

/** The first user prompt in a session log (read from the start), or "". */
export function readFirstPrompt(jsonlPath: string, maxBytes = 256 * 1024): string {
  let size: number;
  try {
    size = statSync(jsonlPath).size;
  } catch {
    return "";
  }
  if (size === 0) return "";
  const length = Math.min(size, maxBytes);
  const fd = openSync(jsonlPath, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, 0);
    for (const line of buf.toString("utf-8").split("\n")) {
      const e = parseEventLine(line);
      if (e && e.role === "user" && e.text.trim()) return e.text;
    }
    return "";
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the entries appended after `fromByte` (the "unread" since last seen).
 * Returns the parsed entries and the new end-of-file byte offset. Codex appends
 * whole newline-terminated JSON objects, so `fromByte` is always a line boundary.
 */
export function readEntriesFrom(jsonlPath: string, fromByte: number): { entries: HistoryEntry[]; size: number } {
  const size = jsonlSize(jsonlPath);
  if (size <= fromByte || size === 0) return { entries: [], size };
  const length = size - fromByte;
  const fd = openSync(jsonlPath, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, fromByte);
    const lines = buf.toString("utf-8").split("\n").filter((l) => l.trim().length > 0);
    const entries: HistoryEntry[] = [];
    for (const line of lines) {
      const e = parseEventLine(line);
      if (e) entries.push(e);
    }
    return { entries, size };
  } finally {
    closeSync(fd);
  }
}

/** Entries suitable for a normal chat transcript; tool and system records stay internal. */
export function conversationEntries(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.filter((entry) => entry.role === "user" || entry.role === "assistant");
}

/** Read conversation messages through long stretches of tool output.
 * Previously the final 4 MiB might contain only function-call logs: the UI
 * falsely showed an empty or frozen chat even when the file kept growing.
 * Increase the window only if needed, up to a bounded 32 MiB to avoid OOM. */
export function readConversationHistory(jsonlPath: string, maxEntries = 20): HistoryEntry[] {
  if (maxEntries <= 0) return [];
  const size = jsonlSize(jsonlPath);
  if (!size) return [];
  const maxWindow = Math.min(size, 32 * 1024 * 1024);
  let window = Math.min(maxWindow, TAIL_WINDOWS.at(-1)!);
  let found: HistoryEntry[] = [];
  while (true) {
    found = conversationEntries(parseTail(jsonlPath, window, Number.MAX_SAFE_INTEGER));
    if (found.length >= maxEntries || window >= maxWindow) break;
    window = Math.min(maxWindow, window * 2);
  }
  return found.slice(-maxEntries);
}

/**
 * Event-loop-friendly transcript reader for the Mini App.
 * Sequential asynchronous IO and lightweight prefiltering avoid repeatedly
 * loading/parsing tens of MiB of tool output on Node's HTTP event loop.
 */
export async function readConversationHistoryAsync(
  jsonlPath: string,
  maxEntries = 40,
  maxBytes = 32 * 1024 * 1024,
): Promise<HistoryEntry[]> {
  if (maxEntries <= 0 || maxBytes <= 0) return [];
  const size = jsonlSize(jsonlPath);
  if (!size) return [];
  const start = Math.max(0, size - maxBytes);
  const input = createReadStream(jsonlPath, { start, end: size - 1, highWaterMark: 64 * 1024 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const entries: HistoryEntry[] = [];
  let first = true;
  try {
    for await (const line of lines) {
      if (first) {
        first = false;
        if (start > 0) continue; // discard partial first JSONL line
      }
      // The majority of a Codex rollout is tooling/reasoning; do not parse
      // giant outputs only to discard them. Retain the exact existing parser
      // for response_item records.
      if (!/"type"\s*:\s*"response_item"/.test(line) || !/"role"\s*:/.test(line)) continue;
      const entry = parseEventLine(line);
      if (!entry || (entry.role !== "assistant" && entry.role !== "user")) continue;
      entries.push(entry);
      if (entries.length > maxEntries) entries.shift();
    }
    return entries;
  } finally {
    lines.close();
    input.destroy();
  }
}

function parseTail(jsonlPath: string, window: number, maxEntries: number): HistoryEntry[] {
  const text = readTail(jsonlPath, window);
  if (!text) return [];

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const entries: HistoryEntry[] = [];

  for (const line of lines) {
    const entry = parseEventLine(line);
    if (entry) entries.push(entry);
  }

  return entries.slice(-maxEntries);
}

/** Parse a single rollout `.jsonl` line into a history entry (or undefined). */
export function parseEventLine(line: string): HistoryEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let ev: RolloutLine;
  try {
    ev = JSON.parse(trimmed) as RolloutLine;
  } catch {
    return undefined;
  }
  return toEntry(ev);
}

/** Build a compact plain-text transcript from history entries (for priming). */
export function buildTranscript(entries: HistoryEntry[], perEntryMax = 600): string {
  const label: Record<string, string> = {
    user: "User",
    assistant: "Assistant",
    tool: "Tool",
    system: "System",
  };
  return entries
    .map((e) => {
      const text = e.text.length > perEntryMax ? e.text.slice(0, perEntryMax) + " …" : e.text;
      return `${label[e.role] ?? e.role}: ${text}`;
    })
    .join("\n");
}

function toEntry(ev: RolloutLine): HistoryEntry | undefined {
  // Only conversation records (`response_item`) become history entries;
  // session_meta / turn_context / event_msg carry no user-visible transcript.
  if (ev.type !== "response_item" || !ev.payload || typeof ev.payload !== "object") return undefined;
  const p = ev.payload;
  const ts = parseTs(ev.timestamp);
  const itemType = String(p.type ?? "");

  if (itemType === "message") {
    const role = roleOf(p.role);
    if (!role) return undefined;
    const text = cleanStoredText(extractText(p.content));
    if (!text.trim()) return undefined;
    return { role, text, timestamp: ts };
  }

  if (itemType === "function_call" || itemType === "local_shell_call" || itemType === "custom_tool_call") {
    const tool = str(p.name) || str(p.tool_name) || (itemType === "local_shell_call" ? "shell" : "tool");
    return { role: "tool", text: `(${tool})`, tool, timestamp: ts };
  }

  // reasoning / function_call_output / other → not shown in history.
  return undefined;
}

/** Convert an ISO timestamp to epoch ms (undefined when absent/invalid). */
function parseTs(iso?: string): number | undefined {
  if (!iso) return undefined;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Strip progress markers and old bot-added prompt text from persisted history. */
function cleanStoredText(text: string): string {
  if (!text) return text;
  let t = extractProgress(text).cleaned;
  const oldLanguageStart = t.indexOf("Пиши пояснения и сообщения пользователю по-русски.");
  if (oldLanguageStart !== -1) {
    const oldLanguageEnd = t.indexOf("\n\n", oldLanguageStart);
    if (oldLanguageEnd !== -1) t = `${t.slice(0, oldLanguageStart)}${t.slice(oldLanguageEnd + 2)}`;
  }
  const oldProgressStart = t.indexOf("PROGRESS REPORTING IS MANDATORY ON EVERY SINGLE MESSAGE YOU SEND");
  if (oldProgressStart !== -1) t = t.slice(0, oldProgressStart).trimEnd();
  return t.trim();
}

function roleOf(role?: string): HistoryRole | undefined {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
    case "developer":
      return "system";
    default:
      return undefined;
  }
}

/** Extract text from a Codex message `content` (array of typed blocks or a
 *  plain string). Handles input_text / output_text / text / refusal blocks. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block && typeof block === "object") {
      const b = block as { type?: string; text?: unknown };
      if (typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("").trim();
}

/** Read up to `maxBytes` from the end of a file as UTF-8 text. */
function readTail(path: string, maxBytes: number): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return "";
  }
  if (size === 0) return "";

  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    let text = buf.toString("utf-8");
    // If we started mid-file, drop the partial first line.
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    closeSync(fd);
  }
}
