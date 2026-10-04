import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, InlineKeyboard } from "grammy";
import { loadConfig, PROJECT_ROOT, type AppConfig } from "../src/config.js";
import { ChatController } from "../src/bot/chat-controller.js";
import { createAuthMiddleware } from "../src/bot/auth.js";
import { MenuCache, type BotDeps } from "../src/bot/deps.js";
import { formatProbeResult, healthCheckKeyboard, mainPanel, snapshotMatches } from "../src/bot/handlers/mcp.js";
import { modelPage, reasoningKeyboard, skillsPage } from "../src/bot/handlers/inline-catalog.js";
import { COMMANDS, HELP_TEXT } from "../src/bot/commands.js";
import { projectPage } from "../src/bot/handlers/projects.js";
import { selectProject } from "../src/bot/handlers/projects.js";
import { continueSession, createConfirmedSession, newSessionConfirmation, selectionCard, sessionPage, showNewSessionConfirmation } from "../src/bot/handlers/sessions.js";
import { mainMenuInline, MENU_BTN, RUNNING_BTN, STOP_BTN } from "../src/bot/menu/keyboard.js";
import { mainMenuText } from "../src/bot/menu/main.js";
import { buildContentBlocks } from "../src/bot/prompt-content.js";
import { callbackDataFits } from "../src/bot/menu/paging.js";
import type { SessionMeta } from "../src/sessions/types.js";
import type { McpServer } from "../src/mcp/types.js";
import { isNpmInstall } from "../src/app/updater.js";
import { canonicalExistingDirectory, isPathWithinRoot, ProjectManager, recentProjects } from "../src/projects/manager.js";
import { TelegramSessionRegistry } from "../src/sessions/telegram-registry.js";
import { defaultSettings } from "../src/app/types.js";
import type { AcpClient } from "../src/acp/client.js";
import { RUNNING_COMMANDS } from "../src/bot/handlers/running.js";

function callbacks(keyboard: InlineKeyboard): string[] {
  return keyboard.inline_keyboard.flatMap((row) => row.flatMap((button) => {
    const data = "callback_data" in button ? button.callback_data : undefined;
    return data ? [data] : [];
  }));
}

function assertCallbacksFit(...keyboards: InlineKeyboard[]): void {
  for (const keyboard of keyboards) {
    for (const data of callbacks(keyboard)) assert.equal(callbackDataFits(data), true, `${data} exceeds Telegram's limit`);
  }
}

test("project picker keeps paths out of buttons and supports a safe wizard cancel", () => {
  const path = "C:\\private\\workspace\\with-a-long-path";
  const keyboard = projectPage([{ name: "A project name that is much longer than a phone button", path, lastUsed: 1 }], 0, "0123456789abcdef", "p", path);
  const wizard = projectPage([{ name: "Project", path, lastUsed: 1 }], 0, "0123456789abcdef", "w");
  const empty = projectPage([], 0, "0123456789abcdef", "p");
  const data = callbacks(keyboard);
  assert(data.some((item) => item === "p:0123456789abcdef:0"));
  assert(data.every((item) => !item.includes(path)));
  assert(keyboard.inline_keyboard[0]![0]!.text.startsWith("✅"));
  assert(callbacks(empty).includes("p:search"));
  assert(callbacks(empty).includes("ui:home"));
  assert(callbacks(wizard).includes("wiz:cancel"));
  assertCallbacksFit(keyboard, wizard, empty);
});

