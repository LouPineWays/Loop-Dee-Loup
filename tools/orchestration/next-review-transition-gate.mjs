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
//         CORRECTION_SATISFIED, lifecycle-gate merge-ready MERGE_READY(*)  -> STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2
//           (same effect as STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2 — merge, open/trigger
//           Stage 2, then stop — kept as a distinct verdict string purely for durable
//           auditability of which path authorized the merge)
//         CORRECTION_SATISFIED, lifecycle-gate merge-ready BLOCKED_CLOSING_REFERENCE -> STAGE1_CORRECTION_REQUIRED
//         CORRECTION_SATISFIED, any other lifecycle-gate merge-ready state -> AMBIGUOUS
//           (unrecognized combination — falls through to the same bottom-of-function fallback
//           as every other unrecognized combination in this table)
//         NOT_SATISFIED (reviewed head lacks findings-provenance, or the corrected head is not
//           a strict, non-diverged descendant of the reviewed head)        -> AMBIGUOUS
//         HEAD_MISMATCH (the disposition names a different head than the one currently being
//           gated — a stale or superseded disposition)                    -> NO_ACTION_YET,
//           same as no disposition being present at all
//         an operational error from checkCorrectionDelta itself           -> AMBIGUOUS
//     - stage1-gate PENDING with findings-bearing unbound genuine matches -> AMBIGUOUS
//     - stage1-gate PENDING otherwise                   -> NO_ACTION_YET
//     - stage1-gate EXEMPT, and
//         lifecycle-gate merge-ready MERGE_READY(*)      -> STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2
//         lifecycle-gate merge-ready BLOCKED_CLOSING_REFERENCE -> STAGE1_CORRECTION_REQUIRED
//     - stage1-gate RESPONSE_RECEIVED with a clean-pass response (consumer-sync-gate.mjs's
//       `isCleanStage1Response`), and lifecycle-gate merge-ready MERGE_READY(*) -> STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2
//     - stage1-gate RESPONSE_RECEIVED with findings preamble -> STAGE1_CORRECTION_REQUIRED,
//       except a control Issue Stage 1 bullet that is both satisfied/exempt and explicitly
//       head-scoped to this same current head also allows merge-ready progression
//     - stage1-gate RESPONSE_RECEIVED without a clean-pass or findings preamble -> NO_ACTION_YET
//     - anything else (operational error from either check, or a combination this gate does
//       not recognize)                                   -> AMBIGUOUS
//
//   Post-merge phase (a settled "Stage 2"/Audit reference):
//     - lifecycle-gate post-audit READY_TO_CLOSE or ACCEPTED_NO_WORK_ISSUE -> STAGE2_CLOSE_READY
//       (issue #407 unit 407-B: this verdict also carries `nextCommand`, the exact real
//       `lifecycle-gate.mjs close-audit` invocation the caller must run next — never only a
//       prose reminder to close the audit issue "where policy requires it". Stage 1 review
//       finding on PR #435: when a real gated work issue exists (READY_TO_CLOSE), `nextCommand`
//       also chains `close-work-issue` first — `close-audit` alone never touches it — so
//       ACCEPTED_NO_WORK_ISSUE, which has no work issue at all, keeps its audit-only shape.)
//     - lifecycle-gate post-audit OK with verdict "CLEAN" and workIssueState "CLOSED" (the
//       motivating resume case: work issue already closed, backed-CLEAN audit never consumed
//       — the exact #380/#384 shape) -> STAGE2_CLOSE_READY, audit-only `nextCommand` (Stage 1
//       review finding on PR #435: this combination reaches checkPostAudit's generic `OK`
//       branch, never `READY_TO_CLOSE`, since that branch requires the work issue to still be
//       open — it previously fell through to `NO_ACTION_YET` below instead)
//     - lifecycle-gate post-audit OK with rawVerdict "NOT CLEAN"           -> STAGE2_CORRECTION_REQUIRED
//     - lifecycle-gate post-audit REPORT_READY_TO_RECORD (issue #439: a completed Stage 2
//       report already exists on the thread, of either verdict, but the audit issue's own
//       durable Verdict field is still PENDING/malformed — the live #408/#436 gap, where a
//       fully completed CLEAN report sat unrecorded and a controller reported "no completed
//       response has landed") -> STAGE2_REPORT_READY_TO_RECORD, carrying `nextCommand` (the
//       exact real `lifecycle-gate.mjs record-verdict` invocation that deterministically
//       promotes the already-established evidence into the durable field, then stops — a
//       fresh gate invocation afterward resolves the now-recorded verdict through this same
//       table exactly as if a human had set the field by hand)
//     - lifecycle-gate post-audit OK with any other rawVerdict (no
//       completed report backing a verdict yet)                            -> NO_ACTION_YET
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
// that response is a clean pass or a findings-bearing reply is resolved with
// consumer-sync-gate.mjs's `isCleanStage1Response` helper, which is deliberately anchored to
// Codex's own known fixed Stage 1 preambles (clean pass vs findings) and does not semantically
// adjudicate arbitrary findings.
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
// "none" before Stage 2 has started) to decide which phase applies and what to compose it
// against. The PR's current head is derived live (one more `gh pr view` read) unless --head
// is given explicitly -- this gate does not invent a new durable "frozen head" bullet; the
// live current head is correct except in the narrow case where a fix commit landed after a
// trigger without a fresh re-trigger, in which case stage1-gate.mjs's own head-scoped
// NOT_REQUESTED evidence at that new head is exactly the correct signal (a fresh Stage 1
// round is required), not a gap this gate needs to paper over.
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

