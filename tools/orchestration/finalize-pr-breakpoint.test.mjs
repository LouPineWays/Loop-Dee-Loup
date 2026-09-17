// Tests for tools/orchestration/finalize-pr-breakpoint.mjs — issue #456 unit 456-A's
// deterministic PR/Stage-1 breakpoint finalize step.
//
// Run with:
//   node --test tools/orchestration/finalize-pr-breakpoint.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  run,
  verifyExecutionMatches,
  verifyPrLinkage,
  verifyPrHeadIsCurrent,
  determineStage1Value,
  composeFinalizedControlBody,
  verifyFinalizedBody,
  canonicalizePreStage2Bullet,
} from "./finalize-pr-breakpoint.mjs";

const READY_BODY = `## Current state

- **Lifecycle:** READY
- **Execution:** #447
- **Route:** implementation worker
- **PR:** none
- **Stage 1:** none
- **Blocker:** none
- **Founder decision:** none
`;

const EXECUTION_COMPLETE_BODY = `## Current state

- **Lifecycle:** EXECUTION_COMPLETE
- **Execution:** #537
- **Route:** stronger/general worker
- **PR:** none
- **Stage 1:** none
- **Blocker:** none
- **Founder decision:** none
`;

// Issue #563 / #560's exact real-world shape: a control Issue authored from the shipped
// `.github/ISSUE_TEMPLATE/parent-execution.yml` template, which renders Lifecycle as the
// "### State" dropdown heading rather than an ad hoc "- **Lifecycle:**" bullet — no such
// bullet exists anywhere in this body at all. The Execution/Route/PR/Stage 1 fields still use
// the ad hoc bullet convention inside the template's own "### Current state" textarea, per
// that field's own description ("also include explicit `- **Execution:** #N` ... bullet lines
// here"). Discovered live blocking #560's PR #562 finalize.
const STATE_HEADING_BODY = `### Source item

https://github.com/LouPineWays/Loop-Dee-Loup/issues/559

### State

READY

### Accepted outcome

Some accepted outcome.

### Current state

- **Execution:** #559
- **Route:** implementation worker
- **PR:** none
- **Stage 1:** none

### Settled decisions

None.

### Current blocker

None

### Founder interrupt

None
`;

// Issue #581's own #577 live reproduction: the exact hybrid shape naming both a `### State`
// heading (READY) and a redundant ad hoc "- **Lifecycle:**" bullet (also READY, per #577's own
// authored body) inside the template's "### Current state" field.
const HYBRID_577_BODY = STATE_HEADING_BODY.replace(
  "### Current state\n\n- **Execution:** #559",
  "### Current state\n\n- **Lifecycle:** READY\n- **Execution:** #559",
);

const LINKED_PR_VIEW_559 = { headRefName: "issue-559-some-fix", headRefOid: "abc1234", body: "Addresses #559.", state: "OPEN" };

// A `gh pr view` result satisfying the Shared Contract's PR-to-execution-Issue linkage
// convention for execution Issue #447 at head "579188a" (the #447/#453 shape) / #537 at head
// "6dc93ac" (the #537/#540 shape) — used as the default `ghPrViewImpl` stub in every run()
// test below that isn't specifically exercising the linkage/head-freshness checks themselves.
const LINKED_PR_VIEW_447 = { headRefName: "issue-447-stage2-response-unusable", headRefOid: "579188a", body: "Addresses #447.", state: "OPEN" };
const LINKED_PR_VIEW_537 = { headRefName: "some-other-branch", headRefOid: "6dc93ac", body: "Addresses #537.", state: "OPEN" };

function makePrViewStub(view) {
  return async () => view;
}

// -- Pure helpers --------------------------------------------------------------------------

test("verifyExecutionMatches: accepts a control body whose Execution pointer names the given execution Issue", () => {
  const result = verifyExecutionMatches(READY_BODY, 447);
  assert.equal(result.ok, true);
});