test("session picker handles long names, empty lists, paging, and active selection", () => {
  const meta: SessionMeta = {
    sessionId: "00000000-0000-4000-8000-000000000001",
    cwd: "C:\\work\\project-name-that-is-long",
    title: "A very long conversation title that should fit on a phone",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    active: false,
    historyBytes: 0,
  };
  const picker = sessionPage([meta], "Recent sessions", 0, "0123456789abcdef", meta.sessionId);
  const empty = sessionPage([], "Recent sessions", 0, "0123456789abcdef");
  assert(picker.keyboard.inline_keyboard[0]![0]!.text.startsWith("✅"));
  assert(!picker.text.includes(meta.title));
  assert(callbacks(picker.keyboard).includes("s:0123456789abcdef:0"));
  assert(callbacks(empty.keyboard).includes("s:new"));
  assert(callbacks(empty.keyboard).includes("ui:home"));
  const many = Array.from({ length: 8 }, (_, i) => ({ ...meta, sessionId: `session-${i}` }));
  assert(callbacks(sessionPage(many, "Recent sessions", 0, "0123456789abcdef").keyboard).includes("sp:0123456789abcdef:1"));
  assert(callbacks(sessionPage(many, "Recent sessions", 1, "0123456789abcdef").keyboard).includes("sp:0123456789abcdef:0"));
  assertCallbacksFit(picker.keyboard, empty.keyboard);
});

test("session selection opens a detail card with existing actions and safe navigation", () => {
  const meta: SessionMeta = {
    sessionId: "00000000-0000-4000-8000-000000000001",
    cwd: "C:\\work",
    title: "Selected session",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    active: true,
    lockPid: 999,
    historyBytes: 0,
  };
  const detail = selectionCard(meta, "0123456789abcdef", 7, 123);
  const data = callbacks(detail.keyboard);
  assert(data.includes(`sess:${meta.sessionId}`));
  assert(data.includes(`hist:${meta.sessionId}`));
  assert(data.includes(`watch:${meta.sessionId}`));
  assert(data.includes(`killsess:${meta.sessionId}`));
  assert(data.includes("sp:0123456789abcdef:1"));
  assert(data.includes("ui:home"));
  assert(detail.keyboard.inline_keyboard[0]![0]!.text.includes("Продолжить"));
  assert(!detail.text.includes(meta.sessionId));
  assert(!detail.text.includes(meta.cwd));
  assert(!detail.text.includes("999"));
  const selfSession = selectionCard({ ...meta, lockPid: 123 }, "0123456789abcdef", 0, 123);
  assert(!callbacks(selfSession.keyboard).some((item) => item.startsWith("killsess:")));
  assertCallbacksFit(detail.keyboard, selfSession.keyboard);
});

test("model, skill, reasoning, and home keyboards use short callback data", () => {
  const model = modelPage([{ modelId: "a-model-id", name: "A model name that is intentionally very long" }], 0, "0123456789abcdef", "a-model-id");
  const emptyModel = modelPage([], 0, "0123456789abcdef");
  const skill = skillsPage([{ name: "A skill with a very long name", description: "details" }], 0, "0123456789abcdef");
  const emptySkill = skillsPage([], 0, "0123456789abcdef");
  const reasoning = reasoningKeyboard("high");
  const home = mainMenuInline({ busy: true });
  assert(model.kb.inline_keyboard[0]![0]!.text.startsWith("✅"));
  assert(emptyModel.text.includes("Codex не сообщил о доступных моделях"));
  assert(emptySkill.text.includes("Codex не сообщил о включённых навыках"));
  assert(callbacks(reasoning).some((data) => data === "reason:high"));
  assert(callbacks(home).includes("m:stop"));
  assertCallbacksFit(model.kb, emptyModel.kb, skill.kb, emptySkill.kb, reasoning, home);
});

test("main menu has home navigation and avoids exposing a full project path", () => {
  const keyboard = mainMenuInline({ busy: false });
  const text = mainMenuText({
    project: "Example project",
    session: "Current session",
    model: "Codex",
    reasoning: "Высокий",
    sandbox: "только к рабочим папкам",
    approval: "по запросу",
    unsafe: false,
    busy: false,
  });
  assert(callbacks(keyboard).includes("m:project"));
  assert(callbacks(keyboard).includes("m:more"));
  assert(callbacks(keyboard).includes("m:reasoning"));
  assert(!callbacks(keyboard).includes("C:\\private\\workspace"));
  const labels = keyboard.inline_keyboard.flat().map((button) => button.text);
  assert(labels.includes("\u{1F4C1} Проекты"));
  assert(labels.includes("\u{1F4AC} Переписки"));
  assert([MENU_BTN, RUNNING_BTN, STOP_BTN].every((label) => /[А-Яа-яЁё]/.test(label)));
  assert(COMMANDS.every(({ description }) => /[А-Яа-яЁё]/.test(description)));
  assert(HELP_TEXT.includes("КАК ЭТО РАБОТАЕТ"));
  assert(text.includes("Example project"));
  assert(text.includes("📁 Example project"));
  assert(text.includes("Высокий"));
  assert(!text.includes("workspace-write"));
  assertCallbacksFit(keyboard);
});

