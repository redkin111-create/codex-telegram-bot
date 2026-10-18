import assert from "node:assert/strict";
import test from "node:test";
import { parseUnifiedDiff } from "../apps/codex-mobile/src/lib/unified-diff.js";

test("unified diff parser classifies edits and tracks both line numbers", () => {
  const patch = [
    "diff --git a/src/main.ts b/src/main.ts",
    "index 1111111..2222222 100644",
    "--- a/src/main.ts",
    "+++ b/src/main.ts",
    "@@ -2,2 +2,3 @@",
    " const first = 1;",
    "-const answer = 42;",
    "+const answer = 43;",
    "+console.log(answer);",
    "\\ No newline at end of file",
  ].join("\n");
  assert.deepEqual(parseUnifiedDiff(patch).map(({ kind, oldLine, newLine, text }) => ({ kind, oldLine, newLine, text })), [
    { kind: "file", oldLine: undefined, newLine: undefined, text: "diff --git a/src/main.ts b/src/main.ts" },
    { kind: "meta", oldLine: undefined, newLine: undefined, text: "index 1111111..2222222 100644" },
    { kind: "meta", oldLine: undefined, newLine: undefined, text: "--- a/src/main.ts" },
    { kind: "meta", oldLine: undefined, newLine: undefined, text: "+++ b/src/main.ts" },
    { kind: "hunk", oldLine: undefined, newLine: undefined, text: "@@ -2,2 +2,3 @@" },
    { kind: "context", oldLine: 2, newLine: 2, text: " const first = 1;" },
    { kind: "remove", oldLine: 3, newLine: undefined, text: "-const answer = 42;" },
    { kind: "add", oldLine: undefined, newLine: 3, text: "+const answer = 43;" },
    { kind: "add", oldLine: undefined, newLine: 4, text: "+console.log(answer);" },
    { kind: "meta", oldLine: undefined, newLine: undefined, text: "\\ No newline at end of file" },
  ]);
});

test("unified diff parser resets line numbers for later hunks and handles binary notes", () => {
  const patch = [
    "diff --git a/image.png b/image.png",
    "Binary files a/image.png and b/image.png differ",
    "@@ -10 +12 @@",
    "-old()",
    "+new()",
  ].join("\n");
  const lines = parseUnifiedDiff(patch);
  assert.equal(lines[1]?.kind, "meta");
  assert.deepEqual(lines.slice(3).map(({ oldLine, newLine }) => [oldLine, newLine]), [[10, undefined], [undefined, 12]]);
});
