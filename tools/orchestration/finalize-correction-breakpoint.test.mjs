// Tests for tools/orchestration/finalize-correction-breakpoint.mjs — issue #576's mechanical
// enforcement that a Stage 1 correction worker cannot reach its normal stopping point without
// the thin control Issue carrying a verified `correction-satisfied at <corrected> (reviewed
// <reviewed>)` disposition.
//
// Run with:
//   node --test tools/orchestration/finalize-correction-breakpoint.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  run,
  correctionSatisfiedDispositionValue,
  composeCorrectionControlBody,
  verifyFinalizedCorrectionBody,
} from "./finalize-correction-breakpoint.mjs";

const REVIEWED = "30b36035c9d6e1a9b0f2c3d4e5f60718293a4b5c";
const CORRECTED = "0009c54b180aedadfa48e3db6266b8473a1d8d35";

const REVIEW_BODY = `## Current state

- **Lifecycle:** REVIEW
- **Execution:** #570
- **Route:** implementation worker
- **PR:** #573
- **Stage 1:** requested
- **Blocker:** none
- **Founder decision:** none
`;

const CORRECTION_LIFECYCLE_BODY = REVIEW_BODY.replace("- **Lifecycle:** REVIEW", "- **Lifecycle:** CORRECTION");

const LINKED_PR_VIEW_570 = { headRefName: "issue-570-fix-correction-satisfied", headRefOid: CORRECTED, body: "Addresses #570.", state: "OPEN" };

function makePrViewStub(view) {
  return async () => view;
}

function correctionSatisfied() {
  return { exitCode: 0, state: "CORRECTION_SATISFIED", reviewedHead: REVIEWED, correctedHead: CORRECTED };
}

function notSatisfied(reason) {
  return { exitCode: 2, state: "NOT_SATISFIED", reviewedHead: REVIEWED, correctedHead: CORRECTED, reason };
}

function headMismatch() {
  return { exitCode: 2, state: "HEAD_MISMATCH", reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED };
}

// -- Pure helpers --------------------------------------------------------------------------

test("correctionSatisfiedDispositionValue: renders the exact shape stage1-correction-gate.mjs recognizes", () => {
  assert.equal(
    correctionSatisfiedDispositionValue({ correctedHead: CORRECTED, reviewedHead: REVIEWED }),
    `correction-satisfied at ${CORRECTED} (reviewed ${REVIEWED})`,
  );
});

test("composeCorrectionControlBody: from REVIEW, sets only the Stage 1 bullet and leaves every other field untouched", () => {
  const result = composeCorrectionControlBody(REVIEW_BODY, { pr: 573, correctedHead: CORRECTED, reviewedHead: REVIEWED });
  assert.equal(result.ok, true);
  assert.match(result.body, /- \*\*Stage 1:\*\* correction-satisfied at 0009c54b180aedadfa48e3db6266b8473a1d8d35 \(reviewed 30b36035c9d6e1a9b0f2c3d4e5f60718293a4b5c\)/);
  assert.match(result.body, /- \*\*Lifecycle:\*\* REVIEW/);
  assert.match(result.body, /- \*\*Execution:\*\* #570/);
  assert.match(result.body, /- \*\*PR:\*\* #573/);
  assert.match(result.body, /- \*\*Blocker:\*\* none/);
});

test("composeCorrectionControlBody: also accepts the CORRECTION lifecycle value", () => {
  const result = composeCorrectionControlBody(CORRECTION_LIFECYCLE_BODY, { pr: 573, correctedHead: CORRECTED, reviewedHead: REVIEWED });
  assert.equal(result.ok, true);
  assert.match(result.body, /- \*\*Lifecycle:\*\* CORRECTION/);
});

test("composeCorrectionControlBody: refuses a Lifecycle value this breakpoint is not authorized to act against", () => {
  const readyBody = REVIEW_BODY.replace("- **Lifecycle:** REVIEW", "- **Lifecycle:** READY");
  const result = composeCorrectionControlBody(readyBody, { pr: 573, correctedHead: CORRECTED, reviewedHead: REVIEWED });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not one of the recognized values/);
});

test("composeCorrectionControlBody: refuses when the control Issue's PR bullet does not match --pr", () => {
  const result = composeCorrectionControlBody(REVIEW_BODY, { pr: 999, correctedHead: CORRECTED, reviewedHead: REVIEWED });
  assert.equal(result.ok, false);
  assert.match(result.reason, /PR bullet is "#573", expected "#999"/);
});

test("composeCorrectionControlBody: idempotent — re-running against an already-finalized body reproduces the same bullet", () => {
  const first = composeCorrectionControlBody(REVIEW_BODY, { pr: 573, correctedHead: CORRECTED, reviewedHead: REVIEWED });
  const second = composeCorrectionControlBody(first.body, { pr: 573, correctedHead: CORRECTED, reviewedHead: REVIEWED });
  assert.equal(second.ok, true);
  assert.equal(second.body, first.body);
});

test("verifyFinalizedCorrectionBody: accepts a fresh body carrying the exact composed bullet", () => {
  const composed = composeCorrectionControlBody(REVIEW_BODY, { pr: 573, correctedHead: CORRECTED, reviewedHead: REVIEWED });
  const result = verifyFinalizedCorrectionBody(composed.body, { correctedHead: CORRECTED, reviewedHead: REVIEWED });
  assert.equal(result.ok, true);
});

test("verifyFinalizedCorrectionBody: rejects a read-back that does not actually carry the composed bullet (a silent write no-op)", () => {
  const result = verifyFinalizedCorrectionBody(REVIEW_BODY, { correctedHead: CORRECTED, reviewedHead: REVIEWED });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Stage 1 bullet/);
});

