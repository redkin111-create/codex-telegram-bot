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
import { DEFAULT_NOTIFICATION_PREFERENCES, notificationCompletionEnabled, notificationPreset, notificationShouldBeLoud } from "../src/app/notifications.js";
import { textPrompt } from "../src/app/types.js";
import { SessionRuntime, LiveSessionConflictError } from "../src/bot/session-runtime.js";
import { isAllowedTelegramDocument, isSafeTelegramImageMime, MAX_TELEGRAM_ATTACHMENT_BYTES, removeIncomingAttachment, safeAttachmentFilename, saveIncomingAttachment } from "../src/bot/incoming-files.js";
import { OutgoingArtifactStore } from "../src/bot/outgoing-artifacts.js";
import { itemToUpdates } from "../src/acp/translate.js";
import { commandOutputPaths } from "../src/bot/command-artifacts.js";
import { PermissionService } from "../src/bot/permission-service.js";

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

test("notification loudness keeps quiet approvals and errors silent, with global quiet as a hard override", () => {
  assert.equal(notificationShouldBeLoud("quiet", false, "approval"), false);
  assert.equal(notificationShouldBeLoud("quiet", false, "error"), false);
  assert.equal(notificationShouldBeLoud("quiet", false, "completion"), false);
  assert.equal(notificationShouldBeLoud("quiet", false, "backgroundCompletion"), false);
  assert.equal(notificationShouldBeLoud("attention", false, "approval"), true);
  assert.equal(notificationShouldBeLoud("attention", false, "error"), true);
  assert.equal(notificationShouldBeLoud("attention", false, "completion"), false);
  assert.equal(notificationShouldBeLoud("all", true, "approval"), false);
});

