import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";

test("AcpClient routes MCP elicitation and fails closed when no phone can answer", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const sent: unknown[] = [];
  let received: Record<string, unknown> | undefined;
  const internal = client as unknown as {
    send(message: unknown): void;
    respondToServerRequest(id: number, method: string, params: Record<string, unknown>): Promise<void>;
    elicitationHandler?: (params: Record<string, unknown>) => Promise<{ action: string; content: Record<string, unknown> | null }>;
  };
  internal.send = (message) => { sent.push(message); };
  internal.elicitationHandler = async (params) => {
    received = params;
    return { action: "accept", content: { account_id: "customer-7" } };
  };

  await internal.respondToServerRequest(73, "mcpServer/elicitation/request", {
    threadId: "thread-1", serverName: "fixture-account", mode: "form", message: "Enter account id",
  });

  assert.equal(received?.serverName, "fixture-account");
  assert.deepEqual(sent, [{ id: 73, result: { action: "accept", content: { account_id: "customer-7" } } }]);

  sent.length = 0;
  internal.elicitationHandler = undefined;
  await internal.respondToServerRequest(74, "mcpServer/elicitation/request", {});
  assert.deepEqual(sent, [{ id: 74, result: { action: "decline", content: null } }]);

  sent.length = 0;
  internal.elicitationHandler = async () => { throw new Error("fixture failure"); };
  await internal.respondToServerRequest(75, "mcpServer/elicitation/request", {});
  assert.deepEqual(sent, [{ id: 75, result: { action: "cancel", content: null } }]);
  client.stop();
});
