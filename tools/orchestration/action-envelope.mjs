#!/usr/bin/env node
// Deterministic action-envelope classification — issue #486, extended by issue #607.
//
// Both `ready-dispatch-gate.mjs` and `next-review-transition-gate.mjs` already compute the
// correct next lifecycle transition and, for terminal/breakpoint verdicts, already attach a
// literal `stopAfter: true` field (issue #498 unit 498-A / #397). Independent live
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
//   - #587 / PR #590 (issue #607): `next-review-transition-gate.mjs` correctly returned
//     `STAGE1_CORRECTION_REQUIRED` (a bounded verdict authorizing exactly one
//     `dispatch-correction-worker` action) and the controller correctly formatted and
//     dispatched the bounded correction worker by reference — then, in the SAME initiating
//     context, restarted #587's own kickoff and re-ran lifecycle logic instead of stopping.
//     `STAGE1_CORRECTION_REQUIRED`'s and `STAGE2_CORRECTION_REQUIRED`'s bounded envelopes
//     already rejected any action outside `["dispatch-correction-worker"]` generically, but
//     this exact incident shape had no regression fixture and the specific "restart the
//     control Issue's own kickoff in the same context" action had no named vocabulary entry.
//     `restart-control-kickoff` (below) closes the naming gap; the fixture in
//     `action-envelope.test.mjs` closes the coverage gap for this verdict.
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
//                 invocation (`AUDIT_ISSUE_DETECTED` -> run next-review-transition-gate.mjs;
//                 `BLOCKED` with `context.blockerReconciliationEligible === true` -> run
//                 reconcile-control-blocker.mjs, then re-invoke ready-dispatch-gate.mjs fresh —
//                 issue #437/#610 Stage 1 finding 1, see the `BLOCKED` handling in
//                 `getActionEnvelope` below), whose OWN verdict and envelope then govern
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
  // This table row is the ordinary (no mechanically-reconcilable Blocker) case only. Issue
  // #437/#610 Stage 1 finding 1: AGENTS.md § Session execution's own `BLOCKED` paragraph
  // conditionally authorizes exactly one `reconcile-control-blocker.mjs` invocation — but only
  // when the gate's own `reasons` name a non-`none` Blocker specifically, never for a
  // Founder-decision-only or blocking-Lifecycle-only `BLOCKED`. Widening this row unconditionally
  // to `bounded`/`chain` would authorize that step even when no Blocker condition exists to
  // reconcile at all, and leaving it unconditionally `none` (the pre-#610 shape) made the
  // documented recovery path unusable under its own authority model — a compliant controller or
  // `verify-action-envelope.mjs` would reject both the reconciliation call and the follow-up
  // fresh gate invocation. The actual authorized envelope is derived from
  // `context.blockerReconciliationEligible` directly in `getActionEnvelope` below, never by
  // widening this static row.
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
  // Issue #561 (live #559/#445/PR #558 reproduction): the prior authorized order —
  // merge-pr, trigger-stage2, write-control-snapshot — let the independent Stage 2 reviewer
  // trigger race ahead of the durable AUDIT projection: PR #558 merged, Audit Issue #559 was
  // created and triggered, and Codex read control #445 while it still said `Lifecycle:
  // REVIEW`, returning BLOCKED. `trigger-stage2` is split into its own two ordered actions —
  // `dispatch-stage2-preparation-worker` (dispatch the bounded Stage 2 preparation worker,
  // which reads the merged PR/diff/execution Issue/Stage 1 disposition directly and persists
  // the canonical audit-control-issue itself, verified by direct read — docs/bounded-review-
  // cycle.md Stage 2 steps 2-3; issue #718 moved this out of the orchestrator's own action list
  // and into a dispatched worker's, renaming it from the prior `create-stage2-audit-issue`,
  // which the orchestrator performed itself) and `post-stage2-reviewer-trigger` (post the
  // `@codex review` trigger, step 4) — with `write-control-snapshot` (in practice,
  // `tools/orchestration/finalize-audit-breakpoint.mjs`'s compose-write-verify sequence)
  // required strictly between them. The reviewer trigger is authorized only after the control
  // snapshot durably records the AUDIT state and the exact Stage 2 reference, and that write
  // has been verified — never before.
  //
  // Issue #586 (live #582/PR #583 reproduction): `next-review-transition-gate.mjs` proved
  // ordinary Stage 1 satisfied and authorized this verdict, PR #583 merged, but the thin
  // control Issue was never durably rewritten past `Stage 1: requested` — nothing mechanically
  // required that write before `merge-pr` proceeded. `finalize-stage1-satisfied` (in practice,
  // `tools/orchestration/finalize-stage1-satisfied-breakpoint.mjs`'s own compose-write-verify
  // sequence) is authorized FIRST, strictly before `merge-pr`, so the durable `satisfied at
  // <head>` disposition is persisted and verified before merge/Stage 2 setup can ever begin —
  // the same "reorder the envelope itself, don't just add a prose reminder" fix issue #561
  // already applied to the reviewer-trigger race above. The distinct
  // `STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2` sibling verdict below deliberately
  // does not gain an equivalent entry: its own `correction-satisfied at ...` disposition is
  // already durably persisted earlier, at the correction worker's own breakpoint
  // (`finalize-correction-breakpoint.mjs`, issue #576/#577), before that verdict is ever
  // reachable at all.
  STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2: {
    mode: ENVELOPE_MODES.BOUNDED,
    authorizedActions: [
      "finalize-stage1-satisfied",
      "merge-pr",
      "dispatch-stage2-preparation-worker",
      "write-control-snapshot",
      "post-stage2-reviewer-trigger",
    ],
  },
  STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2: {
    mode: ENVELOPE_MODES.BOUNDED,
    authorizedActions: [
      "merge-pr",
      "dispatch-stage2-preparation-worker",
      "write-control-snapshot",
      "post-stage2-reviewer-trigger",
    ],
  },
  // Issue #718: the resumable post-merge/pre-preparation gap -- a prior controller already
  // merged the PR (and possibly began Stage 2 preparation) but no settled Stage 2 reference was
  // ever durably recorded. A fresh controller resuming this state (next-review-transition-
  // gate.mjs's control-Issue-mode "PR" bullet settled, live PR state MERGED, no settled "Stage
  // 2" bullet) authorizes exactly one more dispatch, never a second merge-pr.
  STAGE2_PREPARATION_REQUIRED: { mode: ENVELOPE_MODES.BOUNDED, authorizedActions: ["dispatch-stage2-preparation-worker"] },
  // Stage 1 correction on PR #721 (Codex P1 finding): a merged PR whose control Issue's Stage 1
  // disposition was never durably settled -- named by next-review-transition-gate.mjs's own
  // STAGE2_PREPARATION_BLOCKED_ON_STAGE1 verdict. Authorizes exactly the one recovery command
  // that verdict's own `nextCommand` names (finalize-stage1-satisfied-breakpoint.mjs --recover
  // true); a fresh gate invocation afterward resolves normally to STAGE2_PREPARATION_REQUIRED.
  STAGE2_PREPARATION_BLOCKED_ON_STAGE1: {
    mode: ENVELOPE_MODES.BOUNDED,
    authorizedActions: ["run-finalize-stage1-satisfied-recover"],
  },
  // Issue #703: a findings-bearing Stage 1 correction settles the worker's exact PR-head checkout
  // BEFORE spawn (`pr-head-checkout-preflight.mjs --reserve-from-gate`, the pipeline stage between
  // this gate and `format-dispatch-prompt.mjs`), so `reserve-correction-checkout` is authorized
  // strictly before `dispatch-correction-worker`. This row is the findings (default) shape;
  // `getActionEnvelope` narrows it for `correctionReason: "closing-reference"`, whose reservation
  // stage is a pass-through (a metadata-only repair needs no checkout).
  STAGE1_CORRECTION_REQUIRED: {
    mode: ENVELOPE_MODES.BOUNDED,
    authorizedActions: ["reserve-correction-checkout", "dispatch-correction-worker"],
  },
  // Stage 1 finding P2 on PR #710 (issue #703's own correction): a failed `reserve-correction-
  // checkout` must stop the controller without ever dispatching, but STAGE1_CORRECTION_REQUIRED's
  // own bounded envelope above authorizes exactly `["reserve-correction-checkout",
  // "dispatch-correction-worker"]` in order -- checking a reservation-failure action list against
  // THAT envelope always reports the (correctly never-attempted) dispatch as a missing required
  // action, making the safe path indistinguishable from a violation. `pr-head-checkout-
  // preflight.mjs`'s `reserveFromGate` already replaces the verdict's own `state` with
  // `CHECKOUT_BINDING_UNVERIFIED` on a failed reservation (and stamps this exact envelope onto
  // it) -- so a reservation failure is a genuinely different, terminal verdict state, not the
  // original bounded one still in force. This is a `NONE` row (zero further authorized actions)
  // because the reservation attempt itself is what produced this state; nothing may follow it,
  // and the general "missing required action" protection above is deliberately left unchanged --
  // this adds a distinct, correctly-modeled terminal state instead of relaxing that check.
  CHECKOUT_BINDING_UNVERIFIED: { mode: ENVELOPE_MODES.NONE, authorizedActions: [] },
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
  // Issue #646 (the #487/#643/#644/#645 live reproduction): reconcileStage2CorrectionPr found
  // an already-open, work-Issue-linked correction PR while re-evaluating what would otherwise
  // be STAGE2_CORRECTION_REQUIRED -- the PR boundary was already crossed by a prior (possibly
  // interrupted) correction worker, so this controller finalizes that existing PR's own PR/
  // Stage-1 breakpoint directly (the same mechanical trigger-then-finalize sequence
  // `docs/bounded-review-cycle.md`'s Integration/PR worker step 6 already authorizes a
  // controller to run itself), rather than dispatching a sibling correction worker. This table
  // row is the documentation-default (real thin control Issue) superset, kept only as a
  // reference shape -- `getActionEnvelope` below derives the actual authorized actions from
  // this verdict's own `nextCommand`, exactly like `STAGE2_CLOSE_READY` above, never guessed
  // from `state` alone.
  STAGE2_CORRECTION_PR_NEEDS_FINALIZATION: {
    mode: ENVELOPE_MODES.BOUNDED,
    authorizedActions: ["run-review-watch-trigger", "run-finalize-pr-breakpoint"],
  },
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
// for a plain table lookup by state alone. Only three states currently read anything from it:
//
//   - `NOT_READY` with a truthy string `context.postPrLifecycle` (one of the post-PR mid-cycle
//     Lifecycle values ready-dispatch-gate.mjs tags the verdict with — EXECUTING, VERIFYING,
//     REVIEW, AUDIT, CORRECTION) is the AGENTS.md § Session execution exception: it must chain
//     to `next-review-transition-gate.mjs`, never fall through to free reasoning. Absent (or a
//     non-post-PR ordinary NOT_READY), the table's own `fallthrough` row applies unchanged.
//   - `BLOCKED` with `context.blockerReconciliationEligible === true` (set by
//     `ready-dispatch-gate.mjs` only when the Blocker field itself — never Founder decision or a
//     blocking Lifecycle value alone — is the reason for BLOCKED) chains to exactly one
//     `run-reconcile-control-blocker` action; the fresh `ready-dispatch-gate.mjs` re-invocation
//     AGENTS.md's own BLOCKED paragraph authorizes afterward is judged against THAT invocation's
//     own returned verdict/envelope, never pre-authorized here (issue #437/#610 Stage 1 finding
//     1). Any other value (`false`, absent, or a still-non-`none` Founder-decision-only BLOCKED)
//     keeps the table's own unconditional `none` row.
//   - `STAGE2_CLOSE_READY` derives its actual authorized actions from `context.nextCommand`
//     (always present on this verdict — see next-review-transition-gate.mjs) rather than the
//     table's superset row, per the Stage 1 finding on PR #534 documented above the table entry.
//     Issue #542 extends this same context-sensitive derivation to `run-close-control`: it is
//     authorized only when `nextCommand` itself *invokes* `close-control.mjs` as a chained
//     segment's own script (via `parseChainedCommands` above, never a raw substring match) —
//     the shape `next-review-transition-gate.mjs`'s own `appendCloseControlCommand` produces only
//     when that gate was invoked in control-Issue mode (never guessed from `state` alone).
//   - `STAGE2_CORRECTION_PR_NEEDS_FINALIZATION` (issue #646) derives its authorized actions the
//     same context-sensitive way: `run-review-watch-trigger`/`run-finalize-pr-breakpoint` are
//     each authorized only when `nextCommand` actually chains that script — direct-reference
//     mode's `nextCommand` (no thin control Issue) never chains `finalize-pr-breakpoint.mjs`,
//     so that mode's envelope never authorizes a control write it has nothing to write onto.
export function getActionEnvelope(state, context = {}) {
  const entry = typeof state === "string" ? ENVELOPES[state] : undefined;
  if (!entry) return { mode: FAIL_CLOSED_DEFAULT.mode, authorizedActions: [], reason: FAIL_CLOSED_DEFAULT.reason };

  if (state === "NOT_READY" && typeof context.postPrLifecycle === "string" && context.postPrLifecycle.length > 0) {
    return { mode: ENVELOPE_MODES.CHAIN, authorizedActions: ["run-next-review-transition-gate"] };
  }

  if (state === "BLOCKED" && context.blockerReconciliationEligible === true) {
    return { mode: ENVELOPE_MODES.CHAIN, authorizedActions: ["run-reconcile-control-blocker"] };
  }

  // Issue #703: only a findings-bearing correction (the default) reserves a checkout pre-spawn.
  if (state === "STAGE1_CORRECTION_REQUIRED" && context.correctionReason === "closing-reference") {
    return { mode: entry.mode, authorizedActions: ["dispatch-correction-worker"] };
  }

  // Stage 1 correction on PR #721 (Codex findings P1/P6): the three verdicts that dispatch
  // dispatch-stage2-preparation-worker in the SAME bounded envelope
  // (STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2, STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_
  // STAGE2, and the resume verdict STAGE2_PREPARATION_REQUIRED) must not treat
  // write-control-snapshot/post-stage2-reviewer-trigger as unconditionally required. The
  // dispatched worker itself decides, returning a compact "AUDIT_READY #<n>" or
  // "AUDIT_PREPARATION_FAILED <reason>" (format-dispatch-prompt.mjs's
  // formatStage2PreparationWorkerDispatchPrompt). A failed preparation leaves no valid Audit
  // Issue number to project or trigger against -- those two actions cannot safely run, and the
  // dispatch-only sequence ending there is the correct, compliant stop (mirroring
  // CHECKOUT_BINDING_UNVERIFIED's own "the attempt itself is what produced this state" reasoning
  // above). A successful AUDIT_READY authorizes the follow-up: the control-write finalizer
  // (write-control-snapshot, in practice finalize-audit-breakpoint.mjs) in thin/thick
  // control-Issue mode, or a distinct verify-direct-reference-audit action (no control Issue to
  // project onto -- docs/bounded-review-cycle.md's "Stage 2 preparation worker" section's
  // direct-reference continuation, finalize-audit-breakpoint.mjs's own
  // runDirectReferenceVerification) when none exists -- either way followed by
  // post-stage2-reviewer-trigger. `context.preparationResult` is supplied by the caller (the
  // controller's own compliance record of the worker's actual returned status), never guessed
  // from `state` alone; its absence (or an unrecognized value) keeps each verdict's existing
  // static table row unchanged, so every pre-existing caller/test that never supplies it is
  // unaffected.
  if (
    (state === "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2" ||
      state === "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2" ||
      state === "STAGE2_PREPARATION_REQUIRED") &&
    (context.preparationResult === "AUDIT_READY" || context.preparationResult === "AUDIT_PREPARATION_FAILED")
  ) {
    const base =
      state === "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2"
        ? ["finalize-stage1-satisfied", "merge-pr", "dispatch-stage2-preparation-worker"]
        : state === "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2"
          ? ["merge-pr", "dispatch-stage2-preparation-worker"]
          : ["dispatch-stage2-preparation-worker"];
    if (context.preparationResult === "AUDIT_PREPARATION_FAILED") {
      return { mode: ENVELOPE_MODES.BOUNDED, authorizedActions: base };
    }
    const finalizeAction = context.controlIssue != null ? "write-control-snapshot" : "verify-direct-reference-audit";
    return { mode: ENVELOPE_MODES.BOUNDED, authorizedActions: [...base, finalizeAction, "post-stage2-reviewer-trigger"] };
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

  // Issue #646: `STAGE2_CORRECTION_PR_NEEDS_FINALIZATION` derives its actual authorized actions
  // from `context.nextCommand` the same way `STAGE2_CLOSE_READY` does above — `run-finalize-pr-
  // breakpoint` is authorized only when `nextCommand` itself invokes `finalize-pr-breakpoint.mjs`
  // as a chained segment, which `composeStage2CorrectionFinalizeCommand`'s own direct-reference
  // mode (no thin control Issue to project onto) deliberately omits, so a no-control-Issue
  // reconciliation's envelope never authorizes a control write it has no control Issue for.
  if (state === "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION") {
    const commands = parseChainedCommands(context.nextCommand);
    const hasTrigger = commands.some((c) => c.scriptName === "trigger.mjs");
    const hasFinalize = commands.some((c) => c.scriptName === "finalize-pr-breakpoint.mjs");
    const authorizedActions = [];
    if (hasTrigger) authorizedActions.push("run-review-watch-trigger");
    if (hasFinalize) authorizedActions.push("run-finalize-pr-breakpoint");
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
//
// `restart-control-kickoff` (issue #607, the #587/PR #590 reproduction) names the specific
// behavior AGENTS.md's own Fixed chat report formats sentinel-line convention makes possible to
// misuse: re-emitting the fixed `Starting #<issue>.` kickoff line for the SAME control Issue
// inside a context that has already received a verdict for it. A genuine fresh session's own
// kickoff always precedes its first gate invocation and verdict, so it is never itself an
// "action taken after receiving a verdict" in the sense `classifyEnvelopeCompliance` checks —
// only a same-context restart used to simulate a fresh dispatch and continue reasoning past an
// already-consumed bounded/chain envelope is. Unlike "repository-reconnaissance", no legitimate
// post-verdict use of this exact behavior exists in any mode (including ordinary NOT_READY
// fallthrough — a fallthrough verdict's own controller is already mid-session and does not
// re-kick off itself), so it belongs in the unconditional deny-list rather than being left to
// each envelope's own "not in authorizedActions" check alone.
const NEVER_AUTHORIZED = new Set([
  "rerun-gate",
  "wait-for-completion",
  "self-authorized-issue-creation",
  "self-authorized-implementation",
  "restart-control-kickoff",
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
  // sequence (e.g. `write-control-snapshot` before `merge-pr` instead of the declared order)
  // both passed as compliant even though a
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

// Stage 1 review finding on PR #647 (issue #646, P2): the verdict states whose
// `getActionEnvelope` branch above derives `authorizedActions` from `context.nextCommand`
// (`parseChainedCommands`) rather than a fixed table row. Exported as the single source of
// truth for any caller that must know when omitting `context` is unsafe — `getActionEnvelope`
// itself degrades silently (missing context reads as "no chained command", not as an error), so
// `verify-action-envelope.mjs`'s CLI wrapper below uses this list to fail closed instead of
// certifying a spuriously empty/incomplete action list as compliant.
export function contextSensitiveEnvelopeStates() {
  return ["STAGE2_CLOSE_READY", "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION"];
}
