import assert from "node:assert/strict";
import test from "node:test";
import type { Context, InlineKeyboard } from "grammy";
import { loadConfig, PROJECT_ROOT } from "../src/config.js";
import { createAuthMiddleware } from "../src/bot/auth.js";
import { MenuCache } from "../src/bot/deps.js";
import { formatProbeResult, healthCheckKeyboard, mainPanel, snapshotMatches } from "../src/bot/handlers/mcp.js";
import { modelPage, reasoningKeyboard, skillsPage } from "../src/bot/handlers/inline-catalog.js";
import { COMMANDS, HELP_TEXT } from "../src/bot/commands.js";
import { projectPage } from "../src/bot/handlers/projects.js";
import { selectionCard, sessionPage } from "../src/bot/handlers/sessions.js";
import { mainMenuInline, MENU_BTN, RUNNING_BTN, STOP_BTN } from "../src/bot/menu/keyboard.js";
import { mainMenuText } from "../src/bot/menu/main.js";
import { buildContentBlocks } from "../src/bot/prompt-content.js";
import { callbackDataFits } from "../src/bot/menu/paging.js";
import type { SessionMeta } from "../src/sessions/types.js";
import type { McpServer } from "../src/mcp/types.js";
import { isNpmInstall } from "../src/app/updater.js";

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
  assert(picker.text.includes("✅"));
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
  assert(detail.keyboard.inline_keyboard[0]![0]!.text.includes("Открыть"));
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
  assert(model.text.includes("✅"));
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
  assert(callbacks(keyboard).includes("m:settings"));
  assert(callbacks(keyboard).includes("m:project"));
  assert(!callbacks(keyboard).includes("C:\\private\\workspace"));
  const labels = keyboard.inline_keyboard.flat().map((button) => button.text);
  assert(labels.includes("\u{1F4C1} Проекты"));
  assert(labels.includes("\u{1F4AC} Сеансы"));
  assert([MENU_BTN, RUNNING_BTN, STOP_BTN].every((label) => /[А-Яа-яЁё]/.test(label)));
  assert(COMMANDS.every(({ description }) => /[А-Яа-яЁё]/.test(description)));
  assert(HELP_TEXT.includes("КАК ЭТО РАБОТАЕТ"));
  assert(text.includes("Example project"));
  assert(text.includes("Проект: Example project"));
  assert(text.includes("Уровень рассуждений"));
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
