// Tests for tools/orchestration/finalize-stage1-satisfied-breakpoint.mjs — issue #586's
// mechanical enforcement that an ordinary (no-findings) Stage 1 pass cannot reach the merge/
// Stage 2 transition without the thin control Issue durably carrying a verified
// `satisfied at <head>` disposition. Closes the exact #582/PR #583 gap: Stage 1 was genuinely
// satisfied and merge-ready-gate.mjs authorized merge, but the control Issue stayed
// `Stage 1: requested` forever.
//
// Run with:
//   node --test tools/orchestration/finalize-stage1-satisfied-breakpoint.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  run,
  ordinaryStage1SatisfiedDispositionValue,
  verifyControlPrBulletMatches,
  looksLikeCorrectionSatisfiedBullet,
  checkAdmissibleRecoveryPrestate,
  earliestMatchTimestampMs,
  composeStage1SatisfiedControlBody,
  verifyFinalizedStage1SatisfiedBody,
} from "./finalize-stage1-satisfied-breakpoint.mjs";
import { resolveControlPlaneCiHead } from "../review-watch/stage2-control-plane-ci-head.mjs";

const HEAD = "0056e55a8a1d5eb6498a16de42327532d359c694";
const OTHER_HEAD = "9999999999999999999999999999999999999999";

const REVIEW_BODY = `## Current state

- **Lifecycle:** REVIEW
- **Execution:** #586
- **Route:** implementation worker
- **PR:** #590
- **Stage 1:** requested
- **Blocker:** none
- **Founder decision:** none
`;

const AUDIT_LIFECYCLE_BODY = REVIEW_BODY.replace("- **Lifecycle:** REVIEW", "- **Lifecycle:** AUDIT");
const CORRECTION_LIFECYCLE_BODY = REVIEW_BODY.replace("- **Lifecycle:** REVIEW", "- **Lifecycle:** CORRECTION");

const LINKED_PR_VIEW = { headRefName: "issue-586-fix-stage1-satisfied", headRefOid: HEAD, body: "Addresses #586.", state: "OPEN" };

// #596 historical-provenance fixtures: a merge boundary plus response timestamps clearly before
// and after it, mirroring the real #582/#583/#592 shape (trigger/response timestamps that are
// genuinely ordered relative to the merge).
const MERGED_AT = "2026-09-10T12:00:00Z";
const PRE_MERGE_RESPONSE_AT = "2026-09-10T11:00:00Z";
const POST_MERGE_RESPONSE_AT = "2026-09-10T13:00:00Z";

const MERGED_LINKED_PR_VIEW = { ...LINKED_PR_VIEW, state: "MERGED", mergedAt: MERGED_AT };

function makePrViewStub(view) {
  return async () => view;
}

function satisfiedVerdict({ pr = 590, head = HEAD, controlIssue } = {}) {
  return {
    exitCode: 0,
    state: "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2",
    stopAfter: true,
    repo: "owner/repo",
    pr,
    head,
    issue: 586,
    ...(controlIssue != null ? { controlIssue } : {}),
  };
}

function correctionRequiredVerdict() {
  return { exitCode: 3, state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, repo: "owner/repo", pr: 590, head: HEAD, issue: 586 };
}

function ambiguousVerdict(reason) {
  return { exitCode: 4, state: "AMBIGUOUS", stopAfter: true, repo: "owner/repo", reason: reason ?? "unresolved" };
}

function exemptStage1Result() {
  return { exitCode: 0, state: "EXEMPT", reason: "docs typo fix" };
}

function cleanStage1Result({ createdAt = PRE_MERGE_RESPONSE_AT } = {}) {
  return {
    exitCode: 0,
    state: "RESPONSE_RECEIVED",
    matches: [{ body_excerpt: "Codex Review: Didn't find any major issues. Looks good to merge.", created_at: createdAt }],
    unboundGenuineMatches: [],
  };
}

function findingsStage1Result() {
  return {
    exitCode: 0,
    state: "RESPONSE_RECEIVED",
    matches: [{ body_excerpt: "### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request." }],
    unboundGenuineMatches: [],
  };
}

// -- Pure helpers --------------------------------------------------------------------------

test("ordinaryStage1SatisfiedDispositionValue: renders the exact shape stage2-control-plane-ci-head.mjs recognizes", () => {
  assert.equal(ordinaryStage1SatisfiedDispositionValue({ head: HEAD }), `satisfied at ${HEAD}`);
});

