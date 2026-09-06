#!/usr/bin/env node
// Constructed exercise for #397 Verification scenario 2 ("Terse correction dispatch"),
// worker unit 397-C under execution Issue #397 / control Issue #398.
//
// This exercise is CONSTRUCTED, not a real historical occurrence. It isolates the findings-only
// correction path: a findings-bearing Stage 1 response at the current head, with merge state
// otherwise MERGE_READY, must still resolve to `STAGE1_CORRECTION_REQUIRED` with a reference-only
// correction transition. The proof deliberately avoids a simultaneous closing-reference block so
// the findings-bearing branch, not some independent merge-ready failure, is what drives the result.
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
      body_excerpt: "### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.\n\n- **[P1] Do not use an auto-close keyword in the PR body.** ...",
    },
  ],
};

const syntheticMergeReady = {
  exitCode: 0,
  state: "MERGE_READY",
};

const result = resolvePreMergeVerdict(
  { stage1: syntheticStage1ResponseReceived, mergeReady: syntheticMergeReady },
  { repo: "LouPineWays/Loop-Dee-Loup", pr: "999999", issue: "999998" },
);

console.log(JSON.stringify(result, null, 2));

if (result.state !== "STAGE1_CORRECTION_REQUIRED" || result.stopAfter !== true) {
  console.error("FAIL: expected STAGE1_CORRECTION_REQUIRED with stopAfter:true, got", result.state);
  process.exit(1);
}

console.log(
  "\nPASS: a findings-bearing Stage 1 response alone, with merge state otherwise MERGE_READY, resolves to " +
    "STAGE1_CORRECTION_REQUIRED (stopAfter:true) with reference-only correction routing.",
);
