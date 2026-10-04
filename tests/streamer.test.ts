import assert from "node:assert/strict";
import test from "node:test";
import type { Api } from "grammy";
import { ResponseStreamer } from "../src/stream/streamer.js";

test("reasoning summary and final answer are sent as separate Telegram messages", async () => {
  const sent: Array<{ text: string; extra: Record<string, unknown> }> = [];
  const api = {
    sendMessage: async (_chatId: number, text: string, extra: Record<string, unknown>) => {
      sent.push({ text, extra });
      return { message_id: sent.length };
    },
  } as unknown as Api;
  const streamer = new ResponseStreamer(api, 55, 60_000, 77);

  streamer.appendReasoningSummary("Сначала изучил задачу.");
  streamer.appendOutput("Готовый ответ.");
  await streamer.finalize();

  assert.equal(sent.length, 2);
  assert.match(sent[0]!.text, /Ход работы/);
  assert.match(sent[0]!.text, /Сначала изучил задачу/);
  assert.doesNotMatch(sent[0]!.text, /Готовый ответ/);
  assert.match(sent[1]!.text, /Готовый ответ/);
  assert.doesNotMatch(sent[1]!.text, /Сначала изучил задачу/);
  for (const message of sent) {
    assert.deepEqual(message.extra.reply_parameters, {
      message_id: 77,
      allow_sending_without_reply: true,
    });
  }
});