test("cross-module: stage2-control-plane-ci-head.mjs's resolveControlPlaneCiHead resolves the exact disposition this script writes", () => {
  const disposition = ordinaryStage1SatisfiedDispositionValue({ head: HEAD });
  const resolved = resolveControlPlaneCiHead(disposition);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.head, HEAD.toLowerCase());
  assert.equal(resolved.source, "reviewed");
});

test("verifyControlPrBulletMatches: accepts a matching bare PR bullet", () => {
  assert.equal(verifyControlPrBulletMatches(REVIEW_BODY, 590).ok, true);
});

test("verifyControlPrBulletMatches: refuses when the control Issue tracks a different PR", () => {
  const result = verifyControlPrBulletMatches(REVIEW_BODY, 999);
  assert.equal(result.ok, false);
  assert.match(result.reason, /resolves to #590, expected #999/);
});

test("verifyControlPrBulletMatches: refuses when the control Issue has no PR bullet at all", () => {
  const noPrBody = REVIEW_BODY.replace("- **PR:** #590\n", "");
  const result = verifyControlPrBulletMatches(noPrBody, 590);
  assert.equal(result.ok, false);
  assert.match(result.reason, /has no "PR" bullet/);
});

test("verifyControlPrBulletMatches: accepts a full pull-request URL", () => {
  const urlBody = REVIEW_BODY.replace("- **PR:** #590", "- **PR:** https://github.com/LouPineWays/Loop-Dee-Loup/pull/590");
  assert.equal(verifyControlPrBulletMatches(urlBody, 590).ok, true);
});

test("verifyControlPrBulletMatches: refuses a PR bullet expressed as an issue-kind URL", () => {
  const wrongKindBody = REVIEW_BODY.replace("- **PR:** #590", "- **PR:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/590");
  const result = verifyControlPrBulletMatches(wrongKindBody, 590);
  assert.equal(result.ok, false);
  assert.match(result.reason, /names a issue-kind reference/);
});

test("looksLikeCorrectionSatisfiedBullet: recognizes the distinct #576/#577 disposition shape", () => {
  assert.equal(looksLikeCorrectionSatisfiedBullet(`correction-satisfied at ${HEAD} (reviewed ${OTHER_HEAD})`), true);
  assert.equal(looksLikeCorrectionSatisfiedBullet("requested"), false);
  assert.equal(looksLikeCorrectionSatisfiedBullet(`satisfied at ${HEAD}`), false);
  assert.equal(looksLikeCorrectionSatisfiedBullet(null), false);
});

// -- checkAdmissibleRecoveryPrestate (issue #596, original #597) -------------------------

test("checkAdmissibleRecoveryPrestate: accepts the documented stranded 'requested' prestate", () => {
  const result = checkAdmissibleRecoveryPrestate("requested", { head: HEAD });
  assert.equal(result.ok, true);
  assert.equal(result.disposition, "requested");
});

test("checkAdmissibleRecoveryPrestate: accepts the exact already-recovered value for the same head as an idempotent prestate", () => {
  const result = checkAdmissibleRecoveryPrestate(`satisfied at ${HEAD}`, { head: HEAD });
  assert.equal(result.ok, true);
  assert.equal(result.disposition, "already-recovered");
});

test("checkAdmissibleRecoveryPrestate: refuses 'none'", () => {
  const result = checkAdmissibleRecoveryPrestate("none", { head: HEAD });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not an admissible --recover true prestate/);
});

test("checkAdmissibleRecoveryPrestate: refuses malformed/unparseable text", () => {
  const result = checkAdmissibleRecoveryPrestate("¿¿¿ garbage ???", { head: HEAD });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not an admissible --recover true prestate/);
});

test("checkAdmissibleRecoveryPrestate: refuses an ordinary satisfied-at-a-different-head value", () => {
  const result = checkAdmissibleRecoveryPrestate(`satisfied at ${OTHER_HEAD}`, { head: HEAD });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not an admissible --recover true prestate/);
});

test("checkAdmissibleRecoveryPrestate: refuses a correction-satisfied disposition as a defense-in-depth fallback", () => {
  const result = checkAdmissibleRecoveryPrestate(`correction-satisfied at ${HEAD} (reviewed ${OTHER_HEAD})`, { head: HEAD });
  assert.equal(result.ok, false);
});

test("checkAdmissibleRecoveryPrestate: refuses an entirely absent Stage 1 bullet", () => {
  const result = checkAdmissibleRecoveryPrestate(null, { head: HEAD });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no "Stage 1" bullet at all/);
});

// -- earliestMatchTimestampMs (issue #596, original #596) --------------------------------