test("Codex prompts use Russian by default and allow an explicitly requested language", () => {
  const prompt = buildContentBlocks({ text: "Ответь по-русски.", images: [] })[0];
  if (!prompt || prompt.type !== "text" || typeof prompt.text !== "string") assert.fail("expected a text prompt");
  assert(prompt.text.includes("Пиши пояснения и сообщения пользователю по-русски"));
  assert(prompt.text.includes("Если пользователь явно просит другой язык, выполни просьбу."));

  const imagePrompt = buildContentBlocks({ text: "", images: [{ data: "", mimeType: "image/jpeg" }] });
  assert.equal(imagePrompt[0]?.type, "image");
  const imageInstruction = imagePrompt[1];
  if (!imageInstruction || imageInstruction.type !== "text" || typeof imageInstruction.text !== "string") {
    assert.fail("expected a text instruction after the image");
  }
  assert(imageInstruction.text.includes("Проанализируй приложенное изображение."));
});

test("cache tokens prevent an old button selecting a newer list", () => {
  const cache = new MenuCache();
  const oldToken = cache.setProjects(42, [{ name: "old", path: "C:\\old", lastUsed: 0 }]);
  const newToken = cache.setProjects(42, [{ name: "new", path: "C:\\new", lastUsed: 0 }]);
  assert.equal(cache.getProject(42, 0, oldToken), undefined);
  assert.equal(cache.getProject(42, 0, newToken)?.name, "new");

  const meta: SessionMeta = {
    sessionId: "session-one", cwd: "C:\\work", title: "Recent", createdAt: "", updatedAt: "", active: false, historyBytes: 0,
  };
  const sessionToken = cache.setSessions(42, [meta], "Recent");
  assert.equal(cache.getSessions(42, "stale-token"), undefined);
  assert.equal(cache.getSessions(42, sessionToken)?.heading, "Recent");
  assert.equal(cache.getSession(42, sessionToken, 0)?.sessionId, "session-one");
  assert.equal(cache.getSession(42, "stale-token", 0), undefined);
  const modelToken = cache.setModels(42, [{ modelId: "new", name: "New" }]);
  assert.equal(cache.getModel(42, "stale-token", 0), undefined);
  assert.equal(cache.getModel(42, modelToken, 0)?.modelId, "new");
  const skillToken = cache.setSkills(42, [{ name: "New" }]);
  assert.equal(cache.getSkill(42, "stale-token", 0), undefined);
  assert.equal(cache.getSkill(42, skillToken, 0)?.name, "New");
});

