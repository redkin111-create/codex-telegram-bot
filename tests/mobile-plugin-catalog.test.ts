import assert from "node:assert/strict";
import test from "node:test";
import { filterPluginCatalog, paginatePluginCatalog } from "../apps/codex-mobile/src/lib/plugin-catalog.js";

const plugins = Array.from({ length: 500 }, (_, index) => ({
  id: `plugin-${index + 1}@catalog`,
  name: `Plugin ${index + 1}`,
  marketplace: "Fixture catalog",
  description: index === 499 ? "Final searchable extension" : undefined,
}));

test("plugin search can find an entry after the first 80 catalog items", () => {
  assert.deepEqual(filterPluginCatalog(plugins, "plugin 500"), [plugins[499]]);
});

test("plugin search matches IDs, marketplaces and descriptions without case sensitivity", () => {
  assert.deepEqual(filterPluginCatalog(plugins, "PLUGIN-500@CATALOG"), [plugins[499]]);
  assert.deepEqual(filterPluginCatalog(plugins, "fixture CATALOG"), plugins);
  assert.deepEqual(filterPluginCatalog(plugins, "FINAL SEARCHABLE EXTENSION"), [plugins[499]]);
});

test("plugin catalog pagination makes all 500 entries reachable on small pages", () => {
  const result = paginatePluginCatalog(plugins, 25, 20);

  assert.equal(result.total, 500);
  assert.equal(result.page, 25);
  assert.equal(result.pageCount, 25);
  assert.equal(result.items.length, 20);
  assert.equal(result.items[0]?.id, "plugin-481@catalog");
  assert.equal(result.items[19]?.id, "plugin-500@catalog");
});
