#!/usr/bin/env node
// Deterministic post-PR transition gate for docs/operating-model.md § Watched lifecycle
// breakpoints, "Deterministic post-PR transition resolution" — worker unit 397-B under
// control Issue #397's own Shared Contract.
//
// #397's root-cause finding: a control Issue's own free-text "Next authorized transition"
// prose (e.g. #375's mid-cycle comment: "check PR #376 Stage 1 status ... verify/fix
// findings if any, then merge ... open the Stage 2 audit issue, trigger it, and end") reads
// as a correct-looking multi-step sequence, and nothing mechanically stopped a controller
// from executing all of it in one reasoning context — collapsing several of #374's watched
// lifecycle breakpoints into one. `tools/orchestration/ready-dispatch-gate.mjs` already
// closed the equivalent pre-PR gap for the initial READY dispatch; this script closes the
// same gap for a control Issue whose Lifecycle is already one of the five post-PR states
// (EXECUTING, VERIFYING, REVIEW, AUDIT, CORRECTION).
//
// This composes — it does not reimplement — four already-shipped checks:
//   - tools/review-watch/stage1-gate.mjs's `run` (Stage 1 trigger/response evidence)
//   - tools/review-watch/lifecycle-gate.mjs's `checkMergeReady` (closing-reference evidence)
//   - tools/review-watch/lifecycle-gate.mjs's `checkPostAudit` (Stage 2 verdict evidence)
//   - tools/review-watch/stage1-correction-gate.mjs's `checkCorrectionDelta`
//     (correction-satisfied disposition evidence — issue #454, unit 454-C; only ever invoked
//     when stage1-gate itself reports NOT_REQUESTED and the control Issue's own "Stage 1"
//     bullet parses as the new correction-satisfied disposition shape, so the common path
//     spends no extra `gh` call)
// and derives exactly one verdict from their own already-computed states — never from a
// hand-authored control-Issue sub-state field, and never by re-parsing review/audit comment
// *content* for meaning (that would be re-deriving reviewer judgment, which stage1-gate.mjs
// and lifecycle-gate.mjs deliberately do not attempt either). This is a deliberate,
// documented exception to tools/orchestration's usual practice of not importing
// tools/review-watch internals (see ready-dispatch-gate.mjs's own parseHeadingField comment
// for that general boundary): #397's Shared Contract explicitly requires composing these
// exact exported functions rather than re-parsing their evidence a second way.
//
// Verdict derivation (every verdict below carries a literal `stopAfter: true` field):
//
//   Pre-merge phase (a settled "PR" reference, no settled "Stage 2"/Audit reference yet):
//     - stage1-gate NOT_REQUESTED, and no correction-satisfied disposition parses (or none is
//       present at all)                                  -> NO_ACTION_YET
//     - stage1-gate NOT_REQUESTED, and the control Issue's "Stage 1" bullet parses as a
//       correction-satisfied disposition (`- **Stage 1:** correction-satisfied at
//       <corrected-head-sha> (reviewed <reviewed-head-sha>)`, issue #454) whose evidence
//       tools/review-watch/stage1-correction-gate.mjs's `checkCorrectionDelta` independently
//       re-derives (unit 454-C), and
//         CORRECTION_SATISFIED, lifecycle-gate merge-ready MERGE_READY(*), and the live PR's
//         own GitHub mergeable state is not a confirmed conflict against the current target
//         branch                                            -> STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2
//           (same effect as STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2 — merge, open/trigger
//           Stage 2, then stop — kept as a distinct verdict string purely for durable
//           auditability of which path authorized the merge)
//         CORRECTION_SATISFIED, lifecycle-gate merge-ready MERGE_READY(*), but the live PR's
//         own GitHub mergeable state ("gh pr view --json mergeable") reports "CONFLICTING"
//         against the current target branch (issue #665, the live #639/#638/PR #640
//         reproduction: every documented merge prerequisite passed, but the merge action itself
//         was mechanically blocked by real target-branch drift)   -> STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT
//           (authorizes exactly one bounded conflict-recovery worker dispatch — see
//           docs/bounded-review-cycle.md's "Correction-satisfied merge-conflict recovery"
//           section — never a merge attempt, a second Stage 1 round, or founder/controller-
//           improvised branch surgery in this same context; the recovery worker integrates the
//           current target branch into the PR branch with a real merge commit, never a rebase/
//           force-push, so stage1-correction-gate.mjs's own strict-descendant ancestry check
//           still holds at the new head, then re-runs finalize-correction-breakpoint.mjs with
//           the same reviewedHead and the new correctedHead so a fresh invocation of this gate
//           re-derives the normal merge/Stage 2 transition once the conflict is gone)
//         CORRECTION_SATISFIED, lifecycle-gate merge-ready MERGE_READY(*), but the live PR's own
//         GitHub mergeable state reports "UNKNOWN" (not yet computed)  -> NO_ACTION_YET (re-invoke
//           later; never misdiagnosed as a genuine conflict, and never authorizes merge on
//           unconfirmed evidence)
//         CORRECTION_SATISFIED, lifecycle-gate merge-ready BLOCKED_CLOSING_REFERENCE -> STAGE1_CORRECTION_REQUIRED
//           (correctionReason: "closing-reference" -- see #613 note below)
//         CORRECTION_SATISFIED, any other lifecycle-gate merge-ready state -> AMBIGUOUS
//           (unrecognized combination — falls through to the same bottom-of-function fallback
//           as every other unrecognized combination in this table)
//         NOT_SATISFIED (reviewed head lacks findings-provenance, or the corrected head is not
//           a strict, non-diverged descendant of the reviewed head)        -> AMBIGUOUS
//         HEAD_MISMATCH (the disposition names a different head than the one currently being
//           gated — a stale or superseded disposition)                    -> probe the narrow
//           #954 stale-continuation case: if the recorded corrected head is a strict ancestor of
//           the live head, the same reviewed findings round is still bound, and the existing
//           correction/provenance proof succeeds at that live head -> STAGE1_CORRECTION_FINALIZATION_REQUIRED;
//           if no later correction can be proved -> NO_ACTION_YET; operational/untrustworthy
//           comparison or provenance evidence -> AMBIGUOUS
//         an operational error from checkCorrectionDelta itself           -> AMBIGUOUS
//     - stage1-gate PENDING with findings-bearing unbound genuine matches -> AMBIGUOUS
//     - stage1-gate PENDING otherwise                   -> NO_ACTION_YET
//     - stage1-gate EXEMPT, and
//         lifecycle-gate merge-ready MERGE_READY(*)      -> STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2
//         lifecycle-gate merge-ready BLOCKED_CLOSING_REFERENCE -> STAGE1_CORRECTION_REQUIRED
//           (correctionReason: "closing-reference")
//     - stage1-gate RESPONSE_RECEIVED with findings content -- either the fixed old findings
//       preamble, or (issue #638/PR #640 correction) any match on a formal review endpoint
//       whose body stage1-findings.mjs's shared classifier reports as findings-bearing, e.g.
//       raw "P1: ..." text with no fixed heading at all -- checked *before* the clean-pass
//       check below, so a formal review that opens with the fixed clean-pass preamble and then
//       appends a real finding is never misread as clean -> STAGE1_CORRECTION_REQUIRED
//       (correctionReason: "findings"), except a control Issue Stage 1 bullet that is both
//       satisfied/exempt and explicitly head-scoped to this same current head also allows
//       merge-ready progression
//     - stage1-gate RESPONSE_RECEIVED with a clean-pass response (consumer-sync-gate.mjs's
//       `isCleanStage1Response`), and lifecycle-gate merge-ready MERGE_READY(*) -> STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2;
//       BLOCKED_CLOSING_REFERENCE instead -> STAGE1_CORRECTION_REQUIRED (correctionReason: "closing-reference")
//
//     Issue #611/PR #613 (Stage 1 review, P1): every STAGE1_CORRECTION_REQUIRED verdict above
//     now also carries a `correctionReason` field ("findings" or "closing-reference"). The one
//     genuinely findings-bearing path (RESPONSE_RECEIVED with findings content, per the #638
//     extension above) is the #611 #438/PR #610 regression --
//     format-dispatch-prompt.mjs's formatStage1CorrectionWorkerDispatchPrompt mandates
//     finalize-correction-breakpoint.mjs only for that reason. The other three paths
//     (an already correction-satisfied disposition, EXEMPT, or a clean-pass response) are all
//     blocked solely by the closing reference -- finalize-correction-breakpoint.mjs's own
//     findings-bearing/strict-descendant requirements would reject them, so the dispatched
//     worker is instead routed through the ordinary closing-reference repair with no
//     correction-satisfied disposition manufactured.
//     - Issue #1023 (live #963/#964/PR #1021): on the two ordinary-satisfied RESPONSE_RECEIVED
//       paths above (clean-pass, or findings with a head-scoped satisfied disposition), in a
//       control/execution flow, the live GitHub mergeable state is read before the merge verdict:
//         CONFLICTING -> STAGE1_SATISFIED_MERGE_CONFLICT (carries reviewedHead only; authorizes the
//           one successor-first conflict-recovery worker, never a merge, Stage 2 setup, or a
//           predecessor re-review); UNKNOWN -> NO_ACTION_YET; operational error -> AMBIGUOUS;
//           MERGEABLE -> the unchanged STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2. EXEMPT and
//           direct-reference (no control/execution) flows are unchanged.
//     - stage1-gate RESPONSE_RECEIVED without a clean-pass or findings preamble -> NO_ACTION_YET
//     - anything else (operational error from either check, or a combination this gate does
//       not recognize)                                   -> AMBIGUOUS
//
//   Issue #718: control-Issue mode's "PR" bullet is settled but "Stage 2" is not (a genuinely
//   pre-merge control Issue, or a resumed one whose prior Stage 2 preparation never durably
//   recorded a Stage 2 reference), and no explicit --head override was supplied -- this gate
//   now checks live PR state before treating it as an ordinary pre-merge transition:
//     - PR state MERGED, and the control Issue's own "Stage 1" bullet already carries a
//       canonical satisfied/exempt or correction-satisfied disposition (Stage 1 correction on
//       PR #721, Codex P1 finding: a prematurely/manually merged PR whose Stage 1 disposition
//       was never durably settled must not bypass that authority merely because it merged), then
//       (issue #729, the #723/#727 liveness seam) this gate deterministically checks whether the
//       canonical Stage 2 Audit Issue for this exact PR/merge commit already durably exists (an
//       OPEN issue whose own "Exact merge commit"/"Work issue" fields match -- the same
//       "[Audit] in:title" search lifecycle-gate.mjs's checkCloseAudit already performs,
//       reused here, never a second competing search mechanism):
//         - exactly one match -> STAGE2_AUDIT_ALREADY_PREPARED (a prior Stage 2 preparation
//           worker already returned "AUDIT_READY #<n>" and durably created/reused that Audit
//           Issue, but the bounded controller context that received that return was interrupted
//           before finalize-audit-breakpoint.mjs ever ran -- this recovers the exact Audit
//           reference deterministically, with no redispatch of semantic preparation and no
//           diff/Stage-1-narrative/execution-Issue-body reading, and names `nextCommand`: the
//           real finalize-audit-breakpoint.mjs invocation chained into the idempotent
//           trigger.mjs, exactly the ordering issue #561 already requires)
//         - more than one match -> AMBIGUOUS (genuinely conflicting durable evidence; fails
//           closed rather than guessing which Audit Issue is authoritative)
//         - no match, or the reconciliation search itself fails operationally (never blocks the
//           transition -- the acceleration is simply unavailable) ->
//       STAGE2_PREPARATION_REQUIRED (a prior controller already merged and possibly began Stage
//       2 preparation, e.g. via dispatch-stage2-preparation-worker, without it durably
//       completing; re-running stage1-gate/mergeReady against an already-merged PR is not a
//       safe resume path, so this authorizes exactly one more dispatch-stage2-preparation-worker
//       action instead, carrying the same { repo, pr, issue, controlIssue } context shape
//       STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2 carries, resolvable via the Execution bullet)
//     - PR state MERGED, but the "Stage 1" bullet is not one of those two affirmative shapes ->
//       STAGE2_PREPARATION_BLOCKED_ON_STAGE1, naming the exact
//       finalize-stage1-satisfied-breakpoint.mjs --recover true recovery command as
//       `nextCommand`; a fresh gate invocation after that recovery succeeds resolves normally to
//       STAGE2_PREPARATION_REQUIRED above
//     - anything else -> the ordinary pre-merge phase below, using that live head
//
//   Post-merge phase (a settled "Stage 2"/Audit reference):
//     - lifecycle-gate post-audit READY_TO_CLOSE or ACCEPTED_NO_WORK_ISSUE -> STAGE2_CLOSE_READY
//       (issue #407 unit 407-B: this verdict also carries `nextCommand`, the exact real
//       `lifecycle-gate.mjs close-audit` invocation the caller must run next — never only a
//       prose reminder to close the audit issue "where policy requires it". Stage 1 review
//       finding on PR #435: when a real gated work issue exists (READY_TO_CLOSE), `nextCommand`
//       also chains `close-work-issue` first — `close-audit` alone never touches it — so
//       ACCEPTED_NO_WORK_ISSUE, which has no work issue at all, keeps its audit-only shape.
//       Issue #542: when this gate itself was invoked in control-Issue mode (a real thin
//       control Issue — never a direct-reference `--audit-issue`/`--pr` invocation, which has
//       none), `nextCommand` also chains `tools/orchestration/close-control.mjs` last, so the
//       founder-facing thin control Issue's compact lifecycle fields are rewritten to a
//       truthful terminal state and the Issue is closed inside this same bounded transition —
//       closing the #486/#487/#538 gap where that step was left for manual founder repair.)
//     - lifecycle-gate post-audit OK with verdict "CLEAN" and workIssueState "CLOSED" (the
//       motivating resume case: work issue already closed, backed-CLEAN audit never consumed
//       — the exact #380/#384 shape) -> STAGE2_CLOSE_READY, audit-only `nextCommand` (Stage 1
//       review finding on PR #435: this combination reaches checkPostAudit's generic `OK`
//       branch, never `READY_TO_CLOSE`, since that branch requires the work issue to still be
//       open — it previously fell through to `NO_ACTION_YET` below instead; issue #542: this
//       branch's `nextCommand` also chains `close-control.mjs` last in control-Issue mode,
//       exactly like the `READY_TO_CLOSE`/`ACCEPTED_NO_WORK_ISSUE` branch above)
//     - lifecycle-gate post-audit OK with rawVerdict "NOT CLEAN"           -> STAGE2_CORRECTION_REQUIRED
//         ...unless the evidence-only correction path applies (issue #883, live #780/#877/PR #880/
//         Audit #881: a valid recorded NOT CLEAN whose accepted finding needs only bounded proof,
//         no source change). tools/orchestration/evidence-correction.mjs independently re-derives
//         the evidence-correction state from GitHub alone; no reviewer prose is ever keyword-
//         parsed here (the source-vs-evidence classification stays in the correction worker):
//           - not eligible (not a backed exact-merge NOT CLEAN, the audit is itself an
//             evidence-recovery re-audit, the lineage's one re-audit is spent, an open correction
//             PR exists)                          -> STAGE2_CORRECTION_REQUIRED, evidenceOnlyEligible: false
//           - eligible, no/incomplete result      -> STAGE2_CORRECTION_REQUIRED, evidenceOnlyEligible: true
//           - result durably satisfied, no re-audit yet
//                                                  -> STAGE2_EVIDENCE_REAUDIT_PREPARATION_REQUIRED
//           - result satisfied, the one re-audit exists, control/trigger not yet projected
//                                                  -> STAGE2_EVIDENCE_REAUDIT_READY
//           - contradictory/ambiguous evidence-correction state -> AMBIGUOUS (no pointer mutation,
//             no new audit)
//     - lifecycle-gate post-audit REPORT_READY_TO_RECORD (issue #439: a completed Stage 2
//       report already exists on the thread, of either verdict, but the audit issue's own
//       durable Verdict field is still PENDING/malformed — the live #408/#436 gap, where a
//       fully completed CLEAN report sat unrecorded and a controller reported "no completed
//       response has landed") -> STAGE2_REPORT_READY_TO_RECORD, carrying `nextCommand` (the
//       exact real `lifecycle-gate.mjs record-verdict` invocation that deterministically
//       promotes the already-established evidence into the durable field, then stops — a
//       fresh gate invocation afterward resolves the now-recorded verdict through this same
//       table exactly as if a human had set the field by hand)
//     - lifecycle-gate post-audit TRIGGER_REQUIRED (issue #735, live #398/#729/PR #733/Audit
//       #734 reproduction: a canonical, exact-merge, PENDING Audit Issue whose thread carries no
//       valid Stage 2 reviewer trigger at all -- "prepared but never triggered", not "triggered
//       and awaiting a response") -> STAGE2_TRIGGER_REQUIRED, carrying `nextCommand`: the exact
//       idempotent `tools/review-watch/trigger.mjs --kind issue` invocation. Reaching this
//       post-merge branch already requires a settled Stage 2 reference (control-Issue-mode's own
//       "Stage 2" bullet, or a direct-reference --audit-issue), so the control projection issue
//       #561 requires strictly before a reviewer trigger has, by construction, already happened --
//       no finalize-audit-breakpoint.mjs re-run is needed or authorized here, unlike
//       STAGE2_AUDIT_ALREADY_PREPARED's distinct pre-merge resume case above. Never fires once any
//       trigger already exists on the thread (lifecycle-gate.mjs's own `hasTrigger`, reusing
//       trigger.mjs's `findExistingTrigger`) -- that shape keeps resolving to the unmodified
//       NO_ACTION_YET immediately below, exactly as before this fix, and issue #259's anti-
//       retrigger authority is unaffected.
//     - lifecycle-gate post-audit OK with any other rawVerdict (no completed report backing a
//       verdict yet, and a valid Stage 2 trigger already exists on the thread) -> NO_ACTION_YET
//     - lifecycle-gate post-audit RESPONSE_UNUSABLE (issue #447, live reproductions #446 and
//       #380's first round: a genuine, provenance-valid bot response landed post-trigger, but
//       none satisfies the completed-report contract — e.g. #446's terse genuine
//       `chatgpt-codex-connector[bot]` CLEAN reply, alongside an unrelated detailed non-bot
//       report under `LouPineWays` provenance that is never treated as assurance evidence) ->
//       STAGE2_RESPONSE_UNUSABLE, a distinct deterministic fail-closed stop — never ordinary
//       NO_ACTION_YET (which would read as "still waiting," licensing indefinite polling) and
//       never AMBIGUOUS (which means "this gate does not recognize the state," not "a known
//       state that requires a bounded recovery decision"). Carries `postAudit.reportEvidence`
//       (including `genuineResponses`, the exact response reference(s)) so a fresh controller
//       can act without repository archaeology. Idempotent: unchanged durable evidence
//       re-resolves to the same verdict; a later genuine, complete bot response resolves
//       normally through REPORT_READY_TO_RECORD/STAGE2_CLOSE_READY/STAGE2_CORRECTION_REQUIRED
//       above on the very next invocation, with no special "recovery" transition of its own.
//     - anything else (PREMATURE_CLOSURE, an operational error, or a state
//       this gate does not recognize)                                      -> AMBIGUOUS
//
// `stage1-gate.mjs` signals whether a genuine response happened at the current head. Whether
// that response carries findings is resolved first with `hasFindingsStage1Response` (this
// file), which composes stage1-findings.mjs's shared, fail-closed content classifier for any
// match on a formal review endpoint (plus the older fixed findings preamble, kept for
// fixtures/history with no `endpoint` field at all); only when that is false is a clean pass
// resolved with consumer-sync-gate.mjs's `isCleanStage1Response` helper, which is deliberately
// anchored to Codex's own known fixed Stage 1 preambles and does not semantically adjudicate
// arbitrary findings. Neither helper re-parses review content for meaning beyond these fixed,
// narrow, structural checks.
//
// AMBIGUOUS is a founder-interrupt-eligible fail-closed stop (AGENTS.md § Founder interrupt
// conditions, "a failed safety/correctness gate with no authorized recovery path"), never
// license to fall back to free multi-step reasoning across the transition.
//
// Control-Issue mode (the normal path — repository identity derived from the checkout's own
// origin remote, matching ready-dispatch-gate.mjs's resolveRepoIdentity):
//   node tools/orchestration/next-review-transition-gate.mjs --control-issue 375
// reads the control Issue's own recorded bullets (ready-dispatch-gate.mjs's parsing
// convention): "- **Execution:**" (the gated work/execution Issue -- reused verbatim, never
// a second, separately-tracked work-issue field), "- **PR:**" (the PR number, or the "none"
// sentinel before a PR exists), and "- **Stage 2:**" (the Stage 2 Audit Issue number, or
// "none" before Stage 2 has started -- issue #450: the one demonstrated legacy synonym "not
// started" is also tolerated here, read-time-only, for durable state that predates
// finalize-pr-breakpoint.mjs's write-time canonicalization; see isLegacyStage2NotStartedSentinel
// and parseOptionalIssueRef's own comment) to decide which phase applies and what to compose it
// against. The PR's current head is derived live (one more `gh pr view` read) unless --head
// is given explicitly -- this gate does not invent a new durable "frozen head" bullet; the
// live current head is correct except in the narrow case where a fix commit landed after a
// trigger without a fresh re-trigger, in which case stage1-gate.mjs's own head-scoped
// NOT_REQUESTED evidence at that new head is exactly the correct signal (a fresh Stage 1
// round is required), not a gap this gate needs to paper over.
//
// Issue #537 (the #487/#535/#536 incident): a settled "Stage 2" bullet is not, by itself,
// authority to select the post-merge phase. When both "PR" and "Stage 2" resolve to settled
// Issue references, this gate resolves one more piece of live PR state (`state`, alongside the
// existing head read) before choosing a route:
//   - PR state OPEN    -> the pre-merge PR/Stage 1 phase owns the transition, even though a
//                          (possibly historical/predecessor) Stage 2 reference also durably
//                          exists on the control Issue -- that reference is provenance, not a
//                          live post-merge pointer, until the PR it precedes actually merges.
//   - PR state MERGED  -> the existing post-merge Stage 2 phase applies, exactly as before.
//   - anything else (e.g. CLOSED without merging) -> AMBIGUOUS; a closed-but-unmerged PR is
//     never treated as merged merely because a Stage 2 reference happens to be present.
// When "PR" has no settled reference at all ("none", or the bullet is simply absent), a settled
// "Stage 2" reference continues to select the post-merge phase directly, with no live-PR-state
// read at all -- unchanged from before #537.
//
// Direct-reference mode (skips the control-Issue read entirely; "the PR/Audit numbers
// directly" per the Shared Contract):
//   node tools/orchestration/next-review-transition-gate.mjs --pr 376 --head <sha> --issue 375
//   node tools/orchestration/next-review-transition-gate.mjs --audit-issue 378
// Stage 1 review finding on PR #459 (P2): control-Issue mode reads a correction-satisfied
// disposition from the control Issue's own "- **Stage 1:**" bullet, but direct-reference mode
// had no equivalent input, so a corrected head's NOT_REQUESTED state was only ever resolvable
// through control-Issue mode even though this checker was already wired in. Pass the same
// disposition text directly with --stage1-disposition when driving direct-reference mode after
// a correction:
//   node tools/orchestration/next-review-transition-gate.mjs --pr 376 --head <corrected-sha> \
//     --issue 375 --stage1-disposition "correction-satisfied at <corrected-sha> (reviewed <reviewed-sha>)"
//
// Tests: node --test tools/orchestration/next-review-transition-gate.test.mjs

