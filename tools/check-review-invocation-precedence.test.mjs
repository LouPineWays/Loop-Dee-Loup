#!/usr/bin/env node
// Regression guard for issue #626 (closing the live #625 reproduction): a Stage 2
// `@codex review` invocation ran `tools/orchestration/ready-dispatch-gate.mjs` (the
// generic LDL Session-execution READY gate meant for the *controlling executor*), hit a
// missing-`origin` failure in its own hosted checkout, and reported
// `next-review-transition-gate.mjs`'s own waiting-for-a-response verdict text
// (`No action yet: #625 is awaiting a completed Stage 2 audit response.`) as if it were
// the requested audit report -- instead of reading docs/stage2-audit-contract.md and
// posting a genuine one.
//
// Codex's GitHub integration reads only the `## Code Review Rules` heading in AGENTS.md
// to determine review-invocation behavior (root cause: nothing in AGENTS.md previously
// said Session execution's own "first action / before any other tool call" READY-gate
// rule does not apply to that invocation, so a reviewer context reading the whole file
// had no structural reason to prefer the narrower reviewer contract over the generic
// executor one). This is a routing/authority defect entirely inside AGENTS.md's own text
// -- there is no repository-side dispatcher that classifies a `@codex review` invocation
// before Codex's hosted agent starts, so AGENTS.md's own wording *is* the earliest
// repository-authority boundary such an invocation consumes, and is the correct place
// to make precedence structurally unambiguous (see issue #626's "Required layers and
// activities").
//
// This guard exercises that boundary mechanically: it parses AGENTS.md's own
// `## Session execution` and `## Code Review Rules` sections and asserts each carries
// the specific precedence/exclusion text a future edit could otherwise silently drop or
// reword away, rather than merely asserting the headings exist.
//
// Run with: node --test tools/check-review-invocation-precedence.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_PATH = join(ROOT, "AGENTS.md");

// Extracts the body of a `## <heading>` section: everything after the heading line up to
// (but not including) the next `## ` heading or end of file. Does not strip
// `<!-- ldl:source-only -->` markers -- both sections this guard checks live outside
// them, and a future move of either section *into* a source-only block (which would
// silently drop this precedence text from every installed consumer AGENTS.md) is exactly
// the kind of regression the consumer-propagation assertion below exists to catch.
function extractSection(markdown, heading) {
  const headingLine = `## ${heading}`;
  const startIndex = markdown.indexOf(`${headingLine}\n`);
  assert.notEqual(startIndex, -1, `AGENTS.md is missing the "${headingLine}" heading`);
  const bodyStart = startIndex + headingLine.length;
  const nextHeadingIndex = markdown.indexOf("\n## ", bodyStart);
  return nextHeadingIndex === -1 ? markdown.slice(bodyStart) : markdown.slice(bodyStart, nextHeadingIndex);
}

function isOutsideSourceOnlyBlocks(markdown, sectionBody) {
  const sectionIndex = markdown.indexOf(sectionBody);
  assert.notEqual(sectionIndex, -1, "extracted section body could not be relocated in AGENTS.md");
  const before = markdown.slice(0, sectionIndex);
  const opens = (before.match(/<!-- ldl:source-only:start -->/g) || []).length;
  const closes = (before.match(/<!-- ldl:source-only:end -->/g) || []).length;
  return opens === closes;
}

const agentsMd = readFileSync(AGENTS_PATH, "utf8");
const sessionExecution = extractSection(agentsMd, "Session execution");
const codeReviewRules = extractSection(agentsMd, "Code Review Rules");

test("`## Session execution` explicitly excludes `@codex review` invocations before its own READY-gate rule", () => {
  assert.match(
    sessionExecution,
    /never governs an invocation triggered by `@codex review`/,
    "Session execution no longer states it does not govern a `@codex review` invocation -- " +
      "this is the #625 regression: without it, a reviewer context has no structural reason " +
      "to prefer `## Code Review Rules` over this section's generic READY-gate rule."
  );
  assert.match(
    sessionExecution,
    /governed exclusively by `## Code Review Rules` below/,
    "Session execution's `@codex review` exclusion no longer points to `## Code Review Rules` as the exclusive governing section."
  );
});

test("`## Code Review Rules` explicitly forbids running the executor's READY/lifecycle gates and states it takes precedence", () => {
  assert.match(
    codeReviewRules,
    /before any other instruction in this file, including `## Session execution`'s own `first action \/ before any other tool call` READY-gate rule/,
    "Code Review Rules no longer states its role-classification precedence over Session execution's first-action rule."
  );
  assert.match(
    codeReviewRules,
    /must never run `node tools\/orchestration\/ready-dispatch-gate\.mjs` or `node tools\/orchestration\/next-review-transition-gate\.mjs`/,
    "Code Review Rules no longer names the two executor gate scripts a `@codex review` invocation must never run -- " +
      "this is the exact #625 reproduction (ready-dispatch-gate.mjs's missing-origin failure, then " +
      "next-review-transition-gate.mjs's waiting verdict reported as the audit response)."
  );
  assert.match(
    codeReviewRules,
    /reads `docs\/stage2-audit-contract\.md` in full and posts the audit response it defines/,
    "Code Review Rules no longer directs a Stage 2 invocation to docs/stage2-audit-contract.md for the actual response contract."
  );
});

test("both sections live outside `<!-- ldl:source-only -->` blocks, so the precedence text still propagates to installed consumer AGENTS.md files", () => {
  assert.ok(
    isOutsideSourceOnlyBlocks(agentsMd, sessionExecution),
    "`## Session execution` moved inside a ldl:source-only block -- its @codex review exclusion would no longer install into consumer repositories"
  );
  assert.ok(
    isOutsideSourceOnlyBlocks(agentsMd, codeReviewRules),
    "`## Code Review Rules` moved inside a ldl:source-only block -- the reviewer-precedence text would no longer install into consumer repositories"
  );
});
