import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import type { AcpClient } from "../src/acp/client.js";
import type { SessionUpdate, RequestPermissionParams } from "../src/acp/types.js";
import { decidePermissionsApproval, describeRequestedPermissions } from "../src/acp/approvals.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { showHistory } from "../src/bot/handlers/history.js";
import { PermissionService } from "../src/bot/permission-service.js";
import { SessionRuntime } from "../src/bot/session-runtime.js";
import { briefErrorMessage, formatErrorSummary, formatRetryNotice } from "../src/bot/prompt-retry.js";
import { conversationEntries, parseEventLine, readConversationHistory } from "../src/sessions/history.js";

test("history hides prompt rules previously added by the bot", () => {
  const oldPrompt = [
    "Пиши пояснения и сообщения пользователю по-русски. Сохраняй исходный язык кода, цитат и контента. Если пользователь явно просит другой язык, выполни просьбу. В Telegram по умолчанию кратко опиши результат человеческим языком: не копируй уже выполненные команды, сырой stdout/stderr, большие diff и длинные блоки кода без запроса. Если пользователь просит код, команду или diff, покажи их. Эти правила относятся только к ответу пользователю и не ограничивают работу с инструментами.",
    "Моё короткое сообщение",
    "PROGRESS REPORTING IS MANDATORY ON EVERY SINGLE MESSAGE YOU SEND — NO EXCEPTIONS.",
    "ещё много старых правил",
  ].join("\n\n");
  const entry = parseEventLine(JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: oldPrompt }] },
  }));
  assert.equal(entry?.text, "Моё короткое сообщение");
});
import type { SettingsStore } from "../src/app/settings-store.js";

test("clean Telegram defaults hide tools and diffs while explicit settings still work", () => {
  const keys = ["TELEGRAM_BOT_TOKEN", "ALLOWED_USERS", "SHOW_TOOL_CALLS", "SHOW_EDIT_DIFFS"] as const;
  const saved = keys.map((key) => process.env[key]);
  try {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.ALLOWED_USERS = "7";
    delete process.env.SHOW_TOOL_CALLS;
    delete process.env.SHOW_EDIT_DIFFS;
    const defaults = loadConfig();
    assert.equal(defaults.showToolCalls, false);
    assert.equal(defaults.showEditDiffs, false);

    process.env.SHOW_TOOL_CALLS = "true";
    process.env.SHOW_EDIT_DIFFS = "true";
    const verbose = loadConfig();
    assert.equal(verbose.showToolCalls, true);
    assert.equal(verbose.showEditDiffs, true);
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index]!;
    });
  }
});

test("clean mode hides command and diff updates but preserves assistant text", () => {
  const acp = Object.assign(new EventEmitter(), { metadataFor: () => undefined });
  const api = {} as Api;
  const cfg = {
    workspace: tmpdir(),
    showToolCalls: false,
    showEditDiffs: false,
    showSubagents: true,
  } as AppConfig;
  const runtime = new SessionRuntime(
    api,
    42,
    acp as unknown as AcpClient,
    cfg,
    {} as SettingsStore,
    { cwd: tmpdir(), sessionId: "session-id" },
  );
  const shown = { output: [] as string[], thoughts: [] as string[], summaries: [] as string[], tools: [] as string[] };
  const internal = runtime as unknown as {
    busy: boolean;
    streamer: {
      appendOutput: (text: string) => void;
      appendThought: (text: string) => void;
      appendReasoningSummary: (text: string) => void;
      addTool: (text: string) => void;
    };
    toolActivity: boolean;
    onUpdate: (sessionId: string, update: SessionUpdate) => void;
  };
  internal.busy = true;
  internal.streamer = {
    appendOutput: (text) => shown.output.push(text),
    appendThought: (text) => shown.thoughts.push(text),
    appendReasoningSummary: (text) => shown.summaries.push(text),
    addTool: (text) => shown.tools.push(text),
  };
  internal.onUpdate("session-id", {
    sessionUpdate: "tool_call",
    title: "Run command",
    rawInput: { command: "Get-ChildItem C:\\secret-folder" },
    content_blocks: [
      { type: "diff", unified: "SECRET_DIFF" },
      { type: "content", content: { type: "text", text: "SECRET_STDOUT\nSECRET_STDERR" } },
    ],
  });
  internal.onUpdate("session-id", {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "INTERNAL_THOUGHT" },
  });
  internal.onUpdate("session-id", {
    sessionUpdate: "agent_reasoning_summary_chunk",
    content: { type: "text", text: "Проверяю настройки проекта…" },
  });
  internal.onUpdate("session-id", {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Готово: файл обновлён." },
  });

  assert.equal(internal.toolActivity, true);
  assert.deepEqual(shown.tools, []);
  assert.deepEqual(shown.thoughts, []);
  assert.deepEqual(shown.summaries, ["Проверяю настройки проекта…"]);
  assert.deepEqual(shown.output, ["Готово: файл обновлён."]);
  const completion = (runtime as unknown as {
    completionMessage: (reason: string, startedAt: number, streamedOutput: boolean) => string;
  }).completionMessage("end_turn", Date.now() - 1_000, true);
  assert(completion.includes("✅ Готово"));
  assert(!completion.includes("#proj_") && !completion.includes("#sess_"));
  runtime.dispose();
});

