// Tests for tools/orchestration/reconcile-control-blocker.mjs — issue #437 (unit 437-B)'s
// deterministic, idempotent completed-prerequisite Blocker-reconciliation primitive.
// Fixture shapes mirror the real #440 reproduction cited in #437's own "Desired outcome"
// and close-control.test.mjs's own coverage conventions.
//
// Run with:
//   node --test tools/orchestration/reconcile-control-blocker.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { checkReconcileControlBlocker, isPrerequisiteSatisfied, buildUnblockedControlBody } from "./reconcile-control-blocker.mjs";

// Standard fixture: a control Issue shaped like #440's real reproduction, but authored with
// the new "Blocked by ..." grammar (design decision point 3) plus the two new companion
// fields (design decision point 4).
const BLOCKED_BODY = `- **Execution:** #440
- **Lifecycle:** BLOCKED
- **Route:** none
- **Blocker:** Blocked by #407, #408, #436.
- **Blocked lifecycle:** READY_FOR_PLAN
- **Blocked route:** planning worker
- **Founder decision:** none
`;

// A real audit-control-issue.yml-shaped body (mirrors ready-dispatch-gate.test.mjs's own
// auditIssueBody fixture) — carries the three headings classifyAuditIssue requires.
function auditIssueBody(verdict) {
  return `This issue is a **read-only Stage 2 control boundary**. Modify nothing.

### Merged PR

https://github.com/LouPineWays/Loop-Dee-Loup/pull/9001

### Work issue

#9000

### Verdict

${verdict}
`;
}

// Default prerequisite fixtures for the standard BLOCKED_BODY control: #407/#408 are
// ordinary closed issues, #436 is a closed Stage 2 Audit Issue recorded CLEAN.
function makeGhIssueViewImpl(overrides = {}) {
  const issues = {
    440: { state: "OPEN", body: BLOCKED_BODY },
    407: { state: "CLOSED", body: "" },
    408: { state: "CLOSED", body: "" },
    436: { state: "CLOSED", body: auditIssueBody("CLEAN") },
    ...overrides,
  };
  return async ({ number }) => {
    const data = issues[Number(number)];
    if (!data) throw new Error(`unexpected ghIssueViewImpl call for number ${number}`);
    return data;
  };
}

// -- isPrerequisiteSatisfied (pure) ----------------------------------------------------------

test("isPrerequisiteSatisfied: an open issue never satisfies, regardless of shape", () => {
  assert.equal(isPrerequisiteSatisfied({ state: "OPEN", body: "" }), false);
  assert.equal(isPrerequisiteSatisfied({ state: "OPEN", body: auditIssueBody("CLEAN") }), false);
});

test("isPrerequisiteSatisfied: a closed ordinary (non-audit-shaped) issue satisfies on closure alone", () => {
  assert.equal(isPrerequisiteSatisfied({ state: "CLOSED", body: "Just a plain closed issue." }), true);
});

test("isPrerequisiteSatisfied: a closed audit-shaped issue satisfies only with a recorded CLEAN verdict", () => {
  assert.equal(isPrerequisiteSatisfied({ state: "CLOSED", body: auditIssueBody("CLEAN") }), true);
  assert.equal(isPrerequisiteSatisfied({ state: "CLOSED", body: auditIssueBody("NOT CLEAN") }), false);
  assert.equal(isPrerequisiteSatisfied({ state: "CLOSED", body: auditIssueBody("PENDING") }), false);
});

// -- buildUnblockedControlBody (pure) --------------------------------------------------------

test("buildUnblockedControlBody: rewrites Blocker/Lifecycle/Route to the reconciled state", () => {
  const next = buildUnblockedControlBody(BLOCKED_BODY, { blockedByIssues: [407, 408, 436], blockedLifecycle: "READY_FOR_PLAN", blockedRoute: "planning worker" });
  assert.match(next, /- \*\*Blocker:\*\* none — #407, #408, #436 closed/);
  assert.match(next, /- \*\*Lifecycle:\*\* READY_FOR_PLAN/);
  assert.match(next, /- \*\*Route:\*\* planning worker/);
});

test("buildUnblockedControlBody: 'Blocked route: unchanged' leaves the existing Route field untouched", () => {
  const next = buildUnblockedControlBody(BLOCKED_BODY, { blockedByIssues: [407], blockedLifecycle: "READY_FOR_PLAN", blockedRoute: "unchanged" });
  assert.match(next, /- \*\*Route:\*\* none/, "the original 'none' Route value from BLOCKED_BODY must be preserved verbatim");
});

// -- checkReconcileControlBlocker -------------------------------------------------------------

test("checkReconcileControlBlocker: exits 1 when required args are missing", async () => {
  const result = await checkReconcileControlBlocker({ repo: "owner/repo" });
  assert.equal(result.exitCode, 1);
});

test("checkReconcileControlBlocker: exits 1 when gh issue view fails for the control issue", async () => {
  const result = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    { ghIssueViewImpl: async () => { throw new Error("not found"); } },
  );
  assert.equal(result.exitCode, 1);
});