test("earliestMatchTimestampMs: returns the earliest created_at among multiple matches", () => {
  const ms = earliestMatchTimestampMs([{ created_at: POST_MERGE_RESPONSE_AT }, { created_at: PRE_MERGE_RESPONSE_AT }]);
  assert.equal(ms, new Date(PRE_MERGE_RESPONSE_AT).getTime());
});

test("earliestMatchTimestampMs: returns null when no match carries a usable timestamp (unknown ordering)", () => {
  assert.equal(earliestMatchTimestampMs([{ body_excerpt: "no timestamp here" }]), null);
  assert.equal(earliestMatchTimestampMs([]), null);
  assert.equal(earliestMatchTimestampMs(undefined), null);
});

test("composeStage1SatisfiedControlBody: from REVIEW, sets only the Stage 1 bullet and leaves every other field untouched", () => {
  const result = composeStage1SatisfiedControlBody(REVIEW_BODY, { pr: 590, head: HEAD });
  assert.equal(result.ok, true);
  assert.match(result.body, /- \*\*Stage 1:\*\* satisfied at 0056e55a8a1d5eb6498a16de42327532d359c694/);
  assert.match(result.body, /- \*\*Lifecycle:\*\* REVIEW/);
  assert.match(result.body, /- \*\*Execution:\*\* #586/);
  assert.match(result.body, /- \*\*PR:\*\* #590/);
  assert.match(result.body, /- \*\*Blocker:\*\* none/);
});

test("composeStage1SatisfiedControlBody: also accepts AUDIT and CORRECTION lifecycle values", () => {
  const audit = composeStage1SatisfiedControlBody(AUDIT_LIFECYCLE_BODY, { pr: 590, head: HEAD });
  assert.equal(audit.ok, true);
  assert.match(audit.body, /- \*\*Lifecycle:\*\* AUDIT/);
  const correction = composeStage1SatisfiedControlBody(CORRECTION_LIFECYCLE_BODY, { pr: 590, head: HEAD });
  assert.equal(correction.ok, true);
  assert.match(correction.body, /- \*\*Lifecycle:\*\* CORRECTION/);
});

test("composeStage1SatisfiedControlBody: refuses a Lifecycle value this breakpoint is not authorized to act against", () => {
  const readyBody = REVIEW_BODY.replace("- **Lifecycle:** REVIEW", "- **Lifecycle:** READY");
  const result = composeStage1SatisfiedControlBody(readyBody, { pr: 590, head: HEAD });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not one of the recognized/);
});

test("composeStage1SatisfiedControlBody: refuses when the control Issue's PR bullet does not match --pr", () => {
  const result = composeStage1SatisfiedControlBody(REVIEW_BODY, { pr: 999, head: HEAD });
  assert.equal(result.ok, false);
  assert.match(result.reason, /expected #999/);
});

// -- Near-duplicate field guard (issue #596, original #598 / recurrence of #493) ---------

test("composeStage1SatisfiedControlBody: refuses when a canonical Stage 1 bullet coexists with an unrecognized near-duplicate label", () => {
  const ambiguousBody = REVIEW_BODY.replace(
    "- **Stage 1:** requested\n",
    "- **Stage 1:** requested\n- **Stage 1 (current):** satisfied at deadbeef\n",
  );
  const result = composeStage1SatisfiedControlBody(ambiguousBody, { pr: 590, head: HEAD });
  assert.equal(result.ok, false);
  assert.match(result.reason, /"Stage 1" field is ambiguous/);
  assert.match(result.reason, /Stage 1 \(current\)/);
});

test("composeStage1SatisfiedControlBody: a near-duplicate label with no canonical Stage 1 bullet does not manufacture ambiguity on its own", () => {
  const noCanonicalBody = REVIEW_BODY.replace("- **Stage 1:** requested\n", "- **Stage 1 (current):** requested\n");
  // No canonical "Stage 1" bullet exists at all here, so composeStage1SatisfiedControlBody
  // proceeds to insert one fresh -- mirrors checkExecutionCompletePrBoundary's own `raw !== null`
  // gate: a noncanonical bullet alone must never manufacture ambiguity.
  const result = composeStage1SatisfiedControlBody(noCanonicalBody, { pr: 590, head: HEAD });
  assert.equal(result.ok, true);
  assert.match(result.body, /- \*\*Stage 1:\*\* satisfied at 0056e55a8a1d5eb6498a16de42327532d359c694/);
});

test("composeStage1SatisfiedControlBody: refuses to clobber an existing correction-satisfied disposition", () => {
  const correctionBody = REVIEW_BODY.replace(
    "- **Stage 1:** requested",
    `- **Stage 1:** correction-satisfied at ${HEAD} (reviewed ${OTHER_HEAD})`,
  );
  const result = composeStage1SatisfiedControlBody(correctionBody, { pr: 590, head: HEAD });
  assert.equal(result.ok, false);
  assert.match(result.reason, /distinct correction-satisfied disposition/);
});

test("composeStage1SatisfiedControlBody: idempotent — re-running against an already-finalized body reproduces the same bullet", () => {
  const first = composeStage1SatisfiedControlBody(REVIEW_BODY, { pr: 590, head: HEAD });
  const second = composeStage1SatisfiedControlBody(first.body, { pr: 590, head: HEAD });
  assert.equal(second.ok, true);
  assert.equal(second.body, first.body);
});

test("verifyFinalizedStage1SatisfiedBody: accepts a fresh body carrying the exact composed bullet", () => {
  const composed = composeStage1SatisfiedControlBody(REVIEW_BODY, { pr: 590, head: HEAD });
  assert.equal(verifyFinalizedStage1SatisfiedBody(composed.body, { head: HEAD }).ok, true);
});

test("verifyFinalizedStage1SatisfiedBody: rejects a read-back that does not actually carry the composed bullet", () => {
  const result = verifyFinalizedStage1SatisfiedBody(REVIEW_BODY, { head: HEAD });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Stage 1 bullet/);
});

// -- run(): forward path, control-Issue mode --------------------------------------------

test("run(): the exact #582/PR #583 shape — a genuine ordinary Stage 1 pass persists and verifies satisfied-at-head", async () => {
  let currentBody = REVIEW_BODY;
  const writeCalls = [];
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590 },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async () => satisfiedVerdict({ controlIssue: 587 }),
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        writeCalls.push(proposedBody);
        currentBody = proposedBody;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "FINALIZED");
  assert.equal(result.message, "FINALIZED 587 586 590");
  assert.equal(writeCalls.length, 1);
  assert.match(writeCalls[0], /- \*\*Stage 1:\*\* satisfied at 0056e55a8a1d5eb6498a16de42327532d359c694/);
});

