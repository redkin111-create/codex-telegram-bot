import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpClient } from "../src/acp/client.js";
import type { AppConfig } from "../src/config.js";
import type { Api } from "grammy";
import { SettingsStore } from "../src/app/settings-store.js";
import { DEFAULT_NOTIFICATION_PREFERENCES, notificationCompletionEnabled, notificationPreset } from "../src/app/notifications.js";
import { textPrompt } from "../src/app/types.js";
import { SessionRuntime, LiveSessionConflictError } from "../src/bot/session-runtime.js";
import { isAllowedTelegramDocument, isSafeTelegramImageMime, MAX_TELEGRAM_ATTACHMENT_BYTES, removeIncomingAttachment, safeAttachmentFilename, saveIncomingAttachment } from "../src/bot/incoming-files.js";
import { OutgoingArtifactStore } from "../src/bot/outgoing-artifacts.js";

test("notification presets preserve approvals and enforce the global background off switch", () => {
  assert.deepEqual(DEFAULT_NOTIFICATION_PREFERENCES, {
    completion: true, approval: true, error: true, backgroundCompletion: true, progress: false, mode: "all",
  });
  for (const preset of ["attention", "quiet"] as const) {
    const prefs = notificationPreset(preset);
    assert.equal(prefs.completion, false);
    assert.equal(prefs.backgroundCompletion, false);
    assert.equal(prefs.progress, false);
    assert.equal(prefs.approval, true);
    assert.equal(prefs.error, true);
  }
  assert.equal(notificationCompletionEnabled(true, notificationPreset("attention"), false), false);
  assert.equal(notificationCompletionEnabled(false, notificationPreset("all"), false), false);
  assert.equal(notificationCompletionEnabled(false, notificationPreset("all"), true), true);
});

test("chat notification settings survive reload independently", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-settings-"));
  try {
    const first = new SettingsStore(dir);
    first.update(101, { notifications: notificationPreset("quiet") });
    first.update(202, { notifications: { ...notificationPreset("all"), progress: true } });
    const reloaded = new SettingsStore(dir);
    assert.equal(reloaded.get(101).notifications?.mode, "quiet");
    assert.equal(reloaded.get(101).notifications?.approval, true);
    assert.equal(reloaded.get(202).notifications?.progress, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("incoming attachments are allowlisted, sanitized, bounded, and removable only from their private folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-incoming-"));
  try {
    assert.equal(safeAttachmentFilename("../../Пример.txt"), "Пример.txt");
    assert.equal(isAllowedTelegramDocument("notes.MD"), true);
    assert.equal(isAllowedTelegramDocument("run.exe", "application/octet-stream"), false);
    assert.equal(isAllowedTelegramDocument("x", "image/png"), true);
    assert.equal(isSafeTelegramImageMime("image/webp"), true);
    assert.equal(isSafeTelegramImageMime("image/svg+xml"), false);
    const saved = await saveIncomingAttachment(dir, "../../report.pdf", Buffer.from("%PDF-test"));
    assert.equal(saved.path.startsWith(join(dir, "telegram-incoming")), true);
    assert.equal(await removeIncomingAttachment(dir, join(dir, "outside.txt")), false);
    assert.equal(await removeIncomingAttachment(dir, saved.path), true);
    await assert.rejects(() => saveIncomingAttachment(dir, "too-large.zip", Buffer.alloc(MAX_TELEGRAM_ATTACHMENT_BYTES + 1)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queued messages remain separate and can be edited or removed by stable id", async () => {
  const acp = Object.assign(new EventEmitter(), { metadataFor: () => undefined });
  const settings = { get: () => ({ reasoning: "medium" }) };
  const cfg = { workspace: tmpdir(), dataDir: tmpdir() } as AppConfig;
  const runtime = new SessionRuntime({} as Api, 77, acp as unknown as AcpClient, cfg, settings as never, { cwd: tmpdir(), sessionId: "existing" });
  Object.assign(runtime as unknown as Record<string, unknown>, { rebindPending: false, sessionLive: true, busy: true });
  try {
    const withAttachment = textPrompt("первое");
    withAttachment.attachmentNames = ["report.txt"];
    withAttachment.attachmentContext = "Содержимое файла: проверочный текст";
    assert.equal(await runtime.submit(withAttachment), "queued");
    assert.equal(await runtime.submit(textPrompt("второе")), "queued");
    const entries = runtime.queuedPrompts;
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((entry) => entry.input.text), ["первое", "второе"]);
    assert.notEqual(entries[0]?.id, entries[1]?.id);
    assert.equal(runtime.editQueued(entries[0]!.id, "исправлено"), true);
    assert.equal(runtime.queuedPrompts[0]?.input.text, "исправлено\n\nСодержимое файла: проверочный текст");
    assert.deepEqual(runtime.queuedPrompts[0]?.input.attachmentNames, ["report.txt"]);
    assert.equal(runtime.editQueued(entries[0]!.id, "   "), false);
    assert.equal(runtime.removeQueued(entries[0]!.id), true);
    assert.equal(runtime.queuedPrompts.length, 1);
    assert.equal(runtime.clearQueue(), 1);
  } finally {
    runtime.dispose();
  }
});

test("resume conflict is reported instead of silently starting a new session", async () => {
  let newSessions = 0;
  const acp = Object.assign(new EventEmitter(), {
    supportsLoadSession: true,
    loadSession: async () => { throw new Error("thread already active in another process"); },
    newSession: async () => { newSessions++; return "unexpected"; },
    metadataFor: () => undefined,
  });
  const runtime = new SessionRuntime({} as Api, 78, acp as unknown as AcpClient, { workspace: tmpdir(), dataDir: tmpdir() } as AppConfig, { get: () => ({ reasoning: "medium" }) } as never, { cwd: tmpdir(), sessionId: "desktop-thread" });
  try {
    await assert.rejects(runtime.attach("desktop-thread", tmpdir(), "project"), LiveSessionConflictError);
    assert.equal(newSessions, 0);
  } finally {
    runtime.dispose();
  }
});

test("outgoing artifacts include only created safe files and tokens are chat-bound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-artifacts-"));
  const root = join(dir, "workspace");
  const outside = join(dir, "outside");
  try {
    mkdirSync(root);
    mkdirSync(outside);
    const note = join(root, "report.md");
    const secret = join(root, "access_token.json");
    const source = join(root, "app.ts");
    const external = join(outside, "private.pdf");
    writeFileSync(note, "safe report");
    writeFileSync(secret, "sensitive");
    writeFileSync(source, "source");
    writeFileSync(external, "outside");
    const link = join(root, "alias.md");
    symlinkSync(external, link);

    const store = new OutgoingArtifactStore();
    const offer = store.offer(41, root, [note, secret, source, external, link]);
    assert.deepEqual(offer.names, ["report.md"]);
    const buttons = offer.keyboard!.inline_keyboard.flat().flatMap((button) => "callback_data" in button ? [button.callback_data] : []);
    let sent = 0;
    const api = { sendDocument: async (_chatId: number, file: { filename?: string }, _extra: unknown) => { sent++; assert.ok(file); } };
    assert.equal(await store.send(api, 99, buttons[0]!.slice("artifact:".length)), false);
    assert.equal(await store.send(api, 41, buttons[0]!.slice("artifact:".length)), true);
    assert.equal(sent, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
