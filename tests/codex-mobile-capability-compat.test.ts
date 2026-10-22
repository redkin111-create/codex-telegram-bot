import assert from "node:assert/strict";
import test from "node:test";
import { isCapabilitySectionResponse } from "../apps/codex-mobile/src/capability-compat.js";

test("section-aware settings responses are recognized by their explicit marker", () => {
  assert.equal(isCapabilitySectionResponse({ capabilitySection: "core" }, "core"), true);
  assert.equal(isCapabilitySectionResponse({ capabilitySection: "all" }, "core"), false);
});

test("older full-capability responses remain detectable without a marker", () => {
  assert.equal(isCapabilitySectionResponse({}, "core"), false);
});
