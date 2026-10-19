import { asLiveEvent } from "./live-event.js";
import type { MobileLiveEvent } from "../types.js";
import { parseSseBlock, type ParsedSseMessage } from "./sse.js";

const MAX_PENDING_SSE_CHARS = 128 * 1024;
const MAX_BUFFERED_EVENTS = 160;

export class MobileEventBuffer {
  private epoch = "";
  private after = 0;
  private buffered: MobileLiveEvent[] = [];

  constructor(private sessionId: string) {}

  get requestCursor(): { after: number; epoch: string } {
    return { after: this.after, epoch: this.epoch };
  }

  get events(): MobileLiveEvent[] {
    return [...this.buffered];
  }

  setSession(sessionId: string): boolean {
    if (this.sessionId === sessionId) return false;
    this.sessionId = sessionId;
    this.epoch = "";
    this.after = 0;
    this.buffered = [];
    return true;
  }

  accept(message: ParsedSseMessage): { event?: MobileLiveEvent; epochChanged?: boolean; revoked?: boolean } {
    if (message.event === "hello") {
      let epoch = "";
      try {
        const payload = JSON.parse(message.data) as { epoch?: unknown };
        if (typeof payload.epoch === "string" && /^[a-f0-9]{24}$/.test(payload.epoch)) epoch = payload.epoch;
      } catch { /* Ignore an invalid handshake and let the authenticated stream reconnect. */ }
      if (!epoch) return {};
      const changed = Boolean(this.epoch && this.epoch !== epoch);
      this.epoch = epoch;
      if (changed) {
        this.after = 0;
        this.buffered = [];
      }
      return { epochChanged: changed };
    }
    if (message.event === "revoked") return { revoked: true };
    if (message.event !== "message") return {};

    const event = asLiveEvent(message);
    const id = message.id ?? event?.id;
    if (id === undefined || !Number.isSafeInteger(id) || id < 0) return {};
    const duplicate = id <= this.after;
    if (!duplicate) this.after = id;
    if (!event || event.sessionId !== this.sessionId || duplicate || (message.id !== undefined && message.id !== event.id)) return {};
    this.buffered.push(event);
    if (this.buffered.length > MAX_BUFFERED_EVENTS) this.buffered.splice(0, this.buffered.length - MAX_BUFFERED_EVENTS);
    return { event };
  }
}

export async function consumeMobileEventStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: MobileEventBuffer,
  handlers: {
    onEvent: (event: MobileLiveEvent) => void;
    onEpochChanged?: () => void;
  },
  signal?: AbortSignal,
): Promise<"closed" | "revoked"> {
  const decoder = new TextDecoder();
  let pending = "";
  const dispatch = (block: string): boolean => {
    const message = parseSseBlock(block);
    if (!message) return false;
    const result = buffer.accept(message);
    if (result.epochChanged) handlers.onEpochChanged?.();
    if (result.event) handlers.onEvent(result.event);
    return result.revoked === true;
  };

  while (!signal?.aborted) {
    const chunk = await reader.read();
    if (chunk.done) {
      pending += decoder.decode();
      if (pending.trim()) dispatch(pending);
      return "closed";
    }
    pending += decoder.decode(chunk.value, { stream: true });
    while (true) {
      const separator = /\r?\n\r?\n/.exec(pending);
      if (!separator) break;
      const block = pending.slice(0, separator.index);
      pending = pending.slice(separator.index + separator[0].length);
      if (dispatch(block)) return "revoked";
    }
    if (pending.length > MAX_PENDING_SSE_CHARS) throw new Error("Слишком большое событие Codex");
  }
  return "closed";
}
