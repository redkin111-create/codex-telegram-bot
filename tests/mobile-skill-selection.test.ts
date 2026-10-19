import assert from "node:assert/strict";
import test from "node:test";
import { requestedMobileSkillNames, requestsBrowserMobileSkill, selectedMobileSkillName } from "../src/mobile/skill-selection.js";

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

test("mobile recognizes an explicit skill request written as ordinary instructions", () => {
  assert.deepEqual(requestedMobileSkillNames(
    "Проведи реальную браузерную проверку через browser skill. Затем используй ui-ux-pro-max для аудита.",
    ["browser-skill", "ui-ux-pro-max", "unused-skill"],
  ), ["browser-skill", "ui-ux-pro-max"]);
});

test("mobile does not invoke skills when the prompt only asks about them or says not to use them", () => {
  assert.deepEqual(requestedMobileSkillNames("Не используй browser-skill. Проверь, установлен ли ui-ux-pro-max.", ["browser-skill", "ui-ux-pro-max"]), []);
  assert.deepEqual(requestedMobileSkillNames("Вчера browser-skill не сработал.", ["browser-skill"]), []);
});

test("browser skill installation requests are left for Codex instead of treated as skill use", () => {
  assert.equal(requestsBrowserMobileSkill("Проведи проверку через browser skill."), true);
  assert.equal(requestsBrowserMobileSkill("Установи browser-skill в этот проект."), false);
  assert.deepEqual(requestedMobileSkillNames("Установи browser-skill в этот проект.", ["browser-skill"]), []);
});
