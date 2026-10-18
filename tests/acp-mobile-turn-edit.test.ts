import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";

test("mobile edit reads the latest text-only user turn without exposing skill paths and uses thread/revert", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const calls: Array<{ method: string; params: unknown }> = [];
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/turns/list") return {
      data: [{
        id: "turn-uuid-1", status: "completed", itemsView: "full",
        items: [{ type: "userMessage", id: "message-1", content: [
          { type: "text", text: "original prompt" },
          { type: "skill", name: "fixture-review", path: "C:\\private\\SKILL.md" },
        ] }],
      }],
      nextCursor: null,
      backwardsCursor: "turn-cursor",
    };
    if (method === "thread/revert") return {
      thread: { id: "owned-thread", turns: [] },
      turnsBackwardsCursor: "turn-cursor",
      itemsBackwardsCursor: "item-cursor",
    };
    throw new Error(`Unexpected ACP method: ${method}`);
  };

  const api = client as unknown as {
    readMobileLatestEditableTurn?: (threadId: string) => Promise<{
      turnId: string; text: string; skillNames: string[]; attachmentCount: number; editable: boolean;
    } | undefined>;
    revertMobileThread?: (threadId: string, beforeTurnId: string) => Promise<void>;
  };
  assert.equal(typeof api.readMobileLatestEditableTurn, "function");
  assert.equal(typeof api.revertMobileThread, "function");
  const turn = await api.readMobileLatestEditableTurn!.call(client, "owned-thread");
  assert.deepEqual(turn, {
    turnId: "turn-uuid-1", text: "original prompt", skillNames: ["fixture-review"], attachmentCount: 0, editable: true,
  });
  await api.revertMobileThread!.call(client, "owned-thread", "turn-uuid-1");
  assert.deepEqual(calls, [
    { method: "thread/turns/list", params: { threadId: "owned-thread", limit: 1, sortDirection: "desc", itemsView: "full" } },
    { method: "thread/turns/list", params: { threadId: "owned-thread", limit: 1, sortDirection: "desc", itemsView: "full" } },
    { method: "thread/revert", params: { threadId: "owned-thread", beforeTurnId: "turn-uuid-1" } },
  ]);
});

test("mobile edit refuses a changed turn and unsupported attachments before reverting", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const methods: string[] = [];
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method) => {
    methods.push(method);
    if (method === "thread/turns/list") return {
      data: [{ id: "turn-newer", status: "completed", items: [{ type: "userMessage", content: [
        { type: "text", text: "attached prompt" }, { type: "localImage", path: "C:\\private\\photo.png" },
      ] }] }],
    };
    return { thread: { id: "owned-thread" } };
  };
  const api = client as unknown as {
    readMobileLatestEditableTurn: (threadId: string) => Promise<{ editable: boolean; attachmentCount: number } | undefined>;
    revertMobileThread: (threadId: string, beforeTurnId: string) => Promise<void>;
  };
  const turn = await api.readMobileLatestEditableTurn("owned-thread");
  assert.equal(turn?.editable, false);
  assert.equal(turn?.attachmentCount, 1);
  await assert.rejects(api.revertMobileThread("owned-thread", "turn-old"), /изменилась/i);
  assert.deepEqual(methods, ["thread/turns/list", "thread/turns/list"]);
  client.stop();
});

test("mobile edit fails closed when Codex does not confirm a terminal turn status", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  let status: string | undefined;
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async () => ({ data: [{ id: "turn-status-1", status, items: [{ type: "userMessage", content: [{ type: "text", text: "safe prompt" }] }] }] });
  const api = client as unknown as {
    readMobileLatestEditableTurn: (threadId: string) => Promise<{ editable: boolean } | undefined>;
  };
  assert.equal((await api.readMobileLatestEditableTurn("owned-thread"))?.editable, false);
  status = "inProgress";
  assert.equal((await api.readMobileLatestEditableTurn("owned-thread"))?.editable, false);
  status = "completed";
  assert.equal((await api.readMobileLatestEditableTurn("owned-thread"))?.editable, true);
  client.stop();
});
