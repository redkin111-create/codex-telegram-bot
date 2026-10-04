import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Context } from "grammy";
import type { CodexProjectSummary, CodexThreadSummary } from "../src/acp/codex-protocol.js";
import { catalogThreadSessions, codexProjectAt, codexProjects, codexTimestampMilliseconds, includeRegisteredTelegramSessions, isInteractiveThread, listRecentCodexThreads, loadCodexProjects, projectContainsThread, safeSessionTitle, sessionBelongsToProject, threadSessionMeta, threadSourceKind, threadsAsProjects } from "../src/bot/catalog.js";
import { sessionPage, showSessions } from "../src/bot/handlers/sessions.js";
import { cleanSessionPrompt } from "../src/sessions/title.js";
import { callbackDataFits } from "../src/bot/menu/paging.js";
import { ProjectManager } from "../src/projects/manager.js";
import { formatDiagnostics, runtimeIdentity } from "../src/bot/handlers/diagnostics.js";
import { cleanPrompt, runningSessionTitle } from "../src/bot/handlers/running.js";
import { actionFromTaskXml, sameWindowsCheckout, sourceFromTaskAction, staleTargetMessage } from "../src/service/windows-target.js";
import type { SessionMeta } from "../src/sessions/types.js";
import type { TelegramSessionRecord } from "../src/sessions/telegram-registry.js";
import { MenuCache, type BotDeps } from "../src/bot/deps.js";

function thread(id: string, source: CodexThreadSummary["source"], extra: Partial<CodexThreadSummary> = {}): CodexThreadSummary {
  return { id, source, name: id, cwd: "C:\\work\\toy", createdAt: 1767225600, updatedAt: 1767312000, recencyAt: 1767312000, ...extra };
}

