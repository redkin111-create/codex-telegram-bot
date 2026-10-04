import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Api } from "grammy";
import { extractImagePaths, sendImages } from "../src/bot/image-return.js";

test("image paths in quotes can contain spaces", () => {
  assert.deepEqual(
    extractImagePaths('Создал скрин "C:\\Screenshots\\Agent shot 1.png".', process.cwd()),
    ["C:\\Screenshots\\Agent shot 1.png"],
  );
});

test("unquoted absolute image paths with spaces are captured intact", () => {
  const path = resolve(tmpdir(), "Agent Screenshots", "screen 1.png");
  assert.deepEqual(extractImagePaths(`Saved screenshot to ${path}.`, process.cwd()), [path]);
});

test("fresh agent images are sent as replies to the original Telegram prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-telegram-image-"));
  try {
    const path = join(dir, "screen.png");
    writeFileSync(path, Buffer.from([1, 2, 3]));
    let sent: { chatId: number; extra: Record<string, unknown> } | undefined;
    const api = {
      sendPhoto: async (chatId: number, _photo: unknown, extra: Record<string, unknown>) => {
        sent = { chatId, extra };
        return { message_id: 9 };
      },
    } as unknown as Api;

    const count = await sendImages(api, 55, [path], {
      since: Date.now() - 10_000,
      already: new Set(),
      max: 8,
      replyTo: 77,
    });

    assert.equal(count, 1);
    assert.equal(sent?.chatId, 55);
    assert.deepEqual(sent?.extra.reply_parameters, {
      message_id: 77,
      allow_sending_without_reply: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
