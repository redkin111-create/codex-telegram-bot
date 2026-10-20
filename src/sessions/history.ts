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
const MAX_TOOL_OUTPUT_CHARS = 12_000;
const TOOL_OUTPUT_SUFFIX = "\n[вывод сокращён]";

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
  includeToolOutputs = false,
  resolveParentPath?: (threadId: string) => Promise<string | undefined>,
): Promise<HistoryEntry[]> {
  if (maxEntries <= 0 || maxBytes <= 0) return [];
  if (!resolveParentPath) return (await readConversationFileAsync(jsonlPath, maxEntries, maxBytes, includeToolOutputs)).entries;

  // Codex forks keep the earlier transcript in the parent rollout and record
  // the exact byte boundary in the child's session_meta. Follow only parents
  // that the caller explicitly resolves, and never read past that boundary.
  const sources: Array<{ path: string; endByteOffset?: number }> = [{ path: jsonlPath }];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>([jsonlPath]);
  let currentPath = jsonlPath;
  for (let depth = 0; depth < 8; depth++) {
    const meta = readHistoryBase(currentPath);
    if (!meta?.id || !meta.parentId || meta.endByteOffset === undefined) break;
    seenIds.add(meta.id);
    if (seenIds.has(meta.parentId)) break;
    let parentPath: string | undefined;
    try { parentPath = await resolveParentPath(meta.parentId); } catch { break; }
    if (!parentPath || seenPaths.has(parentPath)) break;
    sources.push({ path: parentPath, endByteOffset: meta.endByteOffset });
    seenPaths.add(parentPath);
    currentPath = parentPath;
  }

  const chunks: HistoryEntry[][] = [];
  let bytesLeft = maxBytes;
  let entriesFound = 0;
  // Read newest first so the shared memory budget always favors the currently
  // open fork. Reverse the chunks before returning a chronological transcript.
  for (const source of sources) {
    if (bytesLeft <= 0 || entriesFound >= maxEntries) break;
    const read = await readConversationFileAsync(source.path, maxEntries - entriesFound, bytesLeft,
      includeToolOutputs, source.endByteOffset);
    chunks.push(read.entries);
    entriesFound += read.entries.length;
    bytesLeft -= read.bytesRead;
  }
  return chunks.reverse().flat().slice(-maxEntries);
}

function readHistoryBase(path: string): { id?: string; parentId?: string; endByteOffset?: number } | undefined {
  const size = jsonlSize(path);
  if (!size) return undefined;
  const length = Math.min(size, 64 * 1024);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, 0);
    const line = buffer.toString("utf8").split("\n", 1)[0]?.trim();
    if (!line) return undefined;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type !== "session_meta" || !event.payload || typeof event.payload !== "object") return undefined;
    const payload = event.payload as Record<string, unknown>;
    const id = typeof payload.id === "string" ? payload.id : undefined;
    const base = payload.history_base;
    if (!base || typeof base !== "object") return { id };
    const historyBase = base as Record<string, unknown>;
    const parentId = typeof historyBase.thread_id === "string" && /^[a-z0-9_-]{8,128}$/i.test(historyBase.thread_id)
      ? historyBase.thread_id : undefined;
    const endByteOffset = Number.isSafeInteger(historyBase.end_byte_offset) && (historyBase.end_byte_offset as number) >= 0
      ? historyBase.end_byte_offset as number : undefined;
    return { id, parentId, endByteOffset };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

