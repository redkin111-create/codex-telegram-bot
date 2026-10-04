/** Reduce a persisted Codex prompt to the text the user actually sent. */
export function cleanSessionPrompt(raw: string): string {
  let text = raw.trim().replace(/^\([^)]*\)\s*/, "");
  const directive = "Пиши пояснения и сообщения пользователю по-русски.";
  if (text.startsWith(directive)) {
    const separator = text.indexOf("\n\n");
    if (separator !== -1) text = text.slice(separator + 2);
  }
  const markers = ["Новое сообщение пользователя:", "User's new message:"];
  const marker = markers
    .map((value) => ({ value, index: text.lastIndexOf(value) }))
    .sort((a, b) => b.index - a.index)[0];
  if (marker && marker.index !== -1) text = text.slice(marker.index + marker.value.length);
  return text.replace(/\s+/g, " ").trim();
}
