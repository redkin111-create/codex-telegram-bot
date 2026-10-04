import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";

test("workspace mode runs in-project actions without per-action approval and keeps its sandbox", async () => {
  const client = new AcpClient({
    codexCliPath: "codex",
    workspace: "C:\\work\\default",
    trustAllTools: false,
  });
  let turnStart: Record<string, unknown> | undefined;
  const internal = client as unknown as {
    threadCwd: Map<string, string>;
    request: (method: string, params: unknown) => Promise<unknown>;
    finishTurn: (threadId: string, how: "resolve" | "reject", value: unknown) => void;
  };
  internal.threadCwd.set("thread-1", "C:\\work\\selected-project");
  internal.request = async (method, params) => {
    if (method === "turn/start") {
      turnStart = params as Record<string, unknown>;
      return { turn: { id: "turn-1" } };
    }
    return {};
  };

  const turn = client.prompt("thread-1", [{ type: "text", text: "Сделай задачу в проекте" }]);
  await Promise.resolve();
  internal.finishTurn("thread-1", "resolve", { stopReason: "end_turn" });
  await turn;

  assert.equal(turnStart?.approvalPolicy, "never");
  assert.deepEqual(turnStart?.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: ["C:\\work\\selected-project"],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
});

test("full conversation catalogue follows every thread/list cursor page", async () => {
  const client = new AcpClient({
    codexCliPath: "codex",
    workspace: "C:\\work",
    trustAllTools: false,
  });
  const cursors: Array<unknown> = [];
  const internal = client as unknown as {
    request: (method: string, params: unknown) => Promise<unknown>;
  };
  internal.request = async (method, params) => {
    assert.equal(method, "thread/list");
    const cursor = (params as { cursor?: string }).cursor;
    cursors.push(cursor);
    if (!cursor) return {
      threads: [{ id: "one" }, { id: "duplicate", name: "old" }],
      nextCursor: "next-page",
    };
    return { threads: [{ id: "two" }, { id: "duplicate", name: "new" }] };
  };

  const threads = await client.listAllThreads({ limit: 2 });
  assert.deepEqual(cursors, [undefined, "next-page"]);
  assert.deepEqual(threads.map((thread) => thread.id), ["one", "duplicate", "two"]);
  assert.equal(threads.find((thread) => thread.id === "duplicate")?.name, "new");
});

test("Codex project/list follows its native data and nextCursor fields", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const cursors: Array<string | undefined> = [];
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method, params) => {
    assert.equal(method, "project/list");
    const cursor = (params as { cursor?: string }).cursor;
    cursors.push(cursor);
    return cursor
      ? { data: [{ id: "project-2" }], nextCursor: null }
      : { data: [{ id: "project-1" }], nextCursor: "page-2" };
  };
  const projects = await client.listProjects();
  assert.deepEqual(cursors, [undefined, "page-2"]);
  assert.deepEqual(projects.map((project) => project.id), ["project-1", "project-2"]);
});
