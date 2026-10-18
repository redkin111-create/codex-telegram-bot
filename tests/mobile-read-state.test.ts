import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpClient } from "../src/acp/client.js";
import type { AppConfig } from "../src/config.js";
import { MiniAppAgent } from "../src/tma/agent.js";
import type { RuntimeRegistry } from "../src/bot/registry.js";

const ownerId = 101;
const allowedSession = "11111111-1111-4111-8111-111111111111";
const foreignSession = "22222222-2222-4222-8222-222222222222";
type FixtureReadState = { firstUnread: null | { type: "turn"; turnId: string }; revision: string };

test("mobile read-state inventory excludes unknown sessions and updates only the displayed revision", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-mobile-read-state-"));
  const calls: Array<{ threadId: string; expectedRevision: string; operation: "read" | "unread" }> = [];
  let state: FixtureReadState = { firstUnread: { type: "turn", turnId: "turn-1" }, revision: "rev-1" };
  const thread = {
    id: allowedSession, name: "Authorized", cwd: dataDir, createdAt: 1, updatedAt: 1, recencyAt: 1,
    source: "cli", readStateMetadataAvailable: true, readStateEligible: true,
  };
  const acp = {
    isConnected: true,
    async listProjects() { return []; },
    async listAllThreads() { return [{ ...thread, readState: state }]; },
    async updateThreadReadState(threadId: string, expectedRevision: string, operation: "read" | "unread") {
      calls.push({ threadId, expectedRevision, operation });
      if (expectedRevision !== state.revision) throw new Error("revision conflict");
      state = { firstUnread: null, revision: "rev-3" };
      return state;
    },
  } as unknown as AcpClient;
  const registry = { runtimeForSession: () => undefined } as unknown as RuntimeRegistry;
  const cfg = {
    allowedUsers: new Set([String(ownerId)]), sessionsDir: dataDir, dataDir, workspace: dataDir, projectRoots: [dataDir],
  } as unknown as AppConfig;
  const agent = new MiniAppAgent({ cfg, acp, registry });
  try {
    const inventory = await agent.executeMobile({
      op: "listThreadReadStates", userId: ownerId, args: { sessionIds: [allowedSession, foreignSession] },
    }) as { states: Record<string, unknown> };
    assert.deepEqual(Object.keys(inventory.states), [allowedSession], "an unlisted session must not be exposed");

    state = { firstUnread: null, revision: "rev-2" }; // Simulate Codex Desktop changing the receipt after the list was read.
    await assert.rejects(agent.executeMobile({
      op: "updateThreadReadState", userId: ownerId,
      args: { sessionId: allowedSession, expectedRevision: "rev-1", operation: "read" },
    }), /revision conflict/i);
    assert.deepEqual(calls, [{ threadId: allowedSession, expectedRevision: "rev-1", operation: "read" }]);

    const refreshed = await agent.executeMobile({
      op: "listThreadReadStates", userId: ownerId, args: { sessionIds: [allowedSession] },
    }) as { states: Record<string, { revision: string }> };
    assert.equal(refreshed.states[allowedSession]?.revision, "rev-2", "a Codex conflict must invalidate the stale session cache");
    const updated = await agent.executeMobile({
      op: "updateThreadReadState", userId: ownerId,
      args: { sessionId: allowedSession, expectedRevision: "rev-2", operation: "read" },
    }) as { readState: { revision: string } };
    assert.equal(updated.readState.revision, "rev-3");

    await assert.rejects(agent.executeMobile({
      op: "updateThreadReadState", userId: ownerId,
      args: { sessionId: allowedSession, expectedRevision: "rev-2", operation: "unread" },
    }), /status|статус|revision/i);
    assert.equal(calls.length, 2, "a stale mobile receipt must not be retried against Codex");
  } finally {
    agent.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
