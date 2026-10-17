import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConversationHistoryAsync } from "../src/sessions/history.js";

test("mobile history can include bounded plain-text tool results without changing normal chat history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-mobile-tools-"));
  const path = join(dir, "session.jsonl");
  try {
    const entries = [
      { timestamp: "2026-10-18T00:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Проверь файлы" }] } },
      { timestamp: "2026-10-18T00:00:01Z", type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "exec_command", arguments: "{}" } },
      { timestamp: "2026-10-18T00:00:02Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "Вывод\n" + "x".repeat(15_000) } },
      { timestamp: "2026-10-18T00:00:03Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Готово" }] } },
    ];
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");

    const normal = await readConversationHistoryAsync(path, 40);
    const withTools = await readConversationHistoryAsync(path, 40, 32 * 1024 * 1024, true);
    assert.deepEqual(normal.map((entry) => entry.role), ["user", "assistant"]);
    const output = withTools.find((entry) => entry.role === "tool" && entry.text.startsWith("Вывод"));
    assert.ok(output);
    assert.equal(output.tool, "exec_command");
    assert.equal(output.text.length, 12_000);
    assert.ok(output.text.endsWith("[вывод сокращён]"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
