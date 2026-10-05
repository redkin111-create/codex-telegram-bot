import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, InlineKeyboard } from "grammy";
import type { AppConfig } from "../src/config.js";
import type { PromptInput } from "../src/app/types.js";
import { defaultSettings, textPrompt } from "../src/app/types.js";
import { ChatController } from "../src/bot/chat-controller.js";
import { registerDocuments } from "../src/bot/handlers/document.js";
import { registerPhotos } from "../src/bot/handlers/photo.js";
import { buildRunningCard, switchAndShow } from "../src/bot/handlers/running.js";
import { LiveSessionConflictError, SessionRuntime } from "../src/bot/session-runtime.js";
import type { AcpClient } from "../src/acp/client.js";

const CHAT_ID = 733;
const DESKTOP_ID = "00000000-0000-4000-8000-000000000733";
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type RegisteredHandler = (ctx: Context, next?: () => Promise<void>) => Promise<void>;
type OutgoingMessage = { text: string; extra?: Record<string, unknown> };

function handlerFor(register: (bot: never, deps: never) => void, filter: string, deps: unknown): RegisteredHandler {
  const handlers: Array<{ filter: unknown; handler: unknown }> = [];
  const bot = { on: (event: unknown, handler: unknown) => handlers.push({ filter: event, handler }) };
  register(bot as never, deps as never);
  const entry = handlers.find(({ filter: event }) => event === filter);
  assert(entry, `handler not registered for ${filter}`);
  return entry.handler as RegisteredHandler;
}

function telegramApi(outgoing: OutgoingMessage[]) {
  return {
    getFile: async (fileId: string) => ({ file_path: `${fileId}.bin` }),
    sendMessage: async (_chatId: number, text: string, extra?: Record<string, unknown>) => {
      outgoing.push({ text, extra });
      return { message_id: outgoing.length };
    },
    sendChatAction: async () => {},
  };
}

function mockFetch(bytes: Buffer): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array(bytes))) as typeof fetch;
  return () => { globalThis.fetch = previous; };
}

function createController(
  dir: string,
  chatId: number,
  settingsPatch: Record<string, unknown> = {},
  loadSession: (sessionId: string) => Promise<void> = async () => { throw new Error("thread already active in another process"); },
) {
  const outgoing: OutgoingMessage[] = [];
  const api = telegramApi(outgoing);
  let starts = 0;
  let prompts = 0;
  const acp = Object.assign(new EventEmitter(), {
    loadSession,
    newSession: async () => { starts++; return `unexpected-${starts}`; },
    prompt: async () => { prompts++; return { stopReason: "end_turn" }; },
  }) as unknown as AcpClient;
  Object.defineProperty(acp, "supportsLoadSession", { value: true });
  let currentSettings = { ...defaultSettings(), ...settingsPatch };
  const settings = {
    get: () => currentSettings,
    update: (_chatId: number, patch: Partial<typeof currentSettings>) => { currentSettings = { ...currentSettings, ...patch }; },
  };
  const cfg = {
    workspace: dir,
    dataDir: dir,
    sessionsDir: dir,
    token: "test-token",
    docMaxChars: 1000,
    quietNotifications: true,
    streamThrottleMs: 10,
    progressFallback: false,
    showToolCalls: false,
    showEditDiffs: false,
    diffMaxLines: 8,
    promptRetryAttempts: 0,
    autoForkOnError: false,
    resumeOnStreamError: false,
    notifyOtherSessions: false,
  } as AppConfig;
  const controller = new ChatController(
    api as never,
    chatId,
    acp,
    cfg,
    settings as never,
    { jsonlPath: (id: string) => join(dir, `${id}.jsonl`) } as never,
    () => {},
    () => {},
  );
  return { controller, api, acp, outgoing, get starts() { return starts; }, get prompts() { return prompts; } };
}

function documentContext(api: ReturnType<typeof telegramApi>, fileId: string, replies: string[], messageId: number): Context {
  return {
    api,
    chat: { id: CHAT_ID },
    message: {
      document: { file_id: fileId, file_name: "report.zip", mime_type: "application/zip", file_size: ZIP_BYTES.length },
      caption: "проверь архив",
      message_id: messageId,
    },
    replyWithChatAction: async () => {},
    reply: async (text: string) => { replies.push(text); },
  } as unknown as Context;
}

