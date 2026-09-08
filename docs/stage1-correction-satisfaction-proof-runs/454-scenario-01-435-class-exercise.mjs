#!/usr/bin/env node
// Standalone exercise script for worker unit 454-D, scenario 1 (#435-class correction pass).
// Read-only: runs `runNextReviewTransitionGate` end-to-end against real, already-merged PR
// #435's live comment thread, injecting only a synthetic control-Issue body carrying the new
// "- **Stage 1:** correction-satisfied at <corrected> (reviewed <reviewed>)" disposition (issue
// #408's real durable body does not yet record this bullet, since #454 is what introduces the
// mechanism that would let a future session write it). Every other dependency
// (stage1RunImpl, checkMergeReadyImpl, checkCorrectionDeltaImpl, ghPrHeadImpl) is the real
// implementation, hitting the real `gh` CLI against real, already-merged, already-closed
// GitHub state. This script never mutates PR #435 or issue #408.
//
// Run: node docs/stage1-correction-satisfaction-proof-runs/454-scenario-01-435-class-exercise.mjs

import { runNextReviewTransitionGate } from "../../tools/orchestration/next-review-transition-gate.mjs";

const REVIEWED_HEAD = "30b36035c9725df4ff56c7d688d2db6837a37055"; // PR #435's real Stage 1 trigger head marker
const CORRECTED_HEAD = "0009c54b180aedadfa48e3db6266b8473a1d8d35"; // PR #435's real headRefOid at merge

const syntheticControlBody = `
### Current state
- **PR:** #435
- **Execution issue:** #408
- **Stage 1:** correction-satisfied at ${CORRECTED_HEAD} (reviewed ${REVIEWED_HEAD})
`;

async function main() {
  const result = await runNextReviewTransitionGate(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: "408" },
    {
      ghIssueViewImpl: async () => ({ body: syntheticControlBody, state: "OPEN" }),
      // Everything else defaults to the real implementations (real `gh` CLI calls against
      // real PR #435 / issue #408 state) -- not overridden here.
    },
  );
  console.log(JSON.stringify(result, null, 2));
}

main();
