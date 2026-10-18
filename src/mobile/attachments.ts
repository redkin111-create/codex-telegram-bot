import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import {
  decodeText,
  formatBinaryFilePrompt,
  formatTextFilePrompt,
  looksLikeText,
} from "../bot/file-ingest.js";
import {
  removeIncomingAttachment,
  safeAttachmentFilename,
  saveIncomingAttachment,
} from "../bot/incoming-files.js";

export const MAX_MOBILE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MOBILE_ATTACHMENT_TEXT = 200_000;
const MOBILE_ATTACHMENT_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_PER_DEVICE = 30;
const MAX_ATTACHMENTS_PER_PROMPT = 5;

export interface MobilePromptAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  text?: string;
  truncated?: boolean;
  path?: string;
}

export interface MobileAttachmentDescriptor {
  id: string;
  name: string;
  size: number;
  kind: "text" | "document";
}

interface StoredMobileAttachment extends MobilePromptAttachment {
  ownerId: number;
  deviceId: string;
  sessionId: string;
  expiresAt: number;
  claimedBy?: string;
}

function supportedBinary(bytes: Buffer, name: string): boolean {
  const extension = extname(name).toLowerCase();
  if (extension === ".pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (extension === ".zip") return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && [0x03, 0x05, 0x07].includes(bytes[2]!) && [0x04, 0x06, 0x08].includes(bytes[3]!);
  return false;
}

export class MobileAttachmentStore {
  private readonly entries = new Map<string, StoredMobileAttachment>();

  constructor(private readonly dataDir: string | undefined, private readonly now: () => number = Date.now) {}

  async add(
    ownerId: number,
    deviceId: string,
    sessionId: string,
    originalName: string,
    mimeType: string,
    bytes: Buffer,
  ): Promise<MobileAttachmentDescriptor> {
    await this.pruneExpired();
    if (!this.dataDir) throw new Error("Загрузка файлов недоступна без локального каталога данных");
    if (bytes.length === 0) throw new Error("Выбран пустой файл");
    if (bytes.length > MAX_MOBILE_ATTACHMENT_BYTES) throw new Error("Файл должен быть не больше 10 МБ");
    if ([...this.entries.values()].filter((entry) => entry.deviceId === deviceId).length >= MAX_PENDING_PER_DEVICE) {
      throw new Error("Слишком много ожидающих вложений. Удалите ненужные и попробуйте снова");
    }

    const name = safeAttachmentFilename(originalName);
    const normalizedMime = mimeType.toLowerCase().split(";")[0]!.trim().slice(0, 100) || "application/octet-stream";
    const id = randomUUID();
    const base = {
      id, ownerId, deviceId, sessionId, name, mimeType: normalizedMime,
      size: bytes.length, expiresAt: this.now() + MOBILE_ATTACHMENT_TTL_MS,
    };

    if (looksLikeText(bytes, normalizedMime, name)) {
      const fullText = decodeText(bytes);
      const truncated = fullText.length > MAX_MOBILE_ATTACHMENT_TEXT;
      const entry: StoredMobileAttachment = {
        ...base,
        text: truncated ? fullText.slice(0, MAX_MOBILE_ATTACHMENT_TEXT) : fullText,
        ...(truncated ? { truncated: true } : {}),
      };
      this.entries.set(id, entry);
      return this.descriptor(entry, "text");
    }

    if (!supportedBinary(bytes, name)) throw new Error("Поддерживаются текстовые файлы, PDF и ZIP с проверенной сигнатурой");
    const saved = await saveIncomingAttachment(this.dataDir, name, bytes);
    const entry: StoredMobileAttachment = { ...base, name: saved.name, path: saved.path };
    this.entries.set(id, entry);
    return this.descriptor(entry, "document");
  }

  async resolveForPrompt(
    ownerId: number,
    deviceId: string,
    sessionId: string,
    ids: unknown,
    requestId: string,
  ): Promise<MobilePromptAttachment[]> {
    await this.pruneExpired();
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS_PER_PROMPT ||
        ids.some((id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) ||
        new Set(ids).size !== ids.length) {
      throw new Error("Список вложений недопустим или превышает пять файлов");
    }
    if (ids.length === 0) return [];
    if (!/^[a-zA-Z0-9_-]{12,80}$/.test(requestId)) throw new Error("Неверный идентификатор отправки");

    const selected = ids.map((id) => this.entries.get(id as string));
    if (selected.some((entry) => !entry || entry.ownerId !== ownerId || entry.deviceId !== deviceId || entry.sessionId !== sessionId)) {
      throw new Error("Вложение не найдено или принадлежит другому устройству/сеансу");
    }
    for (const entry of selected as StoredMobileAttachment[]) {
      if (entry.claimedBy && entry.claimedBy !== requestId) throw new Error("Вложение уже используется в другом запросе");
    }
    for (const entry of selected as StoredMobileAttachment[]) entry.claimedBy = requestId;
    return (selected as StoredMobileAttachment[]).map(({ id, name, mimeType, size, text, truncated, path }) => ({
      id, name, mimeType, size,
      ...(text !== undefined ? { text } : {}),
      ...(truncated ? { truncated: true } : {}),
      ...(path ? { path } : {}),
    }));
  }

  complete(ids: readonly string[], deviceId: string, requestId: string): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry?.deviceId === deviceId && entry.claimedBy === requestId) this.entries.delete(id);
    }
  }

  async remove(ownerId: number, deviceId: string, sessionId: string, id: string): Promise<boolean> {
    await this.pruneExpired();
    const entry = this.entries.get(id);
    if (!entry || entry.ownerId !== ownerId || entry.deviceId !== deviceId || entry.sessionId !== sessionId || entry.claimedBy) return false;
    this.entries.delete(id);
    if (entry.path && this.dataDir) await removeIncomingAttachment(this.dataDir, entry.path);
    return true;
  }

  private descriptor(entry: StoredMobileAttachment, kind: MobileAttachmentDescriptor["kind"]): MobileAttachmentDescriptor {
    return { id: entry.id, name: entry.name, size: entry.size, kind };
  }

  private async pruneExpired(): Promise<void> {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt > this.now()) continue;
      this.entries.delete(id);
      if (!entry.claimedBy && entry.path && this.dataDir) await removeIncomingAttachment(this.dataDir, entry.path);
    }
  }
}

export function mobileAttachmentPromptText(attachment: MobilePromptAttachment, caption: string): string {
  return attachment.text !== undefined
    ? formatTextFilePrompt(attachment.name, attachment.text, caption, attachment.truncated === true)
    : formatBinaryFilePrompt(attachment.name, attachment.mimeType, attachment.size, caption, attachment.path);
}

export function mobileAttachmentContext(attachment: MobilePromptAttachment): string {
  return mobileAttachmentPromptText(attachment, "");
}
