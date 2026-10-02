// Deterministic launcher step for issue #73 (unit 73-B).
//
// Composes the existing gates (session-entry-gate and the commands its verdicts already name);
// it adds no lifecycle engine and no verdict semantics. One step:
//   1. read the gate verdict (injected `runGate`),
//   2. for a mechanically decidable verdict, read back the durable effect BEFORE acting,
//      classify it (classifyExternalEffect), and replay only when definitely not completed,
//   3. independently verify the transition's postcondition from a read-back (verifyPostcondition),
//   4. make a successor eligible only when that postcondition is proved.
// An actor's exit status or self-report is never consulted for unlocking a successor.
//
// Tests: node --test tools/orchestration/launcher-step.test.mjs

export const Outcome = Object.freeze({
  ADVANCED: "ADVANCED",
  WAITING: "WAITING",
  OPEN_PATH_REQUIRED: "OPEN_PATH_REQUIRED",
  FAIL_CLOSED: "FAIL_CLOSED",
});

export const EffectClass = Object.freeze({
  NOT_COMPLETED: "NOT_COMPLETED",
  COMPLETED_UNPROJECTED: "COMPLETED_UNPROJECTED",
  AMBIGUOUS: "AMBIGUOUS",
});

// Per-transition table: {preState, action, verifier, postcondition, invalidation}.
// `preState` is the gate verdict state; `action` is the already-authorized mechanical command
// (taken from the verdict itself at run time); `verifier` names the read-back; `invalidation`
// lists the conditions under which a previously proved postcondition no longer unlocks.
export const TRANSITIONS = Object.freeze({
  READY_TO_PROJECT_PLAN_READY: {
    preState: "READY_TO_PROJECT_PLAN_READY",
    action: "write-control-snapshot",
    verifier: "control-lifecycle-readback",
    postcondition: "control Issue Lifecycle reads PLAN_READY",
    invalidation: ["control body changed since read-back", "plan comment superseded"],
  },
  READY_TO_PROJECT_ROUTED: {
    preState: "READY_TO_PROJECT_ROUTED",
    action: "write-control-snapshot",
    verifier: "control-lifecycle-readback",
    postcondition: "control Issue Lifecycle reads ROUTED",
    invalidation: ["control body changed since read-back", "manifest comment superseded"],
  },
  READY_TO_RUN_DISPATCH_MANIFEST: {
    preState: "READY_TO_RUN_DISPATCH_MANIFEST",
    action: "prepare-dispatch-manifest-and-project",
    verifier: "manifest-and-lifecycle-readback",
    postcondition: "verified manifest comment exists and Lifecycle reads ROUTED",
    invalidation: ["plan index pointer changed", "manifest comment edited after verification"],
  },
  STAGE2_REPORT_READY_TO_RECORD: {
    preState: "STAGE2_REPORT_READY_TO_RECORD",
    action: "record-verdict",
    verifier: "audit-verdict-field-readback",
    postcondition: "audit Issue Verdict field is promoted from the bound report comment",
    invalidation: ["report comment id differs from the bound one", "audit Issue reopened"],
  },
  STAGE2_TRIGGER_REQUIRED: {
    preState: "STAGE2_TRIGGER_REQUIRED",
    action: "post-stage2-reviewer-trigger",
    verifier: "trigger-comment-readback",
    postcondition: "exactly one valid reviewer trigger comment exists on the audit Issue",
    invalidation: ["audit Issue closed or superseded", "trigger comment deleted"],
  },
  STAGE2_CLOSE_READY: {
    preState: "STAGE2_CLOSE_READY",
    action: "close-audit",
    verifier: "issue-state-readback",
    postcondition: "audit Issue (and gated work Issue, when present) read CLOSED",
    invalidation: ["audit Issue reopened"],
  },
  STAGE2_CORRECTION_PR_NEEDS_FINALIZATION: {
    preState: "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION",
    action: "finalize-pr-breakpoint",
    verifier: "control-pr-projection-readback",
    postcondition: "control Issue PR field points at the open correction PR with Stage 1 requested",
    invalidation: ["correction PR closed or head changed"],
  },
});