test("run(): control-Issue mode invokes the composed gate in control-Issue mode, not direct-reference mode", async () => {
  let capturedArgs = null;
  await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590 },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async (args) => {
        capturedArgs = args;
        return satisfiedVerdict({ controlIssue: 587 });
      },
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.deepEqual(capturedArgs, { repo: "owner/repo", controlIssue: 587 });
});

test("run(): negative control — a findings-bearing response (STAGE1_CORRECTION_REQUIRED) never manufactures ordinary satisfaction", async () => {
  let writeAttempted = false;
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590 },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async () => correctionRequiredVerdict(),
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /STAGE1_CORRECTION_REQUIRED/);
  assert.equal(writeAttempted, false);
});

test("run(): negative control — an AMBIGUOUS/operational gate verdict fails closed", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590 },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async () => ambiguousVerdict("stage1-gate and merge-ready disagree"),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /AMBIGUOUS/);
});

test("run(): negative control — the correction-satisfied sibling verdict is never treated as this breakpoint's own", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590 },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async () => ({
        exitCode: 0,
        state: "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2",
        pr: 590,
        head: HEAD,
      }),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2/);
});

test("run(): negative control — the gate resolving against a different PR fails closed", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590 },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async () => satisfiedVerdict({ pr: 999, controlIssue: 587 }),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /against PR #999, not the given --pr #590/);
});

test("run(): negative control — a verdict with no usable head fails closed", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590 },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async () => ({ exitCode: 0, state: "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", pr: 590, head: null }),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /carries no usable head/);
});

// Mirrors finalize-correction-breakpoint.mjs's own Stage 1 review finding on PR #579: evidence
// is derived once, but the PR head must be re-checked immediately before finalizing.
test("run(): negative control — the PR head is superseded between the gate's verdict and the pre-finalize re-check, fails closed before writing", async () => {
  let prViewCalls = 0;
  let writeAttempted = false;
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590 },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: async () => {
        prViewCalls++;
        return prViewCalls === 1 ? LINKED_PR_VIEW : { ...LINKED_PR_VIEW, headRefOid: "superseded-head" };
      },
      runNextReviewTransitionGateImpl: async () => satisfiedVerdict({ controlIssue: 587 }),
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /does not match the PR's live head/);
  assert.equal(writeAttempted, false);
  assert.ok(prViewCalls >= 2);
});