test("verifyExecutionMatches: rejects a mismatched Execution pointer — never finalize against the wrong control Issue", () => {
  const result = verifyExecutionMatches(READY_BODY, 999);
  assert.equal(result.ok, false);
  assert.match(result.reason, /names #447, not the given --execution-issue #999/);
});

test("verifyExecutionMatches: rejects a control body with no Execution bullet at all", () => {
  const result = verifyExecutionMatches("- **Lifecycle:** READY\n", 447);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no Execution\/Execution issue bullet/);
});

test("verifyPrLinkage: accepts a PR whose branch/body satisfies the Shared Contract's linkage convention", () => {
  assert.equal(verifyPrLinkage(LINKED_PR_VIEW_447, 447).ok, true);
  assert.equal(verifyPrLinkage({ headRefName: "unrelated-branch", body: "unrelated" }, 447).ok, false);
});

test("verifyPrLinkage: rejects a PR that only mentions the execution Issue in passing (Stage 1 finding on PR #547)", () => {
  const result = verifyPrLinkage({ headRefName: "unrelated-branch", body: "See also #447 for background." }, 447);
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not reference execution Issue #447/);
});

test("verifyPrHeadIsCurrent: accepts a --head matching the PR's live headRefOid", () => {
  assert.equal(verifyPrHeadIsCurrent({ headRefOid: "579188a" }, "579188a").ok, true);
});

test("verifyPrHeadIsCurrent: rejects a stale --head that no longer matches the PR's live head (Stage 1 finding on PR #547)", () => {
  const result = verifyPrHeadIsCurrent({ headRefOid: "abcdef1" }, "579188a");
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match the PR's live head/);
});

test("determineStage1Value: EXEMPT carries the recorded exemption reason verbatim", () => {
  const result = determineStage1Value({ exitCode: 0, state: "EXEMPT", reason: "docs typo fix, not review-worthy" });
  assert.deepEqual(result, { ok: true, value: "exempt: docs typo fix, not review-worthy" });
});

test("determineStage1Value: PENDING and RESPONSE_RECEIVED both resolve to \"requested\"", () => {
  assert.deepEqual(determineStage1Value({ exitCode: 2, state: "PENDING" }), { ok: true, value: "requested" });
  assert.deepEqual(determineStage1Value({ exitCode: 0, state: "RESPONSE_RECEIVED" }), { ok: true, value: "requested" });
});

