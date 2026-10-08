import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import type { AcpClient } from "../src/acp/client.js";
import type { AppConfig } from "../src/config.js";
import { JsonStore } from "../src/app/json-store.js";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "../src/app/notifications.js";
import { defaultSettings, textPrompt } from "../src/app/types.js";
import { ChatController } from "../src/bot/chat-controller.js";
import { DurableQueueStore } from "../src/bot/durable-queue.js";
import { SessionRuntime } from "../src/bot/session-runtime.js";
import { cleanupIncomingAttachments, saveIncomingAttachment } from "../src/bot/incoming-files.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const cfgFor = (dir: string) => ({
  workspace: dir, dataDir: dir, sessionsDir: dir, streamThrottleMs: 5,
  promptRetryAttempts: 0, autoForkOnError: false, resumeOnStreamError: false,
  notifyOtherSessions: false, quietNotifications: false, progressFallback: false,
}) as AppConfig;
const settingStub = { get: () => ({ reasoning: "medium", notifications: DEFAULT_NOTIFICATION_PREFERENCES }) };

test("a queued turn starts before Telegram's progress notification is delivered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-queue-race-"));
  let started = 0;
  let releaseTurn: (() => void) | undefined;
  const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const api = {
    sendMessage: async (_chatId: number, message: string) => {
      if (message.includes("Выполняю сообщение из очереди")) {
        return new Promise<{ message_id: number }>(() => {}); // Telegram is unresponsive.
      }
      return { message_id: 1 };
    },
    sendChatAction: async () => true,
    editMessageText: async () => true,
  } as unknown as Api;
  const acp = Object.assign(new EventEmitter(), {
    prompt: async () => { started++; await turnGate; return { stopReason: "end_turn" }; },
    metadataFor: () => undefined,
  }) as unknown as AcpClient;
  const runtime = new SessionRuntime(api, 2201, acp, cfgFor(dir), settingStub as never, { cwd: dir, sessionId: "queue-race" });
  Object.assign(runtime as unknown as Record<string, unknown>, { busy: true, sessionLive: true, rebindPending: false });
  try {
    assert.equal(await runtime.submit(textPrompt("first")), "queued");
    Object.assign(runtime as unknown as Record<string, unknown>, { busy: false });
    assert.equal(runtime.resumeQueue(), true);
    await tick();
    assert.equal(runtime.isBusy, true);
    assert.equal(await runtime.submit(textPrompt("second")), "queued");
    assert.equal(started, 1, "the second prompt must never run in parallel");
    assert.equal(runtime.queueLength, 1);
    runtime.clearQueue();
  } finally {
    releaseTurn?.();
    for (let i = 0; i < 100 && runtime.isBusy; i++) await tick();
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parallel initial messages share a single Codex load operation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-rebind-race-"));
  let loads = 0;
  let releaseLoad: (() => void) | undefined;
  let releaseTurn: (() => void) | undefined;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const acp = Object.assign(new EventEmitter(), {
    loadSession: async () => { loads++; await loadGate; },
    prompt: async () => { await turnGate; return { stopReason: "end_turn" }; },
    metadataFor: () => undefined,
  }) as unknown as AcpClient;
  const rt = new SessionRuntime({} as Api, 2202, acp, cfgFor(dir), settingStub as never, { cwd: dir, sessionId: "restored" });
  Object.assign(rt as unknown as Record<string, unknown>, { foreground: false });
  try {
    const a = rt.submit(textPrompt("one"));
    const b = rt.submit(textPrompt("two"));
    await tick();
    assert.equal(loads, 1);
    releaseLoad?.();
    const outcomes = await Promise.all([a, b]);
    assert.deepEqual(outcomes.sort(), ["queued", "ran"]);
    assert.equal(rt.queueLength, 1);
    rt.clearQueue();
  } finally {
    releaseLoad?.();
    releaseTurn?.();
    for (let i = 0; i < 100 && rt.isBusy; i++) await tick();
    rt.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closing a busy session or one with queued work is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-close-"));
  const id = "close-me";
  let state = { ...defaultSettings(), notifications: DEFAULT_NOTIFICATION_PREFERENCES, sessionId: id,
    projectPath: dir, foregroundSessionId: id, controlledSessions: [{ sessionId: id, projectPath: dir, projectName: "test" }] };
  const settings = {
    get: () => state,
    update: (_id: number, patch: Record<string, unknown>) => { state = { ...state, ...patch } as typeof state; },
  };
  const acp = Object.assign(new EventEmitter(), { metadataFor: () => undefined }) as unknown as AcpClient;
  const ctrl = new ChatController({} as Api, 2203, acp, cfgFor(dir), settings as never, { jsonlPath: () => "missing.jsonl" } as never, () => {}, () => {});
  try {
    const rt = ctrl.foreground();
    Object.assign(rt as unknown as Record<string, unknown>, { busy: true, rebindPending: false, sessionLive: true });
    assert.equal(await ctrl.close(id), false);
    assert.equal(ctrl.count(), 1);
    assert.equal(await rt.submit(textPrompt("queued")), "queued");
    Object.assign(rt as unknown as Record<string, unknown>, { busy: false });
    assert.equal(await ctrl.close(id), false);
    assert.equal(rt.queueLength, 1);
    assert.equal(rt.clearQueue(), 1);
    Object.assign(rt as unknown as Record<string, unknown>, { sessionInitialization: new Promise<void>(() => {}) });
    assert.equal(await ctrl.close(id), false, "cannot dispose a session during initialization");
    Object.assign(rt as unknown as Record<string, unknown>, { sessionInitialization: undefined });
    assert.equal(await ctrl.close(id), true);
    assert.equal(ctrl.count(), 0);
  } finally {
    ctrl.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("age-based attachment cleanup preserves queued files until queue removal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-attachment-gc-"));
  try {
    const saved = await saveIncomingAttachment(dir, "report.pdf", Buffer.from("%PDF-test"));
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(saved.path, old, old);
    const store = new DurableQueueStore(dir, 2204);
    const input = textPrompt("review PDF");
    input.attachmentPaths = [saved.path];
    store.save("session", { paused: true, items: [{ id: "one", input }] });
    assert.equal(await cleanupIncomingAttachments(dir), 0);
    assert(existsSync(saved.path));
    store.save("session", { paused: false, items: [] });
    assert.equal(await cleanupIncomingAttachments(dir), 1);
    assert.equal(existsSync(saved.path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt settings are not silently replaced with defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-json-corrupt-"));
  try {
    const path = join(dir, "settings.json");
    writeFileSync(path, "{not valid json");
    assert.throws(() => new JsonStore(path, { value: 1 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed JSON write does not change committed in-memory state", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-json-rollback-"));
  try {
    const target = join(dir, "settings.json");
    const store = new JsonStore(target, { value: 1 });
    mkdirSync(target); // rename(file, existing directory) fails on Windows and Linux.
    assert.throws(() => store.update((data) => { data.value = 2; }));
    assert.equal(store.get().value, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
