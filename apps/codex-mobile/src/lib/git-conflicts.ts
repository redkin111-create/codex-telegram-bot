export interface GitStatusChange {
  code: string;
  indexStatus: string;
  worktreeStatus: string;
}

const MAX_CONFLICT_PREVIEW_CHARS = 12_000;

/** Keep conflict comparisons small and avoid cutting a Unicode surrogate pair. */
export function conflictStagePreview(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CONFLICT_PREVIEW_CHARS) return { text, truncated: false };
  let end = MAX_CONFLICT_PREVIEW_CHARS;
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return { text: text.slice(0, end), truncated: true };
}

/** Git's porcelain v1 unmerged records use U, AA or DD status pairs. */
export function isUnmergedGitChange(change: GitStatusChange): boolean {
  return change.indexStatus === "U" || change.worktreeStatus === "U" || change.code === "AA" || change.code === "DD";
}

/** Detect conflict marker lines only when they begin a line. */
export function hasUnresolvedMergeMarkers(content: string): boolean {
  return /^(?:<{7,}|>{7,}|\|{7,})\s?.*$|^={7,}\s*$/m.test(content);
}