// Verdicts whose continuation is semantic work: a fresh bounded worker, never a launcher action.
export const OPEN_PATH_STATES = Object.freeze(
  new Set([
    "READY_TO_DISPATCH",
    "READY_TO_DISPATCH_PLANNING",
    "READY_TO_DISPATCH_UNITS",
    "READY_TO_DISPATCH_INTEGRATION",
    "REPLAN_REQUIRED",
    "STAGE1_CORRECTION_REQUIRED",
    "STAGE2_CORRECTION_REQUIRED",
    "STAGE2_PREPARATION_REQUIRED",
  ]),
);

const WAITING_STATES = new Set(["NO_ACTION_YET"]);

// evidence: { expectedTarget, target, readBackOk, effect: 'absent'|'present'|'unknown',
//             projected: boolean|null }
// `target` is the identity the read-back actually observed; a mismatch (stale / wrong-target)
// or malformed evidence is AMBIGUOUS. Only an authoritative `absent` read-back is NOT_COMPLETED.
export function classifyExternalEffect(evidence) {
  if (!evidence || typeof evidence !== "object") return EffectClass.AMBIGUOUS;
  const { expectedTarget, target, readBackOk, effect, projected } = evidence;
  if (readBackOk !== true) return EffectClass.AMBIGUOUS;
  if (expectedTarget == null || target == null || expectedTarget !== target) return EffectClass.AMBIGUOUS;
  if (effect === "absent") return projected === true ? EffectClass.AMBIGUOUS : EffectClass.NOT_COMPLETED;
  if (effect === "present") {
    if (typeof projected !== "boolean") return EffectClass.AMBIGUOUS;
    return EffectClass.COMPLETED_UNPROJECTED; // when projected is already true, finalize is a no-op
  }
  return EffectClass.AMBIGUOUS;
}

// Independent postcondition: true only when well-formed, current, on-target read-back shows the
// effect present AND projected. Never reads any actor-reported result.
export function verifyPostcondition(evidence) {
  return (
    !!evidence &&
    evidence.readBackOk === true &&
    evidence.expectedTarget != null &&
    evidence.expectedTarget === evidence.target &&
    evidence.effect === "present" &&
    evidence.projected === true
  );
}

function result(outcome, evidence, extra = {}) {
  return { outcome, successorEligible: outcome === Outcome.ADVANCED, evidence, ...extra };
}

// deps: { runGate(controlIssue) -> verdict, readEffect(transition, verdict) -> evidence,
//         execute(transition, verdict) -> any (result ignored for unlocking),
//         finalize(transition, verdict) -> any (project an already-completed effect; no replay) }
export async function runLauncherStep({ controlIssue, deps } = {}) {
  if (controlIssue == null || !deps) {
    return result(Outcome.FAIL_CLOSED, { reason: "missing controlIssue or deps" });
  }
  let verdict;
  try {
    verdict = await deps.runGate(controlIssue);
  } catch (e) {
    return result(Outcome.FAIL_CLOSED, { reason: `gate failed: ${e?.message ?? e}` });
  }
  const state = verdict?.state;
  if (typeof state !== "string") return result(Outcome.FAIL_CLOSED, { reason: "verdict has no state" });
  if (WAITING_STATES.has(state)) return result(Outcome.WAITING, { state });
  if (OPEN_PATH_STATES.has(state)) return result(Outcome.OPEN_PATH_REQUIRED, { state });

  const transition = TRANSITIONS[state];
  if (!transition) return result(Outcome.FAIL_CLOSED, { state, reason: "unrecognized verdict state" });

  try {
    const before = await deps.readEffect(transition, verdict);
    if (verifyPostcondition(before)) return result(Outcome.ADVANCED, { state, before, replayed: false });

    const cls = classifyExternalEffect(before);
    if (cls === EffectClass.AMBIGUOUS) {
      return result(Outcome.FAIL_CLOSED, { state, effectClass: cls, before, reason: "ambiguous external effect" });
    }
    if (cls === EffectClass.NOT_COMPLETED) await deps.execute(transition, verdict);
    else await deps.finalize(transition, verdict); // COMPLETED_UNPROJECTED: never replay

    const after = await deps.readEffect(transition, verdict);
    if (!verifyPostcondition(after)) {
      return result(Outcome.FAIL_CLOSED, {
        state,
        effectClass: cls,
        after,
        reason: "postcondition not independently proved",
      });
    }
    return result(Outcome.ADVANCED, { state, effectClass: cls, after, replayed: cls === EffectClass.NOT_COMPLETED });
  } catch (e) {
    return result(Outcome.FAIL_CLOSED, { state, reason: `step failed: ${e?.message ?? e}` });
  }
}
