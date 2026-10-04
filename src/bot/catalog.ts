/** Converts Codex app-server catalogue records into safe Telegram labels. */
import { basename } from "node:path";
import type { CodexProjectSummary, CodexThreadSummary, CodexThreadSourceKind } from "../acp/codex-protocol.js";
import type { AcpClient } from "../acp/client.js";
import type { ProjectEntry } from "../projects/manager.js";
import { sameProjectPath } from "../projects/manager.js";
import type { SessionMeta } from "../sessions/types.js";
import type { TelegramSessionRecord } from "../sessions/telegram-registry.js";
import { cleanSessionPrompt } from "../sessions/title.js";

type ThreadReader = Pick<AcpClient, "listThreads"> & Partial<Pick<AcpClient, "listAllThreads">>;

export async function listAllCodexThreads(client: ThreadReader, params: Parameters<AcpClient["listThreads"]>[0] = {}) {
  return client.listAllThreads ? client.listAllThreads(params) : client.listThreads(params);
}

export function codexProjects(items: CodexProjectSummary[]): ProjectEntry[] {
  const entries = items.flatMap((item): ProjectEntry[] => {
    const roots = (item.roots ?? []).map((root) => typeof root === "string" ? root : root.path ?? root.root ?? "").filter(Boolean);
    if (roots.length === 0) return [];
    const recency = Date.parse(item.recencyAt ?? item.updatedAt ?? item.createdAt ?? "");
    return [{
      id: item.id,
      name: item.name?.trim() || basename(roots[0]!) || "Проект",
      path: roots[0]!,
      roots,
      position: item.position,
      lastUsed: Number.isFinite(recency) ? recency : 0,
    }];
  });
  return entries.sort((a, b) => b.lastUsed - a.lastUsed || (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
}

export async function loadCodexProjects(client: Pick<AcpClient, "listProjects"> & ThreadReader): Promise<ProjectEntry[]> {
  try {
    return codexProjects(await client.listProjects());
  } catch {
    try {
      const threads = await listAllCodexThreads(client, {
        limit: 500,
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
    const time = Date.parse(thread.recencyAt ?? thread.updatedAt ?? thread.createdAt ?? "");
    const entry = byId.get(key);
    if (!entry) {
      byId.set(key, {
        id: thread.projectId,
        name: basename(cwd) || "Проект",
        path: cwd,
        roots: [cwd],
        lastUsed: Number.isFinite(time) ? time : 0,
      });
    } else {
      entry.lastUsed = Math.max(entry.lastUsed, Number.isFinite(time) ? time : 0);
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

export function threadSourceKind(thread: CodexThreadSummary): CodexThreadSourceKind | undefined {
  const source = thread.source;
  return typeof source === "string" ? source : source?.kind;
}

export function isInteractiveThread(thread: CodexThreadSummary): boolean {
  const source = threadSourceKind(thread);
  return source === undefined || source === "cli" || source === "vscode";
}

export function threadSessionMeta(
  thread: CodexThreadSummary,
  telegram?: TelegramSessionRecord,
  projects: ProjectEntry[] = [],
  getStored?: (sessionId: string) => SessionMeta | undefined,
): SessionMeta {
  const title = safeSessionTitle(thread.name, thread.preview);
  const stored = getStored && (!title || (!telegram?.projectPath && !thread.cwd)) ? getStored(thread.id) : undefined;
  const updatedAt = thread.recencyAt ?? thread.updatedAt ?? stored?.updatedAt ?? thread.createdAt ?? new Date(0).toISOString();
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
    createdAt: thread.createdAt ?? stored?.createdAt ?? updatedAt,
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
  interactive: CodexThreadSummary[],
  telegramThreads: CodexThreadSummary[],
  allowedTelegram: ReadonlyMap<string, TelegramSessionRecord>,
  projects: ProjectEntry[] = [],
  foreignTelegramIds: ReadonlySet<string> = new Set(),
  getStored?: (sessionId: string) => SessionMeta | undefined,
): SessionMeta[] {
  const byId = new Map<string, SessionMeta>();
  for (const thread of interactive) {
    if (isInteractiveThread(thread)) byId.set(thread.id, threadSessionMeta(thread, undefined, projects, getStored));
  }
  for (const thread of telegramThreads) {
    if (threadSourceKind(thread) !== "appServer" || thread.ephemeral || foreignTelegramIds.has(thread.id)) continue;
    const record = allowedTelegram.get(thread.id);
    byId.set(thread.id, threadSessionMeta(thread, record, projects, getStored));
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
