#!/usr/bin/env node
// Standalone exercise script for worker unit 454-D, scenario 2 (#424-class recurrence).
// Read-only: runs `runNextReviewTransitionGate` end-to-end against real, already-merged PR
// #424's live comment thread, injecting only a synthetic control-Issue body carrying the new
// correction-satisfied disposition (issue #423's real durable body predates this mechanism).
// Every other dependency defaults to the real implementation, hitting real `gh` CLI calls
// against real, already-merged, already-closed GitHub state. Never mutates PR #424 or issue
// #423.
//
// Run: node docs/stage1-correction-satisfaction-proof-runs/454-scenario-02-424-class-exercise.mjs

import { runNextReviewTransitionGate } from "../../tools/orchestration/next-review-transition-gate.mjs";

const REVIEWED_HEAD = "95d9d45c367ad5efe0449afbb4d56d7ea30fb6b8"; // PR #424's real Stage 1 trigger head marker
const CORRECTED_HEAD = "7f3dfb275254c4f0b2f516f377993c4afb0f685d"; // PR #424's real headRefOid at merge

const syntheticControlBody = `
### Current state
- **PR:** #424
- **Execution issue:** #423
- **Stage 1:** correction-satisfied at ${CORRECTED_HEAD} (reviewed ${REVIEWED_HEAD})
`;

async function main() {
  const result = await runNextReviewTransitionGate(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: "423" },
    {
      ghIssueViewImpl: async () => ({ body: syntheticControlBody, state: "OPEN" }),
    },
  );
  console.log(JSON.stringify(result, null, 2));
}

main();
