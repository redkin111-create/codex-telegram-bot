import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InputFile } from "grammy";
import type { AcpClient } from "../src/acp/client.js";
import type { AppConfig } from "../src/config.js";
import { SessionRuntime } from "../src/bot/session-runtime.js";
import { splitReportText, sendCompleteWatchReport } from "../src/bot/watch-report.js";
import { extractImagePaths, sendImages } from "../src/bot/image-return.js";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "../src/app/notifications.js";

test("page splitter preserves every character, even long lines, Markdown and emoji", () => {
  const report = "Заголовок\n" + "🚀".repeat(2500) + "\n```ts\n" + "x".repeat(4300) + "\n```";
  const pages = splitReportText(report);
  assert(pages.length > 2);
  assert.equal(pages.join(""), report);
  assert(pages.every((p) => p.length <= 3500));
  for (const page of pages) {
    assert(!/[\uD800-\uDBFF]$/.test(page), "no page ends with a half emoji");
    assert(!/^[\uDC00-\uDFFF]/.test(page), "no page begins with a half emoji");
  }
});

test("complete watch report uses multiple safe Telegram messages and includes original markdown document", async () => {
  const sent: string[] = [];
  const docs: Array<{ source: unknown; caption?: string }> = [];
  const api = {
    sendMessage: async (_chat: number, message: string) => {
      assert(message.length <= 4096);
      sent.push(message);
      return { message_id: sent.length };
    },
    sendDocument: async (_chat: number, file: InputFile, extra: { caption?: string }) => {
      docs.push({ source: file, caption: extra.caption });
      return { message_id: 100 };
    },
  } as unknown as Api;
  const report = "Summary\n" + "abc".repeat(4200) + "\n![proof](output/screen.png)";
  await sendCompleteWatchReport(api, 101, report, { title: "Codex" });
  assert(sent.length >= 3);
  assert.equal(sent.map((m) => m.slice(m.indexOf("\n\n") + 2)).join(""), report);
  assert.equal(docs.length, 1);
  assert(docs[0]!.source instanceof InputFile);
});

test("extremely long report uses readable preview and complete document instead of flooding chat", async () => {
  let pages = 0;
  let files = 0;
  const api = {
    sendMessage: async () => { pages++; return { message_id: 1 }; },
    sendDocument: async () => { files++; return { message_id: 2 }; },
  } as unknown as Api;
  await sendCompleteWatchReport(api, 101, "a".repeat(60000));
  assert.equal(pages, 1);
  assert.equal(files, 1);
});

test("watcher replay sends an untruncated assistant report and screenshots from the observed project", async () => {
  const base = mkdtempSync(join(tmpdir(), "codex-tg-watch-report-"));
  const project = join(base, "other-project");
  const logFile = join(base, "rollout.jsonl");
  const screenshot = join(project, "output", "screen.png");
  const sent: string[] = [];
  const photos: unknown[] = [];
  const docs: unknown[] = [];
  try {
    mkdirSync(join(project, "output"), { recursive: true });
    writeFileSync(screenshot, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9GdrgAAAAAElFTkSuQmCC", "base64"));
    const full = "Готовый полный отчёт: " + "X".repeat(6200) + "\n![](output/screen.png)";
    writeFileSync(logFile, [
      { type: "session_meta", payload: { id: "watch-id", cwd: project } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: full }] } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const api = {
      sendMessage: async (_id: number, text: string) => { sent.push(text); return { message_id: sent.length }; },
      sendDocument: async (_id: number, input: unknown) => { docs.push(input); return { message_id: 77 }; },
      sendPhoto: async (_id: number, input: unknown) => { photos.push(input); return { message_id: 78 }; },
    } as unknown as Api;
    const cfg = { dataDir: base, workspace: base, sendAgentImages: true, agentImagesMax: 8 } as AppConfig;
    const settings = { get: () => ({ reasoning: "medium", notifications: DEFAULT_NOTIFICATION_PREFERENCES }) };
    const acp = Object.assign(new EventEmitter(), { metadataFor: () => undefined }) as unknown as AcpClient;
    const runtime = new SessionRuntime(api, 1004, acp, cfg, settings as never, { cwd: base, sessionId: "watch-id" });
    try {
      assert.equal(await runtime.sendLastWatchReport(logFile, project), true);
      assert.equal(sent.map((m) => m.slice(m.indexOf("\n\n") + 2)).join(""), full);
      assert.equal(photos.length, 1);
      assert.equal(docs.length, 1);
      // A manual replay should still provide the full text; screenshots need not be duplicated.
    } finally {
      runtime.dispose();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("Markdown image link stays relative to the watched project's directory", () => {
  const cwd = join(tmpdir(), "a-project");
  const paths = extractImagePaths("![screen](output/screen.png)", cwd);
  assert(paths.includes(join(cwd, "output", "screen.png")));
  assert(!paths.includes(join("/","screen.png")));
});

test("watcher rejects a referenced screenshot outside the watched project", async () => {
  const base = mkdtempSync(join(tmpdir(), "codex-tg-watch-safety-"));
  try {
    const inside = join(base, "project");
    mkdirSync(inside);
    const outside = join(base, "private.png");
    writeFileSync(outside, "some image data");
    let sent = 0;
    const api = { sendPhoto: async () => { sent++; }, sendDocument: async () => { sent++; } } as unknown as Api;
    const count = await sendImages(api, 1005, [outside], {
      since: 0, already: new Set(), max: 8, allowedRoot: inside,
    });
    assert.equal(count, 0);
    assert.equal(sent, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