import { enforceControlPlaneFreshness } from "./control-plane-freshness.mjs";
import { execFileSync } from "node:child_process";
import { readGithubIssue, readGithubPr } from "./github-read.mjs";
import {
  parseControlBullet,
  parseExecutionPointer,
  isNoneSentinel,
  isLegacyStage2NotStartedSentinel,
  resolveRepoIdentity,
  readExecutionBulletField,
  describeExecutionConflict,
  findNearDuplicateBulletLabels,
  findOpenExecutionLinkedPr,
  referencesExecutionIssue,
  defaultOpenExecutionLinkedPrList,
} from "./ready-dispatch-gate.mjs";
import { run as stage1Run } from "../review-watch/stage1-gate.mjs";
import { findTriggerRounds } from "../review-watch/trigger.mjs";
import {
  checkMergeReady,
  checkPostAudit,
  findMatchingOpenAuditIssues,
  defaultGhIssueList as defaultGhAuditIssueSearchList,
  parseMergeCommitRef,
  parseWorkIssueRef,
} from "../review-watch/lifecycle-gate.mjs";
import { isCleanStage1Response } from "../review-watch/consumer-sync-gate.mjs";
import { isFindingsBearingResponse, isFormalReviewEndpoint } from "../review-watch/stage1-findings.mjs";
// Issue #454, unit 454-C: stage1-correction-gate.mjs itself imports `stage1DispositionMatchesHead`
// from this module (see that export's own comment below), so this is a deliberate circular
// import between the two modules. Both directions only reference the other's bindings from
// inside function bodies (never at module-top-level), so ESM's live-binding semantics resolve
// this safely regardless of which module is loaded first.
import {
  checkCorrectionDelta,
  defaultCompare,
  parseCorrectionSatisfiedDisposition,
  looksLikeCorrectionSatisfiedDisposition,
} from "../review-watch/stage1-correction-gate.mjs";
// Stage 1 review finding on PR #459 (the P1 finding): fold correction evidence into the
// single documented authoritative pre-merge gate (docs/bounded-review-cycle.md step 8/10)
// instead of authorizing merge from a private composition that could disagree with it.
// `combineMergeReadyResult` is merge-ready-gate.mjs's own pure combining logic, reused here
// (not re-implemented) against the exact same already-computed stage1/mergeReady/
// correctionDelta this module fetches for its own verdict — so this module's
// STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2 verdict and a fresh run of
// `merge-ready-gate.mjs --reviewed-head <sha>` against the same evidence can never diverge.
// Extends this file's own already-documented 2-node cycle with merge-ready-gate.mjs
// (merge-ready-gate.mjs itself imports checkCorrectionDelta from stage1-correction-gate.mjs,
// which imports stage1DispositionMatchesHead from this module) into a 3-node cycle; every
// side only reads the others' bindings from inside function bodies, never at module-top-level,
// so this remains safe under ESM's live-binding semantics regardless of load order.
import { combineMergeReadyResult } from "../review-watch/merge-ready-gate.mjs";
// Issue #486: the deterministic action-envelope table every verdict below is stamped with.
import { getActionEnvelope, getCorrectionContinuation } from "./action-envelope.mjs";
import { bindVerdictContinuation } from "./control-plane-continuation.mjs";
// Issue #883: the deterministic evidence-only Stage 2 correction evaluator.
import { evaluateEvidenceCorrection, Status as EvidenceStatus } from "./evidence-correction.mjs";
import { evaluateUnusableRecovery, Status as UnusableRecoveryStatus } from "./unusable-audit-recovery.mjs";
// Issue #678 Stage 1 correction (PR #714, finding 1): persists this gate's own verdict to a
// side channel at the exact moment main() is about to print it, so action-envelope-hook.mjs
// can still observe a bounded/none verdict when a downstream pipeline stage (e.g.
// pr-head-checkout-preflight.mjs --reserve-from-gate, format-dispatch-prompt.mjs) transforms
// the Bash tool's own captured stdout.
import { clearLastGateVerdict, persistLastGateVerdict } from "./action-envelope-hook.mjs";

// Pure. Reads one optional "- **Label:** value" control-Issue bullet that is expected to
// hold either the explicit "none" sentinel or exactly one "#N" issue reference (the same
// shape ready-dispatch-gate.mjs's "Execution" bullet uses, reused here for "PR" and
// "Stage 2"). Returns one of:
//   { kind: "missing", reason }  -- the bullet itself was not found at all.
//   { kind: "none" }             -- the bullet is present and explicitly "none".
//   { kind: "issue", issue }     -- the bullet names exactly one "#N" reference.
//   { kind: "invalid", reason }  -- the bullet is present but neither "none" nor exactly
//                                   one "#N" reference (missing, malformed, or multi-valued).
export function parseOptionalIssueRef(raw, label) {
  if (raw === null) {
    return { kind: "missing", reason: `no "- **${label}:**" bullet found in the control Issue body` };
  }
  if (isNoneSentinel(raw)) {
    return { kind: "none" };
  }
  // Issue #450 (the #428 live reproduction): the "Stage 2" bullet specifically may still
  // durably carry the one demonstrated legacy pre-Stage-2 synonym ("not started") from before
  // finalize-pr-breakpoint.mjs's canonicalizePreStage2Bullet started normalizing new writes to
  // the canonical "none" sentinel. Scoped to exactly this label — the "PR" bullet (and any
  // other future caller of this function) gets no such tolerance, preserving fail-closed
  // parsing everywhere else per #450 Required Behavior #3.
  if (label === "Stage 2" && isLegacyStage2NotStartedSentinel(raw)) {
    return { kind: "none" };
  }
  const parsed = parseExecutionPointer(raw);
  if (!parsed.ok) {
    return { kind: "invalid", reason: `"${label}" field ${JSON.stringify(raw)}: ${parsed.reason}` };
  }
  return { kind: "issue", issue: parsed.issue };
}

// Pure. Issue #493 (the #440 regression): wraps parseOptionalIssueRef with a near-duplicate-
// label ambiguity guard shared by the "PR" and "Stage 2" control bullets — the same silent-
// ignore hazard ready-dispatch-gate.mjs's readExecutionBulletField already closes for
// "Execution". When a recognized "- **<label>:**" bullet is present at all, an unrecognized
// near-duplicate label that could represent the same live field (e.g. canonical
// "Stage 2: #480" alongside "Stage 2 (current): #492") returns { kind: "ambiguous", reason }
// before the recognized value — possibly stale — is ever selected as authoritative. When no
// near-duplicate is found, behaves exactly like parseOptionalIssueRef(raw, label), preserving
// every existing missing/none/issue/invalid outcome unchanged.
export function parseOptionalIssueRefGuarded(body, label) {
  const raw = parseControlBullet(body, label);
  if (raw !== null) {
    const nearDuplicates = findNearDuplicateBulletLabels(body, label);
    if (nearDuplicates.length > 0) {
      return {
        kind: "ambiguous",
        reason:
          `"${label}" reference is ambiguous: recognized "- **${label}:**" bullet (${JSON.stringify(raw)}) coexists ` +
          `with unrecognized near-duplicate label(s) ${nearDuplicates
            .map((m) => `"- **${m.label}:**" (${JSON.stringify(m.raw)})`)
            .join(", ")} that could represent the same live field — refusing to select the canonical value as authoritative`,
      };
    }
  }
  return parseOptionalIssueRef(raw, label);
}

// Pure. True only for a result object this gate can trust as a genuine, fully-formed
// component result -- an object carrying a numeric exitCode. Mirrors merge-ready-gate.mjs's
// own hasTrustworthyExitCode guard: a component that returns malformed output (e.g. an
// injected test fake returning undefined, or a future bug in a composed script) must never
// be silently treated as a resolvable state.
function hasTrustworthyExitCode(result) {
  return result !== null && typeof result === "object" && typeof result.exitCode === "number";
}

// Pure core of the pre-merge phase: derives one verdict from an already-computed
// stage1-gate result and lifecycle-gate `checkMergeReady` result. See the module comment's
// verdict-derivation table for the exact mapping and why "actionable finding" content is
// not, and cannot be, evaluated here.
function isMergeReadyState(state) {
  return state === "MERGE_READY" || state === "MERGE_READY_NO_WORK_ISSUE";
}

function parseAffirmativeStage1Disposition(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || isNoneSentinel(text)) return null;
  const match = /^(satisfied|exempt)\s+at\s+([0-9a-f]{7,40})$/i.exec(text);
  if (!match) return null;
  return { state: match[1].toLowerCase(), sha: match[2].toLowerCase() };
}

// Exported so tools/review-watch/stage1-correction-gate.mjs (unit 454-B under #454's own
// Shared Contract) can reuse this exact case-insensitive prefix comparison for its own
// "correction-satisfied" disposition shape's head check, rather than re-implementing head
// comparison a second way. `disposition` only needs a `.sha` field — callers outside this
// module's own `parseAffirmativeStage1Disposition` may pass any object shaped that way.
export function stage1DispositionMatchesHead(disposition, head) {
  if (!disposition || typeof head !== "string" || !head.trim()) return false;
  return head.toLowerCase().startsWith(disposition.sha);
}

// Issue #1023 Stage 1 correction: ordinary-satisfied conflict recovery is authorized only by a parsed
// `satisfied` disposition at the head; a matching `exempt at <head>` must never reach it.
function stage1SatisfiedMatchesHead(raw, head) {
  const parsed = parseAffirmativeStage1Disposition(raw);
  return parsed !== null && parsed.state === "satisfied" && stage1DispositionMatchesHead(parsed, head);
}

// Codex's other known fixed Stage 1 preamble (observed live on PRs #275/#276), kept as its own
// unconditional check for backward compatibility with fixtures/history that predate stage1-
// findings.mjs's shared classifier and never carry a match `endpoint` field at all.
const FINDINGS_PREAMBLE_PATTERN = /^### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request\./;

// Live regression evidence on PR #435 itself: the genuine Codex review bound to commit
// `30b36035c9` opens with an insignificant leading newline before "### 💡 Codex Review",
// which this `^`-anchored pattern then fails to match -- silently misclassifying a
// findings-bearing response and falling through to `NO_ACTION_YET` instead of
// `STAGE1_CORRECTION_REQUIRED` below. Trimming only insignificant outer whitespace before
// testing tolerates that formatting noise without inspecting or adjudicating any actual
// finding content -- mirrors consumer-sync-gate.mjs's own `stripOuterWhitespace` fix for the
// same duplicated pattern, kept as an independent copy here rather than a cross-module import
// per this file's own module-comment convention (only `isCleanStage1Response` itself is a
// documented import exception).
function stripOuterWhitespace(text) {
  return (text ?? "").trim();
}

// PR #640 Stage 1 review finding #1: this gate used to recognize a findings-bearing round
// only via the fixed preamble above, so a genuine formal-review artifact whose body was
// ordinary finding text (e.g. "P1: missing null check...", with no fixed heading at all --
// exactly what stage1-gate.mjs's own new formal-artifact requirement, issue #638, now accepts
// as RESPONSE_RECEIVED) fell through to NO_ACTION_YET instead of STAGE1_CORRECTION_REQUIRED,
// stalling the deterministic workflow permanently. Propagating stage1-findings.mjs's shared,
// fail-closed content classifier -- but only for a match on a formal review endpoint
// (`isFormalReviewEndpoint`) -- recognizes that case without also flipping an ambiguous
// ack/kickoff comment (no formal endpoint, no recognized clean phrase) to findings-bearing;
// see the "kickoff/ack shape" regression test this gate's own test file still requires.
function hasFindingsStage1Response(stage1) {
  return [...(stage1.matches ?? []), ...(stage1.unboundGenuineMatches ?? [])].some((m) => {
    const bodyExcerpt = stripOuterWhitespace(m.body_excerpt);
    if (FINDINGS_PREAMBLE_PATTERN.test(bodyExcerpt)) return true;
    return isFormalReviewEndpoint(m.endpoint) && isFindingsBearingResponse(bodyExcerpt);
  });
}

// Issue #1023 (control #1022; live #963/#964/PR #1021): an ORDINARY Stage 1 satisfied PR
// (RESPONSE_RECEIVED, clean or head-scoped satisfied) can become genuinely CONFLICTING against its
// current target after the review. Before this, that evidence always returned the merge verdict and
// the merge action then failed (HTTP 405) with no deterministic route. `mergeConflict` is `null`
// whenever the caller did not fetch it (direct-reference/no-control invocations, or a direct unit
// call into this pure function), which preserves the unchanged merge verdict. EXEMPT is deliberately
// out of scope. The new verdict carries `reviewedHead` (the exact head Stage 1 was satisfied at) and
// NEVER a correctedHead: an ordinary satisfied PR has no correction-satisfied reviewed/corrected pair
// and none is fabricated here.
function ordinarySatisfiedMergeVerdict(context, mergeConflict, { stage1, mergeReady }) {
  if (mergeConflict) {
    if (!hasTrustworthyExitCode(mergeConflict) || mergeConflict.exitCode === 1) {
      return {
        state: "AMBIGUOUS",
        stopAfter: true,
        ...context,
        stage1,
        mergeReady,
        reason: `mergeability check for an ordinary Stage 1 satisfied merge failed operationally: ${mergeConflict.message}`,
      };
    }
    if (mergeConflict.mergeable === "CONFLICTING") {
      if (typeof context.head !== "string" || !/^[0-9a-f]{40}$/i.test(context.head)) {
        return {
          state: "AMBIGUOUS",
          stopAfter: true,
          ...context,
          stage1,
          mergeReady,
          reason: "confirmed CONFLICTING ordinary Stage 1 satisfied PR has no provable 40-character reviewed head; failing closed",
        };
      }
      return { state: "STAGE1_SATISFIED_MERGE_CONFLICT", stopAfter: true, ...context, reviewedHead: context.head };
    }
    if (mergeConflict.mergeable === "UNKNOWN") {
      // Never inferred as a conflict and never authorizes merge on unconfirmed evidence: wait and recheck.
      return { state: "NO_ACTION_YET", stopAfter: true, ...context, stage1, mergeReady };
    }
    if (mergeConflict.mergeable !== "MERGEABLE") {
      // A fetched probe must positively report MERGEABLE; missing/novel/malformed values never authorize merge.
      return {
        state: "AMBIGUOUS",
        stopAfter: true,
        ...context,
        stage1,
        mergeReady,
        reason: `mergeability check for an ordinary Stage 1 satisfied merge returned an unrecognized mergeable value ${JSON.stringify(mergeConflict.mergeable)}; failing closed`,
      };
    }
  }
  return { state: "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", stopAfter: true, ...context };
}

export function resolvePreMergeVerdict(
  { stage1, mergeReady, stage1Disposition = null, correctionDelta = null, mergeConflict = null, unfinalizedCorrection = null },
  context = {},
) {
  if (!hasTrustworthyExitCode(stage1) || !hasTrustworthyExitCode(mergeReady)) {
    return {
      state: "AMBIGUOUS",
      stopAfter: true,
      ...context,
      stage1,
      mergeReady,
      reason:
        "stage1-gate and/or lifecycle-gate merge-ready returned output without a trustworthy exitCode; " +
        "this gate fails closed rather than assuming a state.",
    };
  }

  if (stage1.exitCode === 1 || mergeReady.exitCode === 1) {
    return {
      state: "AMBIGUOUS",
      stopAfter: true,
      ...context,
      stage1,
      mergeReady,
      reason: [
        stage1.exitCode === 1 ? `stage1-gate operational error: ${stage1.message}` : null,
        mergeReady.exitCode === 1 ? `lifecycle-gate merge-ready operational error: ${mergeReady.message}` : null,
      ]
        .filter(Boolean)
        .join(" | "),
    };
  }

  const stage1DispositionSatisfiedAtHead = stage1SatisfiedMatchesHead(stage1Disposition, context.head);
  if (stage1.state === "NOT_REQUESTED") {
    // Issue #454, unit 454-C: a correction-satisfied disposition only ever matters once
    // stage1-gate itself reports NOT_REQUESTED at the current head (the reviewed head's own
    // findings-bearing response was already consumed at an earlier head, and no fresh Stage 1
    // trigger exists at this new one). `correctionDelta` is `null` whenever the "Stage 1"
    // bullet didn't parse as this new shape at all -- exactly preserving today's behavior
    // (plain NO_ACTION_YET) when this bullet shape is absent.
    if (correctionDelta && (!hasTrustworthyExitCode(correctionDelta) || correctionDelta.exitCode === 1)) {
      return {
        state: "AMBIGUOUS",
        stopAfter: true,
        ...context,
        stage1,
        mergeReady,
        reason:
          "tools/review-watch/stage1-correction-gate.mjs's checkCorrectionDelta returned output without a " +
          `trustworthy exitCode (or reported an operational error): ${correctionDelta && correctionDelta.message}`,
      };
    }
    if (correctionDelta && correctionDelta.state === "CORRECTION_SATISFIED") {
      // P1 finding on PR #459: do not decide merge authorization from a private
      // isMergeReadyState(mergeReady.state) check alone -- re-derive it through
      // merge-ready-gate.mjs's own combineMergeReadyResult, the exact composition
      // docs/bounded-review-cycle.md step 8/10 requires an executor to run before merging.
      // This guarantees a conforming executor running `merge-ready-gate.mjs --reviewed-head
      // <sha>` against the same evidence reaches the same exit-0/BLOCKED outcome this verdict
      // authorizes -- never a documented gate that stays permanently blocked while this
      // verdict says merge anyway.
      const composed = combineMergeReadyResult({ stage1, lifecycle: mergeReady, correctionDelta }, context);
      if (composed.exitCode === 0) {
        // Issue #665 (live #639/#638/PR #640 reproduction): every documented merge
        // prerequisite passed, but GitHub's own live mergeable state against the current
        // target branch is a distinct dimension none of them inspect. `mergeConflict` is
        // `null` whenever the caller did not fetch it (e.g. a direct unit-test call into this
        // pure function) -- preserving today's behavior exactly, since resolvePreMerge below
        // only ever fetches it on this exact branch.
        if (mergeConflict && (!hasTrustworthyExitCode(mergeConflict) || mergeConflict.exitCode === 1)) {
          return {
            state: "AMBIGUOUS",
            stopAfter: true,
            ...context,
            stage1,
            mergeReady,
            reason: `mergeability check for a correction-satisfied merge failed operationally: ${mergeConflict.message}`,
          };
        }
        if (mergeConflict && mergeConflict.mergeable === "CONFLICTING") {
          // A real pre-merge conflict against the current target branch. Merge is not
          // authorized until this is deterministically recovered -- see
          // docs/bounded-review-cycle.md's "Correction-satisfied merge-conflict recovery"
          // section and this verdict's own action-envelope entry for the one bounded
          // recovery worker this state authorizes.
          return {
            state: "STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT",
            stopAfter: true,
            ...context,
            reviewedHead: correctionDelta.reviewedHead,
            correctedHead: correctionDelta.correctedHead,
          };
        }
        if (mergeConflict && mergeConflict.mergeable === "UNKNOWN") {
          // GitHub has not finished computing mergeability yet -- neither confirmed
          // mergeable nor a confirmed conflict. Wait and re-invoke rather than either
          // authorizing merge on unconfirmed evidence or misdiagnosing a transient
          // "not yet computed" state as a genuine conflict requiring recovery.
          return { state: "NO_ACTION_YET", stopAfter: true, ...context, stage1, mergeReady };
        }
        return {
          state: "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2",
          stopAfter: true,
          ...context,
          reviewedHead: correctionDelta.reviewedHead,
          correctedHead: correctionDelta.correctedHead,
        };
      }
      if (composed.exitCode === 2 && composed.blockedBy?.length === 1 && composed.blockedBy[0].component === "lifecycle") {
        // Stage 1 review finding on PR #613 (P1): a correction-satisfied disposition already
        // exists and re-verified clean here — the only remaining blocker is the closing
        // reference, not a fresh findings-bearing correction. `correctionReason:
        // "closing-reference"` lets format-dispatch-prompt.mjs's formatter route this to the
        // ordinary closing-reference repair instruction instead of mandating
        // finalize-correction-breakpoint.mjs a second time over evidence it already verified.
        return { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, ...context, correctionReason: "closing-reference" };
      }
      // Any other composed outcome for an otherwise-satisfied correction delta (an
      // operational error from the composed check itself, or a combination this gate does
      // not recognize): fall through past this whole NOT_REQUESTED block to the function's
      // existing bottom-of-function AMBIGUOUS -- never NO_ACTION_YET here.
    } else if (correctionDelta && correctionDelta.state === "NOT_SATISFIED") {
      return {
        state: "AMBIGUOUS",
        stopAfter: true,
        ...context,
        stage1,
        mergeReady,
        reason: correctionDelta.reason,
      };
    } else if (correctionDelta && correctionDelta.state === "HEAD_MISMATCH") {
      // Issue #954 (live #951/#950/PR #952): a canonical correction-satisfied disposition can
      // become stale when the same one-round findings correction legitimately appends more
      // correction commits after an earlier finalization. If the existing unfinalized-correction
      // probe independently proves that later live head (findings provenance + strict ancestry +
      // execution-Issue commit provenance), re-enter the same deterministic finalizer instead of
      // dead-ending at NO_ACTION_YET. Without that proof, preserve the historical fallback.
      if (unfinalizedCorrection && context.controlIssue != null && Number.isInteger(context.issue)) {
        return {
          state: "STAGE1_CORRECTION_FINALIZATION_REQUIRED",
          stopAfter: true,
          ...context,
          stage1,
          mergeReady,
          reviewedHead: unfinalizedCorrection.reviewedHead,
          correctedHead: unfinalizedCorrection.correctedHead,
          nextCommand:
            `node tools/orchestration/finalize-correction-breakpoint.mjs --control-issue ${context.controlIssue} ` +
            `--execution-issue ${context.issue} --pr ${context.pr} ` +
            `--reviewed-head ${unfinalizedCorrection.reviewedHead} --corrected-head ${unfinalizedCorrection.correctedHead}`,
        };
      }
      return { state: "NO_ACTION_YET", stopAfter: true, ...context, stage1, mergeReady };
    } else if (!correctionDelta && looksLikeCorrectionSatisfiedDisposition(stage1Disposition)) {
      // Stage 1 review finding on PR #459: `parseCorrectionSatisfiedDisposition` returning
      // `null` collapses "no disposition present at all" and "a disposition that is clearly
      // attempting this shape but is malformed" into the same outcome, silently emitting
      // successful-exit NO_ACTION_YET for corrupted durable state instead of failing closed.
      // docs/bounded-review-cycle.md's own "Correction-satisfied disposition" section (and
      // the malformed-disposition contract every other affirmative Stage 1 disposition shape
      // already honors) promises AMBIGUOUS here instead.
      return {
        state: "AMBIGUOUS",
        stopAfter: true,
        ...context,
        stage1,
        mergeReady,
        reason:
          `control Issue "Stage 1" bullet ${JSON.stringify(stage1Disposition)} looks like a correction-satisfied ` +
          'disposition but does not match the required shape "correction-satisfied at <corrected-head-sha> ' +
          '(reviewed <reviewed-head-sha>)"',
      };
    } else {
      // correctionDelta is falsy and no correction-satisfied-shaped bullet is present at all
      // -- plain NO_ACTION_YET, exactly as before this disposition shape existed, EXCEPT
      // (issue #837, the #817/#835/PR #836 live reproduction) when `unfinalizedCorrection` proves
      // a findings-bearing correction already advanced this head from a reviewed head without
      // the canonical correction-satisfied disposition ever being finalized on the control
      // Issue. That state is a stranded breakpoint, not "nothing to do yet": it names exactly
      // the one deterministic finalize step, reusing finalize-correction-breakpoint.mjs as the
      // only evidence/projection path.
      if (unfinalizedCorrection && context.controlIssue != null && Number.isInteger(context.issue)) {
        return {
          state: "STAGE1_CORRECTION_FINALIZATION_REQUIRED",
          stopAfter: true,
          ...context,
          stage1,
          mergeReady,
          reviewedHead: unfinalizedCorrection.reviewedHead,
          correctedHead: unfinalizedCorrection.correctedHead,
          nextCommand:
            `node tools/orchestration/finalize-correction-breakpoint.mjs --control-issue ${context.controlIssue} ` +
            `--execution-issue ${context.issue} --pr ${context.pr} ` +
            `--reviewed-head ${unfinalizedCorrection.reviewedHead} --corrected-head ${unfinalizedCorrection.correctedHead}`,
        };
      }
      return { state: "NO_ACTION_YET", stopAfter: true, ...context, stage1, mergeReady };
    }
  }
  if (stage1.state === "PENDING") {
    if (hasFindingsStage1Response(stage1)) {
      return {
        state: "AMBIGUOUS",
        stopAfter: true,
        ...context,
        stage1,
        mergeReady,
        reason:
          "stage1-gate is still PENDING at the current head, but unbound genuine matches already include a " +
          "findings-bearing Stage 1 response; fail closed and verify those findings before proceeding.",
      };
    }
    return { state: "NO_ACTION_YET", stopAfter: true, ...context, stage1, mergeReady };
  }

  if (stage1.state === "EXEMPT") {
    if (isMergeReadyState(mergeReady.state)) {
      return { state: "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", stopAfter: true, ...context };
    }
    // Stage 1 review finding on PR #613 (P1): EXEMPT carries no findings at all -- the only
    // possible correction here is the closing reference. See the CORRECTION_SATISFIED branch
    // above for why this field exists.
    if (mergeReady.state === "BLOCKED_CLOSING_REFERENCE") {
      return { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, ...context, correctionReason: "closing-reference" };
    }
  }

  if (stage1.state === "RESPONSE_RECEIVED") {
    // Findings-bearing is checked first and takes precedence over isCleanStage1Response
    // (PR #640 Stage 1 review finding #2's own root cause applies here too):
    // isCleanStage1Response's CLEAN_REVIEW_PATTERN is, by design, a prefix match, so a formal
    // review whose body opens with the fixed clean-pass preamble and then appends a real
    // trailing finding would otherwise be misread as clean before this gate ever reached the
    // findings check. Checking findings first, using stage1-findings.mjs's severity-marker-
    // aware classifier, means that case now routes to correction instead of a false merge
    // authorization -- without changing consumer-sync-gate.mjs's own separately-tested
    // automated-sync classifier at all.
    if (hasFindingsStage1Response(stage1)) {
      if (stage1DispositionSatisfiedAtHead && isMergeReadyState(mergeReady.state)) {
        return ordinarySatisfiedMergeVerdict(context, mergeConflict, { stage1, mergeReady });
      }
      // The one genuinely findings-bearing path: #611's #438/PR #610 regression.
      // finalize-correction-breakpoint.mjs remains mandatory here.
      return { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, ...context, correctionReason: "findings" };
    }
    if (isCleanStage1Response(stage1)) {
      if (isMergeReadyState(mergeReady.state)) {
        return ordinarySatisfiedMergeVerdict(context, mergeConflict, { stage1, mergeReady });
      }
      // Stage 1 review finding on PR #613 (P1): a clean-pass response has no findings either --
      // same closing-reference-only reasoning as the EXEMPT branch above.
      if (mergeReady.state === "BLOCKED_CLOSING_REFERENCE") {
        return { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, ...context, correctionReason: "closing-reference" };
      }
    }
    return { state: "NO_ACTION_YET", stopAfter: true, ...context, stage1, mergeReady };
  }

  return {
    state: "AMBIGUOUS",
    stopAfter: true,
    ...context,
    stage1,
    mergeReady,
    reason:
      `stage1-gate state ${JSON.stringify(stage1.state)} combined with lifecycle-gate merge-ready state ` +
      `${JSON.stringify(mergeReady.state)} and Stage 1 disposition ${JSON.stringify(stage1Disposition)} ` +
      "does not resolve to exactly one known pre-merge transition",
  };
}