test("checkReconcileControlBlocker: ALREADY_TERMINAL — a safe no-op on a control Issue already closed", async () => {
  const result = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    {
      ghIssueViewImpl: async () => ({ state: "CLOSED", body: BLOCKED_BODY }),
      ghEditImpl: () => assert.fail("must not edit an already-closed control Issue"),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "ALREADY_TERMINAL");
  assert.equal(result.controlIssue, 440);
});

// Verification case 1: fixture shaped like #440's reproduction, all named prerequisites
// closed (including one closed Stage-2-audit-shaped prerequisite recorded CLEAN) — reconciles
// to UNBLOCKED with a correctly composed proposed body.
test("checkReconcileControlBlocker: UNBLOCKED — every named prerequisite satisfied composes and persists the reconciled body (Verification case 1)", async () => {
  const calls = [];
  const result = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    { ghIssueViewImpl: makeGhIssueViewImpl(), ghEditImpl: (a) => calls.push(a) },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "UNBLOCKED");
  assert.equal(result.controlIssue, 440);
  assert.deepEqual(result.prerequisitesSatisfied, [407, 408, 436]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /- \*\*Blocker:\*\* none — #407, #408, #436 closed/);
  assert.match(calls[0].body, /- \*\*Lifecycle:\*\* READY_FOR_PLAN/);
  assert.match(calls[0].body, /- \*\*Route:\*\* planning worker/);
});

// Verification case 2: one prerequisite still open yields INCOMPLETE_PREREQUISITE with no
// mutation.
test("checkReconcileControlBlocker: INCOMPLETE_PREREQUISITE — a still-open prerequisite blocks reconciliation, no mutation attempted (Verification case 2)", async () => {
  const result = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    {
      ghIssueViewImpl: makeGhIssueViewImpl({ 407: { state: "OPEN", body: "" } }),
      ghEditImpl: () => assert.fail("must not mutate while a prerequisite is still open"),
    },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "INCOMPLETE_PREREQUISITE");
  assert.deepEqual(result.pending, [407]);
});

// Verification case 3: a closed prerequisite that is audit-shaped but recorded NOT
// CLEAN/PENDING yields INCOMPLETE_PREREQUISITE, not UNBLOCKED.
test("checkReconcileControlBlocker: INCOMPLETE_PREREQUISITE — a closed audit-shaped prerequisite recorded NOT CLEAN never silently passes on closure alone (Verification case 3)", async () => {
  const result = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    {
      ghIssueViewImpl: makeGhIssueViewImpl({ 436: { state: "CLOSED", body: auditIssueBody("NOT CLEAN") } }),
      ghEditImpl: () => assert.fail("must not mutate on a NOT CLEAN audit prerequisite"),
    },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "INCOMPLETE_PREREQUISITE");
  assert.deepEqual(result.pending, [436]);
});

test("checkReconcileControlBlocker: INCOMPLETE_PREREQUISITE — a closed audit-shaped prerequisite recorded PENDING never silently passes (Verification case 3)", async () => {
  const result = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    { ghIssueViewImpl: makeGhIssueViewImpl({ 436: { state: "CLOSED", body: auditIssueBody("PENDING") } }) },
  );
  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.pending, [436]);
});

// Verification case 4: a Blocker naming three prerequisites where only two are satisfied
// yields INCOMPLETE_PREREQUISITE for the whole control, not a partial clear.
test("checkReconcileControlBlocker: INCOMPLETE_PREREQUISITE — two of three prerequisites satisfied still blocks the whole control, no partial clear (Verification case 4)", async () => {
  const result = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    {
      ghIssueViewImpl: makeGhIssueViewImpl({ 408: { state: "OPEN", body: "" } }),
      ghEditImpl: () => assert.fail("must not partially clear the Blocker"),
    },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "INCOMPLETE_PREREQUISITE");
  assert.deepEqual(result.pending, [408]);
});

// Verification case 5: a Blocker field using free prose with no recognized "blocked by ...
// ." clause (the actual historical #440 shape) yields AMBIGUOUS_BLOCKER with no mutation.
test("checkReconcileControlBlocker: AMBIGUOUS_BLOCKER — real historical #440 free-prose Blocker shape is never guessed at (Verification case 5)", async () => {
  const freeProseBody = BLOCKED_BODY.replace(
    "- **Blocker:** Blocked by #407, #408, #436.",
    "- **Blocker:** #407/#408 must first terminalize their already-CLEAN #436 cycle so the new follow-up defect does not contaminate PR #435's audited result.",
  );
  const result = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    {
      ghIssueViewImpl: async ({ number }) => (Number(number) === 440 ? { state: "OPEN", body: freeProseBody } : assert.fail("must not fetch prerequisites for an unrecognized Blocker clause")),
      ghEditImpl: () => assert.fail("must not mutate on an unrecognized Blocker clause"),
    },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "AMBIGUOUS_BLOCKER");
});

