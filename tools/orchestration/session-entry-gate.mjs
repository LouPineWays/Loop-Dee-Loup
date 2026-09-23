#!/usr/bin/env node
// Deterministic session-entry router — issue #675 (control #676), closing the exact #639 live
// reproduction: `ready-dispatch-gate.mjs --control-issue 639` correctly returned `NOT_READY` /
// `postPrLifecycle: "REVIEW"` / `actionEnvelope.mode: "chain"` (authorizing exactly
// `run-next-review-transition-gate`, per action-envelope.mjs's own table), but that result
// reached the calling session as a nonzero-exit Bash command (exit 3) — indistinguishable, at
// the tool-call boundary, from a genuine operational failure ("Failed to run READY
// immediate-dispatch gate") — and the controller still had to read the verdict's own fields and
// invoke the named chained gate itself.
//
// This module composes — never reimplements — the two existing gate scripts
// (`ready-dispatch-gate.mjs`, `next-review-transition-gate.mjs`) and the one chained
// reconciliation script (`reconcile-control-blocker.mjs`) that `action-envelope.mjs`'s table
// already names as the complete set of `mode: "chain"` targets. It performs exactly the named
// chained call — never a free-form alternative — and stops the instant the resulting verdict's
// own envelope is no longer `"chain"`, returning that verdict's fields verbatim (state,
// actionEnvelope, stopAfter, and every other field the leaf gate itself already computed) so
// every existing verdict-handling instruction in AGENTS.md / docs/operating-model.md continues
// to apply unchanged, whether the JSON came from a leaf gate directly or via this wrapper.
//
// Operational status vs. domain verdict (the actual #639 defect): this module's own process
// exit code reports ONLY whether a domain lifecycle verdict was successfully derived at all —
// 0 whenever one was (regardless of how "unready" that verdict looks: BLOCKED, NOT_READY, an
// unresolved AMBIGUOUS all exit 0 here, exactly like READY_TO_DISPATCH does), and non-zero (1)
// only for a genuine operational failure — an unreadable Issue, an unresolved repository
// identity, a malformed machine contract, or a failed child gate invocation — the same shape
// both leaf gates already use for their own exitCode-1 "no verdict was ever reached" case. The
// verdict's own historical `exitCode` field (3, 4, 9, ...) is preserved verbatim inside the JSON
// output as diagnostic provenance; it no longer doubles as this process's own exit status.
//
// Provenance: every internal gate/reconciliation call this router makes is recorded, in order,
// under the returned `provenance` array — `{ gate, state, leafExitCode, actionEnvelopeMode }`
// per hop — so a reader can tell exactly which internal gate(s) produced the final verdict
// without re-deriving it.
//
// Backward compatibility: neither leaf gate's own CLI, exit codes, or exported functions are
// modified by this module (per #675's own required behavior: "preserve existing leaf-gate
// semantics/backward compatibility ... do not eliminate leaf-gate diagnostic exit codes"). A
// caller that still invokes `ready-dispatch-gate.mjs` or `next-review-transition-gate.mjs`
// directly sees identical behavior to before this issue.
//
// Chain shapes recognized (mirrors action-envelope.mjs's own ENVELOPES table exactly — see that
// module's `getActionEnvelope` doc comment for the authoritative definition of each):
//
//   - `ready-dispatch-gate.mjs` NOT_READY carrying a truthy `postPrLifecycle` -> chain to
//     `next-review-transition-gate.mjs --control-issue <N>` (the exact #639 shape).
//   - `ready-dispatch-gate.mjs` AUDIT_ISSUE_DETECTED -> chain to
//     `next-review-transition-gate.mjs --audit-issue <auditIssue>` (never `--control-issue`;
//     mirrors AGENTS.md's own "the <N> the gate's own output names" instruction, since a
//     directly-dispatched canonical Stage 2 Audit Issue is not a thin control Issue).
//   - `ready-dispatch-gate.mjs` BLOCKED with `blockerReconciliationEligible: true` -> chain to
//     `reconcile-control-blocker.mjs --control-issue <N>`; an `UNBLOCKED` result then authorizes
//     exactly one fresh `ready-dispatch-gate.mjs` re-invocation (AGENTS.md's own BLOCKED
//     paragraph), which this router performs and re-evaluates from. Any other reconciliation
//     result (`INCOMPLETE_PREREQUISITE`, `AMBIGUOUS_BLOCKER`, `ALREADY_UNBLOCKED`,
//     `ALREADY_TERMINAL`) is terminal here, exactly as AGENTS.md's own prose already requires —
//     this router never chains past it, and returns the original BLOCKED verdict with its
//     `actionEnvelope` overridden to `{ mode: "none", authorizedActions: [] }` (the one
//     authorized reconciliation attempt has now been exercised, not merely inspected — nothing
//     further is authorized), annotated with the reconciliation outcome for diagnostics.
//
// A future verdict state whose own `actionEnvelope.mode` is `"chain"` but does not match one of
// the three shapes above fails closed to an operational error rather than guessing — this
// router's own recognized-shape list must never silently fall behind action-envelope.mjs's
// table without being noticed.
//
// Tests: node --test tools/orchestration/session-entry-gate.test.mjs

