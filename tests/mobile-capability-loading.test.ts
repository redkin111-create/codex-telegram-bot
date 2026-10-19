import assert from "node:assert/strict";
import test from "node:test";
import { loadCapabilitySections } from "../apps/codex-mobile/src/lib/capability-loading.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("fast skill inventory is applied while slower app and plugin inventories are pending", async () => {
  const apps = deferred<object>();
  const plugins = deferred<object>();
  const applied: string[] = [];

  const loading = loadCapabilitySections([
    { section: "skills", load: async () => ({ skills: ["browser-skill"] }) },
    { section: "apps", load: () => apps.promise },
    { section: "plugins", load: () => plugins.promise },
  ], (section) => applied.push(section));

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, ["skills"]);

  apps.resolve({ apps: [] });
  plugins.resolve({ plugins: [] });
  assert.deepEqual(await loading, []);
  assert.deepEqual(applied.sort(), ["apps", "plugins", "skills"]);
});

test("a failed inventory does not hide other sections and is reported by section name", async () => {
  const applied: string[] = [];
  const failed = await loadCapabilitySections([
    { section: "skills", load: async () => ({ skills: ["browser-skill"] }) },
    { section: "plugins", load: async () => { throw new Error("catalog unavailable"); } },
  ], (section, inventory) => { if (inventory) applied.push(section); });

  assert.deepEqual(applied, ["skills"]);
  assert.deepEqual(failed, ["plugins"]);
});
