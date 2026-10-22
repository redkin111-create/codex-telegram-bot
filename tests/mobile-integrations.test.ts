import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";
import { resolveRemotePluginInstall } from "../src/acp/plugins.js";
import { gitRemoteTarget } from "../src/mobile/git-remotes.js";
import { normalizeMobileIntegrations, normalizeMobileMcpServers } from "../src/mobile/integrations.js";

test("mobile Git remote display exposes only safe hosts and rejects executable helper protocols", () => {
  assert.equal(gitRemoteTarget("https://token:secret@github.com/org/repo.git"), "github.com");
  assert.equal(gitRemoteTarget("ssh://git@git.example:2222/org/repo.git"), "git.example:2222");
  assert.equal(gitRemoteTarget("git@git.example:org/repo.git"), "git.example");
  assert.equal(gitRemoteTarget("https://127.0.0.1:8080/origin.git"), "127.0.0.1:8080");
  assert.equal(gitRemoteTarget("C:\\work\\origin.git"), "Локальный Git");
  assert.equal(gitRemoteTarget("ext::sh -c echo-injected"), undefined);
  assert.equal(gitRemoteTarget("http://github.com/org/repo.git"), undefined);
  assert.equal(gitRemoteTarget("git://github.com/org/repo.git"), undefined);
});