// Issue #542: appends the deterministic thin-control terminalization command
// (`tools/orchestration/close-control.mjs`) to a `STAGE2_CLOSE_READY` `nextCommand` chain,
// but only when `controlIssue` is a real number — i.e. only when *this gate itself* was
// invoked in control-Issue mode (a real `--control-issue` on the current invocation), or (issue
// #550 correction) when direct-reference mode's own `checkPostAudit` call redirected a mistaken
// thin-control `auditIssue` input to the real Stage 2 Audit Issue it names — in which case that
// original input is itself the thin control needing terminalization, and `resolvePostMerge`
// populates `context.controlIssue` with it for exactly this reason. Absent either of those two
// explicit sources, direct-reference mode leaves `context.controlIssue` `null`, so this never
// chains for a no-thin-control flow — satisfying #542 requirement 3 ("fail closed on control
// identity") structurally: this function never searches for or guesses a control Issue, it only
// reacts to one the caller already resolved from its own explicit argument or its own bounded
// redirect recovery. This closes the #486/#487/#538 gap: work and audit terminalized correctly,
// the controller correctly stopped per #486's action-envelope boundary, but the founder-facing
// thin control Issue was left open with stale lifecycle fields, requiring manual repair.
//
// Stage 1 review finding on PR #544: the `&&` chain below joins this command after
// `lifecycle-gate.mjs close-audit`, but that command's own CLI exits 0 even for its normal,
// non-error `NOT_TERMINAL_YET` result (the audit correctly stayed open) — a 0-exit code alone is
// never proof the audit actually closed, so a shell chain gated only on exit codes cannot itself
// keep `close-control.mjs` from running against a still-open audit if evidence changed between
// this gate's own read-only check and `nextCommand`'s later execution. This is deliberately not
// fixed by restructuring the chain to parse `close-audit`'s JSON output between steps;
// `close-control.mjs` independently re-fetches and revalidates the named audit issue's own live
// GitHub state (`state === "CLOSED"`) before ever mutating the control, so it fails closed
// (REJECTED) regardless of what produced its `--audit-issue` argument or that argument's own
// exit code. See close-control.mjs's `checkCloseControl` for that independent check.
function appendCloseControlCommand(baseCommand, { repo, controlIssue, auditIssue, workIssue }) {
  if (controlIssue === null || controlIssue === undefined) return baseCommand;
  const workIssueArg = typeof workIssue === "number" && Number.isFinite(workIssue) ? ` --work-issue ${workIssue}` : "";
  return (
    `${baseCommand} && node tools/orchestration/close-control.mjs --repo ${repo} --control-issue ${controlIssue} ` +
    `--audit-issue ${auditIssue}${workIssueArg}`
  );
}

// Pure core of the post-merge phase: derives one verdict from an already-computed
// lifecycle-gate `checkPostAudit` result. See the module comment's verdict-derivation table.
export function resolvePostMergeVerdict({ postAudit }, context = {}) {
  if (!hasTrustworthyExitCode(postAudit)) {
    return {
      state: "AMBIGUOUS",
      stopAfter: true,
      ...context,
      postAudit,
      reason:
        "lifecycle-gate post-audit returned output without a trustworthy exitCode; this gate fails closed " +
        "rather than assuming a state.",
    };
  }

  if (postAudit.exitCode === 1) {
    return {
      state: "AMBIGUOUS",
      stopAfter: true,
      ...context,
      postAudit,
      reason: `lifecycle-gate post-audit operational error: ${postAudit.message}`,
    };
  }

  if (postAudit.state === "READY_TO_CLOSE" || postAudit.state === "ACCEPTED_NO_WORK_ISSUE") {
    // Issue #407 unit 407-B (Shared Contract item 9, the #380/#384 fix): STAGE2_CLOSE_READY
    // must deterministically lead to invoking `lifecycle-gate.mjs close-audit`, not only
    // closing the work issue — a prose reminder alone already proved insufficient. `context`
    // here always carries `repo` and `auditIssue` (this branch is reached only from
    // resolvePostMerge, which supplies both), so `nextCommand` names the exact real
    // (non-dry-run) invocation the caller must run next, never left to be reconstructed by
    // hand or skipped.
    //
    // Stage 1 review finding on PR #435: `close-audit` alone deliberately never touches the
    // gated work issue (Shared Contract item 3), so a CLEAN cycle that only ran `close-audit`
    // left the work issue itself open indefinitely -- exactly the #380/#384 shape one step
    // further down the chain. `READY_TO_CLOSE` always carries a real `postAudit.workIssue`
    // (checkPostAudit's own no-work-issue branch reports `ACCEPTED_NO_WORK_ISSUE` instead, with
    // `workIssue: null`), so `nextCommand` chains `close-work-issue` before `close-audit` only
    // when there is a real gated work issue to close; `ACCEPTED_NO_WORK_ISSUE` keeps the
    // audit-only behavior unchanged, since there is no work issue for it to close.
    const closeAuditCommand = `node tools/review-watch/lifecycle-gate.mjs close-audit --repo ${context.repo} --audit-issue ${context.auditIssue}`;
    const hasWorkIssue = typeof postAudit.workIssue === "number" && Number.isFinite(postAudit.workIssue);
    const baseCommand = hasWorkIssue
      ? `node tools/review-watch/lifecycle-gate.mjs close-work-issue --repo ${context.repo} --work-issue ${postAudit.workIssue} --audit-issue ${context.auditIssue} && ${closeAuditCommand}`
      : closeAuditCommand;
    // Issue #542: chain the thin-control terminalization command last, but only for a
    // control-Issue-mode invocation (context.controlIssue is a real number) — see
    // appendCloseControlCommand's own comment above.
    const nextCommand = appendCloseControlCommand(baseCommand, {
      repo: context.repo,
      controlIssue: context.controlIssue,
      auditIssue: context.auditIssue,
      workIssue: hasWorkIssue ? postAudit.workIssue : null,
    });
    return { state: "STAGE2_CLOSE_READY", stopAfter: true, ...context, postAudit, nextCommand };
  }

  if (postAudit.state === "REPORT_READY_TO_RECORD") {
    // Issue #439 (the live #408/#436 gap): a completed Stage 2 report already exists on the
    // thread — of either verdict — but the audit issue's own durable Verdict field is still
    // PENDING/malformed. `nextCommand` names the exact real (non-dry-run) promotion invocation;
    // per this verdict's own contract (mirroring STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2's
    // "perform the action, then stop" precedent), a controller runs it once and stops — it does
    // not chain straight into re-resolving this gate in the same step. A fresh invocation
    // afterward resolves the now-recorded verdict through STAGE2_CLOSE_READY/
    // STAGE2_CORRECTION_REQUIRED/NO_ACTION_YET below exactly as if a human had set the field.
    return {
      state: "STAGE2_REPORT_READY_TO_RECORD",
      stopAfter: true,
      ...context,
      postAudit,
      nextCommand: `node tools/review-watch/lifecycle-gate.mjs record-verdict --repo ${context.repo} --audit-issue ${context.auditIssue}`,
    };
  }

  if (postAudit.state === "RESPONSE_UNUSABLE") {
    // Issue #447 (live reproductions #446 and #380's first round): lifecycle-gate.mjs's
    // checkPostAudit already distinguishes "no genuine reviewer response yet" (state A, falls
    // through to the ordinary NO_ACTION_YET branch below via its own unmodified OK result) from
    // "a genuine reviewer response landed, but none is a provenance-valid completed Stage 2
    // report" (state C, RESPONSE_UNUSABLE) -- this branch is what keeps state C from ever being
    // reported as ordinary waiting at the composed-gate level, the actual failure a controller
    // observed: a genuine response had landed, yet next-review-transition-gate.mjs still returned
    // plain NO_ACTION_YET, indistinguishable from a controller merely needing to poll again.
    // STAGE2_RESPONSE_UNUSABLE is a distinct, deterministic, fail-closed state (never AMBIGUOUS's
    // "this gate does not recognize the state" fallback, and never a silent recovery) -- it names
    // the audit issue and the exact genuine-but-unusable response reference(s)
    // (postAudit.reportEvidence.genuineResponses) so a fresh controller can act without broad
    // repository archaeology. It never accepts a structurally complete-looking non-bot report as
    // assurance (lifecycle-gate.mjs's findAllMatches only ever considers bot-authored comments as
    // candidates at all -- a detailed `LouPineWays`-authored report, #446's own reproduction, is
    // never even in reportEvidence.genuineResponses), and it never authorizes an automatic second
    // Stage 2 trigger or reviewer coaching (issue #259's anti-coaching authority is unchanged --
    // this state only reports; it performs no mutation of its own). Re-running this gate against
    // the same durable evidence deterministically reproduces the same STAGE2_RESPONSE_UNUSABLE
    // result (no retrigger, no poll, no issue creation -- idempotent per this Issue's own
    // acceptance criteria); once a later genuine, complete bot response lands on the same thread,
    // lifecycle-gate.mjs's own findStage2ReportEvidence finds it and checkPostAudit reports
    // REPORT_READY_TO_RECORD/READY_TO_CLOSE/STAGE2_CORRECTION_REQUIRED normally on the very next
    // invocation -- recovery resumes automatically from durable state, with no special-cased
    // "unusable -> normal" transition logic of its own.
    return { state: "STAGE2_RESPONSE_UNUSABLE", stopAfter: true, ...context, postAudit };
  }

  if (postAudit.state === "TRIGGER_REQUIRED") {
    // Issue #735 (live #398/#729/PR #733/Audit #734 reproduction): lifecycle-gate.mjs's
    // checkPostAudit now distinguishes "this canonical Audit Issue was never triggered at all"
    // (this branch) from ordinary "triggered, correctly still waiting for a response" (the
    // unmodified NO_ACTION_YET fallthrough in the generic OK branch below, reached only once
    // postAudit.reportEvidence.hasTrigger is true). Before this fix both shapes reached the
    // identical generic OK/PENDING result, so a canonical, exact-merge, PENDING Audit Issue with
    // zero issue comments -- #734's exact live shape -- silently resolved to terminal
    // NO_ACTION_YET even though independent review had never been requested.
    //
    // `context` here is always `{ repo, auditIssue, controlIssue? }` (resolvePostMerge's own
    // composition) -- exactly what `tools/review-watch/trigger.mjs --kind issue` needs. Unlike
    // STAGE2_AUDIT_ALREADY_PREPARED's pre-merge resume (which chains finalize-audit-breakpoint.mjs
    // first because the control Issue's own Stage 2/Lifecycle projection has not happened yet),
    // reaching this post-merge branch at all already requires a settled "Stage 2" reference on the
    // control Issue (or a direct-reference `--audit-issue` invocation) -- the finalization/
    // projection issue #561 requires strictly before a reviewer trigger has, by construction,
    // already happened durably. There is nothing left to (re-)finalize or (re-)project here, so
    // `nextCommand` names only the one remaining step: the idempotent trigger.mjs invocation
    // (docs/bounded-review-cycle.md Stage 2 step 4). trigger.mjs's own dedup (`findExistingTrigger`)
    // makes a retry of this exact command safe -- it never posts a second trigger once one exists,
    // matching this Issue's own idempotence requirement across every interruption boundary.
    return {
      state: "STAGE2_TRIGGER_REQUIRED",
      stopAfter: true,
      ...context,
      postAudit,
      nextCommand: `node tools/review-watch/trigger.mjs --repo ${context.repo} --kind issue --number ${context.auditIssue}`,
    };
  }

  if (postAudit.state === "OK") {
    // Stage 1 review finding on PR #435: the motivating resume case -- the work issue is
    // already closed, but its backed-CLEAN audit was never consumed -- never reaches
    // checkPostAudit's `READY_TO_CLOSE` branch at all (that branch requires the work issue to
    // still be open); it surfaces here as plain `OK` with `verdict: "CLEAN"` and
    // `workIssueState: "CLOSED"` instead, and previously fell all the way through to
    // `NO_ACTION_YET` below -- preserving the exact #380/#384 defect this whole mechanism
    // exists to fix. Route it to `STAGE2_CLOSE_READY` too, audit-only (the work issue is
    // already closed, so only `close-audit` is needed -- never re-attempt closing it).
    if (postAudit.verdict === "CLEAN" && postAudit.workIssueState === "CLOSED") {
      const baseCommand = `node tools/review-watch/lifecycle-gate.mjs close-audit --repo ${context.repo} --audit-issue ${context.auditIssue}`;
      // Issue #542: the work issue here is already closed (workIssueState "CLOSED"), so it is
      // still passed through to close-control's own --work-issue (for its informational
      // "Terminal result" text only — close-control never re-closes it) when known.
      const nextCommand = appendCloseControlCommand(baseCommand, {
        repo: context.repo,
        controlIssue: context.controlIssue,
        auditIssue: context.auditIssue,
        workIssue: typeof postAudit.workIssue === "number" && Number.isFinite(postAudit.workIssue) ? postAudit.workIssue : null,
      });
      return {
        state: "STAGE2_CLOSE_READY",
        stopAfter: true,
        ...context,
        postAudit,
        nextCommand,
      };
    }
    if (postAudit.rawVerdict === "NOT CLEAN") {
      // Issue #646: thread the audited Work/execution Issue through from durable authority
      // (checkPostAudit's own already-fetched `workIssue`, parsed from the Audit Issue's own
      // "Work issue" field) rather than leaving a dispatched correction worker or the
      // reconciliation check below to re-derive it a second way. Absent for the explicit
      // no-work-issue state (issue #190) -- reconciliation below is skipped in that case, since
      // there is no execution-linked PR search to perform without a work Issue to search for.
      return {
        state: "STAGE2_CORRECTION_REQUIRED",
        stopAfter: true,
        ...context,
        workIssue: typeof postAudit.workIssue === "number" ? postAudit.workIssue : null,
      };
    }
    // rawVerdict is null/PENDING, or CLEAN-but-not-yet-backed-by-a-completed-report (verdict
    // nulled out by checkPostAudit itself in that case) -- either way, no completed Stage 2
    // report exists yet to act on.
    return { state: "NO_ACTION_YET", stopAfter: true, ...context, postAudit };
  }

  // PREMATURE_CLOSURE (a work issue closed without a backing CLEAN verdict) is itself a
  // recoverable-but-abnormal state (lifecycle-gate.mjs's own `--recover true`), and any other
  // state this gate does not recognize falls here too: neither is safely resolvable into one
  // of the six fixed dispatch verdicts without a mutating recovery step this read-only gate
  // does not perform on its own.
  return {
    state: "AMBIGUOUS",
    stopAfter: true,
    ...context,
    postAudit,
    reason:
      `lifecycle-gate post-audit state ${JSON.stringify(postAudit.state)} (rawVerdict ` +
      `${JSON.stringify(postAudit.rawVerdict ?? null)}) does not resolve to exactly one known post-merge transition`,
  };
}

// Exit-code scheme (this script's own; no prior convention already fixed it, so it mirrors
// ready-dispatch-gate.mjs's READY/BLOCKED/NOT_READY/ERROR split as closely as this verdict
// set allows): 0 for a verdict that authorizes proceeding or explicitly says "wait, nothing
// to do" (NO_ACTION_YET, STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2,
// STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2 -- issue #454, unit 454-C: same "merge and
// trigger Stage 2, then stop" bucket as STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2, kept as a
// distinct verdict string purely for durable auditability of which path authorized the merge --
// STAGE2_CLOSE_READY, STAGE2_REPORT_READY_TO_RECORD -- issue #439: this names a required,
// non-blocking promotion action, the same "authorizes proceeding" bucket as STAGE2_CLOSE_READY,
// never an error or an outstanding correction); 3 for a verdict that names a concrete,
// non-blocking corrective action required before the happy path can proceed
// (STAGE1_CORRECTION_REQUIRED, STAGE2_CORRECTION_REQUIRED); 4 for AMBIGUOUS and
// STAGE2_RESPONSE_UNUSABLE (both mirror BLOCKED's exit 4 -- a positive "stop, do not improvise"
// signal; issue #447: STAGE2_RESPONSE_UNUSABLE is a distinct, deterministic, *recognized*
// fail-closed state, never AMBIGUOUS's own "this gate does not recognize the state" meaning -- it
// shares AMBIGUOUS's exit code only because both require the same bounded recovery/founder-
// interrupt stop, not because they are the same condition); 1 for a genuine operational error
// (missing/invalid arguments, or an underlying `gh` read that itself failed before any verdict
// could be computed at all).
function exitCodeFor(state) {
  switch (state) {
    case "NO_ACTION_YET":
    case "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2":
    case "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2":
    // Issue #718: names a required, non-blocking resume action (dispatch the Stage 2
    // preparation worker) -- the same "authorizes proceeding" bucket as the two merge/trigger
    // verdicts above, never an error or an outstanding correction.
    case "STAGE2_PREPARATION_REQUIRED":
    // Issue #729: names a required, non-blocking resume action (finalize the already-durable
    // Audit Issue, then trigger) -- same "authorizes proceeding" bucket as its
    // STAGE2_PREPARATION_REQUIRED sibling. Not reached via this switch today (the inline
    // construction sets its own literal exitCode: 0), kept here only for this function's own
    // documented exhaustiveness.
    case "STAGE2_AUDIT_ALREADY_PREPARED":
    case "STAGE2_CLOSE_READY":
    case "STAGE2_REPORT_READY_TO_RECORD":
    // Issue #735: names a required, non-blocking resume action (post the missing Stage 2
    // reviewer trigger on an already-prepared, already-projected canonical Audit Issue) -- same
    // "authorizes proceeding" bucket as its STAGE2_REPORT_READY_TO_RECORD/
    // STAGE2_AUDIT_ALREADY_PREPARED siblings, never an error or an outstanding correction.
    case "STAGE2_TRIGGER_REQUIRED":
    // Issue #883: both evidence-recovery verdicts name one concrete required next command
    // (prepare the single re-audit; project + trigger it) -- same "authorizes proceeding" bucket
    // as STAGE2_TRIGGER_REQUIRED, never an outstanding source correction.
    case "STAGE2_EVIDENCE_REAUDIT_PREPARATION_REQUIRED":
    case "STAGE2_EVIDENCE_REAUDIT_READY":
    // Issue #985: the unusable-response replacement verdicts name one concrete required next
    // command each (prepare the single replacement; project + trigger it) -- same bucket.
    case "STAGE2_UNUSABLE_REPLACEMENT_PREPARATION_REQUIRED":
    case "STAGE2_UNUSABLE_REPLACEMENT_READY":
      return 0;
    case "STAGE1_CORRECTION_REQUIRED":
    // Issue #837: names the one concrete, non-blocking finalize step a stranded corrected head
    // needs -- same bucket as its STAGE1_CORRECTION_REQUIRED sibling.
    case "STAGE1_CORRECTION_FINALIZATION_REQUIRED":
    case "STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT":
    // Issue #1023: ordinary satisfied analog; same bounded corrective-action bucket.
    case "STAGE1_SATISFIED_MERGE_CONFLICT":
    case "STAGE2_CORRECTION_REQUIRED":
    // Issue #646: STAGE2_CORRECTION_PR_NEEDS_FINALIZATION names a concrete, non-blocking
    // corrective action too (run the trigger/finalize nextCommand) -- same exit-code bucket as
    // its STAGE2_CORRECTION_REQUIRED sibling, never the "authorizes proceeding" bucket above.
    case "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION":
    // Stage 1 correction on PR #721: names a concrete, non-blocking corrective action (run
    // finalize-stage1-satisfied-breakpoint.mjs --recover true) required before Stage 2
    // preparation may resume -- same bucket as its STAGE1_CORRECTION_REQUIRED sibling. Not
    // reached via this switch today (the inline construction sets its own literal exitCode:3),
    // kept here only for this function's own documented exhaustiveness.
    case "STAGE2_PREPARATION_BLOCKED_ON_STAGE1":
      return 3;
    case "AMBIGUOUS":
    case "STAGE2_RESPONSE_UNUSABLE":
      return 4;
    default:
      return 4;
  }
}

