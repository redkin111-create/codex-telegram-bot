import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";

test("manual compaction uses Codex app-server and refuses an active turn", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const internal = client as unknown as {
    request: (method: string, params: unknown) => Promise<unknown>;
    turns: Map<string, unknown>;
  };
  const calls: Array<{ method: string; params: unknown }> = [];
  internal.request = async (method, params) => { calls.push({ method, params }); return {}; };

  const api = client as unknown as { compactThread?: (threadId: string) => Promise<void> };
  assert.equal(typeof api.compactThread, "function", "AcpClient must expose Codex's manual compaction method");
  await api.compactThread!.call(client, "thread-idle");
  assert.deepEqual(calls, [{ method: "thread/compact/start", params: { threadId: "thread-idle" } }]);
  internal.turns.set("thread-busy", {});
  await assert.rejects(api.compactThread!.call(client, "thread-busy"), /активн|выполня/i);
  assert.equal(calls.length, 1, "Codex must not receive a compaction request during an active turn");
});

test("native review starts on the selected Codex thread with a semantic target", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  const calls: Array<{ method: string; params: unknown }> = [];
  internal.request = async (method, params) => {
    calls.push({ method, params });
    return { reviewThreadId: "thread-review", turn: { id: "turn-review", status: "inProgress" } };
  };
  const api = client as unknown as {
    reviewThread?: (threadId: string, target: { type: "baseBranch"; branch: string }, delivery?: "inline" | "detached") => Promise<unknown>;
  };
  assert.equal(typeof api.reviewThread, "function", "AcpClient must use Codex's native review/start request");
  const response = await api.reviewThread!.call(client, "thread-source", { type: "baseBranch", branch: "main" }, "inline");
  assert.deepEqual(calls, [{
    method: "review/start",
    params: { threadId: "thread-source", target: { type: "baseBranch", branch: "main" }, delivery: "inline" },
  }]);
  assert.deepEqual(response, { reviewThreadId: "thread-review", turn: { id: "turn-review", status: "inProgress" } });
});
