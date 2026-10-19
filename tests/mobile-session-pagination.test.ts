import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.js";
import type { AcpClient } from "../src/acp/client.js";
import type { RuntimeRegistry } from "../src/bot/registry.js";
import { MiniAppAgent } from "../src/tma/agent.js";
import { TelegramSessionRegistry } from "../src/sessions/telegram-registry.js";

function makeThread(id: string, name: string, cwd: string) {
  return { id, name, cwd, source: "appServer", createdAt: 1, updatedAt: 2, recencyAt: 2 };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "codex-mobile-session-pages-"));
  const owned = makeThread("11111111-1111-4111-8111-111111111111", "Owned first page", dir);
  const nextOwned = makeThread("22222222-2222-4222-8222-222222222222", "Owned next page", dir);
  const foreign = makeThread("33333333-3333-4333-8333-333333333333", "Foreign thread", dir);
  const ephemeral = { ...makeThread("44444444-4444-4444-8444-444444444444", "Ephemeral", dir), ephemeral: true };
  const pages: Array<Record<string, unknown>> = [];
  const fullCatalogueCalls: Array<Record<string, unknown>> = [];
  const acp = Object.assign(new EventEmitter(), {
    isConnected: true,
    listProjects: async () => [{ id: "fixture-project", name: "Fixture", roots: [dir] }],
    listThreadsPage: async (params: Record<string, unknown>) => {
      pages.push(params);
      if (params.cursor === "active-page-2") return { threads: [nextOwned, foreign], nextCursor: "active-page-3" };
      return { threads: [owned, foreign, ephemeral], nextCursor: "active-page-2" };
    },
    listThreads: async () => [],
    listAllThreads: async (params: Record<string, unknown> = {}) => {
      fullCatalogueCalls.push(params);
      return params.archived === true ? [] : [owned, foreign, ephemeral];
    },
    listThreadSections: async () => [],
    availableModels: [], availableModes: [], availableSkills: [], availableMcpServers: [],
    currentModelId: "default", currentModeId: "code", accountState: async () => ({}),
  }) as unknown as AcpClient;
  const registry = {
    controller: () => ({ list: () => [] }),
    get: () => ({ sessionId: "" }),
    runtimeForSession: () => undefined,
  } as unknown as RuntimeRegistry;
  const cfg = { sessionsDir: dir, dataDir: dir, workspace: dir, projectRoots: [dir], allowedUsers: new Set(["101", "202"]) } as AppConfig;
  const owners = new TelegramSessionRegistry(dir);
  owners.recordMobile(foreign.id, 202, dir, "Foreign");
  const agent = new MiniAppAgent({ cfg, acp, registry });
  return { dir, agent, pages, fullCatalogueCalls, owned, nextOwned, foreign };
}

test("mobile snapshot returns a bounded active page without enumerating every session", async () => {
  const f = fixture();
  try {
    const snapshot = await f.agent.execute({ id: "abcdef0123456789abcdef01", op: "snapshot", userId: 101, args: {} }) as {
      sessions: Array<{ id: string }>;
      sessionsNextCursor?: string;
      archivedSessions?: Array<{ id: string }>;
      archiveAvailable?: boolean;
    };

    assert.deepEqual(snapshot.sessions.map((session) => session.id), [f.owned.id]);
    assert.equal(snapshot.sessionsNextCursor, "active-page-2");
    assert.deepEqual(snapshot.archivedSessions, []);
    assert.equal(snapshot.archiveAvailable, true);
    assert.equal(f.pages.length, 1);
    assert.equal(f.fullCatalogueCalls.length, 0);
  } finally {
    f.agent.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("mobile session paging uses Codex cursors and grants access only to returned owner sessions", async () => {
  const f = fixture();
  try {
    await f.agent.execute({ id: "abcdef0123456789abcdef01", op: "snapshot", userId: 101, args: {} });
    const page = await f.agent.executeMobile({ op: "listMoreThreads", userId: 101, args: { cursor: "active-page-2", cwd: f.dir } }) as {
      sessions: Array<{ id: string }>;
      nextCursor?: string;
    };

    assert.deepEqual(page.sessions.map((session) => session.id), [f.nextOwned.id]);
    assert.equal(page.nextCursor, "active-page-3");
    assert.deepEqual(f.pages.map((params) => params.cursor), [undefined, "active-page-2"]);
    assert.equal(f.pages[1]?.cwd, f.dir);
    assert.equal(await f.agent.canReadSession(f.nextOwned.id, 101), true);
    assert.equal(await f.agent.canReadSession(f.foreign.id, 101), false);
    assert.equal(f.fullCatalogueCalls.length, 0);
  } finally {
    f.agent.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