test("determineStage1Value: NOT_REQUESTED fails closed — the caller's claim that Stage 1 was requested is not backed by evidence", () => {
  const result = determineStage1Value({ exitCode: 2, state: "NOT_REQUESTED" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /NOT_REQUESTED/);
});

test("determineStage1Value: an operational stage1-gate failure also fails closed", () => {
  const result = determineStage1Value({ exitCode: 1, message: "gh pr view failed" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /gh pr view failed/);
});

test("composeFinalizedControlBody: from READY, sets PR/Stage 1/Lifecycle and leaves every other field untouched", () => {
  const result = composeFinalizedControlBody(READY_BODY, { pr: 453, stage1Value: "requested" });
  assert.equal(result.ok, true);
  assert.match(result.body, /- \*\*PR:\*\* #453/);
  assert.match(result.body, /- \*\*Stage 1:\*\* requested/);
  assert.match(result.body, /- \*\*Lifecycle:\*\* REVIEW/);
  assert.match(result.body, /- \*\*Execution:\*\* #447/);
  assert.match(result.body, /- \*\*Route:\*\* implementation worker/);
  assert.match(result.body, /- \*\*Blocker:\*\* none/);
  assert.match(result.body, /- \*\*Founder decision:\*\* none/);
});

test("composeFinalizedControlBody: from EXECUTION_COMPLETE (Integration/PR worker route), also transitions to REVIEW", () => {
  const result = composeFinalizedControlBody(EXECUTION_COMPLETE_BODY, { pr: 540, stage1Value: "requested" });
  assert.equal(result.ok, true);
  assert.match(result.body, /- \*\*Lifecycle:\*\* REVIEW/);
  assert.match(result.body, /- \*\*PR:\*\* #540/);
});

test("composeFinalizedControlBody: re-running against an already-finalized REVIEW body is a safe no-op (idempotence)", () => {
  const alreadyFinalized = READY_BODY.replace("- **Lifecycle:** READY", "- **Lifecycle:** REVIEW").replace("- **PR:** none", "- **PR:** #453").replace("- **Stage 1:** none", "- **Stage 1:** requested");
  const result = composeFinalizedControlBody(alreadyFinalized, { pr: 453, stage1Value: "requested" });
  assert.equal(result.ok, true);
  assert.equal(result.body, alreadyFinalized);
});

test("composeFinalizedControlBody: falls back to the '### State' heading when no ad hoc Lifecycle bullet exists (issue #563 / #560's shape)", () => {
  const result = composeFinalizedControlBody(STATE_HEADING_BODY, { pr: 562, stage1Value: "requested" });
  assert.equal(result.ok, true);
  assert.match(result.body, /- \*\*PR:\*\* #562/);
  assert.match(result.body, /- \*\*Stage 1:\*\* requested/);
  // upsertControlBullet updates the "### State" heading's value in place rather than inserting
  // a brand-new ad hoc "- **Lifecycle:**" bullet — see its own comment block.
  assert.match(result.body, /### State\n\nREVIEW/);
  assert.doesNotMatch(result.body, /### State\n\nREADY/);
  assert.doesNotMatch(result.body, /- \*\*Lifecycle:\*\*/);
  // Every other field must survive untouched.
  assert.match(result.body, /- \*\*Execution:\*\* #559/);
  assert.match(result.body, /- \*\*Route:\*\* implementation worker/);
});

// -- Issue #581 (the #577 live reproduction): hybrid State/Lifecycle drift --------------------

test("composeFinalizedControlBody: the exact #577 hybrid shape (State=READY, Lifecycle=READY) converges both representations to REVIEW, never leaving '### State' stale (Required check 1)", () => {
  const result = composeFinalizedControlBody(HYBRID_577_BODY, { pr: 578, stage1Value: "requested" });
  assert.equal(result.ok, true);
  assert.match(result.body, /### State\n\nREVIEW/);
  assert.doesNotMatch(result.body, /### State\n\nREADY/);
  assert.match(result.body, /- \*\*Lifecycle:\*\* REVIEW/);
  assert.match(result.body, /- \*\*PR:\*\* #578/);
  assert.match(result.body, /- \*\*Execution:\*\* #559/);
});

// -- Issue #450 (the #428 live reproduction): canonicalizing the legacy pre-Stage-2 sentinel --

test("canonicalizePreStage2Bullet: normalizes the one demonstrated legacy synonym ('not started') to the canonical 'none' sentinel", () => {
  const body = "- **Lifecycle:** REVIEW\n- **Stage 2:** not started\n";
  const result = canonicalizePreStage2Bullet(body);
  assert.match(result, /- \*\*Stage 2:\*\* none/);
});

test("canonicalizePreStage2Bullet: leaves an already-canonical 'none' value, a real #N reference, an absent bullet, and any other value untouched", () => {
  assert.equal(canonicalizePreStage2Bullet("- **Stage 2:** none\n"), "- **Stage 2:** none\n");
  assert.equal(canonicalizePreStage2Bullet("- **Stage 2:** #480\n"), "- **Stage 2:** #480\n");
  assert.equal(canonicalizePreStage2Bullet("- **Lifecycle:** READY\n"), "- **Lifecycle:** READY\n");
  // Not the legacy sentinel -- left for write-control-snapshot.mjs's own validator to reject.
  assert.equal(canonicalizePreStage2Bullet("- **Stage 2:** pending\n"), "- **Stage 2:** pending\n");
});

// Stage 1 review finding on PR #569: a trailing explanation carrying a real issue/PR pointer
// contradicts the "not started" reading and must not be erased by canonicalization.
test("canonicalizePreStage2Bullet: leaves a contradictory 'not started' value carrying a real pointer untouched", () => {
  assert.equal(
    canonicalizePreStage2Bullet("- **Stage 2:** not started — previous audit #480\n"),
    "- **Stage 2:** not started — previous audit #480\n",
  );
  assert.equal(
    canonicalizePreStage2Bullet(
      "- **Stage 2:** not started — see https://github.com/LouPineWays/Loop-Dee-Loup/issues/480\n",
    ),
    "- **Stage 2:** not started — see https://github.com/LouPineWays/Loop-Dee-Loup/issues/480\n",
  );
});

const CONTROL_BODY_428_SHAPE_FOR_FINALIZE = `## Current state

- **Lifecycle:** REVIEW
- **Execution:** #447
- **Route:** implementation worker
- **PR:** #453
- **Stage 1:** requested
- **Stage 2:** not started
- **Blocker:** none
- **Founder decision:** none
`;

test("composeFinalizedControlBody: the exact #428 shape -- a legacy 'Stage 2: not started' bullet already present on the control Issue is canonicalized to 'none' as part of the REVIEW transition", () => {
  const result = composeFinalizedControlBody(CONTROL_BODY_428_SHAPE_FOR_FINALIZE, { pr: 453, stage1Value: "requested" });
  assert.equal(result.ok, true);
  assert.match(result.body, /- \*\*Stage 2:\*\* none/);
  assert.doesNotMatch(result.body, /not started/);
});

test("composeFinalizedControlBody: a real Stage 2 reference is never clobbered by the canonicalization step", () => {
  const bodyWithRealStage2 = READY_BODY.replace("- **PR:** none", "- **PR:** #453") + "- **Stage 2:** #480\n";
  const result = composeFinalizedControlBody(bodyWithRealStage2, { pr: 453, stage1Value: "requested" });
  assert.equal(result.ok, true);
  assert.match(result.body, /- \*\*Stage 2:\*\* #480/);
});

test("verifyFinalizedBody: rejects a fresh read-back that still carries the legacy pre-start sentinel (a silent write no-op)", () => {
  const result = verifyFinalizedBody(CONTROL_BODY_428_SHAPE_FOR_FINALIZE, { pr: 453, stage1Value: "requested" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /legacy pre-start sentinel/);
});

test("composeFinalizedControlBody: refuses to overwrite a Lifecycle value it was not authorized to transition from (e.g. mid-cycle CORRECTION)", () => {
  const correctionBody = READY_BODY.replace("- **Lifecycle:** READY", "- **Lifecycle:** CORRECTION");
  const result = composeFinalizedControlBody(correctionBody, { pr: 453, stage1Value: "requested" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not one of the recognized pre-finalize values/);
});

test("composeFinalizedControlBody: from AUDIT (Stage 2 NOT CLEAN correction-worker route, issue #646), also transitions to REVIEW", () => {
  const auditBody = READY_BODY.replace("- **Lifecycle:** READY", "- **Lifecycle:** AUDIT").replace(
    "- **Stage 1:** none",
    "- **Stage 1:** none\n- **Stage 2:** #643",
  );
  const result = composeFinalizedControlBody(auditBody, { pr: 644, stage1Value: "requested" });
  assert.equal(result.ok, true);
  assert.match(result.body, /- \*\*PR:\*\* #644/);
  assert.match(result.body, /- \*\*Stage 1:\*\* requested/);
  assert.match(result.body, /- \*\*Lifecycle:\*\* REVIEW/);
  // The prior audit's own Stage 2 pointer is left exactly as-is -- it remains the
  // most-recent-Stage-2-audit reference until the correction PR's own eventual merge
  // triggers a fresh Stage 2 and finalize-audit-breakpoint.mjs overwrites it.
  assert.match(result.body, /- \*\*Stage 2:\*\* #643/);
});

test("verifyFinalizedBody: accepts a fresh body carrying the exact composed bullets", () => {
  const composed = composeFinalizedControlBody(READY_BODY, { pr: 453, stage1Value: "requested" });
  const result = verifyFinalizedBody(composed.body, { pr: 453, stage1Value: "requested" });
  assert.equal(result.ok, true);
});

test("verifyFinalizedBody: rejects a fresh read-back that does not actually carry the PR bullet just composed (e.g. the gh write silently no-oped)", () => {
  const result = verifyFinalizedBody(READY_BODY, { pr: 453, stage1Value: "requested" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /PR bullet/);
});

test("verifyFinalizedBody: recognizes a '### State' heading updated in place as the finalized Lifecycle, on a template-shaped body with no ad hoc Lifecycle bullet (issue #563)", () => {
  const composed = composeFinalizedControlBody(STATE_HEADING_BODY, { pr: 562, stage1Value: "requested" });
  assert.equal(composed.ok, true);
  const result = verifyFinalizedBody(composed.body, { pr: 562, stage1Value: "requested" });
  assert.equal(result.ok, true);
});

test("verifyFinalizedBody: still rejects a template-shaped read-back whose '### State' heading was never actually updated (write silently no-oped)", () => {
  const result = verifyFinalizedBody(STATE_HEADING_BODY, { pr: 562, stage1Value: "requested" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /PR bullet/);
});

// -- run(): end-to-end with injected implementations ----------------------------------------

function makeStage1GateStub(result) {
  return async () => result;
}

test("run(): Verification scenario 4 — normal direct-worker PR creation persists PR+Stage1+Lifecycle, verified by a fresh read-back", async () => {
  let currentBody = READY_BODY;
  const writeCalls = [];
  const result = await run(
    { repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_447),
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 2, state: "PENDING", triggerTimestamp: "2026-01-01T00:00:00Z" }),
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        writeCalls.push(proposedBody);
        currentBody = proposedBody; // simulate the durable write actually landing
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "FINALIZED");
  assert.equal(result.message, "FINALIZED 448 447 453");
  assert.equal(writeCalls.length, 1);
  assert.match(writeCalls[0], /- \*\*PR:\*\* #453/);
  assert.match(writeCalls[0], /- \*\*Stage 1:\*\* requested/);
  assert.match(writeCalls[0], /- \*\*Lifecycle:\*\* REVIEW/);
});

test("run(): a recorded Stage 1 exemption is persisted verbatim from durable PR-body evidence, not from the caller's own claim", async () => {
  let currentBody = EXECUTION_COMPLETE_BODY;
  const result = await run(
    { repo: "owner/repo", controlIssue: 539, executionIssue: 537, pr: 540, head: "6dc93ac" },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_537),
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 0, state: "EXEMPT", reason: "consumer-sync PR, not review-worthy" }),
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        currentBody = proposedBody;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stage1, "exempt: consumer-sync PR, not review-worthy");
  assert.match(currentBody, /- \*\*Stage 1:\*\* exempt: consumer-sync PR, not review-worthy/);
});

test("run(): Verification scenario 5 — a control-write failure fails closed with PR_BREAKPOINT_UNVERIFIED, control body left unchanged", async () => {
  const originalBody = READY_BODY;
  let currentBody = originalBody;
  const result = await run(
    { repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_447),
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 2, state: "PENDING" }),
      writeControlSnapshotImpl: async () => ({ exitCode: 2, state: "REJECTED", errors: ["simulated validation rejection"] }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PR_BREAKPOINT_UNVERIFIED");
  assert.equal(result.message, "PR_BREAKPOINT_UNVERIFIED 448 447 453");
  assert.equal(currentBody, originalBody, "the durable control body must be left exactly as it was on a write failure");
});

test("run(): issue #563 regression — a control Issue authored with '### State' (no ad hoc Lifecycle bullet, #560's exact shape) now finalizes as FINALIZED instead of failing closed with PR_BREAKPOINT_UNVERIFIED", async () => {
  let currentBody = STATE_HEADING_BODY;
  const writeCalls = [];
  const result = await run(
    { repo: "owner/repo", controlIssue: 560, executionIssue: 559, pr: 562, head: "abc1234" },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_559),
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 2, state: "PENDING" }),
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        writeCalls.push(proposedBody);
        currentBody = proposedBody; // simulate the durable write actually landing
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "FINALIZED");
  assert.equal(result.message, "FINALIZED 560 559 562");
  assert.equal(writeCalls.length, 1);
  assert.match(writeCalls[0], /- \*\*PR:\*\* #562/);
  assert.match(writeCalls[0], /- \*\*Stage 1:\*\* requested/);
  assert.match(writeCalls[0], /### State\n\nREVIEW/);
});

test("run(): issue #581 regression — replaying the exact #577 hybrid transition (State=READY, Lifecycle=READY -> REVIEW) end to end leaves one coherent durable value, never a stale '### State' (Required check 1)", async () => {
  let currentBody = HYBRID_577_BODY;
  const writeCalls = [];
  const result = await run(
    { repo: "owner/repo", controlIssue: 560, executionIssue: 559, pr: 578, head: "abc1234" },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_559),
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 2, state: "PENDING" }),
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        writeCalls.push(proposedBody);
        currentBody = proposedBody; // simulate the durable write actually landing
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "FINALIZED");
  assert.equal(writeCalls.length, 1);
  // Both lifecycle representations converge to REVIEW — the exact #577 drift (one advancing
  // while the other stayed stale) can no longer occur.
  assert.match(writeCalls[0], /### State\n\nREVIEW/);
  assert.doesNotMatch(writeCalls[0], /### State\n\nREADY/);
  assert.match(writeCalls[0], /- \*\*Lifecycle:\*\* REVIEW/);
  assert.match(currentBody, /### State\n\nREVIEW/);
  assert.match(currentBody, /- \*\*Lifecycle:\*\* REVIEW/);
});

test("run(): a caller claiming the PR crossed the breakpoint when no Stage 1 trigger actually exists fails closed, never reporting ordinary success", async () => {
  let writeAttempted = false;
  const result = await run(
    { repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" },
    {
      ghIssueViewImpl: async () => READY_BODY,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_447),
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 2, state: "NOT_REQUESTED" }),
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PR_BREAKPOINT_UNVERIFIED");
  assert.equal(writeAttempted, false, "NOT_REQUESTED must be caught before any write is even attempted");
});

test("run(): Verification scenario 6 — idempotence: repeated finalize against the same PR/head does not corrupt the control body or re-trigger anything", async () => {
  let currentBody = READY_BODY;
  const stage1Calls = [];
  const deps = {
    ghIssueViewImpl: async () => currentBody,
    ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_447),
    stage1GateRunImpl: async (args) => {
      stage1Calls.push(args);
      return { exitCode: 2, state: "PENDING" };
    },
    writeControlSnapshotImpl: async ({ proposedBody }) => {
      currentBody = proposedBody;
      return { exitCode: 0, state: "WRITTEN" };
    },
  };
  const first = await run({ repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" }, deps);
  const bodyAfterFirst = currentBody;
  const second = await run({ repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" }, deps);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(currentBody, bodyAfterFirst, "a second finalize against the same already-finalized state must not further mutate the control body");
  assert.equal(stage1Calls.length, 2, "finalize itself never posts a trigger — it only re-reads existing Stage 1 evidence each time, so no duplicate trigger is possible");
});

test("run(): a mismatched --execution-issue fails closed rather than finalizing against the wrong control Issue", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 448, executionIssue: 999, pr: 453, head: "579188a" },
    {
      ghIssueViewImpl: async () => READY_BODY,
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 2, state: "PENDING" }),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PR_BREAKPOINT_UNVERIFIED");
});

test("run(): a write-control-snapshot success whose fresh read-back does not actually reflect it fails closed (never trusts the write call's own return value)", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" },
    {
      ghIssueViewImpl: async () => READY_BODY, // never actually updated, simulating a silent gh no-op
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_447),
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 2, state: "PENDING" }),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PR_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /PR bullet/);
});

test("run(): operational error on missing/invalid required args, distinct from PR_BREAKPOINT_UNVERIFIED", async () => {
  const result = await run({ repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "" });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--head is required/);
});

test("run(): true pre-PR negative control is not this script's concern — a control Issue with no PR should never be pointed at this script at all, but if it is, a genuinely linked PR at the current head still finalizes normally", async () => {
  // This script is only ever invoked once a PR genuinely exists (per its own dispatch-prompt
  // wiring). It now independently verifies the given PR actually belongs to the execution
  // Issue (verifyPrLinkage) and that --head is still the PR's live head (verifyPrHeadIsCurrent)
  // before ever trusting stage1-gate.mjs's evidence — see the dedicated linkage/head-mismatch
  // tests below for the negative cases those checks now cover (Stage 1 findings on PR #547).
  let currentBody = READY_BODY;
  const result = await run(
    { repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_447),
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 2, state: "PENDING" }),
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        currentBody = proposedBody;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
});

test("run(): a PR that does not satisfy the linkage convention fails closed before any write is attempted (Stage 1 finding on PR #547)", async () => {
  let writeAttempted = false;
  const result = await run(
    { repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 999, head: "579188a" },
    {
      ghIssueViewImpl: async () => READY_BODY,
      ghPrViewImpl: makePrViewStub({ headRefName: "unrelated-branch", headRefOid: "579188a", body: "See also #447 for background.", state: "OPEN" }),
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 2, state: "PENDING" }),
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PR_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /does not reference execution Issue #447/);
  assert.equal(writeAttempted, false);
});

test("run(): a stale --head that no longer matches the PR's live head fails closed before Stage 1 evidence is even consulted (Stage 1 finding on PR #547)", async () => {
  const stage1Calls = [];
  const result = await run(
    { repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" },
    {
      ghIssueViewImpl: async () => READY_BODY,
      ghPrViewImpl: makePrViewStub({ ...LINKED_PR_VIEW_447, headRefOid: "9999999" }),
      stage1GateRunImpl: async (args) => {
        stage1Calls.push(args);
        return { exitCode: 2, state: "PENDING" };
      },
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PR_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /does not match the PR's live head/);
  assert.equal(stage1Calls.length, 0, "a stale head must be rejected before stage1-gate.mjs is even consulted at that head");
});

test("run(): re-reads the control Issue immediately before composing/writing so a concurrently-added Blocker survives (Stage 1 finding on PR #547)", async () => {
  let currentBody = READY_BODY;
  const writeCalls = [];
  const result = await run(
    { repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" },
    {
      ghIssueViewImpl: async () => currentBody,
      ghPrViewImpl: makePrViewStub(LINKED_PR_VIEW_447),
      stage1GateRunImpl: async () => {
        // Simulate a concurrent session recording a blocker while this finalize step's own
        // stage1-gate.mjs call is in flight — the exact race the finding describes.
        currentBody = currentBody.replace("- **Blocker:** none", "- **Blocker:** waiting on founder input recorded mid-flight");
        return { exitCode: 2, state: "PENDING" };
      },
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        writeCalls.push(proposedBody);
        currentBody = proposedBody; // simulate the durable write actually landing
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.match(writeCalls[0], /- \*\*Blocker:\*\* waiting on founder input recorded mid-flight/, "the concurrently-recorded Blocker must survive into the composed write, not be clobbered by the stale pre-fetch body");
});
