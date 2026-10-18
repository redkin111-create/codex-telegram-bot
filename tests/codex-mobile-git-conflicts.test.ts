import assert from "node:assert/strict";
import test from "node:test";
import { conflictStagePreview, hasUnresolvedMergeMarkers, isUnmergedGitChange } from "../apps/codex-mobile/src/lib/git-conflicts.js";

test("detects Git's seven unmerged porcelain status combinations",()=>{
  const conflicts=[
    {code:"DD",indexStatus:"D",worktreeStatus:"D"},
    {code:"AU",indexStatus:"A",worktreeStatus:"U"},
    {code:"UD",indexStatus:"U",worktreeStatus:"D"},
    {code:"UA",indexStatus:"U",worktreeStatus:"A"},
    {code:"DU",indexStatus:"D",worktreeStatus:"U"},
    {code:"AA",indexStatus:"A",worktreeStatus:"A"},
    {code:"UU",indexStatus:"U",worktreeStatus:"U"},
  ];
  for(const status of conflicts)assert.equal(isUnmergedGitChange(status),true,status.code);
  for(const status of [
    {code:"M",indexStatus:" ",worktreeStatus:"M"},
    {code:"AM",indexStatus:"A",worktreeStatus:"M"},
    {code:"??",indexStatus:"?",worktreeStatus:"?"},
  ])assert.equal(isUnmergedGitChange(status),false,status.code);
});

test("detects unresolved conflict marker lines without matching inline examples",()=>{
  assert.equal(hasUnresolvedMergeMarkers("<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n"),true);
  assert.equal(hasUnresolvedMergeMarkers("||||||| base\nold\n<<<<<<< HEAD\nnew\n=======\nother\n>>>>>>> feature\n"),true);
  assert.equal(hasUnresolvedMergeMarkers('const example = "<<<<<<< not a conflict";\n'),false);
  assert.equal(hasUnresolvedMergeMarkers("normal source text\n"),false);
});

test("conflict stage previews stay bounded and do not split a Unicode character",()=>{
  const short="const value = 'ours';\n";
  assert.deepEqual(conflictStagePreview(short),{text:short,truncated:false});
  const long="a".repeat(11_999)+"😀"+"b";
  const preview=conflictStagePreview(long);
  assert.equal(preview.truncated,true);
  assert.equal(preview.text.length,11_999);
  assert.equal(preview.text.at(-1),"a");
});
