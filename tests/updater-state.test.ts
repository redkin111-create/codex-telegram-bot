import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updater } from "../src/app/updater.js";

test("updater rejects malformed pending updates without erasing their persisted state", () => {
  const dir = mkdtempSync(join(tmpdir(), "updater-state-"));
  const path = join(dir, "update-state.json");
  const create = () => new Updater({
    enabled: false, intervalMs: 60_000, projectRoot: dir, instanceDir: dir, dataDir: dir,
    isPromptInFlight: () => false, otherActiveSessions: () => 0,
    announce: async () => {}, shutdown: async () => {},
  });
  try {
    for (const data of [[], 42, "invalid", {}, { from: "1.0.0", to: "1.1.0", chats: "101" },
      { from: "1.0.0", to: "1.1.0", chats: [null] }]) {
      const contents = JSON.stringify(data);
      writeFileSync(path, contents);
      assert.throws(create, /invalid.*state/i);
      assert.equal(readFileSync(path, "utf8"), contents);
    }
    for (const data of [null, { from: "1.0.0", to: "1.1.0", chats: [101] }]) {
      writeFileSync(path, JSON.stringify(data));
      assert.doesNotThrow(create);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