test("project/list count is authoritative and does not grow with allowed Windows folders", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-tg-project-roots-"));
  try {
    for (const name of ["Downloads", "Videos", "Documents", "WPS Cloud", ...Array.from({ length: 66 }, (_, i) => `folder-${i}`)]) {
      mkdirSync(join(root, name));
    }
    const manualFolders = new ProjectManager([root]).list(100);
    const apiProjects: CodexProjectSummary[] = Array.from({ length: 5 }, (_, i) => ({
      id: `codex-${i}`,
      name: `Project ${i}`,
      roots: [{ path: `C:\\work\\project-${i}` }],
      createdAt: 1767225600,
      updatedAt: 1767225600 + i * 86400,
      recencyAt: 1767225600 + i * 86400,
      position: i,
    }));
    const entries = codexProjects(apiProjects);
    assert.equal(manualFolders.length, 70);
    assert.equal(entries.length, 5);
    assert(!entries.some((entry) => ["Downloads", "Videos", "Documents", "WPS Cloud"].includes(entry.name)));
    assert.deepEqual(entries.map((entry) => entry.name), ["Project 4", "Project 3", "Project 2", "Project 1", "Project 0"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active checkout uses the Codex project name instead of its folder name", async () => {
  const project = await codexProjectAt({
    listProjects: async () => [{ id: "p1", name: "OgPixelPay", roots: [{ path: "C:\\Users\\me\\gen" }] }],
    listThreads: async () => [],
  } as never, "C:\\Users\\me\\gen");
  assert.equal(project?.name, "OgPixelPay");
});

test("session cards use the Codex project name and capitalize Russian titles", () => {
  const project = { id: "p1", name: "OgPixelPay", path: "C:\\Users\\me\\gen", roots: ["C:\\Users\\me\\gen"], lastUsed: 1 };
  const meta = threadSessionMeta(thread("id", "cli", {
    projectId: "p1",
    cwd: "C:\\Users\\me\\gen",
    name: "а сейчас подключение к мсп есть?",
  }), undefined, [project]);
  assert.equal(meta.projectName, "OgPixelPay");
  assert.equal(meta.title, "А сейчас подключение к мсп есть?");
});

test("project list fallback uses interactive thread cwd and groups multiple roots", async () => {
  const client = {
    listProjects: async () => { throw new Error("method not found"); },
    listThreads: async () => [
      thread("one", "cli", { projectId: "p1", cwd: "C:\\work\\one", recencyAt: 1779926400 }),
      thread("two", "vscode", { projectId: "p1", cwd: "C:\\work\\one-tools", recencyAt: 1780012800 }),
      thread("noise", "exec", { cwd: "C:\\Users\\me\\Downloads" }),
    ],
  };
  const entries = await loadCodexProjects(client as never);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.roots?.length, 2);
  assert(entries[0]?.lastUsed > 0);
  assert.equal((await loadCodexProjects({ listProjects: async () => { throw Error(); }, listThreads: async () => { throw Error(); } } as never)).length, 0);
});

test("project matching trusts the actual working folder over stale project ids", () => {
  const project = { id: "codex-project", name: "Workspace", path: "C:\\work\\main", roots: ["C:\\work\\main", "C:\\work\\tools"], lastUsed: 1 };
  assert(!projectContainsThread(project, thread("t", "cli", { projectId: "codex-project", cwd: "C:\\elsewhere" })));
  assert(projectContainsThread(project, thread("t", "cli", { projectId: "codex-project", cwd: "" })));
  assert(sessionBelongsToProject({ sessionId: "s", cwd: "c:\\WORK\\TOOLS", title: "t", createdAt: "", updatedAt: "", active: false, historyBytes: 0 }, project));
  assert(!sessionBelongsToProject({ sessionId: "s", projectId: "other", cwd: "C:\\other", title: "t", createdAt: "", updatedAt: "", active: false, historyBytes: 0 }, project));
  assert(sessionBelongsToProject({ sessionId: "s", projectId: "stale-id", cwd: "C:\\work\\tools", title: "t", createdAt: "", updatedAt: "", active: false, historyBytes: 0 }, project));
  assert(projectContainsThread(project, thread("t", "cli", { projectId: "stale-id", cwd: "C:\\work\\tools" })));
});

test("conversation list includes Codex Desktop appServer threads but hides other Telegram users", () => {
  const interactive = [
    thread("cli", "cli"),
    thread("vscode", "vscode"),
    thread("exec", "exec"),
    thread("agent", { subAgent: "review" }),
    thread("review", { subAgent: "review" }),
    thread("compact", { subAgent: "compact" }),
    thread("spawn", { subAgent: { threadSpawn: { parentThreadId: "parent", depth: 1 } } }),
    thread("memory-consolidation", { subAgent: "memoryConsolidation" }),
    thread("other-subagent", { subAgent: { other: "future-agent" } }),
    thread("custom", { custom: "something" }),
    thread("unknown", "unknown"),
    thread("foreign-app", "appServer"),
  ];
  const telegram: TelegramSessionRecord = { createdBy: "telegram", createdAt: "2026-01-01T00:00:00.000Z", chatId: 7, projectPath: "C:\\work\\toy", projectName: "toy" };
  const list = catalogThreadSessions(
    interactive,
    [thread("ours", "appServer"), thread("desktop", "appServer"), thread("other-user", "appServer")],
    new Map([["ours", telegram]]),
    [],
    new Set(["other-user"]),
  );
  assert.deepEqual(list.map((item) => item.sessionId).sort(), ["cli", "desktop", "ours", "vscode"]);
  assert.equal(list.find((item) => item.sessionId === "ours")?.telegramCreated, true);
  assert(isInteractiveThread(thread("cli", "cli")));
  assert(isInteractiveThread(thread("vscode", "vscode")));
  assert(!isInteractiveThread(thread("missing", undefined)));
  assert(!isInteractiveThread(thread("exec", "exec")));
  assert(!isInteractiveThread(thread("unknown", "unknown")));
  assert(!isInteractiveThread(thread("custom", { custom: "something" })));
  assert(!isInteractiveThread(thread("subagent", { subAgent: "compact" })));
  assert(!isInteractiveThread(thread("memory-consolidation", { subAgent: "memoryConsolidation" })));
  assert(!isInteractiveThread(thread("other-subagent", { subAgent: { other: "future-agent" } })));
  assert.equal(threadSourceKind(thread("custom", { custom: "something" })), "custom");
  assert.equal(threadSourceKind(thread("subagent", { subAgent: { threadSpawn: { parentThreadId: "parent", depth: 1 } } })), "subAgent");
});

test("real project and thread Unix-second timestamps normalize and sort newest first", () => {
  const newerProject: CodexProjectSummary = {
    id: "project-1", name: "OgPixelPay", roots: [{ path: "C:\\work\\new" }],
    createdAt: 1791000000, updatedAt: 1791000100, recencyAt: 1791000200,
  };
  const olderProject: CodexProjectSummary = {
    id: "project-2", name: "Older", roots: [{ path: "C:\\work\\old" }],
    createdAt: 1790000000, updatedAt: 1790000100, recencyAt: null,
  };
  const projects = codexProjects([olderProject, newerProject]);
  assert.equal(projects[0]?.id, "project-1");
  assert.equal(projects[0]?.lastUsed, 1791000200000);
  assert(Number.isFinite(projects[0]?.lastUsed) && projects[0]!.lastUsed > 0);
  assert.equal(projects[1]?.lastUsed, 1790000100000);

  const newer = thread("newer", "cli", { createdAt: 1791000000, updatedAt: 1791000100, recencyAt: 1791000200 });
  const older = thread("older", "vscode", { createdAt: 1790000000, updatedAt: 1790000100, recencyAt: null });
  const sessions = catalogThreadSessions([older, newer], [], new Map());
  assert.deepEqual(sessions.map((session) => session.sessionId), ["newer", "older"]);
  assert.equal(sessions[0]?.createdAt, new Date(1791000000000).toISOString());
  assert.equal(sessions[0]?.updatedAt, new Date(1791000200000).toISOString());
  assert.equal(codexTimestampMilliseconds("2026-01-02T00:00:00.000Z"), Date.parse("2026-01-02T00:00:00.000Z"));
});

test("recent thread listing stops after collecting 24 eligible records", async () => {
  const newestFirst = Array.from({ length: 200 }, (_, index) => {
    const value = 200 - index;
    return thread(`thread-${value}`, value % 5 === 0 ? "cli" : "exec", {
      createdAt: value * 10,
      updatedAt: value * 10 + 1,
      recencyAt: value * 10 + 2,
    });
  });
  const requests: Array<{ cursor?: string; limit?: number }> = [];
  const client = {
    listThreads: async () => [],
    listThreadsPage: async (params: { cursor?: string; limit?: number }) => {
      requests.push(params);
      const start = params.cursor ? Number(params.cursor) : 0;
      const end = start + (params.limit ?? 50);
      return { threads: newestFirst.slice(start, end), nextCursor: end < newestFirst.length ? String(end) : undefined };
    },
  };
  const recent = await listRecentCodexThreads(client as never, { limit: 24, sortKey: "recency_at", sortDirection: "desc" }, isInteractiveThread);
  assert.equal(recent.length, 24);
  assert.equal(requests.length, 3);
  assert.deepEqual(recent.slice(0, 3).map((item) => item.id), ["thread-200", "thread-195", "thread-190"]);
  assert.equal(recent.at(-1)?.id, "thread-85");
});

test("session menu scopes to the current project, preserves selection, and searches old threads natively", async () => {
  const chatId = 77;
  const project: CodexProjectSummary = {
    id: "project-1", name: "OgPixelPay", roots: [{ path: "C:\\work\\toy" }],
    createdAt: 1791000000, updatedAt: 1791000100, recencyAt: 1791000200,
  };
  const current = Array.from({ length: 30 }, (_, index) => {
    const recencyAt = 1791000200 - index;
    return thread(`recent-${index}`, "cli", { name: `Recent ${index}`, cwd: "C:\\work\\toy", createdAt: recencyAt - 10, updatedAt: recencyAt, recencyAt });
  });
  const otherProject = thread("other-project", "cli", { cwd: "C:\\work\\elsewhere", name: "Other" });
  const pageRequests: Array<{ cwd?: string | string[]; searchTerm?: string }> = [];
  const searchRequests: Array<{ cwd?: string | string[]; searchTerm?: string }> = [];
  const cache = new MenuCache();
  const replies: string[] = [];
  const deps = {
    menuCache: cache,
    acp: {
      pid: 1,
      listProjects: async () => [project],
      listThreads: async () => [],
      listThreadsPage: async (params: { cwd?: string | string[]; limit?: number; cursor?: string }) => {
        pageRequests.push(params);
        const roots = Array.isArray(params.cwd) ? params.cwd : params.cwd ? [params.cwd] : undefined;
        const filtered = [...current, otherProject].filter((item) => !roots || roots.includes(item.cwd ?? ""));
        const start = params.cursor ? Number(params.cursor) : 0;
        const end = start + (params.limit ?? 50);
        return { threads: filtered.slice(start, end), nextCursor: end < filtered.length ? String(end) : undefined };
      },
      listAllThreads: async (params: { cwd?: string | string[]; searchTerm?: string }) => {
        searchRequests.push(params);
        return [thread("old-session", "cli", { name: "Ancient search match", cwd: "C:\\work\\toy", createdAt: 100, updatedAt: 110, recencyAt: 120 })];
      },
    },
    telegramSessions: { listAll: () => [], get: () => undefined },
    store: { get: () => undefined, list: () => [], jsonlPath: () => "" },
    registry: { get: () => ({ cwd: "C:\\work\\toy", sessionId: "" }) },
    ephemeral: {
      open: async () => undefined,
      reply: async (_ctx: Context, text: string) => { replies.push(text); },
      editLatest: async (_chatId: number, text: string) => { replies.push(text); },
    },
  } as unknown as BotDeps;
  const ctx = { chat: { id: chatId } } as unknown as Context;

  await showSessions(ctx, deps);
  assert.deepEqual(pageRequests[0]?.cwd, ["C:\\work\\toy"]);
  assert.equal(cache.getSelectedProject(chatId)?.id, "project-1");
  assert.equal(cache.getSessions(chatId)?.metas.length, 24);
  assert.equal(cache.getSessions(chatId)?.metas[0]?.sessionId, "recent-0");
  assert(replies.at(-1)?.includes("Переписки · OgPixelPay"));
  assert(replies.at(-1)?.includes("Последние: 24"));

  await showSessions(ctx, deps, undefined, null);
  assert.equal(pageRequests.at(-1)?.cwd, undefined);
  assert.equal(cache.getSelectedProject(chatId)?.id, "project-1");

  await showSessions(ctx, deps, "ancient search", undefined);
  assert.equal(searchRequests.at(-1)?.searchTerm, "ancient search");
  assert.deepEqual(searchRequests.at(-1)?.cwd, ["C:\\work\\toy"]);
  assert.equal(cache.getSessions(chatId)?.metas[0]?.sessionId, "old-session");
  assert(replies.at(-1)?.includes("Найдено: 1"));
});

test("registered Telegram project path and name override stale app-server metadata", () => {
  const record: TelegramSessionRecord = {
    createdBy: "telegram", createdAt: "2026-01-01T00:00:00.000Z", chatId: 7,
    projectPath: "C:\\work\\toy", projectName: "Codex Toy",
  };
  const meta = threadSessionMeta(thread("tg", "appServer", {
    projectId: "stale-id", cwd: "C:\\old\\folder",
  }), record, [{ id: "p1", name: "Codex Toy", path: "C:\\work\\toy", roots: ["C:\\work\\toy"], lastUsed: 1 }]);
  assert.equal(meta.cwd, record.projectPath);
  assert.equal(meta.projectId, undefined);
  assert.equal(meta.projectName, "Codex Toy");
});

test("registered empty Telegram sessions remain visible before app-server thread/list indexes them", () => {
  const record: TelegramSessionRecord = {
    createdBy: "telegram", createdAt: "2026-01-01T00:00:00.000Z", chatId: 7,
    projectPath: "C:\\work\\gen", projectName: "OgPixelPay",
  };
  const stored: SessionMeta = {
    sessionId: "new-thread", cwd: "", title: "# AGENTS.md instructions", createdAt: record.createdAt,
    updatedAt: record.createdAt, active: false, historyBytes: 0,
  };
  const result = includeRegisteredTelegramSessions([], [{ sessionId: "new-thread", record }], () => stored);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.telegramCreated, true);
  assert.equal(result[0]?.title, "Новый сеанс");
  assert.equal(result[0]?.projectName, "OgPixelPay");
  assert.equal(result[0]?.cwd, record.projectPath);
  assert.equal(includeRegisteredTelegramSessions([], [{ sessionId: "new-thread", record }], () => undefined).length, 1);
});

