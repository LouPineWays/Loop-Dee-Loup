import { test } from "node:test";
import assert from "node:assert/strict";
import { getActionEnvelope, classifyEnvelopeCompliance, knownEnvelopeStates, ENVELOPE_MODES } from "./action-envelope.mjs";

// -- getActionEnvelope: table shape -----------------------------------------------------

test("getActionEnvelope: every ready-dispatch-gate.mjs and next-review-transition-gate.mjs verdict state is recognized", () => {
  const expected = [
    "BLOCKED",
    "NOT_READY",
    "READY_TO_DISPATCH",
    "READY_TO_DISPATCH_PLANNING",
    "READY_TO_RUN_DISPATCH_MANIFEST",
    "READY_TO_PROJECT_PLAN_READY",
    "READY_TO_PROJECT_ROUTED",
    "READY_TO_DISPATCH_UNITS",
    "READY_TO_DISPATCH_INTEGRATION",
    "REPLAN_REQUIRED",
    "AUDIT_ISSUE_DETECTED",
    "AMBIGUOUS",
    "NO_ACTION_YET",
    "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2",
    "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2",
    "STAGE1_CORRECTION_REQUIRED",
    "STAGE2_CORRECTION_REQUIRED",
    "STAGE2_CLOSE_READY",
    "STAGE2_REPORT_READY_TO_RECORD",
    "STAGE2_RESPONSE_UNUSABLE",
  ];
  const known = knownEnvelopeStates();
  for (const state of expected) assert.ok(known.includes(state), `missing envelope for ${state}`);
  assert.equal(known.length, expected.length, "envelope table has an unexpected extra/missing entry");
});

test("getActionEnvelope: an unrecognized or absent state fails closed to mode none with zero authorized actions", () => {
  assert.deepEqual(getActionEnvelope("SOME_UNKNOWN_STATE"), {
    mode: "none",
    authorizedActions: [],
    reason: "unrecognized or absent verdict state; fails closed to zero further authorized action",
  });
  assert.equal(getActionEnvelope(undefined).mode, "none");
  assert.equal(getActionEnvelope(null).mode, "none");
});

test("getActionEnvelope: returns a fresh array each call (callers cannot mutate the shared table)", () => {
  const a = getActionEnvelope("READY_TO_DISPATCH_PLANNING");
  a.authorizedActions.push("something-else");
  const b = getActionEnvelope("READY_TO_DISPATCH_PLANNING");
  assert.deepEqual(b.authorizedActions, ["dispatch-planning-worker", "write-control-snapshot"]);
});

// -- classifyEnvelopeCompliance: no-action verdicts --------------------------------------
// Verification class 1 (#440 no-action stop) and 2 (founder/fail-closed stop).

test("#440 shape: STAGE2_RESPONSE_UNUSABLE authorizes zero further action; the full incident sequence is a violation", () => {
  const result = classifyEnvelopeCompliance("STAGE2_RESPONSE_UNUSABLE", [
    "repository-reconnaissance",
    "self-authorized-issue-creation",
    "implementation-edit",
    "pr-mutation",
  ]);
  assert.equal(result.status, "violation");
  assert.equal(result.envelope.mode, "none");
  assert.equal(result.reasons.length, 4);
  assert.ok(result.reasons.some((r) => r.includes("repository-reconnaissance")));
  assert.ok(result.reasons.some((r) => r.includes("self-authorized-issue-creation")));
});

test("STAGE2_RESPONSE_UNUSABLE: a concise handoff with no further action is compliant", () => {
  assert.deepEqual(classifyEnvelopeCompliance("STAGE2_RESPONSE_UNUSABLE", []), {
    status: "compliant",
    envelope: { mode: "none", authorizedActions: [] },
    reasons: [],
  });
});

test("AMBIGUOUS (founder/fail-closed stop): no action is compliant, any action is a violation", () => {
  assert.equal(classifyEnvelopeCompliance("AMBIGUOUS", []).status, "compliant");
  const violated = classifyEnvelopeCompliance("AMBIGUOUS", ["repository-reconnaissance"]);
  assert.equal(violated.status, "violation");
});

test("BLOCKED (pre-PR blocker regression, #368-style): zero execution-plane reads/work authorized", () => {
  assert.equal(classifyEnvelopeCompliance("BLOCKED", []).status, "compliant");
  const violated = classifyEnvelopeCompliance("BLOCKED", ["repository-reconnaissance", "implementation-edit"]);
  assert.equal(violated.status, "violation");
  assert.equal(violated.reasons.length, 2);
});

// -- classifyEnvelopeCompliance: wait state -----------------------------------------------
// Verification class 3.

