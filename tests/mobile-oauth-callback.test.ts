import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  isLoopbackListenerOwnedByProcess,
  mcpOAuthCallbackTarget,
  processOwnsLoopbackTcpListener,
  processOwnsLoopbackSsListener,
  processOwnsLoopbackLsofListener,
  validateMcpOAuthCallback,
} from "../src/mobile/oauth-callback.js";

test("MCP OAuth callback target recognizes only HTTPS PAR requests when redirect_uri is hidden", () => {
  const target = mcpOAuthCallbackTarget({
    authorizationUrl: "https://provider.example/authorize?client_id=codex&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Aabc&state=expected",
  });
  assert.deepEqual(target, { type: "codex-loopback", state: "expected" });
  assert.equal(mcpOAuthCallbackTarget({ authorizationUrl: "https://provider.example/authorize?request_uri=x" })?.type, "codex-loopback");
  assert.equal(mcpOAuthCallbackTarget({ authorizationUrl: "http://provider.example/authorize?request_uri=x" }), undefined);
  assert.equal(mcpOAuthCallbackTarget({ authorizationUrl: "https://provider.example/authorize?request_uri=x&request_uri=y" }), undefined);
  assert.equal(mcpOAuthCallbackTarget({ authorizationUrl: "https://provider.example/authorize?state=a&state=b&request_uri=x" }), undefined);
  assert.equal(mcpOAuthCallbackTarget({ authorizationUrl: "https://provider.example/authorize?client_id=codex" }), undefined);
});

test("PAR callback accepts only a bounded HTTP loopback Codex callback with a valid state", () => {
  const target = { type: "codex-loopback" as const, state: "expected" };
  const valid = validateMcpOAuthCallback("http://127.0.0.1:43123/callback/id_1?code=secret&state=expected", target);
  assert.equal(valid?.hostname, "127.0.0.1");
  for (const value of [
    "http://127.0.0.1:43123/callback/id_1?code=secret&state=wrong",
    "http://192.168.1.4:43123/callback/id_1?code=secret&state=expected",
    "http://127.0.0.1:43123/other?code=secret&state=expected",
    "http://127.0.0.1:43123/callback/id_1?code=secret&state=expected&extra=x",
    "http://127.0.0.1:43123/callback/id_1?code=secret&code=again&state=expected",
    "http://127.0.0.1:43123/callback/id_1?error=denied&state=expected#fragment",
  ]) assert.equal(validateMcpOAuthCallback(value, target), undefined, value);
});

test("Windows netstat listener check requires exact loopback address, port and Codex PID", () => {
  const output = [
    "  TCP    127.0.0.1:43123       0.0.0.0:0              LISTENING       7124",
    "  TCP    0.0.0.0:43123         0.0.0.0:0              LISTENING       7124",
    "  TCP    127.0.0.1:43125       0.0.0.0:0              LISTENING       7125",
    "  TCP    [::1]:43124           [::]:0                 LISTENING       7124",
  ].join("\n");
  assert.equal(processOwnsLoopbackTcpListener(output, 7124, "127.0.0.1", 43123), true);
  assert.equal(processOwnsLoopbackTcpListener(output, 7124, "0.0.0.0", 43123), false);
  assert.equal(processOwnsLoopbackTcpListener(output, 7125, "127.0.0.1", 43123), false);
  assert.equal(processOwnsLoopbackTcpListener(output, 7124, "::1", 43124), true);
});

test("ss listener check requires the Codex PID on a loopback TCP socket", () => {
  const output = [
    'LISTEN 0 128 127.0.0.1:43123 0.0.0.0:* users:(("codex",pid=7124,fd=11))',
    'LISTEN 0 128 0.0.0.0:43123 0.0.0.0:* users:(("codex",pid=7124,fd=12))',
    'LISTEN 0 128 127.0.0.1:43124 0.0.0.0:* users:(("other",pid=7125,fd=13))',
  ].join("\n");
  assert.equal(processOwnsLoopbackSsListener(output, 7124, "127.0.0.1", 43123), true);
  assert.equal(processOwnsLoopbackSsListener(output, 7124, "0.0.0.0", 43123), false);
  assert.equal(processOwnsLoopbackSsListener(output, 7124, "127.0.0.1", 43124), false);
});

test("lsof listener check matches only the target process and loopback socket", () => {
  const output = [
    "COMMAND  PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    "codex   7124 user   11u  IPv4  12345      0t0  TCP 127.0.0.1:43123 (LISTEN)",
    "codex   7124 user   12u  IPv4  12346      0t0  TCP *:43123 (LISTEN)",
    "other   7125 user   13u  IPv4  12347      0t0  TCP 127.0.0.1:43125 (LISTEN)",
  ].join("\n");
  assert.equal(processOwnsLoopbackLsofListener(output, 7124, "127.0.0.1", 43123), true);
  assert.equal(processOwnsLoopbackLsofListener(output, 7124, "0.0.0.0", 43123), false);
  assert.equal(processOwnsLoopbackLsofListener(output, 7125, "127.0.0.1", 43123), false);
});

test("Windows confirms a real loopback socket owned by the current process", { skip: process.platform !== "win32" }, async () => {
  const server = createServer((_req, res) => res.end("ok"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    assert.equal(await isLoopbackListenerOwnedByProcess(process.pid, "127.0.0.1", address.port), true);
    assert.equal(await isLoopbackListenerOwnedByProcess(process.pid + 1, "127.0.0.1", address.port), false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