function photoContext(api: ReturnType<typeof telegramApi>, fileId: string, messageId: number): Context {
  return {
    api,
    chat: { id: CHAT_ID },
    message: {
      photo: [{ file_id: fileId, file_size: PNG_BYTES.length }],
      caption: "проверь изображение",
      message_id: messageId,
    },
  } as unknown as Context;
}

test("document held and blocked do not claim success; the pending file survives and the next file is cleaned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-document-route-"));
  const restoreFetch = mockFetch(ZIP_BYTES);
  const fixture = createController(dir, CHAT_ID, { sessionId: DESKTOP_ID, projectPath: dir, projectName: "project" });
  const replies: string[] = [];
  const inputs: PromptInput[] = [];
  const deps = {
    cfg: { token: "test-token", docMaxChars: 1000, dataDir: dir },
    wizard: { isActive: () => false },
    registry: { submitPrompt: (_id: number, input: PromptInput) => { inputs.push(input); return fixture.controller.submitPrompt(input); } },
  };
  const handle = handlerFor(registerDocuments as never, "message:document", deps);
  try {
    await handle(documentContext(fixture.api, "held-document", replies, 1));
    const pendingPath = inputs[0]?.attachmentPaths?.[0];
    assert(pendingPath && existsSync(pendingPath));
    assert.equal(replies.some((text) => /Файл (?:добавлен|отправлен)/.test(text)), false);
    assert(fixture.outgoing.some(({ text }) => text.includes("Сообщение сохранено и не отправлено")));

    await handle(documentContext(fixture.api, "blocked-document", replies, 2));
    const blockedPath = inputs[1]?.attachmentPaths?.[0];
    assert(blockedPath);
    for (let i = 0; i < 50 && existsSync(blockedPath); i++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(existsSync(pendingPath), true);
    assert.equal(existsSync(blockedPath), false);
    assert.equal(replies.some((text) => /Файл (?:добавлен|отправлен)/.test(text)), false);
    assert(fixture.outgoing.some(({ text }) => text.includes("одно ожидающее сообщение")));
    assert.equal(fixture.starts, 0);
  } finally {
    fixture.controller.dispose();
    rmSync(dir, { recursive: true, force: true });
    restoreFetch();
  }
});

test("photo held and blocked do not claim the image was sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-photo-route-"));
  const restoreFetch = mockFetch(PNG_BYTES);
  const fixture = createController(dir, CHAT_ID, { sessionId: DESKTOP_ID, projectPath: dir, projectName: "project" });
  const inputs: PromptInput[] = [];
  const deps = {
    cfg: { token: "test-token" },
    api: fixture.api,
    wizard: { isActive: () => false },
    registry: { submitPrompt: (_id: number, input: PromptInput) => { inputs.push(input); return fixture.controller.submitPrompt(input); } },
  };
  const handle = handlerFor(registerPhotos as never, "message:photo", deps);
  try {
    await handle(photoContext(fixture.api, "held-photo", 1));
    await handle(photoContext(fixture.api, "blocked-photo", 2));
    assert.equal(inputs[0]?.images.length, 1);
    assert.equal(fixture.outgoing.some(({ text }) => text === "🖼 Изображение отправлено в текущую задачу."), false);
    assert.equal(fixture.outgoing.some(({ text }) => text === "🖼 Изображение добавлено к задаче."), false);
    assert(fixture.outgoing.some(({ text }) => text.includes("Сообщение сохранено и не отправлено")));
    assert(fixture.outgoing.some(({ text }) => text.includes("одно ожидающее сообщение")));
    assert.equal(fixture.starts, 0);
  } finally {
    fixture.controller.dispose();
    rmSync(dir, { recursive: true, force: true });
    restoreFetch();
  }
});

