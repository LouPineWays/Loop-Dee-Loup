#!/usr/bin/env node
// Deterministic action-envelope classification — issue #486.
//
// Both `ready-dispatch-gate.mjs` and `next-review-transition-gate.mjs` already compute the
// correct next lifecycle transition and, for terminal/breakpoint verdicts, already attach a
// literal `stopAfter: true` field (issue #498 unit 498-A / #397). Three independent live
// reproductions proved that alone is not enforcement:
//
//   - #440: `STAGE2_RESPONSE_UNUSABLE` (a no-action verdict) was followed by diagnosis, issue
//     creation, source edits, a PR, and review — in the SAME controller context that had just
//     stated the verdict stops immediately.
//   - #494: `STAGE2_REPORT_READY_TO_RECORD` authorized exactly one action (`record-verdict`).
//     After that action produced its durable breakpoint, the same controller re-ran lifecycle
//     logic, reached `STAGE2_CLOSE_READY`, and terminalized the chain in the same invocation.
//   - #514: a healthy pre-PR run crossed `READY_TO_DISPATCH_PLANNING` -> `PLAN_READY` ->
//     `READY_TO_RUN_DISPATCH_MANIFEST`/`ROUTED` -> `READY_TO_DISPATCH_UNITS` in one controller
//     context, despite each transition's own documented "record state, then end" contract.
//   - #500: `READY_TO_DISPATCH_UNITS` (bounded to a unit-dispatch handoff) was followed by
//     free-form PR/repository archaeology and a direct source edit by the same controller.
//
// The missing piece is not another verdict field naming the next step — every verdict above
// already carried the right `state`, `stopAfter`, and (where applicable) `nextCommand`. It is
// a machine-checkable description of the COMPLETE action-authority envelope for the current
// controller context, and a deterministic way to check a recorded sequence of actions against
// it. This module is that description and that checker. See docs/operating-model.md § Action
// envelope enforcement for the full narrative and AGENTS.md § Session execution for the
// pointer every controller reads.
//
// `getActionEnvelope(state)` is the single source of truth both gate scripts attach to every
// verdict they return (as `actionEnvelope`), so the boundary travels with the verdict itself
// rather than living only in prose a controller might read past. `classifyEnvelopeCompliance`
// is the deterministic, fail-closed compliance check: given a verdict state and an ordered
// list of canonical action-kind strings a controller actually performed after receiving that
// verdict, it reports "compliant" or "violation" with reasons — reproducible by any fresh
// reviewer (human or agent) from the recorded action list alone, no model judgment involved.
//
// This module intentionally does not attempt to derive the action list from a live transcript
// itself (unlike tools/telemetry/diagnostic-trace.mjs's pre-dispatch classifier) — real spawned
// multi-transition proving sessions in this repository's own execution environment are blocked
// by the credential-forwarding issue documented in docs/execution-boundary-experiment.md, so a
// literal live-transcript-derived action log is not currently reproducible on demand here. The
// action-kind vocabulary and compliance function are still directly usable by hand against a
// diagnostic trace's already-classified tool_use events (or any equivalent log), and by test
// fixtures replaying the exact incident shapes named above.
//
// Usage as a CLI: see tools/orchestration/verify-action-envelope.mjs.
// Tests: node --test tools/orchestration/action-envelope.test.mjs

// -- Envelope modes -----------------------------------------------------------------------
//
// "none"        — a no-action terminal/non-advance verdict. Zero further repository/GitHub
//                 operational tool calls are authorized before the concise handoff; the
//                 controller ends.
// "bounded"     — an action-bearing verdict. Exactly the actions named in `authorizedActions`
//                 are authorized, and nothing else — never a second gate invocation, a further
//                 lifecycle transition, or a newly invented recovery sequence, even when the
//                 authorized action(s) were performed correctly first.
// "chain"       — a verdict that itself hands off to exactly one further deterministic gate
//                 invocation (currently only `AUDIT_ISSUE_DETECTED` -> run
//                 next-review-transition-gate.mjs), whose OWN verdict and envelope then govern
//                 whatever happens next. This is not "no boundary" — only that one named
//                 chained action is authorized here, and compliance for what follows is judged
//                 against the next verdict's own envelope, not this one.
// "fallthrough" — `NOT_READY` only. Authorizes falling through to the Decomposition boundary /
//                 normal reasoning per AGENTS.md § Session execution; deliberately unpoliced by
//                 this mechanism, matching AGENTS.md's own explicit NOT_READY carve-out.
export const ENVELOPE_MODES = Object.freeze({
  NONE: "none",
  BOUNDED: "bounded",
  CHAIN: "chain",
  FALLTHROUGH: "fallthrough",
});