// Issue #837 / #913: the shared unfinalized-findings-correction probe. Used by the pre-merge phase
// (PR still open at the corrected head) and by the merged-PR resume branches (the #702/#910/PR #909
// recurrence, where the PR merged at the corrected head while the control still read the stale
// pre-correction "requested" disposition). The reviewed head is the most recent Stage 1 trigger
// round bound to a head other than `head`; it is evidence-checked by checkCorrectionDelta (genuine
// head-bound findings + strict non-diverged ancestry + head match) and by correction provenance on
// every intervening commit, never taken on faith. Returns { unfinalizedCorrection } (null when the
// evidence is absent/unrelated -- the caller keeps its pre-existing behavior) or { ambiguous }
// (an operational/unreadable failure -- fail closed).
function unrecoverableCorrectionVerdict(u, { repo, pr, head, issue, controlIssue }) {
  return {
    exitCode: 4,
    state: "AMBIGUOUS",
    stopAfter: true,
    repo,
    pr,
    head,
    issue,
    controlIssue,
    reviewedHead: u.reviewedHead,
    correctedHead: u.correctedHead,
    reason: u.reason,
  };
}

async function probeUnfinalizedCorrection(
  { repo, pr, head, issue, controlIssue },
  { checkCorrectionDeltaImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl = defaultReadTargetBranchCommits },
) {
  const ambiguous = (reason) => ({
    ambiguous: { exitCode: 4, state: "AMBIGUOUS", stopAfter: true, repo, pr, head, issue, controlIssue, reason },
  });
  let heads;
  try {
    heads = await listStage1TriggerHeadsImpl({ repo, pr });
  } catch (err) {
    return ambiguous(`could not read PR #${pr}'s Stage 1 trigger rounds to check for an unfinalized correction: ${err.message}`);
  }
  const reviewedHead = (Array.isArray(heads) ? heads : []).find(
    (h) => typeof h === "string" && h && h.toLowerCase() !== String(head).toLowerCase(),
  );
  if (!reviewedHead) return { unfinalizedCorrection: null };
  let delta;
  try {
    delta = await checkCorrectionDeltaImpl({ repo, pr, reviewedHead, correctedHead: head, gatedHead: head });
  } catch (err) {
    delta = { exitCode: 1, message: `stage1-correction-gate threw: ${err.message}` };
  }
  if (!delta || typeof delta.exitCode !== "number" || delta.exitCode === 1) {
    return ambiguous(`unfinalized-correction probe against reviewed head ${reviewedHead} failed operationally: ${delta && delta.message}`);
  }
  if (delta.state !== "CORRECTION_SATISFIED") return { unfinalizedCorrection: null };
  // Stage 1 review finding on PR #838 (P1): head ancestry plus genuine findings at the reviewed
  // head proves a descendant exists, not that the descendant is the authorized correction of those
  // findings (an unrelated commit or merge-forward satisfies the same shape). Require every
  // intervening commit to carry the execution Issue's own provenance; anything unverifiable stays
  // unrelated (null) or AMBIGUOUS (unreadable) -- never a finalization authorization.
  let commits;
  try {
    commits = await readCorrectionCommitsImpl({ repo, base: delta.reviewedHead, head: delta.correctedHead });
  } catch (err) {
    return ambiguous(`could not read the commits between reviewed head ${reviewedHead} and ${head} to verify correction provenance: ${err.message}`);
  }
  let provenanceOk;
  let provenanceReason = "";
  try {
    const provenance = await verifyCorrectionProvenanceWithRecovery({ commits, executionIssue: issue, repo, pr, reviewedHead: delta.reviewedHead, readTargetCommitsImpl });
    provenanceOk = provenance.ok;
    provenanceReason = provenance.reason ?? "";
  } catch (err) {
    return ambiguous(`could not read target-branch commits to verify correction provenance: ${err.message}`);
  }
  if (!provenanceOk) {
    // Issue #924 (the #908/#907/PR #923 escape): genuine head-bound findings plus a strict
    // descendant already passed checkCorrectionDelta above, so a provenance failure here is not
    // "nothing happened" -- it is a findings round whose descendant cannot be attributed to the
    // execution Issue (e.g. the correction commit omitted `#<issue>`). Plain NO_ACTION_YET with an
    // empty envelope is the dead end this closes. Surface a specific fail-closed result instead;
    // the verifier itself is unchanged (no PR-number/diff/conversational substitute).
    return {
      unfinalizedCorrection: null,
      unrecoverable: {
        reviewedHead: delta.reviewedHead,
        correctedHead: delta.correctedHead,
        reason:
          `PR #${pr} advanced from findings-reviewed head ${delta.reviewedHead} to ${delta.correctedHead}, but the ` +
          `correction range is not mechanically attributable to execution Issue #${issue} (${provenanceReason}); ` +
          "finalize-correction-breakpoint.mjs cannot record the canonical correction-satisfied disposition, and " +
          "no ordinary Stage 1 re-review is authorized. Smallest continuation: founder authorizes republishing the " +
          `correction with its commit message(s) naming #${issue} (a history rewrite this gate never performs), ` +
          "then re-run the finalizer; do not request a second ordinary review.",
      },
    };
  }
  return { unfinalizedCorrection: { reviewedHead: delta.reviewedHead, correctedHead: delta.correctedHead } };
}