test("mobile MCP status keeps useful per-thread details while redacting endpoints, errors and schemas", () => {
  const result = normalizeMobileMcpServers([{
    name: "local-tools", runtimeStatus: "connected", authStatus: "oauth",
    serverInfo: { name: "Local tools", version: "2.0", privatePath: "C:\\private\\server" },
    httpOrigin: "https://internal.example.invalid", toolsError: "C:\\private\\token: secret",
    tools: {
      read_file: { description: "Read a fixture file", inputSchema: { properties: { token: { default: "secret" } } } },
      "<script>": { description: "Literal <img src=x onerror=alert(1)>", inputSchema: { secret: "hidden" } },
    },
    resources: [{ uri: "file:///private/report" }], resourceTemplates: [{ uriTemplate: "file:///private/{name}" }],
  }]);
  assert.deepEqual(result, [{
    name: "local-tools", status: "connected", authStatus: "oauth", serverName: "Local tools", serverVersion: "2.0",
    tools: [
      { name: "read_file", description: "Read a fixture file" },
      { name: "<script>", description: "Literal <img src=x onerror=alert(1)>" },
    ], toolCount: 2, resourceCount: 1, resourceTemplateCount: 1, discoveryFailed: true,
  }]);
  assert.doesNotMatch(JSON.stringify(result), /internal\.example|private|secret|inputSchema|file:\/\//i);
});

test("mobile integration inventory drops local paths and unsafe URLs while keeping useful status", () => {
  const result = normalizeMobileIntegrations({
    marketplaces: [{ name: "official", path: "C:\\Users\\owner\\marketplace.json", plugins: [
      { id: "reviewer@official", name: "reviewer", installed: false, enabled: true,
        installPolicy: "AVAILABLE", availability: "AVAILABLE", source: { type: "remote", url: "https://private.invalid/plugin.git" },
        interface: { shortDescription: "Review changes", logo: "C:\\secret\\logo.png", logoUrl: "https://track.invalid/x" } },
      { id: "local@official", name: "local", installed: true, enabled: true, installPolicy: "NOT_AVAILABLE",
        source: { type: "local", path: "C:\\private\\plugin" }, interface: { shortDescription: "Local plugin" } },
    ] }],
  }, { marketplaces: [{ name: "official", plugins: [{ id: "local@official", installed: true }] }] },
  { data: [
    { id: "calendar", name: "Calendar", description: "Calendar connector", isEnabled: true, isAccessible: true,
      installUrl: "https://login.example.invalid/connect" },
    { id: "unsafe", name: "Unsafe URL", isEnabled: true, isAccessible: false, installUrl: "javascript:alert(1)" },
  ] },
  { apps: [{ id: "calendar", enabled: true, callable: true, runtimeName: "Calendar runtime" }] });

  assert.equal(result.pluginCatalogAvailable, true);
  assert.equal(result.appsAvailable, true);
  assert.equal(result.plugins.length, 2);
  assert.deepEqual(result.plugins.map((plugin) => [plugin.id, plugin.installed, plugin.enabled, plugin.canToggle, plugin.installable]), [
    ["reviewer@official", false, true, false, true], ["local@official", true, true, true, false],
  ]);
  assert.equal(result.plugins[0]?.description, "Review changes");
  assert.deepEqual(result.apps.map((app) => [app.id, app.enabled, app.callable, app.installUrl]), [
    ["calendar", true, true, "https://login.example.invalid/connect"], ["unsafe", true, false, undefined],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /C:\\\\Users|C:\\\\secret|private\\\\plugin|track\.invalid|plugin\.git/);
});

test("mobile integration inventory keeps every plugin in a 500-entry marketplace", () => {
  const plugins = Array.from({ length: 500 }, (_, index) => ({
    id: `plugin-${index + 1}@large`,
    name: `Plugin ${index + 1}`,
    source: { type: "remote" },
    installed: false,
    enabled: true,
    installPolicy: "AVAILABLE",
    availability: "AVAILABLE",
  }));

  const result = normalizeMobileIntegrations(
    { marketplaces: [{ name: "large", path: "C:\\fixture\\catalog.json", plugins }] },
    undefined,
    undefined,
    undefined,
  );

  assert.equal(result.plugins.length, 500);
  assert.equal(result.plugins[499]?.id, "plugin-500@large");
});

test("mobile integration inventory keeps all 300 apps from a larger Codex app catalog", () => {
  const apps = Array.from({ length: 300 }, (_, index) => ({
    id: `app-${index + 1}`,
    name: `Application ${index + 1}`,
    description: "Callable Codex app",
    isEnabled: true,
    isAccessible: true,
  }));

  const result = normalizeMobileIntegrations(undefined, undefined, { data: apps }, undefined);

  assert.equal(result.apps.length, 300);
  assert.equal(result.apps[299]?.id, "app-300");
});

test("remote plugin installation only resolves an available catalog entry without a local path", () => {
  const catalog = { marketplaces: [{ name: "official", path: null, plugins: [
    { id: "safe@official", name: "safe", source: { type: "remote" }, installed: false,
      enabled: true, installPolicy: "AVAILABLE", availability: "AVAILABLE" },
    { id: "local@official", name: "local", source: { type: "local", path: "C:\\private" }, installed: false,
      enabled: true, installPolicy: "AVAILABLE", availability: "AVAILABLE" },
    { id: "disabled@official", name: "disabled", source: { type: "remote" }, installed: false,
      enabled: false, installPolicy: "AVAILABLE", availability: "DISABLED_BY_ADMIN" },
    { id: "installed@official", name: "installed", source: { type: "remote" }, installed: true,
      enabled: true, installPolicy: "AVAILABLE", availability: "AVAILABLE" },
  ] }] };

  assert.deepEqual(resolveRemotePluginInstall(catalog, "safe@official", "official"), { pluginName: "safe", remoteMarketplaceName: "official" });
  assert.throws(() => resolveRemotePluginInstall(catalog, "safe@official", "elsewhere"), /каталоге/i);
  assert.throws(() => resolveRemotePluginInstall(catalog, "local@official", "official"), /удалённого каталога/i);
  assert.throws(() => resolveRemotePluginInstall(catalog, "disabled@official", "official"), /недоступен/i);
  assert.throws(() => resolveRemotePluginInstall(catalog, "installed@official", "official"), /уже установлен/i);
  assert.throws(() => resolveRemotePluginInstall({ marketplaces: [] }, "../../etc", "official"), /каталоге/i);
});

test("MCP inventory reads the selected thread and follows every cursor page", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const calls: Array<Record<string, unknown>> = [];
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method, params) => {
    assert.equal(method, "mcpServerStatus/list");
    calls.push(params as Record<string, unknown>);
    const cursor = (params as { cursor?: string }).cursor;
    return cursor
      ? { data: [{ name: "second", tools: {} }], nextCursor: null }
      : { data: [{ name: "first", tools: {} }], nextCursor: "mcp-page-2" };
  };
  try {
    const servers = await client.listMobileMcpServers("owned-thread");
    assert.deepEqual(servers.map((server) => server.name), ["first", "second"]);
    assert.deepEqual(calls, [
      { threadId: "owned-thread", detail: "full", limit: 100 },
      { threadId: "owned-thread", detail: "full", limit: 100, cursor: "mcp-page-2" },
    ]);
  } finally { client.stop(); }
});

