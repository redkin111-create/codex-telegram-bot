/**
 * Crash-safe, per-chat follow-up queues. Each mutation reloads the file so
 * separate SessionRuntime instances cannot overwrite another session's queue.
 * Only local files under DATA_DIR are used; never put queued prompts in Git.
 *
 * A turn removed from the pending queue remains stored as `inFlight` until it
 * finishes. An interrupted turn is restored in PAUSED state, never auto-run:
 * repeating a half-finished coding task without review can duplicate edits.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { QueuedPrompt } from "./session-runtime.js";

export interface DurableQueue {
  items: QueuedPrompt[];
  inFlight?: QueuedPrompt;
  paused: boolean;
}

type QueueFile = Record<string, DurableQueue>;

function validPrompt(value: unknown): value is QueuedPrompt {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  const input = obj.input as Record<string, unknown> | undefined;
  return typeof obj.id === "string" && obj.id.length > 0
    && !!input && typeof input.text === "string" && Array.isArray(input.images);
}

export class DurableQueueStore {
  private readonly path: string;

  constructor(dataDir: string, chatId: number) {
    if (!Number.isSafeInteger(chatId)) throw new Error("Invalid chat id");
    this.path = join(dataDir, "queues", `${chatId}.json`);
  }

  load(sessionId: string): DurableQueue {
    const raw = this.read()[sessionId];
    if (!raw) return { items: [], paused: false };
    if (!Array.isArray(raw.items) || !raw.items.every(validPrompt)
      || (raw.inFlight !== undefined && !validPrompt(raw.inFlight))
      || typeof raw.paused !== "boolean") {
      throw new Error("Invalid persisted queue state");
    }
    return structuredClone(raw);
  }

  save(sessionId: string, state: DurableQueue): void {
    const data = this.read();
    if (state.items.length || state.inFlight) {
      data[sessionId] = structuredClone(state);
    } else {
      delete data[sessionId];
    }
    this.write(data);
  }

  move(previousId: string, nextId: string): void {
    if (previousId === nextId) return;
    const data = this.read();
    const previous = data[previousId];
    if (!previous) return;
    if (data[nextId]) throw new Error("Target session already has a saved queue");
    data[nextId] = previous;
    delete data[previousId];
    this.write(data);
  }

  private read(): QueueFile {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Invalid queue file");
    }
    return data as QueueFile;
  }

  private write(data: QueueFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tempPath = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(tempPath, JSON.stringify(data), { mode: 0o600 });
      renameSync(tempPath, this.path);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }
}