test("queued document and photo confirmations include queue position and preserve the caption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-attachment-queue-"));
  const restoreFetch = mockFetch(ZIP_BYTES);
  const outgoing: OutgoingMessage[] = [];
  const api = telegramApi(outgoing);
  const inputs: PromptInput[] = [];
  const deps = {
    cfg: { token: "test-token", docMaxChars: 1000, dataDir: dir },
    api,
    wizard: { isActive: () => false },
    registry: { submitPrompt: async (_id: number, input: PromptInput) => {
      inputs.push(input);
      return { kind: "submitted", outcome: "queued", runtime: { queueLength: 3 } };
    } },
  };
  const documentReplies: string[] = [];
  const handleDocument = handlerFor(registerDocuments as never, "message:document", deps);
  const handlePhoto = handlerFor(registerPhotos as never, "message:photo", deps);
  try {
    await handleDocument(documentContext(api, "queued-document", documentReplies, 1));
    assert.equal(inputs[0]?.displayText, "проверь архив");
    assert.equal(inputs[0]?.attachmentNames?.[0], "report.zip");
    assert(documentReplies.some((text) => text.includes("добавлен в очередь · позиция 3")));

    restoreFetch();
    const restorePngFetch = mockFetch(PNG_BYTES);
    await handlePhoto(photoContext(api, "queued-photo", 2));
    assert.equal(inputs[1]?.text, "проверь изображение");
    assert.equal(inputs[1]?.images.length, 1);
    assert(outgoing.some(({ text }) => text.includes("Изображение добавлено в очередь · позиция 3")));
    restorePngFetch();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    restoreFetch();
  }
});