test("installed integration inventories remain visible when the runtime cannot load catalogs", () => {
  const result = normalizeMobileIntegrations(undefined,
    { marketplaces: [{ name: "local", path: "C:\\private\\marketplace.json", plugins: [
      { id: "existing@local", name: "existing", installed: true, enabled: false, installPolicy: "NOT_AVAILABLE",
        source: { type: "local", path: "C:\\private\\plugin" }, interface: { shortDescription: "Installed locally" } },
    ] }] },
    undefined,
    { apps: [{ id: "notes", runtimeName: "Notes connector", enabled: true, callable: false }] });

  assert.equal(result.pluginCatalogAvailable, true);
  assert.equal(result.appsAvailable, true);
  assert.deepEqual(result.plugins.map((plugin) => [plugin.id, plugin.installed, plugin.canToggle, plugin.installable]), [["existing@local", true, true, false]]);
  assert.deepEqual(result.apps.map((app) => [app.id, app.name, app.enabled, app.callable]), [["notes", "Notes connector", true, false]]);
  assert.doesNotMatch(JSON.stringify(result), /C:\\\\private/);
});

test("ACP plugin operations re-check installed state and use only catalog-derived install parameters", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  const calls: Array<{ method: string; params: unknown }> = [];
  let pluginIsInstalled = false;
  internal.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "plugin/list") return { marketplaces: [{ name: "official", plugins: [
      { id: "remote@official", name: "remote-package-name", source: { type: "remote" }, installed: false,
        enabled: true, installPolicy: "AVAILABLE", availability: "AVAILABLE" },
      { id: "local@official", name: "local", source: { type: "local", path: "C:\\private" }, installed: false,
        enabled: true, installPolicy: "AVAILABLE", availability: "AVAILABLE" },
    ] }] };
    if (method === "plugin/installed") return { marketplaces: pluginIsInstalled ? [{ name: "official", plugins: [
      { id: "remote@official", name: "remote-package-name", source: { type: "remote" }, installed: true,
        enabled: true, installPolicy: "AVAILABLE", availability: "AVAILABLE" },
    ] }] : [] };
    if (method === "plugin/install") { pluginIsInstalled = true; return { appsNeedingAuth: [] }; }
    if (method === "plugin/uninstall") { pluginIsInstalled = false; return {}; }
    throw new Error(`Unexpected ACP method: ${method}`);
  };
  client.refreshInventories = async () => undefined;
  try {
    await client.installMobilePlugin("remote@official", "official", "C:\\work\\project");
    const installCall = calls.find((call) => call.method === "plugin/install");
    assert.ok(installCall);
    const installParams = installCall.params as { pluginName: string; remoteMarketplaceName: string; installAttemptId: string };
    assert.deepEqual({ pluginName: installParams.pluginName, remoteMarketplaceName: installParams.remoteMarketplaceName }, {
      pluginName: "remote-package-name", remoteMarketplaceName: "official",
    });
    assert.match(installParams.installAttemptId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(calls.filter((call) => call.method !== "plugin/install"), [
      { method: "plugin/list", params: { cwds: ["C:\\work\\project"] } },
      { method: "plugin/installed", params: {} },
    ]);
    await assert.rejects(client.installMobilePlugin("remote@official", "official", "C:\\work\\project"), /уже установлен/i);
    const installAttempts = calls.filter((call) => call.method === "plugin/install").length;
    await assert.rejects(client.installMobilePlugin("local@official", "official", "C:\\work\\project"), /удалённого каталога/i);
    assert.equal(calls.filter((call) => call.method === "plugin/install").length, installAttempts);
    await client.uninstallMobilePlugin("remote@official");
    assert.equal(pluginIsInstalled, false);
    await assert.rejects(client.uninstallMobilePlugin("unknown@official"), /не найден среди установленных/i);
  } finally { client.stop(); }
});

