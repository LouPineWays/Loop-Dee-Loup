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
  assert.deepEqual(b.authorizedActions, ["dispatch-planning-worker"]);
});

// -- Stage 1 finding on PR #534: READY_TO_DISPATCH_PLANNING must not authorize a same-context
// projection write ------------------------------------------------------------------------

test("READY_TO_DISPATCH_PLANNING: dispatching the planning worker and stopping is compliant; also persisting a control snapshot in the same context is a violation", () => {
  assert.equal(
    classifyEnvelopeCompliance("READY_TO_DISPATCH_PLANNING", ["dispatch-planning-worker"]).status,
    "compliant",
  );
  // Projecting PLAN_READY/ROUTED into the control Issue body belongs to a later fresh
  // READY_TO_PROJECT_PLAN_READY/READY_TO_PROJECT_ROUTED invocation, never this same context.
  const result = classifyEnvelopeCompliance("READY_TO_DISPATCH_PLANNING", [
    "dispatch-planning-worker",
    "write-control-snapshot",
  ]);
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 1);
  assert.ok(result.reasons[0].includes("write-control-snapshot"));
});

// -- Stage 1 finding on PR #534: duplicate/reordered authorized actions must be violations ---

test("duplicating an authorized action within one bounded transition is a violation (two dispatch-unit-wave calls)", () => {
  const result = classifyEnvelopeCompliance("READY_TO_DISPATCH_UNITS", ["dispatch-unit-wave", "dispatch-unit-wave"]);
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 1);
  assert.ok(result.reasons[0].includes("already performed once"));
});

test("performing an envelope's own authorized actions out of its declared order is a violation (write-control-snapshot, trigger-stage2, merge-pr)", () => {
  const result = classifyEnvelopeCompliance("STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", [
    "write-control-snapshot",
    "trigger-stage2",
    "merge-pr",
  ]);
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 2);
  assert.ok(result.reasons.every((r) => r.includes("ran out of order")));
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
  // READY_TO_DISPATCH_PLANNING authorizes only dispatch-planning-worker (issue #486/PR #534
  // Stage 1 finding: it never authorizes write-control-snapshot in this same context), so both
  // write-control-snapshot occurrences are also violations here: write-control-snapshot x2,
  // rerun-gate x2 (never-authorized), prepare-dispatch-manifest, dispatch-unit-wave,
  // wait-for-completion (never-authorized) = 7
  assert.equal(result.reasons.length, 7);
});