import { execFileSync } from "node:child_process";
import {
  parseControlBullet,
  parseExecutionPointer,
  isNoneSentinel,
  resolveRepoIdentity,
  readExecutionBulletField,
  describeExecutionConflict,
  findNearDuplicateBulletLabels,
} from "./ready-dispatch-gate.mjs";
import { run as stage1Run } from "../review-watch/stage1-gate.mjs";
import { checkMergeReady, checkPostAudit } from "../review-watch/lifecycle-gate.mjs";
import { isCleanStage1Response } from "../review-watch/consumer-sync-gate.mjs";
// Issue #454, unit 454-C: stage1-correction-gate.mjs itself imports `stage1DispositionMatchesHead`
// from this module (see that export's own comment below), so this is a deliberate circular
// import between the two modules. Both directions only reference the other's bindings from
// inside function bodies (never at module-top-level), so ESM's live-binding semantics resolve
// this safely regardless of which module is loaded first.
import {
  checkCorrectionDelta,
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
import { getActionEnvelope } from "./action-envelope.mjs";

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

function hasFindingsStage1Response(stage1) {
  return [...(stage1.matches ?? []), ...(stage1.unboundGenuineMatches ?? [])].some((m) =>
    FINDINGS_PREAMBLE_PATTERN.test(stripOuterWhitespace(m.body_excerpt)),
  );
}

export function resolvePreMergeVerdict({ stage1, mergeReady, stage1Disposition = null, correctionDelta = null }, context = {}) {
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

  const stage1DispositionSatisfiedAtHead = stage1DispositionMatchesHead(
    parseAffirmativeStage1Disposition(stage1Disposition),
    context.head,
  );
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
        return {
          state: "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2",
          stopAfter: true,
          ...context,
          reviewedHead: correctionDelta.reviewedHead,
          correctedHead: correctionDelta.correctedHead,
        };
      }
      if (composed.exitCode === 2 && composed.blockedBy?.length === 1 && composed.blockedBy[0].component === "lifecycle") {
        return { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, ...context };
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
      // A stale/superseded disposition that doesn't name the head currently being gated --
      // same plain NO_ACTION_YET as no disposition present at all.
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
      // -- plain NO_ACTION_YET, exactly as before this disposition shape existed.
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
    if (mergeReady.state === "BLOCKED_CLOSING_REFERENCE") {
      return { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, ...context };
    }
  }

  if (stage1.state === "RESPONSE_RECEIVED") {
    if (isCleanStage1Response(stage1)) {
      if (isMergeReadyState(mergeReady.state)) {
        return { state: "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", stopAfter: true, ...context };
      }
      if (mergeReady.state === "BLOCKED_CLOSING_REFERENCE") {
        return { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, ...context };
      }
    } else if (hasFindingsStage1Response(stage1)) {
      if (stage1DispositionSatisfiedAtHead && isMergeReadyState(mergeReady.state)) {
        return { state: "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", stopAfter: true, ...context };
      }
      return { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, ...context };
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
    const nextCommand = hasWorkIssue
      ? `node tools/review-watch/lifecycle-gate.mjs close-work-issue --repo ${context.repo} --work-issue ${postAudit.workIssue} --audit-issue ${context.auditIssue} && ${closeAuditCommand}`
      : closeAuditCommand;
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
      return {
        state: "STAGE2_CLOSE_READY",
        stopAfter: true,
        ...context,
        postAudit,
        nextCommand: `node tools/review-watch/lifecycle-gate.mjs close-audit --repo ${context.repo} --audit-issue ${context.auditIssue}`,
      };
    }
    if (postAudit.rawVerdict === "NOT CLEAN") {
      return { state: "STAGE2_CORRECTION_REQUIRED", stopAfter: true, ...context };
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
    case "STAGE2_CLOSE_READY":
    case "STAGE2_REPORT_READY_TO_RECORD":
      return 0;
    case "STAGE1_CORRECTION_REQUIRED":
    case "STAGE2_CORRECTION_REQUIRED":
      return 3;
    case "AMBIGUOUS":
    case "STAGE2_RESPONSE_UNUSABLE":
      return 4;
    default:
      return 4;
  }
}

async function resolvePreMerge(
  { repo, pr, head, issue, stage1Disposition = null, controlIssue },
  { stage1RunImpl, checkMergeReadyImpl, checkCorrectionDeltaImpl },
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
  if (stage1.state === "NOT_REQUESTED") {
    const parsed = parseCorrectionSatisfiedDisposition(stage1Disposition);
    if (parsed) {
      try {
        correctionDelta = await checkCorrectionDeltaImpl({
          repo,
          pr,
          reviewedHead: parsed.reviewedHead,
          correctedHead: parsed.correctedHead,
          gatedHead: head,
        });
      } catch (err) {
        correctionDelta = { exitCode: 1, message: `stage1-correction-gate threw: ${err.message}` };
      }
    }
  }

  const context = { repo, pr, head, issue, ...(controlIssue != null ? { controlIssue } : {}) };
  const verdict = resolvePreMergeVerdict({ stage1, mergeReady, stage1Disposition, correctionDelta }, context);
  return { exitCode: exitCodeFor(verdict.state), ...verdict };
}

async function resolvePostMerge({ repo, auditIssue, controlIssue }, { checkPostAuditImpl }) {
  let postAudit;
  try {
    postAudit = await checkPostAuditImpl({ repo, "audit-issue": auditIssue });
  } catch (err) {
    postAudit = { exitCode: 1, message: `lifecycle-gate post-audit threw: ${err.message}` };
  }

  const context = { repo, auditIssue, ...(controlIssue != null ? { controlIssue } : {}) };
  const verdict = resolvePostMergeVerdict({ postAudit }, context);
  return { exitCode: exitCodeFor(verdict.state), ...verdict };
}

function defaultGhIssueView({ repo, number }) {
  const raw = execFileSync("gh", ["issue", "view", String(number), "--repo", repo, "--json", "body,state"], {
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

function defaultGhPrHead({ repo, number }) {
  const raw = execFileSync("gh", ["pr", "view", String(number), "--repo", repo, "--json", "headRefOid"], {
    encoding: "utf8",
  });
  return JSON.parse(raw).headRefOid;
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
    stage1RunImpl = stage1Run,
    checkMergeReadyImpl = checkMergeReady,
    checkPostAuditImpl = checkPostAudit,
    checkCorrectionDeltaImpl = checkCorrectionDelta,
  } = {},
) {
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
    return resolvePostMerge({ repo, auditIssue: args.auditIssue, controlIssue: null }, { checkPostAuditImpl });
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
      { stage1RunImpl, checkMergeReadyImpl, checkCorrectionDeltaImpl },
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
  if (auditRef.kind === "issue") {
    return resolvePostMerge({ repo, auditIssue: auditRef.issue, controlIssue: controlIssueNumber }, { checkPostAuditImpl });
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
  if (prRef.kind === "issue") {
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

    let head = args.head;
    if (!head) {
      try {
        head = await ghPrHeadImpl({ repo, number: prRef.issue });
      } catch (err) {
        return { exitCode: 1, message: `gh pr view failed for ${repo}#${prRef.issue}: ${err.message}` };
      }
    }
    const stage1Disposition = parseControlBullet(body, "Stage 1");

    return resolvePreMerge(
      { repo, pr: prRef.issue, head, issue: executionRef.issue, stage1Disposition, controlIssue: controlIssueNumber },
      { stage1RunImpl, checkMergeReadyImpl, checkCorrectionDeltaImpl },
    );
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
  return { ...result, actionEnvelope: getActionEnvelope(result.state, result) };
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
  const raw = parseArgs(process.argv.slice(2));
  const result = await runNextReviewTransitionGate({
    repo: raw.repo,
    controlIssue: raw["control-issue"],
    pr: raw.pr,
    head: raw.head,
    issue: raw.issue,
    auditIssue: raw["audit-issue"],
    stage1Disposition: raw["stage1-disposition"],
  });
  if (result.exitCode === 1) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  console.log(JSON.stringify(result));
  process.exit(result.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("next-review-transition-gate.mjs")) {
  main();
}
