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

const ownedSession = "11111111-1111-4111-8111-111111111111";
const foreignSession = "22222222-2222-4222-8222-222222222222";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "codex-mobile-capability-sections-"));
  const threads = [
    { id: ownedSession, name: "Owned", cwd: dir, source: "appServer", createdAt: 1, updatedAt: 2, recencyAt: 2 },
    { id: foreignSession, name: "Foreign", cwd: dir, source: "appServer", createdAt: 1, updatedAt: 1, recencyAt: 1 },
  ];
  const calls = { refresh: 0, skills: 0, integrations: 0, plugins: 0, mcp: 0, settings: 0, goal: 0, account: 0 };
  const acp = Object.assign(new EventEmitter(), {
    isConnected: true,
    availableModels: [{ modelId: "model", name: "Model" }],
    availableModes: [{ id: "code", name: "Code" }],
    availableSkills: [],
    availableMcpServers: [],
    currentModelId: "model",
    currentModeId: "code",
    async listProjects() { return [{ id: "project", name: "Fixture", roots: [dir] }]; },
    async listAllThreads() { return threads; },
    async refreshInventories() { calls.refresh += 1; },
    async listMobileSkills(cwd: string) {
      calls.skills += 1;
      assert.equal(cwd, dir);
      return [{ name: "browser-skill", description: "Browser checks", scope: "user", enabled: true }];
    },
    async mobileIntegrationInventory(cwd: string, threadId: string) {
      calls.integrations += 1;
      assert.equal(cwd, dir);
      assert.equal(threadId, ownedSession);
      return {
        pluginCatalog: { marketplaces: [] }, installedPlugins: { marketplaces: [] },
        apps: { data: [{ id: "calendar", name: "Calendar", isEnabled: true, isAccessible: true }] },
        installedApps: { apps: [{ id: "calendar", enabled: true, callable: true }] },
      };
    },
    async mobilePluginInventory(cwd: string) {
      calls.plugins += 1;
      assert.equal(cwd, dir);
      return { pluginCatalog: { marketplaces: [] }, installedPlugins: { marketplaces: [] } };
    },
    async listMobileMcpServers() { calls.mcp += 1; return []; },
    async readMobileThreadSettings() { calls.settings += 1; return { model: "model", effort: "medium" }; },
    async getThreadGoal() { calls.goal += 1; return undefined; },
    async accountState() { calls.account += 1; return {}; },
    currentSubagents() { return []; },
  }) as unknown as AcpClient;
  const registry = { runtimeForSession: () => undefined } as unknown as RuntimeRegistry;
  const cfg = { sessionsDir: dir, dataDir: dir, workspace: dir, projectRoots: [dir], allowedUsers: new Set(["101", "202"]) } as AppConfig;
  const owners = new TelegramSessionRegistry(dir);
  owners.recordMobile(ownedSession, 101, dir, "Owned");
  owners.recordMobile(foreignSession, 202, dir, "Foreign");
  const agent = new MiniAppAgent({ cfg, acp, registry });
  return { dir, agent, calls, acp };
}

test("the skill picker reads only the authorized project's skill inventory", async () => {
  const f = fixture();
  try {
    const result = await f.agent.executeMobile({ op: "capabilities", userId: 101, args: { sessionId: ownedSession, section: "skills" } }) as Record<string, unknown>;
    assert.equal(result.capabilitySection, "skills");
    assert.deepEqual(Object.keys(result), ["capabilitySection", "skills"]);
    assert.deepEqual(result.skills, [{ name: "browser-skill", description: "Browser checks", enabled: true, scope: "user", canToggle: true, invokable: true }]);
    assert.deepEqual(f.calls, { refresh: 0, skills: 1, integrations: 0, plugins: 0, mcp: 0, settings: 0, goal: 0, account: 0 });
  } finally {
    f.agent.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the app picker reads only the authorized thread's Codex App inventory", async () => {
  const f = fixture();
  try {
    const result = await f.agent.executeMobile({ op: "capabilities", userId: 101, args: { sessionId: ownedSession, section: "apps" } }) as Record<string, unknown>;
    assert.equal(result.capabilitySection, "apps");
    assert.deepEqual(Object.keys(result).sort(), ["apps", "appsAvailable", "capabilitySection"].sort());
    assert.deepEqual(result.apps, [{ id: "calendar", name: "Calendar", description: undefined, enabled: true, accessible: true, callable: true, installUrl: undefined }]);
    assert.equal(result.appsAvailable, true);
    assert.deepEqual(f.calls, { refresh: 0, skills: 0, integrations: 1, plugins: 0, mcp: 0, settings: 0, goal: 0, account: 0 });
  } finally {
    f.agent.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the settings core returns without discovering MCP or plugin inventories", async () => {
  const f = fixture();
  try {
    const result = await f.agent.executeMobile({ op: "capabilities", userId: 101, args: { sessionId: ownedSession, section: "core" } }) as Record<string, unknown>;
    assert.equal(result.online, true);
    assert.equal(result.capabilitySection, "core");
    assert.equal(result.model, "model");
    assert.deepEqual(result.mcpServers, []);
    assert.deepEqual(result.plugins, []);
    assert.deepEqual(result.skills, []);
    assert.deepEqual(result.apps, []);
    assert.deepEqual(f.calls, { refresh: 0, skills: 0, integrations: 0, plugins: 0, mcp: 0, settings: 1, goal: 1, account: 1 });
  } finally {
    f.agent.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the plugin settings inventory does not read Apps or MCP details", async () => {
  const f = fixture();
  try {
    const result = await f.agent.executeMobile({ op: "capabilities", userId: 101, args: { sessionId: ownedSession, section: "plugins" } }) as Record<string, unknown>;
    assert.equal(result.capabilitySection, "plugins");
    assert.deepEqual(Object.keys(result).sort(), ["capabilitySection", "marketplaces", "pluginCatalogAvailable", "plugins"].sort());
    assert.deepEqual(result.plugins, []);
    assert.deepEqual(f.calls, { refresh: 0, skills: 0, integrations: 0, plugins: 1, mcp: 0, settings: 0, goal: 0, account: 0 });
  } finally {
    f.agent.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the Codex settings inventory starts optional reads while its general refresh is pending", async () => {
  const f = fixture();
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  (f.acp as unknown as { refreshInventories(): Promise<void> }).refreshInventories = async () => {
    f.calls.refresh += 1;
    await refreshGate;
  };
  try {
    const pending = f.agent.executeMobile({ op: "capabilities", userId: 101, args: { sessionId: ownedSession } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.calls.integrations, 1);
    assert.equal(f.calls.mcp, 1);
    assert.equal(f.calls.skills, 1);
    releaseRefresh();
    await pending;
  } finally {
    releaseRefresh();
    f.agent.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("capability sections cannot read another owner's thread", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.agent.executeMobile({ op: "capabilities", userId: 101, args: { sessionId: foreignSession, section: "skills" } }),
      /Доступ к сеансу запрещён/,
    );
    assert.deepEqual(f.calls, { refresh: 0, skills: 0, integrations: 0, plugins: 0, mcp: 0, settings: 0, goal: 0, account: 0 });
  } finally {
    f.agent.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
