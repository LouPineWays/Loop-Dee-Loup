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
// Open path (unit 73-C): semantic stages dispatch one fresh bounded worker BY REFERENCE using the
// route chosen by route-qualification. A correction (Stage 1 findings, Stage 2 NOT CLEAN) also
// needs exact-target Chat guidance (chat-guidance-gate); without it the step stops with the fixed
// handoff string and dispatches nothing. The supervisor never authors the correction.
//
// Tests: node --test tools/orchestration/launcher-step.test.mjs

import { verifyChatGuidance, guidanceTargetForVerdict } from "./chat-guidance-gate.mjs";
import { selectRoute } from "./route-qualification.mjs";

const GUIDED_CORRECTION_STATES = new Set(["STAGE1_CORRECTION_REQUIRED", "STAGE2_CORRECTION_REQUIRED"]);

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

// deps.readOpenPath(verdict) -> { comments, reportCommentId?, routeInput? } is optional; absent,
// the open path is reported without a dispatch (prior behavior). `routeInput` is
// { outcomeClass, assurance, candidates, evidence, availability } for selectRoute.
async function resolveOpenPath(state, verdict, deps) {
  if (typeof deps.readOpenPath !== "function") return result(Outcome.OPEN_PATH_REQUIRED, { state });
  try {
    const input = await deps.readOpenPath(verdict);
    let guidance = null;
    if (GUIDED_CORRECTION_STATES.has(state)) {
      const target = guidanceTargetForVerdict(verdict, { reportCommentId: input?.reportCommentId });
      const g = verifyChatGuidance(input?.comments, target);
      if (g.status !== "VALID") {
        return result(Outcome.WAITING, { state, chatGuidanceRequired: true, guidanceStatus: g.status, handoff: g.handoff, reason: g.reason });
      }
      guidance = { commentId: g.guidance.commentId, target };
    }
    const route = selectRoute(input?.routeInput ?? {});
    if (route.failClosed) return result(Outcome.FAIL_CLOSED, { state, reason: `no qualified route: ${route.reason}` });
    const role = GUIDED_CORRECTION_STATES.has(state) ? "correction worker" : "implementation worker";
    return result(Outcome.OPEN_PATH_REQUIRED, {
      state,
      dispatch: { role, route: route.route, byReference: { state, guidance }, freshWorker: true, supervisorAuthors: false },
    });
  } catch (e) {
    return result(Outcome.FAIL_CLOSED, { state, reason: `open path failed: ${e?.message ?? e}` });
  }
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
  if (OPEN_PATH_STATES.has(state)) return resolveOpenPath(state, verdict, deps);

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

// ---------------------------------------------------------------------------------------------
// Founder interrupt/resume, terminal return, environment resume (issue #73, unit 73-E).
// Pure helpers; durable writes go through injected deps (write-control-snapshot.mjs in production).
// ---------------------------------------------------------------------------------------------

export const DECISION_SURFACE_HEADING = "## Launcher Decision Surface (v1)";
export const FOUNDER_DECISION_STATES = Object.freeze({ NONE: "none", PENDING: "pending" });
const WRITER_PERMISSIONS = ["admin", "maintain", "write"];

// One durable surface batching every currently known founder question on the active path.
// questions: [{ id, question, blocking, options?: string[], recommended?: string }]
export function renderDecisionSurface({ controlIssue, questions } = {}) {
  if (!Number.isInteger(controlIssue) || !Array.isArray(questions) || questions.length === 0) return null;
  const lines = [DECISION_SURFACE_HEADING, "", `- **Control issue:** #${controlIssue}`];
  for (const q of questions) {
    if (!q?.id || !q?.question || !q?.blocking) return null;
    lines.push(
      `- **Question ${q.id}:** ${q.question} (blocks: ${q.blocking}; options: ${(q.options ?? []).join(" | ") || "open"}; recommended: ${q.recommended ?? "none"})`,
    );
  }
  lines.push("", "Resolve by replying with `- **Answer <id>:** <choice>` bullets from a repository writer.");
  return lines.join("\n");
}

// comments: [{ id, body, authorPermission }]. Answers count only from write/maintain/admin
// authors; the first answer per question wins.
export function parseDecisionResolution(comments, questionIds) {
  const answers = new Map();
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!WRITER_PERMISSIONS.includes(String(c?.authorPermission ?? "").toLowerCase())) continue;
    for (const line of String(c.body ?? "").split(/\r?\n/)) {
      const m = /^\s*[-*]\s+\*\*Answer ([^*:]+):\*\*\s*(\S.*?)\s*$/.exec(line);
      if (m && !answers.has(m[1].trim())) answers.set(m[1].trim(), m[2].trim());
    }
  }
  const missing = questionIds.filter((id) => !answers.has(id));
  return { resolved: missing.length === 0, missing, answers };
}

