/** Best-effort origin metadata for sessions started by this Telegram bridge. */
import { join } from "node:path";
import { JsonStore } from "../app/json-store.js";

export interface TelegramSessionRecord {
  createdBy: "telegram";
  createdAt: string;
  chatId: number;
  projectPath: string;
  projectName: string;
}

export interface MobileSessionRecord extends Omit<TelegramSessionRecord, "createdBy"> {
  createdBy: "mobile";
}

export type SessionOwnerRecord = TelegramSessionRecord | MobileSessionRecord;

export class TelegramSessionRegistry {
  private readonly store: JsonStore<Record<string, SessionOwnerRecord>>;

  constructor(dataDir: string) {
    this.store = new JsonStore(join(dataDir, "telegram-sessions.json"), {});
  }

  get(sessionId: string): TelegramSessionRecord | undefined {
    const owner = this.getOwner(sessionId);
    return owner?.createdBy === "telegram" ? owner : undefined;
  }

  getOwner(sessionId: string): SessionOwnerRecord | undefined {
    const value = this.records()[sessionId] as unknown;
    if (!value || typeof value !== "object") return undefined;
    const entry = value as Partial<SessionOwnerRecord>;
    return (entry.createdBy === "telegram" || entry.createdBy === "mobile") && typeof entry.createdAt === "string"
      && typeof entry.chatId === "number" && typeof entry.projectPath === "string"
      && typeof entry.projectName === "string" ? entry as SessionOwnerRecord : undefined;
  }

  listForChat(chatId: number): Array<{ sessionId: string; record: TelegramSessionRecord }> {
    return Object.entries(this.records()).flatMap(([sessionId, raw]) => {
      const record = this.get(sessionId);
      return record && record.chatId === chatId ? [{ sessionId, record }] : [];
    });
  }

  listAll(): Array<{ sessionId: string; record: TelegramSessionRecord }> {
    return Object.keys(this.records()).flatMap((sessionId) => {
      const record = this.get(sessionId);
      return record ? [{ sessionId, record }] : [];
    });
  }

  record(sessionId: string, chatId: number, projectPath: string, projectName: string): void {
    if (!/^[a-z0-9_-]{1,128}$/i.test(sessionId)) return;
    const entry: TelegramSessionRecord = {
      createdBy: "telegram",
      createdAt: new Date().toISOString(),
      chatId,
      projectPath,
      projectName,
    };
    this.store.set({ ...this.records(), [sessionId]: entry });
  }

  recordMobile(sessionId: string, ownerId: number, projectPath: string, projectName: string): void {
    if (!/^[a-z0-9_-]{1,128}$/i.test(sessionId)) return;
    const entry: MobileSessionRecord = {
      createdBy: "mobile",
      createdAt: new Date().toISOString(),
      chatId: ownerId,
      projectPath,
      projectName,
    };
    this.store.set({ ...this.records(), [sessionId]: entry });
  }

  /** Remove only entries whose Codex thread no longer exists. */
  prune(isExistingSession: (sessionId: string) => boolean): number {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const stale = Object.entries(this.records())
      .filter(([id, entry]) => {
        const created = Date.parse(entry?.createdAt ?? "");
        return (!Number.isFinite(created) || created < cutoff) && !isExistingSession(id);
      })
      .map(([id]) => id);
    if (stale.length) {
      const records = { ...this.records() };
      for (const id of stale) delete records[id];
      this.store.set(records);
    }
    return stale.length;
  }

  private records(): Record<string, SessionOwnerRecord> {
    const value: unknown = this.store.get();
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, SessionOwnerRecord>
      : {};
  }
}
