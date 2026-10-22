const MOBILE_SKILL_NAME = /^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,159}$/u;

/** Skill names come from project metadata and must stay a single plain-text token. */
export function isMobileSkillNameSafe(name: string): boolean {
  return MOBILE_SKILL_NAME.test(name);
}

/** Prefix the ordinary Codex prompt with its native `$skill` invocation marker. */
export function prependMobileSkill(prompt: string, name: string): string {
  if (!isMobileSkillNameSafe(name)) throw new Error("Небезопасное имя навыка Codex");
  const body = prompt.trim();
  return body ? `$${name} ${body}` : `$${name} `;
}
