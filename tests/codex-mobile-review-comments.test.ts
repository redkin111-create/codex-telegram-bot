import assert from "node:assert/strict";
import test from "node:test";
import { splitCodeReviewComments } from "../apps/codex-mobile/src/lib/review-comments.js";

test("extracts bounded review comments and preserves surrounding assistant text", () => {
  const segments = splitCodeReviewComments(
    'Findings:\n\n::code-comment{title="[P1] Validate input" body="Reject \\"bad\\" input.\\nKeep it safe." file="src/main.ts" start=12 end=15 priority=1}\n\nNo blockers.',
  );

  assert.deepEqual(segments, [
    { type: "text", text: "Findings:\n\n" },
    {
      type: "comment",
      title: "[P1] Validate input",
      body: 'Reject "bad" input.\nKeep it safe.',
      file: "src/main.ts",
      start: 12,
      end: 15,
      priority: 1,
    },
    { type: "text", text: "\n\nNo blockers." },
  ]);
});

test("does not extract code examples, malformed directives, or unsafe ranges", () => {
  const source = [
    "```md",
    '::code-comment{title="Example" body="Not a real finding" file="a.ts" start=2}',
    "```",
    '::code-comment{title="Bad range" body="Body" file="a.ts" start=8 end=3}',
    '::code-comment{title="Unknown attribute" body="Body" file="a.ts" onclick="alert(1)"}',
  ].join("\n");

  assert.deepEqual(splitCodeReviewComments(source), [{ type: "text", text: source }]);
});

test("keeps oversized review directives as inert text", () => {
  const body = "x".repeat(4_001);
  const source = `::code-comment{title="Finding" body="${body}" file="a.ts"}`;

  assert.deepEqual(splitCodeReviewComments(source), [{ type: "text", text: source }]);
});

test("keeps comments that point to one start line without an end line", () => {
  assert.deepEqual(splitCodeReviewComments('::code-comment{title="Finding" body="Body" file="a.ts" start=8}'), [
    { type: "comment", title: "Finding", body: "Body", file: "a.ts", start: 8 },
  ]);
});

test("preserves Windows path separators in escaped directive values", () => {
  assert.deepEqual(splitCodeReviewComments(String.raw`::code-comment{title="Finding" body="See C:\work\app.ts before editing." file="src/main.ts"}`), [
    { type: "comment", title: "Finding", body: "See C:\\work\\app.ts before editing.", file: "src/main.ts" },
  ]);
});
