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
// "fallthrough" — `NOT_READY` only, and only when the verdict does NOT also carry
//                 `postPrLifecycle` (a post-PR mid-cycle Lifecycle value — EXECUTING, VERIFYING,
//                 REVIEW, AUDIT, CORRECTION). Authorizes falling through to the Decomposition
//                 boundary / normal reasoning per AGENTS.md § Session execution; deliberately
//                 unpoliced by this mechanism, matching AGENTS.md's own explicit NOT_READY
//                 carve-out. A `NOT_READY` verdict carrying `postPrLifecycle` is the AGENTS.md
//                 § Session execution exception ("a post-PR mid-cycle lifecycle state ... does
//                 not fall through to free reasoning either") and is classified as `chain` to
//                 `next-review-transition-gate.mjs` instead — see the `NOT_READY` handling in
//                 `getActionEnvelope` below (Stage 1 finding on PR #534: the unconditional
//                 fallthrough previously stamped onto every `NOT_READY` result, including this
//                 post-PR exception, meant the compliance checker could never detect repository
//                 reconnaissance or self-authorized implementation performed instead of routing
//                 through the review gate).
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
  // NOT_READY's table row is the ordinary (pre-PR / non-lifecycle) case only. The post-PR
  // mid-cycle exception (`postPrLifecycle` present on the verdict) is handled as a special
  // case directly in `getActionEnvelope` below, never by widening this row — see the
  // `ENVELOPE_MODES` "fallthrough" doc comment above and the Stage 1 finding on PR #534.
  NOT_READY: { mode: ENVELOPE_MODES.FALLTHROUGH, authorizedActions: [] },
  READY_TO_DISPATCH: { mode: ENVELOPE_MODES.BOUNDED, authorizedActions: ["dispatch-execution-worker"] },
  // Stage 1 finding on PR #534: AGENTS.md's own READY_TO_DISPATCH_PLANNING contract is
  // "pipe the same gate JSON into format-dispatch-prompt.mjs and dispatch the planning worker
  // by reference, then stop" — no write-control-snapshot in this same context. Projecting the
  // resulting PLAN_READY/ROUTED state into the control Issue body is READY_TO_PROJECT_PLAN_READY/
  // READY_TO_PROJECT_ROUTED's own job, in a later fresh invocation. Authorizing
  // write-control-snapshot here reopened exactly the same-context lifecycle-advancement defect
  // this table exists to close.
  READY_TO_DISPATCH_PLANNING: {
    mode: ENVELOPE_MODES.BOUNDED,
    authorizedActions: ["dispatch-planning-worker"],
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
  // This table row is the superset (real gated work issue exists, plus a real thin control
  // Issue to terminalize) shape, kept here only as the documentation default for this state.
  // Stage 1 finding on PR #534: for `ACCEPTED_NO_WORK_ISSUE` or an already-closed work issue,
  // next-review-transition-gate.mjs's own `nextCommand` deliberately names only `close-audit` —
  // there is no work issue to close, so authorizing `run-lifecycle-gate-close-work-issue`
  // unconditionally let the compliance checker accept a mutation the concrete verdict never
  // authorized. Issue #542 extends the same "actual nextCommand, never a guessed superset"
  // discipline to thin-control terminalization: `run-close-control`
  // (`tools/orchestration/close-control.mjs`) is authorized only when the concrete verdict's own
  // `nextCommand` was built in control-Issue mode (a real `--control-issue` on the *gate*
  // invocation, never guessed or searched for) — a direct-reference invocation
  // (`--audit-issue`/`--pr`) never chains it, so a no-thin-control flow's envelope is unaffected.
  // `getActionEnvelope` below derives the actual authorized actions from the verdict's own
  // `nextCommand` (present on every STAGE2_CLOSE_READY verdict) and fails closed to the narrowest
  // subset — never this wider row — when no `nextCommand` context is supplied at all, consistent
  // with `FAIL_CLOSED_DEFAULT` below: never guess wider authority from an absent context.
  STAGE2_CLOSE_READY: {
    mode: ENVELOPE_MODES.BOUNDED,
    authorizedActions: ["run-lifecycle-gate-close-work-issue", "run-lifecycle-gate-close-audit", "run-close-control"],
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

// Splits a `nextCommand` chain string ("cmd1 && cmd2 && ...") into each chained segment's own
// script basename and (if present) its first non-flag argument -- a real, structural parse of
// the command's own identity tokens, never a raw substring search over the whole command text.
// Stage 1 review finding on PR #544 (issue #542's close-control.mjs correction, P2): the prior
// `context.nextCommand.includes("close-control.mjs")` check matched that text anywhere in the
// command, including inside an unrelated argument's own *value* -- e.g. a `--repo` value of
// `owner/close-control.mjs` would misclassify an audit-only command as authorizing
// `run-close-control` despite naming no control Issue at all. Only the token immediately after
// `node` (the script path) is ever treated as "the script being invoked"; only the first
// non-flag token after that is ever treated as "the subcommand" -- an argument's own value is
// never inspected for either purpose.
function parseChainedCommands(commandText) {
  if (typeof commandText !== "string" || commandText.length === 0) return [];
  return commandText.split("&&").map((segment) => {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const nodeIdx = tokens.indexOf("node");
    const scriptPath = nodeIdx !== -1 ? tokens[nodeIdx + 1] ?? "" : "";
    const scriptName = scriptPath.split(/[\\/]/).pop() ?? "";
    const rest = nodeIdx !== -1 ? tokens.slice(nodeIdx + 2) : [];
    const subcommand = rest.find((token) => !token.startsWith("--")) ?? null;
    return { scriptName, subcommand };
  });
}

// `context` is the verdict object itself (or an equivalent shape) — optional, and safe to omit
// for a plain table lookup by state alone. Only two states currently read anything from it:
//
//   - `NOT_READY` with a truthy string `context.postPrLifecycle` (one of the post-PR mid-cycle
//     Lifecycle values ready-dispatch-gate.mjs tags the verdict with — EXECUTING, VERIFYING,
//     REVIEW, AUDIT, CORRECTION) is the AGENTS.md § Session execution exception: it must chain
//     to `next-review-transition-gate.mjs`, never fall through to free reasoning. Absent (or a
//     non-post-PR ordinary NOT_READY), the table's own `fallthrough` row applies unchanged.
//   - `STAGE2_CLOSE_READY` derives its actual authorized actions from `context.nextCommand`
//     (always present on this verdict — see next-review-transition-gate.mjs) rather than the
//     table's superset row, per the Stage 1 finding on PR #534 documented above the table entry.
//     Issue #542 extends this same context-sensitive derivation to `run-close-control`: it is
//     authorized only when `nextCommand` itself *invokes* `close-control.mjs` as a chained
//     segment's own script (via `parseChainedCommands` above, never a raw substring match) —
//     the shape `next-review-transition-gate.mjs`'s own `appendCloseControlCommand` produces only
//     when that gate was invoked in control-Issue mode (never guessed from `state` alone).
export function getActionEnvelope(state, context = {}) {
  const entry = typeof state === "string" ? ENVELOPES[state] : undefined;
  if (!entry) return { mode: FAIL_CLOSED_DEFAULT.mode, authorizedActions: [], reason: FAIL_CLOSED_DEFAULT.reason };

  if (state === "NOT_READY" && typeof context.postPrLifecycle === "string" && context.postPrLifecycle.length > 0) {
    return { mode: ENVELOPE_MODES.CHAIN, authorizedActions: ["run-next-review-transition-gate"] };
  }

  if (state === "STAGE2_CLOSE_READY") {
    const commands = parseChainedCommands(context.nextCommand);
    const hasWorkIssue = commands.some((c) => c.scriptName === "lifecycle-gate.mjs" && c.subcommand === "close-work-issue");
    const hasCloseControl = commands.some((c) => c.scriptName === "close-control.mjs");
    const authorizedActions = [];
    if (hasWorkIssue) authorizedActions.push("run-lifecycle-gate-close-work-issue");
    authorizedActions.push("run-lifecycle-gate-close-audit");
    if (hasCloseControl) authorizedActions.push("run-close-control");
    return { mode: entry.mode, authorizedActions };
  }

  return { mode: entry.mode, authorizedActions: [...entry.authorizedActions] };
}

// Action kinds no verdict envelope ever authorizes, regardless of mode — an explicit deny-list
// so a future edit to the table above cannot silently legitimize one of these via a copy/paste
// mistake. Each corresponds to a concrete behavior named as prohibited in issue #486's Required
// behavior sections 1 and 3: re-running a gate to consume a further transition in the same
// context, remaining alive waiting for asynchronous completion, or converting a newly noticed
// defect into self-authorized intake/implementation.
//
// Stage 1 finding on PR #536 (reviewed at c3c3a24): "repository-reconnaissance" deliberately
// does NOT belong in this unconditional set. AGENTS.md § Session execution's own NOT_READY
// fallthrough ("reason normally, including reading the issue's own body directly") and §
// Decomposition boundary both require exactly this action under ordinary NOT_READY fallthrough
// — it is authorized reasoning, not archaeology, so an unconditional deny-list entry for it
// contradicted the fallthrough carve-out it was checked "before". Ordinary FALLTHROUGH mode is
// the only envelope shape this exclusion changes: NONE, BOUNDED, and CHAIN modes still reject
// "repository-reconnaissance" exactly as before, via the normal "not in this verdict's own
// authorizedActions" path below (it never appears in any authorizedActions list), so #440's and
// #500's no-action/bounded-mode reconnaissance violations are unaffected.
const NEVER_AUTHORIZED = new Set([
  "rerun-gate",
  "wait-for-completion",
  "self-authorized-issue-creation",
  "self-authorized-implementation",
]);

// Pure, deterministic compliance check. `actionsTaken` is an ordered list of short canonical
// action-kind strings (see the vocabulary used throughout ENVELOPES above and
// action-envelope.test.mjs) representing what a controller actually did after receiving this
// verdict. Reproducible by any fresh reviewer from the action list alone — no transcript
// content, no model judgment. `context` is the same optional verdict-shaped object
// `getActionEnvelope` accepts (see its own doc comment) — pass the verdict object itself when
// available so state-dependent envelopes (`NOT_READY`'s post-PR exception, `STAGE2_CLOSE_READY`'s
// nextCommand-derived subset) resolve correctly; omitting it falls back to each state's plain
// table row.
export function classifyEnvelopeCompliance(state, actionsTaken = [], context = {}) {
  const envelope = getActionEnvelope(state, context);
  const actions = Array.isArray(actionsTaken) ? actionsTaken : [];
  const reasons = [];

  // Stage 2 audit finding on PR #534 (issue #535): the fixed deny-list below is documented as
  // unconditional — "regardless of mode" — so it must be checked before the fallthrough
  // short-circuit, not after it. Checking it first, for every mode, closes the gap where a
  // deny-listed action taken under ordinary NOT_READY fallthrough was never evaluated at all.
  // "repository-reconnaissance" is deliberately not a member of NEVER_AUTHORIZED (see that
  // constant's own comment, Stage 1 finding on PR #536) — it is authorized, expected behavior
  // under ordinary NOT_READY fallthrough, so it is left to the mode-specific checks below
  // (which still reject it for every non-fallthrough mode, since it never appears in any
  // verdict's own authorizedActions list).
  for (const action of actions) {
    if (NEVER_AUTHORIZED.has(action)) {
      reasons.push(`action "${action}" is never authorized by any verdict envelope`);
    }
  }

  if (envelope.mode === ENVELOPE_MODES.FALLTHROUGH) {
    // NOT_READY deliberately hands off to normal reasoning (AGENTS.md § Session execution,
    // Decomposition boundary) — this mechanism does not police what happens after it, beyond the
    // fixed deny-list checked unconditionally above.
    return reasons.length > 0
      ? { status: "violation", envelope, reasons }
      : { status: "compliant", envelope, reasons: [] };
  }

  // Stage 1 finding on PR #534: checking `authorizedActions.includes(action)` alone treats the
  // list as a set, so a duplicated action (two `dispatch-unit-wave` calls) or a reordered
  // sequence (`write-control-snapshot, trigger-stage2, merge-pr` instead of the declared
  // `merge-pr, trigger-stage2, write-control-snapshot`) both passed as compliant even though a
  // bounded/chain envelope authorizes exactly one occurrence of each named action, in the order
  // the envelope itself declares. `seenAuthorized` and `lastAuthorizedIndex` enforce both: an
  // authorized action already performed once, or one performed out of the envelope's own
  // declared order, is a violation exactly like an action absent from the list entirely.
  const seenAuthorized = new Set();
  // Every non-deny-listed action actually observed, regardless of whether it was ultimately
  // accepted (authorized, unique, in order) below -- used only to decide which required actions
  // were never attempted at all (see the "missing" check after this loop), so an action that was
  // attempted but rejected for being out of order or duplicated is never also reported "missing".
  const attemptedActions = new Set();
  let lastAuthorizedIndex = -1;

  for (const action of actions) {
    if (NEVER_AUTHORIZED.has(action)) {
      // Already recorded in the unconditional deny-list pass above.
      continue;
    }
    attemptedActions.add(action);
    if (envelope.mode === ENVELOPE_MODES.NONE) {
      reasons.push(`no-action verdict "${state}" authorizes zero further operational actions; observed "${action}"`);
      continue;
    }
    // BOUNDED and CHAIN both reduce to "must be in the named list, performed at most once, in
    // the envelope's own declared order."
    const authorizedIndex = envelope.authorizedActions.indexOf(action);
    if (authorizedIndex === -1) {
      reasons.push(
        `action "${action}" is not in the authorized envelope for "${state}" ` +
          `(authorized: ${envelope.authorizedActions.join(", ") || "none"})`,
      );
      continue;
    }
    if (seenAuthorized.has(action)) {
      reasons.push(
        `action "${action}" was already performed once under the "${state}" envelope; repeating an authorized action is not itself authorized`,
      );
      continue;
    }
    if (authorizedIndex < lastAuthorizedIndex) {
      reasons.push(
        `action "${action}" ran out of order for "${state}" (expected order: ${envelope.authorizedActions.join(", ")})`,
      );
      continue;
    }
    seenAuthorized.add(action);
    lastAuthorizedIndex = authorizedIndex;
  }

  // Stage 1 review finding on PR #544 (issue #542's close-control.mjs correction, P1): the loop
  // above only ever checked that each *observed* action was permitted, unique, and in order --
  // it never checked the reverse, that every action the envelope's own `authorizedActions`
  // names was actually observed at all. For a bounded/chain envelope whose authorized sequence
  // is itself the required terminal sequence (e.g. STAGE2_CLOSE_READY with `run-close-control`
  // required), omitting a required action entirely passed as "compliant" as long as whatever was
  // observed happened to be a permitted, in-order subset. Every action named in the envelope must
  // now actually have been attempted (whether or not that attempt was itself accepted above) —
  // BOUNDED and CHAIN both authorize the complete named sequence, not a permitted-superset menu.
  if (envelope.mode === ENVELOPE_MODES.BOUNDED || envelope.mode === ENVELOPE_MODES.CHAIN) {
    const missing = envelope.authorizedActions.filter((action) => !attemptedActions.has(action));
    if (missing.length > 0) {
      reasons.push(
        `required action(s) not observed for "${state}": ${missing.join(", ")} (authorized: ${envelope.authorizedActions.join(", ")})`,
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