test("quiet permission approval is still visible and explicitly silent", async () => {
  const registry = {
    describeSession: () => ({ chatId: 82, controlled: true, subagent: false, projectName: "проект" }),
    get: () => ({ sessionId: "session" }),
  };
  for (const mode of ["quiet", "attention"] as const) {
    let sent: { text: string; extra: Record<string, unknown> } | undefined;
    const api = { sendMessage: async (_id: number, text: string, extra: Record<string, unknown>) => { sent = { text, extra }; return { message_id: 7 }; } };
    const settings = { get: () => ({ notifications: notificationPreset(mode) }) };
    const service = new PermissionService(api as never, registry as never, settings as never, false);
    const pending = service.handle({
      sessionId: "session", options: [{ optionId: "approve", name: "Approve", kind: "allow_once" }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert(sent, "the approval prompt must be sent");
    assert.equal(sent.extra.disable_notification, mode === "quiet");
    assert(sent.text.includes("Codex запрашивает разрешение") || sent.text.includes("нужно разрешение"));
    service.resolveChoice("1", 0);
    await pending;
  }
});

test("quiet mode keeps blocking errors visible but silent and suppresses completion pings", async () => {
  for (const scenario of ["error", "completion"] as const) {
    const sent: Array<{ text: string; extra: Record<string, unknown> }> = [];
    const api = { sendMessage: async (_id: number, text: string, extra: Record<string, unknown>) => { sent.push({ text, extra }); return { message_id: 1 }; } };
    const acp = Object.assign(new EventEmitter(), {
      prompt: async () => {
        if (scenario === "error") throw new Error("operation blocked");
        return { stopReason: "end_turn" };
      },
      metadataFor: () => undefined,
    }) as unknown as AcpClient;
    const settings = { get: () => ({ reasoning: "medium", notifications: notificationPreset("quiet") }) };
    const cfg = {
      workspace: tmpdir(), dataDir: tmpdir(), quietNotifications: false, notifyOtherSessions: true,
      promptRetryAttempts: 0, autoForkOnError: false, resumeOnStreamError: false,
    } as AppConfig;
    const runtime = new SessionRuntime(api as never, 83, acp, cfg, settings as never, { cwd: tmpdir(), sessionId: `quiet-${scenario}` });
    Object.assign(runtime as unknown as Record<string, unknown>, { rebindPending: false, sessionLive: true, foreground: false });
    try {
      await runtime.submit(textPrompt("задача"));
      for (let i = 0; runtime.isBusy && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      if (scenario === "error") {
        assert.equal(sent.length, 1);
        assert(sent[0]!.text.includes("Не удалось завершить задачу"));
        assert(sent[0]!.text.includes("operation blocked"));
        assert.equal(sent[0]!.extra.disable_notification, true);
      } else {
        assert.equal(sent.length, 0, `quiet mode must not send an extra completion ping: ${JSON.stringify(sent)}`);
      }
    } finally {
      runtime.dispose();
    }
  }
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

test("prompt on a restored Desktop-live session fails as handoff conflict without auto-fork", async () => {
  let loads = 0;
  let newSessions = 0;
  const acp = Object.assign(new EventEmitter(), {
    supportsLoadSession: true,
    loadSession: async () => { loads++; throw new Error("thread already active in another process"); },
    newSession: async () => { newSessions++; return "unexpected"; },
    metadataFor: () => undefined,
  });
  const sessionId = "desktop-live-session";
  const runtime = new SessionRuntime(
    {} as Api, 79, acp as unknown as AcpClient,
    { workspace: tmpdir(), dataDir: tmpdir() } as AppConfig,
    { get: () => ({ reasoning: "medium" }) } as never,
    { cwd: tmpdir(), sessionId },
  );
  try {
    await assert.rejects(runtime.submit(textPrompt("не отправлять в Desktop")), LiveSessionConflictError);
    assert.equal(loads, 1, "live conflicts are not pointlessly retried");
    assert.equal(newSessions, 0);
    assert.equal(runtime.sessionId, sessionId);
  } finally {
    runtime.dispose();
  }
});

test("commandExecution output paths are detected through the runtime and ZIP is offered as a document", async () => {
  for (const [filename, command] of [
    ["report.md", "Set-Content -Path report.md -Value safe"],
    ["archive.zip", "Compress-Archive -Path notes.md -DestinationPath archive.zip"],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), "codex-tg-command-artifact-"));
    const root = join(dir, "workspace");
    mkdirSync(root);
    const sourceDir = join(root, "src");
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, "foo.ts"), "source", "utf8");
    writeFileSync(join(root, "package-lock.json"), "lock data", "utf8");
    const store = new OutgoingArtifactStore();
    const offered: string[] = [];
    let offeredToken: string | undefined;
    let acp!: EventEmitter & { prompt: (id: string, content: unknown) => Promise<{ stopReason: string }> };
    acp = Object.assign(new EventEmitter(), {
      prompt: async (id: string) => {
        acp.emit("session-update", id, {
          sessionUpdate: "command_execution_started", toolCallId: "command",
          rawInput: { command, cwd: root },
        });
        writeFileSync(join(root, filename), "generated output", "utf8");
        for (const update of itemToUpdates({ id: "command", type: "commandExecution", status: "completed", command, cwd: root, exitCode: 0 })) {
          acp.emit("session-update", id, update);
        }
        for (const update of itemToUpdates({ id: "source", type: "fileChange", status: "completed", changes: [{ path: join(sourceDir, "foo.ts"), kind: "update" }] })) {
          acp.emit("session-update", id, update);
        }
        for (const update of itemToUpdates({ id: "lock", type: "fileChange", status: "completed", changes: [{ path: join(root, "package-lock.json"), kind: "add" }] })) {
          acp.emit("session-update", id, update);
        }
        return { stopReason: "end_turn" };
      },
    });
    const settings = { get: () => ({ reasoning: "medium", notifications: DEFAULT_NOTIFICATION_PREFERENCES }) };
    const cfg = {
      workspace: root, dataDir: dir, promptRetryAttempts: 0, autoForkOnError: false,
      resumeOnStreamError: false, notifyOtherSessions: false, quietNotifications: false,
    } as AppConfig;
    const runtime = new SessionRuntime({} as Api, 80, acp as unknown as AcpClient, cfg, settings as never, { cwd: root, sessionId: "command-session" });
    Object.assign(runtime as unknown as Record<string, unknown>, { rebindPending: false, sessionLive: true, foreground: false });
    runtime.onArtifactOffer = (cwd, paths, base) => {
      const result = store.offer(80, cwd, paths, base);
      offered.push(...result.names);
      offeredToken = result.keyboard?.inline_keyboard.flat().flatMap((button) => "callback_data" in button ? [button.callback_data] : [])
        .find((data) => data.startsWith("artifact:"))?.slice("artifact:".length);
      return result;
    };
    try {
      await runtime.submit(textPrompt("создай отчет"));
      for (let i = 0; runtime.isBusy && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.deepEqual(offered, [filename]);
      const buttons = store.offer(80, root, [join(root, filename)]).keyboard!.inline_keyboard.flat();
      assert(buttons.some((button) => "text" in button && button.text === `📎 ${filename}`));
      assert(offeredToken);
      let documents = 0;
      assert.equal(await store.send({ sendDocument: async (_chatId, file) => { documents++; assert.equal(file.filename, filename); } }, 80, offeredToken), true);
      assert.equal(documents, 1, "artifacts, including ZIP, are sent as Telegram documents");
      assert(!(offered as string[]).includes("foo.ts"), "ordinary source edits do not become download artifacts");
      assert(!(offered as string[]).includes("package-lock.json"), "package lock files are not download artifacts");
    } finally {
      runtime.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("command artifacts skip files that existed before the command and parser accepts common output forms", async () => {
  assert.deepEqual(commandOutputPaths("echo report > report.md"), ["report.md"]);
  assert.deepEqual(commandOutputPaths("Out-File report.md"), ["report.md"]);
  assert.deepEqual(commandOutputPaths("New-Item -ItemType File -Path report.md"), ["report.md"]);
  assert.deepEqual(commandOutputPaths("zip -r archive.zip report.md"), ["archive.zip"]);
  assert.deepEqual(commandOutputPaths("tar -czf archive.tar.gz report.md"), ["archive.tar.gz"]);
  const dir = mkdtempSync(join(tmpdir(), "codex-tg-old-command-artifact-"));
  const old = join(dir, "report.md");
  writeFileSync(old, "before", "utf8");
  const acp = Object.assign(new EventEmitter(), {
    prompt: async (id: string) => {
      const command = "Set-Content -Path report.md -Value updated";
      acp.emit("session-update", id, { sessionUpdate: "command_execution_started", rawInput: { command, cwd: dir } });
      writeFileSync(old, "updated", "utf8");
      for (const update of itemToUpdates({ id: "command", type: "commandExecution", status: "completed", command, cwd: dir, exitCode: 0 })) acp.emit("session-update", id, update);
      return { stopReason: "end_turn" };
    },
  });
  const runtime = new SessionRuntime(
    {} as Api, 81, acp as unknown as AcpClient,
    { workspace: dir, dataDir: dir, promptRetryAttempts: 0, notifyOtherSessions: false } as AppConfig,
    { get: () => ({ reasoning: "medium", notifications: DEFAULT_NOTIFICATION_PREFERENCES }) } as never,
    { cwd: dir, sessionId: "existing-file-session" },
  );
  Object.assign(runtime as unknown as Record<string, unknown>, { rebindPending: false, sessionLive: true, foreground: false });
  let paths: string[] = [];
  runtime.onArtifactOffer = (_cwd, candidates) => { paths = candidates; return { names: [] }; };
  try {
    await runtime.submit(textPrompt("измени отчет"));
    for (let i = 0; runtime.isBusy && i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert(!paths.includes(old));
  } finally {
    runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
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
    const packageLock = join(root, "package-lock.json");
    const secretPrefix = join(root, "secret-notes.md");
    const tokenPrefix = join(root, "tokenfile.txt");
    const credentialPrefix = join(root, "credential_backup.pdf");
    const passwordPrefix = join(root, "passwords.txt");
    const privateKey = join(root, "id_rsa.pub");
    const external = join(outside, "private.pdf");
    writeFileSync(note, "safe report");
    writeFileSync(secret, "sensitive");
    writeFileSync(source, "source");
    writeFileSync(packageLock, "lock");
    writeFileSync(secretPrefix, "sensitive");
    writeFileSync(tokenPrefix, "sensitive");
    writeFileSync(credentialPrefix, "sensitive");
    writeFileSync(passwordPrefix, "sensitive");
    writeFileSync(privateKey, "sensitive");
    writeFileSync(external, "outside");
    const link = join(root, "alias.md");
    symlinkSync(external, link);

    const store = new OutgoingArtifactStore();
    const offer = store.offer(41, root, [note, secret, source, packageLock, secretPrefix, tokenPrefix, credentialPrefix, passwordPrefix, privateKey, external, link]);
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