test("history replay keeps recent user and assistant messages, excluding tool traces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-clean-history-"));
  const path = join(dir, "history.jsonl");
  try {
    const rows = [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Сделай задачу" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Начинаю." }] } },
      ...Array.from({ length: 30 }, (_, i) => ({
        type: "response_item",
        payload: { type: "local_shell_call", command: `SECRET_COMMAND_${i}` },
      })),
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Продолжай" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Готово." }] } },
    ];
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"));
    const history = readConversationHistory(path, 2);
    assert.deepEqual(history.map((entry) => [entry.role, entry.text]), [
      ["user", "Продолжай"],
      ["assistant", "Готово."],
    ]);
    assert(!JSON.stringify(history).includes("SECRET_COMMAND"));

    let sent = "";
    const deps = {
      api: { sendMessage: async (_chatId: number, text: string) => { sent = text; return { message_id: 1 }; } },
      store: { jsonlPath: () => path },
    };
    await showHistory(deps as never, 42, "session-id", {
      sessionId: "session-id",
      cwd: dir,
      title: "Диалог",
      createdAt: "",
      updatedAt: "",
      active: false,
      historyBytes: 0,
    }, 2);
    assert(sent.includes("Продолжай") && (sent.includes("Готово.") || sent.includes("Готово\\.")));
    assert(!sent.includes("SECRET_COMMAND") && !sent.includes("#proj_") && !sent.includes("#sess_"));
    assert.deepEqual(conversationEntries([
      { role: "user", text: "Вопрос", timestamp: 1 },
      { role: "tool", text: "SECRET_COMMAND", tool: "shell", timestamp: 2 },
      { role: "system", text: "Внутреннее", timestamp: 3 },
      { role: "assistant", text: "Ответ", timestamp: 4 },
    ]).map((entry) => entry.role), ["user", "assistant"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verbose tool display remains available when explicitly enabled", () => {
  const acp = Object.assign(new EventEmitter(), { metadataFor: () => undefined });
  const runtime = new SessionRuntime(
    {} as Api,
    42,
    acp as unknown as AcpClient,
    { workspace: tmpdir(), showToolCalls: true, showEditDiffs: true, showSubagents: true } as AppConfig,
    {} as SettingsStore,
    { cwd: tmpdir(), sessionId: "session-id" },
  );
  const shown: string[] = [];
  const internal = runtime as unknown as {
    busy: boolean;
    streamer: { addTool: (text: string) => void };
    onUpdate: (sessionId: string, update: SessionUpdate) => void;
  };
  internal.busy = true;
  internal.streamer = { addTool: (text) => shown.push(text) };
  internal.onUpdate("session-id", {
    sessionUpdate: "tool_call",
    kind: "execute",
    rawInput: { command: "npm test" },
  });
  assert.equal(shown.length, 1);
  assert(shown[0]!.includes("npm test"));
  runtime.dispose();
});