// One row per verdict `state` string either gate script can return. Kept as one table (rather
// than one per script) because AUDIT_ISSUE_DETECTED's chain mode deliberately spans both, and
// because a single authoritative list is easier to keep exhaustive than two.
const ENVELOPES = {
  // -- ready-dispatch-gate.mjs -------------------------------------------------------------
  BLOCKED: { mode: ENVELOPE_MODES.NONE, authorizedActions: [] },
  NOT_READY: { mode: ENVELOPE_MODES.FALLTHROUGH, authorizedActions: [] },
  READY_TO_DISPATCH: { mode: ENVELOPE_MODES.BOUNDED, authorizedActions: ["dispatch-execution-worker"] },
  READY_TO_DISPATCH_PLANNING: {
    mode: ENVELOPE_MODES.BOUNDED,
    authorizedActions: ["dispatch-planning-worker", "write-control-snapshot"],
  },
  READY_TO_RUN_DISPATCH_MANIFEST: {
    mode: ENVELOPE_MODES.BOUNDED,
    authorizedActions: ["prepare-dispatch-manifest", "write-control-snapshot"],
  },
  READY_TO_PROJECT_PLAN_READY: { mode: ENVELOPE_MODES.BOUNDED, authorizedActions: ["write-control-snapshot"] },
  READY_TO_PROJECT_ROUTED: { mode: ENVELOPE_MODES.BOUNDED, authorizedActions: ["write-control-snapshot"] },
  READY_TO_DISPATCH_UNITS: { mode: ENVELOPE_MODES.BOUNDED, authorizedActions: ["dispatch-unit-wave"] },
  READY_TO_DISPATCH_INTEGRATION: { mode: ENVELOPE_MODES.BOUNDED, authorizedActions: ["dispatch-integration-worker"] },
  REPLAN_REQUIRED: { mode: ENVELOPE_MODES.BOUNDED, authorizedActions: ["dispatch-planning-correction-worker"] },
  AUDIT_ISSUE_DETECTED: { mode: ENVELOPE_MODES.CHAIN, authorizedActions: ["run-next-review-transition-gate"] },

  // -- next-review-transition-gate.mjs -----------------------------------------------------
  AMBIGUOUS: { mode: ENVELOPE_MODES.NONE, authorizedActions: [] },
  NO_ACTION_YET: { mode: ENVELOPE_MODES.NONE, authorizedActions: [] },
  STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2: {
    mode: ENVELOPE_MODES.BOUNDED,
    authorizedActions: ["merge-pr", "trigger-stage2", "write-control-snapshot"],
  },
  STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2: {
    mode: ENVELOPE_MODES.BOUNDED,
    authorizedActions: ["merge-pr", "trigger-stage2", "write-control-snapshot"],
  },
  STAGE1_CORRECTION_REQUIRED: { mode: ENVELOPE_MODES.BOUNDED, authorizedActions: ["dispatch-correction-worker"] },
  STAGE2_CORRECTION_REQUIRED: { mode: ENVELOPE_MODES.BOUNDED, authorizedActions: ["dispatch-correction-worker"] },
  STAGE2_CLOSE_READY: {
    mode: ENVELOPE_MODES.BOUNDED,
    authorizedActions: ["run-lifecycle-gate-close-work-issue", "run-lifecycle-gate-close-audit"],
  },
  STAGE2_REPORT_READY_TO_RECORD: {
    mode: ENVELOPE_MODES.BOUNDED,
    authorizedActions: ["run-lifecycle-gate-record-verdict"],
  },
  STAGE2_RESPONSE_UNUSABLE: { mode: ENVELOPE_MODES.NONE, authorizedActions: [] },
};