// PR #955 Stage 1 correction (#954): a stale canonical correction-satisfied disposition is
// recoverable only when the live head is a strict continuation of the correction that was already
// finalized. The ordinary unfinalized-correction probe proves reviewed->live findings/provenance,
// but by itself it also admits a force-pushed sibling correction from the same reviewed head. First
// prove old-corrected->live is strictly "ahead", then reuse the existing probe. Operational compare
// failures fail closed; a non-ahead relation is simply not a valid later continuation.
async function probeStaleCorrectionContinuation(
  { repo, pr, head, issue, controlIssue, disposition },
  {
    compareImpl = defaultCompare,
    checkCorrectionDeltaImpl,
    listStage1TriggerHeadsImpl,
    readCorrectionCommitsImpl,
    readTargetCommitsImpl,
  },
) {
  const ambiguous = (reason) => ({
    ambiguous: { exitCode: 4, state: "AMBIGUOUS", stopAfter: true, repo, pr, head, issue, controlIssue, reason },
  });
  if (!disposition?.correctedHead || !disposition?.reviewedHead) return { unfinalizedCorrection: null };

  let ancestry;
  try {
    ancestry = await compareImpl({ repo, base: disposition.correctedHead, head });
  } catch (err) {
    return ambiguous(
      `could not verify stale correction continuation from recorded corrected head ${disposition.correctedHead} to live head ${head}: ${err.message}`,
    );
  }
  if (!ancestry || typeof ancestry.status !== "string") {
    return ambiguous(
      `stale correction continuation compare for ${disposition.correctedHead}...${head} returned no trustworthy status`,
    );
  }
  if (ancestry.status !== "ahead") return { unfinalizedCorrection: null };

  const probe = await probeUnfinalizedCorrection(
    { repo, pr, head, issue, controlIssue },
    { checkCorrectionDeltaImpl, compareImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
  );
  if (probe.ambiguous || probe.unrecoverable || !probe.unfinalizedCorrection) return probe;

  // Bind the re-finalization to the same Stage 1 findings round the durable disposition records.
  // A different trigger round must never be borrowed merely because it can prove its own
  // reviewed->live correction lineage.
  if (
    !stage1DispositionMatchesHead(
      { sha: disposition.reviewedHead.toLowerCase() },
      probe.unfinalizedCorrection.reviewedHead,
    )
  ) {
    return { unfinalizedCorrection: null };
  }
  return probe;
}

// Issue #913 (the #702/#910/PR #909 recurrence): a MERGED PR whose control "Stage 1" bullet is
// neither an affirmative nor a correction-satisfied disposition is ordinarily a stranded no-findings
// state recoverable by finalize-stage1-satisfied-breakpoint.mjs --recover true. When durable
// evidence instead proves a findings-bearing round followed by an accepted, provenance-bearing
// correction that is the exact merged PR head (probeUnfinalizedCorrection, merged head =
// `headRefOid`), that ordinary recovery would (correctly) refuse the prestate -- the one-round
// policy forbids a second review, and a findings round must never be flattened into
// "satisfied at <head>". Route to the existing correction-finalization verdict instead, whose
// bounded envelope authorizes only finalize-correction-breakpoint.mjs. Returns the verdict to emit,
// or null when no such evidence exists (caller keeps its pre-existing ordinary-recovery verdict).
async function mergedUnfinalizedCorrectionVerdict(
  { repo, pr, headRefOid, issue, controlIssue, stage1Bullet },
  {
    compareImpl = defaultCompare,
    checkCorrectionDeltaImpl,
    listStage1TriggerHeadsImpl,
    readCorrectionCommitsImpl,
    readTargetCommitsImpl,
  },
) {
  if (typeof headRefOid !== "string" || !headRefOid.trim()) return null;
  // Ordinary affirmative dispositions and malformed correction-satisfied-looking values retain
  // their existing handling. A strictly parsed correction-satisfied disposition is admitted only
  // through the stale-continuation proof below, which additionally requires old-corrected->live
  // strict ancestry before the existing reviewed->live findings/provenance probe can authorize
  // re-finalization.
  if (parseAffirmativeStage1Disposition(stage1Bullet) !== null) return null;
  const parsedCorrectionSatisfied = parseCorrectionSatisfiedDisposition(stage1Bullet);
  if (parsedCorrectionSatisfied === null && looksLikeCorrectionSatisfiedDisposition(stage1Bullet)) return null;
  // Stage 1 correction on PR #914: a bullet that opens with an affirmative keyword
  // ("satisfied"/"exempt") but failed the strict parse (e.g. "satisfied at not-a-sha") is a
  // malformed durable assertion, not a stranded prestate -- never recover over it.
  if (typeof stage1Bullet === "string" && /^(satisfied|exempt)(?:\s|$)/i.test(stage1Bullet.trim())) return null;
  const probe = parsedCorrectionSatisfied
    ? await probeStaleCorrectionContinuation(
        { repo, pr, head: headRefOid, issue, controlIssue, disposition: parsedCorrectionSatisfied },
        {
          compareImpl,
          checkCorrectionDeltaImpl,
          listStage1TriggerHeadsImpl,
          readCorrectionCommitsImpl,
          readTargetCommitsImpl,
        },
      )
    : await probeUnfinalizedCorrection(
        { repo, pr, head: headRefOid, issue, controlIssue },
        { checkCorrectionDeltaImpl, compareImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
      );
  if (probe.ambiguous) return probe.ambiguous;
  if (probe.unrecoverable) return unrecoverableCorrectionVerdict(probe.unrecoverable, { repo, pr, head: headRefOid, issue, controlIssue });
  const found = probe.unfinalizedCorrection;
  if (!found) return null;
  return {
    exitCode: 3,
    state: "STAGE1_CORRECTION_FINALIZATION_REQUIRED",
    stopAfter: true,
    repo,
    controlIssue,
    pr,
    head: headRefOid,
    issue,
    prState: "MERGED",
    reviewedHead: found.reviewedHead,
    correctedHead: found.correctedHead,
    reason:
      `PR #${pr} is already MERGED at corrected head ${found.correctedHead}, but control Issue #${controlIssue}'s ` +
      `"Stage 1" bullet never recorded the findings-bearing correction (reviewed ${found.reviewedHead}) -- ` +
      "finalize the canonical correction-satisfied disposition; ordinary satisfied recovery does not apply",
    nextCommand:
      `node tools/orchestration/finalize-correction-breakpoint.mjs --control-issue ${controlIssue} ` +
      `--execution-issue ${issue} --pr ${pr} --reviewed-head ${found.reviewedHead} --corrected-head ${found.correctedHead}`,
  };
}

async function resolvePreMerge(
  { repo, pr, head, issue, stage1Disposition = null, controlIssue },
  {
    stage1RunImpl,
    checkMergeReadyImpl,
    checkCorrectionDeltaImpl,
    compareImpl = defaultCompare,
    checkMergeConflictImpl = defaultGhPrMergeable,
    listStage1TriggerHeadsImpl = defaultListStage1TriggerHeads,
    readCorrectionCommitsImpl = defaultReadCorrectionCommits,
    readTargetCommitsImpl = defaultReadTargetBranchCommits,
  },
) {
  let stage1;
  try {
    stage1 = await stage1RunImpl({ repo, number: pr, head });
  } catch (err) {
    stage1 = { exitCode: 1, message: `stage1-gate threw: ${err.message}` };
  }

  let mergeReady;
  try {
    mergeReady = await checkMergeReadyImpl({ repo, pr, issue });
  } catch (err) {
    mergeReady = { exitCode: 1, message: `lifecycle-gate merge-ready threw: ${err.message}` };
  }

  // Issue #454, unit 454-C: only ever attempted when stage1-gate itself reports NOT_REQUESTED
  // at the current head -- no new `gh` call on the common path where this new disposition shape
  // is absent (parseCorrectionSatisfiedDisposition is pure and returns `null` for every other
  // shape, including an absent bullet, without ever calling checkCorrectionDeltaImpl).
  let correctionDelta = null;
  let parsedCorrectionSatisfied = null;
  if (stage1.state === "NOT_REQUESTED") {
    parsedCorrectionSatisfied = parseCorrectionSatisfiedDisposition(stage1Disposition);
    if (parsedCorrectionSatisfied) {
      try {
        correctionDelta = await checkCorrectionDeltaImpl({
          repo,
          pr,
          reviewedHead: parsedCorrectionSatisfied.reviewedHead,
          correctedHead: parsedCorrectionSatisfied.correctedHead,
          gatedHead: head,
        });
      } catch (err) {
        correctionDelta = { exitCode: 1, message: `stage1-correction-gate threw: ${err.message}` };
      }
    }
  }

  // Issue #837 (the #817/#835/PR #836 live reproduction): a findings-bearing correction advanced
  // the PR head, but the canonical correction-satisfied disposition never reached the control
  // Issue (control still "Stage 1: requested"), so the corrected head's NOT_REQUESTED fell into
  // plain NO_ACTION_YET forever. Probe only in the exact stranded shape -- control-Issue mode,
  // Stage 1 NOT_REQUESTED at the current head, and a disposition that is neither an affirmative
  // satisfied/exempt shape nor any correction-satisfied-shaped bullet -- so the common path and
  // every other disposition shape spend no extra `gh` call. The reviewed head is the head of the
  // most recent Stage 1 trigger round that differs from the current head; it is *evidence-checked*
  // by the same checkCorrectionDelta every other correction path trusts (genuine head-bound
  // findings at that head + strict non-diverged ancestry), never taken on faith.
  let unfinalizedCorrection = null;
  const staleCorrectionSatisfiedHead = correctionDelta && correctionDelta.state === "HEAD_MISMATCH";
  if (
    stage1.state === "NOT_REQUESTED" &&
    controlIssue != null &&
    (staleCorrectionSatisfiedHead ||
      (!correctionDelta &&
        !looksLikeCorrectionSatisfiedDisposition(stage1Disposition) &&
        !parseAffirmativeStage1Disposition(stage1Disposition)))
  ) {
    const probe = staleCorrectionSatisfiedHead
      ? await probeStaleCorrectionContinuation(
          { repo, pr, head, issue, controlIssue, disposition: parsedCorrectionSatisfied },
          {
            compareImpl,
            checkCorrectionDeltaImpl,
            listStage1TriggerHeadsImpl,
            readCorrectionCommitsImpl,
            readTargetCommitsImpl,
          },
        )
      : await probeUnfinalizedCorrection(
          { repo, pr, head, issue, controlIssue },
          { checkCorrectionDeltaImpl, compareImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
        );
    if (probe.ambiguous) return probe.ambiguous;
    if (probe.unrecoverable) {
      return {
        exitCode: exitCodeFor("AMBIGUOUS"),
        ...unrecoverableCorrectionVerdict(probe.unrecoverable, { repo, pr, head, issue, controlIssue }),
      };
    }
    unfinalizedCorrection = probe.unfinalizedCorrection;
  }

  // Issue #665: only ever fetched once correctionDelta itself already reports
  // CORRECTION_SATISFIED *and* lifecycle-gate's own merge-ready leg already succeeded --
  // exactly the one case where resolvePreMergeVerdict's own composed check below could
  // otherwise authorize STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2. A
  // BLOCKED_CLOSING_REFERENCE (or any other non-zero) mergeReady result is already routed to
  // STAGE1_CORRECTION_REQUIRED regardless of live mergeability, so no extra `gh` call is spent
  // fetching evidence that branch never consults -- mirroring correctionDelta's own "only
  // fetched when it might matter" convention above.
  let mergeConflict = null;
  if (
    correctionDelta &&
    correctionDelta.exitCode === 0 &&
    correctionDelta.state === "CORRECTION_SATISFIED" &&
    mergeReady &&
    mergeReady.exitCode === 0
  ) {
    try {
      mergeConflict = await checkMergeConflictImpl({ repo, number: pr });
    } catch (err) {
      mergeConflict = { exitCode: 1, message: `mergeability check threw: ${err.message}` };
    }
  }

  // Issue #1023: the ordinary-satisfied analog, fetched only in a control/execution flow (the only
  // flow with a successor route) and only when the evidence would otherwise authorize the merge verdict.
  if (
    mergeConflict === null &&
    controlIssue != null &&
    Number.isInteger(issue) &&
    stage1.state === "RESPONSE_RECEIVED" &&
    mergeReady &&
    mergeReady.exitCode === 0 &&
    isMergeReadyState(mergeReady.state) &&
    (hasFindingsStage1Response(stage1)
      ? stage1SatisfiedMatchesHead(stage1Disposition, head)
      : isCleanStage1Response(stage1))
  ) {
    try {
      mergeConflict = await checkMergeConflictImpl({ repo, number: pr });
    } catch (err) {
      mergeConflict = { exitCode: 1, message: `mergeability check threw: ${err.message}` };
    }
  }

  const context = { repo, pr, head, issue, ...(controlIssue != null ? { controlIssue } : {}) };
  const verdict = resolvePreMergeVerdict(
    { stage1, mergeReady, stage1Disposition, correctionDelta, mergeConflict, unfinalizedCorrection },
    context,
  );
  return { exitCode: exitCodeFor(verdict.state), ...verdict };
}

// Issue #646 (the #487/#643/#644/#645 live reproduction): before authorizing another
// `STAGE2_CORRECTION_REQUIRED` dispatch, reconcile against the one narrow, work-Issue-scoped
// PR lookup `findOpenExecutionLinkedPr` above authorizes for exactly this recovery — the same
// Shared Contract pattern `ready-dispatch-gate.mjs`'s own `reconcileReadyPrBreakpoint`
// (issue #456 unit 456-B) already established for the pre-PR READY-lifecycle case, reused
// here rather than a second competing PR-discovery mechanism. Returns `{ crossed: false }`
// for the ordinary, genuinely no-correction-PR-yet case (the ONLY case in which dispatching a
// fresh correction worker is authorized), or `{ crossed: true, pr }` when an OPEN,
// work-Issue-linked correction PR already exists — the caller must route to finalization
// instead of dispatching a sibling. `ghPrListImpl` is injected so tests never touch the real
// network/`gh` CLI, matching this file's existing injection convention.
//
// Stage 1 review finding on PR #647 (issue #646, P1): defaults to
// `defaultOpenExecutionLinkedPrList` rather than the bare `defaultGhPrList` this call used
// before — `defaultGhPrList`'s own `--search "#N"` cannot discover a correction PR linked purely
// by the permitted branch-name convention (no body marker), since GitHub's PR search never
// indexes head ref names. See `defaultOpenExecutionLinkedPrList`'s own comment in
// ready-dispatch-gate.mjs for why that merge lives there rather than inside `defaultGhPrList`
// itself.
export async function reconcileStage2CorrectionPr({ repo, workIssue }, { ghPrListImpl = defaultOpenExecutionLinkedPrList } = {}) {
  let prList;
  try {
    prList = await ghPrListImpl({ repo, executionIssue: workIssue });
  } catch (err) {
    return {
      crossed: false,
      operationalError: true,
      reason: `operational failure searching for an execution-linked correction PR for ${repo}#${workIssue}: ${err.message}`,
    };
  }
  const pr = findOpenExecutionLinkedPr(prList, workIssue);
  if (!pr) return { crossed: false };
  // Issue #992: the full open-candidate count lets an action-bearing caller re-prove uniqueness at
  // the action boundary instead of trusting the number of the one PR this selection happened to pick.
  const openCandidateCount = (Array.isArray(prList) ? prList : []).filter(
    (p) => referencesExecutionIssue(p ?? {}, workIssue) && String(p?.state ?? "").toUpperCase() === "OPEN",
  ).length;
  return { crossed: true, pr, openCandidateCount };
}

// Pure. Composes the exact real (non-dry-run) command a controller must run to finalize a
// Stage 2 NOT CLEAN correction PR that reconciliation above already proved exists: an
// idempotent Stage 1 trigger at the correction PR's own live head, chained into
// `finalize-pr-breakpoint.mjs` (extended to accept a `Lifecycle: AUDIT` source state — see its
// own comment) whenever a real thin control Issue exists to project onto. Mirrors the exact
// trigger-then-finalize sequence `docs/bounded-review-cycle.md`'s Integration/PR worker step 6
// and direct-implementation-worker route already establish for the analogous pre-merge PR/
// Stage-1 breakpoint -- this is the same breakpoint, reached from a different pre-state.
export function composeStage2CorrectionFinalizeCommand({ repo, controlIssue, workIssue, pr, head }) {
  const triggerCommand = `node tools/review-watch/trigger.mjs --repo ${repo} --kind pr --number ${pr} --head ${head}`;
  if (controlIssue === null || controlIssue === undefined) return triggerCommand;
  return (
    `${triggerCommand} && node tools/orchestration/finalize-pr-breakpoint.mjs --control-issue ${controlIssue} ` +
    `--execution-issue ${workIssue} --pr ${pr} --head ${head}`
  );
}

async function resolvePostMerge(
  { repo, auditIssue, controlIssue },
  {
    checkPostAuditImpl,
    reconcileStage2CorrectionPrImpl = reconcileStage2CorrectionPr,
    ghPrStateImpl = defaultGhPrState,
    ghIssueViewImpl = defaultGhIssueView,
    reconcileExistingStage2AuditIssueImpl = reconcileExistingStage2AuditIssue,
    checkCorrectionDeltaImpl = checkCorrectionDelta,
    compareImpl = defaultCompare,
    evaluateEvidenceCorrectionImpl = evaluateEvidenceCorrection,
    evaluateUnusableRecoveryImpl = evaluateUnusableRecovery,
    listStage1TriggerHeadsImpl = defaultListStage1TriggerHeads,
    readCorrectionCommitsImpl = defaultReadCorrectionCommits,
    readTargetCommitsImpl = defaultReadTargetBranchCommits,
  },
) {
  let postAudit;
  try {
    postAudit = await checkPostAuditImpl({ repo, "audit-issue": auditIssue });
  } catch (err) {
    postAudit = { exitCode: 1, message: `lifecycle-gate post-audit threw: ${err.message}` };
  }

  // Issue #550 correction (Stage 1 finding P1): checkPostAudit may have redirected a mistaken
  // thin-control `auditIssue` input to the real Stage 2 Audit Issue it names (at most one hop,
  // per checkPostAudit's own bounded recovery — see lifecycle-gate.mjs's checkPostAudit comment).
  // When a genuine resolved `postAudit.auditIssue` is present, it — not the original input — is
  // the canonical audit identity for every downstream nextCommand this gate composes from here
  // on (close-work-issue/close-audit/record-verdict, and the report-promotion path). The original
  // input becomes the control identity instead, but only when this call did not already carry a
  // distinct one of its own: control-Issue mode's `controlIssueNumber` (resolved from a real
  // `--control-issue` argument at the top of this gate) must never be overwritten by a redirect
  // origin discovered one layer down inside checkPostAudit. `postAudit.auditIssue` is absent on
  // every operational-error result and on some test doubles that omit it deliberately — in either
  // case this must fall back to the original input exactly as before, never invent a redirect.
  const hasResolvedAuditIssue = typeof postAudit.auditIssue === "number";
  const resolvedAuditIssue = hasResolvedAuditIssue ? postAudit.auditIssue : auditIssue;
  const redirectedFrom =
    hasResolvedAuditIssue && postAudit.auditIssue !== Number(auditIssue) ? Number(auditIssue) : null;
  const effectiveControlIssue = controlIssue ?? redirectedFrom;

  const context = {
    repo,
    auditIssue: resolvedAuditIssue,
    ...(effectiveControlIssue != null ? { controlIssue: effectiveControlIssue } : {}),
  };
  let verdict = resolvePostMergeVerdict({ postAudit }, context);

  // Issue #992: set only when an unusable (NOT backed NOT CLEAN) audit has exactly one open or
  // merged execution-linked correction PR that an explicit founder instruction names. Enters the
  // shared open/merged correction-PR resolution below without fabricating a verdict.
  let unusableCorrection = null;
  // Issue #992: fresh re-evaluation with the same founder-supplied resume input; returns the
  // descriptor only while it still authorizes exactly the same single PR in the same state.
  const reproveUnusableCorrection = async () => {
    try {
      const again = await evaluateUnusableRecoveryImpl({ repo, auditIssue: context.auditIssue });
      const c = again?.correctionPr;
      return c?.authority?.proven === true && c.candidateCount === 1 && c.number === unusableCorrection.pr && c.state === unusableCorrection.state ? c : null;
    } catch {
      return null;
    }
  };

  // Issue #985: a FIRST unusable genuine reviewer response may recover through exactly one fresh
  // same-target replacement Audit; anything else keeps the unchanged STAGE2_RESPONSE_UNUSABLE stop.
  if (verdict.state === "STAGE2_RESPONSE_UNUSABLE") {
    const routed = await resolveUnusableRecoveryRouting({ repo, context, postAudit, verdict }, { evaluateUnusableRecoveryImpl });
    if (routed.state !== "STAGE2_UNUSABLE_CORRECTION_PR_AUTHORIZED") return { exitCode: exitCodeFor(routed.state), ...routed };
    unusableCorrection = routed.unusableCorrection;
    verdict = { ...verdict, workIssue: routed.workIssue };
  }

  // Issue #646: STAGE2_CORRECTION_REQUIRED is the one verdict this reconciliation step can
  // still override -- every other verdict above is left exactly as resolvePostMergeVerdict
  // computed it. Skipped entirely when there is no real work Issue to search for (the explicit
  // no-work-issue state, issue #190) -- there is no execution-linked PR convention to search
  // against without one.
  if ((verdict.state === "STAGE2_CORRECTION_REQUIRED" || unusableCorrection) && typeof verdict.workIssue === "number") {
    let reconciliation;
    if (unusableCorrection?.state === "MERGED") {
      // The authorized correction already merged, so the open-PR search cannot see it. Re-prove the
      // unique candidate set fresh (same founder-named PR, still the only one) and let the merged
      // branch below do its own live merge-identity read.
      const fresh = await reproveUnusableCorrection();
      reconciliation = fresh
        ? { crossed: true, pr: { number: unusableCorrection.pr, headRefOid: fresh.headRefOid }, openCandidateCount: 1 }
        : { crossed: false, operationalError: true, reason: "the authorized merged correction PR is no longer the single unambiguous candidate" };
    } else {
      reconciliation = await reconcileStage2CorrectionPrImpl({ repo, workIssue: verdict.workIssue });
    }
    if (unusableCorrection && !reconciliation.operationalError && (reconciliation.pr?.number !== unusableCorrection.pr || reconciliation.openCandidateCount !== 1)) {
      // Fail closed: re-prove uniqueness at the action boundary. Never resume a PR other than the
      // one the founder named, never when a competing linked PR is open, and never fall through to
      // a correction-worker dispatch for an unusable audit.
      const failedVerdict = {
        state: "AMBIGUOUS",
        stopAfter: true,
        ...context,
        postAudit,
        reason:
          `unusable audit #${context.auditIssue}'s authorized correction PR #${unusableCorrection.pr} is no longer the single execution-linked ` +
          `candidate (reconciliation found ${reconciliation.pr ? `#${reconciliation.pr.number}` : "none"}, ${reconciliation.openCandidateCount ?? "unknown"} open); refusing to resume it`,
      };
      return { exitCode: exitCodeFor(failedVerdict.state), ...failedVerdict };
    }
    if (reconciliation.operationalError) {
      // Fail closed rather than silently falling through to an ordinary correction-worker
      // dispatch on an operational failure -- an unverified "no PR exists yet" claim is exactly
      // the unsafe assumption issue #646's own duplicate-PR incident (#644/#645) grew from.
      const failedVerdict = {
        state: "AMBIGUOUS",
        stopAfter: true,
        ...context,
        postAudit,
        reason: `Stage 2 correction-PR reconciliation failed operationally, refusing to authorize a correction-worker dispatch without it: ${reconciliation.reason}`,
      };
      return { exitCode: exitCodeFor(failedVerdict.state), ...failedVerdict };
    }
    if (reconciliation.crossed) {
      const pr = reconciliation.pr;
      const head = pr?.headRefOid;
      if (typeof head !== "string" || !head) {
        const failedVerdict = {
          state: "AMBIGUOUS",
          stopAfter: true,
          ...context,
          postAudit,
          reason: `found an open execution-linked correction PR #${pr?.number} for ${repo}#${verdict.workIssue}, but it carries no usable headRefOid -- refusing to compose a finalize command against an unverified head`,
        };
        return { exitCode: exitCodeFor(failedVerdict.state), ...failedVerdict };
      }
      // Issue #750 (the #691/#742/#739 recurrence): `reconciliation`'s own PR search can be
      // stale by the time a controller actually runs the `nextCommand` this branch is about to
      // compose -- the correction PR it found open a moment ago may have already merged (a
      // genuine TOCTOU race between this reconciliation read and the composed command's later
      // execution, or between two concurrent sessions). A merged correction PR is never
      // "needs its initial PR/Stage-1 breakpoint finalized" -- composing a fresh Stage 1
      // trigger + finalize-pr-breakpoint.mjs command against it is exactly the trap that
      // produced `PR_BREAKPOINT_UNVERIFIED` for already-merged PR #742 (its one allowed Stage 1
      // round was triggered at reviewed head 55790ac..., while the accepted correction produced
      // final head a12bf7d...). One more direct, authoritative live read of this exact PR number
      // (never trusting the list search alone -- this file's own established convention, see
      // e.g. reconcileExistingStage2AuditIssue's callers) closes that window before ever
      // composing the finalize command.
      let livePrState;
      try {
        livePrState = await ghPrStateImpl({ repo, number: Number(pr.number) });
      } catch (err) {
        const failedVerdict = {
          state: "AMBIGUOUS",
          stopAfter: true,
          ...context,
          postAudit,
          reason:
            `operational failure independently re-verifying live state for execution-linked correction PR ` +
            `#${pr.number} before authorizing its open-PR finalization path: ${err.message}`,
        };
        return { exitCode: exitCodeFor(failedVerdict.state), ...failedVerdict };
      }
      if (unusableCorrection && livePrState?.state !== unusableCorrection.state) {
        const failedVerdict = {
          state: "AMBIGUOUS",
          stopAfter: true,
          ...context,
          postAudit,
          reason: `authorized correction PR #${pr.number} was ${unusableCorrection.state} when authorized but is now ${JSON.stringify(livePrState?.state ?? null)}; re-run the gate to re-prove state before any action`,
        };
        return { exitCode: exitCodeFor(failedVerdict.state), ...failedVerdict };
      }
      if (unusableCorrection && livePrState?.headRefOid !== head) {
        const failedVerdict = {
          state: "AMBIGUOUS",
          stopAfter: true,
          ...context,
          postAudit,
          reason: `authorized correction PR #${pr.number}'s live head ${JSON.stringify(livePrState?.headRefOid ?? null)} differs from the reconciled head ${head}; re-run the gate to re-prove the head before any action`,
        };
        return { exitCode: exitCodeFor(failedVerdict.state), ...failedVerdict };
      }
      if (livePrState?.state === "MERGED") {
        // The correction PR already merged. Never finalize/re-trigger it as if it were still
        // pending its first Stage 1 breakpoint. When a control Issue is known, route it through
        // the same independent correction-satisfied revalidation + exact-merge Stage 2
        // preparation/recovery machinery (resolveStalePointerCorrectionRecovery, factored out of
        // resolveMergedPrWithSettledStage2, issue #747/#748/#750) a fresh `--control-issue`
        // evaluation of that same control Issue would already reach on its own. This never calls
        // back into resolvePostMerge/resolveMergedPrWithSettledStage2 -- both of those have their
        // own tolerant fallback paths that loop back here, and this call has already independently,
        // freshly re-verified the merge itself moments ago, so there is no remaining tolerance
        // case left to retry. `auditIssue` remains exactly the predecessor pointer it already
        // was; this call never edits or retires it (a preserved non-goal).
        if (typeof context.controlIssue !== "number") {
          const failedVerdict = {
            state: "AMBIGUOUS",
            stopAfter: true,
            ...context,
            postAudit,
            reason:
              `execution-linked correction PR #${pr.number} for ${repo}#${verdict.workIssue} has already merged ` +
              `(merge commit ${livePrState.mergeCommit?.oid ?? "<unknown>"}), but no control Issue is known in this ` +
              `direct --audit-issue invocation to independently revalidate its correction-satisfied evidence and ` +
              `route it into Stage 2 preparation -- re-run next-review-transition-gate.mjs --control-issue <N> ` +
              "against this correction PR's governing control Issue instead of retrying this --audit-issue " +
              "invocation, which can never resolve a merged correction PR on its own.",
          };
          return { exitCode: exitCodeFor(failedVerdict.state), ...failedVerdict };
        }
        const mergeCommitOid = livePrState.mergeCommit?.oid;
        if (typeof mergeCommitOid !== "string" || !mergeCommitOid.trim()) {
          const failedVerdict = {
            state: "AMBIGUOUS",
            stopAfter: true,
            ...context,
            postAudit,
            reason:
              `execution-linked correction PR #${pr.number} for ${repo}#${verdict.workIssue} reports live state ` +
              "MERGED but carries no usable merge commit oid -- refusing to route Stage 2 preparation/recovery " +
              "against an unverified merge identity",
          };
          return { exitCode: exitCodeFor(failedVerdict.state), ...failedVerdict };
        }
        let controlBody;
        try {
          const controlData = await ghIssueViewImpl({ repo, number: context.controlIssue });
          controlBody = controlData?.body ?? "";
        } catch (err) {
          return { exitCode: 1, message: `gh issue view failed for ${repo}#${context.controlIssue}: ${err.message}` };
        }
        const executionField = readExecutionBulletField(controlBody);
        const executionRef = resolveExecutionPointerOrNone(executionField);
        if (!executionRef.ok) {
          const failedVerdict = {
            state: "AMBIGUOUS",
            stopAfter: true,
            ...context,
            postAudit,
            reason:
              `Execution reference required to route merged execution-linked correction PR #${pr.number} into ` +
              `Stage 2 preparation/recovery is malformed: ${executionRef.reason}`,
          };
          return { exitCode: exitCodeFor(failedVerdict.state), ...failedVerdict };
        }
        // Stage 1 review finding on this PR (P1): `reconciliation` selected this correction PR
        // because it links to the predecessor audit's own reported `verdict.workIssue`. The
        // control body was just re-read fresh above, and its current "Execution" bullet may since
        // have moved on to a different work Issue -- silently handing that possibly-unrelated
        // Issue to recovery could return STAGE2_PREPARATION_REQUIRED or recover an audit for this
        // PR while declaring the wrong Issue as the audited work. Fail closed on that
        // contradiction rather than routing it.
        if (executionRef.issue !== verdict.workIssue) {
          const failedVerdict = {
            state: "AMBIGUOUS",
            stopAfter: true,
            ...context,
            postAudit,
            reason:
              `predecessor audit for execution-linked correction PR #${pr.number} reports work Issue ` +
              `#${verdict.workIssue}, but control Issue #${context.controlIssue}'s current Execution bullet ` +
              `now points at ${JSON.stringify(executionRef.issue)} -- refusing to route this contradictory ` +
              "durable state into Stage 2 preparation/recovery",
          };
          return { exitCode: exitCodeFor(failedVerdict.state), ...failedVerdict };
        }
        const recovered = await resolveStalePointerCorrectionRecovery(
          {
            repo,
            body: controlBody,
            // Stage 1 review finding on this PR (P1): pass the canonical resolved audit identity
            // (`context.auditIssue`, already redirected by checkPostAudit when applicable at the
            // top of resolvePostMerge) rather than the raw original input -- otherwise a redirect
            // leaves this call's own `staleAuditIssue` naming the control Issue itself, which
            // `finalize-audit-breakpoint.mjs --stale-audit-issue` can never match against the
            // control's actual Stage 2 pointer.
            auditIssue: context.auditIssue,
            prIssue: Number(pr.number),
            controlIssueNumber: context.controlIssue,
            mergeCommitOid,
            headRefOid: livePrState.headRefOid,
            executionRef,
          },
          { checkCorrectionDeltaImpl, compareImpl, reconcileExistingStage2AuditIssueImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
        );
        // PR #1002 Stage 1 P1: reconciliation above can read Stage 1 and audit state after
        // the initial merged-correction uniqueness check. Re-prove the complete candidate
        // set at this branch's own action boundary, not only on the open-PR path below.
        // Stage 2 preparation dispatch is action-bearing even without a nextCommand.
        if (unusableCorrection && (recovered?.nextCommand || recovered?.state === "STAGE2_PREPARATION_REQUIRED")) {
          const fresh = await reproveUnusableCorrection();
          let latestLivePr = null;
          if (fresh && fresh.number === Number(pr.number) && fresh.headRefOid === head) {
            try {
              latestLivePr = await ghPrStateImpl({ repo, number: Number(pr.number) });
            } catch {
              // An unreadable live PR is not proof of an unchanged action target.
            }
          }
          if (
            !fresh ||
            fresh.number !== Number(pr.number) ||
            fresh.headRefOid !== head ||
            latestLivePr?.state !== "MERGED" ||
            latestLivePr?.headRefOid !== head ||
            latestLivePr?.mergeCommit?.oid !== mergeCommitOid
          ) {
            const failedVerdict = {
              state: "AMBIGUOUS",
              stopAfter: true,
              ...context,
              postAudit,
              reason:
                `authorized merged correction PR #${pr.number} is no longer proven to be the sole execution-linked candidate ` +
                `at head ${head} and merge ${mergeCommitOid} after Stage 1/audit reconciliation; ` +
                "refusing to authorize another Stage 2 transition",
            };
            return { exitCode: exitCodeFor(failedVerdict.state), ...failedVerdict };
          }
        }
        return recovered;
      }
      // Stage 2 audit finding on this PR (#753, P1): the branch above only special-cases
      // `livePrState.state === "MERGED"`; everything else previously fell through unconditionally
      // to the open-PR finalization path below. `CLOSED` is a valid, distinct GitHub PR state --
      // a correction PR closed without merging between reconciliation's search and this direct
      // live read is not "genuinely still open" and must never be authorized into a fresh Stage 1
      // trigger/finalize-pr-breakpoint.mjs command. The required invariant is an explicit
      // allowlist, not a MERGED/else split: OPEN proceeds here, MERGED already returned above,
      // and anything else (CLOSED, blank, or otherwise unrecognized) fails closed.
      if (livePrState?.state !== "OPEN") {
        const failedVerdict = {
          state: "AMBIGUOUS",
          stopAfter: true,
          ...context,
          postAudit,
          reason:
            `execution-linked correction PR #${pr.number} for ${repo}#${verdict.workIssue} reports live state ` +
            `${JSON.stringify(livePrState?.state ?? null)}, which is neither OPEN nor MERGED -- refusing to treat ` +
            "a closed-without-merge or unrecognized PR state as though it were genuinely still open before " +
            "composing a Stage 1 trigger/finalize-pr-breakpoint.mjs command",
        };
        return { exitCode: exitCodeFor(failedVerdict.state), ...failedVerdict };
      }
      if (unusableCorrection) {
        // Stage 2 audit #1001 finding 2: immediately before emitting the action-bearing command, freshly
        // re-prove the complete open+merged candidate set (a competitor that merged since the first
        // evaluation is counted here, not just open ones) is still exactly the founder-named PR, in the
        // same state, at the same head the command is about to be composed from.
        const fresh = await reproveUnusableCorrection();
        if (!fresh || fresh.number !== Number(pr.number) || fresh.headRefOid !== head) {
          const failedVerdict = {
            state: "AMBIGUOUS",
            stopAfter: true,
            ...context,
            postAudit,
            reason:
              `authorized correction PR #${pr.number} is no longer the single open-or-merged execution-linked candidate at head ${head} ` +
              `on a fresh re-evaluation (${fresh ? `candidate #${fresh.number} at ${fresh.headRefOid ?? "unknown head"}` : "authority or uniqueness no longer proven"}); refusing to emit a mutating command`,
          };
          return { exitCode: exitCodeFor(failedVerdict.state), ...failedVerdict };
        }
      }
      const crossedVerdict = {
        state: "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION",
        stopAfter: true,
        ...context,
        ...(unusableCorrection ? { unusableAuditCorrection: unusableCorrection } : {}),
        workIssue: verdict.workIssue,
        pr: Number(pr.number),
        head,
        nextCommand: composeStage2CorrectionFinalizeCommand({
          repo,
          controlIssue: context.controlIssue ?? null,
          workIssue: verdict.workIssue,
          pr: Number(pr.number),
          head,
        }),
      };
      return { exitCode: exitCodeFor(crossedVerdict.state), ...crossedVerdict };
    }
  }

  if (unusableCorrection) {
    // reconciliation found no PR (it closed or merged unseen between reads): never dispatch a
    // correction worker or a replacement audit for an unusable audit on that unverified state.
    const failedVerdict = {
      state: "AMBIGUOUS",
      stopAfter: true,
      ...context,
      postAudit,
      reason: `unusable audit #${context.auditIssue}'s authorized correction PR #${unusableCorrection.pr} was not found open on reconciliation; refusing a replacement audit or correction-worker dispatch on unverified state`,
    };
    return { exitCode: exitCodeFor(failedVerdict.state), ...failedVerdict };
  }

  // Issue #883: no correction PR exists, so this NOT CLEAN is either a source defect awaiting
  // the ordinary correction PR, or an evidence-only finding. Resolve which routing applies.
  if (verdict.state === "STAGE2_CORRECTION_REQUIRED" && typeof verdict.workIssue === "number") {
    const routed = await resolveEvidenceOnlyRouting({ repo, context, postAudit, verdict }, { evaluateEvidenceCorrectionImpl });
    return { exitCode: exitCodeFor(routed.state), ...routed };
  }

  return { exitCode: exitCodeFor(verdict.state), ...verdict };
}

// Issue #985: routes a first unusable genuine Stage 2 response through the bounded one-replacement
// recovery (tools/orchestration/unusable-audit-recovery.mjs). Only a durably re-proven, exact
// PR/work/merge-identity result authorizes the single replacement; an exhausted bound (the audit is
// itself a replacement) keeps the unchanged STAGE2_RESPONSE_UNUSABLE founder interrupt, now carrying
// the predecessor reference; any operational failure or ambiguous provenance fails closed to
// AMBIGUOUS -- never a pointer mutation, a new audit, a same-thread retrigger, or reviewer coaching.
async function resolveUnusableRecoveryRouting({ repo, context, postAudit, verdict }, { evaluateUnusableRecoveryImpl }) {
  const ambiguous = (reason) => ({ state: "AMBIGUOUS", stopAfter: true, ...context, postAudit, reason });
  let evaluated;
  try {
    evaluated = await evaluateUnusableRecoveryImpl({ repo, auditIssue: context.auditIssue });
  } catch (err) {
    return ambiguous(`unusable-response recovery evaluation failed operationally, refusing to create a replacement audit on unverified state: ${err.message}`);
  }
  switch (evaluated?.status) {
    case UnusableRecoveryStatus.NOT_ELIGIBLE: {
      // Issue #992: an open or merged execution-linked correction PR is the one NOT_ELIGIBLE shape
      // that may still advance, and only on an explicit founder instruction naming that exact PR.
      const corr = evaluated.correctionPr;
      if (corr) {
        if (corr.authority?.proven === true && corr.candidateCount === 1 && typeof evaluated.workIssue === "number") {
          return {
            state: "STAGE2_UNUSABLE_CORRECTION_PR_AUTHORIZED",
            workIssue: evaluated.workIssue,
            unusableCorrection: { pr: corr.number, state: corr.state, authority: corr.authority.reason },
          };
        }
        return {
          ...verdict,
          unusableRecovery: {
            status: evaluated.status,
            reason: evaluated.reason,
            correctionPrs: { open: corr.openNumbers, merged: corr.mergedNumbers },
            authority: "UNPROVEN",
            authorityReason: corr.authority?.reason ?? "no authority evaluation reported",
            ...(corr.authority?.resume ? { resume: corr.authority.resume } : {}),
          },
        };
      }
      return {
        ...verdict,
        unusableRecovery: {
          status: evaluated.status,
          reason: evaluated.reason,
          ...(evaluated.predecessorAuditIssue != null ? { predecessorAuditIssue: evaluated.predecessorAuditIssue } : {}),
          ...(evaluated.closedCorrectionPrs ? { closedCorrectionPrs: evaluated.closedCorrectionPrs } : {}),
        },
      };
    }
    case UnusableRecoveryStatus.ELIGIBLE:
      return {
        state: "STAGE2_UNUSABLE_REPLACEMENT_PREPARATION_REQUIRED",
        stopAfter: true,
        ...context,
        workIssue: evaluated.workIssue,
        pr: evaluated.pr,
        mergeCommit: evaluated.mergeCommit,
        predecessorAuditIssue: context.auditIssue,
        unusableResponseUrl: evaluated.responseUrl,
        nextCommand: `node tools/orchestration/unusable-audit-recovery.mjs prepare --repo ${repo} --audit-issue ${context.auditIssue}`,
      };
    case UnusableRecoveryStatus.REPLACEMENT_EXISTS: {
      if (!evaluated.replacement?.pending) {
        return ambiguous(
          `replacement audit #${evaluated.replacement?.number} already carries a non-pending verdict while the current Stage 2 pointer ` +
            `still names predecessor #${context.auditIssue}; refusing to project or trigger it`,
        );
      }
      const replacement = evaluated.replacement.number;
      const triggerCommand = `node tools/review-watch/trigger.mjs --repo ${repo} --kind issue --number ${replacement}`;
      const finalizeCommand =
        typeof context.controlIssue === "number"
          ? `node tools/orchestration/finalize-audit-breakpoint.mjs --control-issue ${context.controlIssue} ` +
            `--execution-issue ${evaluated.workIssue} --pr ${evaluated.pr} --audit-issue ${replacement} ` +
            `--stale-audit-issue ${context.auditIssue} --revalidate-uniqueness true`
          : `node tools/orchestration/finalize-audit-breakpoint.mjs --execution-issue ${evaluated.workIssue} ` +
            `--pr ${evaluated.pr} --audit-issue ${replacement} --revalidate-uniqueness true`;
      return {
        state: "STAGE2_UNUSABLE_REPLACEMENT_READY",
        stopAfter: true,
        ...context,
        workIssue: evaluated.workIssue,
        pr: evaluated.pr,
        mergeCommit: evaluated.mergeCommit,
        predecessorAuditIssue: context.auditIssue,
        unusableResponseUrl: evaluated.responseUrl,
        replacementAuditIssue: replacement,
        nextCommand: `${finalizeCommand} && ${triggerCommand}`,
      };
    }
    default:
      return ambiguous(
        `unusable-response recovery state is ${JSON.stringify(evaluated?.status ?? null)}: ${evaluated?.reason ?? "no reason reported"} -- ` +
          "ambiguous or mismatched replacement provenance fails closed; no pointer mutation, no new audit",
      );
  }
}

// Issue #883: routes a recorded NOT CLEAN (no correction PR) through the evidence-only recovery
// evaluation. Source-defect and not-yet-evidenced cases stay STAGE2_CORRECTION_REQUIRED (the
// correction worker classifies semantically and, for evidence-only, ends at `evidence-
// correction.mjs record` with no PR); only a durably verified, provenance-checked result
// authorizes the single same-merge re-audit. Any operational failure or contradictory/ambiguous
// state fails closed to AMBIGUOUS -- never a pointer mutation, a new audit, or a guessed route.
async function resolveEvidenceOnlyRouting({ repo, context, postAudit, verdict }, { evaluateEvidenceCorrectionImpl }) {
  const ambiguous = (reason) => ({ state: "AMBIGUOUS", stopAfter: true, ...context, postAudit, reason });
  let evaluated;
  try {
    evaluated = await evaluateEvidenceCorrectionImpl({ repo, auditIssue: context.auditIssue });
  } catch (err) {
    return ambiguous(
      "evidence-only correction evaluation failed operationally, refusing to authorize either a source-correction " +
        `dispatch or a re-audit on unverified state: ${err.message}`,
    );
  }
  switch (evaluated?.status) {
    case EvidenceStatus.NOT_ELIGIBLE:
      return {
        ...verdict,
        evidenceOnlyEligible: false,
        evidenceCorrection: { status: evaluated.status, reason: evaluated.reason },
      };
    case EvidenceStatus.NO_RESULT:
      return { ...verdict, evidenceOnlyEligible: true };
    case EvidenceStatus.INCOMPLETE:
      return {
        ...verdict,
        evidenceOnlyEligible: true,
        evidenceCorrection: { status: evaluated.status, reason: evaluated.reason },
      };
    case EvidenceStatus.SATISFIED: {
      const base = {
        ...context,
        workIssue: evaluated.workIssue,
        pr: evaluated.pr,
        mergeCommit: evaluated.mergeCommit,
        predecessorAuditIssue: context.auditIssue,
        evidenceResultUrl: evaluated.resultUrl,
      };
      if (!evaluated.replacement) {
        return {
          state: "STAGE2_EVIDENCE_REAUDIT_PREPARATION_REQUIRED",
          stopAfter: true,
          ...base,
          nextCommand: `node tools/orchestration/evidence-correction.mjs prepare --repo ${repo} --audit-issue ${context.auditIssue}`,
        };
      }
      if (!evaluated.replacement.pending) {
        return ambiguous(
          `evidence-recovery re-audit #${evaluated.replacement.number} already carries a non-pending verdict while the ` +
            `current Stage 2 pointer still names predecessor #${context.auditIssue}; refusing to project or trigger it`,
        );
      }
      const replacement = evaluated.replacement.number;
      const triggerCommand = `node tools/review-watch/trigger.mjs --repo ${repo} --kind issue --number ${replacement}`;
      const finalizeCommand =
        typeof context.controlIssue === "number"
          ? `node tools/orchestration/finalize-audit-breakpoint.mjs --control-issue ${context.controlIssue} ` +
            `--execution-issue ${evaluated.workIssue} --pr ${evaluated.pr} --audit-issue ${replacement} ` +
            `--stale-audit-issue ${context.auditIssue} --revalidate-uniqueness true`
          : `node tools/orchestration/finalize-audit-breakpoint.mjs --execution-issue ${evaluated.workIssue} ` +
            `--pr ${evaluated.pr} --audit-issue ${replacement} --revalidate-uniqueness true`;
      return {
        state: "STAGE2_EVIDENCE_REAUDIT_READY",
        stopAfter: true,
        ...base,
        replacementAuditIssue: replacement,
        nextCommand: `${finalizeCommand} && ${triggerCommand}`,
      };
    }
    default:
      return ambiguous(
        `evidence-only correction state is ${JSON.stringify(evaluated?.status ?? null)}: ${evaluated?.reason ?? "no reason reported"} -- ` +
          "contradictory or ambiguous evidence-correction state fails closed; no pointer mutation, no new audit",
      );
  }
}

// Pure. Resolves a `readExecutionBulletField` result to either a positive-integer execution
// Issue or the literal "none" sentinel -- distinct from `parseExecutionPointer`, which requires
// an actual "#N" pointer and treats an absent/explicit "none" bullet as malformed. Issue #747
// Stage 1 correction (P2 finding on PR #748): `resolveMergedPrWithSettledStage2` below hands its
// resolved issue straight to `finalize-audit-breakpoint.mjs`/`reconcileExistingStage2AuditIssue`,
// both of which already treat "none" as the documented no-work-issue representation (mirroring
// lifecycle-gate.mjs's own `--issue none` convention, issue #190) -- so an absent/"none"
// Execution bullet must resolve here the same way, never be rejected as malformed merely because
// it names no "#N" pointer. Scoped to that one caller: every other Execution-pointer resolution
// in this file still requires an actual pointer via `parseExecutionPointer` directly, since none
// of those call sites feed a "none"-aware downstream.
function resolveExecutionPointerOrNone(executionField) {
  if (executionField.conflict) {
    return { ok: false, reason: describeExecutionConflict(executionField) };
  }
  if (executionField.value === null || isNoneSentinel(executionField.value)) {
    return { ok: true, issue: "none" };
  }
  return parseExecutionPointer(executionField.value);
}

// Issue #747 (control #539, the #691/#742/#739 reproduction): control-Issue mode's coexisting-
// PR-and-Stage-2 branch above found the relevant PR MERGED. Before #747, that alone was enough
// to hand the transition to whatever Issue the settled "Stage 2" bullet named (exactly #537's
// established behavior) -- but a settled pointer that merely *parses* as a valid Issue reference
// is not proof it is the audit *for this merge*. #691's live shape: correction PR #742 merged,
// but the control Issue's retained "Stage 2: #739" bullet still names the NOT CLEAN audit of the
// predecessor PR #738 -- provenance only, never a live post-merge pointer for #742.
//
// This verifies the settled pointer's own structured "Exact merge commit"/"Work issue" fields
// (the same fields `findMatchingOpenAuditIssues`/`hasCanonicalAuditShape` already treat as the
// sole identity authority -- never issue numbers, timestamps, or wording) against the PR that
// actually just merged. A genuine match hands the transition to resolvePostMerge completely
// unchanged (the pre-#747 behavior). A mismatch (or a pointer whose own body doesn't parse as an
// identity-bearing audit at all) never edits or retires the predecessor pointer -- it instead
// routes the *current* merged PR through the exact same deterministic recovery-or-prepare
// machinery (issue #729's `reconcileExistingStage2AuditIssue`) the merged-PR-with-no-settled-
// Stage-2-pointer branch below already uses for this evidence shape, so a fresh canonical audit
// already prepared for this merge is recovered rather than duplicated, and only a genuinely
// unprepared merge falls through to STAGE2_PREPARATION_REQUIRED.
//
// Stage 1 correction on PR #748 (three accepted findings, applied as one consolidated pass --
// see this PR's "Stage 1 guidance" comment): a verified-stale predecessor pointer may hand the
// transition to the current merge's own recovery/preparation path only if the rest of the
// post-merge contract still holds:
//   1. Stage 1 eligibility is still mandatory -- the same affirmative/correction-satisfied
//      disposition (independently re-validated against the actual merged head for a
//      correction-satisfied bullet, exactly like the sibling merged-PR-with-no-settled-Stage-2
//      branch below) is required before recovery/preparation proceeds, so a stale predecessor
//      pointer can never become a bypass around Stage 1.
//   2. The replacement audit pointer must be committable -- STAGE2_AUDIT_ALREADY_PREPARED's
//      `nextCommand` now also names `--stale-audit-issue <auditIssue>`, which authorizes
//      `finalize-audit-breakpoint.mjs` to overwrite an already-AUDIT control's Stage 2 pointer
//      only when it still exactly names this verified-stale predecessor (never any other
//      mismatch). STAGE2_PREPARATION_REQUIRED likewise carries `staleAuditIssue` so the eventual
//      finalize call the controller composes after the dispatched preparation worker returns can
//      pass the same authorization; the predecessor Audit Issue itself is never edited or closed.
//   3. An absent/explicit "none" Execution state remains valid through this path -- the
//      Execution field is resolved to either a positive issue number or the literal "none"
//      sentinel (mirroring finalize-audit-breakpoint.mjs's own `--execution-issue none`
//      convention) rather than requiring an actual "#N" pointer, so a merged no-work-issue
//      correction retaining its predecessor audit is never forced to fabricate one.
async function resolveMergedPrWithSettledStage2(
  { repo, body, auditIssue, prIssue, controlIssueNumber, mergeCommitOid, headRefOid },
  {
    ghIssueViewImpl,
    reconcileExistingStage2AuditIssueImpl,
    checkPostAuditImpl,
    reconcileStage2CorrectionPrImpl,
    checkCorrectionDeltaImpl,
    compareImpl = defaultCompare,
    ghPrStateImpl = defaultGhPrState,
    evaluateEvidenceCorrectionImpl, evaluateUnusableRecoveryImpl,
    listStage1TriggerHeadsImpl = defaultListStage1TriggerHeads,
    readCorrectionCommitsImpl = defaultReadCorrectionCommits,
    readTargetCommitsImpl = defaultReadTargetBranchCommits,
  },
) {
  // No merge commit at all (an unexpected `gh`/test-double response shape): there is no evidence
  // to verify identity one way or the other. Trust the settled pointer exactly as before this
  // fix rather than inventing a new failure mode over a field this gate has never required
  // before -- mirrors the merged-PR-with-no-Stage-2-pointer branch's own identical tolerance.
  if (typeof mergeCommitOid !== "string" || !mergeCommitOid.trim()) {
    return resolvePostMerge(
      { repo, auditIssue, controlIssue: controlIssueNumber },
      { checkPostAuditImpl, reconcileStage2CorrectionPrImpl, ghPrStateImpl, ghIssueViewImpl, reconcileExistingStage2AuditIssueImpl, checkCorrectionDeltaImpl, compareImpl, evaluateEvidenceCorrectionImpl, evaluateUnusableRecoveryImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
    );
  }

  // The gated work/Execution Issue is required both for the identity comparison below and for
  // composing a STAGE2_PREPARATION_REQUIRED/STAGE2_AUDIT_ALREADY_PREPARED verdict if the settled
  // pointer turns out not to match -- resolved from the control body already in hand, no extra
  // read. An absent/explicit "none" Execution state is a legitimate no-work-issue representation
  // elsewhere in this lifecycle (finalize-audit-breakpoint.mjs's own `--execution-issue none`)
  // and must remain valid here too (P2 finding on PR #748) -- resolveExecutionPointerOrNone
  // normalizes it to the "none" sentinel instead of requiring an actual "#N" pointer. A genuinely
  // conflicting or multi-valued Execution field still fails closed exactly as before.
  const executionField = readExecutionBulletField(body);
  const executionRef = resolveExecutionPointerOrNone(executionField);
  if (!executionRef.ok) {
    return {
      exitCode: 4,
      state: "AMBIGUOUS",
      stopAfter: true,
      repo,
      controlIssue: controlIssueNumber,
      reason:
        `Execution reference required to verify the settled "Stage 2" pointer's identity against the current ` +
        `merged PR #${prIssue} is malformed: ${executionRef.reason}`,
    };
  }

  let auditData;
  try {
    auditData = await ghIssueViewImpl({ repo, number: auditIssue });
  } catch (err) {
    return {
      exitCode: 1,
      message: `gh issue view failed for ${repo}#${auditIssue} while verifying its identity against merged PR #${prIssue}: ${err.message}`,
    };
  }
  const auditBody = auditData.body ?? "";
  const candidateMergeCommit = parseMergeCommitRef(auditBody);
  const candidateWorkIssue = parseWorkIssueRef(auditBody);
  const isGenuineMatch =
    typeof candidateMergeCommit === "string" &&
    candidateMergeCommit.toLowerCase() === mergeCommitOid.toLowerCase() &&
    candidateWorkIssue === executionRef.issue;

  if (isGenuineMatch) {
    // Exactly the pre-#747 behavior: the settled Stage 2 reference genuinely audits this PR's
    // own merge, so it owns the transition unchanged.
    return resolvePostMerge(
      { repo, auditIssue, controlIssue: controlIssueNumber },
      { checkPostAuditImpl, reconcileStage2CorrectionPrImpl, ghPrStateImpl, ghIssueViewImpl, reconcileExistingStage2AuditIssueImpl, checkCorrectionDeltaImpl, compareImpl, evaluateEvidenceCorrectionImpl, evaluateUnusableRecoveryImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
    );
  }

  return resolveStalePointerCorrectionRecovery(
    { repo, body, auditIssue, prIssue, controlIssueNumber, mergeCommitOid, headRefOid, executionRef },
    { checkCorrectionDeltaImpl, reconcileExistingStage2AuditIssueImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
  );
}

// Issue #750 (extracted from resolveMergedPrWithSettledStage2, which continues to use this for
// its own "settled Stage 2 pointer proven stale/mismatched" case): independently revalidates
// Stage 1 authority for a merged PR whose retained/candidate Stage 2 pointer does not (or
// cannot be assumed to) audit this exact merge, then recovers/requires the canonical Stage 2
// Audit Issue for the CURRENT merge -- never resuming through the stale pointer. Deliberately
// self-contained (no call back into resolvePostMerge or resolveMergedPrWithSettledStage2):
// every caller here has already independently, freshly verified `mergeCommitOid` itself moments
// before calling in, so there is no remaining tolerance case that would need to loop back for a
// second attempt -- looping back was exactly the infinite-recursion hazard a pathological/
// self-referential `auditIssue` (one whose own body coincidentally reports the same merge
// commit this call already knows is not genuinely current) could otherwise trigger.
async function resolveStalePointerCorrectionRecovery(
  { repo, body, auditIssue, prIssue, controlIssueNumber, mergeCommitOid, headRefOid, executionRef },
  {
    checkCorrectionDeltaImpl,
    compareImpl = defaultCompare,
    reconcileExistingStage2AuditIssueImpl,
    listStage1TriggerHeadsImpl = defaultListStage1TriggerHeads,
    readCorrectionCommitsImpl = defaultReadCorrectionCommits,
    readTargetCommitsImpl = defaultReadTargetBranchCommits,
  },
) {
  // P1 finding on PR #748: the settled pointer is now proven stale/unparseable, but that alone
  // is not proof this merge's own Stage 1 authority was ever satisfied. Mirrors the sibling
  // merged-PR-with-no-settled-Stage-2-pointer branch's own STAGE2_PREPARATION_BLOCKED_ON_STAGE1
  // guard below (Stage 1 correction on PR #721/#724): require the control Issue's own "Stage 1"
  // bullet to already carry one of the two affirmative shapes the pre-merge phase authorizes
  // merge from before ever recovering/preparing a replacement audit.
  const stage1Bullet = parseControlBullet(body, "Stage 1");
  // Stage 1 review finding on this PR (P1): an ordinary "satisfied/exempt at <sha>" disposition
  // only ever proves Stage 1 authority for the head it names. Mirrors this file's own established
  // pre-merge convention (`stage1DispositionSatisfiedAtHead` above) -- require the disposition's
  // own SHA to match the live merged PR head (`headRefOid`) before trusting it here too; a
  // disposition left over from a predecessor/earlier head must not silently authorize recovery
  // for a different, later merged head.
  const hasAffirmativeDisposition = stage1DispositionMatchesHead(
    parseAffirmativeStage1Disposition(stage1Bullet),
    headRefOid,
  );
  const parsedCorrectionSatisfied = parseCorrectionSatisfiedDisposition(stage1Bullet);
  const hasCorrectionSatisfiedDisposition = parsedCorrectionSatisfied !== null;
  if (!hasAffirmativeDisposition && !hasCorrectionSatisfiedDisposition) {
    // Issue #913: see the sibling merged-PR branch -- provable findings-correction evidence
    // selects correction finalization rather than ordinary satisfied recovery.
    const correctionVerdict = await mergedUnfinalizedCorrectionVerdict(
      { repo, pr: prIssue, headRefOid, issue: executionRef.issue, controlIssue: controlIssueNumber, stage1Bullet },
      { checkCorrectionDeltaImpl, compareImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
    );
    if (correctionVerdict) return correctionVerdict;
    return {
      exitCode: 3,
      state: "STAGE2_PREPARATION_BLOCKED_ON_STAGE1",
      stopAfter: true,
      repo,
      controlIssue: controlIssueNumber,
      pr: prIssue,
      issue: executionRef.issue,
      reason:
        `control Issue #${controlIssueNumber}'s "Stage 1" bullet (${JSON.stringify(stage1Bullet)}) is not a ` +
        `canonical satisfied/exempt or correction-satisfied disposition, but PR #${prIssue} is already MERGED ` +
        `and its retained "Stage 2" pointer #${auditIssue} does not audit this merge -- Stage 2 recovery/` +
        "preparation must not resume on unverified Stage 1 authority",
      nextCommand:
        `node tools/orchestration/finalize-stage1-satisfied-breakpoint.mjs --control-issue ${controlIssueNumber} ` +
        `--execution-issue ${executionRef.issue} --pr ${prIssue} --recover true`,
    };
  }
  // A canonical "correction-satisfied at <corrected> (reviewed <reviewed>)" bullet proves only
  // that it parses -- independently re-derive the full evidence invariant the pre-merge phase
  // already enforces (checkCorrectionDeltaImpl), exactly as the sibling branch does. Skipped
  // entirely when an ordinary satisfied/exempt disposition is already present.
  if (!hasAffirmativeDisposition) {
    let correctionDelta;
    try {
      correctionDelta = await checkCorrectionDeltaImpl({
        repo,
        pr: prIssue,
        reviewedHead: parsedCorrectionSatisfied.reviewedHead,
        correctedHead: parsedCorrectionSatisfied.correctedHead,
        gatedHead: headRefOid,
      });
    } catch (err) {
      correctionDelta = { exitCode: 1, message: `stage1-correction-gate threw: ${err.message}` };
    }
    if (!hasTrustworthyExitCode(correctionDelta) || correctionDelta.exitCode === 1) {
      return {
        exitCode: 4,
        state: "AMBIGUOUS",
        stopAfter: true,
        repo,
        controlIssue: controlIssueNumber,
        reason:
          "tools/review-watch/stage1-correction-gate.mjs's checkCorrectionDelta returned output without a " +
          "trustworthy exitCode (or reported an operational error) while independently validating the stale-" +
          `Stage-2-pointer resume correction-satisfied disposition for PR #${prIssue}: ` +
          `${correctionDelta && correctionDelta.message}`,
      };
    }
    if (correctionDelta.state === "HEAD_MISMATCH") {
      const correctionVerdict = await mergedUnfinalizedCorrectionVerdict(
        { repo, pr: prIssue, headRefOid, issue: executionRef.issue, controlIssue: controlIssueNumber, stage1Bullet },
        { checkCorrectionDeltaImpl, compareImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
      );
      if (correctionVerdict) return correctionVerdict;
    }
    if (correctionDelta.state !== "CORRECTION_SATISFIED") {
      return {
        exitCode: 3,
        state: "STAGE2_PREPARATION_BLOCKED_ON_STAGE1",
        stopAfter: true,
        repo,
        controlIssue: controlIssueNumber,
        pr: prIssue,
        issue: executionRef.issue,
        reason:
          `control Issue #${controlIssueNumber}'s "Stage 1" bullet (${JSON.stringify(stage1Bullet)}) names a ` +
          "correction-satisfied disposition, but its correction evidence did not independently validate " +
          `against merged PR #${prIssue}'s actual head ${headRefOid} (checkCorrectionDelta reported ` +
          `${correctionDelta.state}${correctionDelta.reason ? `: ${correctionDelta.reason}` : ""}) -- Stage 2 ` +
          "recovery/preparation must not resume on unverified Stage 1 authority",
        nextCommand:
          `node tools/orchestration/finalize-stage1-satisfied-breakpoint.mjs --control-issue ${controlIssueNumber} ` +
          `--execution-issue ${executionRef.issue} --pr ${prIssue} --recover true`,
      };
    }
  }

  // The settled "Stage 2" pointer names a different merge/work identity than the PR that just
  // merged (or its body carries no parseable identity at all) -- it is provenance only. Never
  // edit or retire it here (a non-goal); instead search for the canonical Stage 2 Audit Issue
  // that already matches *this* merge, exactly as the merged-PR-with-no-settled-Stage-2-pointer
  // branch below already does for the same evidence shape.
  let reconciled;
  try {
    reconciled = await reconcileExistingStage2AuditIssueImpl({ repo, mergeCommitOid, executionIssue: executionRef.issue });
  } catch (err) {
    reconciled = { exitCode: 1, message: `reconcileExistingStage2AuditIssue threw: ${err.message}` };
  }
  // A genuinely conflicting result (more than one durable match) fails closed to AMBIGUOUS --
  // never guessed past. An operational search failure is tolerated exactly as issue #729
  // documents for the sibling branch: it only means this acceleration is unavailable right now,
  // never a reason to trust the mismatched pointer or block the whole transition.
  if (reconciled && reconciled.exitCode === 0 && reconciled.state === "AMBIGUOUS_MATCHES") {
    return {
      exitCode: 4,
      state: "AMBIGUOUS",
      stopAfter: true,
      repo,
      controlIssue: controlIssueNumber,
      reason: reconciled.message,
    };
  }
  if (reconciled && reconciled.exitCode === 0 && reconciled.state === "FOUND") {
    return {
      exitCode: 0,
      state: "STAGE2_AUDIT_ALREADY_PREPARED",
      stopAfter: true,
      repo,
      controlIssue: controlIssueNumber,
      pr: prIssue,
      issue: executionRef.issue,
      auditIssue: reconciled.auditIssue,
      staleAuditIssue: auditIssue,
      nextCommand:
        `node tools/orchestration/finalize-audit-breakpoint.mjs --control-issue ${controlIssueNumber} ` +
        `--execution-issue ${executionRef.issue} --pr ${prIssue} --audit-issue ${reconciled.auditIssue} ` +
        `--stale-audit-issue ${auditIssue} --revalidate-uniqueness true && ` +
        `node tools/review-watch/trigger.mjs --repo ${repo} --kind issue --number ${reconciled.auditIssue}`,
    };
  }

  // NONE_FOUND (or the tolerated operational-failure fallback above): the current merged PR has
  // no canonical Stage 2 audit yet. Require Stage 2 preparation for it -- never resume through
  // the mismatched predecessor pointer. `staleAuditIssue` travels with this verdict so the
  // controller's own eventual `finalize-audit-breakpoint.mjs` call (once the dispatched
  // preparation worker reports the freshly created Audit Issue number) can authorize replacing
  // this same verified-stale predecessor pointer.
  return {
    exitCode: 0,
    state: "STAGE2_PREPARATION_REQUIRED",
    stopAfter: true,
    repo,
    controlIssue: controlIssueNumber,
    pr: prIssue,
    issue: executionRef.issue,
    staleAuditIssue: auditIssue,
  };
}

// Control-Issue mode's shared pre-merge composition step: resolves the gated work/execution
// Issue from the control Issue body's own "Execution" bullet *before* resolving `head` (a
// malformed Execution reference must fail closed without ever spending a live PR-head read --
// the original, still-required ordering), reads the "Stage 1" disposition bullet, and delegates
// to resolvePreMerge. Issue #537 factors this out so both control-Issue mode's PR-only branch
// and its PR-open-alongside-a-settled-Stage-2 branch share exactly one Execution-resolution/
// composition path rather than two copies that could drift. Pass an already-known `head`
// (e.g. from a live-PR-state read the caller already made, or an explicit --head) to skip the
// lazy `ghPrHeadImpl` read entirely; otherwise supply `ghPrHeadImpl` and this function fetches
// the head itself, only once the Execution reference has already checked out.
async function resolvePreMergeFromControlBody(
  { repo, body, prIssue, controlIssueNumber, head, ghPrHeadImpl },
  { stage1RunImpl, checkMergeReadyImpl, checkCorrectionDeltaImpl, compareImpl, checkMergeConflictImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
) {
  const executionField = readExecutionBulletField(body);
  const executionRef = executionField.conflict
    ? { ok: false, reason: describeExecutionConflict(executionField) }
    : parseExecutionPointer(executionField.value);
  if (!executionRef.ok) {
    return {
      exitCode: 4,
      state: "AMBIGUOUS",
      stopAfter: true,
      repo,
      controlIssue: controlIssueNumber,
      reason:
        `Execution reference required to resolve the gated work issue for the pre-merge check is malformed: ` +
        `${executionRef.reason}`,
    };
  }

  let resolvedHead = head;
  if (!resolvedHead) {
    try {
      resolvedHead = await ghPrHeadImpl({ repo, number: prIssue });
    } catch (err) {
      return { exitCode: 1, message: `gh pr view failed for ${repo}#${prIssue}: ${err.message}` };
    }
  }

  const stage1Disposition = parseControlBullet(body, "Stage 1");
  return resolvePreMerge(
    { repo, pr: prIssue, head: resolvedHead, issue: executionRef.issue, stage1Disposition, controlIssue: controlIssueNumber },
    { stage1RunImpl, checkMergeReadyImpl, checkCorrectionDeltaImpl, compareImpl, checkMergeConflictImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
  );
}

function defaultGhIssueView({ repo, number }) {
  return readGithubIssue({ repo, number, fields: ["body", "state"] });
}

// Issue #837: the heads of every Stage 1 trigger round on the PR, most recent first. Reuses
// trigger.mjs's own findTriggerRounds (requires a valid head marker, so prose mentions of the
// trigger text never count) rather than a second parse of the marker format.
export function defaultListStage1TriggerHeads({ repo, pr }) {
  const raw = execFileSync("gh", ["api", `repos/${repo}/issues/${pr}/comments`, "--paginate", "--slurp"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const comments = JSON.parse(raw).flat();
  return findTriggerRounds(comments)
    .map((r) => r.head)
    .reverse();
}

// Issue #837 / PR #838 Stage 1 correction: the commits strictly between the reviewed head and the
// corrected head (GitHub compare API), reduced to what provenance needs. Throws on any I/O or
// shape failure so the caller fails closed to AMBIGUOUS.
export function defaultReadCorrectionCommits({ repo, base, head }) {
  const raw = execFileSync("gh", ["api", `repos/${repo}/compare/${base}...${head}?per_page=100`, "--paginate", "--slurp"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return reduceCompareCommits(JSON.parse(raw));
}

// Pure (Stage 2 Audit #839 finding 1). Flattens every paginated compare page and proves the
// enumeration is complete: the compare API's `total_commits` must equal the commits collected,
// otherwise the evidence is truncated and this throws so the caller fails closed to AMBIGUOUS.
export function reduceCompareCommits(pages) {
  const list = Array.isArray(pages) ? pages : [pages];
  const commits = [];
  let total = null;
  for (const page of list) {
    if (!page || !Array.isArray(page.commits)) throw new Error("compare API returned no commit list");
    if (Number.isInteger(page.total_commits)) total = page.total_commits;
    for (const c of page.commits) {
      commits.push({
        sha: c.sha,
        parents: Array.isArray(c.parents) ? c.parents.length : -1,
        parentShas: Array.isArray(c.parents) ? c.parents.map((x) => x?.sha) : [],
        message: c.commit?.message,
      });
    }
  }
  if (!Number.isInteger(total) || total !== commits.length) {
    throw new Error(`compare API commit enumeration incomplete (collected ${commits.length}, total_commits ${total})`);
  }
  return commits;
}

// Pure. Correction provenance for a strict reviewed->corrected descendant: the pair is the
// completed result of the authorized findings correction only when EVERY intervening commit is a
// plain single-parent commit (a merge-forward is not a correction) and names the execution Issue
// whose dispatch authorized the correction (LDL commit convention `... (#<execution>)`). The one
// representation of correction satisfaction remains the canonical finalized disposition; this
// only decides whether the gate may authorize writing it.
export function verifyCorrectionProvenance(commits, executionIssue, { targetShas = null } = {}) {
  if (!Array.isArray(commits) || commits.length === 0) return { ok: false, reason: "no intervening commits" };
  if (!Number.isInteger(executionIssue) || executionIssue <= 0) return { ok: false, reason: "no execution Issue to bind provenance to" };
  const ref = new RegExp(`(^|[^\\w/])#${executionIssue}(?!\\w)`);
  const onTarget = (sha) => targetShas instanceof Set && typeof sha === "string" && targetShas.has(sha);
  let authored = 0;
  for (const c of commits) {
    // Authorized conflict-recovery merge (docs/bounded-review-cycle.md "Correction-satisfied
    // merge-conflict recovery", PR #916 Stage 1 finding): commits that merely arrived from the
    // target branch are not correction commits, and the recovery's real merge commit is admitted
    // only when it is a two-parent merge naming the execution Issue whose first parent is
    // off-target (the PR branch) and whose second parent is on the target branch. Any other
    // multi-parent commit (an unrelated merge-forward) still fails closed.
    if (c && onTarget(c.sha)) continue;
    if (c && c.parents === 2 && targetShas instanceof Set) {
      const [first, second] = Array.isArray(c.parentShas) ? c.parentShas : [];
      if (typeof c.message === "string" && ref.test(c.message) && !onTarget(first) && onTarget(second)) {
        authored += 1;
        continue;
      }
      return { ok: false, reason: `commit ${c.sha} is a merge that is not the authorized conflict-recovery merge of the target branch` };
    }
    if (!c || c.parents !== 1) return { ok: false, reason: `commit ${c?.sha ?? "?"} is not a single-parent commit` };
    if (typeof c.message !== "string" || !ref.test(c.message)) {
      return { ok: false, reason: `commit ${c.sha} does not reference execution Issue #${executionIssue}` };
    }
    authored += 1;
  }
  if (authored === 0) return { ok: false, reason: "no correction commits in range" };
  return { ok: true };
}

// Commits on the PR's target branch that are not in `base` (GitHub compare, complete or throws).
export function defaultReadTargetBranchCommits({ repo, pr, base }) {
  const baseRef = String(readGithubPr({ repo, number: pr, fields: ["baseRefName"] }).baseRefName ?? "").trim();
  if (!baseRef) throw new Error("could not resolve PR base branch");
  const raw = execFileSync(
    "gh",
    ["api", `repos/${repo}/compare/${base}...${encodeURIComponent(baseRef)}?per_page=100`, "--paginate", "--slurp"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return reduceCompareCommits(JSON.parse(raw));
}

// Shared by the gate and the finalizer. Plain provenance first; only when the range contains a
// multi-parent commit is the target-branch commit set fetched to evaluate the authorized
// conflict-recovery merge. Throws on an unreadable/incomplete target enumeration (fail closed).
export async function verifyCorrectionProvenanceWithRecovery({ commits, executionIssue, repo, pr, reviewedHead, readTargetCommitsImpl = defaultReadTargetBranchCommits }) {
  const plain = verifyCorrectionProvenance(commits, executionIssue);
  if (plain.ok || !Array.isArray(commits) || !commits.some((c) => c && c.parents === 2)) return plain;
  const target = await readTargetCommitsImpl({ repo, pr, base: reviewedHead });
  return verifyCorrectionProvenance(commits, executionIssue, { targetShas: new Set(target.map((t) => t.sha)) });
}

function defaultGhPrHead({ repo, number }) {
  return readGithubPr({ repo, number, fields: ["headRefOid"] }).headRefOid;
}

// Issue #665 (the live #639/#638/PR #640 reproduction): `checkMergeReady` (lifecycle-gate.mjs)
// and `combineMergeReadyResult` (merge-ready-gate.mjs) both authorize merge without ever
// inspecting GitHub's own live mergeability against the current target branch -- a real
// conflict caused purely by target-branch drift is a dimension neither one checks. This reads
// exactly that one field, `gh pr view --json mergeable`, which GitHub reports as one of
// "MERGEABLE", "CONFLICTING", or "UNKNOWN" (computed asynchronously; not yet resolved). Scoped
// narrowly to the one call site below that fetches it -- the correction-satisfied merge path
// only, per this issue's own explicit scope -- so no other pre-merge path pays for this extra
// `gh` call or changes behavior at all.
function defaultGhPrMergeable({ repo, number }) {
  return { exitCode: 0, mergeable: readGithubPr({ repo, number, fields: ["mergeable"] }).mergeable };
}

// Issue #537: control-Issue mode's own live-PR-state read, used only when a settled "PR" and a
// settled "Stage 2" reference coexist and this gate must therefore decide which phase currently
// owns the transition (see the module comment above). `gh pr view --json state` reports exactly
// one of "OPEN", "CLOSED", or "MERGED". A sibling of defaultGhPrHead (its own injectable,
// mirroring this module's existing ghIssueViewImpl/ghPrHeadImpl/checkPostAuditImpl convention)
// rather than a change to defaultGhPrHead's own return shape, so every existing caller of
// ghPrHeadImpl (direct-reference mode, and control-Issue mode's PR-only branch) is unaffected.
//
// Issue #729: also fetches `mergeCommit` (the same field finalize-audit-breakpoint.mjs's own
// defaultGhPrView reads) -- a harmless extra field for every caller that ignores it, and what
// the merged-PR resume path's deterministic Stage 2 Audit Issue reconciliation below needs to
// match against an already-prepared Audit Issue's own "Exact merge commit" field. Absent (a test
// double that doesn't supply it) reads as `undefined`, which that reconciliation treats as "skip
// reconciliation, fall through to STAGE2_PREPARATION_REQUIRED unchanged" -- never a crash.
function defaultGhPrState({ repo, number }) {
  return readGithubPr({ repo, number, fields: ["headRefOid", "state", "mergeCommit"] });
}

// Issue #729 (control #398, the #723/#727 liveness seam): a prior Stage 2 preparation worker may
// have already created (or reconciled onto) the canonical Stage 2 Audit Issue for this exact
// PR/merge commit and returned "AUDIT_READY #<n>" -- but the bounded controller context that
// received that return value ended (interruption, not a designed stop) before it could run
// finalize-audit-breakpoint.mjs. The Audit Issue itself is already durable (it exists on GitHub);
// only the *fact that it's the authoritative one for this control Issue* needs deterministic
// recovery. `findMatchingOpenAuditIssues` now lives in `../review-watch/lifecycle-gate.mjs`
// (Stage 1 review finding P1/P2 on PR #730) so this module's own initial reconciliation search
// below and `finalize-audit-breakpoint.mjs`'s final pre-projection/trigger revalidation share one
// definition of "audit ready" -- including the complete canonical audit shape requirement, not
// only the two structured pointer fields -- rather than each maintaining a second, competing
// filter that could silently drift apart. Re-exported here so existing callers/tests of this
// module keep importing it from its established path.
export { findMatchingOpenAuditIssues };

// Issue #729: the async orchestration wrapper around findMatchingOpenAuditIssues above --
// injectable `ghIssueListImpl` mirrors this module's existing reconcileStage2CorrectionPr
// convention (its own `ghPrListImpl` injectable). Three outcomes:
//   { exitCode: 0, state: "NONE_FOUND" }        -- no durable match; normal dispatch applies.
//   { exitCode: 0, state: "FOUND", auditIssue }  -- exactly one durable match.
//   { exitCode: 0, state: "AMBIGUOUS_MATCHES", matches, message } -- more than one OPEN Audit
//     Issue durably matches the same merge commit/work issue -- genuinely conflicting evidence
//     (#729 Required Behavior 6) that must fail closed to a founder-visible AMBIGUOUS stop, never
//     be resolved by silently picking one.
//   { exitCode: 1, message } -- an operational failure searching GitHub. Callers treat this the
//     same as "the reconciliation mechanism itself is unavailable right now" and fall back to
//     the always-safe normal dispatch path (STAGE2_PREPARATION_REQUIRED), never as a reason to
//     block the whole transition on a transient search failure -- the dispatched worker performs
//     its own direct-read reconciliation regardless.
export async function reconcileExistingStage2AuditIssue(
  { repo, mergeCommitOid, executionIssue },
  { ghIssueListImpl = defaultGhAuditIssueSearchList } = {},
) {
  let candidates;
  try {
    candidates = await ghIssueListImpl({ repo });
  } catch (err) {
    return { exitCode: 1, message: `gh issue search failed while looking for an already-prepared Stage 2 Audit Issue: ${err.message}` };
  }
  // Issue #788: a malformed (non-pending) candidate is never "already prepared".
  const matches = findMatchingOpenAuditIssues(candidates, { mergeCommitOid, executionIssue }, { requirePendingState: true });
  if (matches.length === 0) return { exitCode: 0, state: "NONE_FOUND" };
  if (matches.length > 1) {
    const numbers = matches.map((m) => Number(m.number)).sort((a, b) => a - b);
    return {
      exitCode: 0,
      state: "AMBIGUOUS_MATCHES",
      matches: numbers,
      message:
        `more than one OPEN Audit Issue durably matches merge commit ${mergeCommitOid} and work issue ` +
        `${JSON.stringify(executionIssue)}: ${numbers.map((n) => `#${n}`).join(", ")}`,
    };
  }
  return { exitCode: 0, state: "FOUND", auditIssue: Number(matches[0].number) };
}

// The whole composed gate, wired for tests: every I/O dependency (control-Issue read, PR
// head read, and the four composed check functions themselves) is injectable, defaulting
// to the real `gh` CLI / real stage1-gate.mjs / real lifecycle-gate.mjs / real
// stage1-correction-gate.mjs in main(). Direct-reference mode (`auditIssue`, or `pr`+`head`)
// takes precedence over control-Issue mode when both are supplied, mirroring
// format-unit-dispatch-prompt.mjs's own explicit-fields-first convention.
// Named "...Core" and wrapped below (issue #486) so every verdict this returns picks up its
// `actionEnvelope` field in exactly one place, mirroring ready-dispatch-gate.mjs's identical
// checkReadyDispatchCore/checkReadyDispatch split.
async function runNextReviewTransitionGateCore(
  args,
  {
    resolveRepoIdentityImpl = resolveRepoIdentity,
    ghIssueViewImpl = defaultGhIssueView,
    ghPrHeadImpl = defaultGhPrHead,
    ghPrStateImpl = defaultGhPrState,
    stage1RunImpl = stage1Run,
    checkMergeReadyImpl = checkMergeReady,
    checkPostAuditImpl = checkPostAudit,
    checkCorrectionDeltaImpl = checkCorrectionDelta,
    compareImpl = defaultCompare,
    checkMergeConflictImpl = defaultGhPrMergeable,
    listStage1TriggerHeadsImpl = defaultListStage1TriggerHeads,
    readCorrectionCommitsImpl = defaultReadCorrectionCommits,
    readTargetCommitsImpl = defaultReadTargetBranchCommits,
    reconcileStage2CorrectionPrImpl = reconcileStage2CorrectionPr,
    reconcileExistingStage2AuditIssueImpl = reconcileExistingStage2AuditIssue,
    evaluateEvidenceCorrectionImpl = evaluateEvidenceCorrection,
    evaluateUnusableRecoveryImpl = evaluateUnusableRecovery,
  } = {},
) {
  if (args.resumeCorrectionPr !== undefined) {
    const n = Number(args.resumeCorrectionPr);
    if (!Number.isInteger(n) || n <= 0) return { exitCode: 1, message: "--resume-correction-pr must be a positive PR number." };
    // Issue #992: the founder's explicit resume instruction, handed only to the unusable-recovery evaluation.
    const baseEvaluate = evaluateUnusableRecoveryImpl;
    evaluateUnusableRecoveryImpl = (a, ...rest) => baseEvaluate({ ...a, resumeCorrectionPr: n }, ...rest);
  }
  let repo = args.repo;
  if (!repo) {
    const identity = resolveRepoIdentityImpl();
    if (!identity.ok) {
      return {
        exitCode: 1,
        message: `Could not determine the current repository identity (--repo was not supplied): ${identity.reason}`,
      };
    }
    repo = identity.repo;
  }

  // Direct-reference mode: skips the control-Issue read entirely. Checked before
  // --control-issue so an explicit direct reference always wins if both happen to be given.
  if (args.auditIssue) {
    return resolvePostMerge(
      { repo, auditIssue: args.auditIssue, controlIssue: null },
      { checkPostAuditImpl, reconcileStage2CorrectionPrImpl, ghPrStateImpl, ghIssueViewImpl, reconcileExistingStage2AuditIssueImpl, checkCorrectionDeltaImpl, compareImpl, evaluateEvidenceCorrectionImpl, evaluateUnusableRecoveryImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
    );
  }
  if (args.pr) {
    if (!args.head) {
      return {
        exitCode: 1,
        message: "Missing required arg: --head is required alongside --pr in direct-reference mode.",
      };
    }
    if (args.issue === undefined) {
      return {
        exitCode: 1,
        message:
          "Missing required arg: --issue is required alongside --pr and --head in direct-reference mode " +
          '(use "--issue none" only for the explicit no-work-issue path).',
      };
    }
    return resolvePreMerge(
      {
        repo,
        pr: args.pr,
        head: args.head,
        issue: args.issue,
        stage1Disposition: args.stage1Disposition ?? null,
        controlIssue: null,
      },
      { stage1RunImpl, checkMergeReadyImpl, checkCorrectionDeltaImpl, compareImpl, checkMergeConflictImpl },
    );
  }

  if (!args.controlIssue) {
    return {
      exitCode: 1,
      message:
        "Missing required arg: supply --control-issue, or a direct reference (--audit-issue, or --pr with --head).",
    };
  }

  let controlData;
  try {
    controlData = await ghIssueViewImpl({ repo, number: args.controlIssue });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo}#${args.controlIssue}: ${err.message}` };
  }
  const body = controlData.body ?? "";
  const controlIssueNumber = Number(args.controlIssue);
  if (controlData.state !== "OPEN") {
    return {
      exitCode: 4,
      state: "AMBIGUOUS",
      stopAfter: true,
      repo,
      controlIssue: controlIssueNumber,
      reason: `control Issue ${repo}#${controlIssueNumber} is ${controlData.state}, not OPEN`,
    };
  }

  const auditRef = parseOptionalIssueRefGuarded(body, "Stage 2");
  if (auditRef.kind === "ambiguous") {
    return {
      exitCode: 4,
      state: "AMBIGUOUS",
      stopAfter: true,
      repo,
      controlIssue: controlIssueNumber,
      reason: auditRef.reason,
    };
  }
  if (auditRef.kind === "invalid") {
    return {
      exitCode: 4,
      state: "AMBIGUOUS",
      stopAfter: true,
      repo,
      controlIssue: controlIssueNumber,
      reason: `Stage 2 (Audit) reference is malformed: ${auditRef.reason}`,
    };
  }

  const prRef = parseOptionalIssueRefGuarded(body, "PR");
  if (prRef.kind === "ambiguous") {
    return {
      exitCode: 4,
      state: "AMBIGUOUS",
      stopAfter: true,
      repo,
      controlIssue: controlIssueNumber,
      reason: prRef.reason,
    };
  }
  if (prRef.kind === "invalid") {
    return {
      exitCode: 4,
      state: "AMBIGUOUS",
      stopAfter: true,
      repo,
      controlIssue: controlIssueNumber,
      reason: `PR reference is malformed: ${prRef.reason}`,
    };
  }

  // Issue #537 (the #487/#535/#536 incident): both a settled "PR" and a settled "Stage 2"
  // reference are present. Field presence/order is not phase authority — live PR state is.
  // Resolve one more piece of live PR state (alongside the existing head read) before deciding
  // whether the pre-merge or post-merge phase currently owns the transition.
  if (prRef.kind === "issue" && auditRef.kind === "issue") {
    let prState;
    try {
      prState = await ghPrStateImpl({ repo, number: prRef.issue });
    } catch (err) {
      return { exitCode: 1, message: `gh pr view failed for ${repo}#${prRef.issue}: ${err.message}` };
    }
    if (prState.state === "MERGED") {
      // Issue #747 (the #691/#742/#739 reproduction): the relevant PR is merged, but a settled
      // "Stage 2" reference that merely *parses* is not proof it audits *this* merge -- #537 only
      // ever established that a settled pointer exists, never that it is current. Verify its
      // identity against the PR that actually just merged before trusting it.
      return resolveMergedPrWithSettledStage2(
        {
          repo,
          body,
          auditIssue: auditRef.issue,
          prIssue: prRef.issue,
          controlIssueNumber,
          mergeCommitOid: prState.mergeCommit?.oid,
          headRefOid: prState.headRefOid,
        },
        { ghIssueViewImpl, reconcileExistingStage2AuditIssueImpl, checkPostAuditImpl, reconcileStage2CorrectionPrImpl, checkCorrectionDeltaImpl, compareImpl, ghPrStateImpl, evaluateEvidenceCorrectionImpl, evaluateUnusableRecoveryImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
      );
    }
    if (prState.state === "OPEN") {
      // The PR is still open: the pre-merge PR/Stage 1 phase owns the transition even though a
      // (possibly historical/predecessor) Stage 2 reference also durably exists — that
      // reference is provenance, not a live post-merge pointer, until this PR actually merges.
      // Reuse the head this same call already read unless an explicit --head overrides it.
      const head = args.head || prState.headRefOid;
      return resolvePreMergeFromControlBody(
        { repo, body, prIssue: prRef.issue, controlIssueNumber, head, ghPrHeadImpl },
        { stage1RunImpl, checkMergeReadyImpl, checkCorrectionDeltaImpl, compareImpl, checkMergeConflictImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
      );
    }
    // CLOSED without merging (or any other state gh might report): a genuinely contradictory
    // phase. A closed-but-unmerged PR must never be silently treated as merged merely because a
    // Stage 2 reference happens to be present (#537 constraint 5) — fail closed instead of
    // guessing which phase applies.
    return {
      exitCode: 4,
      state: "AMBIGUOUS",
      stopAfter: true,
      repo,
      controlIssue: controlIssueNumber,
      reason:
        `PR ${repo}#${prRef.issue} is ${JSON.stringify(prState.state)} (neither OPEN nor MERGED) while control ` +
        `Issue #${controlIssueNumber} also references Stage 2 #${auditRef.issue}; refusing to select a phase for ` +
        "this contradictory PR/Stage 2 combination",
    };
  }

  if (auditRef.kind === "issue") {
    // No settled "PR" reference at all ("none", or the bullet is simply absent): the settled
    // Stage 2 reference remains the only active post-review pointer, exactly as before #537.
    return resolvePostMerge(
      { repo, auditIssue: auditRef.issue, controlIssue: controlIssueNumber },
      { checkPostAuditImpl, reconcileStage2CorrectionPrImpl, ghPrStateImpl, ghIssueViewImpl, reconcileExistingStage2AuditIssueImpl, checkCorrectionDeltaImpl, compareImpl, evaluateEvidenceCorrectionImpl, evaluateUnusableRecoveryImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
    );
  }

  if (prRef.kind === "issue") {
    // Issue #718: an explicit --head is a deliberate override (e.g. replaying a specific
    // already-known state) and, exactly as before this fix, skips any live PR read entirely --
    // it does not opt into the merged-PR resume detection below.
    if (args.head) {
      return resolvePreMergeFromControlBody(
        { repo, body, prIssue: prRef.issue, controlIssueNumber, head: args.head, ghPrHeadImpl },
        { stage1RunImpl, checkMergeReadyImpl, checkCorrectionDeltaImpl, compareImpl, checkMergeConflictImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
      );
    }
    // No settled "Stage 2" reference exists here (the auditRef.kind === "issue" branch above
    // already returned). Resolve the Execution reference first, before any live PR read --
    // mirrors resolvePreMergeFromControlBody's own ordering rationale below (a malformed
    // Execution reference must fail closed without ever spending a live PR read at all), and
    // means this same resolved reference is available for both outcomes of the live-state check
    // that follows.
    const executionField = readExecutionBulletField(body);
    const executionRef = executionField.conflict
      ? { ok: false, reason: describeExecutionConflict(executionField) }
      : parseExecutionPointer(executionField.value);
    if (!executionRef.ok) {
      return {
        exitCode: 4,
        state: "AMBIGUOUS",
        stopAfter: true,
        repo,
        controlIssue: controlIssueNumber,
        reason:
          `Execution reference required to resolve the gated work issue for the pre-merge check is malformed: ` +
          `${executionRef.reason}`,
      };
    }
    // Before treating this as an ordinary pre-merge transition, resolve live PR state the same
    // way the coexisting-PR-and-Stage-2 branch above already does (#537) -- a prior controller
    // may have already merged this PR (and possibly begun Stage 2 preparation) without ever
    // durably recording a settled "Stage 2" reference, e.g. because
    // dispatch-stage2-preparation-worker failed or the session was interrupted before
    // finalize-audit-breakpoint.mjs ran. Re-running stage1-gate/mergeReady against an
    // already-merged PR is not a safe resume path -- mergeReady in particular has no notion of
    // "already merged" and would happily re-authorize a second merge-pr action.
    let prState;
    try {
      prState = await ghPrStateImpl({ repo, number: prRef.issue });
    } catch (err) {
      return { exitCode: 1, message: `gh pr view failed for ${repo}#${prRef.issue}: ${err.message}` };
    }
    if (prState.state === "MERGED") {
      // Stage 1 correction on PR #721 (Codex P1 finding): a merged PR with no settled Stage 2
      // pointer must not resume Stage 2 preparation merely because it is merged -- a
      // prematurely or manually merged PR whose control state still carries an unsettled Stage
      // 1 disposition (e.g. the stranded "requested" shape, or none at all) would otherwise
      // bypass Stage 1 authority entirely. Require the control Issue's own "Stage 1" bullet to
      // already carry one of the two affirmative shapes the pre-merge phase above authorizes
      // merge from -- an ordinary "satisfied|exempt at <sha>" disposition, or a
      // "correction-satisfied at <sha> (reviewed <sha>)" one -- before resuming. When neither is
      // present, this is not a safe resume: stop at STAGE2_PREPARATION_BLOCKED_ON_STAGE1 and name
      // the documented recovery command (finalize-stage1-satisfied-breakpoint.mjs --recover true)
      // rather than silently authorizing Stage 2 preparation on unverified Stage 1 authority.
      // Issue #722: looksLikeCorrectionSatisfiedDisposition is defined to return false whenever
      // the strict parse below already succeeds (it exists only to flag a correction-shaped
      // bullet whose strict parse failed, so malformed state can fail closed -- see its own
      // module comment in stage1-correction-gate.mjs). ANDing it with a successful strict parse
      // was therefore mutually exclusive by construction: hasCorrectionSatisfiedDisposition could
      // never be true, so a canonical "correction-satisfied at <corrected> (reviewed <reviewed>)"
      // disposition was always rejected here, incorrectly reaching
      // STAGE2_PREPARATION_BLOCKED_ON_STAGE1 on the merged-PR resume path (the #398 reproduction
      // for execution #718 / merged PR #721). A successful strict parse is sufficient on its own
      // to prove the bullet's *syntax*; it is never sufficient on its own to prove the recorded
      // correction is still valid *authority* for the PR head actually being resumed here -- see
      // the independent re-validation against checkCorrectionDeltaImpl below (Stage 1 correction
      // on PR #724, Codex P1 finding on #722: a syntactically-canonical bullet naming a stale,
      // unverified, or provenance-invalid correction must still fail closed). The lenient
      // helper's role remains limited to distinguishing "absent" from "malformed" for a strict
      // parse that already failed, never to gating an already-successful strict parse.
      const stage1Bullet = parseControlBullet(body, "Stage 1");
      const hasAffirmativeDisposition = parseAffirmativeStage1Disposition(stage1Bullet) !== null;
      const parsedCorrectionSatisfied = parseCorrectionSatisfiedDisposition(stage1Bullet);
      const hasCorrectionSatisfiedDisposition = parsedCorrectionSatisfied !== null;
      if (!hasAffirmativeDisposition && !hasCorrectionSatisfiedDisposition) {
        // Issue #913: findings-bearing correction evidence selects correction finalization, never
        // the ordinary satisfied recovery below (which stays unchanged for no-findings state).
        const correctionVerdict = await mergedUnfinalizedCorrectionVerdict(
          { repo, pr: prRef.issue, headRefOid: prState.headRefOid, issue: executionRef.issue, controlIssue: controlIssueNumber, stage1Bullet },
          { checkCorrectionDeltaImpl, compareImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
        );
        if (correctionVerdict) return correctionVerdict;
        return {
          exitCode: 3,
          state: "STAGE2_PREPARATION_BLOCKED_ON_STAGE1",
          stopAfter: true,
          repo,
          controlIssue: controlIssueNumber,
          pr: prRef.issue,
          issue: executionRef.issue,
          reason:
            `control Issue #${controlIssueNumber}'s "Stage 1" bullet (${JSON.stringify(stage1Bullet)}) is not a ` +
            `canonical satisfied/exempt or correction-satisfied disposition, but PR #${prRef.issue} is already ` +
            "MERGED -- Stage 2 preparation must not resume on unverified Stage 1 authority",
          nextCommand:
            `node tools/orchestration/finalize-stage1-satisfied-breakpoint.mjs --control-issue ${controlIssueNumber} ` +
            `--execution-issue ${executionRef.issue} --pr ${prRef.issue} --recover true`,
        };
      }
      // Stage 1 correction on PR #724 (Codex P1 finding on #722): a canonical
      // "correction-satisfied at <corrected> (reviewed <reviewed>)" bullet proves only that the
      // bullet parses -- it does not by itself prove the recorded correction is still valid
      // authority for the PR head actually being resumed. Re-derive the full evidence invariant
      // the pre-merge phase already enforces (resolvePreMerge above) by independently validating
      // through the same checkCorrectionDeltaImpl: the corrected head must match the actual
      // merged PR head, the reviewed head must carry genuine findings-bearing Stage 1 evidence,
      // and the corrected head must be a strict, non-diverged descendant of the reviewed head.
      // Skipped entirely when an ordinary satisfied/exempt disposition is already present --
      // that shape needs no correction-evidence re-derivation.
      if (!hasAffirmativeDisposition) {
        let correctionDelta;
        try {
          correctionDelta = await checkCorrectionDeltaImpl({
            repo,
            pr: prRef.issue,
            reviewedHead: parsedCorrectionSatisfied.reviewedHead,
            correctedHead: parsedCorrectionSatisfied.correctedHead,
            gatedHead: prState.headRefOid,
          });
        } catch (err) {
          correctionDelta = { exitCode: 1, message: `stage1-correction-gate threw: ${err.message}` };
        }
        if (!hasTrustworthyExitCode(correctionDelta) || correctionDelta.exitCode === 1) {
          return {
            exitCode: 4,
            state: "AMBIGUOUS",
            stopAfter: true,
            repo,
            controlIssue: controlIssueNumber,
            reason:
              "tools/review-watch/stage1-correction-gate.mjs's checkCorrectionDelta returned output without a " +
              "trustworthy exitCode (or reported an operational error) while independently validating the " +
              `merged-PR resume correction-satisfied disposition for PR #${prRef.issue}: ` +
              `${correctionDelta && correctionDelta.message}`,
          };
        }
        if (correctionDelta.state === "HEAD_MISMATCH") {
          const correctionVerdict = await mergedUnfinalizedCorrectionVerdict(
            { repo, pr: prRef.issue, headRefOid: prState.headRefOid, issue: executionRef.issue, controlIssue: controlIssueNumber, stage1Bullet },
            { checkCorrectionDeltaImpl, compareImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
          );
          if (correctionVerdict) return correctionVerdict;
        }
        if (correctionDelta.state !== "CORRECTION_SATISFIED") {
          return {
            exitCode: 3,
            state: "STAGE2_PREPARATION_BLOCKED_ON_STAGE1",
            stopAfter: true,
            repo,
            controlIssue: controlIssueNumber,
            pr: prRef.issue,
            issue: executionRef.issue,
            reason:
              `control Issue #${controlIssueNumber}'s "Stage 1" bullet (${JSON.stringify(stage1Bullet)}) names a ` +
              "correction-satisfied disposition, but its correction evidence did not independently validate " +
              `against merged PR #${prRef.issue}'s actual head ${prState.headRefOid} (checkCorrectionDelta ` +
              `reported ${correctionDelta.state}${correctionDelta.reason ? `: ${correctionDelta.reason}` : ""}) -- ` +
              "Stage 2 preparation must not resume on unverified Stage 1 authority",
            nextCommand:
              `node tools/orchestration/finalize-stage1-satisfied-breakpoint.mjs --control-issue ${controlIssueNumber} ` +
              `--execution-issue ${executionRef.issue} --pr ${prRef.issue} --recover true`,
          };
        }
      }
      // Issue #729 (the #723/#727 liveness seam): before authorizing a fresh
      // dispatch-stage2-preparation-worker action merely to rediscover state a prior worker may
      // already have durably established, deterministically check whether the canonical Stage 2
      // Audit Issue for this exact PR/merge commit already exists and is still OPEN. This uses
      // only mechanically-decidable evidence -- the Audit Issue's own structured "Exact merge
      // commit"/"Work issue" fields, the same evidence finalize-audit-breakpoint.mjs
      // independently re-verifies before ever projecting control state -- never the diff, Stage 1
      // finding narrative, or execution-Issue body content, so this never reintroduces semantic
      // loading into the orchestrator. Skipped entirely when the live PR state carries no merge
      // commit (a test double, or an unexpected `gh` response shape) -- falls through to the
      // unchanged STAGE2_PREPARATION_REQUIRED dispatch below exactly as before this fix.
      const mergeCommitOid = prState.mergeCommit?.oid;
      if (typeof mergeCommitOid === "string" && mergeCommitOid.trim()) {
        let reconciled;
        try {
          reconciled = await reconcileExistingStage2AuditIssueImpl({ repo, mergeCommitOid, executionIssue: executionRef.issue });
        } catch (err) {
          reconciled = { exitCode: 1, message: `reconcileExistingStage2AuditIssue threw: ${err.message}` };
        }
        // An operational search failure never blocks the transition -- it only means the
        // acceleration this reconciliation offers is unavailable right now; fall through to the
        // always-safe normal dispatch path, which performs its own direct-read reconciliation
        // regardless. Only a genuinely conflicting result (more than one durable match) fails
        // closed to AMBIGUOUS -- #729 Required Behavior 6: a stop, never a guess, never silently
        // authorizing a trigger against ambiguous evidence.
        if (reconciled && reconciled.exitCode === 0 && reconciled.state === "AMBIGUOUS_MATCHES") {
          return {
            exitCode: 4,
            state: "AMBIGUOUS",
            stopAfter: true,
            repo,
            controlIssue: controlIssueNumber,
            reason: reconciled.message,
          };
        }
        if (reconciled && reconciled.exitCode === 0 && reconciled.state === "FOUND") {
          // Issue #561's own ordering invariant is unchanged: the reviewer trigger must occur
          // only after the Audit Issue/control relationship and exact merge identity are
          // deterministically verified/projected. finalize-audit-breakpoint.mjs independently
          // re-derives and re-verifies every one of those facts from live GitHub state (it never
          // trusts this reconciliation's own match as sufficient on its own) before
          // trigger.mjs's own idempotent dedup check ever runs -- so a retry of this exact
          // nextCommand (#729 Required Behavior 5) neither duplicates the Audit Issue (already
          // durable, only reused) nor posts a duplicate reviewer trigger. Stage 1 review finding
          // P2 on PR #730 (the TOCTOU gap): a second preparation worker could durably create
          // another matching canonical Audit Issue between this reconciliation search and the
          // finalize step's own control write/trigger authorization, so this recovery path's own
          // `nextCommand` -- and only this path, since it alone performs a discovery search a
          // race can land behind -- opts finalize-audit-breakpoint.mjs into re-searching and
          // revalidating that `reconciled.auditIssue` is still the sole matching OPEN canonical
          // Audit Issue immediately before it writes/triggers, failing closed to
          // AUDIT_BREAKPOINT_UNVERIFIED rather than silently proceeding against ambiguous
          // evidence if a second match has since appeared.
          return {
            exitCode: 0,
            state: "STAGE2_AUDIT_ALREADY_PREPARED",
            stopAfter: true,
            repo,
            controlIssue: controlIssueNumber,
            pr: prRef.issue,
            issue: executionRef.issue,
            auditIssue: reconciled.auditIssue,
            nextCommand:
              `node tools/orchestration/finalize-audit-breakpoint.mjs --control-issue ${controlIssueNumber} ` +
              `--execution-issue ${executionRef.issue} --pr ${prRef.issue} --audit-issue ${reconciled.auditIssue} ` +
              `--revalidate-uniqueness true && ` +
              `node tools/review-watch/trigger.mjs --repo ${repo} --kind issue --number ${reconciled.auditIssue}`,
          };
        }
      }
      // This verdict's own context shape (repo, pr, issue, controlIssue) matches
      // STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2's exactly -- tools/orchestration/format-
      // dispatch-prompt.mjs's stage2-preparation template can pipe either verdict's JSON through
      // unchanged.
      return {
        exitCode: 0,
        state: "STAGE2_PREPARATION_REQUIRED",
        stopAfter: true,
        repo,
        controlIssue: controlIssueNumber,
        pr: prRef.issue,
        issue: executionRef.issue,
      };
    }
    const head = prState.headRefOid;
    return resolvePreMergeFromControlBody(
      { repo, body, prIssue: prRef.issue, controlIssueNumber, head, ghPrHeadImpl },
      { stage1RunImpl, checkMergeReadyImpl, checkCorrectionDeltaImpl, compareImpl, checkMergeConflictImpl, listStage1TriggerHeadsImpl, readCorrectionCommitsImpl, readTargetCommitsImpl },
    );
  }

  // Neither "Stage 2" nor "PR" names a settled issue reference: a post-PR-lifecycle control
  // Issue with no PR and no Audit recorded at all is exactly the "conflicting/unrecognized
  // evidence shape" case AMBIGUOUS exists for.
  return {
    exitCode: 4,
    state: "AMBIGUOUS",
    stopAfter: true,
    repo,
    controlIssue: controlIssueNumber,
    reason:
      `control Issue #${controlIssueNumber} has neither a settled "PR" nor "Stage 2" reference ` +
      `(PR: ${JSON.stringify(parseControlBullet(body, "PR"))}, Stage 2: ${JSON.stringify(parseControlBullet(body, "Stage 2"))}) ` +
      "-- this gate only applies once at least one of them is settled",
  };
}

// Issue #486: attaches the deterministic `actionEnvelope` (see action-envelope.mjs) to every
// verdict this gate returns, keyed off the verdict's own `state`. A result with no `state`
// (an exitCode-1 operational-error shape) is left untouched — not a verdict on durable
// evidence at all, so it must not carry an envelope that could be mistaken for one.
export async function runNextReviewTransitionGate(args, impls) {
  const result = await runNextReviewTransitionGateCore(args, impls);
  if (typeof result.state !== "string") return result;
  const correctionContinuation = getCorrectionContinuation(result.state, result);
  return {
    ...result,
    actionEnvelope: getActionEnvelope(result.state, result),
    ...(correctionContinuation ? { correctionContinuation } : {}),
  };
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
  // Issue #678 Stage 1 correction, finding 1: clear any stale prior verdict before computing a
  // new one, so a run that errors out below never leaves an old side-channel entry behind for
  // a later, unrelated command to mistakenly consume.
  clearLastGateVerdict();
  // Issue #779: refuse to interpret lifecycle state with a stale controller checkout.
  const controlPlaneWitness = enforceControlPlaneFreshness();
  const raw = parseArgs(process.argv.slice(2));
  const result = await runNextReviewTransitionGate({
    repo: raw.repo,
    controlIssue: raw["control-issue"],
    pr: raw.pr,
    head: raw.head,
    issue: raw.issue,
    auditIssue: raw["audit-issue"],
    stage1Disposition: raw["stage1-disposition"],
    resumeCorrectionPr: raw["resume-correction-pr"],
  });
  if (controlPlaneWitness) result.controlPlaneWitness = controlPlaneWitness;
  if (result.exitCode === 1) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  // Issue #678 Stage 1 correction, finding 1: persist the verdict to the side channel at the
  // exact point it is emitted, before any downstream pipeline stage can transform stdout.
  // Issue #901: machine-authored continuations stay bound to the authenticated runner.
  const emitted = bindVerdictContinuation(result);
  persistLastGateVerdict(emitted);
  console.log(JSON.stringify(emitted));
  process.exit(result.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("next-review-transition-gate.mjs")) {
  main();
}