test("thread.name leads, preview is fallback, and bootstrap titles are rejected", () => {
  assert.equal(threadSessionMeta(thread("id", "cli", { name: "Полезный заголовок", preview: "Другой текст" })).title, "Полезный заголовок");
  assert.equal(threadSessionMeta(thread("id", "cli", { name: "# AGENTS.md instructions <INSTRUCTIONS>", preview: "Аудит проекта" })).title, "Аудит проекта");
  assert.equal(safeSessionTitle("<INSTRUCTIONS>"), undefined);
  assert.equal(safeSessionTitle("<recommended_plugins> Here is a list of plugins"), undefined);
  assert.equal(safeSessionTitle("# Context from my IDE setup: ## Active selection"), undefined);
  assert.equal(safeSessionTitle("Untitled"), undefined);
  assert.equal(safeSessionTitle("Новый сеанс"), undefined);
  assert.equal(safeSessionTitle("(untitled)"), undefined);
  assert.equal(safeSessionTitle("а сейчас подключение к МСП есть?"), "А сейчас подключение к МСП есть?");
  assert.equal(safeSessionTitle("You are Codex"), undefined);
});

test("stored first prompts provide real session titles after removing Codex setup text", () => {
  const prompt = "(Reasoning: high)\nПиши пояснения и сообщения пользователю по-русски.\n\nНовое сообщение пользователя:\nПроверь подключение к MCP";
  assert.equal(cleanSessionPrompt(prompt), "Проверь подключение к MCP");
  const stored: SessionMeta = {
    sessionId: "session", cwd: "C:\\work\\toy", title: "Проверь подключение к MCP",
    createdAt: "", updatedAt: "", active: false, historyBytes: 0,
  };
  const fallback = threadSessionMeta(thread("session", "cli", { name: "Новый сеанс" }), undefined, [], () => stored);
  assert.equal(fallback.title, "Проверь подключение к MCP");
});

