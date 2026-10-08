import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import type { AcpClient } from "../src/acp/client.js";
import type { AppConfig } from "../src/config.js";
import { textPrompt } from "../src/app/types.js";
import { DurableQueueStore } from "../src/bot/durable-queue.js";
import { SessionRuntime } from "../src/bot/session-runtime.js";

test("durable queues are per chat/session, survive reload and move across forks", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-queue-"));
  try {
    const a = new DurableQueueStore(dir, 101);
    const b = new DurableQueueStore(dir, 101);
    const other = new DurableQueueStore(dir, 202);
    const item = { id: "one", input: textPrompt("review pending diff") };
    a.save("old", { items: [item], paused: false });
    assert.deepEqual(b.load("old").items, [item]);
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
  const acp = Object.assign(new EventEmitter(), { metadataFor: () => undefined }) as AcpClient;
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