test("recent Codex projects deduplicate cwd, use newest activity, and ignore missing folders", () => {
  const base = mkdtempSync(join(tmpdir(), "codex-tg-recent-"));
  try {
    const project = join(base, "toy");
    mkdirSync(project);
    const meta = (sessionId: string, cwd: string, updatedAt: string): SessionMeta => ({
      sessionId, cwd, title: sessionId, createdAt: updatedAt, updatedAt, active: false, historyBytes: 0,
    });
    const recent = recentProjects([
      meta("old", project, "2026-01-01T00:00:00.000Z"),
      meta("new", project + "/", "2026-01-03T00:00:00.000Z"),
      meta("missing", join(base, "gone"), "2026-01-04T00:00:00.000Z"),
    ]);
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.name, "toy");
    assert.equal(recent[0]?.lastUsed, Date.parse("2026-01-03T00:00:00.000Z"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("project path allowlist accepts a folder inside root and rejects siblings and traversal", () => {
  const base = mkdtempSync(join(tmpdir(), "codex-tg-roots-"));
  try {
    const root = join(base, "projects");
    const inside = join(root, "toy");
    const nested = join(inside, "nested");
    const sibling = join(base, "projects2");
    mkdirSync(nested, { recursive: true });
    mkdirSync(sibling);
    const canonicalRoot = canonicalExistingDirectory(root)!;
    const canonicalInside = canonicalExistingDirectory(inside)!;
    const canonicalSibling = canonicalExistingDirectory(sibling)!;
    assert(canonicalRoot);
    const manager = new ProjectManager([root]);
    assert.deepEqual(manager.list().map((entry) => entry.name), ["toy"]);
    assert.equal(manager.resolveAllowedPath(inside), canonicalInside);
    assert.equal(manager.resolveAllowedPath(sibling), undefined);
    assert.equal(manager.resolveAllowedPath(join(root, "..", "projects2")), undefined);
    assert.equal(manager.resolveAllowedPath(sibling, [sibling]), canonicalSibling);
    assert.equal(isPathWithinRoot("C:\\projects", "C:\\projects\\toy"), true);
    assert.equal(isPathWithinRoot("C:\\projects", "C:\\projects2"), false);
    assert.equal(isPathWithinRoot("C:\\projects", "C:\\projects\\..\\Windows"), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("unset project roots do not add HOME; explicit workspace is the only fallback root", () => {
  const keys = ["TELEGRAM_BOT_TOKEN", "ALLOWED_USERS", "PROJECT_ROOTS", "CODEX_WORKSPACE"] as const;
  const saved = keys.map((key) => process.env[key]);
  try {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.ALLOWED_USERS = "7";
    process.env.PROJECT_ROOTS = "";
    delete process.env.CODEX_WORKSPACE;
    assert.deepEqual(loadConfig().projectRoots, []);
    process.env.CODEX_WORKSPACE = join(tmpdir(), "safe-workspace");
    assert.deepEqual(loadConfig().projectRoots, [join(tmpdir(), "safe-workspace")]);
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index]!;
    });
  }
});

test("choosing a project opens its filtered sessions without creating a thread", async () => {
  let starts = 0;
  let shown = "";
  const cache = new MenuCache();
  const deps = {
    menuCache: cache,
    store: { list: () => [], get: () => undefined },
    telegramSessions: { prune: () => 0, get: () => undefined, listForChat: () => [], listAll: () => [] },
    registry: {
      get: () => ({ sessionId: undefined }),
      controller: () => ({ addNew: async () => { starts++; } }),
    },
    ephemeral: { open: async () => {}, reply: async (_ctx: Context, text: string) => { shown = text; } },
  } as unknown as BotDeps;
  const ctx = { chat: { id: 44 } } as unknown as Context;
  const project = { name: "toy", path: "C:\\work\\toy", lastUsed: 1 };
  await selectProject(ctx, deps, project);
  assert.equal(starts, 0);
  assert.equal(cache.getSelectedProject(44)?.path, project.path);
  assert(shown.includes("В этом проекте пока нет сеансов"));
});

test("new session waits for the matching confirmation token", async () => {
  let starts = 0;
  let keyboard: InlineKeyboard | undefined;
  const cache = new MenuCache();
  const deps = {
    menuCache: cache,
    registry: {
      get: () => ({ cwd: "C:\\work\\toy", projectName: "toy" }),
      controller: () => ({ addNew: async (path: string, name: string) => { starts++; return { sessionId: `${path}:${name}` }; } }),
    },
    ephemeral: {
      open: async () => {},
      reply: async (_ctx: Context, _text: string, extra: { reply_markup?: InlineKeyboard }) => { keyboard = extra.reply_markup; },
    },
  } as unknown as BotDeps;
  const ctx = { chat: { id: 45 } } as unknown as Context;
  await showNewSessionConfirmation(ctx, deps);
  assert.equal(starts, 0);
  assert(keyboard);
  const createButton = callbacks(keyboard!).find((data) => data.startsWith("s:create:"));
  assert(createButton);
  const token = createButton.slice("s:create:".length);
  assert.equal(await createConfirmedSession(deps, 45, "ffffffffffffffff"), undefined);
  assert.equal(starts, 0);
  const created = await createConfirmedSession(deps, 45, token);
  assert.equal(starts, 1);
  assert.equal(created?.target.path, "C:\\work\\toy");
  const confirmation = newSessionConfirmation("toy");
  assert(confirmation.includes("Создан через Telegram"));
  assert(!confirmation.includes(created!.runtime.sessionId!));
  assert.equal(await createConfirmedSession(deps, 45, token), undefined);
  assert.equal(starts, 1);
  assertCallbacksFit(keyboard!);
});

test("Continue resumes the selected thread and returns a short confirmation without history", async () => {
  const meta: SessionMeta = {
    sessionId: "00000000-0000-4000-8000-000000000099",
    cwd: "C:\\work\\toy",
    title: "Проверка инвентаря",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    active: false,
    historyBytes: 10,
  };
  let resumed = "";
  const deps = {
    registry: {
      get: () => ({ cwd: "C:\\work\\other" }),
      controller: () => ({ addAttach: async (id: string) => { resumed = id; return { result: "resumed", alreadyControlled: false }; } }),
    },
    store: { jsonlPath: () => join(tmpdir(), "missing-continuation-history.jsonl") },
  } as unknown as BotDeps;
  const message = await continueSession(deps, 51, meta);
  assert.equal(resumed, meta.sessionId);
  assert(message.includes("Сеанс выбран: Проверка инвентаря"));
  assert(message.includes("Отправьте сообщение."));
  assert(!message.includes("История"));
});

test("/active remains an alias of the controlled sessions view", () => {
  assert.deepEqual(RUNNING_COMMANDS, ["running", "active"]);
});

test("existing session attachment resumes the same session id without thread/start", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const cwd = "C:\\work\\toy";
  let resumed: string | undefined;
  let starts = 0;
  const acp = Object.assign(new EventEmitter(), {
    loadSession: async (id: string) => { resumed = id; },
    newSession: async () => { starts++; return "new-session"; },
  }) as unknown as AcpClient;
  Object.defineProperty(acp, "supportsLoadSession", { value: true });
  let currentSettings = defaultSettings();
  const settings = {
    get: () => currentSettings,
    update: (_chatId: number, patch: Partial<typeof currentSettings>) => { currentSettings = { ...currentSettings, ...patch }; },
  };
  const store = { jsonlPath: () => join(tmpdir(), "missing-codex-rollout.jsonl") };
  const controller = new ChatController({} as never, 46, acp, {} as AppConfig, settings as never, store as never, () => {}, () => {});
  try {
    const result = await controller.addAttach(sessionId, cwd, "toy", []);
    assert.equal(result.result, "resumed");
    assert.equal(result.rt.sessionId, sessionId);
    assert.equal(resumed, sessionId);
    assert.equal(starts, 0);
  } finally {
    controller.dispose();
  }
});

test("a non-lock resume failure is returned instead of silently forking", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000003";
  let starts = 0;
  const acp = Object.assign(new EventEmitter(), {
    loadSession: async () => { throw new Error("invalid session arguments"); },
    newSession: async () => { starts++; return "new-session"; },
  }) as unknown as AcpClient;
  Object.defineProperty(acp, "supportsLoadSession", { value: true });
  let currentSettings = defaultSettings();
  const settings = { get: () => currentSettings, update: (_id: number, patch: Partial<typeof currentSettings>) => { currentSettings = { ...currentSettings, ...patch }; } };
  const controller = new ChatController({} as never, 48, acp, {} as AppConfig, settings as never, { jsonlPath: () => "missing.jsonl" } as never, () => {}, () => {});
  try {
    await assert.rejects(controller.addAttach(sessionId, "C:\\work", "work", []), /invalid session arguments/);
    assert.equal(starts, 0);
  } finally {
    controller.dispose();
  }
});

test("a real live-session conflict keeps the existing linked-continuation fallback", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000004";
  let starts = 0;
  const acp = Object.assign(new EventEmitter(), {
    loadSession: async () => { throw new Error("Thread is already active in another process"); },
    newSession: async () => { starts++; return "linked-continuation"; },
  }) as unknown as AcpClient;
  Object.defineProperty(acp, "supportsLoadSession", { value: true });
  let currentSettings = defaultSettings();
  const settings = { get: () => currentSettings, update: (_id: number, patch: Partial<typeof currentSettings>) => { currentSettings = { ...currentSettings, ...patch }; } };
  const controller = new ChatController({} as never, 49, acp, {} as AppConfig, settings as never, { jsonlPath: () => "missing.jsonl" } as never, () => {}, () => {});
  try {
    const result = await controller.addAttach(sessionId, "C:\\work", "work", []);
    assert.equal(result.result, "forked");
    assert.equal(result.rt.sessionId, "linked-continuation");
    assert.equal(starts, 1);
  } finally {
    controller.dispose();
  }
});

test("session origin labels and Telegram registry contain only origin metadata", () => {
  const base = mkdtempSync(join(tmpdir(), "codex-tg-registry-"));
  try {
    const registry = new TelegramSessionRegistry(base);
    const sessionId = "00000000-0000-4000-8000-000000000001";
    registry.record(sessionId, 47, "C:\\work\\toy", "toy");
    const stored = JSON.parse(readFileSync(join(base, "telegram-sessions.json"), "utf8")) as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(stored[sessionId]!).sort(), ["chatId", "createdAt", "createdBy", "projectName", "projectPath"]);
    assert.equal(stored[sessionId]?.createdBy, "telegram");
    const old = { ...stored[sessionId]!, createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() };
    writeFileSync(join(base, "telegram-sessions.json"), JSON.stringify({ [sessionId]: old }), "utf8");
    const staleRegistry = new TelegramSessionRegistry(base);
    assert.equal(staleRegistry.prune(() => false), 1);
    assert.equal(staleRegistry.get(sessionId), undefined);

    const meta: SessionMeta = {
      sessionId, cwd: "C:\\work\\toy", title: "QA", createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z", active: false, historyBytes: 0,
    };
    const page = sessionPage([meta, { ...meta, sessionId: "00000000-0000-4000-8000-000000000002" }], "Сеансы", 0, "0123456789abcdef", undefined, (id) => id === sessionId);
    assert(page.keyboard.inline_keyboard[0]![0]!.text.includes("📱"));
    assert(page.keyboard.inline_keyboard[1]![0]!.text.includes("🖥"));
    assert(!page.text.includes("📱") && !page.text.includes("🖥"));
    assert(selectionCard(meta, "0123456789abcdef", 0, undefined, true).text.includes("Сеанс Telegram"));
    assert(selectionCard(meta, "0123456789abcdef", 0).text.includes("Сеанс Codex"));
    assertCallbacksFit(page.keyboard);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("MCP display omits config secrets and probe details", () => {
  const server: McpServer = {
    name: "safe-server",
    scope: "global",
    configPath: "C:\\private\\TOKEN_SHOULD_NOT_APPEAR\\config.toml",
    disabled: false,
    transport: "http",
    detail: "https://user:password@secret.example/path",
    config: { headers: { Authorization: "Bearer API_SECRET" }, env: { PRIVATE_VALUE: "ENV_SECRET" } },
  };
  const panel = mainPanel([server], [], 0, "0123456789abcdef");
  const livePanel = mainPanel([server], [{ name: "safe-server", tools: { one: {} }, resources: [{}], authStatus: "needs_auth" }], 0, "0123456789abcdef");
  const liveOnlyPanel = mainPanel([], [{ name: "live-only-server", tools: { one: {} }, resourceTemplates: [{}] }], 0, "0123456789abcdef");
  const disabledPanel = mainPanel([{ ...server, disabled: true }], [], 0, "0123456789abcdef");
  const failed = formatProbeResult({ name: "safe-server", ok: false, error: "process exited (code 1) — API_SECRET in stderr" });
  const displayed = `${panel.text}\n${livePanel.text}\n${liveOnlyPanel.text}\n${disabledPanel.text}\n${failed}`;
  for (const secret of ["TOKEN_SHOULD_NOT_APPEAR", "password", "API_SECRET", "ENV_SECRET", "secret.example"]) assert(!displayed.includes(secret));
  assert(livePanel.text.includes("инструментов: 1 · ресурсов: 1 · требуется вход"));
  assert(liveOnlyPanel.text.includes("Обнаружены Codex"));
  assert(callbacks(disabledPanel.kb).some((data) => data.startsWith("mcp:restart:")));
  assert(failed.includes("Процесс завершился (code 1)"));
  assertCallbacksFit(panel.kb, livePanel.kb, liveOnlyPanel.kb, disabledPanel.kb);
});

test("MCP re-check uses its own callback and rejects stale workspace snapshots", () => {
  const token = "0123456789abcdef";
  const keyboard = healthCheckKeyboard(token);
  const data = callbacks(keyboard);
  assert(data.includes(`mcp:recheck:${token}`));
  assert(data.includes("mcp:refresh"));
  assert(snapshotMatches({ token, cwd: "C:\\Work\\Project" }, token, "c:/work/project/"));
  assert(!snapshotMatches({ token, cwd: "C:\\Work\\Project" }, "fedcba9876543210", "C:\\Work\\Project"));
  assert(!snapshotMatches({ token, cwd: "C:\\Work\\Project" }, token, "C:\\Work\\Other"));
  assertCallbacksFit(keyboard);
});

test("bot config requires an allowlist and disables auto-update by default", () => {
  const keys = ["TELEGRAM_BOT_TOKEN", "ALLOWED_USERS", "AUTO_UPDATE"] as const;
  const saved = keys.map((key) => process.env[key]);
  try {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.ALLOWED_USERS = "";
    delete process.env.AUTO_UPDATE;
    assert.throws(() => loadConfig(), /ALLOWED_USERS is empty/);
    process.env.ALLOWED_USERS = "7, 8";
    assert.equal(loadConfig().autoUpdate, false);
    process.env.AUTO_UPDATE = "true";
    assert.equal(loadConfig().autoUpdate, true);
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index]!;
    });
  }
});

test("npm updater recognizes packages and leaves source checkouts alone", () => {
  assert.equal(isNpmInstall(PROJECT_ROOT), false);
  assert.equal(isNpmInstall("C:\\Users\\me\\node_modules\\codex-telegram-bot"), true);
});

test("unauthorized callback taps are rejected without entering handlers", async () => {
  let entered = false;
  let replied = false;
  let answer: Record<string, unknown> | undefined;
  const middleware = createAuthMiddleware({ allowedUsers: new Set(["7"]) } as never);
  const ctx = {
    from: { id: 9, is_bot: false },
    chat: { id: 42 },
    callbackQuery: { id: "callback" },
    answerCallbackQuery: async (options: Record<string, unknown>) => { answer = options; },
    reply: async () => { replied = true; },
  } as unknown as Context;
  await middleware(ctx, async () => { entered = true; });
  assert.equal(entered, false);
  assert.equal(replied, false);
  assert.equal(answer?.show_alert, true);
  assert.equal(answer?.text, "⛔ Нет доступа.");
});

test("authorized callback taps continue to their selected handler", async () => {
  let entered = false;
  const middleware = createAuthMiddleware({ allowedUsers: new Set(["7"]) } as never);
  const ctx = {
    from: { id: 7, is_bot: false },
    callbackQuery: { id: "callback" },
  } as unknown as Context;
  await middleware(ctx, async () => { entered = true; });
  assert.equal(entered, true);
});

test("empty authorization list denies all users", async () => {
  let entered = false;
  let answer: Record<string, unknown> | undefined;
  const middleware = createAuthMiddleware({ allowedUsers: new Set() } as never);
  const ctx = {
    from: { id: 7, is_bot: false },
    callbackQuery: { id: "callback" },
    answerCallbackQuery: async (options: Record<string, unknown>) => { answer = options; },
  } as unknown as Context;
  await middleware(ctx, async () => { entered = true; });
  assert.equal(entered, false);
  assert.equal(answer?.show_alert, true);
});
