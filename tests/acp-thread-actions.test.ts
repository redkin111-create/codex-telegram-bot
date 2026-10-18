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

test("archived thread deletion uses Codex app-server and reports its failure", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  const calls: Array<{ method: string; params: unknown }> = [];
  internal.request = async (method, params) => { calls.push({ method, params }); return {}; };
  const api = client as unknown as { deleteThread?: (threadId: string) => Promise<void> };
  assert.equal(typeof api.deleteThread, "function", "AcpClient must expose Codex's native local thread/delete method");
  await api.deleteThread!.call(client, "thread-archived");
  assert.deepEqual(calls, [{ method: "thread/delete", params: { threadId: "thread-archived" } }]);

  internal.request = async () => { throw new Error("Codex refused deletion because a fork still references this thread"); };
  await assert.rejects(api.deleteThread!.call(client, "thread-referenced"), /fork still references/i);
});

test("thread sections use Codex native list, create, update, delete and move requests", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  const calls: Array<{ method: string; params: unknown }> = [];
  internal.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "threadSection/list" && calls.length === 1) return { data: [{ id: "section-1", name: "Inbox" }], nextCursor: "page-2" };
    if (method === "threadSection/list") return { data: [{ id: "section-2", name: "Later" }], nextCursor: null };
    if (method === "threadSection/create") return { section: { id: "section-3", name: "Review" } };
    if (method === "threadSection/update") return { section: { id: "section-3", name: "Ship" } };
    return {};
  };
  const api = client as unknown as {
    listThreadSections?: () => Promise<Array<{ id: string; name: string }>>;
    createThreadSection?: (name: string) => Promise<{ id: string; name: string }>;
    renameThreadSection?: (sectionId: string, name: string) => Promise<{ id: string; name: string }>;
    deleteThreadSection?: (sectionId: string) => Promise<void>;
    moveThreadToSection?: (threadId: string, sectionId: string | null) => Promise<void>;
  };
  assert.equal(typeof api.listThreadSections, "function");
  assert.equal(typeof api.createThreadSection, "function");
  assert.equal(typeof api.renameThreadSection, "function");
  assert.equal(typeof api.deleteThreadSection, "function");
  assert.equal(typeof api.moveThreadToSection, "function");
  assert.deepEqual(await api.listThreadSections!.call(client), [
    { id: "section-1", name: "Inbox" }, { id: "section-2", name: "Later" },
  ]);
  assert.deepEqual(await api.createThreadSection!.call(client, "Review"), { id: "section-3", name: "Review" });
  assert.deepEqual(await api.renameThreadSection!.call(client, "section-3", "Ship"), { id: "section-3", name: "Ship" });
  await api.moveThreadToSection!.call(client, "thread-1", "section-3");
  await api.moveThreadToSection!.call(client, "thread-1", null);
  await api.deleteThreadSection!.call(client, "section-3");
  assert.deepEqual(calls, [
    { method: "threadSection/list", params: { limit: 100 } },
    { method: "threadSection/list", params: { limit: 100, cursor: "page-2" } },
    { method: "threadSection/create", params: { name: "Review" } },
    { method: "threadSection/update", params: { sectionId: "section-3", name: "Ship" } },
    { method: "thread/section/move", params: { threadId: "thread-1", sectionId: "section-3" } },
    { method: "thread/section/move", params: { threadId: "thread-1", sectionId: null } },
    { method: "threadSection/delete", params: { sectionId: "section-3" } },
  ]);
});