// Verification case 6: a recognized Blocker clause missing "Blocked lifecycle"/"Blocked
// route" yields AMBIGUOUS_BLOCKER.
test("checkReconcileControlBlocker: AMBIGUOUS_BLOCKER — a recognized clause with no 'Blocked lifecycle'/'Blocked route' companion fields fails closed (Verification case 6)", async () => {
  const noCompanionFields = BLOCKED_BODY.replace("- **Blocked lifecycle:** READY_FOR_PLAN\n", "").replace("- **Blocked route:** planning worker\n", "");
  const result = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    {
      ghIssueViewImpl: async ({ number }) => (Number(number) === 440 ? { state: "OPEN", body: noCompanionFields } : assert.fail("must not fetch prerequisites when companion fields are missing")),
      ghEditImpl: () => assert.fail("must not mutate when companion fields are missing"),
    },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "AMBIGUOUS_BLOCKER");
});

// Verification case 7: re-running against an already-"none" Blocker yields
// ALREADY_UNBLOCKED with no mutation (idempotence).
test("checkReconcileControlBlocker: ALREADY_UNBLOCKED — an already-'none' Blocker is a safe idempotent no-op (Verification case 7)", async () => {
  const unblockedBody = BLOCKED_BODY.replace("- **Blocker:** Blocked by #407, #408, #436.", "- **Blocker:** none — #407, #408, #436 closed");
  const result = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    {
      ghIssueViewImpl: async ({ number }) => (Number(number) === 440 ? { state: "OPEN", body: unblockedBody } : assert.fail("must not fetch prerequisites when already unblocked")),
      ghEditImpl: () => assert.fail("must not re-edit an already-unblocked control Issue"),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "ALREADY_UNBLOCKED");
});

test("checkReconcileControlBlocker: ALREADY_UNBLOCKED — a control Issue with no Blocker bullet at all is also a safe no-op", async () => {
  const noBlockerBody = "- **Lifecycle:** READY\n- **Execution:** #440\n";
  const result = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    { ghIssueViewImpl: async () => ({ state: "OPEN", body: noBlockerBody }) },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "ALREADY_UNBLOCKED");
});

// Verification case 8: a proposed body with duplicate "Blocker:"/"Founder decision:"
// bullets is rejected by write-control-snapshot.mjs via the new control-field-validator.mjs
// specs.
test("checkReconcileControlBlocker: REJECTED — a pre-existing duplicate 'Founder decision' bullet elsewhere in the body is refused at the write boundary (Verification case 8)", async () => {
  const duplicateFounderDecisionBody = `${BLOCKED_BODY}- **Founder decision:** none — stray duplicate\n`;
  const result = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    {
      ghIssueViewImpl: makeGhIssueViewImpl({ 440: { state: "OPEN", body: duplicateFounderDecisionBody } }),
      ghEditImpl: () => assert.fail("an invalid composed body must never reach the write implementation"),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "REJECTED");
  assert.ok(result.errors.some((e) => /"Founder decision" reference is ambiguous/.test(e)));
});

test("checkReconcileControlBlocker: AMBIGUOUS_BLOCKER — an unreadable named prerequisite fails closed rather than crashing", async () => {
  const result = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    {
      ghIssueViewImpl: async ({ number }) => {
        if (Number(number) === 440) return { state: "OPEN", body: BLOCKED_BODY };
        throw new Error("gh: issue not found");
      },
    },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "AMBIGUOUS_BLOCKER");
  assert.match(result.reason, /could not be read/);
});

test("checkReconcileControlBlocker: a gh issue edit failure during the write step is an operational error", async () => {
  const result = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    {
      ghIssueViewImpl: makeGhIssueViewImpl(),
      ghEditImpl: () => { throw new Error("gh: network error"); },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh issue edit failed/);
});

test("checkReconcileControlBlocker: a subsequent fresh run against the just-written UNBLOCKED body is idempotent (ALREADY_UNBLOCKED)", async () => {
  let writtenBody = null;
  const first = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    { ghIssueViewImpl: makeGhIssueViewImpl(), ghEditImpl: (a) => { writtenBody = a.body; } },
  );
  assert.equal(first.exitCode, 0);
  assert.equal(first.state, "UNBLOCKED");
  assert.ok(writtenBody);

  const second = await checkReconcileControlBlocker(
    { repo: "owner/repo", "control-issue": 440 },
    {
      ghIssueViewImpl: async ({ number }) => (Number(number) === 440 ? { state: "OPEN", body: writtenBody } : assert.fail("must not fetch prerequisites on the idempotent rerun")),
      ghEditImpl: () => assert.fail("must not re-edit on the idempotent rerun"),
    },
  );
  assert.equal(second.exitCode, 0);
  assert.equal(second.state, "ALREADY_UNBLOCKED");
});