// -- run(): control-Issue mode, end-to-end with injected implementations -------------------

test("run(): the exact #571/PR #573 shape — a genuinely corrected head persists and verifies the correction-satisfied disposition", async () => {
  let currentBody = REVIEW_BODY;
  const writeCalls = [];
  const result = await run(
    { repo: "owner/repo", controlIssue: 571, executionIssue: 570, pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_570),
      checkCorrectionDeltaImpl: async () => correctionSatisfied(),
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        writeCalls.push(proposedBody);
        currentBody = proposedBody;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "FINALIZED");
  assert.equal(result.message, "FINALIZED 571 570 573");
  assert.equal(writeCalls.length, 1);
  assert.match(writeCalls[0], /correction-satisfied at 0009c54b180aedadfa48e3db6266b8473a1d8d35 \(reviewed 30b36035c9d6e1a9b0f2c3d4e5f60718293a4b5c\)/);
});

test("run(): negative control — a stale corrected head that no longer matches the PR's live head fails closed before any evidence check runs", async () => {
  let deltaCalls = 0;
  const result = await run(
    { repo: "owner/repo", controlIssue: 571, executionIssue: 570, pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: makePrViewStub({ ...LINKED_PR_VIEW_570, headRefOid: "9999999" }),
      checkCorrectionDeltaImpl: async () => {
        deltaCalls++;
        return correctionSatisfied();
      },
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CORRECTION_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /does not match the PR's live head/);
  assert.equal(deltaCalls, 0, "a stale head must be rejected before the correction-gate evidence is even consulted");
});

test("run(): negative control — reviewed head has no genuine findings-bearing response fails closed", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 571, executionIssue: 570, pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_570),
      checkCorrectionDeltaImpl: async () => notSatisfied("reviewed head has no genuine findings-bearing match."),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CORRECTION_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /no genuine findings-bearing match/);
});

test("run(): negative control — a diverged/unrelated corrected head fails closed", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 571, executionIssue: 570, pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_570),
      checkCorrectionDeltaImpl: async () => notSatisfied('compare reported status "diverged", not "ahead"'),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CORRECTION_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /diverged/);
});

test("run(): negative control — a HEAD_MISMATCH correction-gate result fails closed too, never silently accepted", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 571, executionIssue: 570, pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_570),
      checkCorrectionDeltaImpl: async () => headMismatch(),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CORRECTION_BREAKPOINT_UNVERIFIED");
});

test("run(): negative control — control points at a different execution Issue fails closed before any write is attempted", async () => {
  let writeAttempted = false;
  const result = await run(
    { repo: "owner/repo", controlIssue: 571, executionIssue: 999, pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_570),
      checkCorrectionDeltaImpl: async () => correctionSatisfied(),
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CORRECTION_BREAKPOINT_UNVERIFIED");
  assert.equal(writeAttempted, false);
});

test("run(): negative control — a PR that does not satisfy the linkage convention to the execution Issue fails closed", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 571, executionIssue: 570, pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: makePrViewStub({ headRefName: "unrelated-branch", headRefOid: CORRECTED, body: "unrelated", state: "OPEN" }),
      checkCorrectionDeltaImpl: async () => correctionSatisfied(),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CORRECTION_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /does not reference execution Issue #570/);
});