test("NO_ACTION_YET: stop/re-invoke later is compliant; same-session polling or search is a violation", () => {
  assert.equal(classifyEnvelopeCompliance("NO_ACTION_YET", []).status, "compliant");
  const polled = classifyEnvelopeCompliance("NO_ACTION_YET", ["rerun-gate"]);
  assert.equal(polled.status, "violation");
  assert.ok(polled.reasons[0].includes("never authorized"));
});

// -- classifyEnvelopeCompliance: #494 action-bearing promotion ----------------------------
// Verification class 5.

test("#494 shape: STAGE2_REPORT_READY_TO_RECORD authorizes only the record action; the full incident sequence is a violation", () => {
  const result = classifyEnvelopeCompliance("STAGE2_REPORT_READY_TO_RECORD", [
    "run-lifecycle-gate-record-verdict",
    "rerun-gate",
    "run-lifecycle-gate-close-work-issue",
    "run-lifecycle-gate-close-audit",
  ]);
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 3);
  assert.ok(result.reasons.some((r) => r.includes("rerun-gate")));
  assert.ok(result.reasons.some((r) => r.includes("run-lifecycle-gate-close-work-issue")));
  assert.ok(result.reasons.some((r) => r.includes("run-lifecycle-gate-close-audit")));
});

test("STAGE2_REPORT_READY_TO_RECORD: performing only the record action and stopping is compliant", () => {
  const result = classifyEnvelopeCompliance("STAGE2_REPORT_READY_TO_RECORD", ["run-lifecycle-gate-record-verdict"]);
  assert.equal(result.status, "compliant");
});

// -- classifyEnvelopeCompliance: action-bearing merge -------------------------------------
// Verification class 6.

test("STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2: merge + trigger + persisting refs is compliant; anything more is a violation", () => {
  assert.equal(
    classifyEnvelopeCompliance("STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", [
      "merge-pr",
      "trigger-stage2",
      "write-control-snapshot",
    ]).status,
    "compliant",
  );
  const result = classifyEnvelopeCompliance("STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", [
    "merge-pr",
    "trigger-stage2",
    "wait-for-completion",
  ]);
  assert.equal(result.status, "violation");
});

test("STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2: same bounded merge+trigger+persist envelope", () => {
  assert.equal(
    classifyEnvelopeCompliance("STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2", [
      "merge-pr",
      "trigger-stage2",
      "write-control-snapshot",
    ]).status,
    "compliant",
  );
});

// -- classifyEnvelopeCompliance: action-bearing correction --------------------------------
// Verification class 7.

test("STAGE2_CORRECTION_REQUIRED: one bounded correction dispatch, no extra audit archaeology or further lifecycle step", () => {
  assert.equal(
    classifyEnvelopeCompliance("STAGE2_CORRECTION_REQUIRED", ["dispatch-correction-worker"]).status,
    "compliant",
  );
  const result = classifyEnvelopeCompliance("STAGE2_CORRECTION_REQUIRED", [
    "dispatch-correction-worker",
    "repository-reconnaissance",
    "rerun-gate",
  ]);
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 2);
});

test("STAGE1_CORRECTION_REQUIRED: same bounded single-dispatch envelope", () => {
  assert.equal(
    classifyEnvelopeCompliance("STAGE1_CORRECTION_REQUIRED", ["dispatch-correction-worker"]).status,
    "compliant",
  );
});

// -- classifyEnvelopeCompliance: #514 pre-PR planning/routing/dispatch breakpoints --------
// Verification classes 8, 9, 10.

test("#514 shape: crossing PLAN_READY -> ROUTED -> unit dispatch -> wait in one context is a violation with every crossed boundary named", () => {
  const result = classifyEnvelopeCompliance("READY_TO_DISPATCH_PLANNING", [
    "dispatch-planning-worker",
    "write-control-snapshot",
    "rerun-gate",
    "prepare-dispatch-manifest",
    "write-control-snapshot",
    "rerun-gate",
    "dispatch-unit-wave",
    "wait-for-completion",
  ]);
  assert.equal(result.status, "violation");
  // rerun-gate x2, prepare-dispatch-manifest, dispatch-unit-wave, wait-for-completion = 5
  assert.equal(result.reasons.length, 5);
});

test("#514 planning breakpoint: dispatch planner, record PLAN_READY, then end is compliant", () => {
  const result = classifyEnvelopeCompliance("READY_TO_DISPATCH_PLANNING", [
    "dispatch-planning-worker",
    "write-control-snapshot",
  ]);
  assert.equal(result.status, "compliant");
});

test("#514 routing breakpoint: fresh PLAN_READY invocation prepares/verifies manifest and records ROUTED, then ends", () => {
  const compliant = classifyEnvelopeCompliance("READY_TO_RUN_DISPATCH_MANIFEST", [
    "prepare-dispatch-manifest",
    "write-control-snapshot",
  ]);
  assert.equal(compliant.status, "compliant");
  const violated = classifyEnvelopeCompliance("READY_TO_RUN_DISPATCH_MANIFEST", [
    "prepare-dispatch-manifest",
    "write-control-snapshot",
    "dispatch-unit-wave",
  ]);
  assert.equal(violated.status, "violation");
});

