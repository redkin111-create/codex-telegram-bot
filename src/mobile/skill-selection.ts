/** Find the first explicit `$skill` marker in a message. A marker may follow
 * an introductory paragraph as long as it starts its own line. */
export function selectedMobileSkillName(text: string): string | undefined {
  const match = /(?:^|\r?\n)[\t ]*\$([\p{L}\p{N}][\p{L}\p{N}_.:-]{0,159})(?=$|[\t \r\n])/u.exec(text);
  return match?.[1];
}

const MOBILE_SKILL_ACTION = /(^|[^\p{L}\p{N}_])(use|apply|invoke|run|follow|select|используй|используйте|использовать|применяй|применяйте|примени|примените|запускай|запускайте|запусти|запустите|вызови|вызовите|выбери|выберите)(?=$|[^\p{L}\p{N}_])/giu;
const BROWSER_SKILL_VERIFICATION = /(?:check|test|verify|browse|audit|проведение|проверка|проверь|проверьте|проведи|проведите|выполни|выполните)[^.!?;]{0,180}(?:through|using|via|with|через|с\s+помощью)\s+browser[\s-]+skill/iu;
const BROWSER_SKILL_INSTALL = /(?:install|add|установи|установить|добавь|добавить)[^.!?;]{0,180}browser[\s-]+skill|browser[\s-]+skill[^.!?;]{0,180}(?:install|add|установи|установить|добавь|добавить)/iu;

function isNegatedSkillAction(text: string, actionStart: number): boolean {
  const prefix = text.slice(Math.max(0, actionStart - 48), actionStart);
  return /(?:\b(?:do\s+not|don't|never|not)\s*|(?:^|[^\p{L}\p{N}_])не(?:\s+\S+){0,2}\s*)$/iu.test(prefix);
}

function naturalSkillActionTails(text: string): Array<{ text: string; start: number }> {
  const tails: Array<{ text: string; start: number }> = [];
  MOBILE_SKILL_ACTION.lastIndex = 0;
  for (const match of text.matchAll(MOBILE_SKILL_ACTION)) {
    const actionStart = match.index! + match[1]!.length;
    if (isNegatedSkillAction(text, actionStart)) continue;
    const end = actionStart + match[2]!.length;
    const rest = text.slice(end, end + 320);
    const sentenceEnd = /[!?;]|\.(?=\s|$)/u.exec(rest)?.index;
    tails.push({ text: sentenceEnd === undefined ? rest : rest.slice(0, sentenceEnd), start: end });
  }
  return tails;
}

function naturalSkillPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const candidates = name.toLowerCase() === "browser-skill" ? [escaped, "browser[\\s-]+skill"] : [escaped];
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])\\$?(?:${candidates.join("|")})(?=$|[^\\p{L}\\p{N}_])`, "iu");
}

/** Find explicitly invoked skill names in ordinary instructions, using the live Codex inventory. */
export function requestedMobileSkillNames(text: string, availableSkillNames: readonly string[]): string[] {
  const requested = new Set<string>();
  for (const match of text.matchAll(/(?:^|\r?\n)[\t ]*\$([\p{L}\p{N}][\p{L}\p{N}_.:-]{0,159})(?=$|[\t \r\n])/gu)) {
    requested.add(match[1]!);
  }
  const tails = naturalSkillActionTails(text);
  const naturalMatches: Array<{ name: string; index: number }> = [];
  for (const name of new Set(availableSkillNames.filter((value) => /^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,159}$/u.test(value)))) {
    if(name.toLowerCase()==="browser-skill"&&BROWSER_SKILL_INSTALL.test(text))continue;
    const pattern = naturalSkillPattern(name);
    for (const tail of tails) {
      const match = pattern.exec(tail.text);
      if (match) naturalMatches.push({ name, index: tail.start + match.index });
    }
  }
  if(BROWSER_SKILL_VERIFICATION.test(text)&&availableSkillNames.some(name=>name.toLowerCase()==="browser-skill")){
    const match=text.match(BROWSER_SKILL_VERIFICATION);
    if(match?.index!==undefined)naturalMatches.push({name:availableSkillNames.find(name=>name.toLowerCase()==="browser-skill")!,index:match.index});
  }
  naturalMatches.sort((a, b) => a.index - b.index || a.name.localeCompare(b.name));
  for (const match of naturalMatches) requested.add(match.name);
  return [...requested];
}

/** Detect a natural-language request that depends specifically on browser-skill. */
export function requestsBrowserMobileSkill(text: string): boolean {
  if(BROWSER_SKILL_INSTALL.test(text))return false;
  return BROWSER_SKILL_VERIFICATION.test(text)||naturalSkillActionTails(text).some(tail=>/browser[\s-]+skill/iu.test(tail.text));
}

/** Avoid querying Codex's skill catalog for ordinary prompts that do not ask to use a skill. */
export function mayRequestMobileSkillNaturally(text: string): boolean {
  if(requestsBrowserMobileSkill(text))return true;
  return naturalSkillActionTails(text).some(tail=>/(?:\bskills?\b|навык|browser[\s-]+skill|[\p{L}\p{N}]+[-_.:][\p{L}\p{N}_.:-]+)/iu.test(tail.text));
}
