import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";
import { buildContentBlocks, mergeInputs } from "../src/bot/prompt-content.js";

test("selected skill names survive queued prompt merging without storing local paths", () => {
  const merged = mergeInputs([
    { text: "$review Check this file", images: [], skillNames: ["review"] },
    { text: "$review Check the tests", images: [], skillNames: ["review", "test-helper"] },
  ]);
  assert.deepEqual(merged.skillNames, ["review", "test-helper"]);
  assert.deepEqual(buildContentBlocks(merged).slice(-2), [
    { type: "skill", name: "review" },
    { type: "skill", name: "test-helper" },
  ]);
  assert.doesNotMatch(JSON.stringify(merged), /SKILL\.md|C:\\\\private/);
});

test("selected skills are resolved from Codex and sent as explicit app-server input items", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const internal = client as unknown as {
    threadCwd: Map<string, string>;
    request: (method: string, params: unknown) => Promise<unknown>;
    finishTurn: (threadId: string, how: "resolve" | "reject", value: unknown) => void;
  };
  internal.threadCwd.set("thread-1", "C:\\work\\project");
  internal.request = async (method, params) => {
    calls.push({ method, params: params as Record<string, unknown> });
    if (method === "skills/list") return { data: [{ skills: [
      { name: "review", path: "C:\\private\\skills\\review\\SKILL.md", enabled: true, scope: "user" },
    ] }] };
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    throw new Error(`Unexpected Codex method: ${method}`);
  };

  const turn = client.prompt("thread-1", [
    { type: "text", text: "$review Summarize the changes." },
    { type: "skill", name: "review" },
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map((call) => call.method), ["skills/list", "turn/start"]);
  assert.deepEqual((calls[1]!.params.input as unknown[]), [
    { type: "text", text: "$review Summarize the changes." },
    { type: "skill", name: "review", path: "C:\\private\\skills\\review\\SKILL.md" },
  ]);
  internal.finishTurn("thread-1", "resolve", { stopReason: "end_turn" });
  await turn;
});

test("selected disabled or ambiguous skills fail before turn/start", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const methods: string[] = [];
  const internal = client as unknown as {
    threadCwd: Map<string, string>;
    request: (method: string, params: unknown) => Promise<unknown>;
  };
  internal.threadCwd.set("thread-1", "C:\\work\\project");
  internal.request = async (method) => {
    methods.push(method);
    return { data: [{ skills: [
      { name: "disabled", path: "C:\\skills\\disabled\\SKILL.md", enabled: false },
      { name: "duplicate", path: "C:\\skills\\one\\SKILL.md", enabled: true },
      { name: "duplicate", path: "C:\\skills\\two\\SKILL.md", enabled: true },
    ] }] };
  };

  await assert.rejects(client.prompt("thread-1", [
    { type: "text", text: "$disabled Do this" }, { type: "skill", name: "disabled" },
  ]), /отключён|недоступен|неоднозначен/i);
  assert.deepEqual(methods, ["skills/list"]);
});

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

test("steer targets only the confirmed active turn and rejects stale or missing turns", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  let call: { method: string; params: unknown } | undefined;
  const internal = client as unknown as {
    connected: boolean;
    turns: Map<string, { turnId?: string }>;
    request: (method: string, params: unknown) => Promise<unknown>;
  };
  internal.connected = true;
  internal.turns.set("thread-1", { turnId: "turn-current" });
  internal.request = async (method, params) => {
    call = { method, params };
    return { turnId: "turn-current" };
  };

  await client.steer("thread-1", [{ type: "text", text: "Исправь только ошибку из журнала" }]);
  assert.deepEqual(call, {
    method: "turn/steer",
    params: {
      threadId: "thread-1",
      expectedTurnId: "turn-current",
      input: [{ type: "text", text: "Исправь только ошибку из журнала" }],
    },
  });
  internal.request = async () => ({ turnId: "a-different-turn" });
  await assert.rejects(client.steer("thread-1", [{ type: "text", text: "Не менять файлы" }]), /не подтвердил/i);
  internal.turns.delete("thread-1");
  await assert.rejects(client.steer("thread-1", [{ type: "text", text: "Уже не активно" }]), /Нет активной задачи/i);
});

test("fork requests Codex to copy only the selected source thread", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  let call: { method: string; params: unknown } | undefined;
  const internal = client as unknown as {
    request: (method: string, params: unknown) => Promise<unknown>;
    threadCwd: Map<string, string>;
  };
  internal.threadCwd.set("thread-source", "C:\\work\\project");
  internal.request = async (method, params) => {
    call = { method, params };
    return { thread: { id: "thread-fork" }, cwd: "C:\\work\\project", model: "fixture-model" };
  };

  const forkThread = (client as unknown as { forkThread?: (id: string) => Promise<unknown> }).forkThread;
  assert.equal(typeof forkThread, "function", "AcpClient must expose Codex's native thread/fork operation");
  const result = await forkThread!.call(client, "thread-source");
  assert.deepEqual(call, { method: "thread/fork", params: { threadId: "thread-source" } });
  assert.deepEqual(result, { thread: { id: "thread-fork" }, cwd: "C:\\work\\project", model: "fixture-model" });
});

test("side chat requests an ephemeral fork that excludes the current parent turn", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  let call: { method: string; params: unknown } | undefined;
  const internal = client as unknown as {
    request: (method: string, params: unknown) => Promise<unknown>;
    threadCwd: Map<string, string>;
  };
  internal.threadCwd.set("thread-source", "C:\\work\\project");
  internal.request = async (method, params) => {
    call = { method, params };
    return { thread: { id: "thread-side-chat", ephemeral: true }, cwd: "C:\\work\\project" };
  };

  const forkThread = (client as unknown as { forkThread?: (id: string, options: { ephemeral: boolean; excludeTurns: boolean }) => Promise<unknown> }).forkThread;
  assert.equal(typeof forkThread, "function");
  await forkThread!.call(client, "thread-source", { ephemeral: true, excludeTurns: true });
  assert.deepEqual(call, {
    method: "thread/fork",
    params: { threadId: "thread-source", ephemeral: true, excludeTurns: true },
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
