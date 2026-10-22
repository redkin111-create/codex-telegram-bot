import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";

test("mobile edit reads the latest text-only user turn without exposing skill paths and uses thread/revert", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const calls: Array<{ method: string; params: unknown }> = [];
  let dispatchNotified = false;
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method, params) => {
    if (method === "thread/revert") assert.equal(dispatchNotified, true, "the dispatch marker must be set immediately before the history mutation");
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
    revertMobileThread?: (threadId: string, beforeTurnId: string, expectedLatestTurnId?: string, appIds?: string[], onBeforeRevert?: () => void) => Promise<void>;
  };
  assert.equal(typeof api.readMobileLatestEditableTurn, "function");
  assert.equal(typeof api.revertMobileThread, "function");
  const turn = await api.readMobileLatestEditableTurn!.call(client, "owned-thread");
  assert.deepEqual(turn, {
    turnId: "turn-uuid-1", text: "original prompt", skillNames: ["fixture-review"], attachmentCount: 0, editable: true,
  });
  await api.revertMobileThread!.call(client, "owned-thread", "turn-uuid-1", undefined, undefined, () => { dispatchNotified = true; });
  assert.deepEqual(calls, [
    { method: "thread/turns/list", params: { threadId: "owned-thread", limit: 1, sortDirection: "desc", itemsView: "full" } },
    { method: "thread/turns/list", params: { threadId: "owned-thread", limit: 20, sortDirection: "desc", itemsView: "full" } },
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
        { type: "text", text: "attached prompt" }, { type: "image", url: "https://example.test/photo.png" },
      ] }] }],
    };
    return { thread: { id: "owned-thread" } };
  };
  const api = client as unknown as {
    readMobileLatestEditableTurn: (threadId: string) => Promise<{ editable: boolean; attachmentCount: number } | undefined>;
    revertMobileThread: (threadId: string, beforeTurnId: string, expectedLatestTurnId?: string, appIds?: string[], onBeforeRevert?: () => void) => Promise<void>;
  };
  const turn = await api.readMobileLatestEditableTurn("owned-thread");
  assert.equal(turn?.editable, false);
  assert.equal(turn?.attachmentCount, 1);
  let dispatchNotified = false;
  await assert.rejects(api.revertMobileThread("owned-thread", "turn-old", undefined, undefined, () => { dispatchNotified = true; }), /изменил|не найден/i);
  assert.equal(dispatchNotified, false, "rejected validation must remain safe to retry");
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

test("mobile edit lists recent user turns and revalidates an earlier text-only turn before revert", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const calls: Array<{ method: string; params: unknown }> = [];
  const turns = [
    { id: "turn-current", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: "newest request" }] }] },
    { id: "turn-older", status: "completed", items: [{ type: "userMessage", content: [
      { type: "text", text: "request to revise" }, { type: "skill", name: "fixture-review", path: "C:\\private\\SKILL.md" },
    ] }] },
    { id: "turn-with-image", status: "completed", items: [{ type: "userMessage", content: [
      { type: "text", text: "image request" }, { type: "image", url: "https://example.test/photo.png" },
    ] }] },
  ];
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/turns/list") return { data: turns };
    if (method === "thread/revert") return { thread: { id: "owned-thread" } };
    throw new Error(`Unexpected ACP method: ${method}`);
  };
  const api = client as unknown as {
    readMobileEditableTurns?: (threadId: string) => Promise<Array<{
      turnId: string; text: string; skillNames: string[]; attachmentCount: number; editable: boolean;
    }>>;
    revertMobileThread?: (threadId: string, beforeTurnId: string, expectedLatestTurnId?: string) => Promise<void>;
  };
  assert.equal(typeof api.readMobileEditableTurns, "function");
  const recent = await api.readMobileEditableTurns!.call(client, "owned-thread");
  assert.deepEqual(recent.map(({ turnId, editable, attachmentCount }) => ({ turnId, editable, attachmentCount })), [
    { turnId: "turn-current", editable: true, attachmentCount: 0 },
    { turnId: "turn-older", editable: true, attachmentCount: 0 },
    { turnId: "turn-with-image", editable: false, attachmentCount: 1 },
  ]);
  assert.equal(recent[1]?.text, "request to revise");
  assert.deepEqual(recent[1]?.skillNames, ["fixture-review"]);
  await api.revertMobileThread!.call(client, "owned-thread", "turn-older", "turn-current");
  await assert.rejects(api.revertMobileThread!.call(client, "owned-thread", "turn-older", "turn-advanced"), /История Codex изменилась/i);
  assert.deepEqual(calls.map(({ method }) => method), ["thread/turns/list", "thread/turns/list", "thread/revert", "thread/turns/list"]);
  assert.deepEqual(calls[2], {
    method: "thread/revert", params: { threadId: "owned-thread", beforeTurnId: "turn-older" },
  });
  client.stop();
});

