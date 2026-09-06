#!/usr/bin/env node
// Constructed exercise for #397 Verification scenario 5 ("Fresh Stage 2 observation"),
// worker unit 397-C under execution Issue #397 / control Issue #398.
//
// The real, live audit corpus checked during this proof run (#384, #406, #380 -- see the
// narrative doc's scenario-5 section) only exposes the "already closed, nothing further to
// do" (NO_ACTION_YET) and an unrelated AMBIGUOUS/PREMATURE_CLOSURE case, because every real
// CLEAN audit currently in this repository whose work issue is still OPEN at query time (the
// shape that actually produces STAGE2_CLOSE_READY) had already been closed out by the time
// this unit ran -- and no real NOT CLEAN audit is currently open either. This script
// therefore calls the shipped, unmodified `resolvePostMergeVerdict` pure function directly
// with two synthetic `postAudit` fixtures reproducing those two exact shapes, to prove both
// verdicts, exactly as 294-D's own scenario-4/5 exercises did for their own no-real-
// occurrence cases.
//
// Run: node docs/next-review-transition-proof-runs/397-scenario-05-fresh-stage2-observation-exercise.mjs

import { resolvePostMergeVerdict } from "../../tools/orchestration/next-review-transition-gate.mjs";

let failures = 0;

// Case A: a backed CLEAN verdict whose work issue is still open -- lifecycle-gate.mjs's own
// "READY_TO_CLOSE" state (see tools/review-watch/lifecycle-gate.mjs line ~677).
const syntheticReadyToClose = {
  exitCode: 0,
  state: "READY_TO_CLOSE",
  workIssue: 999997,
  auditIssue: 999996,
  verdict: "CLEAN",
  rawVerdict: "CLEAN",
  workIssueState: "OPEN",
  reportEvidence: {
    backed: true,
    verdict: "CLEAN",
    responsesSeen: 1,
    matchedCommentUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/999996#issuecomment-0000000001",
    legacyCompatible: false,
  },
};

const resultA = resolvePostMergeVerdict(
  { postAudit: syntheticReadyToClose },
  { repo: "LouPineWays/Loop-Dee-Loup", auditIssue: "999996" },
);
console.log("Case A (CLEAN, work issue still open):");
console.log(JSON.stringify(resultA, null, 2));
if (resultA.state !== "STAGE2_CLOSE_READY" || resultA.stopAfter !== true) {
  console.error("FAIL: expected STAGE2_CLOSE_READY with stopAfter:true, got", resultA.state);
  failures += 1;
}

// Case B: a completed NOT CLEAN audit report.
const syntheticNotClean = {
  exitCode: 0,
  state: "OK",
  workIssue: 999995,
  auditIssue: 999994,
  verdict: null,
  rawVerdict: "NOT CLEAN",
  workIssueState: "OPEN",
  reportEvidence: {
    backed: true,
    verdict: "NOT CLEAN",
    responsesSeen: 1,
    matchedCommentUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/999994#issuecomment-0000000002",
    legacyCompatible: false,
  },
};

const resultB = resolvePostMergeVerdict(
  { postAudit: syntheticNotClean },
  { repo: "LouPineWays/Loop-Dee-Loup", auditIssue: "999994" },
);
console.log("\nCase B (NOT CLEAN):");
console.log(JSON.stringify(resultB, null, 2));
if (resultB.state !== "STAGE2_CORRECTION_REQUIRED" || resultB.stopAfter !== true) {
  console.error("FAIL: expected STAGE2_CORRECTION_REQUIRED with stopAfter:true, got", resultB.state);
  failures += 1;
}

if (failures > 0) {
  console.error(`\n${failures} case(s) FAILED`);
  process.exit(1);
}

console.log(
  "\nPASS: a fresh controller observing only durable Audit-Issue state resolves to exactly one verdict " +
    "in each case -- STAGE2_CLOSE_READY (close the work issue explicitly, record terminal state) or " +
    "STAGE2_CORRECTION_REQUIRED (dispatch one correction worker by reference to the Audit Issue only) -- " +
    "with no prior Stage 1 controller history required or consulted in either case.",
);
