import assert from "node:assert/strict";
import test from "node:test";
import { canStartCodexReview } from "../apps/codex-mobile/src/lib/review-policy.js";

test("Codex review is disabled until the connected session is idle", () => {
  assert.equal(canStartCodexReview(true, true, false), false);
  assert.equal(canStartCodexReview(true, false, false), true);
  assert.equal(canStartCodexReview(false, false, false), false);
});
