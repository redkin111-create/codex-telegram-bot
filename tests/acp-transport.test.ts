import assert from "node:assert/strict";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { JsonRpcTransport } from "../src/acp/transport.js";

function setup(limit?: number) {
  const stdout = new PassThrough();
  let killed = false;
  const proc = { stdout, stderr: new PassThrough(), stdin: new PassThrough(), kill: () => { killed = true; return true; } };
  const transport = new JsonRpcTransport(proc as unknown as ChildProcessWithoutNullStreams, limit);
  const messages: unknown[] = [];
  transport.on("message", (message) => messages.push(message));
  return { stdout, messages, killed: () => killed };
}

test("transport ignores invalid envelopes and continues with valid Codex messages", () => {
  const io = setup();
  io.stdout.write('null\n[]\n42\n{"method":3}\n{"id":{},"result":1}\n{"method":"thread/started","params":{}}\n{"id":0,"result":null}\n');
  assert.deepEqual(io.messages, [{ method: "thread/started", params: {} }, { id: 0, result: null }]);
});

test("transport never forwards malformed error responses as successful results", () => {
  const io = setup();
  io.stdout.write('{"id":1,"error":null}\n{"id":1,"error":{}}\n{"id":1,"error":{"code":"bad","message":"failure"}}\n{"id":1,"result":true,"error":{"code":-1,"message":"failure"}}\n');
  assert.deepEqual(io.messages, []);
  io.stdout.write('{"id":1,"error":{"code":-32603,"message":"failure"}}\n');
  assert.deepEqual(io.messages, [{ id: 1, error: { code: -32603, message: "failure" } }]);
});

test("transport stops an oversized incomplete frame before accepting more data", () => {
  const io = setup(64);
  io.stdout.write("x".repeat(40));
  io.stdout.write("x".repeat(25));
  assert.equal(io.killed(), true);
  io.stdout.write('\n{"id":1,"result":true}\n');
  assert.deepEqual(io.messages, []);
});

test("transport bounds individual UTF-8 frames rather than the whole stream chunk", () => {
  const io = setup(64);
  const message = { method: "ping", params: "я" };
  const line = JSON.stringify(message) + "\n";
  io.stdout.write(line.slice(0, 10));
  io.stdout.write(line.slice(10) + line.repeat(10));
  assert.equal(io.killed(), false);
  assert.deepEqual(io.messages, Array(11).fill(message));
  io.stdout.write('"' + "я".repeat(32) + '"\n');
  assert.equal(io.killed(), true);
});