test("run(): negative control — control points at a different execution Issue fails closed before the gate is ever invoked", async () => {
  let gateInvoked = false;
  let writeAttempted = false;
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 999, pr: 590 },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async () => {
        gateInvoked = true;
        return satisfiedVerdict({ controlIssue: 587 });
      },
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.equal(gateInvoked, false, "a mismatched execution Issue must be rejected before the evidence gate ever runs");
  assert.equal(writeAttempted, false);
});

test("run(): negative control — control tracks a different PR than --pr fails closed before the gate is ever invoked", async () => {
  let gateInvoked = false;
  const otherPrBody = REVIEW_BODY.replace("- **PR:** #590", "- **PR:** #999");
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590 },
    {
      ghIssueViewImpl: async () => otherPrBody,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async () => {
        gateInvoked = true;
        return satisfiedVerdict({ controlIssue: 587 });
      },
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.equal(gateInvoked, false);
});

test("run(): negative control — a PR that does not satisfy the linkage convention to the execution Issue fails closed", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590 },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: makePrViewStub({ headRefName: "unrelated-branch", headRefOid: HEAD, body: "unrelated", state: "OPEN" }),
      runNextReviewTransitionGateImpl: async () => satisfiedVerdict({ controlIssue: 587 }),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /does not reference execution Issue #586/);
});

test("run(): negative control — the control Issue's Execution pointer changes between the initial read and the pre-write re-read, fails closed before writing", async () => {
  let issueReadCalls = 0;
  let writeAttempted = false;
  const retargetedBody = REVIEW_BODY.replace("- **Execution:** #586", "- **Execution:** #999");
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590 },
    {
      ghIssueViewImpl: async () => {
        issueReadCalls++;
        return issueReadCalls === 1 ? REVIEW_BODY : retargetedBody;
      },
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async () => satisfiedVerdict({ controlIssue: 587 }),
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /names #999, not the given --execution-issue #586/);
  assert.equal(writeAttempted, false);
});

test("run(): idempotency — re-running against an already-correctly-recorded disposition is a safe no-op success", async () => {
  let currentBody = REVIEW_BODY;
  const deps = {
    ghIssueViewImpl: async () => currentBody,
    ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
    runNextReviewTransitionGateImpl: async () => satisfiedVerdict({ controlIssue: 587 }),
    writeControlSnapshotImpl: async ({ proposedBody }) => {
      currentBody = proposedBody;
      return { exitCode: 0, state: "WRITTEN" };
    },
  };
  const args = { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590 };
  const first = await run(args, deps);
  const bodyAfterFirst = currentBody;
  const second = await run(args, deps);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(currentBody, bodyAfterFirst);
});

test("run(): a write-control-snapshot success whose fresh read-back does not actually reflect it fails closed", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590 },
    {
      ghIssueViewImpl: async () => REVIEW_BODY, // never actually updated
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async () => satisfiedVerdict({ controlIssue: 587 }),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /Stage 1 bullet/);
});

test("run(): a control-write failure fails closed, control body left unchanged", async () => {
  const originalBody = REVIEW_BODY;
  let currentBody = originalBody;
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590 },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async () => satisfiedVerdict({ controlIssue: 587 }),
      writeControlSnapshotImpl: async () => ({ exitCode: 2, state: "REJECTED", errors: ["simulated validation rejection"] }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.equal(currentBody, originalBody);
});

test("run(): operational error on missing/invalid required args, distinct from STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED", async () => {
  const missingPr = await run({ repo: "owner/repo", pr: null });
  assert.equal(missingPr.exitCode, 1);
  assert.match(missingPr.message, /--pr must be a positive integer/);

  const badHead = await run({ repo: "owner/repo", pr: 590, head: "" });
  assert.equal(badHead.exitCode, 1);
  assert.match(badHead.message, /--head, when given, must be a non-empty string/);
});

test("run(): --control-issue and --execution-issue must be supplied together", async () => {
  const result = await run({ repo: "owner/repo", controlIssue: 587, executionIssue: null, pr: 590 });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /must be supplied together/);
});

test("run(): a given --head that is not the PR's live head fails closed before the gate is ever invoked", async () => {
  let gateInvoked = false;
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, head: OTHER_HEAD },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async () => {
        gateInvoked = true;
        return satisfiedVerdict({ controlIssue: 587 });
      },
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.equal(gateInvoked, false);
});

// -- run(): direct-reference mode ---------------------------------------------------------

