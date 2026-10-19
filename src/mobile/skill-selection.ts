/** Find the first explicit `$skill` marker in a message. A marker may follow
 * an introductory paragraph as long as it starts its own line. */
export function selectedMobileSkillName(text: string): string | undefined {
  const match = /(?:^|\r?\n)[\t ]*\$([\p{L}\p{N}][\p{L}\p{N}_.:-]{0,159})(?=$|[\t \r\n])/u.exec(text);
  return match?.[1];
}
