import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../src/app/json-store.js";

test("JSON stores reject incompatible persisted roots without replacing saved data", () => {
  const dir = mkdtempSync(join(tmpdir(), "json-store-shape-"));
  const path = join(dir, "state.json");
  try {
    for (const [fallback, invalid] of [[{}, null], [{}, []], [{}, 2], [[], {}], [[], null]]) {
      const contents = JSON.stringify(invalid);
      writeFileSync(path, contents);
      assert.throws(() => new JsonStore(path, fallback), /invalid.*state/i);
      assert.equal(readFileSync(path, "utf8"), contents);
    }
    writeFileSync(path, "null");
    assert.equal(new JsonStore<object | null>(path, null).get(), null);
    writeFileSync(path, '{"from":"1","to":"2","chats":[]}');
    assert.deepEqual(new JsonStore<object | null>(path, null).get(), { from: "1", to: "2", chats: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
