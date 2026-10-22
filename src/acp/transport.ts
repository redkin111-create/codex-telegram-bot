/**
 * Newline-delimited JSON-RPC framing over a child process's stdio.
 * Parses incoming lines and emits typed messages; writes outgoing messages.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { JsonRpcMessage } from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("acp:transport");
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

function isMessage(value: unknown): value is JsonRpcMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.id !== undefined && typeof message.id !== "string" &&
    !(typeof message.id === "number" && Number.isFinite(message.id))) return false;
  if (message.method !== undefined) return typeof message.method === "string" && message.method.length > 0;
  if (message.id === undefined || ("result" in message) === ("error" in message)) return false;
  if ("result" in message) return true;
  const error = message.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const details = error as Record<string, unknown>;
  return typeof details.code === "number" && Number.isFinite(details.code) && typeof details.message === "string";
}

export class JsonRpcTransport extends EventEmitter {
  private buffer = "";
  private bufferBytes = 0;
  private stopped = false;

  constructor(private readonly proc: ChildProcessWithoutNullStreams, private readonly maxFrameBytes = MAX_FRAME_BYTES) {
    super();
    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => {
      const msg = chunk.trim();
      if (msg) log.debug("[codex stderr]", msg.slice(0, 500));
    });
  }

  private onData(chunk: string): void {
    if (this.stopped) return;
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf("\n", start);
      const fragment = chunk.slice(start, end < 0 ? undefined : end);
      this.bufferBytes += Buffer.byteLength(fragment, "utf8");
      if (this.bufferBytes > this.maxFrameBytes) {
        this.stopped = true;
        this.buffer = "";
        this.bufferBytes = 0;
        log.error(`Codex JSON-RPC frame exceeded ${this.maxFrameBytes} bytes; restarting the process`);
        this.proc.kill(); // The client's exit handler fails pending requests and reconnects.
        return;
      }
      this.buffer += fragment;
      if (end < 0) return;
      start = end + 1;
      const line = this.buffer.trim();
      this.buffer = "";
      this.bufferBytes = 0;
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        log.debug("non-JSON line ignored:", line.slice(0, 200));
        continue;
      }
      if (!isMessage(parsed)) {
        log.debug("invalid JSON-RPC envelope ignored");
        continue;
      }
      this.emit("message", parsed);
    }
  }

  send(msg: object): void {
    if (this.stopped || !this.proc.stdin.writable) {
      throw new Error("ACP process stdin is not writable");
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }
}
