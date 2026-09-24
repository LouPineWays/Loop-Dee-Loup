import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getActionEnvelope,
  classifyEnvelopeCompliance,
  knownEnvelopeStates,
  contextSensitiveEnvelopeStates,
  ENVELOPE_MODES,
} from "./action-envelope.mjs";

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
    "STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT",
    "STAGE1_CORRECTION_REQUIRED",
    "CHECKOUT_BINDING_UNVERIFIED",
    "STAGE2_PREPARATION_REQUIRED",
    "STAGE2_AUDIT_ALREADY_PREPARED",
    "STAGE2_PREPARATION_BLOCKED_ON_STAGE1",
    "STAGE2_CORRECTION_REQUIRED",
    "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION",
    "STAGE2_CLOSE_READY",
    "STAGE2_REPORT_READY_TO_RECORD",
    "STAGE2_RESPONSE_UNUSABLE",
    "STAGE2_TRIGGER_REQUIRED",
  ];
  const known = knownEnvelopeStates();
  for (const state of expected) assert.ok(known.includes(state), `missing envelope for ${state}`);
  assert.equal(known.length, expected.length, "envelope table has an unexpected extra/missing entry");
});

// Stage 1 review finding on PR #647 (issue #646, P2): the exact two states whose authorized
// actions above are derived from `context.nextCommand` rather than a fixed table row --
// `verify-action-envelope.mjs`'s CLI uses this list to fail closed when that context is missing,
// instead of silently classifying against an absent nextCommand.
test("contextSensitiveEnvelopeStates: names exactly the two nextCommand-derived states", () => {
  assert.deepEqual(
    [...contextSensitiveEnvelopeStates()].sort(),
    ["STAGE2_CLOSE_READY", "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION"].sort(),
  );
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

test("performing an envelope's own authorized actions out of its declared order is a violation (write-control-snapshot, dispatch-stage2-preparation-worker, post-stage2-reviewer-trigger, merge-pr)", () => {
  const result = classifyEnvelopeCompliance("STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", [
    "write-control-snapshot",
    "dispatch-stage2-preparation-worker",
    "post-stage2-reviewer-trigger",
    "merge-pr",
  ]);
  assert.equal(result.status, "violation");
  // Issue #586: this envelope now also requires "finalize-stage1-satisfied" (never attempted
  // here), so a third reason names it missing, alongside the two original out-of-order reasons.
  assert.equal(result.reasons.length, 3);
  assert.equal(result.reasons.filter((r) => r.includes("ran out of order")).length, 2);
  assert.ok(result.reasons.some((r) => r.includes("finalize-stage1-satisfied") && r.includes("required action")));
});

// Issue #561 (live #559/#445/PR #558 reproduction): the reviewer trigger racing ahead of the
// durable control projection is exactly an out-of-order `post-stage2-reviewer-trigger` before
// `write-control-snapshot` — the old `merge-pr -> trigger-stage2 -> write-control-snapshot`
// order this envelope used to authorize would be indistinguishable from this shape today.
test("#559/#445/PR #558 shape: posting the Stage 2 reviewer trigger before the control snapshot is written is a violation", () => {
  const result = classifyEnvelopeCompliance("STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", [
    "finalize-stage1-satisfied",
    "merge-pr",
    "dispatch-stage2-preparation-worker",
    "post-stage2-reviewer-trigger",
    "write-control-snapshot",
  ]);
  assert.equal(result.status, "violation");
  assert.ok(result.reasons.some((r) => r.includes("post-stage2-reviewer-trigger") && r.includes("ran out of order")));
});

test("#559/#445/PR #558 shape: the corrected order (merge, create audit issue, project+verify control, then trigger) is compliant", () => {
  const result = classifyEnvelopeCompliance("STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", [
    "finalize-stage1-satisfied",
    "merge-pr",
    "dispatch-stage2-preparation-worker",
    "write-control-snapshot",
    "post-stage2-reviewer-trigger",
  ]);
  assert.equal(result.status, "compliant");
});

// -- Issue #586: finalize-stage1-satisfied is required, first, and strictly before merge-pr --

test("#582/#583 shape: merging before the Stage 1 disposition is durably persisted is a violation", () => {
  const result = classifyEnvelopeCompliance("STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", [
    "merge-pr",
    "finalize-stage1-satisfied",
    "dispatch-stage2-preparation-worker",
    "write-control-snapshot",
    "post-stage2-reviewer-trigger",
  ]);
  assert.equal(result.status, "violation");
  assert.ok(result.reasons.some((r) => r.includes("finalize-stage1-satisfied") && r.includes("ran out of order")));
});

test("#582/#583 shape: omitting finalize-stage1-satisfied entirely is a violation even though every observed action is itself permitted and in order", () => {
  const result = classifyEnvelopeCompliance("STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", [
    "merge-pr",
    "dispatch-stage2-preparation-worker",
    "write-control-snapshot",
    "post-stage2-reviewer-trigger",
  ]);
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 1);
  assert.ok(result.reasons[0].includes("finalize-stage1-satisfied"));
  assert.ok(result.reasons[0].includes("required action"));
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

// Issue #437/#610 Stage 1 finding 1: without `blockerReconciliationEligible` in context (the
// ordinary case — no context at all, or a Founder-decision-only/blocking-Lifecycle-only
// BLOCKED), BLOCKED stays exactly the unconditional no-action verdict above.
test("BLOCKED with no blockerReconciliationEligible context is still the ordinary no-action envelope", () => {
  assert.deepEqual(getActionEnvelope("BLOCKED"), { mode: ENVELOPE_MODES.NONE, authorizedActions: [] });
  assert.deepEqual(getActionEnvelope("BLOCKED", { reasons: ["Founder decision is not \"none\" ..."] }), {
    mode: ENVELOPE_MODES.NONE,
    authorizedActions: [],
  });
  assert.deepEqual(getActionEnvelope("BLOCKED", { blockerReconciliationEligible: false }), {
    mode: ENVELOPE_MODES.NONE,
    authorizedActions: [],
  });
});

// Issue #437/#610 Stage 1 finding 1 (the AGENTS.md/action-envelope.mjs authority mismatch): a
// BLOCKED verdict whose Blocker field is itself the reason (ready-dispatch-gate.mjs sets
// `blockerReconciliationEligible: true` only in exactly this case) chains to the one documented
// reconciliation step, matching AUDIT_ISSUE_DETECTED's own chain shape.
test("BLOCKED with blockerReconciliationEligible: true chains to exactly one reconcile-control-blocker run", () => {
  const context = { blockerReconciliationEligible: true };
  assert.deepEqual(getActionEnvelope("BLOCKED", context), {
    mode: ENVELOPE_MODES.CHAIN,
    authorizedActions: ["run-reconcile-control-blocker"],
  });
  assert.equal(classifyEnvelopeCompliance("BLOCKED", ["run-reconcile-control-blocker"], context).status, "compliant");
  const missing = classifyEnvelopeCompliance("BLOCKED", [], context);
  assert.equal(missing.status, "violation");
  assert.match(missing.reasons.join(" "), /run-reconcile-control-blocker/);
  const overreach = classifyEnvelopeCompliance(
    "BLOCKED",
    ["run-reconcile-control-blocker", "self-authorized-implementation"],
    context,
  );
  assert.equal(overreach.status, "violation");
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

test("STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2: finalize-stage1-satisfied, merge, create audit issue, project+verify control, then trigger is compliant; anything more is a violation", () => {
  assert.equal(
    classifyEnvelopeCompliance("STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", [
      "finalize-stage1-satisfied",
      "merge-pr",
      "dispatch-stage2-preparation-worker",
      "write-control-snapshot",
      "post-stage2-reviewer-trigger",
    ]).status,
    "compliant",
  );
  const result = classifyEnvelopeCompliance("STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", [
    "finalize-stage1-satisfied",
    "merge-pr",
    "dispatch-stage2-preparation-worker",
    "wait-for-completion",
  ]);
  assert.equal(result.status, "violation");
});

test("STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2: same bounded merge/create-audit/project-verify/trigger envelope", () => {
  assert.equal(
    classifyEnvelopeCompliance("STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2", [
      "merge-pr",
      "dispatch-stage2-preparation-worker",
      "write-control-snapshot",
      "post-stage2-reviewer-trigger",
    ]).status,
    "compliant",
  );
});

// Issue #718 controller-context negative (Required check 2): the pre-#718 shape -- the
// controller itself performing semantic Stage 2 audit-issue authoring, recorded here as the old
// "create-stage2-audit-issue" action kind -- is no longer in either merge/trigger verdict's
// authorized envelope at all. A controller that still performed it directly, instead of
// dispatching the bounded preparation worker, is now a structural violation, not merely
// discouraged by prose.
test("STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2: the pre-#718 controller-performed 'create-stage2-audit-issue' action is no longer authorized at all", () => {
  const result = classifyEnvelopeCompliance("STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", [
    "finalize-stage1-satisfied",
    "merge-pr",
    "create-stage2-audit-issue",
    "write-control-snapshot",
    "post-stage2-reviewer-trigger",
  ]);
  assert.equal(result.status, "violation");
  assert.ok(result.reasons.some((r) => r.includes("create-stage2-audit-issue") && r.includes("not in the authorized envelope")));
  assert.ok(
    result.reasons.some((r) => r.includes("dispatch-stage2-preparation-worker") && r.includes("required action")),
    "the envelope must still require the bounded worker dispatch even though an unauthorized substitute was attempted",
  );
});

// -- Issue #718: STAGE2_PREPARATION_REQUIRED -- the resumable post-merge/pre-preparation gap --

test("STAGE2_PREPARATION_REQUIRED: one bounded dispatch is compliant; anything else (including a second merge-pr) is a violation", () => {
  assert.equal(
    classifyEnvelopeCompliance("STAGE2_PREPARATION_REQUIRED", ["dispatch-stage2-preparation-worker"]).status,
    "compliant",
  );
  const result = classifyEnvelopeCompliance("STAGE2_PREPARATION_REQUIRED", [
    "merge-pr",
    "dispatch-stage2-preparation-worker",
  ]);
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 1);
  assert.ok(result.reasons[0].includes("merge-pr"));
});

// -- Stage 1 correction on PR #721: preparationResult-derived follow-up authorization --------
// Codex findings P1 ("Authorize completion after resumed preparation") and P6 ("Model a failed
// preparation as a terminal transition"), plus the guidance-comment regression list items 1-2.

test("STAGE2_PREPARATION_REQUIRED with preparationResult AUDIT_READY (control-Issue mode): dispatch, write-control-snapshot, then trigger is compliant and advances exactly once", () => {
  const context = { preparationResult: "AUDIT_READY", controlIssue: 322 };
  assert.equal(
    classifyEnvelopeCompliance(
      "STAGE2_PREPARATION_REQUIRED",
      ["dispatch-stage2-preparation-worker", "write-control-snapshot", "post-stage2-reviewer-trigger"],
      context,
    ).status,
    "compliant",
  );
  // Stopping after dispatch alone (as if the resumed envelope were still the narrow default) is
  // now a violation -- the required follow-up was never observed. This is the exact defect the
  // Codex P1 finding reported: the pre-correction envelope permitted only the dispatch even
  // though the worker cannot itself finalize/trigger.
  const short = classifyEnvelopeCompliance("STAGE2_PREPARATION_REQUIRED", ["dispatch-stage2-preparation-worker"], context);
  assert.equal(short.status, "violation");
  assert.ok(short.reasons.some((r) => r.includes("write-control-snapshot")));
  // A second dispatch (never re-dispatching the same worker twice under one resumed envelope) is
  // still rejected.
  const repeated = classifyEnvelopeCompliance(
    "STAGE2_PREPARATION_REQUIRED",
    [
      "dispatch-stage2-preparation-worker",
      "write-control-snapshot",
      "post-stage2-reviewer-trigger",
      "dispatch-stage2-preparation-worker",
    ],
    context,
  );
  assert.equal(repeated.status, "violation");
});

test("STAGE2_PREPARATION_REQUIRED with preparationResult AUDIT_PREPARATION_FAILED: stopping after the dispatch alone is compliant; attempting write-control-snapshot or the trigger afterward is a violation", () => {
  const context = { preparationResult: "AUDIT_PREPARATION_FAILED", controlIssue: 322 };
  assert.equal(
    classifyEnvelopeCompliance("STAGE2_PREPARATION_REQUIRED", ["dispatch-stage2-preparation-worker"], context).status,
    "compliant",
  );
  const overreach = classifyEnvelopeCompliance(
    "STAGE2_PREPARATION_REQUIRED",
    ["dispatch-stage2-preparation-worker", "write-control-snapshot"],
    context,
  );
  assert.equal(overreach.status, "violation");
  assert.ok(overreach.reasons.some((r) => r.includes("write-control-snapshot")));
});

test("STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2 with preparationResult AUDIT_PREPARATION_FAILED: merge/dispatch stops cleanly, never reaching write-control-snapshot/trigger", () => {
  const context = { preparationResult: "AUDIT_PREPARATION_FAILED", controlIssue: 322 };
  assert.equal(
    classifyEnvelopeCompliance(
      "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2",
      ["finalize-stage1-satisfied", "merge-pr", "dispatch-stage2-preparation-worker"],
      context,
    ).status,
    "compliant",
  );
  const overreach = classifyEnvelopeCompliance(
    "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2",
    ["finalize-stage1-satisfied", "merge-pr", "dispatch-stage2-preparation-worker", "post-stage2-reviewer-trigger"],
    context,
  );
  assert.equal(overreach.status, "violation");
});

test("STAGE2_PREPARATION_REQUIRED with preparationResult AUDIT_READY and no controlIssue (direct-reference mode): authorizes verify-direct-reference-audit, never write-control-snapshot (no control Issue exists to project onto)", () => {
  const context = { preparationResult: "AUDIT_READY", controlIssue: null };
  assert.equal(
    classifyEnvelopeCompliance(
      "STAGE2_PREPARATION_REQUIRED",
      ["dispatch-stage2-preparation-worker", "verify-direct-reference-audit", "post-stage2-reviewer-trigger"],
      context,
    ).status,
    "compliant",
  );
  const wrongFinalizer = classifyEnvelopeCompliance(
    "STAGE2_PREPARATION_REQUIRED",
    ["dispatch-stage2-preparation-worker", "write-control-snapshot", "post-stage2-reviewer-trigger"],
    context,
  );
  assert.equal(wrongFinalizer.status, "violation");
  assert.ok(wrongFinalizer.reasons.some((r) => r.includes("write-control-snapshot")));
});

test("STAGE2_PREPARATION_REQUIRED: omitting preparationResult from context keeps the original narrow dispatch-only envelope unchanged (backward compatible default)", () => {
  assert.deepEqual(getActionEnvelope("STAGE2_PREPARATION_REQUIRED", { controlIssue: 322 }), {
    mode: "bounded",
    authorizedActions: ["dispatch-stage2-preparation-worker"],
  });
});

// -- Stage 1 correction on PR #721: STAGE2_PREPARATION_BLOCKED_ON_STAGE1 --------------------
// Codex P1 finding ("Verify Stage 1 before resuming Stage 2") -- the merged-PR resume path must
// not bypass an unsettled Stage 1 disposition; next-review-transition-gate.mjs's own new verdict
// authorizes exactly the one named recovery command.

test("STAGE2_PREPARATION_BLOCKED_ON_STAGE1: exactly one recovery-script run is compliant; dispatching the Stage 2 preparation worker directly from this state is a violation", () => {
  assert.equal(
    classifyEnvelopeCompliance("STAGE2_PREPARATION_BLOCKED_ON_STAGE1", ["run-finalize-stage1-satisfied-recover"]).status,
    "compliant",
  );
  const result = classifyEnvelopeCompliance("STAGE2_PREPARATION_BLOCKED_ON_STAGE1", ["dispatch-stage2-preparation-worker"]);
  assert.equal(result.status, "violation");
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

// Issue #665 (live #639/#638/PR #640 reproduction): a correction-satisfied PR's merge is
// mechanically blocked by a real conflict against the current target branch. Exactly one
// bounded conflict-recovery worker dispatch is authorized -- never a merge attempt, a second
// Stage 1 round, or founder/controller-improvised branch surgery in the same context.
// Stage 1 review finding on PR #719 (P1): the conflict-recovery worker mutates source exactly
// like a findings-bearing STAGE1_CORRECTION_REQUIRED worker, so it now reserves its exclusive
// PR-head checkout before spawn too, in the same declared order as that sibling envelope.
test("STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT: reserve the checkout, then one bounded conflict-recovery dispatch -- never a merge attempt or a second gate invocation in the same context", () => {
  assert.deepEqual(getActionEnvelope("STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT"), {
    mode: "bounded",
    authorizedActions: ["reserve-correction-checkout", "dispatch-conflict-recovery-worker"],
  });
  assert.equal(
    classifyEnvelopeCompliance("STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT", [
      "reserve-correction-checkout",
      "dispatch-conflict-recovery-worker",
    ]).status,
    "compliant",
  );
  const mergeAttempt = classifyEnvelopeCompliance("STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT", [
    "reserve-correction-checkout",
    "dispatch-conflict-recovery-worker",
    "merge-pr",
  ]);
  assert.equal(mergeAttempt.status, "violation");
  assert.ok(mergeAttempt.reasons.some((r) => r.includes("merge-pr")));
  const rerun = classifyEnvelopeCompliance("STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT", [
    "reserve-correction-checkout",
    "dispatch-conflict-recovery-worker",
    "rerun-gate",
  ]);
  assert.equal(rerun.status, "violation");
  const missingDispatch = classifyEnvelopeCompliance("STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT", [
    "reserve-correction-checkout",
  ]);
  assert.equal(missingDispatch.status, "violation");
  assert.ok(missingDispatch.reasons.some((r) => r.includes("dispatch-conflict-recovery-worker")));
  const missingReservation = classifyEnvelopeCompliance("STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT", [
    "dispatch-conflict-recovery-worker",
  ]);
  assert.equal(missingReservation.status, "violation");
  assert.ok(missingReservation.reasons.some((r) => r.includes("reserve-correction-checkout") && r.includes("not observed")));
  const outOfOrder = classifyEnvelopeCompliance("STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT", [
    "dispatch-conflict-recovery-worker",
    "reserve-correction-checkout",
  ]);
  assert.equal(outOfOrder.status, "violation");
});

// Issue #703: a findings-bearing Stage 1 correction reserves its PR-head checkout before spawn
// (`pr-head-checkout-preflight.mjs --reserve-from-gate`), strictly before the dispatch itself.
test("STAGE1_CORRECTION_REQUIRED (findings): reserve the correction checkout, then dispatch -- in that order", () => {
  assert.equal(
    classifyEnvelopeCompliance("STAGE1_CORRECTION_REQUIRED", ["reserve-correction-checkout", "dispatch-correction-worker"]).status,
    "compliant",
  );
  assert.equal(
    classifyEnvelopeCompliance("STAGE1_CORRECTION_REQUIRED", ["reserve-correction-checkout", "dispatch-correction-worker"], {
      correctionReason: "findings",
    }).status,
    "compliant",
  );
});

test("STAGE1_CORRECTION_REQUIRED (findings): dispatching without the pre-spawn reservation is a violation", () => {
  const result = classifyEnvelopeCompliance("STAGE1_CORRECTION_REQUIRED", ["dispatch-correction-worker"]);
  assert.equal(result.status, "violation");
  assert.ok(result.reasons.some((r) => r.includes("reserve-correction-checkout") && r.includes("not observed")));
});

test("STAGE1_CORRECTION_REQUIRED (findings): reserving after dispatching is out of order", () => {
  const result = classifyEnvelopeCompliance("STAGE1_CORRECTION_REQUIRED", ["dispatch-correction-worker", "reserve-correction-checkout"]);
  assert.equal(result.status, "violation");
});

test("STAGE1_CORRECTION_REQUIRED (closing-reference): single-dispatch envelope, no reservation authorized", () => {
  const context = { correctionReason: "closing-reference" };
  assert.equal(classifyEnvelopeCompliance("STAGE1_CORRECTION_REQUIRED", ["dispatch-correction-worker"], context).status, "compliant");
  assert.equal(
    classifyEnvelopeCompliance("STAGE1_CORRECTION_REQUIRED", ["reserve-correction-checkout", "dispatch-correction-worker"], context).status,
    "violation",
  );
});

// Issue #607, the live #587/PR #590 reproduction: the controller correctly reached
// `STAGE1_CORRECTION_REQUIRED`, correctly dispatched the one authorized bounded correction
// worker, then — in the SAME initiating context — restarted #587's own kickoff and re-ran
// lifecycle logic instead of stopping. `STAGE1_CORRECTION_REQUIRED` had no violation-shape
// fixture before this issue (only the compliant single-dispatch case above), unlike its sibling
// `STAGE2_CORRECTION_REQUIRED` below, which already had one. This closes that specific gap and
// proves the exact #587/PR #590 action sequence is rejected: the bounded envelope already
// generically rejects any action outside `["dispatch-correction-worker"]`, and
// `restart-control-kickoff`/`rerun-gate` are additionally unconditionally deny-listed.
test("STAGE1_CORRECTION_REQUIRED: #587/PR #590 shape — dispatch the correction worker, then restart the control Issue's own kickoff and re-run lifecycle logic in the same context, is a violation", () => {
  const result = classifyEnvelopeCompliance("STAGE1_CORRECTION_REQUIRED", [
    "reserve-correction-checkout",
    "dispatch-correction-worker",
    "restart-control-kickoff",
    "rerun-gate",
  ]);
  assert.equal(result.status, "violation");
  // restart-control-kickoff and rerun-gate are each unconditionally deny-listed (never
  // authorized by any verdict envelope, regardless of mode) = 2 reasons.
  // reserve-correction-checkout and dispatch-correction-worker are the verdict's authorized
  // actions (issue #703), each attempted exactly once, in order, so they contribute no reason.
  assert.equal(result.reasons.length, 2);
  assert.ok(result.reasons.some((r) => r.includes("restart-control-kickoff") && r.includes("never authorized")));
  assert.ok(result.reasons.some((r) => r.includes("rerun-gate") && r.includes("never authorized")));
});

// Stage 1 finding P2 on PR #710 (issue #703's own correction): a reservation failure replaces
// the verdict with its own terminal CHECKOUT_BINDING_UNVERIFIED state (`pr-head-checkout-
// preflight.mjs`'s `reserveFromGate`) rather than staying under STAGE1_CORRECTION_REQUIRED's own
// bounded envelope, precisely so the controller's correct "stop, never dispatch" response is
// compliant against the state actually in force, not a false "missing dispatch-correction-worker"
// violation against the original one.
test("CHECKOUT_BINDING_UNVERIFIED: zero further actions after a failed reservation is compliant", () => {
  assert.equal(classifyEnvelopeCompliance("CHECKOUT_BINDING_UNVERIFIED", []).status, "compliant");
});

test("CHECKOUT_BINDING_UNVERIFIED: dispatching a correction worker anyway is a violation", () => {
  const result = classifyEnvelopeCompliance("CHECKOUT_BINDING_UNVERIFIED", ["dispatch-correction-worker"]);
  assert.equal(result.status, "violation");
  assert.ok(result.reasons.some((r) => r.includes("dispatch-correction-worker") && r.includes("zero further operational actions")));
});

// The general "missing required action" protection must stay intact for the ORIGINAL
// STAGE1_CORRECTION_REQUIRED envelope: a reservation that was never attempted at all (as opposed
// to attempted-and-failed, which produces the distinct CHECKOUT_BINDING_UNVERIFIED state checked
// above) is still exactly the existing violation shape.
test("STAGE1_CORRECTION_REQUIRED still reports a genuinely omitted reservation as a violation (CHECKOUT_BINDING_UNVERIFIED is additive, not a relaxation)", () => {
  const result = classifyEnvelopeCompliance("STAGE1_CORRECTION_REQUIRED", ["dispatch-correction-worker"]);
  assert.equal(result.status, "violation");
  assert.ok(result.reasons.some((r) => r.includes("reserve-correction-checkout") && r.includes("not observed")));
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
// one of the (then five) deny-listed action kinds under ordinary NOT_READY fallthrough —
// contradicting the module's own claim that the deny-list applies "regardless of mode". The
// deny-list must be checked before the fallthrough short-circuit, for fallthrough exactly like
// every other mode.
test("NOT_READY: fallthrough mode still rejects every NEVER_AUTHORIZED deny-listed action", () => {
  for (const action of [
    "rerun-gate",
    "wait-for-completion",
    "self-authorized-issue-creation",
    "self-authorized-implementation",
    "restart-control-kickoff",
  ]) {
    const result = classifyEnvelopeCompliance("NOT_READY", [action]);
    assert.equal(result.status, "violation", `expected "${action}" to violate fallthrough's deny-list`);
    assert.equal(result.reasons.length, 1);
    assert.ok(result.reasons[0].includes("never authorized"));
  }
});

// Stage 1 finding on PR #536 (reviewed at c3c3a24): the unconditional deny-list above previously
// also included "repository-reconnaissance", so it flagged the exact reconnaissance AGENTS.md's
// own NOT_READY fallthrough contract requires ("reason normally, including reading the issue's
// own body directly") as a violation — turning normal, authorized execution into a reported
// misconduct. Ordinary NOT_READY fallthrough must leave "repository-reconnaissance" unpoliced,
// the same as any other non-deny-listed action, while a genuinely deny-listed action alongside it
// still violates.
test("NOT_READY: fallthrough mode authorizes repository-reconnaissance (reading the issue/repo is the mandated fallthrough behavior)", () => {
  const result = classifyEnvelopeCompliance("NOT_READY", ["repository-reconnaissance"]);
  assert.equal(result.status, "compliant");
  assert.deepEqual(result.reasons, []);

  const mixedWithOrdinary = classifyEnvelopeCompliance("NOT_READY", ["repository-reconnaissance", "implementation-edit"]);
  assert.equal(mixedWithOrdinary.status, "compliant");

  const mixedWithDenyListed = classifyEnvelopeCompliance("NOT_READY", ["repository-reconnaissance", "rerun-gate"]);
  assert.equal(mixedWithDenyListed.status, "violation");
  assert.equal(mixedWithDenyListed.reasons.length, 1);
  assert.ok(mixedWithDenyListed.reasons[0].includes("rerun-gate"));
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
  // Issue #542 correction (PR #544 Stage 1 finding, P1): three reasons, not two -- neither
  // observed action is authorized under this chain envelope, AND the one required chained
  // action ("run-next-review-transition-gate") was never observed at all.
  assert.equal(violated.reasons.length, 3);
  assert.ok(violated.reasons.some((r) => r.includes("run-next-review-transition-gate") && r.includes("required action")));
});

// Issue #558 Stage 1 correction, finding 2 (P1): the EXECUTION_COMPLETE-with-established-PR
// marker (issue #444) is a distinct literal from the five post-PR mid-cycle Lifecycle values
// above, but getActionEnvelope's `postPrLifecycle` check is truthy-string-based, not an
// enumerated match against those five -- this proves the marker also chains, matching the
// AGENTS.md edit that named it as the second NOT_READY fallthrough exception.
test("NOT_READY with postPrLifecycle: EXECUTION_COMPLETE_PR_ESTABLISHED is also chain mode, not fallthrough", () => {
  const envelope = getActionEnvelope("NOT_READY", { postPrLifecycle: "EXECUTION_COMPLETE_PR_ESTABLISHED" });
  assert.deepEqual(envelope, { mode: ENVELOPE_MODES.CHAIN, authorizedActions: ["run-next-review-transition-gate"] });
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

// -- Issue #542: thin-control terminalization chained onto STAGE2_CLOSE_READY -----------------

const CLOSE_READY_WITH_WORK_ISSUE_AND_CONTROL = {
  nextCommand:
    "node tools/review-watch/lifecycle-gate.mjs close-work-issue --repo o/r --work-issue 1 --audit-issue 2 && " +
    "node tools/review-watch/lifecycle-gate.mjs close-audit --repo o/r --audit-issue 2 && " +
    "node tools/orchestration/close-control.mjs --repo o/r --control-issue 3 --audit-issue 2 --work-issue 1",
};
const CLOSE_READY_AUDIT_ONLY_WITH_CONTROL = {
  nextCommand:
    "node tools/review-watch/lifecycle-gate.mjs close-audit --repo o/r --audit-issue 2 && " +
    "node tools/orchestration/close-control.mjs --repo o/r --control-issue 3 --audit-issue 2",
};

test("STAGE2_CLOSE_READY (control-Issue mode, real work issue): performing the full work/audit/control chain in the nextCommand's own order is compliant", () => {
  const result = classifyEnvelopeCompliance(
    "STAGE2_CLOSE_READY",
    ["run-lifecycle-gate-close-work-issue", "run-lifecycle-gate-close-audit", "run-close-control"],
    CLOSE_READY_WITH_WORK_ISSUE_AND_CONTROL,
  );
  assert.equal(result.status, "compliant");
  assert.deepEqual(result.envelope.authorizedActions, [
    "run-lifecycle-gate-close-work-issue",
    "run-lifecycle-gate-close-audit",
    "run-close-control",
  ]);
});

test("STAGE2_CLOSE_READY (control-Issue mode, audit-only): close-audit then close-control, in order, is compliant", () => {
  const result = classifyEnvelopeCompliance(
    "STAGE2_CLOSE_READY",
    ["run-lifecycle-gate-close-audit", "run-close-control"],
    CLOSE_READY_AUDIT_ONLY_WITH_CONTROL,
  );
  assert.equal(result.status, "compliant");
  assert.deepEqual(result.envelope.authorizedActions, ["run-lifecycle-gate-close-audit", "run-close-control"]);
});

test("STAGE2_CLOSE_READY: run-close-control is not authorized when nextCommand never names close-control.mjs (direct-reference / no-thin-control invocation)", () => {
  const result = classifyEnvelopeCompliance(
    "STAGE2_CLOSE_READY",
    ["run-lifecycle-gate-close-audit", "run-close-control"],
    CLOSE_READY_AUDIT_ONLY,
  );
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 1);
  assert.ok(result.reasons[0].includes("run-close-control"));
});

test("STAGE2_CLOSE_READY: run-close-control out of order (before close-audit) is a violation, not silently reordered", () => {
  const result = classifyEnvelopeCompliance(
    "STAGE2_CLOSE_READY",
    ["run-close-control", "run-lifecycle-gate-close-audit"],
    CLOSE_READY_AUDIT_ONLY_WITH_CONTROL,
  );
  assert.equal(result.status, "violation");
  assert.ok(result.reasons.some((r) => r.includes("run-lifecycle-gate-close-audit") && r.includes("out of order")));
});

// -- Never-authorized deny-list applies under every mode, not just "none" -----------------

test("NEVER_AUTHORIZED action kinds are rejected even inside an otherwise-bounded envelope", () => {
  const result = classifyEnvelopeCompliance("READY_TO_DISPATCH", ["dispatch-execution-worker", "wait-for-completion"]);
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 1);
  assert.ok(result.reasons[0].includes("wait-for-completion"));
});

// -- Issue #542 correction (PR #544 Stage 1 finding P1): every required action in a bounded/
// chain envelope's own authorizedActions must actually be observed, not merely "whatever was
// observed happened to be permitted and in order" -----------------------------------------

test("STAGE2_CLOSE_READY (control-Issue mode): omitting run-close-control entirely is a violation even though every observed action was itself permitted and in order", () => {
  const result = classifyEnvelopeCompliance(
    "STAGE2_CLOSE_READY",
    ["run-lifecycle-gate-close-audit"],
    CLOSE_READY_AUDIT_ONLY_WITH_CONTROL,
  );
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 1);
  assert.ok(result.reasons[0].includes("run-close-control"));
  assert.ok(result.reasons[0].includes("required action"));
});

test("STAGE2_CLOSE_READY (control-Issue mode, real work issue): omitting run-close-control after a real close-work-issue+close-audit pair is still a violation", () => {
  const result = classifyEnvelopeCompliance(
    "STAGE2_CLOSE_READY",
    ["run-lifecycle-gate-close-work-issue", "run-lifecycle-gate-close-audit"],
    CLOSE_READY_WITH_WORK_ISSUE_AND_CONTROL,
  );
  assert.equal(result.status, "violation");
  assert.equal(result.reasons.length, 1);
  assert.ok(result.reasons[0].includes("run-close-control"));
});

test("a bounded multi-action envelope reports every action never attempted at all as missing, distinct from an out-of-order/duplicated attempt", () => {
  const missingBoth = classifyEnvelopeCompliance("READY_TO_RUN_DISPATCH_MANIFEST", []);
  assert.equal(missingBoth.status, "violation");
  assert.equal(missingBoth.reasons.length, 1);
  assert.ok(missingBoth.reasons[0].includes("prepare-dispatch-manifest"));
  assert.ok(missingBoth.reasons[0].includes("write-control-snapshot"));
});

// -- Issue #542 correction (PR #544 Stage 1 finding P2): run-close-control authority is derived
// from a structural parse of the chained command's own script token, never a raw substring
// search that could match unrelated argument text -------------------------------------------

test("STAGE2_CLOSE_READY: a --repo value that happens to contain the close-control.mjs substring never manufactures run-close-control authority", () => {
  const trickyRepoSlug = {
    nextCommand: "node tools/review-watch/lifecycle-gate.mjs close-audit --repo owner/close-control.mjs --audit-issue 2",
  };
  const envelope = getActionEnvelope("STAGE2_CLOSE_READY", trickyRepoSlug);
  assert.deepEqual(envelope.authorizedActions, ["run-lifecycle-gate-close-audit"]);
  const result = classifyEnvelopeCompliance(
    "STAGE2_CLOSE_READY",
    ["run-lifecycle-gate-close-audit", "run-close-control"],
    trickyRepoSlug,
  );
  assert.equal(result.status, "violation");
  assert.ok(result.reasons.some((r) => r.includes("run-close-control") && r.includes("not in the authorized envelope")));
});

test("STAGE2_CLOSE_READY: a --work-issue or --audit-issue value containing the close-work-issue substring never manufactures run-lifecycle-gate-close-work-issue authority", () => {
  const trickyArgValue = {
    nextCommand: "node tools/review-watch/lifecycle-gate.mjs close-audit --repo owner/close-work-issue-fixture --audit-issue 2",
  };
  const envelope = getActionEnvelope("STAGE2_CLOSE_READY", trickyArgValue);
  assert.deepEqual(envelope.authorizedActions, ["run-lifecycle-gate-close-audit"]);
});

// -- Issue #646: STAGE2_CORRECTION_PR_NEEDS_FINALIZATION -------------------------------------
// The #487/#643/#644/#645 live reproduction: a controller re-evaluating what would otherwise be
// STAGE2_CORRECTION_REQUIRED discovers an already-open, work-Issue-linked correction PR and must
// finalize it directly (trigger Stage 1, then finalize-pr-breakpoint.mjs) rather than dispatch a
// sibling correction worker. Its authorized actions depend on `nextCommand`, the same
// context-sensitive derivation STAGE2_CLOSE_READY already established above.

const CORRECTION_PR_FINALIZE_CONTROL_ISSUE_MODE = {
  nextCommand:
    "node tools/review-watch/trigger.mjs --repo o/r --kind pr --number 644 --head correctionhead && node tools/orchestration/finalize-pr-breakpoint.mjs --control-issue 322 --execution-issue 375 --pr 644 --head correctionhead",
};
const CORRECTION_PR_FINALIZE_DIRECT_REFERENCE_MODE = {
  nextCommand: "node tools/review-watch/trigger.mjs --repo o/r --kind pr --number 644 --head correctionhead",
};

test("STAGE2_CORRECTION_PR_NEEDS_FINALIZATION (control-Issue mode): performing trigger then finalize, in order, is compliant", () => {
  const envelope = getActionEnvelope("STAGE2_CORRECTION_PR_NEEDS_FINALIZATION", CORRECTION_PR_FINALIZE_CONTROL_ISSUE_MODE);
  assert.deepEqual(envelope.authorizedActions, ["run-review-watch-trigger", "run-finalize-pr-breakpoint"]);
  const result = classifyEnvelopeCompliance(
    "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION",
    ["run-review-watch-trigger", "run-finalize-pr-breakpoint"],
    CORRECTION_PR_FINALIZE_CONTROL_ISSUE_MODE,
  );
  assert.equal(result.status, "compliant");
});

test("STAGE2_CORRECTION_PR_NEEDS_FINALIZATION (direct-reference mode, no thin control): run-finalize-pr-breakpoint is not authorized -- there is no control Issue to project onto", () => {
  const envelope = getActionEnvelope("STAGE2_CORRECTION_PR_NEEDS_FINALIZATION", CORRECTION_PR_FINALIZE_DIRECT_REFERENCE_MODE);
  assert.deepEqual(envelope.authorizedActions, ["run-review-watch-trigger"]);
  const result = classifyEnvelopeCompliance(
    "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION",
    ["run-review-watch-trigger", "run-finalize-pr-breakpoint"],
    CORRECTION_PR_FINALIZE_DIRECT_REFERENCE_MODE,
  );
  assert.equal(result.status, "violation");
  assert.ok(result.reasons.some((r) => r.includes("run-finalize-pr-breakpoint") && r.includes("not in the authorized envelope")));
});

test("STAGE2_CORRECTION_PR_NEEDS_FINALIZATION: dispatching a fresh correction worker instead of finalizing the already-open PR is a violation -- exactly the #644/#645 duplicate-PR shape this verdict exists to prevent", () => {
  const result = classifyEnvelopeCompliance(
    "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION",
    ["dispatch-correction-worker"],
    CORRECTION_PR_FINALIZE_CONTROL_ISSUE_MODE,
  );
  assert.equal(result.status, "violation");
  assert.ok(result.reasons.some((r) => r.includes("dispatch-correction-worker")));
});