test("switchTo and addResume expose Desktop conflicts without changing IDs or starting sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-switch-conflict-"));
  const fixture = createController(dir, CHAT_ID, {
    controlledSessions: [
      { sessionId: "previous-thread", projectPath: dir, projectName: "previous" },
      { sessionId: DESKTOP_ID, projectPath: dir, projectName: "desktop" },
    ],
    foregroundSessionId: "previous-thread",
  });
  try {
    const switched = await fixture.controller.switchTo(DESKTOP_ID);
    assert.equal(switched?.handoff, "live-conflict");
    assert.equal(switched?.sessionId, DESKTOP_ID);
    assert.equal(switched?.rt.isWatching, false);
    assert.equal(fixture.controller.count(), 2);
    assert.equal(fixture.controller.list().find((session) => session.sessionId === DESKTOP_ID)?.foreground, true);
    await assert.rejects(fixture.controller.addAttach(DESKTOP_ID, dir, "desktop", []), LiveSessionConflictError);
    assert.equal(fixture.controller.list().find((session) => session.sessionId === DESKTOP_ID)?.sessionId, DESKTOP_ID);
    assert.equal(fixture.starts, 0);
  } finally {
    fixture.controller.dispose();
  }

  const resumeFixture = createController(dir, CHAT_ID + 1);
  try {
    const resumed = await resumeFixture.controller.addResume(DESKTOP_ID, dir, "desktop");
    assert.equal(resumed.handoff, "live-conflict");
    assert.equal(resumed.sessionId, DESKTOP_ID);
    assert.equal(resumed.rt.sessionId, DESKTOP_ID);
    assert.equal(resumeFixture.controller.count(), 1);
    assert.equal(resumeFixture.controller.list()[0]?.foreground, true);
    assert.equal(resumeFixture.starts, 0);
  } finally {
    resumeFixture.controller.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reselecting the watched Desktop session preserves pending input, attachment, and its watcher", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-same-handoff-"));
  const incoming = join(dir, "telegram-incoming");
  mkdirSync(incoming);
  const attachment = join(incoming, "private-note.txt");
  writeFileSync(attachment, "private attachment", "utf8");
  const fixture = createController(dir, CHAT_ID, { sessionId: DESKTOP_ID, projectPath: dir, projectName: "project" });
  const replies: Array<{ text: string; extra?: Record<string, unknown> }> = [];
  try {
    const input = textPrompt("private pending prompt");
    input.attachmentPaths = [attachment];
    const routed = await fixture.controller.submitPrompt(input);
    assert.equal(routed.kind, "held");
    const pending = fixture.controller.pendingHandoffFor(DESKTOP_ID);
    assert(pending?.token);
    assert.equal(existsSync(attachment), true);

    const runtime = fixture.controller.runtimeForSession(DESKTOP_ID)!;
    assert.equal(runtime.isWatching, true);
    const originalStart = runtime.startWatch.bind(runtime);
    const originalStop = runtime.stopWatch.bind(runtime);
    let starts = 0;
    let stops = 0;
    runtime.startWatch = ((path: string, follow?: boolean) => { starts++; originalStart(path, follow); }) as typeof runtime.startWatch;
    runtime.stopWatch = (() => { stops++; return originalStop(); }) as typeof runtime.stopWatch;

    const switched = await fixture.controller.switchTo(DESKTOP_ID);
    assert.equal(switched?.handoff, "live-conflict");
    assert.equal(switched?.pendingHandoffToken, pending.token);
    assert.equal(fixture.controller.pendingHandoffFor(DESKTOP_ID)?.token, pending.token);
    assert.equal(fixture.controller.watchTarget(DESKTOP_ID)?.cwd, dir);
    assert.equal(runtime.isWatching, true);
    assert.equal(existsSync(attachment), true);
    assert.equal(starts, 0);
    assert.equal(stops, 0);
    assert.equal(fixture.starts, 0);

    await switchAndShow(
      { chat: { id: CHAT_ID }, reply: async (text: string, extra?: Record<string, unknown>) => { replies.push({ text, extra }); } } as unknown as Context,
      {
        registry: { controller: () => fixture.controller },
        store: { get: () => ({ title: "Desktop session" }) },
        settings: { get: () => defaultSettings() },
        cfg: { quietNotifications: false },
      } as never,
      DESKTOP_ID,
    );
    assert(replies[0]?.text.includes("Есть сохранённое сообщение"));
    assert.equal(replies[0]?.text.includes("private pending prompt"), false);
    const keyboard = replies[0]?.extra?.reply_markup as InlineKeyboard;
    const actions = keyboard.inline_keyboard.flatMap((row) => row.flatMap((button) => "callback_data" in button ? [button.callback_data] : []));
    assert(actions.includes(`handoff:watch:${DESKTOP_ID}`));
    assert(actions.includes(`handoff:send:${pending.token}`));
    assert(actions.includes(`handoff:cancel:${pending.token}`));
    assert.equal(actions.includes(`handoff:fork:${DESKTOP_ID}`), false);
    assert.equal(runtime.isWatching, true);
    assert.equal(starts, 0);
    assert.equal(stops, 0);
    assert.equal(fixture.prompts, 0);
  } finally {
    fixture.controller.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switching from a watched session to a different session cancels its pending prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-other-handoff-"));
  const incoming = join(dir, "telegram-incoming");
  mkdirSync(incoming);
  const attachment = join(incoming, "pending.txt");
  writeFileSync(attachment, "pending", "utf8");
  const otherId = "00000000-0000-4000-8000-000000000734";
  const fixture = createController(dir, CHAT_ID, {
    controlledSessions: [
      { sessionId: DESKTOP_ID, projectPath: dir, projectName: "A" },
      { sessionId: otherId, projectPath: dir, projectName: "B" },
    ],
    foregroundSessionId: DESKTOP_ID,
  }, async (sessionId) => {
    if (sessionId === DESKTOP_ID) throw new Error("thread already active in another process");
  });
  try {
    const input = textPrompt("do not send to B");
    input.attachmentPaths = [attachment];
    assert.equal((await fixture.controller.submitPrompt(input)).kind, "held");
    const runtimeA = fixture.controller.runtimeForSession(DESKTOP_ID)!;
    assert.equal(runtimeA.isWatching, true);
    assert(fixture.controller.pendingHandoffFor(DESKTOP_ID));

    const switched = await fixture.controller.switchTo(otherId);
    assert.equal(switched?.handoff, undefined);
    assert.equal(fixture.controller.pendingHandoffFor(DESKTOP_ID), undefined);
    assert.equal(fixture.controller.watchTarget(DESKTOP_ID), undefined);
    assert.equal(runtimeA.isWatching, false);
    assert.equal(fixture.controller.list().find((session) => session.sessionId === otherId)?.foreground, true);
    assert.equal(fixture.prompts, 0);
    assert.equal(fixture.starts, 0);
    for (let i = 0; i < 50 && existsSync(attachment); i++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(existsSync(attachment), false);
  } finally {
    fixture.controller.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("if the same watched session becomes available, pending input is cancelled with notice and never auto-sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-released-handoff-"));
  const incoming = join(dir, "telegram-incoming");
  mkdirSync(incoming);
  const attachment = join(incoming, "pending.txt");
  writeFileSync(attachment, "pending", "utf8");
  let loads = 0;
  const fixture = createController(dir, CHAT_ID, { sessionId: DESKTOP_ID, projectPath: dir, projectName: "project" }, async () => {
    loads++;
    if (loads === 1) throw new Error("thread already active in another process");
  });
  try {
    const input = textPrompt("do not silently send");
    input.attachmentPaths = [attachment];
    assert.equal((await fixture.controller.submitPrompt(input)).kind, "held");
    const runtime = fixture.controller.runtimeForSession(DESKTOP_ID)!;
    assert.equal(runtime.isWatching, true);
    assert(fixture.controller.pendingHandoffFor(DESKTOP_ID));

    const switched = await fixture.controller.switchTo(DESKTOP_ID);
    assert.equal(switched?.handoff, undefined);
    assert.equal(fixture.controller.pendingHandoffFor(DESKTOP_ID), undefined);
    assert.equal(runtime.isWatching, false);
    assert.equal(runtime.sessionId, DESKTOP_ID);
    assert.equal(fixture.outgoing.some(({ text }) => text.toLowerCase().includes("ожидающее сообщение отменено — отправьте его повторно")), true);
    assert.equal(fixture.prompts, 0);
    assert.equal(fixture.starts, 0);
    for (let i = 0; i < 50 && existsSync(attachment); i++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(existsSync(attachment), false);
  } finally {
    fixture.controller.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normal switches and non-conflict prepare errors do not show Desktop handoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-switch-normal-"));
  const settings = {
    controlledSessions: [
      { sessionId: "previous-thread", projectPath: dir, projectName: "previous" },
      { sessionId: DESKTOP_ID, projectPath: dir, projectName: "desktop" },
    ],
    foregroundSessionId: "previous-thread",
  };
  const fixture = createController(dir, CHAT_ID, settings, async () => {});
  const originalPrepare = SessionRuntime.prototype.prepare;
  try {
    const normal = await fixture.controller.switchTo(DESKTOP_ID);
    assert.equal(normal?.handoff, undefined);
    assert.equal(normal?.rt.sessionId, DESKTOP_ID);

    SessionRuntime.prototype.prepare = async function () { throw new Error("connection reset"); };
    const bestEffort = await fixture.controller.switchTo("previous-thread");
    assert.equal(bestEffort?.handoff, undefined);
  } finally {
    SessionRuntime.prototype.prepare = originalPrepare;
    fixture.controller.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("running screen checks the current session and live-conflict switch shows handoff buttons", async () => {
  const card = buildRunningCard({
    sessionId: DESKTOP_ID,
    cwd: "C:\\work",
    projectName: "project",
    busy: false,
    foreground: true,
    unread: 0,
    queueLength: 0,
    queuePaused: false,
  }, { store: { jsonlPath: () => join(tmpdir(), "missing-running.jsonl"), get: () => undefined } } as never, Date.now());
  const cardActions = card.kb.inline_keyboard.flatMap((row) => row.flatMap((button) => "callback_data" in button ? [button.callback_data] : []));
  assert(cardActions.includes(`run:check:${DESKTOP_ID}`));

  const replies: Array<{ text: string; extra?: Record<string, unknown> }> = [];
  const controller = { switchTo: async () => ({
    rt: {} as SessionRuntime,
    sessionId: DESKTOP_ID,
    projectName: "project",
    busy: false,
    unread: [],
    firstView: false,
    alreadyForeground: true,
    handoff: "live-conflict" as const,
  }) };
  await switchAndShow(
    { chat: { id: CHAT_ID }, reply: async (text: string, extra?: Record<string, unknown>) => { replies.push({ text, extra }); } } as unknown as Context,
    {
      registry: { controller: () => controller },
      store: { get: () => ({ title: "Desktop session" }) },
      settings: { get: () => defaultSettings() },
      cfg: { quietNotifications: false },
    } as never,
    DESKTOP_ID,
  );
  assert(replies[0]?.text.includes("открыт в Codex Desktop"));
  const keyboard = replies[0]?.extra?.reply_markup as InlineKeyboard;
  const actions = keyboard.inline_keyboard.flatMap((row) => row.flatMap((button) => "callback_data" in button ? [button.callback_data] : []));
  assert(actions.includes(`handoff:watch:${DESKTOP_ID}`));
  assert(actions.includes(`handoff:fork:${DESKTOP_ID}`));
});
