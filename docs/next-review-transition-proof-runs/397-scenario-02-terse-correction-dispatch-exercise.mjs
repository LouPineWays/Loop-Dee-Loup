#!/usr/bin/env node
// Constructed exercise for #397 Verification scenario 2 ("Terse correction dispatch"),
// worker unit 397-C under execution Issue #397 / control Issue #398.
//
// This exercise is CONSTRUCTED, not a real historical occurrence: `resolvePreMergeVerdict`'s
// `STAGE1_CORRECTION_REQUIRED` verdict fires only for the one concrete, mechanically-detectable
// pre-merge defect the composed checks can see -- a GitHub closing-reference violation
// (`lifecycle-gate.mjs`'s `checkMergeReady` returning `BLOCKED_CLOSING_REFERENCE`) -- not for
// "the reviewer found a bug that got fixed in a later commit" (per the module's own comment,
// a fix-then-re-trigger cycle instead surfaces as a fresh `NOT_REQUESTED` state at the new
// head, which resolves to `NO_ACTION_YET`, not `STAGE1_CORRECTION_REQUIRED`). No PR in this
// repository's current history is live in the closing-reference-violation state (the user's
// own standing preference -- never write Fixes/Closes/Resolves # in a review-worthy LDL PR
// body -- means this defect is deliberately rare in practice). This script therefore calls
// the shipped, unmodified `resolvePreMergeVerdict` pure function directly with a synthetic
// `stage1`/`mergeReady` pair reproducing that exact shape, to prove the verdict and its
// reference-only dispatch implication, exactly as 294-D's own scenario-4/5 exercises did for
// their own no-real-occurrence cases.
//
// Run: node docs/next-review-transition-proof-runs/397-scenario-02-terse-correction-dispatch-exercise.mjs

import { resolvePreMergeVerdict } from "../../tools/orchestration/next-review-transition-gate.mjs";

const syntheticStage1ResponseReceived = {
  exitCode: 0,
  state: "RESPONSE_RECEIVED",
  triggerTimestamp: "2026-09-06T00:00:00Z",
  matches: [
    {
      endpoint: "issue-comments",
      id: 9999999999,
      login: "chatgpt-codex-connector[bot]",
      created_at: "2026-09-06T00:05:00Z",
      body_excerpt: "## Review finding\n\n- **[P1] Do not use an auto-close keyword in the PR body.** ...",
    },
  ],
};

const syntheticMergeReadyBlockedClosingReference = {
  exitCode: 2,
  state: "BLOCKED_CLOSING_REFERENCE",
  violations: [
    {
      source: "closingIssuesReferences",
      detail:
        'PR LouPineWays/Loop-Dee-Loup#999999 carries a GitHub closing reference (PR-body keyword or ' +
        'Development-sidebar link) to issue #999998. Use a non-closing reference (e.g. "Addresses #999998") ' +
        "instead, and remove or decline the Development-sidebar link if one is set.",
    },
  ],
};

const result = resolvePreMergeVerdict(
  { stage1: syntheticStage1ResponseReceived, mergeReady: syntheticMergeReadyBlockedClosingReference },
  { repo: "LouPineWays/Loop-Dee-Loup", pr: "999999", issue: "999998" },
);

console.log(JSON.stringify(result, null, 2));

if (result.state !== "STAGE1_CORRECTION_REQUIRED" || result.stopAfter !== true) {
  console.error("FAIL: expected STAGE1_CORRECTION_REQUIRED with stopAfter:true, got", result.state);
  process.exit(1);
}

console.log(
  "\nPASS: a genuine Stage 1 response combined with a closing-reference violation resolves to exactly " +
    "one verdict, STAGE1_CORRECTION_REQUIRED (stopAfter:true) -- naming the PR/issue references only, " +
    "never the finding text. Per docs/bounded-review-cycle.md's correction-dispatch discipline (already " +
    "shipped, unmodified by this unit), the correction worker dispatched from this verdict reads " +
    "\"PR #999999\" and its own review comments directly; the controller does not restate the finding " +
    "narrative in the dispatch prompt.",
);
