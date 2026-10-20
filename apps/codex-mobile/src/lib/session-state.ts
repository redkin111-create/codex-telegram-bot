import type { MobileAttachment } from "../types.js";
import type { FollowUpMode, PromptImage } from "../types.js";

export type SessionDrafts = Record<string, string>;

export interface MobileAuthScope {
  generation: number;
  deviceId: string;
}

export function isCurrentMobileAuthScope(current: MobileAuthScope, generation: number, deviceId: string): boolean {
  return current.generation === generation && current.deviceId === deviceId;
}

export interface MobileSessionSyncScope {
  sessionId: string;
  selectionGeneration: number;
  requestGeneration: number;
}

export function isCurrentMobileSessionSync(current: MobileSessionSyncScope, requested: MobileSessionSyncScope): boolean {
  return current.sessionId === requested.sessionId &&
    current.selectionGeneration === requested.selectionGeneration &&
    current.requestGeneration === requested.requestGeneration;
}

export function mobileDraftKey(deviceId: string, authEpoch: number, sessionId: string): string {
  return JSON.stringify([deviceId, authEpoch, sessionId]);
}

export class MobileSubmissionLock {
  private locked = false;

  tryAcquire(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  release(): void {
    this.locked = false;
  }
}

export function setSessionDraft(drafts: SessionDrafts, sessionId: string, text: string): SessionDrafts {
  if (!sessionId) return drafts;
  if (text === "") {
    if (!(sessionId in drafts)) return drafts;
    const next = { ...drafts };
    delete next[sessionId];
    return next;
  }
  return drafts[sessionId] === text ? drafts : { ...drafts, [sessionId]: text };
}

export function clearSessionDraftIfUnchanged(drafts: SessionDrafts, sessionId: string, sentText: string): SessionDrafts {
  return drafts[sessionId] === sentText ? setSessionDraft(drafts, sessionId, "") : drafts;
}

export interface SessionBoundState<T> {
  sessionId: string;
  value: T;
}

export function updateCurrentSessionState<T>(
  state: SessionBoundState<T>,
  selectedSessionId: string,
  targetSessionId: string,
  initialValue: T,
  update: (current: T) => T,
): SessionBoundState<T> {
  if (!targetSessionId || selectedSessionId !== targetSessionId) return state;
  const current = state.sessionId === targetSessionId ? state.value : initialValue;
  return { sessionId: targetSessionId, value: update(current) };
}

export interface MobileSendPayload {
  sessionId: string;
  text: string;
  images: PromptImage[];
  attachments: MobileAttachment[];
  mode: FollowUpMode;
  appIds: string[];
}

export function mobileSendFingerprint(payload: MobileSendPayload): string {
  return JSON.stringify([
    payload.sessionId,
    payload.mode,
    payload.text,
    payload.images.map(({ name, mimeType, data }) => [name, mimeType, data]),
    payload.attachments.map(({ id }) => id),
    payload.appIds,
  ]);
}

export class PendingMobileSendIds {
  private readonly requests = new Map<string, string>();

  getOrCreate(fingerprint: string, createId: () => string): string {
    const pending = this.requests.get(fingerprint);
    if (pending) return pending;
    const requestId = createId();
    this.requests.set(fingerprint, requestId);
    return requestId;
  }

  complete(fingerprint: string, requestId: string): void {
    if (this.requests.get(fingerprint) === requestId) this.requests.delete(fingerprint);
  }
}