test("run(): direct-reference mode (no --control-issue) verifies the evidence and reports success without inventing a control Issue", async () => {
  let writeAttempted = false;
  let issueReadAttempted = false;
  let capturedArgs = null;
  const result = await run(
    { repo: "owner/repo", pr: 590, issue: "none" },
    {
      ghIssueViewImpl: async () => {
        issueReadAttempted = true;
        return REVIEW_BODY;
      },
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async (args) => {
        capturedArgs = args;
        return satisfiedVerdict();
      },
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "STAGE1_SATISFIED_VERIFIED");
  assert.equal(result.message, "STAGE1_SATISFIED_VERIFIED 590");
  assert.equal(writeAttempted, false);
  assert.equal(issueReadAttempted, false);
  assert.deepEqual(capturedArgs, { repo: "owner/repo", pr: 590, head: HEAD, issue: "none" });
});

test("run(): direct-reference mode passes a real work-issue reference through to the transition gate instead of the \"none\" sentinel (Stage 1 finding on PR #590)", async () => {
  let capturedArgs = null;
  const result = await run(
    { repo: "owner/repo", pr: 590, issue: "586" },
    {
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async (args) => {
        capturedArgs = args;
        return satisfiedVerdict();
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "STAGE1_SATISFIED_VERIFIED");
  assert.deepEqual(capturedArgs, { repo: "owner/repo", pr: 590, head: HEAD, issue: "586" });
});

test("run(): direct-reference mode requires --issue -- refuses to silently select the \"none\" sentinel on the caller's behalf", async () => {
  const result = await run(
    { repo: "owner/repo", pr: 590 },
    {
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async () => {
        throw new Error("must not be called before --issue is validated");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--issue is required in direct-reference mode/);
});

test("run(): direct-reference mode still fails closed on a verdict other than STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", async () => {
  const result = await run(
    { repo: "owner/repo", pr: 590, issue: "none" },
    {
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async () => correctionRequiredVerdict(),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
});

test("run(): direct-reference mode still fails closed on a stale head", async () => {
  let prViewCalls = 0;
  const result = await run(
    { repo: "owner/repo", pr: 590, issue: "none" },
    {
      ghPrViewImpl: async () => {
        prViewCalls++;
        return prViewCalls === 1 ? LINKED_PR_VIEW : { ...LINKED_PR_VIEW, headRefOid: "superseded-head" };
      },
      runNextReviewTransitionGateImpl: async () => satisfiedVerdict(),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /does not match the PR's live head/);
});

test("run(): --recover true requires --control-issue -- there is no stranded state to reconcile in direct-reference mode", async () => {
  const result = await run({ repo: "owner/repo", pr: 590, recover: true });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /requires --control-issue/);
});

// -- run(): recovery mode (issue #586 Required behavior #10, the exact #582/#583 shape) ---

test("run(): --recover true — the exact #582/#583 shape (PR already merged, control still says requested) reconciles via a genuinely clean live Stage 1 response", async () => {
  let currentBody = AUDIT_LIFECYCLE_BODY;
  const writeCalls = [];
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, recover: true },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(MERGED_LINKED_PR_VIEW),
      stage1GateRunImpl: async () => cleanStage1Result(),
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        writeCalls.push(proposedBody);
        currentBody = proposedBody;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "FINALIZED");
  assert.match(writeCalls[0], /- \*\*Stage 1:\*\* satisfied at 0056e55a8a1d5eb6498a16de42327532d359c694/);
  // Lifecycle is left exactly as recorded -- recovery never itself transitions Lifecycle.
  assert.match(writeCalls[0], /- \*\*Lifecycle:\*\* AUDIT/);
});

test("run(): --recover true also accepts an EXEMPT disposition", async () => {
  let currentBody = AUDIT_LIFECYCLE_BODY;
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, recover: true },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(MERGED_LINKED_PR_VIEW),
      stage1GateRunImpl: async () => exemptStage1Result(),
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        currentBody = proposedBody;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "FINALIZED");
});

// Issue #596 Required behavior: EXEMPT must never be rejected merely for lacking a
// response-shaped timestamp -- it is a structural PR-body marker, not a timestamped event, so
// this must succeed even when the PR carries no usable "mergedAt" at all (a case that would fail
// closed for a RESPONSE_RECEIVED disposition -- see the "unknown ordering" test below).
test("run(): --recover true accepts EXEMPT even when the PR carries no usable mergedAt timestamp", async () => {
  const noMergedAtView = { ...MERGED_LINKED_PR_VIEW, mergedAt: null };
  let currentBody = AUDIT_LIFECYCLE_BODY;
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, recover: true },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(noMergedAtView),
      stage1GateRunImpl: async () => exemptStage1Result(),
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        currentBody = proposedBody;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "FINALIZED");
});

// -- Historical-provenance guard (issue #596, original #596) -----------------------------

test("run(): --recover true refuses a clean response that arrived only after merge -- never backfills pre-merge authority", async () => {
  let writeAttempted = false;
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, recover: true },
    {
      ghIssueViewImpl: async () => AUDIT_LIFECYCLE_BODY,
      ghPrViewImpl: makePrViewStub(MERGED_LINKED_PR_VIEW),
      stage1GateRunImpl: async () => cleanStage1Result({ createdAt: POST_MERGE_RESPONSE_AT }),
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /does not predate PR #590's merge boundary/);
  assert.equal(writeAttempted, false);
});

test("run(): --recover true succeeds when the qualifying response demonstrably predates merge", async () => {
  let currentBody = AUDIT_LIFECYCLE_BODY;
  const writeCalls = [];
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, recover: true },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(MERGED_LINKED_PR_VIEW),
      stage1GateRunImpl: async () => cleanStage1Result({ createdAt: PRE_MERGE_RESPONSE_AT }),
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        writeCalls.push(proposedBody);
        currentBody = proposedBody;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "FINALIZED");
  assert.equal(writeCalls.length, 1);
});

