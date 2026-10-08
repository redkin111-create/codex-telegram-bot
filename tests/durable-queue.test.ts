import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import type { AcpClient } from "../src/acp/client.js";
import type { AppConfig } from "../src/config.js";
import { textPrompt } from "../src/app/types.js";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "../src/app/notifications.js";
import { DurableQueueStore } from "../src/bot/durable-queue.js";
import { SessionRuntime } from "../src/bot/session-runtime.js";
import { recentTranscript } from "../src/bot/session-fork.js";

test("durable queues are per chat/session, survive reload and move across forks", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-queue-"));
  try {
    const a = new DurableQueueStore(dir, 101);
    const b = new DurableQueueStore(dir, 101);
    const other = new DurableQueueStore(dir, 202);
    const item = { id: "one", input: textPrompt("review pending diff") };
    a.save("old", { items: [item], paused: false });
    assert.deepEqual(b.load("old").items.map((q) => q.input.text), [item.input.text]);
    assert.equal(other.load("old").items.length, 0);
    b.move("old", "new");
    assert.equal(a.load("old").items.length, 0);
    assert.equal(a.load("new").items[0]?.input.text, "review pending diff");
    a.save("new", { items: [], paused: false });
    assert.equal(b.load("new").items.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interrupted queued turn is restored paused for manual review", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-queue-recover-"));
  const cfg = { dataDir: dir, workspace: dir } as AppConfig;
  const settings = { get: () => ({ reasoning: "medium" }) };
  const acp = Object.assign(new EventEmitter(), { metadataFor: () => undefined }) as unknown as AcpClient;
  const store = new DurableQueueStore(dir, 1001);
  const interrupted = { id: "started", input: textPrompt("potentially touched source files") };
  const pending = { id: "later", input: textPrompt("run later") };
  try {
    store.save("existing", { items: [pending], inFlight: interrupted, paused: false });
    const rt = new SessionRuntime({} as Api, 1001, acp, cfg, settings as never, { cwd: dir, sessionId: "existing" });
    try {
      assert.equal(rt.isQueuePaused, true);
      assert.deepEqual(rt.queuedPrompts.map(({ id }) => id), ["started", "later"]);
      assert.equal(store.load("existing").inFlight, undefined);
      assert.equal(rt.editQueued("started", "review first"), true);
    } finally {
      rt.dispose();
    }
    const restored = new SessionRuntime({} as Api, 1001, acp, cfg, settings as never, { cwd: dir, sessionId: "existing" });
    try {
      assert.equal(restored.isQueuePaused, true);
      assert.equal(restored.queuedPrompts[0]?.input.text, "review first");
      assert.equal(restored.removeQueued("started"), true);
      assert.equal(restored.clearQueue(), 1);
      assert.deepEqual(store.load("existing").items, []);
    } finally {
      restored.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queued turn is checkpointed inFlight before execution and removed after success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-queue-execute-"));
  const chatId = 2001;
  const sessionId = "session-controlled";
  const store = new DurableQueueStore(dir, chatId);
  let checkpointId: string | undefined;
  const acp = Object.assign(new EventEmitter(), {
    metadataFor: () => undefined,
    prompt: async () => {
      checkpointId = store.load(sessionId).inFlight?.id;
      return { stopReason: "end_turn" };
    },
  }) as unknown as AcpClient;
  const cfg = {
    dataDir: dir, workspace: dir, promptRetryAttempts: 0,
    autoForkOnError: false, resumeOnStreamError: false,
    notifyOtherSessions: false, quietNotifications: false,
  } as AppConfig;
  const settings = { get: () => ({ reasoning: "medium", notifications: DEFAULT_NOTIFICATION_PREFERENCES }) };
  const runtime = new SessionRuntime({} as Api, chatId, acp, cfg, settings as never, { cwd: dir, sessionId });
  try {
    Object.assign(runtime as unknown as Record<string, unknown>, { busy: true, sessionLive: true, rebindPending: false, foreground: false });
    assert.equal(await runtime.submit(textPrompt("queued work")), "queued");
    const id = runtime.queuedPrompts[0]?.id;
    assert(id);
    assert.equal(store.load(sessionId).items[0]?.id, id);
    Object.assign(runtime as unknown as Record<string, unknown>, { busy: false });
    assert.equal(runtime.resumeQueue(), true);
    for (let i = 0; i < 200 && (checkpointId === undefined || runtime.isBusy || store.load(sessionId).inFlight); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(checkpointId, id);
    assert.equal(runtime.queueLength, 0);
    assert.equal(store.load(sessionId).inFlight, undefined);
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Desktop handoff reads a real nested Codex rollout transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-rollout-"));
  const id = "22222222-2222-4222-8222-222222222222";
  try {
    const folder = join(dir, "2026", "10", "08");
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `rollout-2026-10-08T10-00-00-${id}.jsonl`);
    const events = [
      { type: "session_meta", payload: { id, cwd: "C:\\\\work" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Continue this flight project" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will update the tests" }] } },
    ];
    writeFileSync(path, events.map((ev) => JSON.stringify(ev)).join("\n") + "\n");
    const transcript = recentTranscript(dir, id);
    assert(transcript.includes("User: Continue this flight project"));
    assert(transcript.includes("Assistant: I will update the tests"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
