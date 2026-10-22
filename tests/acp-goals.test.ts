import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";

test("thread goal actions use Codex's owner-authorized app-server methods", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const goal = {
    threadId: "thread-1", objective: "Repair the mobile client", status: "active",
    tokenBudget: 12000, tokensUsed: 310, timeUsedSeconds: 20, createdAt: 1, updatedAt: 2,
  };
  const calls: Array<{ method: string; params: unknown }> = [];
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/goal/get") return { goal };
    if (method === "thread/goal/set") return { goal };
    if (method === "thread/goal/clear") return { cleared: true };
    throw new Error("Unexpected Codex method");
  };

  const api = client as unknown as {
    getThreadGoal?: (threadId: string) => Promise<unknown>;
    setThreadGoal?: (threadId: string, input: { objective?: string; status?: string; tokenBudget?: number | null }) => Promise<unknown>;
    clearThreadGoal?: (threadId: string) => Promise<unknown>;
  };
  assert.equal(typeof api.getThreadGoal, "function", "AcpClient must read the Codex goal for one thread");
  assert.equal(typeof api.setThreadGoal, "function", "AcpClient must update the Codex goal through app-server");
  assert.equal(typeof api.clearThreadGoal, "function", "AcpClient must clear the Codex goal through app-server");
  assert.deepEqual(await api.getThreadGoal!.call(client, "thread-1"), goal);
  assert.deepEqual(await api.setThreadGoal!.call(client, "thread-1", { objective: goal.objective, tokenBudget: 12000 }), goal);
  assert.deepEqual(await api.clearThreadGoal!.call(client, "thread-1"), { cleared: true });
  assert.deepEqual(calls, [
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
    { method: "thread/goal/set", params: { threadId: "thread-1", origin: "user", objective: goal.objective, tokenBudget: 12000 } },
    { method: "thread/goal/clear", params: { threadId: "thread-1", origin: "user" } },
  ]);
});