test("READY_TO_PROJECT_PLAN_READY / READY_TO_PROJECT_ROUTED: only the idempotent projection write is authorized", () => {
  assert.equal(
    classifyEnvelopeCompliance("READY_TO_PROJECT_PLAN_READY", ["write-control-snapshot"]).status,
    "compliant",
  );
  assert.equal(classifyEnvelopeCompliance("READY_TO_PROJECT_ROUTED", ["write-control-snapshot"]).status, "compliant");
  assert.equal(
    classifyEnvelopeCompliance("READY_TO_PROJECT_ROUTED", ["write-control-snapshot", "dispatch-unit-wave"]).status,
    "violation",
  );
});

test("#514 unit-dispatch breakpoint: dispatch the ready wave and end, without waiting or advancing again", () => {
  assert.equal(classifyEnvelopeCompliance("READY_TO_DISPATCH_UNITS", ["dispatch-unit-wave"]).status, "compliant");
  const violated = classifyEnvelopeCompliance("READY_TO_DISPATCH_UNITS", ["dispatch-unit-wave", "wait-for-completion"]);
  assert.equal(violated.status, "violation");
});

// -- #500 shape: READY_TO_DISPATCH_UNITS followed by orchestrator self-implementation -----

test("#500 shape: READY_TO_DISPATCH_UNITS followed by PR archaeology and a direct source edit is a violation", () => {
  const result = classifyEnvelopeCompliance("READY_TO_DISPATCH_UNITS", [
    "dispatch-unit-wave",
    "repository-reconnaissance",
    "implementation-edit",
  ]);
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 2);
  assert.ok(result.reasons.some((r) => r.includes("repository-reconnaissance")));
  assert.ok(result.reasons.some((r) => r.includes("implementation-edit")));
});

// -- AUDIT_ISSUE_DETECTED: chain mode ------------------------------------------------------

test("AUDIT_ISSUE_DETECTED: running the next gate is compliant; skipping straight to reconnaissance is a violation", () => {
  assert.equal(
    classifyEnvelopeCompliance("AUDIT_ISSUE_DETECTED", ["run-next-review-transition-gate"]).status,
    "compliant",
  );
  const violated = classifyEnvelopeCompliance("AUDIT_ISSUE_DETECTED", ["repository-reconnaissance"]);
  assert.equal(violated.status, "violation");
});

test("AUDIT_ISSUE_DETECTED: performing the chained action plus extra work in the same step is a violation", () => {
  const result = classifyEnvelopeCompliance("AUDIT_ISSUE_DETECTED", [
    "run-next-review-transition-gate",
    "implementation-edit",
  ]);
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 1);
});

// -- NOT_READY: fallthrough is deliberately unpoliced --------------------------------------

test("NOT_READY: fallthrough mode is always compliant regardless of actions taken (hands off to Decomposition boundary)", () => {
  assert.equal(classifyEnvelopeCompliance("NOT_READY", []).status, "compliant");
  assert.equal(
    classifyEnvelopeCompliance("NOT_READY", ["repository-reconnaissance", "implementation-edit"]).status,
    "compliant",
  );
  assert.equal(getActionEnvelope("NOT_READY").mode, ENVELOPE_MODES.FALLTHROUGH);
});

// -- Independent-defect temptation ---------------------------------------------------------
// Verification class 11.

test("independent-defect temptation: a bounded breakpoint never authorizes self-authorized intake or implementation of a newly noticed bug", () => {
  const result = classifyEnvelopeCompliance("STAGE2_CLOSE_READY", [
    "run-lifecycle-gate-close-work-issue",
    "run-lifecycle-gate-close-audit",
    "self-authorized-issue-creation",
    "self-authorized-implementation",
  ]);
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 2);
  assert.ok(result.reasons.every((r) => r.includes("never authorized")));
});

test("STAGE2_CLOSE_READY: performing only the recorded chained close command is compliant", () => {
  const result = classifyEnvelopeCompliance("STAGE2_CLOSE_READY", [
    "run-lifecycle-gate-close-work-issue",
    "run-lifecycle-gate-close-audit",
  ]);
  assert.equal(result.status, "compliant");
});

// -- Never-authorized deny-list applies under every mode, not just "none" -----------------

test("NEVER_AUTHORIZED action kinds are rejected even inside an otherwise-bounded envelope", () => {
  const result = classifyEnvelopeCompliance("READY_TO_DISPATCH", ["dispatch-execution-worker", "wait-for-completion"]);
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 1);
  assert.ok(result.reasons[0].includes("wait-for-completion"));
});