test("run(): --recover true fails closed when the PR's own mergedAt timestamp is unusable -- unknown ordering, never guessed", async () => {
  const unusableMergedAtView = { ...MERGED_LINKED_PR_VIEW, mergedAt: null };
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, recover: true },
    {
      ghIssueViewImpl: async () => AUDIT_LIFECYCLE_BODY,
      ghPrViewImpl: makePrViewStub(unusableMergedAtView),
      stage1GateRunImpl: async () => cleanStage1Result(),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /no usable "mergedAt" timestamp/);
});

test("run(): --recover true fails closed when the qualifying response carries no usable timestamp -- unknown ordering, never guessed", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, recover: true },
    {
      ghIssueViewImpl: async () => AUDIT_LIFECYCLE_BODY,
      ghPrViewImpl: makePrViewStub(MERGED_LINKED_PR_VIEW),
      stage1GateRunImpl: async () => ({
        exitCode: 0,
        state: "RESPONSE_RECEIVED",
        matches: [{ body_excerpt: "Codex Review: Didn't find any major issues. Looks good to merge." }], // no created_at
        unboundGenuineMatches: [],
      }),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /qualifying Stage 1 response carries no usable timestamp/);
});

// -- Admissible-prestate guard (issue #596, original #597) --------------------------------

test("run(): --recover true refuses an admissible-prestate violation -- 'none' -- before ever consulting stage1-gate", async () => {
  let stage1Invoked = false;
  const noneBody = AUDIT_LIFECYCLE_BODY.replace("- **Stage 1:** requested", "- **Stage 1:** none");
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, recover: true },
    {
      ghIssueViewImpl: async () => noneBody,
      ghPrViewImpl: makePrViewStub(MERGED_LINKED_PR_VIEW),
      stage1GateRunImpl: async () => {
        stage1Invoked = true;
        return cleanStage1Result();
      },
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /not an admissible --recover true prestate/);
  assert.equal(stage1Invoked, false);
});

test("run(): --recover true refuses an admissible-prestate violation -- satisfied at a different head -- before ever consulting stage1-gate", async () => {
  let stage1Invoked = false;
  const differentHeadBody = AUDIT_LIFECYCLE_BODY.replace("- **Stage 1:** requested", `- **Stage 1:** satisfied at ${OTHER_HEAD}`);
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, recover: true },
    {
      ghIssueViewImpl: async () => differentHeadBody,
      ghPrViewImpl: makePrViewStub(MERGED_LINKED_PR_VIEW),
      stage1GateRunImpl: async () => {
        stage1Invoked = true;
        return cleanStage1Result();
      },
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /not an admissible --recover true prestate/);
  assert.equal(stage1Invoked, false);
});

test("run(): --recover true refuses malformed/unparseable Stage 1 text before ever consulting stage1-gate", async () => {
  let stage1Invoked = false;
  const malformedBody = AUDIT_LIFECYCLE_BODY.replace("- **Stage 1:** requested", "- **Stage 1:** ??? unparseable ???");
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, recover: true },
    {
      ghIssueViewImpl: async () => malformedBody,
      ghPrViewImpl: makePrViewStub(MERGED_LINKED_PR_VIEW),
      stage1GateRunImpl: async () => {
        stage1Invoked = true;
        return cleanStage1Result();
      },
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /not an admissible --recover true prestate/);
  assert.equal(stage1Invoked, false);
});

