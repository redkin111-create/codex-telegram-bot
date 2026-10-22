import assert from "node:assert/strict";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";

const threadId = "voice-session-12345678";
const offer = "v=0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
const answer = "v=0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";

test("AcpClient returns only allowlisted realtime voice IDs and passes a selected voice to Codex", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: process.cwd(), trustAllTools: false });
  const calls: Array<{ method: string; params: unknown }> = [];
  Object.assign(client, {
    async request(method: string, params: unknown) {
      calls.push({ method, params });
      if (method === "thread/realtime/listVoices") return { voices: {
        v1: ["cove", "unsafe voice", "<script>"], v2: ["marin", 42], v3: ["cedar"],
        defaultV1: "cove", defaultV2: "marin",
      } };
      if (method === "thread/realtime/start") client.emit("notification", "thread/realtime/sdp", { threadId, sdp: answer });
      return {};
    },
  });
  const api = client as unknown as {
    listRealtimeVoices(): Promise<{ voices: string[]; defaultVoice: string }>;
    startRealtime(id: string, sdp: string, voice?: string): Promise<string>;
  };
  assert.deepEqual(await api.listRealtimeVoices(), { voices: ["cove", "marin", "cedar"], defaultVoice: "marin" });
  assert.equal(await api.startRealtime(threadId, offer, "cedar"), answer);
  assert.deepEqual(calls, [
    { method: "thread/realtime/listVoices", params: {} },
    { method: "thread/realtime/start", params: { threadId, outputModality: "audio", transport: { type: "webrtc", sdp: offer }, voice: "cedar" } },
  ]);
});

test("AcpClient rejects unsafe selected realtime voice IDs", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: process.cwd(), trustAllTools: false });
  let calls = 0;
  Object.assign(client, { async request() { calls++; return {}; } });
  const api = client as unknown as { startRealtime(id: string, sdp: string, voice?: string): Promise<string> };
  await assert.rejects(api.startRealtime(threadId, offer, "<script>"), /голос/i);
  assert.equal(calls, 0);
});

test("AcpClient starts WebRTC voice through Codex, waits for matching SDP and stops the same thread", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: process.cwd(), trustAllTools: false });
  const calls: Array<{ method: string; params: unknown }> = [];
  Object.assign(client, {
    async request(method: string, params: unknown) {
      calls.push({ method, params });
      if (method === "thread/realtime/start") {
        client.emit("notification", "thread/realtime/sdp", { threadId: "another-thread-12345678", sdp: "wrong" });
        client.emit("notification", "thread/realtime/sdp", { threadId, sdp: answer });
      }
      return {};
    },
  });

  const api = client as unknown as {
    startRealtime(id: string, sdp: string): Promise<string>;
    stopRealtime(id: string): Promise<void>;
    isRealtimeActive(id: string): boolean;
  };
  assert.equal(await api.startRealtime(threadId, offer), answer);
  assert.equal(api.isRealtimeActive(threadId), true);
  await api.stopRealtime(threadId);
  assert.equal(api.isRealtimeActive(threadId), false);
  assert.deepEqual(calls, [
    { method: "thread/realtime/start", params: { threadId, outputModality: "audio", transport: { type: "webrtc", sdp: offer } } },
    { method: "thread/realtime/stop", params: { threadId } },
  ]);
});

test("AcpClient rejects a realtime SDP failure without exposing Codex error details", async () => {
  const client = new AcpClient({ codexCliPath: "codex", workspace: process.cwd(), trustAllTools: false });
  Object.assign(client, {
    async request(method: string) {
      if (method === "thread/realtime/start") {
        client.emit("notification", "thread/realtime/error", { threadId, message: "provider-secret" });
      }
      return {};
    },
  });
  const api = client as unknown as { startRealtime(id: string, sdp: string): Promise<string>; isRealtimeActive(id: string): boolean };
  await assert.rejects(api.startRealtime(threadId, offer), (error: unknown) =>
    error instanceof Error && /голосовой сеанс/i.test(error.message) && !error.message.includes("provider-secret"));
  assert.equal(api.isRealtimeActive(threadId), false);
});
