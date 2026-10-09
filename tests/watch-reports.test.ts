import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import { chunkPlainText } from "../src/bot/telegram-io.js";
import { deliverWatchReport } from "../src/bot/watch-report.js";
import { recentWatchImagePaths, watchImagePathsFromEvents } from "../src/bot/watch-images.js";
import { sendImages } from "../src/bot/image-return.js";

test("long watched reports are sent losslessly as ordered Telegram chunks and a full document", async () => {
  const report = "Работа завершена.\n" + "Проверил страницы и сделал исправления.\n".repeat(370) + "✅ Готово";
  const sent: string[] = [];
  const docs: unknown[] = [];
  const api = {
    sendMessage: async (_chat: number, msg: string) => {
      sent.push(msg);
      assert(msg.length <= 4096, "Telegram must accept every part");
      return { message_id: sent.length };
    },
    sendDocument: async (_chat: number, doc: unknown) => { docs.push(doc); return { message_id: 50 }; },
  } as unknown as Api;
  await deliverWatchReport(api, 4, [{ role: "assistant", text: report }], true);
  assert(sent.length > 1);
  assert.equal(sent.join(""), "🤖 Codex\n" + report);
  assert.equal(docs.length, 1, "long report is also attached as Markdown");
});

test("Telegram chunk boundaries preserve multiline text and surrogate-pair emoji", () => {
  const src = "A".repeat(95) + "😀" + "\n" + "строка\n".repeat(50) + "Z";
  const parts = chunkPlainText(src, 96);
  assert(parts.length > 1);
  assert(parts.every((part) => part.length <= 96));
  assert.equal(parts.join(""), src);
});

test("short watched responses do not send an unnecessary attachment", async () => {
  let count = 0;
  const texts: string[] = [];
  const api = {
    sendMessage: async (_c: number, text: string) => { texts.push(text); return { message_id: 1 }; },
    sendDocument: async () => { count++; return { message_id: 2 }; },
  } as unknown as Api;
  await deliverWatchReport(api, 44, [
    { role: "user", text: "проверь проект" },
    { role: "tool", text: "secret token output" },
    { role: "assistant", text: "Отчёт целиком" },
  ], false);
  assert.equal(count, 0);
  assert.equal(texts.join("\n"), "👤 Запрос\nпроверь проект\n🤖 Codex\nОтчёт целиком");
  assert(!texts.join(" ").includes("secret token"));
});

test("screen image references from rollout tool outputs are found without publishing their logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-watch-images-"));
  try {
    const screenshot = join(dir, "screen 1.png");
    writeFileSync(screenshot, Buffer.from([137, 80, 78, 71]));
    const lines = [
      JSON.stringify({ type: "response_item", payload: {
        type: "function_call_output", output: `Screenshot saved to "${screenshot}"`
      }}),
      JSON.stringify({ type: "response_item", payload: {
        type: "message", role: "assistant", content: [{ type: "output_text", text: `Done: "${screenshot}"` }]
      }}),
    ];
    const found = watchImagePathsFromEvents(lines, dir);
    assert.deepEqual(found, [screenshot]);
    const log = join(dir, "rollout.jsonl");
    writeFileSync(log, lines.join("\n") + "\n");
    assert.deepEqual(recentWatchImagePaths(log, dir), [screenshot]);

    let sent = 0;
    const api = {
      sendPhoto: async () => { sent++; return { message_id: sent }; },
    } as unknown as Api;
    const already = new Set<string>();
    const first = await sendImages(api, 44, found, { since: Date.now() - 2000, already, max: 8, root: dir });
    const again = await sendImages(api, 44, found, { since: Date.now() - 2000, already, max: 8, root: dir });
    assert.equal(first, 1);
    assert.equal(again, 0);
    assert.equal(sent, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watch images cannot escape project via absolute paths or symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-watch-root-"));
  const outside = mkdtempSync(join(tmpdir(), "codex-watch-outside-"));
  try {
    const filename = join(outside, "private.png");
    writeFileSync(filename, Buffer.from([137, 80, 78, 71]));
    let sent = 0;
    const api = { sendPhoto: async () => { sent++; return { message_id: 1 }; } } as unknown as Api;
    const count = await sendImages(api, 5, [filename], {
      root, since: Date.now() - 2000, already: new Set(), max: 8,
    });
    assert.equal(count, 0);
    assert.equal(sent, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
