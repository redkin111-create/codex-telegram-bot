import assert from "node:assert/strict";
import test from "node:test";
import {
  clearSessionDraftIfUnchanged,
  isCurrentMobileAuthScope,
  isCurrentMobileSessionSync,
  mobileDraftKey,
  MobileSubmissionLock,
  mobileSendFingerprint,
  PendingMobileSendIds,
  setSessionDraft,
  updateCurrentSessionState,
} from "../apps/codex-mobile/src/lib/session-state.js";

test("mobile text drafts stay separate per session and return when revisiting", () => {
  const first = setSessionDraft({}, "session-a", "Draft A");
  const second = setSessionDraft(first, "session-b", "Draft B");

  assert.equal(second["session-a"], "Draft A");
  assert.equal(second["session-b"], "Draft B");
});

test("draft keys isolate the same Codex session across owners and later logins", () => {
  const ownerA = mobileDraftKey("device-a", 0, "shared-session");
  const ownerBAfterLogin = mobileDraftKey("device-b", 1, "shared-session");
  const ownerAAfterRelogin = mobileDraftKey("device-a", 2, "shared-session");
  const oldDraft = setSessionDraft({}, ownerA, "same draft text");
  const nextOwnerDraft = setSessionDraft(oldDraft, ownerBAfterLogin, "same draft text");

  assert.notEqual(ownerA, ownerBAfterLogin);
  assert.notEqual(ownerA, ownerAAfterRelogin);
  assert.equal(nextOwnerDraft[ownerBAfterLogin], "same draft text");
  const afterOldSendCompletes = clearSessionDraftIfUnchanged(nextOwnerDraft, ownerA, "same draft text");
  assert.equal(afterOldSendCompletes[ownerBAfterLogin], "same draft text");
  assert.equal(afterOldSendCompletes[ownerA], undefined);
});

test("late snapshots and syncs cannot cross an authentication or selection generation", () => {
  assert.equal(isCurrentMobileAuthScope({ generation: 4, deviceId: "device-b" }, 3, "device-a"), false);
  assert.equal(isCurrentMobileAuthScope({ generation: 4, deviceId: "device-b" }, 4, "device-b"), true);

  const request = { sessionId: "session-a", selectionGeneration: 2, requestGeneration: 7 };
  assert.equal(isCurrentMobileSessionSync({ ...request, selectionGeneration: 4 }, request), false);
  assert.equal(isCurrentMobileSessionSync({ ...request, requestGeneration: 8 }, request), false);
  assert.equal(isCurrentMobileSessionSync(request, request), true);
});

test("finishing an older send cannot clear a newer draft in the same session", () => {
  const drafts = setSessionDraft({}, "session-a", "Message A");
  const edited = setSessionDraft(drafts, "session-a", "Message B");

  assert.equal(clearSessionDraftIfUnchanged(edited, "session-a", "Message A"), edited);
  assert.equal(clearSessionDraftIfUnchanged(drafts, "session-a", "Message A")["session-a"], undefined);
});

test("finishing session A cannot clear a draft already typed in session B", () => {
  const drafts = setSessionDraft(setSessionDraft({}, "session-a", "sent from A"), "session-b", "keep this in B");
  const afterACompletes = clearSessionDraftIfUnchanged(drafts, "session-a", "sent from A");
  assert.equal(afterACompletes["session-a"], undefined);
  assert.equal(afterACompletes["session-b"], "keep this in B");
});

test("a rapid second Enter cannot start another send until the first settles", () => {
  const lock = new MobileSubmissionLock();
  assert.equal(lock.tryAcquire(), true);
  assert.equal(lock.tryAcquire(), false);
  lock.release();
  assert.equal(lock.tryAcquire(), true);
});

test("late data from the previous session is ignored and the new session starts empty", () => {
  const previous = { sessionId: "session-a", value: { history: ["A"], queue: ["A job"] } };
  const stale = updateCurrentSessionState(previous, "session-b", "session-a", { history: [], queue: [] }, () => ({ history: ["late A"], queue: [] }));
  assert.equal(stale, previous);

  const current = updateCurrentSessionState(previous, "session-b", "session-b", { history: [], queue: [] }, (value) => value);
  assert.deepEqual(current, { sessionId: "session-b", value: { history: [], queue: [] } });
});

test("uncertain retries reuse their request id without sharing it with another send", () => {
  const ledger = new PendingMobileSendIds();
  const ids = ["request-a", "request-b", "request-a-after-success"];
  const createId = () => ids.shift()!;
  const first = mobileSendFingerprint({ sessionId: "session-a", text: "same", images: [], attachments: [], mode: "queue", appIds: [] });
  const second = mobileSendFingerprint({ sessionId: "session-b", text: "different", images: [], attachments: [], mode: "queue", appIds: [] });

  assert.equal(ledger.getOrCreate(first, createId), "request-a");
  assert.equal(ledger.getOrCreate(first, createId), "request-a");
  assert.equal(ledger.getOrCreate(second, createId), "request-b");
  ledger.complete(first, "request-a");
  assert.equal(ledger.getOrCreate(second, createId), "request-b");
  assert.equal(ledger.getOrCreate(first, createId), "request-a-after-success");
  ledger.complete(first, "request-a");
  assert.equal(ledger.getOrCreate(first, createId), "request-a-after-success");
});

test("send fingerprints include image contents, not only their names and lengths", () => {
  const base = { sessionId: "session-a", text: "look", images: [{ name: "image.png", mimeType: "image/png", data: "AAAA", preview: "data:image/png;base64,AAAA" }], attachments: [], mode: "queue" as const, appIds: [] };
  assert.notEqual(mobileSendFingerprint(base), mobileSendFingerprint({ ...base, images: [{ ...base.images[0]!, data: "BBBB" }] }));
});
