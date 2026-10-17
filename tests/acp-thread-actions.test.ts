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
