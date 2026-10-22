import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";

test("mobile background terminal controls page one thread and stop only an explicitly selected process", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const calls: Array<{ method: string; params: unknown }> = [];
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/backgroundTerminals/list") {
      return params && typeof params === "object" && "cursor" in params
        ? { data: [{ itemId: "item-2", processId: "202" }, { itemId: "item-3", processId: "303" }], nextCursor: null }
        : { data: [{ itemId: "item-1", processId: "101" }], nextCursor: "next-page" };
    }
    if (method === "thread/backgroundTerminals/terminate") {
      const processId = (params as { processId?: string }).processId;
      if (processId === "303") return {};
      return { terminated: processId === "202" };
    }
    throw new Error(`Unexpected ACP method: ${method}`);
  };

  const api = client as unknown as {
    listMobileBackgroundTerminals?: (threadId: string) => Promise<Array<{ itemId: string; processId: string }>>;
    terminateMobileBackgroundTerminal?: (threadId: string, processId: string) => Promise<void>;
  };
  assert.equal(typeof api.listMobileBackgroundTerminals, "function");
  assert.equal(typeof api.terminateMobileBackgroundTerminal, "function");
  assert.deepEqual(await api.listMobileBackgroundTerminals!.call(client, "owned-thread"), [
    { itemId: "item-1", processId: "101" },
    { itemId: "item-2", processId: "202" },
    { itemId: "item-3", processId: "303" },
  ]);
  await api.terminateMobileBackgroundTerminal!.call(client, "owned-thread", "202");
  await assert.rejects(api.terminateMobileBackgroundTerminal!.call(client, "owned-thread", "101"), /остановку/i);
  await assert.rejects(api.terminateMobileBackgroundTerminal!.call(client, "owned-thread", "303"), /остановку/i);
  assert.deepEqual(calls, [
    { method: "thread/backgroundTerminals/list", params: { threadId: "owned-thread", limit: 100 } },
    { method: "thread/backgroundTerminals/list", params: { threadId: "owned-thread", cursor: "next-page", limit: 100 } },
    { method: "thread/backgroundTerminals/list", params: { threadId: "owned-thread", limit: 100 } },
    { method: "thread/backgroundTerminals/list", params: { threadId: "owned-thread", cursor: "next-page", limit: 100 } },
    { method: "thread/backgroundTerminals/terminate", params: { threadId: "owned-thread", processId: "202" } },
    { method: "thread/backgroundTerminals/list", params: { threadId: "owned-thread", limit: 100 } },
    { method: "thread/backgroundTerminals/list", params: { threadId: "owned-thread", cursor: "next-page", limit: 100 } },
    { method: "thread/backgroundTerminals/terminate", params: { threadId: "owned-thread", processId: "101" } },
    { method: "thread/backgroundTerminals/list", params: { threadId: "owned-thread", limit: 100 } },
    { method: "thread/backgroundTerminals/list", params: { threadId: "owned-thread", cursor: "next-page", limit: 100 } },
    { method: "thread/backgroundTerminals/terminate", params: { threadId: "owned-thread", processId: "303" } },
  ]);
  await assert.rejects(api.terminateMobileBackgroundTerminal!.call(client, "owned-thread", ""), /процесс/i);
  client.stop();
});