async function readConversationFileAsync(
  jsonlPath: string,
  maxEntries: number,
  maxBytes: number,
  includeToolOutputs: boolean,
  endByteOffset?: number,
): Promise<{ entries: HistoryEntry[]; bytesRead: number }> {
  if (maxEntries <= 0 || maxBytes <= 0) return { entries: [], bytesRead: 0 };
  const fileSize = jsonlSize(jsonlPath);
  const size = endByteOffset === undefined ? fileSize : Math.min(fileSize, endByteOffset);
  if (!size) return { entries: [], bytesRead: 0 };
  const start = Math.max(0, size - maxBytes);
  const bytesRead = size - start;
  const input = createReadStream(jsonlPath, { start, end: size - 1, highWaterMark: 64 * 1024 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const entries: HistoryEntry[] = [];
  const toolNames = new Map<string, string>();
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
      if (!/"type"\s*:\s*"response_item"/.test(line)) continue;
      const toolOutput = includeToolOutputs ? parseToolOutputLine(line, toolNames) : undefined;
      if (!includeToolOutputs && !/"role"\s*:/.test(line)) continue;
      if (includeToolOutputs && !toolOutput && !/"role"\s*:/.test(line)) continue;
      const entry = toolOutput ?? parseEventLine(line);
      if (!entry || (entry.role !== "assistant" && entry.role !== "user" && !(includeToolOutputs && entry.role === "tool"))) continue;
      entries.push(entry);
      if (entries.length > maxEntries) entries.shift();
    }
    return { entries, bytesRead };
  } finally {
    lines.close();
    input.destroy();
  }
}

export interface ConversationHistorySearch {
  entries: HistoryEntry[];
  total: number;
  skippedLargeRecords: number;
  startOffset: number;
  nextOffset?: number;
}

const MAX_SEARCH_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_SEARCH_RESULT_CHARS = 8_000;

/** Search the complete rollout without retaining it in memory. The first page
 * contains the most recent matches; beforeOffset pages older matches. One
 * malformed or unusually large record cannot grow the search buffer without
 * bound. */
export async function searchConversationHistoryAsync(
  jsonlPath: string,
  query: string,
  includeToolOutputs = false,
  maxResults = 100,
  beforeOffset?: number,
): Promise<ConversationHistorySearch> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2 || needle.length > 100) throw new Error("Поисковый запрос должен содержать от 2 до 100 символов");
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 200) throw new Error("Неверный размер страницы поиска");
  if (beforeOffset !== undefined && (!Number.isSafeInteger(beforeOffset) || beforeOffset < 0)) throw new Error("Неверное смещение страницы поиска");
  const size = jsonlSize(jsonlPath);
  if (!size) {
    if (beforeOffset) throw new Error("История Codex изменилась. Повторите поиск.");
    return { entries: [], total: 0, skippedLargeRecords: 0, startOffset: 0 };
  }

  const input = createReadStream(jsonlPath, { start: 0, end: size - 1, highWaterMark: 64 * 1024 });
  const matches: HistoryEntry[] = [];
  const toolNames = new Map<string, string>();
  let total = 0;
  let skippedLargeRecords = 0;
  let pending = Buffer.alloc(0);
  let discardingLargeRecord = false;
  const pageStart = beforeOffset === undefined ? 0 : Math.max(beforeOffset - maxResults, 0);

  const inspectLine = (bytes: Buffer) => {
    if (bytes.length > MAX_SEARCH_RECORD_BYTES) { skippedLargeRecords++; return; }
    if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, -1);
    const line = bytes.toString("utf8");
    if (!line.includes("response_item")) return;
    const toolOutput = includeToolOutputs ? parseToolOutputLine(line, toolNames) : undefined;
    if (toolNames.size > 2_000) {
      const oldest = toolNames.keys().next().value;
      if (oldest) toolNames.delete(oldest);
    }
    if (!includeToolOutputs && !/"role"\s*:/.test(line)) return;
    const entry = toolOutput ?? parseEventLine(line);
    if (!entry || (entry.role !== "user" && entry.role !== "assistant" && !(includeToolOutputs && entry.role === "tool"))) return;
    if (!entry.text.toLowerCase().includes(needle)) return;
    const matchOffset = total++;
    const text = entry.text.length <= MAX_SEARCH_RESULT_CHARS
      ? entry.text
      : searchExcerpt(entry.text, needle, MAX_SEARCH_RESULT_CHARS);
    if (beforeOffset === undefined) {
      matches.push({ ...entry, text });
      if (matches.length > maxResults) matches.shift();
    } else if (matchOffset >= pageStart && matchOffset < beforeOffset) {
      matches.push({ ...entry, text });
    }
  };

  try {
    for await (const chunk of input) {
      const data = pending.length ? Buffer.concat([pending, chunk as Buffer]) : chunk as Buffer;
      let start = 0;
      let newline: number;
      while ((newline = data.indexOf(0x0a, start)) !== -1) {
        const line = data.subarray(start, newline);
        if (discardingLargeRecord) discardingLargeRecord = false;
        else inspectLine(line);
        start = newline + 1;
      }
      const tail = data.subarray(start);
      if (discardingLargeRecord) {
        pending = Buffer.alloc(0);
      } else if (tail.length > MAX_SEARCH_RECORD_BYTES) {
        skippedLargeRecords++;
        discardingLargeRecord = true;
        pending = Buffer.alloc(0);
      } else {
        pending = Buffer.from(tail);
      }
    }
    if (pending.length && !discardingLargeRecord) inspectLine(pending);
    if (beforeOffset !== undefined && beforeOffset > total) throw new Error("История Codex изменилась. Повторите поиск.");
    const startOffset = beforeOffset === undefined ? Math.max(total - matches.length, 0) : pageStart;
    return {
      entries: matches,
      total,
      skippedLargeRecords,
      startOffset,
      ...(startOffset > 0 ? { nextOffset: startOffset } : {}),
    };
  } finally {
    input.destroy();
  }
}

