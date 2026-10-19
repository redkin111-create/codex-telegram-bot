import assert from "node:assert/strict";
import test from "node:test";
import { selectedMobileSkillName } from "../src/mobile/skill-selection.js";

test("mobile sends an explicitly selected skill after a standalone introductory paragraph", () => {
  assert.equal(selectedMobileSkillName("(Check the edge cases first.)\n\n$browser-skill Open example.com"), "browser-skill");
});

test("mobile recognizes a skill marker at the start of the prompt", () => {
  assert.equal(selectedMobileSkillName("$review Check this patch"), "review");
});

test("skill names embedded in prose or fenced text are not treated as selections", () => {
  assert.equal(selectedMobileSkillName("Use $browser-skill to do this"), undefined);
  assert.equal(selectedMobileSkillName("Example:\n`$browser-skill`\nRun the test"), undefined);
});

test("invalid or multiword skill markers are rejected", () => {
  assert.equal(selectedMobileSkillName("$skill-name/other Do the task"), undefined);
});