test("#514 planning breakpoint: dispatch the planning worker by reference and stop is compliant (no projection write in the same context)", () => {
  const result = classifyEnvelopeCompliance("READY_TO_DISPATCH_PLANNING", ["dispatch-planning-worker"]);
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

// -- NOT_READY: fallthrough is unpoliced beyond the unconditional deny-list ----------------

test("NOT_READY: fallthrough mode is compliant for actions outside the deny-list (hands off to Decomposition boundary)", () => {
  assert.equal(classifyEnvelopeCompliance("NOT_READY", []).status, "compliant");
  assert.equal(classifyEnvelopeCompliance("NOT_READY", ["implementation-edit"]).status, "compliant");
  assert.equal(getActionEnvelope("NOT_READY").mode, ENVELOPE_MODES.FALLTHROUGH);
});

// Stage 2 audit finding on PR #534 (issue #535): the deny-list check previously ran only after
// the fallthrough short-circuit, so `classifyEnvelopeCompliance` returned "compliant" for every
// one of the five deny-listed action kinds under ordinary NOT_READY fallthrough — contradicting
// the module's own claim that the deny-list applies "regardless of mode". The deny-list must be
// checked before the fallthrough short-circuit, for fallthrough exactly like every other mode.
test("NOT_READY: fallthrough mode still rejects every NEVER_AUTHORIZED deny-listed action", () => {
  for (const action of [
    "rerun-gate",
    "wait-for-completion",
    "repository-reconnaissance",
    "self-authorized-issue-creation",
    "self-authorized-implementation",
  ]) {
    const result = classifyEnvelopeCompliance("NOT_READY", [action]);
    assert.equal(result.status, "violation", `expected "${action}" to violate fallthrough's deny-list`);
    assert.equal(result.reasons.length, 1);
    assert.ok(result.reasons[0].includes("never authorized"));
  }

  // A deny-listed action alongside an otherwise-unpoliced one still reports only the deny-list
  // violation — fallthrough does not additionally police the non-deny-listed action.
  const mixed = classifyEnvelopeCompliance("NOT_READY", ["repository-reconnaissance", "implementation-edit"]);
  assert.equal(mixed.status, "violation");
  assert.equal(mixed.reasons.length, 1);
  assert.ok(mixed.reasons[0].includes("repository-reconnaissance"));
});

// -- Stage 1 finding on PR #534: a post-PR mid-cycle NOT_READY is AGENTS.md's explicit
// fallthrough exception and must chain to next-review-transition-gate.mjs, never fall through
// unpoliced the way an ordinary pre-PR NOT_READY does --------------------------------------

test("NOT_READY with postPrLifecycle (EXECUTING/VERIFYING/REVIEW/AUDIT/CORRECTION) is chain mode, not fallthrough", () => {
  for (const lifecycle of ["EXECUTING", "VERIFYING", "REVIEW", "AUDIT", "CORRECTION"]) {
    const envelope = getActionEnvelope("NOT_READY", { postPrLifecycle: lifecycle });
    assert.deepEqual(
      envelope,
      { mode: ENVELOPE_MODES.CHAIN, authorizedActions: ["run-next-review-transition-gate"] },
      `expected chain mode for postPrLifecycle ${lifecycle}`,
    );
  }
});

test("NOT_READY with postPrLifecycle: running the review gate and stopping is compliant; repository reconnaissance or self-implementation instead is a violation", () => {
  const context = { postPrLifecycle: "EXECUTING" };
  assert.equal(
    classifyEnvelopeCompliance("NOT_READY", ["run-next-review-transition-gate"], context).status,
    "compliant",
  );
  const violated = classifyEnvelopeCompliance(
    "NOT_READY",
    ["repository-reconnaissance", "self-authorized-implementation"],
    context,
  );
  assert.equal(violated.status, "violation");
  assert.equal(violated.reasons.length, 2);
});

test("NOT_READY without postPrLifecycle is still ordinary unpoliced fallthrough", () => {
  assert.deepEqual(getActionEnvelope("NOT_READY", {}), { mode: ENVELOPE_MODES.FALLTHROUGH, authorizedActions: [] });
  assert.deepEqual(getActionEnvelope("NOT_READY", { postPrLifecycle: "" }), {
    mode: ENVELOPE_MODES.FALLTHROUGH,
    authorizedActions: [],
  });
});

// -- Independent-defect temptation ---------------------------------------------------------
// Verification class 11.

// Stage 1 finding on PR #534: STAGE2_CLOSE_READY's authorized actions depend on whether the
// concrete verdict's own `nextCommand` actually chains a work-issue close first — a real gated
// work issue exists (`nextCommand` includes "close-work-issue") vs. ACCEPTED_NO_WORK_ISSUE /
// an already-closed work issue (`nextCommand` is `close-audit` alone). Tests below pass
// `nextCommand` as context so `getActionEnvelope` derives the actual authorized subset instead
// of falling back to the table's superset row.
const CLOSE_READY_WITH_WORK_ISSUE = {
  nextCommand:
    "node tools/review-watch/lifecycle-gate.mjs close-work-issue --repo o/r --work-issue 1 --audit-issue 2 && node tools/review-watch/lifecycle-gate.mjs close-audit --repo o/r --audit-issue 2",
};
const CLOSE_READY_AUDIT_ONLY = {
  nextCommand: "node tools/review-watch/lifecycle-gate.mjs close-audit --repo o/r --audit-issue 2",
};

test("independent-defect temptation: a bounded breakpoint never authorizes self-authorized intake or implementation of a newly noticed bug", () => {
  const result = classifyEnvelopeCompliance(
    "STAGE2_CLOSE_READY",
    [
      "run-lifecycle-gate-close-work-issue",
      "run-lifecycle-gate-close-audit",
      "self-authorized-issue-creation",
      "self-authorized-implementation",
    ],
    CLOSE_READY_WITH_WORK_ISSUE,
  );
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 2);
  assert.ok(result.reasons.every((r) => r.includes("never authorized")));
});

test("STAGE2_CLOSE_READY (real gated work issue): performing only the recorded chained close command is compliant", () => {
  const result = classifyEnvelopeCompliance(
    "STAGE2_CLOSE_READY",
    ["run-lifecycle-gate-close-work-issue", "run-lifecycle-gate-close-audit"],
    CLOSE_READY_WITH_WORK_ISSUE,
  );
  assert.equal(result.status, "compliant");
});

test("STAGE2_CLOSE_READY (ACCEPTED_NO_WORK_ISSUE / already-closed work issue): close-audit alone is authorized; close-work-issue is not", () => {
  const compliant = classifyEnvelopeCompliance(
    "STAGE2_CLOSE_READY",
    ["run-lifecycle-gate-close-audit"],
    CLOSE_READY_AUDIT_ONLY,
  );
  assert.equal(compliant.status, "compliant");
  assert.deepEqual(compliant.envelope.authorizedActions, ["run-lifecycle-gate-close-audit"]);

  // Stage 1 finding on PR #534: the concrete verdict never authorized closing a work issue in
  // this audit-only shape, so performing it anyway must be a violation, not silently accepted
  // because the table's superset row happens to list it.
  const violated = classifyEnvelopeCompliance(
    "STAGE2_CLOSE_READY",
    ["run-lifecycle-gate-close-work-issue", "run-lifecycle-gate-close-audit"],
    CLOSE_READY_AUDIT_ONLY,
  );
  assert.equal(violated.status, "violation");
  assert.equal(violated.reasons.length, 1);
  assert.ok(violated.reasons[0].includes("run-lifecycle-gate-close-work-issue"));
});

// -- Never-authorized deny-list applies under every mode, not just "none" -----------------

test("NEVER_AUTHORIZED action kinds are rejected even inside an otherwise-bounded envelope", () => {
  const result = classifyEnvelopeCompliance("READY_TO_DISPATCH", ["dispatch-execution-worker", "wait-for-completion"]);
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 1);
  assert.ok(result.reasons[0].includes("wait-for-completion"));
});