// Fail-closed default for any verdict state this table does not recognize — including a state
// that is simply absent (e.g. the exitCode-1 operational-error shape neither gate script
// treats as a verdict at all; AGENTS.md § Session execution: "a script error ... must never be
// treated as the same permission"). Never widen this by guessing at intent from the shape of
// an unrecognized state string.
const FAIL_CLOSED_DEFAULT = Object.freeze({
  mode: ENVELOPE_MODES.NONE,
  authorizedActions: [],
  reason: "unrecognized or absent verdict state; fails closed to zero further authorized action",
});

export function getActionEnvelope(state) {
  const entry = typeof state === "string" ? ENVELOPES[state] : undefined;
  if (!entry) return { mode: FAIL_CLOSED_DEFAULT.mode, authorizedActions: [], reason: FAIL_CLOSED_DEFAULT.reason };
  return { mode: entry.mode, authorizedActions: [...entry.authorizedActions] };
}

// Action kinds no verdict envelope ever authorizes, regardless of mode — an explicit deny-list
// so a future edit to the table above cannot silently legitimize one of these via a copy/paste
// mistake. Each corresponds to a concrete behavior named as prohibited in issue #486's Required
// behavior sections 1 and 3: re-running a gate to consume a further transition in the same
// context, remaining alive waiting for asynchronous completion, doing repository/execution-plane
// reconnaissance a no-action verdict never authorized, or converting a newly noticed defect into
// self-authorized intake/implementation.
const NEVER_AUTHORIZED = new Set([
  "rerun-gate",
  "wait-for-completion",
  "repository-reconnaissance",
  "self-authorized-issue-creation",
  "self-authorized-implementation",
]);

// Pure, deterministic compliance check. `actionsTaken` is an ordered list of short canonical
// action-kind strings (see the vocabulary used throughout ENVELOPES above and
// action-envelope.test.mjs) representing what a controller actually did after receiving this
// verdict. Reproducible by any fresh reviewer from the action list alone — no transcript
// content, no model judgment.
export function classifyEnvelopeCompliance(state, actionsTaken = []) {
  const envelope = getActionEnvelope(state);
  const actions = Array.isArray(actionsTaken) ? actionsTaken : [];
  const reasons = [];

  if (envelope.mode === ENVELOPE_MODES.FALLTHROUGH) {
    // NOT_READY deliberately hands off to normal reasoning (AGENTS.md § Session execution,
    // Decomposition boundary) — this mechanism does not police what happens after it.
    return { status: "compliant", envelope, reasons: [] };
  }

  for (const action of actions) {
    if (NEVER_AUTHORIZED.has(action)) {
      reasons.push(`action "${action}" is never authorized by any verdict envelope`);
      continue;
    }
    if (envelope.mode === ENVELOPE_MODES.NONE) {
      reasons.push(`no-action verdict "${state}" authorizes zero further operational actions; observed "${action}"`);
      continue;
    }
    // BOUNDED and CHAIN both reduce to "must be in the named list."
    if (!envelope.authorizedActions.includes(action)) {
      reasons.push(
        `action "${action}" is not in the authorized envelope for "${state}" ` +
          `(authorized: ${envelope.authorizedActions.join(", ") || "none"})`,
      );
    }
  }

  return reasons.length > 0 ? { status: "violation", envelope, reasons } : { status: "compliant", envelope, reasons: [] };
}

// Every verdict `state` string this table currently recognizes — exported so tests (and any
// future exhaustiveness check against the two gate scripts' own emitted states) can assert
// nothing was left out, without duplicating the list by hand.
export function knownEnvelopeStates() {
  return Object.keys(ENVELOPES);
}