// -- Near-duplicate field guard in recovery mode (issue #596, original #598) -------------

test("run(): --recover true fails closed on a near-duplicate Stage 1 label before persistence", async () => {
  let writeAttempted = false;
  const ambiguousBody = AUDIT_LIFECYCLE_BODY.replace(
    "- **Stage 1:** requested\n",
    "- **Stage 1:** requested\n- **Stage 1 (updated):** satisfied at deadbeef\n",
  );
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, recover: true },
    {
      ghIssueViewImpl: async () => ambiguousBody,
      ghPrViewImpl: makePrViewStub(MERGED_LINKED_PR_VIEW),
      stage1GateRunImpl: async () => cleanStage1Result(),
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /"Stage 1" field is ambiguous/);
  assert.equal(writeAttempted, false);
});

test("run(): forward path also fails closed on a near-duplicate Stage 1 label before persistence", async () => {
  let writeAttempted = false;
  const ambiguousBody = REVIEW_BODY.replace(
    "- **Stage 1:** requested\n",
    "- **Stage 1:** requested\n- **Stage 1 (current):** satisfied at deadbeef\n",
  );
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590 },
    {
      ghIssueViewImpl: async () => ambiguousBody,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW),
      runNextReviewTransitionGateImpl: async () => satisfiedVerdict({ controlIssue: 587 }),
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /"Stage 1" field is ambiguous/);
  assert.equal(writeAttempted, false);
});

test("run(): --recover true refuses when the PR is not actually merged", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, recover: true },
    {
      ghIssueViewImpl: async () => AUDIT_LIFECYCLE_BODY,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW), // still OPEN
      stage1GateRunImpl: async () => cleanStage1Result(),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /requires the PR to already be MERGED/);
});

test("run(): --recover true refuses a findings-bearing live response, never manufacturing satisfaction", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, recover: true },
    {
      ghIssueViewImpl: async () => AUDIT_LIFECYCLE_BODY,
      ghPrViewImpl: makePrViewStub(MERGED_LINKED_PR_VIEW),
      stage1GateRunImpl: async () => findingsStage1Result(),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /not a genuine clean-pass\/exempt disposition/);
});

test("run(): --recover true never touches an already-stranded correction-satisfied disposition", async () => {
  let writeAttempted = false;
  const correctionBody = AUDIT_LIFECYCLE_BODY.replace(
    "- **Stage 1:** requested",
    `- **Stage 1:** correction-satisfied at ${HEAD} (reviewed ${OTHER_HEAD})`,
  );
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, recover: true },
    {
      ghIssueViewImpl: async () => correctionBody,
      ghPrViewImpl: makePrViewStub(MERGED_LINKED_PR_VIEW),
      stage1GateRunImpl: async () => cleanStage1Result(),
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /never reconciles that stranded shape/);
  assert.equal(writeAttempted, false);
});

test("run(): --recover true is idempotent against an already-recovered disposition", async () => {
  let currentBody = AUDIT_LIFECYCLE_BODY;
  const deps = {
    ghIssueViewImpl: async () => currentBody,
    ghPrViewImpl: makePrViewStub(MERGED_LINKED_PR_VIEW),
    stage1GateRunImpl: async () => cleanStage1Result(),
    writeControlSnapshotImpl: async ({ proposedBody }) => {
      currentBody = proposedBody;
      return { exitCode: 0, state: "WRITTEN" };
    },
  };
  const args = { repo: "owner/repo", controlIssue: 587, executionIssue: 586, pr: 590, recover: true };
  const first = await run(args, deps);
  const bodyAfterFirst = currentBody;
  const second = await run(args, deps);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(currentBody, bodyAfterFirst);
});

test("run(): --recover true still enforces execution/PR linkage checks before ever consulting stage1-gate", async () => {
  let stage1Invoked = false;
  const result = await run(
    { repo: "owner/repo", controlIssue: 587, executionIssue: 999, pr: 590, recover: true },
    {
      ghIssueViewImpl: async () => AUDIT_LIFECYCLE_BODY,
      ghPrViewImpl: makePrViewStub(MERGED_LINKED_PR_VIEW),
      stage1GateRunImpl: async () => {
        stage1Invoked = true;
        return cleanStage1Result();
      },
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED");
  assert.equal(stage1Invoked, false);
});