test("run(): negative control — control tracks a different PR than --pr fails closed before any write is attempted", async () => {
  let writeAttempted = false;
  const otherPrBody = REVIEW_BODY.replace("- **PR:** #573", "- **PR:** #999");
  const result = await run(
    { repo: "owner/repo", controlIssue: 571, executionIssue: 570, pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghIssueViewImpl: async () => otherPrBody,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_570),
      checkCorrectionDeltaImpl: async () => correctionSatisfied(),
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CORRECTION_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /PR bullet is "#999", expected "#573"/);
  assert.equal(writeAttempted, false);
});

test("run(): idempotency — re-running against an already-correctly-recorded disposition is a safe no-op success", async () => {
  let currentBody = REVIEW_BODY;
  const deps = {
    ghIssueViewImpl: async () => currentBody,
    ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_570),
    checkCorrectionDeltaImpl: async () => correctionSatisfied(),
    writeControlSnapshotImpl: async ({ proposedBody }) => {
      currentBody = proposedBody;
      return { exitCode: 0, state: "WRITTEN" };
    },
  };
  const args = { repo: "owner/repo", controlIssue: 571, executionIssue: 570, pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED };
  const first = await run(args, deps);
  const bodyAfterFirst = currentBody;
  const second = await run(args, deps);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(currentBody, bodyAfterFirst, "a second finalize against the already-finalized state must not further mutate the control body");
});

test("run(): a write-control-snapshot success whose fresh read-back does not actually reflect it fails closed (never trusts the write call's own return value)", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 571, executionIssue: 570, pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghIssueViewImpl: async () => REVIEW_BODY, // never actually updated, simulating a silent gh no-op
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_570),
      checkCorrectionDeltaImpl: async () => correctionSatisfied(),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CORRECTION_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /Stage 1 bullet/);
});

test("run(): a control-write failure fails closed, control body left unchanged", async () => {
  const originalBody = REVIEW_BODY;
  let currentBody = originalBody;
  const result = await run(
    { repo: "owner/repo", controlIssue: 571, executionIssue: 570, pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_570),
      checkCorrectionDeltaImpl: async () => correctionSatisfied(),
      writeControlSnapshotImpl: async () => ({ exitCode: 2, state: "REJECTED", errors: ["simulated validation rejection"] }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CORRECTION_BREAKPOINT_UNVERIFIED");
  assert.equal(currentBody, originalBody, "the durable control body must be left exactly as it was on a write failure");
});

test("run(): operational error on missing/invalid required args, distinct from CORRECTION_BREAKPOINT_UNVERIFIED", async () => {
  const missingHead = await run({ repo: "owner/repo", controlIssue: 571, executionIssue: 570, pr: 573, reviewedHead: REVIEWED, correctedHead: "" });
  assert.equal(missingHead.exitCode, 1);
  assert.match(missingHead.message, /--corrected-head is required/);

  const missingPr = await run({ repo: "owner/repo", pr: null, reviewedHead: REVIEWED, correctedHead: CORRECTED });
  assert.equal(missingPr.exitCode, 1);
  assert.match(missingPr.message, /--pr must be a positive integer/);
});

test("run(): --control-issue and --execution-issue must be supplied together", async () => {
  const result = await run({ repo: "owner/repo", controlIssue: 571, executionIssue: null, pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /must be supplied together/);
});

// -- run(): direct-reference mode (issue #576 Required behavior #8) ------------------------

test("run(): direct-reference mode (no --control-issue) verifies the evidence and reports success without inventing a control Issue", async () => {
  let writeAttempted = false;
  let issueReadAttempted = false;
  const result = await run(
    { repo: "owner/repo", pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghIssueViewImpl: async () => {
        issueReadAttempted = true;
        return REVIEW_BODY;
      },
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_570),
      checkCorrectionDeltaImpl: async () => correctionSatisfied(),
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "CORRECTION_SATISFIED_VERIFIED");
  assert.equal(result.message, "CORRECTION_SATISFIED_VERIFIED 573");
  assert.equal(writeAttempted, false, "direct-reference mode must never attempt a control write");
  assert.equal(issueReadAttempted, false, "direct-reference mode must never read a control Issue at all");
});

test("run(): direct-reference mode still fails closed on unsatisfied correction-gate evidence", async () => {
  const result = await run(
    { repo: "owner/repo", pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_570),
      checkCorrectionDeltaImpl: async () => notSatisfied("no genuine findings-bearing match."),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CORRECTION_BREAKPOINT_UNVERIFIED");
});

test("run(): direct-reference mode still fails closed on a stale corrected head", async () => {
  const result = await run(
    { repo: "owner/repo", pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghPrViewImpl: makePrViewStub({ ...LINKED_PR_VIEW_570, headRefOid: "9999999" }),
      checkCorrectionDeltaImpl: async () => correctionSatisfied(),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CORRECTION_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /does not match the PR's live head/);
});
