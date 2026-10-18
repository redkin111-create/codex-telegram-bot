import assert from "node:assert/strict";
import test from "node:test";
import { isMobileSkillNameSafe, prependMobileSkill } from "../apps/codex-mobile/src/skill-prompt.js";

test("native skill markers stay a single token and preserve the user's task", () => {
  assert.equal(isMobileSkillNameSafe("review-project"), true);
  assert.equal(isMobileSkillNameSafe("github:review_project.v2"), true);
  assert.equal(prependMobileSkill("  Check this patch  ", "review-project"), "$review-project Check this patch");
  assert.equal(prependMobileSkill("", "github:review_project.v2"), "$github:review_project.v2 ");
});

test("unsafe skill names cannot inject extra prompt text", () => {
  for (const name of ["", "has spaces", "line\nbreak", "$other", "$(run)", "x".repeat(161)]) {
    assert.equal(isMobileSkillNameSafe(name), false);
    assert.throws(() => prependMobileSkill("review this", name), /небезопасное имя/i);
  }
});
