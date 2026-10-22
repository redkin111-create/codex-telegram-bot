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
  private uncertainSubmission = false;
  private uncertainFingerprint?: string;
  private readonly activeAttachmentIds = new Set<string>();
  private readonly uncertainAttachmentIds = new Set<string>();

  get isLocked(): boolean {
    return this.locked;
  }

  get hasUncertainSubmission(): boolean {
    return this.uncertainSubmission;
  }

  canRetryFingerprint(fingerprint: string): boolean {
    return !this.uncertainSubmission || this.uncertainFingerprint === fingerprint;
  }

  markUncertainSubmission(fingerprint: string): void {
    this.uncertainSubmission = true;
    this.uncertainFingerprint = fingerprint;
  }

  tryAcquire(attachmentIds: readonly string[] = []): boolean {
    if (this.locked) return false;
    this.locked = true;
    for (const id of attachmentIds) this.activeAttachmentIds.add(id);
    return true;
  }

  release(outcome: "accepted" | "rejected" | "uncertain" = "uncertain"): void {
    this.locked = false;
    this.uncertainSubmission = outcome === "uncertain";
    if (outcome !== "uncertain") this.uncertainFingerprint = undefined;
    for (const id of this.activeAttachmentIds) {
      if (outcome === "uncertain") this.uncertainAttachmentIds.add(id);
      else this.uncertainAttachmentIds.delete(id);
    }
    this.activeAttachmentIds.clear();
  }

  isAttachmentProtected(id: string): boolean {
    return (this.isLocked && this.activeAttachmentIds.has(id)) || this.uncertainAttachmentIds.has(id);
  }

  resolveAttachments(ids: readonly string[]): void {
    for (const id of ids) {
      this.activeAttachmentIds.delete(id);
      this.uncertainAttachmentIds.delete(id);
    }
  }
}

export interface MobileAttachmentSnapshot {
  sessionId?: string;
  attachments: readonly MobileAttachment[];
}

export interface MobileComposerDraft {
  images: PromptImage[];
  attachments: MobileAttachment[];
  mode: FollowUpMode;
  appIds: string[];
}

export function emptyMobileComposerDraft(): MobileComposerDraft {
  return { images: [], attachments: [], mode: "queue", appIds: [] };
}

export function mobileAttachmentsForCleanup(
  snapshot: MobileAttachmentSnapshot,
  sessionId: string,
  submission: Pick<MobileSubmissionLock, "isAttachmentProtected">,
): MobileAttachment[] {
  if (!sessionId || snapshot.sessionId !== sessionId) return [];
  return snapshot.attachments.filter(({ id }) => !submission.isAttachmentProtected(id));
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
