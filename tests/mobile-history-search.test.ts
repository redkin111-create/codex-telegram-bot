import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConversationHistoryAsync, searchConversationHistoryAsync } from "../src/sessions/history.js";

function message(role: "user" | "assistant", text: string, timestamp: number) {
  return JSON.stringify({ type: "response_item", timestamp: new Date(timestamp).toISOString(), payload: {
    type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  } });
}

test("full history search finds messages older than the conversation window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-history-search-"));
  const path = join(dir, "rollout.jsonl");
  const lines = [message("user", "Ancient needle message", 1)];
  for (let index = 0; index < 60; index++) lines.push(message(index % 2 ? "assistant" : "user", `Recent message ${index}`, index + 2));
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  try {
    assert.equal((await readConversationHistoryAsync(path, 40)).some((entry) => entry.text.includes("Ancient needle")), false);
    const result = await searchConversationHistoryAsync(path, "needle");
    assert.equal(result.total, 1);
    assert.equal(result.entries[0]?.text, "Ancient needle message");
    assert.equal(result.entries[0]?.role, "user");
    assert.equal(result.skippedLargeRecords, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("forked conversation history includes its parent only through the fork point", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-fork-history-"));
  const parentId = "01a1575d-bb08-7af1-b09f-1b97d4de9085";
  const childId = "01a1577c-d2f2-7192-a77a-f51f75692404";
  const parentPath = join(dir, "parent.jsonl");
  const childPath = join(dir, "child.jsonl");
  const parentPrefix = [
    JSON.stringify({ type: "session_meta", payload: { id: parentId } }),
    message("user", "Parent prompt", 1),
    message("assistant", "Parent answer", 2),
  ].join("\n") + "\n";
  const forkOffset = Buffer.byteLength(parentPrefix);
  await writeFile(parentPath, parentPrefix, "utf8");
  await appendFile(parentPath, message("user", "Parent message after fork", 3) + "\n", "utf8");
  await writeFile(childPath, [
    JSON.stringify({ type: "session_meta", payload: { id: childId, history_base: { thread_id: parentId, end_byte_offset: forkOffset } } }),
    message("user", "Fork follow-up", 4),
    message("assistant", "Fork answer", 5),
  ].join("\n") + "\n", "utf8");
  try {
    const entries = await readConversationHistoryAsync(childPath, 40, 32 * 1024 * 1024, false,
      async (threadId) => threadId === parentId ? parentPath : undefined);
    assert.deepEqual(entries.map((entry) => entry.text), ["Parent prompt", "Parent answer", "Fork follow-up", "Fork answer"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("full history search includes tool output only when requested and pages all matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-history-search-tools-"));
  const path = join(dir, "rollout.jsonl");
  const lines = [
    JSON.stringify({ type: "response_item", timestamp: new Date(1).toISOString(), payload: { type: "function_call", call_id: "call-1", name: "web_search", arguments: "{}" } }),
    JSON.stringify({ type: "response_item", timestamp: new Date(2).toISOString(), payload: { type: "function_call_output", call_id: "call-1", output: "Private needle in tool output" } }),
    ...Array.from({ length: 205 }, (_, index) => message("assistant", `Needle result ${index}`, index + 3)),
  ];
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  try {
    assert.equal((await searchConversationHistoryAsync(path, "private needle")).total, 0);
    const withTools = await searchConversationHistoryAsync(path, "private needle", true);
    assert.equal(withTools.total, 1);
    assert.equal(withTools.entries[0]?.role, "tool");
    const latest = await searchConversationHistoryAsync(path, "needle", false, 100);
    assert.equal(latest.total, 205);
    assert.equal(latest.entries.length, 100);
    assert.equal(latest.entries[0]?.text, "Needle result 105");
    assert.equal(latest.entries.at(-1)?.text, "Needle result 204");
    assert.equal(latest.startOffset, 105);
    assert.equal(latest.nextOffset, 105);
    const middle = await searchConversationHistoryAsync(path, "needle", false, 100, latest.nextOffset);
    assert.equal(middle.entries[0]?.text, "Needle result 5");
    assert.equal(middle.entries.at(-1)?.text, "Needle result 104");
    assert.equal(middle.startOffset, 5);
    assert.equal(middle.nextOffset, 5);
    const oldest = await searchConversationHistoryAsync(path, "needle", false, 100, middle.nextOffset);
    assert.equal(oldest.entries.length, 5);
    assert.equal(oldest.entries[0]?.text, "Needle result 0");
    assert.equal(oldest.entries.at(-1)?.text, "Needle result 4");
    assert.equal(oldest.startOffset, 0);
    assert.equal(oldest.nextOffset, undefined);
    await assert.rejects(searchConversationHistoryAsync(path, "needle", false, 100, 206), /история Codex изменилась/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("full history search validates the query and skips a single oversized record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-history-search-limit-"));
  const path = join(dir, "rollout.jsonl");
  await writeFile(path, [message("user", "Before large record", 1), "x".repeat(16 * 1024 * 1024 + 1), message("assistant", "After large record", 2)].join("\n"), "utf8");
  try {
    await assert.rejects(searchConversationHistoryAsync(path, "x"), /2 до 100/);
    const result = await searchConversationHistoryAsync(path, "After large");
    assert.equal(result.total, 1);
    assert.equal(result.entries[0]?.text, "After large record");
    assert.equal(result.skippedLargeRecords, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
