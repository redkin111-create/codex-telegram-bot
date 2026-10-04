import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodexProjectSummary, CodexThreadSummary } from "../src/acp/codex-protocol.js";
import { catalogThreadSessions, codexProjectAt, codexProjects, includeRegisteredTelegramSessions, isInteractiveThread, loadCodexProjects, projectContainsThread, safeSessionTitle, sessionBelongsToProject, threadSessionMeta, threadsAsProjects } from "../src/bot/catalog.js";
import { sessionPage } from "../src/bot/handlers/sessions.js";
import { cleanSessionPrompt } from "../src/sessions/title.js";
import { callbackDataFits } from "../src/bot/menu/paging.js";
import { ProjectManager } from "../src/projects/manager.js";
import { formatDiagnostics, runtimeIdentity } from "../src/bot/handlers/diagnostics.js";
import { cleanPrompt, runningSessionTitle } from "../src/bot/handlers/running.js";
import { actionFromTaskXml, sameWindowsCheckout, sourceFromTaskAction, staleTargetMessage } from "../src/service/windows-target.js";
import type { SessionMeta } from "../src/sessions/types.js";
import type { TelegramSessionRecord } from "../src/sessions/telegram-registry.js";

function thread(id: string, source: CodexThreadSummary["source"], extra: Partial<CodexThreadSummary> = {}): CodexThreadSummary {
  return { id, source, name: id, cwd: "C:\\work\\toy", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", ...extra };
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
      recencyAt: new Date(2026, 0, i + 1).toISOString(),
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
      thread("one", "cli", { projectId: "p1", cwd: "C:\\work\\one", recencyAt: "2026-02-01T00:00:00.000Z" }),
      thread("two", "vscode", { projectId: "p1", cwd: "C:\\work\\one-tools", recencyAt: "2026-02-02T00:00:00.000Z" }),
      thread("noise", "exec", { cwd: "C:\\Users\\me\\Downloads" }),
    ],
  };
  const entries = await loadCodexProjects(client as never);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.roots?.length, 2);
  assert(entries[0]?.lastUsed > Date.parse("2026-02-01T00:00:00.000Z"));
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
    thread("agent", "subAgent"),
    thread("review", "subAgentReview"),
    thread("compact", "subAgentCompact"),
    thread("spawn", "subAgentThreadSpawn"),
    thread("other", "subAgentOther"),
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
  assert(isInteractiveThread(thread("legacy", undefined)));
  assert(!isInteractiveThread(thread("exec", "exec")));
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
  assert(first.text.includes("Всего: 100"));
  assert(first.text.includes("1/17"));
  assert(!first.text.includes("Сеанс 0"));
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
