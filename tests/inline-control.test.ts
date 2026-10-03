import assert from "node:assert/strict";
import test from "node:test";
import type { Context, InlineKeyboard } from "grammy";
import { createAuthMiddleware } from "../src/bot/auth.js";
import { MenuCache } from "../src/bot/deps.js";
import { formatProbeResult, mainPanel } from "../src/bot/handlers/mcp.js";
import { modelPage, reasoningKeyboard, skillsPage } from "../src/bot/handlers/inline-catalog.js";
import { projectPage } from "../src/bot/handlers/projects.js";
import { sessionPage } from "../src/bot/handlers/sessions.js";
import { mainMenuInline } from "../src/bot/menu/keyboard.js";
import { mainMenuText } from "../src/bot/menu/main.js";
import { callbackDataFits } from "../src/bot/menu/paging.js";
import type { SessionMeta } from "../src/sessions/types.js";
import type { McpServer } from "../src/mcp/types.js";

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

test("model, skill, reasoning, and home keyboards use short callback data", () => {
  const model = modelPage([{ modelId: "a-model-id", name: "A model name that is intentionally very long" }], 0, "0123456789abcdef", "a-model-id");
  const emptyModel = modelPage([], 0, "0123456789abcdef");
  const skill = skillsPage([{ name: "A skill with a very long name", description: "details" }], 0, "0123456789abcdef");
  const emptySkill = skillsPage([], 0, "0123456789abcdef");
  const reasoning = reasoningKeyboard("high");
  const home = mainMenuInline({ busy: true });
  assert(model.text.includes("✅"));
  assert(emptyModel.text.includes("No selectable models"));
  assert(emptySkill.text.includes("No enabled skills"));
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
    reasoning: "High",
    sandbox: "workspace-write",
    approval: "on request",
    unsafe: false,
    busy: false,
  });
  assert(callbacks(keyboard).includes("m:settings"));
  assert(callbacks(keyboard).includes("m:project"));
  assert(!callbacks(keyboard).includes("C:\\private\\workspace"));
  assert(text.includes("Example project"));
  assertCallbacksFit(keyboard);
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
  assert(livePanel.text.includes("1 tools · 1 resources · auth needed"));
  assert(liveOnlyPanel.text.includes("Reported by Codex app-server"));
  assert(callbacks(disabledPanel.kb).some((data) => data.startsWith("mcp:restart:")));
  assert(failed.includes("Process exited (code 1)"));
  assertCallbacksFit(panel.kb, livePanel.kb, liveOnlyPanel.kb, disabledPanel.kb);
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
  assert.equal(answer?.text, "⛔ Not authorized.");
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
