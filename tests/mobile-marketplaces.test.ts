import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";
import { requireManagedMarketplace, validateMobileMarketplaceRef, validateMobileMarketplaceSource } from "../src/acp/marketplaces.js";
import { normalizeMobileMarketplaces } from "../src/mobile/marketplaces.js";

test("mobile marketplace inventory exposes safe management metadata only", () => {
  const result = normalizeMobileMarketplaces({ marketplaces: [
    { name: "official", path: null, plugins: [{ id: "remote@official" }] },
    { name: "company-tools", path: "C:\\Users\\owner\\.codex\\plugins\\company\\marketplace.json", plugins: [
      { id: "reviewer@company-tools" }, { id: "formatter@company-tools" },
    ] },
    { name: "C:\\Users\\owner\\secret", path: "C:\\private\\marketplace.json", plugins: [] },
  ] }, { marketplaces: [{ name: "company-tools", path: "C:\\private", plugins: [
    { id: "reviewer@company-tools", installed: true }, { id: "old@company-tools", installed: true },
  ] }] });

  assert.deepEqual(result, [
    { name: "official", pluginCount: 1, installedPluginCount: 0, manageable: false },
    { name: "company-tools", pluginCount: 2, installedPluginCount: 1, manageable: true },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /C:\\|private|marketplace\.json/i);
});

test("marketplace sources accept GitHub shorthand and safe HTTPS URLs only", () => {
  assert.equal(validateMobileMarketplaceSource("owner/repo"), "owner/repo");
  assert.equal(validateMobileMarketplaceSource("https://github.com/owner/repo.git"), "https://github.com/owner/repo.git");
  assert.throws(() => validateMobileMarketplaceSource("C:\\private\\marketplace"), /HTTPS-адрес или owner\/repo/i);
  assert.throws(() => validateMobileMarketplaceSource("git@github.com:owner/repo.git"), /HTTPS-адрес или owner\/repo/i);
  assert.throws(() => validateMobileMarketplaceSource("https://user:secret@example.com/owner/repo.git"), /без имени пользователя/i);
  assert.throws(() => validateMobileMarketplaceSource("https://127.0.0.1/private.git"), /GitHub HTTPS/i);
  assert.throws(() => validateMobileMarketplaceSource("https://example.local/private.git"), /GitHub HTTPS/i);
  assert.throws(() => validateMobileMarketplaceSource("https://github.com.evil.example/owner/repo.git"), /GitHub HTTPS/i);
  assert.throws(() => validateMobileMarketplaceSource("https://github.com/owner/repo/tree/main"), /Недопустимый адрес/i);
  assert.throws(() => validateMobileMarketplaceSource("https://github.com/owner%2frepo/repository.git"), /Недопустимый адрес/i);
  assert.throws(() => validateMobileMarketplaceSource("https://example.com/a/../private.git"), /HTTPS-адрес или owner\/repo/i);
});

test("marketplace selection is rechecked against live Codex state and ref names stay bounded", () => {
  const catalog = { marketplaces: [
    { name: "company-tools", path: "C:\\private\\marketplace.json" },
    { name: "official", path: null },
  ] };
  assert.equal(requireManagedMarketplace(catalog, "company-tools"), "company-tools");
  assert.throws(() => requireManagedMarketplace(catalog, "official"), /не управляется/i);
  assert.throws(() => requireManagedMarketplace(catalog, "missing"), /не управляется/i);
  assert.throws(() => requireManagedMarketplace({ marketplaces: [
    { name: "bad/name", path: "C:\\private\\marketplace.json" },
  ] }, "bad/name"), /Выберите каталог/i);
  assert.equal(validateMobileMarketplaceRef("stable/release-1"), "stable/release-1");
  assert.equal(validateMobileMarketplaceRef("  "), undefined);
  assert.throws(() => validateMobileMarketplaceRef("../secret"), /ветка или версия/i);
});

test("ACP marketplace operations use native methods and revalidate managed catalog entries", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: "C:\\work", trustAllTools: false });
  const calls: Array<{ method: string; params: unknown }> = [];
  const internal = client as unknown as { request: (method: string, params: unknown) => Promise<unknown> };
  internal.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "plugin/list") return { marketplaces: [
      { name: "company-tools", path: "C:\\private\\marketplace.json", plugins: [] },
      { name: "official", path: null, plugins: [] },
    ] };
    if (method === "marketplace/add") return { marketplaceName: "new-tools", installedRoot: "C:\\private", alreadyAdded: false };
    if (method === "marketplace/remove") return {};
    if (method === "marketplace/upgrade") return { upgraded: ["company-tools"] };
    throw new Error(`Unexpected ACP method: ${method}`);
  };
  client.refreshInventories = async () => undefined;
  try {
    const added = await client.addMobileMarketplace("owner/new-tools", "stable");
    assert.deepEqual(added, { marketplaceName: "new-tools", alreadyAdded: false });
    await client.upgradeMobileMarketplace("company-tools");
    await client.removeMobileMarketplace("company-tools");
    await assert.rejects(client.removeMobileMarketplace("official"), /не управляется в мобильном клиенте/i);
    await assert.rejects(client.upgradeMobileMarketplace("official"), /не управляется в мобильном клиенте/i);
    assert.deepEqual(calls, [
      { method: "marketplace/add", params: { source: "owner/new-tools", refName: "stable" } },
      { method: "plugin/list", params: {} },
      { method: "marketplace/upgrade", params: { marketplaceName: "company-tools" } },
      { method: "plugin/list", params: {} },
      { method: "marketplace/remove", params: { marketplaceName: "company-tools" } },
      { method: "plugin/list", params: {} },
      { method: "plugin/list", params: {} },
    ]);
  } finally { client.stop(); }
});