test("mobile edit pages older user turns and revalidates one beyond the first page", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const firstPage = Array.from({ length: 20 }, (_, index) => ({
    id: index === 0 ? "turn-current" : `turn-recent-${index}`,
    status: "completed",
    items: [{ type: "userMessage", content: [{ type: "text", text: `request ${index}` }] }],
  }));
  const internal = client as unknown as { request: (method: string, params: Record<string, unknown>) => Promise<unknown> };
  internal.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/turns/list" && params.cursor === undefined) {
      return { data: firstPage, nextCursor: "native-older-cursor", backwardsCursor: "newer-cursor" };
    }
    if (method === "thread/turns/list" && params.cursor === "native-older-cursor") {
      return { data: [{
        id: "turn-original", status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: "old request to revise" }] }],
      }], nextCursor: null, backwardsCursor: "native-older-cursor" };
    }
    if (method === "thread/revert") return { thread: { id: "owned-thread" } };
    throw new Error(`Unexpected ACP method: ${method}`);
  };
  const api = client as unknown as {
    readMobileEditableTurnsPage?: (threadId: string, cursor?: string) => Promise<{
      latestTurnId?: string; turns: Array<{ turnId: string; text: string }>; nextCursor?: string;
    }>;
    revertMobileThread?: (threadId: string, beforeTurnId: string, expectedLatestTurnId?: string) => Promise<{ turnId: string; text: string }>;
  };
  assert.equal(typeof api.readMobileEditableTurnsPage, "function");
  const page = await api.readMobileEditableTurnsPage!.call(client, "owned-thread");
  assert.equal(page.latestTurnId, "turn-current");
  assert.equal(page.turns.length, 20);
  assert.equal(page.nextCursor, "native-older-cursor");
  assert.equal("backwardsCursor" in page, false);

  const reverted = await api.revertMobileThread!.call(client, "owned-thread", "turn-original", "turn-current");
  assert.deepEqual(reverted, { turnId: "turn-original", text: "old request to revise", skillNames: [], attachmentCount: 0, editable: true });
  assert.deepEqual(calls.filter((call) => call.method === "thread/turns/list").map((call) => call.params), [
    { threadId: "owned-thread", limit: 20, sortDirection: "desc", itemsView: "full" },
    { threadId: "owned-thread", limit: 20, sortDirection: "desc", itemsView: "full" },
    { threadId: "owned-thread", limit: 20, cursor: "native-older-cursor", sortDirection: "desc", itemsView: "full" },
  ]);
  assert.deepEqual(calls.at(-1), {
    method: "thread/revert", params: { threadId: "owned-thread", beforeTurnId: "turn-original" },
  });
  client.stop();
});

test("mobile edit keeps validated inline and local images inside the server and returns them after a confirmed revert", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-mobile-edit-image-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=", "base64");
  const imageUrl = `data:image/png;base64,${png.toString("base64")}`;
  const localImage = join(dir, "photo.png");
  writeFileSync(localImage, png);
  const client = new AcpClient({ codexCliPath: "codex", workspace: dir, trustAllTools: false });
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method) => {
    if (method === "thread/turns/list") return { data: [{
      id: "turn-image-1", status: "completed", items: [{ type: "userMessage", content: [
        { type: "text", text: "Check this screenshot" }, { type: "image", url: imageUrl },
        { type: "localImage", path: localImage },
      ] }],
    }] };
    if (method === "thread/revert") return { thread: { id: "owned-thread" } };
    throw new Error(`Unexpected ACP method: ${method}`);
  };
  const api = client as unknown as {
    readMobileEditableTurns: (threadId: string) => Promise<Array<{
      turnId: string; text: string; attachmentCount: number; editable: boolean;
      resendImages?: Array<{ mimeType: string; data: string }>;
      resendLocalImages?: string[];
    }>>;
    revertMobileThread: (threadId: string, beforeTurnId: string, expectedLatestTurnId?: string) => Promise<{
      resendImages?: Array<{ mimeType: string; data: string }>;
      resendLocalImages?: string[];
    }>;
  };
  const [turn] = await api.readMobileEditableTurns("owned-thread");
  assert.equal(turn?.editable, true);
  assert.equal(turn?.attachmentCount, 2);
  assert.equal(turn?.resendImages, undefined);
  assert.equal(turn?.resendLocalImages, undefined);
  const restored = await api.revertMobileThread("owned-thread", "turn-image-1", "turn-image-1");
  assert.deepEqual(restored.resendImages, [{ mimeType: "image/png", data: png.toString("base64") }]);
  assert.deepEqual(restored.resendLocalImages, [localImage]);
  client.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("mobile edit checks local image availability before truncating history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-mobile-edit-missing-image-"));
  const missingImage = join(dir, "missing.png");
  const client = new AcpClient({ codexCliPath: "codex", workspace: dir, trustAllTools: false });
  const calls: string[] = [];
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method) => {
    calls.push(method);
    if (method === "thread/turns/list") return { data: [{
      id: "turn-stale-image", status: "completed", items: [{ type: "userMessage", content: [
        { type: "text", text: "Review this image" }, { type: "localImage", path: missingImage },
      ] }],
    }] };
    return { thread: { id: "owned-thread" } };
  };
  try {
    await assert.rejects(client.revertMobileThread("owned-thread", "turn-stale-image", "turn-stale-image"), /изображение недоступно/i);
    assert.deepEqual(calls, ["thread/turns/list"]);
  } finally {
    client.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
