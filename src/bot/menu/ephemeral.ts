/**
 * Ephemeral message tracker — keeps the chat history clean.
 *
 * Navigation surfaces (the inline menu, session/project cards, pickers, status
 * snapshots, submenus) are *transient*: they're tracked per chat and removed
 * when a new surface opens or an action resolves. Persistent messages
 * (🔀 Switched / ✨ New session boundary markers, agent output, Done summaries,
 * the pinned status panel) are simply never tracked, so they survive clear().
 *
 * Tracked ids are persisted to disk so a restart (manual, crash, or
 * auto-update) doesn't orphan the last surface — it's cleaned on startup and by
 * the next surface that opens.
 */
import { join } from "node:path";
import { type Api, type Context, GrammyError } from "grammy";
import { JsonStore } from "../../app/json-store.js";

type TrackMap = Record<string, number[]>;

export class Ephemeral {
  private readonly store: JsonStore<TrackMap>;
  /** Per-chat promise chain so open/clear/reply never interleave for one chat
   *  (e.g. startup cleanupAll racing the first surface the user opens). */
  private readonly locks = new Map<number, Promise<unknown>>();

  constructor(
    private readonly api: Api,
    dataDir: string,
  ) {
    this.store = new JsonStore<TrackMap>(join(dataDir, "ephemeral.json"), {});
  }

  /** Run `fn` after any in-flight ephemeral op for this chat completes. */
  private serialize<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(chatId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(chatId, run.then(noop, noop));
    return run;
  }

  /** Track a bot message id for later cleanup. */
  remember(chatId: number, messageId: number | undefined): void {
    if (!messageId) return;
    this.store.update((m) => {
      const k = String(chatId);
      const ids = (m[k] ??= []);
      if (!ids.includes(messageId)) ids.push(messageId);
    });
  }

  /** Delete every tracked transient message for a chat (best-effort). */
  async clear(chatId: number | undefined): Promise<void> {
    if (chatId === undefined) return;
    await this.serialize(chatId, () => this.doClear(chatId));
  }

  private async doClear(chatId: number, preserveMessageId?: number): Promise<void> {
    const k = String(chatId);
    const ids = (this.store.get()[k] ?? []).slice();
    if (ids.length === 0) return;
    // A Telegram rejection (message gone / too old / not found) is final, so we
    // forget that id. A transient/network failure is KEPT for the next sweep so
    // a tracked card never becomes a permanent "ghost" (the duplicate-cards bug).
    const keep: number[] = preserveMessageId === undefined ? [] : ids.filter((id) => id === preserveMessageId);
    await Promise.all(
      ids.filter((id) => id !== preserveMessageId).map(async (id) => {
        try {
          await this.api.deleteMessage(chatId, id);
        } catch (err) {
          if (!(err instanceof GrammyError)) keep.push(id);
        }
      }),
    );
    this.store.update((m) => {
      if (keep.length > 0) m[k] = keep;
      else delete m[k];
    });
  }

  /** On startup, delete any surface left over from before a restart. */
  async cleanupAll(): Promise<void> {
    for (const k of Object.keys(this.store.get())) {
      await this.clear(Number(k));
    }
  }

  /**
   * Open a fresh navigation surface: clear whatever transient surface was up.
   * Call at the start of every menu/card/picker handler.
   */
  async open(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const preserveMessageId = ctx.callbackQuery?.message?.message_id;
    await this.serialize(chatId, () => this.doClear(chatId, preserveMessageId));
  }

  /** Send a transient reply (tracked) — use for menus / cards / pickers. */
  async reply(ctx: Context, text: string, extra: Record<string, unknown> = {}): Promise<number | undefined> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return undefined;
    return this.serialize(chatId, async () => {
      const currentMessageId = ctx.callbackQuery?.message?.message_id;
      if (currentMessageId !== undefined) {
        try {
          await ctx.editMessageText(text, extra as never);
          this.remember(chatId, currentMessageId);
          return currentMessageId;
        } catch (err) {
          if (isNotModified(err)) {
            this.remember(chatId, currentMessageId);
            return currentMessageId;
          }
          if (!isUneditable(err)) return undefined;
        }
      }
      try {
        const msg = await ctx.reply(text, extra);
        this.remember(chatId, msg.message_id);
        return msg.message_id;
      } catch {
        return undefined;
      }
    });
  }

  /** Edit the current navigation message after an input-only step such as search. */
  async editLatest(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<number | undefined> {
    return this.serialize(chatId, async () => {
      const k = String(chatId);
      const ids = (this.store.get()[k] ?? []).slice();
      const latest = ids.at(-1);
      if (latest !== undefined) {
        try {
          await this.api.editMessageText(chatId, latest, text, extra as never);
          return latest;
        } catch (err) {
          if (isNotModified(err)) return latest;
          if (!isUneditable(err)) return undefined;
          this.store.update((m) => {
            m[k] = (m[k] ?? []).filter((id) => id !== latest);
            if (m[k]!.length === 0) delete m[k];
          });
        }
      }
      try {
        const msg = await this.api.sendMessage(chatId, text, extra as never);
        this.remember(chatId, msg.message_id);
        return msg.message_id;
      } catch {
        return undefined;
      }
    });
  }

  /** Delete just one tracked message (e.g. closing a single card). */
  async drop(ctx: Context): Promise<void> {
    await ctx.deleteMessage().catch(() => {});
  }
}

function isNotModified(err: unknown): boolean {
  return err instanceof GrammyError && /message is not modified/i.test(err.description);
}

function isUneditable(err: unknown): boolean {
  return err instanceof GrammyError && /message to edit not found|message can't be edited|message_id_invalid|message to be edited/i.test(err.description);
}

function noop(): void {
  /* swallow chain errors so serialize() keeps flowing */
}
