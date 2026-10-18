export interface GitStatusChange {
  code: string;
  indexStatus: string;
  worktreeStatus: string;
}

/** Git's porcelain v1 unmerged records use U, AA or DD status pairs. */
export function isUnmergedGitChange(change: GitStatusChange): boolean {
  return change.indexStatus === "U" || change.worktreeStatus === "U" || change.code === "AA" || change.code === "DD";
}

/** Detect conflict marker lines only when they begin a line. */
export function hasUnresolvedMergeMarkers(content: string): boolean {
  return /^(?:<{7,}|>{7,}|\|{7,})\s?.*$|^={7,}\s*$/m.test(content);
}