test("approval prompts still show the command and resolve the selected option", async () => {
  let prompt = "";
  let keyboard: unknown;
  const api = {
    sendMessage: async (_chatId: number, text: string, extra: { reply_markup?: unknown }) => {
      prompt = text;
      keyboard = extra.reply_markup;
      return { message_id: 10 };
    },
  } as unknown as Api;
  const registry = {
    describeSession: () => ({ chatId: 55, controlled: true, subagent: false, projectName: "Проект" }),
    get: () => ({ sessionId: "session-1" }),
  };
  const permissions = new PermissionService(api, registry as never);
  const params: RequestPermissionParams = {
    sessionId: "session-1",
    toolCall: { kind: "execute", title: "Запуск команды", rawInput: { command: "git push origin feature/test" } },
    options: [{ optionId: "allow-once", name: "Allow once" }, { optionId: "reject", name: "Reject" }],
  };

  const pending = permissions.handle(params);
  await Promise.resolve();
  assert(prompt.includes("git push origin feature/test"));
  assert(keyboard);
  assert.equal(permissions.resolveChoice("1", 0), "Разрешить");
  assert.deepEqual(await pending, { outcome: { outcome: "selected", optionId: "allow-once" } });
});

test("Codex permission approval grants only the requested profile for the current turn", async () => {
  const requested = { fileSystem: { write: ["C:\\test\\allowed"], entries: [{ path: { type: "path", path: "C:\\test\\allowed" }, access: "write" }] } };
  assert.deepEqual(describeRequestedPermissions(requested), ["Изменение: C:\\test\\allowed"]);
  let prompt: RequestPermissionParams | undefined;
  const response = await decidePermissionsApproval(
    { threadId: "thread-1", itemId: "item-1", reason: "Создать отчёт", permissions: requested },
    false,
    async (params) => {
      prompt = params;
      return { outcome: { outcome: "selected", optionId: "grant" } };
    },
  );
  assert.equal(prompt?.reason, "Создать отчёт");
  assert.equal(prompt?.options[0]?.name, "Разрешить один раз");
  assert.deepEqual(response, { permissions: requested, scope: "turn", strictAutoReview: false });
});

test("Codex permission approval denies on reject, missing handler, and unknown scope", async () => {
  const requested = { network: { enabled: true } };
  const denied = await decidePermissionsApproval({ permissions: requested }, false, async () => ({
    outcome: { outcome: "selected", optionId: "deny" },
  }));
  const unattended = await decidePermissionsApproval({ permissions: requested }, false, undefined);
  const unknown = await decidePermissionsApproval({ permissions: { futurePermission: true } }, false, async () => {
    throw new Error("must not ask to approve an unknown scope");
  });
  assert.deepEqual(denied, { permissions: {}, scope: "turn", strictAutoReview: false });
  assert.deepEqual(unattended, denied);
  assert.deepEqual(unknown, denied);
});

test("Telegram permission prompts show the exact requested path and one-time choices", async () => {
  let prompt = "";
  let keyboard: { inline_keyboard?: Array<Array<{ text?: string }>> } | undefined;
  const api = {
    sendMessage: async (_chatId: number, text: string, extra: { reply_markup?: unknown }) => {
      prompt = text;
      keyboard = extra.reply_markup as typeof keyboard;
      return { message_id: 11 };
    },
  } as unknown as Api;
  const registry = {
    describeSession: () => ({ chatId: 55, controlled: true, subagent: false, projectName: "Проект" }),
    get: () => ({ sessionId: "session-1" }),
  };
  const permissions = new PermissionService(api, registry as never);
  const pending = permissions.handle({
    sessionId: "session-1",
    options: [],
    permissions: { fileSystem: { write: ["C:\\test\\outside"] } },
    reason: "Записать безопасный тестовый файл",
  });
  await Promise.resolve();
  assert(prompt.includes("Изменение: C:\\test\\outside"));
  assert(prompt.includes("только для этого запроса"));
  assert.deepEqual(keyboard?.inline_keyboard?.[0]?.map((button) => button.text), ["✅ Разрешить один раз", "⛔ Отклонить"]);
  assert.equal(permissions.resolveChoice("1", 1), "Отклонить");
  assert.deepEqual(await pending, { outcome: { outcome: "selected", optionId: "deny" } });
});

test("retry and failure notices stay concise and omit multiline command output", () => {
  const error = new Error("Сервис временно недоступен\nstdout: SECRET_OUTPUT\nstderr: SECRET_ERROR");
  assert.equal(briefErrorMessage(error), "Сервис временно недоступен");
  const retry = formatRetryNotice(error, 1, 3, 6_000);
  const failure = formatErrorSummary(error, "2 с", 1, false);
  for (const text of [retry, failure]) {
    assert(!text.includes("SECRET_OUTPUT"));
    assert(!text.includes("SECRET_ERROR"));
  }
  assert(retry.includes("Повтор через 6 с"));
  assert(failure.includes("Причина: Сервис временно недоступен"));
});