test("controlled-session cards suppress bootstrap prompts but keep the user's actual prompt", () => {
  assert.equal(cleanPrompt("# AGENTS.md instructions for C:\\work <INSTRUCTIONS> Please follow these rules"), "");
  assert.equal(cleanPrompt("User's new message: Проверь проект без изменений"), "Проверь проект без изменений");
  assert.equal(runningSessionTitle("OgPixelPay", "", "(untitled)"), "Сеанс · OgPixelPay");
  assert.equal(runningSessionTitle("OgPixelPay", "Проверь оплату", "старый заголовок"), "“Проверь оплату”");
  assert.equal(runningSessionTitle("OgPixelPay", "первый запрос", "", "Автоматический заголовок Codex"), "“Автоматический заголовок Codex”");
});

test("session picker is short, search-based and does not repeat titles in body", () => {
  const metas: SessionMeta[] = Array.from({ length: 100 }, (_, i) => ({
    sessionId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    cwd: "C:\\work\\toy",
    title: `Сеанс ${i}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    active: false,
    historyBytes: 1,
  }));
  const first = sessionPage(metas, "Сеансы · toy", 0, "0123456789abcdef", metas[0]?.sessionId);
  assert(first.text.includes("Последние: 24"));
  assert(first.text.includes("1/4"));
  assert(!first.text.includes("Сеанс 0"));
  const search = sessionPage(metas, "Переписки", 0, "0123456789abcdef", undefined, undefined, false, true);
  assert(search.text.includes("Найдено: 100"));
  assert(search.text.includes("1/17"));
  assert(first.keyboard.inline_keyboard.flat().filter((button) => "callback_data" in button && button.callback_data.startsWith("s:0123456789abcdef:")).length <= 6);
  assert(first.keyboard.inline_keyboard.flat().some((button) => "callback_data" in button && button.callback_data === "s:search"));
  for (const button of first.keyboard.inline_keyboard.flat()) if ("callback_data" in button) assert(callbackDataFits(button.callback_data));
});

test("Windows task XML identifies its checkout and stale source clearly", () => {
  const xml = '<Task><Command>wscript.exe</Command><Arguments>&quot;C:\\old\\run-service.vbs&quot;</Arguments></Task>';
  const action = actionFromTaskXml(xml);
  assert(action);
  const source = sourceFromTaskAction(action, 'sh.CurrentDirectory = "C:\\old"');
  assert(sameWindowsCheckout("c:\\OLD\\.", source));
  assert(!sameWindowsCheckout("C:\\new", source));
  const message = staleTargetMessage("C:\\new", source);
  assert(message.includes("Expected:\nC:\\new"));
  assert(message.includes("Actual:\nC:\\old"));
  assert(message.includes("Reinstall the service"));
});

test("diagnostics show runtime source and commit fallback without configuration secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-tg-diagnostics-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.8.7" }));
    const output = formatDiagnostics(runtimeIdentity(root, 1234, true));
    assert(output.includes("Версия бота: 9.8.7"));
    assert(output.includes("Коммит: версия 9.8.7"));
    assert(output.includes("PID: 1234"));
    assert(output.includes(`Папка запуска:\n${root}`));
    assert(output.includes("Сервер Codex: подключён"));
    assert(!output.includes("TELEGRAM_BOT_TOKEN") && !output.includes("ALLOWED_USERS"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
