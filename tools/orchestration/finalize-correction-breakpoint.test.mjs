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
  assert.match(result.reason, /PR bullet "#573" resolves to #573, expected #999/);
});

// Stage 1 review finding on PR #579 (P2): a raw "#<pr>" string comparison rejected two other
// shapes control-field-validator.mjs's own write-time validator (and next-review-transition-
// gate.mjs's read-time reader) already treat as a valid "PR" bullet.
test("composeCorrectionControlBody: accepts a full pull-request URL as the PR bullet", () => {
  const urlBody = REVIEW_BODY.replace("- **PR:** #573", "- **PR:** https://github.com/LouPineWays/Loop-Dee-Loup/pull/573");
  const result = composeCorrectionControlBody(urlBody, { pr: 573, correctedHead: CORRECTED, reviewedHead: REVIEWED });
  assert.equal(result.ok, true);
});

test("composeCorrectionControlBody: accepts \"#<pr>\" plus safe parenthetical annotation as the PR bullet", () => {
  const annotatedBody = REVIEW_BODY.replace("- **PR:** #573", "- **PR:** #573 (retitled during review)");
  const result = composeCorrectionControlBody(annotatedBody, { pr: 573, correctedHead: CORRECTED, reviewedHead: REVIEWED });
  assert.equal(result.ok, true);
});

test("composeCorrectionControlBody: refuses a PR bullet expressed as an issue-kind URL", () => {
  const wrongKindBody = REVIEW_BODY.replace("- **PR:** #573", "- **PR:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/573");
  const result = composeCorrectionControlBody(wrongKindBody, { pr: 573, correctedHead: CORRECTED, reviewedHead: REVIEWED });
  assert.equal(result.ok, false);
  assert.match(result.reason, /names a issue-kind reference/);
});

test("composeCorrectionControlBody: refuses when the control Issue has no PR bullet at all", () => {
  const noPrBody = REVIEW_BODY.replace("- **PR:** #573\n", "");
  const result = composeCorrectionControlBody(noPrBody, { pr: 573, correctedHead: CORRECTED, reviewedHead: REVIEWED });
  assert.equal(result.ok, false);
  assert.match(result.reason, /has no "PR" bullet/);
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

// Issue #611: the exact live #438/PR #610 regression this whole feature exists to close. #576's
// mechanism (this script) already worked when invoked; the escaped defect was that the
// correction worker's own dispatch prompt never instructed it to invoke this script at all
// (format-dispatch-prompt.test.mjs's own #611 regression tests pin that half). This test proves
// that once a worker actually follows the now-mandatory dispatch instruction and runs this
// script with the incident's real PR/head values, finalization succeeds and persists exactly the
// disposition next-review-transition-gate.mjs's own #611 regression tests (in
// next-review-transition-gate.test.mjs) then prove unblocks the stuck NO_ACTION_YET loop.
test("run(): the exact #438/PR #610 regression — finalizing with the incident's own real reviewed/corrected heads persists the canonical disposition", async () => {
  const reviewedHead438 = "100801f442cd2538c6667eec9a6f935484d856f8";
  const correctedHead438 = "f3fc2adaa35febe586fce838c027177b869c2739";
  const body438 = `## Current state

- **Lifecycle:** REVIEW
- **Execution:** #437
- **Route:** implementation worker
- **PR:** #610
- **Stage 1:** requested
- **Blocker:** none
- **Founder decision:** none
`;
  const prView438 = { headRefName: "issue-437-fix", headRefOid: correctedHead438, body: "Addresses #437.", state: "OPEN" };
  let currentBody = body438;
  const writeCalls = [];
  const result = await run(
    {
      repo: "owner/repo",
      controlIssue: 438,
      executionIssue: 437,
      pr: 610,
      reviewedHead: reviewedHead438,
      correctedHead: correctedHead438,
    },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(prView438),
      checkCorrectionDeltaImpl: async () => ({
        exitCode: 0,
        state: "CORRECTION_SATISFIED",
        reviewedHead: reviewedHead438,
        correctedHead: correctedHead438,
      }),
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        writeCalls.push(proposedBody);
        currentBody = proposedBody;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "FINALIZED");
  assert.equal(result.message, "FINALIZED 438 437 610");
  assert.equal(writeCalls.length, 1);
  assert.match(writeCalls[0], new RegExp(`correction-satisfied at ${correctedHead438} \\(reviewed ${reviewedHead438}\\)`));
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
  assert.match(result.reason, /PR bullet "#999" resolves to #999, expected #573/);
  assert.equal(writeAttempted, false);
});

// Stage 1 review finding on PR #579 (P2): the original single `headCheck` ran before
// `checkCorrectionDeltaImpl`'s own GitHub reads — a real window for a superseding push.
test("run(): negative control — the PR head is superseded between the initial head check and the control write, fails closed before writing", async () => {
  let prViewCalls = 0;
  let writeAttempted = false;
  const result = await run(
    { repo: "owner/repo", controlIssue: 571, executionIssue: 570, pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: async () => {
        prViewCalls++;
        // First read (the initial headCheck) still sees the corrected head as current; a
        // second commit lands before the pre-finalize re-check runs.
        return prViewCalls === 1 ? LINKED_PR_VIEW_570 : { ...LINKED_PR_VIEW_570, headRefOid: "superseded-head" };
      },
      checkCorrectionDeltaImpl: async () => correctionSatisfied(),
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CORRECTION_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /does not match the PR's live head/);
  assert.equal(writeAttempted, false, "a superseded head must never reach the control write");
  assert.ok(prViewCalls >= 2, "the PR head must be re-checked immediately before finalizing, not trusted from the initial read alone");
});

test("run(): direct-reference mode also fails closed when the PR head is superseded before the pre-finalize re-check", async () => {
  let prViewCalls = 0;
  const result = await run(
    { repo: "owner/repo", pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghPrViewImpl: async () => {
        prViewCalls++;
        return prViewCalls === 1 ? LINKED_PR_VIEW_570 : { ...LINKED_PR_VIEW_570, headRefOid: "superseded-head" };
      },
      checkCorrectionDeltaImpl: async () => correctionSatisfied(),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CORRECTION_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /does not match the PR's live head/);
});

// Stage 1 review finding on PR #579 (P2): the original `executionCheck` ran only against the
// body fetched before the pre-write re-read, never against `latestBody` itself.
test("run(): negative control — the control Issue's Execution pointer changes between the initial read and the pre-write re-read, fails closed before writing", async () => {
  let issueReadCalls = 0;
  let writeAttempted = false;
  const retargetedBody = REVIEW_BODY.replace("- **Execution:** #570", "- **Execution:** #999");
  const result = await run(
    { repo: "owner/repo", controlIssue: 571, executionIssue: 570, pr: 573, reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      ghIssueViewImpl: async () => {
        issueReadCalls++;
        // Initial read (verifyExecutionMatches) still names #570; the pre-write re-read sees a
        // concurrent edit that retargeted Execution to #999.
        return issueReadCalls === 1 ? REVIEW_BODY : retargetedBody;
      },
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
  assert.match(result.reason, /names #999, not the given --execution-issue #570/);
  assert.equal(writeAttempted, false, "a retargeted Execution pointer must never reach the control write");
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