test("ACP plugin enablement changes only a unique installed plugin and verifies the effective state", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  const calls: Array<{ method: string; params: unknown }> = [];
  let enabled = true;
  let installed = true;
  internal.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "plugin/list") return { marketplaces: [{ name: "official", plugins: installed ? [
      { id: "remote@official", installed: true, enabled, availability: "AVAILABLE" },
    ] : [] }] };
    if (method === "plugin/installed") return { marketplaces: [{ name: "official", plugins: installed ? [
      { id: "remote@official", installed: true, enabled, availability: "AVAILABLE" },
    ] : [] }] };
    if (method === "config/value/write") {
      const write = params as { keyPath: string; value: unknown; mergeStrategy: string };
      assert.equal(write.keyPath, 'plugins."remote@official".enabled');
      assert.equal(write.value, false);
      assert.equal(write.mergeStrategy, "upsert");
      enabled = false;
      return { status: "ok" };
    }
    throw new Error(`Unexpected ACP method: ${method}`);
  };
  client.refreshInventories = async () => undefined;
  try {
    assert.equal(await client.setMobilePluginEnabled("remote@official", false, "C:\\work\\project"), false);
    assert.deepEqual(calls.map(({ method }) => method), ["plugin/list", "plugin/installed", "config/value/write", "plugin/list", "plugin/installed"]);
    installed = false;
    await assert.rejects(client.setMobilePluginEnabled("missing@official", false, "C:\\work\\project"), /не найден среди установленных/i);
  } finally { client.stop(); }
});

test("ACP plugin enablement rejects ambiguous, admin-disabled and unconfirmed plugin state", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  let inventory: unknown = { marketplaces: [{ name: "official", plugins: [
    { id: "remote@official", installed: true, enabled: true, availability: "AVAILABLE" },
  ] }] };
  let catalog: unknown = { marketplaces: [{ name: "official", plugins: [
    { id: "remote@official", installed: true, enabled: true, availability: "AVAILABLE" },
  ] }] };
  let writes = 0;
  internal.request = async (method) => {
    if (method === "plugin/installed") return inventory;
    if (method === "plugin/list") return catalog;
    if (method === "config/value/write") { writes += 1; return { status: "ok" }; }
    throw new Error(`Unexpected ACP method: ${method}`);
  };
  client.refreshInventories = async () => undefined;
  try {
    inventory = { marketplaces: [{ name: "official", plugins: [
      { id: "remote@official", installed: true, enabled: true },
      { id: "remote@official", installed: true, enabled: true },
    ] }] };
    catalog = inventory;
    await assert.rejects(client.setMobilePluginEnabled("remote@official", false, "C:\\work\\project"), /однозначно|несколько/i);
    inventory = { marketplaces: [{ name: "official", plugins: [
      { id: "remote@official", installed: true, enabled: true, availability: "AVAILABLE" },
    ] }] };
    catalog = { marketplaces: [{ name: "official", plugins: [
      { id: "remote@official", installed: true, enabled: false, availability: "DISABLED_BY_ADMIN" },
    ] }] };
    await assert.rejects(client.setMobilePluginEnabled("remote@official", true, "C:\\work\\project"), /администратор|политик/i);
    inventory = { marketplaces: [{ name: "official", plugins: [
      { id: "remote@official", installed: true, enabled: true, availability: "AVAILABLE" },
    ] }] };
    catalog = inventory;
    await assert.rejects(client.setMobilePluginEnabled("remote@official", false, "C:\\work\\project"), /не подтвердил|итоговое состояние/i);
    assert.equal(writes, 1);
  } finally { client.stop(); }
});
