import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import { EventEmitter } from "node:events";
import type { AcpClient } from "../src/acp/client.js";
import type { AppConfig } from "../src/config.js";
import { SessionRuntime } from "../src/bot/session-runtime.js";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "../src/app/notifications.js";
import { chunkPlainText } from "../src/bot/telegram-io.js";
import { deliverWatchReport } from "../src/bot/watch-report.js";
import { recentWatchImagePaths, watchImagePathsFromEvents } from "../src/bot/watch-images.js";
import { extractImagePaths, sendImages } from "../src/bot/image-return.js";
import { showHistory } from "../src/bot/handlers/history.js";
import type { BotDeps } from "../src/bot/deps.js";

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

test("Watch backfills a complete previous Codex answer and its screenshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-watch-integration-"));
  const path = join(dir, "screen.png");
  const log = join(dir, "rollout.jsonl");
  const answer = "Completed task\\n" + "Reviewed everything.\\n".repeat(410);
  writeFileSync(path, Buffer.from([137, 80, 78, 71]));
  const records = [
    { type: "session_meta", payload: { id: "watch-session", cwd: dir } },
    { type: "response_item", payload: { type: "function_call_output", output: `Screenshot saved: "${path}"` } },
    { type: "response_item", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: answer }] } },
  ];
  writeFileSync(log, records.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const sent: string[] = [];
  let docs = 0;
  let images = 0;
  const api = {
    sendMessage: async (_id: number, body: string) => { sent.push(body); return { message_id: sent.length }; },
    sendDocument: async () => { docs++; return { message_id: 30 }; },
    sendPhoto: async () => { images++; return { message_id: 31 }; },
  } as unknown as Api;
  const cfg = { workspace: dir, dataDir: dir, sendAgentImages: true, agentImagesMax: 8,
    quietNotifications: true } as AppConfig;
  const acp = new EventEmitter() as AcpClient;
  const settings = { get: () => ({ notifications: DEFAULT_NOTIFICATION_PREFERENCES }) };
  const runtime = new SessionRuntime(api, 9090, acp, cfg, settings as never,
    { cwd: dir, sessionId: "watch-session" });
  try {
    runtime.startWatch(log, false, dir);
    // The snapshot is sent asynchronously and ordered before future log events.
    const pending = (runtime as unknown as { watchDelivery: Promise<void> }).watchDelivery;
    await pending;
    assert.equal(sent.join(""), "🤖 Codex\n" + answer);
    assert(sent.length > 1);
    assert.equal(docs, 1);
    assert.equal(images, 1);
  } finally {
    runtime.stopWatch();
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Markdown screenshot paths stay relative to the watched project", () => {
  const root = join(tmpdir(), "watch-relative");
  const image = join(root, "screenshots", "visual.png");
  const refs = extractImagePaths("Evidence: ![visual](screenshots/visual.png)", root);
  assert(refs.includes(image));
  assert(!refs.includes(join("/","visual.png")));
});

test("/history preserves an assistant report longer than Telegram's message limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-history-full-"));
  try {
    const file = join(dir, "rollout.jsonl");
    const answer = "FULL-START\n" + "Detailed work completed.\n".repeat(400) + "FULL-END";
    writeFileSync(file, JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant",
        content: [{ type: "output_text", text: answer }] },
    }) + "\n");
    const sent: string[] = [];
    let docs = 0;
    const deps = {
      store: { jsonlPath: () => file },
      api: {
        sendMessage: async (_id: number, text: string) => { sent.push(text); return { message_id: sent.length }; },
        sendDocument: async () => { docs++; return { message_id: 999 }; },
      },
    } as unknown as BotDeps;
    await showHistory(deps, 100, "history-session");
    assert(sent.length > 1);
    assert(sent.every((part) => part.length <= 4096));
    assert(sent.join("").includes("FULL-START"));
    assert(sent.join("").includes("FULL-END"));
    assert.equal(docs, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