function searchExcerpt(text: string, needle: string, limit: number): string {
  const index = text.toLowerCase().indexOf(needle);
  const start = Math.max(0, Math.min(index - Math.floor(limit / 3), text.length - limit));
  const end = Math.min(text.length, start + limit);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}\n[показан фрагмент совпавшего сообщения]`;
}

function parseToolOutputLine(line: string, toolNames: Map<string, string>): HistoryEntry | undefined {
  let event: RolloutLine;
  try { event = JSON.parse(line) as RolloutLine; } catch { return undefined; }
  if (event.type !== "response_item" || !event.payload || typeof event.payload !== "object") return undefined;
  const payload = event.payload as RolloutPayload & { call_id?: unknown; output?: unknown; stdout?: unknown; stderr?: unknown };
  const type = String(payload.type ?? "");
  const callId = typeof payload.call_id === "string" ? payload.call_id : "";
  if (type === "function_call" || type === "local_shell_call" || type === "custom_tool_call") {
    if (callId) toolNames.set(callId, str(payload.name) || str(payload.tool_name) || "Инструмент");
    return undefined;
  }
  if (type !== "function_call_output") return undefined;
  const tool = (callId && toolNames.get(callId)) || str(payload.name) || str(payload.tool_name) || "Результат инструмента";
  const output = payload.output ?? (typeof payload.stdout === "string" || typeof payload.stderr === "string"
    ? [payload.stdout, payload.stderr].filter((value) => typeof value === "string" && value.length > 0).join("\n")
    : undefined);
  let text = toolOutputText(output);
  if (!text.trim()) return undefined;
  if (text.length > MAX_TOOL_OUTPUT_CHARS) {
    text = text.slice(0, MAX_TOOL_OUTPUT_CHARS - TOOL_OUTPUT_SUFFIX.length) + TOOL_OUTPUT_SUFFIX;
  }
  return { role: "tool", tool, text, timestamp: parseTs(event.timestamp) };
}

function toolOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const item = part as { text?: unknown; output_text?: unknown; type?: unknown };
      return typeof item.text === "string" ? item.text : typeof item.output_text === "string" ? item.output_text : "";
    }).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    const item = value as { text?: unknown; stdout?: unknown; stderr?: unknown; output?: unknown };
    if (typeof item.text === "string") return item.text;
    if (typeof item.output === "string") return item.output;
    return [item.stdout, item.stderr].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
  }
  return "";
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