import { checkReadyDispatch, resolveRepoIdentity } from "./ready-dispatch-gate.mjs";
import { runNextReviewTransitionGate } from "./next-review-transition-gate.mjs";
import { checkReconcileControlBlocker } from "./reconcile-control-blocker.mjs";
import { clearLastGateVerdict, persistLastGateVerdict } from "./action-envelope-hook.mjs";

// Fail-closed circuit breaker against an unbounded chain loop — never expected in practice
// (today's longest real chain is two hops: BLOCKED -> reconcile -> fresh ready-dispatch-gate),
// but a future chain-shaped verdict this router's own recognizer has not been taught yet must
// never be able to spin forever.
const MAX_CHAIN_HOPS = 6;

function provenanceEntry(gate, verdict) {
  return {
    gate,
    state: typeof verdict?.state === "string" ? verdict.state : null,
    leafExitCode: typeof verdict?.exitCode === "number" ? verdict.exitCode : null,
    actionEnvelopeMode: typeof verdict?.actionEnvelope?.mode === "string" ? verdict.actionEnvelope.mode : null,
  };
}

function operationalError(message, provenance) {
  return { ok: false, exitCode: 1, message, provenance };
}

// The deterministic router itself. `repo`/`controlIssue` mirror the two leaf gates' own call
// shape. Every dependency is injectable so tests never touch the real network/`gh` CLI or spawn
// a real child process for the composed gates.
export async function runSessionEntryGate(
  { repo, controlIssue },
  {
    checkReadyDispatchImpl = checkReadyDispatch,
    runNextReviewTransitionGateImpl = runNextReviewTransitionGate,
    checkReconcileControlBlockerImpl = checkReconcileControlBlocker,
    resolveRepoIdentityImpl = resolveRepoIdentity,
  } = {},
) {
  const provenance = [];

  if (!controlIssue) {
    return operationalError("Missing required arg: --control-issue is required.", provenance);
  }

  // Resolved once and threaded through every composed call below, so a chain never drifts onto
  // a different repository identity mid-sequence — `reconcile-control-blocker.mjs`'s own
  // exported function (unlike the two gate scripts) does not resolve repository identity
  // internally, so this router must always supply it explicitly.
  let resolvedRepo = repo;
  if (!resolvedRepo) {
    const identity = resolveRepoIdentityImpl();
    if (!identity.ok) {
      return operationalError(
        `Could not determine the current repository identity (--repo was not supplied): ${identity.reason}`,
        provenance,
      );
    }
    resolvedRepo = identity.repo;
  }

  let verdict;
  try {
    verdict = await checkReadyDispatchImpl({ repo: resolvedRepo, controlIssue });
  } catch (err) {
    return operationalError(`ready-dispatch-gate.mjs threw: ${err.message}`, provenance);
  }
  provenance.push(provenanceEntry("ready-dispatch-gate", verdict));
  if (typeof verdict?.state !== "string") {
    return operationalError(verdict?.message ?? "ready-dispatch-gate.mjs produced no verdict.", provenance);
  }

  let hops = 0;
  while (verdict.actionEnvelope?.mode === "chain") {
    hops += 1;
    if (hops > MAX_CHAIN_HOPS) {
      return operationalError(
        `Exceeded ${MAX_CHAIN_HOPS} chained gate hops without reaching a non-chain verdict for ` +
          `${resolvedRepo}#${controlIssue} -- refusing to loop further.`,
        provenance,
      );
    }

    // Shape 1 (the #639 reproduction): a post-PR mid-cycle Lifecycle value, chained to the
    // deterministic post-PR transition gate against the same control Issue.
    if (verdict.state === "NOT_READY" && typeof verdict.postPrLifecycle === "string" && verdict.postPrLifecycle.length > 0) {
      let chained;
      try {
        chained = await runNextReviewTransitionGateImpl({ repo: resolvedRepo, controlIssue });
      } catch (err) {
        return operationalError(`next-review-transition-gate.mjs threw: ${err.message}`, provenance);
      }
      provenance.push(provenanceEntry("next-review-transition-gate", chained));
      if (typeof chained?.state !== "string") {
        return operationalError(chained?.message ?? "next-review-transition-gate.mjs produced no verdict.", provenance);
      }
      verdict = chained;
      continue;
    }

    // Shape 2: a directly-dispatched canonical Stage 2 Audit Issue. Direct-reference mode by
    // `auditIssue` alone, never `controlIssue` — see module comment.
    if (verdict.state === "AUDIT_ISSUE_DETECTED") {
      let chained;
      try {
        chained = await runNextReviewTransitionGateImpl({ repo: resolvedRepo, auditIssue: verdict.auditIssue });
      } catch (err) {
        return operationalError(`next-review-transition-gate.mjs threw: ${err.message}`, provenance);
      }
      provenance.push(provenanceEntry("next-review-transition-gate", chained));
      if (typeof chained?.state !== "string") {
        return operationalError(chained?.message ?? "next-review-transition-gate.mjs produced no verdict.", provenance);
      }
      verdict = chained;
      continue;
    }

    // Shape 3: a mechanically-reconcilable Blocker. UNBLOCKED authorizes exactly one fresh
    // ready-dispatch-gate re-invocation; every other reconciliation outcome is terminal.
    if (verdict.state === "BLOCKED" && verdict.blockerReconciliationEligible === true) {
      let reconciled;
      try {
        reconciled = await checkReconcileControlBlockerImpl({ repo: resolvedRepo, "control-issue": controlIssue });
      } catch (err) {
        return operationalError(`reconcile-control-blocker.mjs threw: ${err.message}`, provenance);
      }
      provenance.push({
        gate: "reconcile-control-blocker",
        state: typeof reconciled?.state === "string" ? reconciled.state : null,
        leafExitCode: typeof reconciled?.exitCode === "number" ? reconciled.exitCode : null,
        // reconcile-control-blocker.mjs verdicts carry no action envelope of their own (see
        // AGENTS.md's own BLOCKED paragraph: the fresh ready-dispatch-gate.mjs re-invocation it
        // authorizes on UNBLOCKED is judged against THAT invocation's own verdict, never this
        // one's).
        actionEnvelopeMode: null,
      });
      if (typeof reconciled?.state !== "string") {
        return operationalError(reconciled?.message ?? "reconcile-control-blocker.mjs produced no verdict.", provenance);
      }
      if (reconciled.state !== "UNBLOCKED") {
        // The one reconciliation attempt AGENTS.md's own BLOCKED paragraph authorizes has now
        // been made and did not clear the block -- the original verdict's own `actionEnvelope`
        // (mode "chain", since it was reconciliation-eligible) has been fully exercised, not
        // merely inspected. Overriding it to "none" here reports the correct next instruction
        // ("stops with this same concise chat contract, unchanged" — AGENTS.md's own words for
        // every non-UNBLOCKED outcome) rather than leaving a spent "chain" authorization in the
        // returned envelope, which could otherwise read as still owing a further hop.
        return {
          ok: true,
          ...verdict,
          actionEnvelope: { mode: "none", authorizedActions: [] },
          reconciliation: reconciled,
          provenance,
        };
      }
      let fresh;
      try {
        fresh = await checkReadyDispatchImpl({ repo: resolvedRepo, controlIssue });
      } catch (err) {
        return operationalError(`ready-dispatch-gate.mjs threw (post-reconciliation re-invocation): ${err.message}`, provenance);
      }
      provenance.push(provenanceEntry("ready-dispatch-gate", fresh));
      if (typeof fresh?.state !== "string") {
        return operationalError(fresh?.message ?? "ready-dispatch-gate.mjs produced no verdict (post-reconciliation).", provenance);
      }
      verdict = fresh;
      continue;
    }

    // action-envelope.mjs's table is the single source of truth for which states are "chain" —
    // reaching here means this router's own shape recognition has fallen behind that table.
    // Fail closed rather than silently treating an unrecognized chain verdict as terminal.
    return operationalError(
      `Verdict state "${verdict.state}" carries actionEnvelope.mode "chain" but this router ` +
        "recognizes no chain shape for it -- refusing to guess the authorized next gate.",
      provenance,
    );
  }

  return { ok: true, ...verdict, provenance };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    args[a.slice(2)] = argv[++i];
  }
  return args;
}

async function main() {
  // Mirrors both composed leaf gates' own main(): clear any stale prior verdict before
  // computing a new one, and persist this router's own final resolved verdict to the same side
  // channel the moment it is known — so a downstream pipeline stage (e.g. piping this script's
  // output into format-dispatch-prompt.mjs) never strands action-envelope-hook.mjs's live
  // "none"/"bounded" enforcement without a verdict to observe (issue #678's own fix, extended to
  // this entrypoint).
  clearLastGateVerdict();
  const args = parseArgs(process.argv.slice(2));
  const result = await runSessionEntryGate({ repo: args.repo, controlIssue: args["control-issue"] });
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  persistLastGateVerdict(result);
  console.log(JSON.stringify(result));
  // Operational execution status only: a domain verdict was successfully derived, regardless of
  // the verdict's own historical `exitCode` field (preserved inside the JSON for diagnostics) or
  // how far down the lifecycle it stops the calling session.
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("session-entry-gate.mjs")) {
  main();
}
