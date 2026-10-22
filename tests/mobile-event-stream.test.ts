import assert from "node:assert/strict";
import test from "node:test";
import { MobileEventBuffer, consumeMobileEventStream } from "../apps/codex-mobile/src/lib/event-stream.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const firstEpoch = "a".repeat(24);
const nextEpoch = "b".repeat(24);

function reader(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }).getReader();
}

test("mobile event stream parses fragmented frames, heartbeats and safe events", async () => {
  const state = new MobileEventBuffer(sessionId);
  const live = JSON.stringify({ id: 4, sessionId, kind: "tool", label: "Codex ищет файлы", at: 100 });
  const received: number[] = [];

  await consumeMobileEventStream(reader([
    `: connected\r\n\r\nevent: hello\r\ndata: ${JSON.stringify({ epoch: firstEpoch })}\r`,
    `\n\r\nid: 4\ndata: ${live}\n\n: heartbeat\n\n`,
  ]), state, { onEvent: (event) => received.push(event.id) });

  assert.deepEqual(received, [4]);
  assert.equal(state.requestCursor.epoch, firstEpoch);
  assert.equal(state.requestCursor.after, 4);
  assert.equal(state.events[0]?.label, "Codex ищет файлы");
});

test("mobile event cursor clears replayed events after the Codex runtime epoch changes", async () => {
  const state = new MobileEventBuffer(sessionId);
  const oldEvent = JSON.stringify({ id: 32, sessionId, kind: "tool", label: "Старое событие", at: 100 });
  await consumeMobileEventStream(reader([
    `event: hello\ndata: ${JSON.stringify({ epoch: firstEpoch })}\n\nid: 32\ndata: ${oldEvent}\n\n`,
  ]), state, { onEvent: () => undefined });

  assert.equal(state.requestCursor.after, 32);
  let cleared = false;
  const newEvent = JSON.stringify({ id: 2, sessionId, kind: "status", status: "working", label: "Codex выполняет задание", at: 101 });
  await consumeMobileEventStream(reader([
    `event: hello\ndata: ${JSON.stringify({ epoch: nextEpoch })}\n\nid: 2\ndata: ${newEvent}\n\n`,
  ]), state, { onEvent: () => undefined, onEpochChanged: () => { cleared = true; } });

  assert.equal(cleared, true);
  assert.equal(state.requestCursor.epoch, nextEpoch);
  assert.equal(state.requestCursor.after, 2);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0]?.status, "working");
});

test("mobile event stream ignores duplicate and foreign-session events and recognizes revocation", async () => {
  const state = new MobileEventBuffer(sessionId);
  const event = JSON.stringify({ id: 7, sessionId, kind: "activity", label: "Вход в MCP-сервер выполнен", at: 100 });
  await consumeMobileEventStream(reader([
    `event: hello\ndata: ${JSON.stringify({ epoch: firstEpoch })}\n\nid: 7\ndata: ${event}\n\nid: 7\ndata: ${event}\n\n`,
    `id: 8\ndata: ${JSON.stringify({ id: 8, sessionId: "22222222-2222-4222-8222-222222222222", kind: "tool", label: "Чужое событие", at: 101 })}\n\n`,
  ]), state, { onEvent: () => undefined });

  assert.equal(state.events.length, 1);
  assert.equal(state.requestCursor.after, 8);
  assert.equal(await consumeMobileEventStream(reader(["event: revoked\ndata: {}\n\n"]), state, { onEvent: () => undefined }), "revoked");
});

test("mobile event stream requests a full state sync when the server buffer reports a gap", async () => {
  const state = new MobileEventBuffer(sessionId);
  const oldEvent = JSON.stringify({ id: 7, sessionId, kind: "tool", label: "Old event", at: 100 });
  await consumeMobileEventStream(reader([`event: hello\ndata: ${JSON.stringify({ epoch: firstEpoch })}\n\nid: 7\ndata: ${oldEvent}\n\n`]), state, { onEvent: () => undefined });

  let syncRequested = false;
  const nextEvent = JSON.stringify({ id: 12, sessionId, kind: "status", status: "working", label: "Codex выполняет задание", at: 101 });
  await consumeMobileEventStream(reader([`id: 10\nevent: sync_required\ndata: {}\n\nid: 12\ndata: ${nextEvent}\n\n`]), state, {
    onEvent: () => undefined,
    onSyncRequired: () => { syncRequested = true; },
  });

  assert.equal(syncRequested, true);
  assert.equal(state.requestCursor.after, 12);
  assert.deepEqual(state.events.map((event) => event.id), [12]);
});
