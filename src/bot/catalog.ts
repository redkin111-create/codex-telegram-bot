/** Converts Codex app-server catalogue records into safe Telegram labels. */
import { basename } from "node:path";
import type { CodexProjectSummary, CodexThreadListParams, CodexThreadSummary, CodexThreadSourceKind } from "../acp/codex-protocol.js";
import type { AcpClient } from "../acp/client.js";
import type { ProjectEntry } from "../projects/manager.js";
import { sameProjectPath } from "../projects/manager.js";
import type { SessionMeta } from "../sessions/types.js";
import type { TelegramSessionRecord } from "../sessions/telegram-registry.js";
import { cleanSessionPrompt } from "../sessions/title.js";

type ThreadReader = Pick<AcpClient, "listThreads"> & Partial<Pick<AcpClient, "listAllThreads" | "listThreadsPage">>;

export const RECENT_SESSION_LIMIT = 24;
const THREAD_PAGE_SIZE = 50;

export async function listAllCodexThreads(client: ThreadReader, params: CodexThreadListParams = {}): Promise<CodexThreadSummary[]> {
  if (client.listAllThreads) return client.listAllThreads(params);
  if (!client.listThreadsPage) return client.listThreads(params);
  const threads = new Map<string, CodexThreadSummary>();
  const seen = new Set<string>();
  let cursor = params.cursor;
  for (let page = 0; page < 1000; page++) {
    const pageParams = { ...params, ...(cursor ? { cursor } : {}) };
    if (!cursor) delete pageParams.cursor;
    const result = await client.listThreadsPage(pageParams);
    for (const thread of result.threads) threads.set(thread.id, thread);
    const next = result.nextCursor;
    if (!next || next === cursor || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return [...threads.values()];
}

/** Read newest matching threads without materializing the full history. */
export async function listRecentCodexThreads(
  client: ThreadReader,
  params: CodexThreadListParams,
  accept: (thread: CodexThreadSummary) => boolean,
  limit = RECENT_SESSION_LIMIT,
): Promise<CodexThreadSummary[]> {
  if (!client.listThreadsPage) {
    return (await client.listThreads({ ...params, limit: Math.min(params.limit ?? limit, limit) })).filter(accept).slice(0, limit);
  }
  const accepted = new Map<string, CodexThreadSummary>();
  const seen = new Set<string>();
  let cursor = params.cursor;
  for (let page = 0; page < 1000 && accepted.size < limit; page++) {
    const pageParams: CodexThreadListParams = { ...params, limit: THREAD_PAGE_SIZE };
    if (cursor) pageParams.cursor = cursor;
    else delete pageParams.cursor;
    const result = await client.listThreadsPage(pageParams);
    for (const thread of result.threads) {
      if (accept(thread)) accepted.set(thread.id, thread);
      if (accepted.size >= limit) break;
    }
    const next = result.nextCursor;
    if (accepted.size >= limit || !next || next === cursor || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return [...accepted.values()];
}

export function codexProjects(items: CodexProjectSummary[]): ProjectEntry[] {
  const entries = items.flatMap((item): ProjectEntry[] => {
    const roots = (item.roots ?? []).map((root) => typeof root === "string" ? root : root.path ?? root.root ?? "").filter(Boolean);
    if (roots.length === 0) return [];
    const recency = codexTimestampMilliseconds(item.recencyAt)
      ?? codexTimestampMilliseconds(item.updatedAt)
      ?? codexTimestampMilliseconds(item.createdAt)
      ?? 0;
    return [{
      id: item.id,
      name: item.name?.trim() || basename(roots[0]!) || "Проект",
      path: roots[0]!,
      roots,
      position: item.position,
      lastUsed: recency,
    }];
  });
  return entries.sort((a, b) => b.lastUsed - a.lastUsed || (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
}

export async function loadCodexProjects(client: Pick<AcpClient, "listProjects"> & ThreadReader): Promise<ProjectEntry[]> {
  try {
    return codexProjects(await client.listProjects());
  } catch {
    try {
      const threads = await client.listThreads({
        limit: 100,
        sortKey: "recency_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode"],
      });
      return threadsAsProjects(threads.filter(isInteractiveThread));
    } catch {
      return [];
    }
  }
}

export async function codexProjectAt(
  client: Pick<AcpClient, "listProjects"> & ThreadReader,
  cwd: string,
): Promise<ProjectEntry | undefined> {
  return (await loadCodexProjects(client))
    .find((project) => (project.roots ?? [project.path]).some((root) => sameProjectPath(root, cwd)));
}

export function threadsAsProjects(threads: CodexThreadSummary[]): ProjectEntry[] {
  const byId = new Map<string, ProjectEntry>();
  for (const thread of threads) {
    const cwd = thread.cwd?.trim();
    if (!cwd) continue;
    const key = thread.projectId || cwd.toLocaleLowerCase();
    const time = codexTimestampMilliseconds(thread.recencyAt)
      ?? codexTimestampMilliseconds(thread.updatedAt)
      ?? codexTimestampMilliseconds(thread.createdAt)
      ?? 0;
    const entry = byId.get(key);
    if (!entry) {
      byId.set(key, {
        id: thread.projectId,
        name: basename(cwd) || "Проект",
        path: cwd,
        roots: [cwd],
        lastUsed: time,
      });
    } else {
      entry.lastUsed = Math.max(entry.lastUsed, time);
      if (!entry.roots!.some((root) => sameProjectPath(root, cwd))) entry.roots!.push(cwd);
    }
  }
  return [...byId.values()].sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name));
}

export function projectContainsThread(project: ProjectEntry, thread: CodexThreadSummary): boolean {
  const cwd = thread.cwd;
  if (cwd) return (project.roots ?? [project.path]).some((root) => sameProjectPath(root, cwd));
  return Boolean(project.id && thread.projectId && project.id === thread.projectId);
}

export function sessionBelongsToProject(session: SessionMeta, project: ProjectEntry): boolean {
  if (session.cwd) return (project.roots ?? [project.path]).some((root) => sameProjectPath(session.cwd, root));
  return Boolean(project.id && session.projectId && project.id === session.projectId);
}

export function threadSourceKind(thread: CodexThreadSummary): CodexThreadSourceKind | "custom" | undefined {
  const source = thread.source;
  if (typeof source === "string") {
    const known = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];
    return known.includes(source) ? source as CodexThreadSourceKind : undefined;
  }
  if (!source || typeof source !== "object") return undefined;
  if ("subAgent" in source) return "subAgent";
  if ("custom" in source) return "custom";
  return undefined;
}

export function isInteractiveThread(thread: CodexThreadSummary): boolean {
  const source = threadSourceKind(thread);
  return source === "cli" || source === "vscode";
}

/** Telegram ownership decides visibility before Codex's session source. */
export function isVisibleThreadForChat(
  thread: CodexThreadSummary,
  allowedTelegram: ReadonlyMap<string, TelegramSessionRecord>,
  foreignTelegramIds: ReadonlySet<string>,
): boolean {
  if (foreignTelegramIds.has(thread.id)) return false;
  if (allowedTelegram.has(thread.id)) return true;
  return isInteractiveThread(thread)
    || (threadSourceKind(thread) === "appServer" && !thread.ephemeral);
}

export function threadSessionMeta(
  thread: CodexThreadSummary,
  telegram?: TelegramSessionRecord,
  projects: ProjectEntry[] = [],
  getStored?: (sessionId: string) => SessionMeta | undefined,
): SessionMeta {
  const title = safeSessionTitle(thread.name, thread.preview);
  const stored = getStored && (!title || (!telegram?.projectPath && !thread.cwd)) ? getStored(thread.id) : undefined;
  const updatedAt = codexTimestampIso(thread.recencyAt)
    ?? codexTimestampIso(thread.updatedAt)
    ?? codexTimestampIso(stored?.updatedAt)
    ?? codexTimestampIso(thread.createdAt)
    ?? new Date(0).toISOString();
  const source = threadSourceKind(thread);
  const status = typeof thread.status === "string" ? thread.status : thread.status?.type;
  const cwd = telegram?.projectPath ?? thread.cwd ?? stored?.cwd ?? "";
  const project = projects.find((item) => Boolean(cwd
    && (item.roots ?? [item.path]).some((root) => sameProjectPath(root, cwd))))
    ?? (!cwd ? projects.find((item) => item.id && item.id === thread.projectId) : undefined);
  return {
    sessionId: thread.id,
    cwd,
    title: title || safeSessionTitle(stored?.title) || "Сеанс Codex",
    createdAt: codexTimestampIso(thread.createdAt) ?? codexTimestampIso(stored?.createdAt) ?? updatedAt,
    updatedAt,
    active: status === "active" || status === "inProgress" || status === "running" || stored?.active === true,
    historyBytes: stored?.historyBytes ?? 0,
    projectId: telegram ? undefined : thread.projectId,
    projectName: telegram?.projectName ?? project?.name ?? stored?.projectName ?? (cwd ? basename(cwd) : undefined),
    source: source ?? stored?.source,
    telegramCreated: Boolean(telegram),
  };
}

export function catalogThreadSessions(
  threads: CodexThreadSummary[],
  allowedTelegram: ReadonlyMap<string, TelegramSessionRecord>,
  projects: ProjectEntry[] = [],
  foreignTelegramIds: ReadonlySet<string> = new Set(),
  getStored?: (sessionId: string) => SessionMeta | undefined,
): SessionMeta[] {
  const byId = new Map<string, SessionMeta>();
  for (const thread of threads) {
    if (!isVisibleThreadForChat(thread, allowedTelegram, foreignTelegramIds)) continue;
    const record = allowedTelegram.get(thread.id);
    byId.set(thread.id, threadSessionMeta(thread, record, projects, getStored));
  }
  return sortSessionsNewestFirst([...byId.values()]);
}

/** Keep a newly created, empty Telegram session visible before thread/list indexes it. */
export function includeRegisteredTelegramSessions(
  sessions: SessionMeta[],
  registered: Array<{ sessionId: string; record: TelegramSessionRecord }>,
  getStored: (sessionId: string) => SessionMeta | undefined,
): SessionMeta[] {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  for (const { sessionId, record } of registered) {
    if (byId.has(sessionId)) continue;
    const stored = getStored(sessionId);
    byId.set(sessionId, {
      sessionId,
      cwd: stored?.cwd || record.projectPath,
      projectId: undefined,
      projectName: record.projectName,
      title: safeSessionTitle(stored?.title) || "Новый сеанс",
      createdAt: stored?.createdAt || record.createdAt,
      updatedAt: stored?.updatedAt || record.createdAt,
      active: stored?.active ?? false,
      historyBytes: stored?.historyBytes ?? 0,
      source: "appServer",
      telegramCreated: true,
    });
  }
  return sortSessionsNewestFirst([...byId.values()]);
}

/** Converts Codex Unix seconds to milliseconds; accepts old ISO strings defensively. */
export function codexTimestampMilliseconds(value: unknown): number | undefined {
  const milliseconds = typeof value === "number"
    ? value * 1000
    : typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15 ? milliseconds : undefined;
}

function codexTimestampIso(value: unknown): string | undefined {
  const milliseconds = codexTimestampMilliseconds(value);
  if (milliseconds === undefined) return undefined;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return undefined;
  }
}

function sortSessionsNewestFirst(sessions: SessionMeta[]): SessionMeta[] {
  return sessions.sort((a, b) =>
    (codexTimestampMilliseconds(b.updatedAt) ?? 0) - (codexTimestampMilliseconds(a.updatedAt) ?? 0));
}

export function safeSessionTitle(name?: string, preview?: string): string | undefined {
  for (const candidate of [name, preview]) {
    const clean = candidate ? cleanSessionPrompt(candidate) : "";
    if (!clean || isBootstrapText(clean)) continue;
    const title = clean.replace(/^\p{Ll}/u, (letter) => letter.toLocaleUpperCase("ru-RU"));
    return title.length > 120 ? `${title.slice(0, 119).trimEnd()}…` : title;
  }
  return undefined;
}

function isBootstrapText(value: string): boolean {
  return /^#?\s*AGENTS\.md\b/i.test(value)
    || /^<\/?INSTRUCTIONS\b/i.test(value)
    || /^<[a-z][a-z0-9:_-]*(?:\s[^>]*)?>/i.test(value)
    || /^#?\s*Context from my IDE setup\b/i.test(value)
    || /^(?:you are codex|developer instructions|system instructions|repository instructions|bootstrap instructions)\b/i.test(value)
    || /^(?:here is a list of plugins|the following instructions|system prompt|developer prompt)\b/i.test(value)
    || /^\(?\s*(?:new(?:\s+(?:session|chat|conversation))?|untitled(?:\s+(?:session|conversation))?|codex\s+session|session|новый\s+(?:сеанс|чат)|новая\s+(?:сессия|переписка|беседа))(?:\s+\d+)?\s*\)?$/i.test(value)
    || /\b(?:agent|developer) instructions for (?:[a-z]:[\\/]|\/)/i.test(value);
}