// Resume automatically only when the decision is fully resolved AND exactly one authorized
// continuation remains; zero or several is itself a founder-level stop.
export function resolveFounderResume({ questionIds, comments, continuations } = {}) {
  const ids = Array.isArray(questionIds) ? questionIds : [];
  if (ids.length === 0) return { outcome: Outcome.FAIL_CLOSED, resume: false, reason: "no decision surface" };
  const r = parseDecisionResolution(comments, ids);
  if (!r.resolved) {
    return { outcome: Outcome.WAITING, resume: false, founderDecision: FOUNDER_DECISION_STATES.PENDING, missing: r.missing };
  }
  const list = Array.isArray(continuations) ? continuations : [];
  if (list.length === 1) {
    return {
      outcome: Outcome.ADVANCED,
      resume: true,
      continuation: list[0],
      founderDecision: FOUNDER_DECISION_STATES.NONE,
      answers: Object.fromEntries(r.answers),
    };
  }
  return {
    outcome: Outcome.WAITING,
    resume: false,
    founderDecision: FOUNDER_DECISION_STATES.PENDING,
    reason: list.length === 0 ? "no authorized continuation remains" : "multiple equally authorized continuations",
  };
}

// Compact founder-evaluation result persisted to the thin control Issue on terminal CLEAN.
export function renderTerminalReturn({ objective, terminalResult, evidencePointers, residualLimitation, founderDecision } = {}) {
  const fd = founderDecision ?? FOUNDER_DECISION_STATES.NONE;
  if (!objective || !terminalResult || !Array.isArray(evidencePointers) || evidencePointers.length === 0) return null;
  if (!Object.values(FOUNDER_DECISION_STATES).includes(fd)) return null;
  return [
    `- **Objective:** ${objective}`,
    `- **Terminal result:** ${terminalResult}`,
    `- **Evidence:** ${evidencePointers.join("; ")}`,
    `- **Residual limitation:** ${residualLimitation || "none"}`,
    `- **Founder decision:** ${fd}`,
  ].join("\n");
}

// deps.writeControl(block) persists via write-control-snapshot; deps.readControl() reads back.
// ADVANCED only when the read-back contains the exact block; never selects follow-on work
// (autonomy ends at the authorized objective boundary).
export async function projectTerminalReturn(input, deps) {
  const block = renderTerminalReturn(input);
  if (!block) return result(Outcome.FAIL_CLOSED, { reason: "terminal return fields incomplete" });
  try {
    await deps.writeControl(block);
    const back = await deps.readControl();
    if (typeof back !== "string" || !back.includes(block)) {
      return result(Outcome.FAIL_CLOSED, { reason: "terminal return not provable on read-back" });
    }
    return result(Outcome.ADVANCED, { terminal: true, block, selectsNextObjective: false });
  } catch (e) {
    return result(Outcome.FAIL_CLOSED, { reason: `terminal projection failed: ${e?.message ?? e}` });
  }
}

// Replacement-environment resume: derived only from durable state passed in (authorization,
// attempt-claim plan, recorded environment requirements); runner/provider memory is never read.
// Untrusted triggers gain nothing; an environment mismatch fails durably, never silently.
export function resumeFromDurableState({ durable, trigger, environment } = {}) {
  if (!trigger?.trusted) return result(Outcome.FAIL_CLOSED, { reason: `untrusted trigger: ${trigger?.reason ?? "none"}` });
  if (!durable?.authorization) return result(Outcome.FAIL_CLOSED, { reason: "no durable authorization" });
  const required = durable.requiredEnvironment ?? {};
  const mismatched = Object.keys(required).filter((k) => environment?.[k] !== required[k]);
  if (mismatched.length) {
    return result(Outcome.FAIL_CLOSED, { reason: "environment mismatch", mismatched, durableHold: true });
  }
  const action = durable.claimsPlan?.action;
  if (action === "BLOCK" || action == null) return result(Outcome.WAITING, { reason: "attempt claim blocks launch", action });
  return result(Outcome.ADVANCED, { resume: true, action, authorization: durable.authorization.commentId ?? null });
}
