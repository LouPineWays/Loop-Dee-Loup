#!/usr/bin/env node
// Deterministic ordinary Stage 1 satisfaction breakpoint finalize step — issue #586.
//
// #586's live #582/PR #583 reproduction: `tools/orchestration/next-review-transition-gate.mjs`
// independently proved Stage 1 satisfied at head `0056e55a8a1d5eb6498a16de42327532d359c694`
// (a genuine clean-pass Stage 1 response, merge-ready-gate.mjs satisfied) and authorized the
// `STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2` transition, PR #583 merged, but the thin control
// Issue was never durably rewritten past `- **Stage 1:** requested` — nothing mechanically
// required that write before merge/Stage 2 setup proceeded. `tools/review-watch/
// stage2-control-plane-ci-head.mjs` then correctly failed closed, since it can only resolve a
// canonical `satisfied at <head>` / `exempt at <head>` / `correction-satisfied at <head>
// (reviewed <head>)` disposition, none of which existed durably.
//
// This is the ordinary no-findings sibling of `finalize-correction-breakpoint.mjs` (issue
// #576/#577): that script mechanically persists `- **Stage 1:** correction-satisfied at
// <corrected-head> (reviewed <reviewed-head>)` once a correction round is genuinely satisfied.
// This script persists the plain `- **Stage 1:** satisfied at <head>` disposition once the
// *first-round* Stage 1 response is genuinely satisfied (a clean pass, or an exemption) and
// merge-ready-gate.mjs's evidence already authorizes `STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2`
// — the one durable disposition shape `tools/review-watch/stage2-control-plane-ci-head.mjs`'s
// own `AFFIRMATIVE_DISPOSITION_PATTERN` already recognizes, but that (before this issue) nothing
// ever mechanically wrote.
//
// It composes existing tooling only, never reimplements the underlying evidence check a second
// way:
//   - `tools/orchestration/next-review-transition-gate.mjs`'s own `runNextReviewTransitionGate`
//     is the ONLY thing that establishes the `STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2` verdict
//     — the exact same composed stage1-gate.mjs / lifecycle-gate.mjs merge-ready evidence a fresh
//     controller invoking that gate directly would see. This script never re-derives "is Stage 1
//     genuinely satisfied" from a private recomputation that could disagree with it (issue #586
//     Required behavior #3: "derived from the same evidence that authorized that transition").
//   - `finalize-pr-breakpoint.mjs`'s own exported `verifyExecutionMatches` and
//     `verifyPrHeadIsCurrent` supply the control/execution-Issue identity and head-freshness
//     checks — the exact same linkage convention and staleness guard every other finalize-*-
//     breakpoint script in this directory already trusts, reused rather than reimplemented here.
//   - `tools/orchestration/write-control-snapshot.mjs`'s `checkWriteControlSnapshot` performs the
//     only write, validating the proposed body before it ever reaches `gh`.
//   - `tools/orchestration/ready-dispatch-gate.mjs`'s `parseControlBullet`, `parseHeadingField`,
//     `upsertControlBullet`, and `parseExecutionPointer` supply the read/compose primitives on
//     the control body — the same parser/convention every other control-plane script trusts.
//   - `tools/review-watch/stage1-gate.mjs`'s `run` and `tools/review-watch/consumer-sync-gate.mjs`'s
//     `isCleanStage1Response` supply the independent re-derivation used only by `--recover`
//     mode's bounded reconciliation path (see below) — the same evidence primitives
//     `next-review-transition-gate.mjs` itself already composes for the forward path.
//
// What it persists, and why:
//   - `- **Stage 1:** satisfied at <head>` — the exact disposition shape
//     `tools/review-watch/stage2-control-plane-ci-head.mjs`'s own
//     `AFFIRMATIVE_DISPOSITION_PATTERN` already recognizes. Established from durable evidence
//     (the gate's own `STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2` verdict, or — in `--recover`
//     mode only — a direct independent re-derivation against the exact merged PR head), never
//     from the caller's own claim that Stage 1 was satisfied.
//   - Nothing else. `Lifecycle`, `PR`, `Execution`, `Route`, `Stage 2`, `Blocker`, and `Founder
//     decision` are left exactly as the control Issue already records them — this breakpoint
//     does not itself merge the PR, open the Stage 2 Audit Issue, or transition Lifecycle to
//     `AUDIT` (that remains `finalize-audit-breakpoint.mjs`'s own later, distinct job); it only
//     ever exists to close the durable-persistence gap between the gate's verdict and those
//     later, distinct actions.
//
// Ordering (issue #586 Required behavior #4 — "the transition ordering must prevent merge/
// Stage 2 setup from outrunning this durable Stage 1 promotion"): this script is the FIRST
// action in `tools/orchestration/action-envelope.mjs`'s `STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2`
// authorized-action sequence, strictly before `merge-pr` — mirroring issue #561's own precedent
// of reordering an authorized-action sequence at the envelope level, rather than merely adding
// another prose reminder, to make an ordering invariant structurally enforced. The
// `STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2` sibling verdict's sequence is
// deliberately left unchanged: its own durable `correction-satisfied at ...` disposition is
// already persisted earlier, at the correction worker's own breakpoint
// (`finalize-correction-breakpoint.mjs`), before that verdict is ever reachable at all.
//
// Fails closed (`STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED`) rather than reporting ordinary success
// whenever the durable transition cannot be established or verified:
//   - the control Issue's own Execution pointer does not resolve to `--execution-issue`;
//   - the control Issue's own "PR" bullet does not resolve to `--pr` (never persist a Stage 1
//     disposition onto a control Issue that is not actually tracking this PR — Stage 1 review
//     finding on PR #579's rigorous PR-pointer check, reused here rather than the weaker raw-
//     string comparison it replaced elsewhere);
//   - `--pr` does not itself reference `--execution-issue` via the Shared Contract's own PR-to-
//     execution-Issue linkage convention (`verifyPrLinkage`);
//   - a given `--head` is not the PR's own live `headRefOid` (`verifyPrHeadIsCurrent`);
//   - `next-review-transition-gate.mjs` does not resolve exactly
//     `STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2` — any other verdict (`STAGE1_CORRECTION_REQUIRED`
//     for a findings-bearing response, `NO_ACTION_YET`, `AMBIGUOUS`, an operational error, or the
//     distinct correction-satisfied verdict, which this script never acts on) refuses to
//     manufacture ordinary satisfaction (Required behaviors #6 and #7);
//   - the gate's own verdict does not name the exact `--pr` given, or carries no usable `head`;
//   - a fresh re-read of the PR's live head immediately before finalizing no longer matches the
//     head the gate's verdict authorized (a superseding push landed in the interim — mirrors
//     `finalize-correction-breakpoint.mjs`'s own Stage 1 review finding on PR #579);
//   - the control Issue's current Lifecycle is not one of the recognized values this breakpoint
//     is authorized to write over;
//   - `write-control-snapshot.mjs` does not report `WRITTEN`;
//   - a fresh read-back of the control Issue's body — never the write call's own return value —
//     does not show the exact `Stage 1` bullet just composed.
//
// Direct-reference/no-thin-control flows (mirroring `finalize-correction-breakpoint.mjs`'s own
// issue #576 Required behavior #8 precedent): omit `--control-issue`/`--execution-issue`. The
// script still independently re-derives the verdict via `next-review-transition-gate.mjs`'s own
// direct-reference mode (`--pr`/`--head`/`--issue`) and reports `STAGE1_SATISFIED_VERIFIED` with
// no control write attempted — there is no thin control Issue to invent.
//
// Recovery mode (`--recover true`, issue #586 Required behavior #10 — the exact #582/#583
// partial-transition shape: the PR is already merged and the control Issue still says only
// `Stage 1: requested`, so the forward path above no longer applies because
// `next-review-transition-gate.mjs` now routes a merged PR to its post-merge phase instead of
// resolving a pre-merge verdict at all). Requires `--control-issue`/`--execution-issue` (there is
// no stranded control-Issue state to reconcile in direct-reference mode). Independently
// re-derives Stage 1 evidence directly from `stage1-gate.mjs`'s `run` against the PR's own live
// `headRefOid` (still queryable after merge — the exact head that was actually merged, since a
// merged PR's branch can no longer receive further pushes) rather than the composed pre-merge
// gate, since merge-ready-gate.mjs's own closing-reference evidence is moot once the merge has
// already happened. Accepts only `EXEMPT` or a clean-pass `RESPONSE_RECEIVED`
// (`isCleanStage1Response`) — a findings-bearing response is refused exactly as in the forward
// path (Required behavior #6). Also refuses when the control Issue's current "Stage 1" bullet
// already parses as a `correction-satisfied` disposition — that stranded shape belongs to
// #576/#577's own recovery, never this one (issue #586 non-goal: "do not duplicate its findings-
// correction path"). Reuses the exact same compose/write/verify primitives as the forward path,
// so the two converge on identical durable output.
//
// On success, prints `FINALIZED <controlIssue> <executionIssue> <pr>` (control-Issue mode) or
// `STAGE1_SATISFIED_VERIFIED <pr>` (direct-reference mode) to stdout (exit 0). On a fail-closed
// durable-handoff failure, prints `STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED <pr>` to stdout (exit
// 2) — report that reference verbatim rather than treating the ordinary Stage 1 satisfaction
// breakpoint as complete. Full diagnostic detail goes to stderr in both the exit-1 (missing/
// invalid argument, unresolved repository identity) and exit-2 cases.
//
// Usage:
//   node tools/orchestration/finalize-stage1-satisfied-breakpoint.mjs --control-issue 587 \
//     --execution-issue 586 --pr 590
//   node tools/orchestration/finalize-stage1-satisfied-breakpoint.mjs --pr 590   # direct-reference
//   node tools/orchestration/finalize-stage1-satisfied-breakpoint.mjs --control-issue 587 \
//     --execution-issue 586 --pr 590 --recover true   # #582/#583 stranded-state reconciliation
//
// Tests: node --test tools/orchestration/finalize-stage1-satisfied-breakpoint.test.mjs

import { execFileSync } from "node:child_process";
import {
  resolveRepoIdentity,
  parseControlBullet,
  parseHeadingField,
  upsertControlBullet,
  parseExecutionPointer,
} from "./ready-dispatch-gate.mjs";
import { verifyExecutionMatches, verifyPrHeadIsCurrent, verifyPrLinkage } from "./finalize-pr-breakpoint.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";
import { runNextReviewTransitionGate } from "./next-review-transition-gate.mjs";
import { extractUrlPointerKinds } from "./control-field-validator.mjs";
import { run as stage1GateRun } from "../review-watch/stage1-gate.mjs";
import { isCleanStage1Response } from "../review-watch/consumer-sync-gate.mjs";

// Lifecycle values this script is authorized to write the ordinary Stage 1 `satisfied at <head>`
// disposition bullet over. `REVIEW` is the normal pre-merge value the forward path always sees
// (this script is authorized as the FIRST action in that verdict's envelope, strictly before
// `merge-pr` — see module comment). `CORRECTION` is included for parity with
// `finalize-correction-breakpoint.mjs`'s own tolerance (a second, now-clean Stage 1 round after
// an earlier correction pass, before any later transition has moved Lifecycle again). `AUDIT` is
// included only because `--recover true` mode's own #582/#583 reproduction shape genuinely
// reaches this breakpoint with Lifecycle already `AUDIT` (Stage 2 was already triggered before
// the Stage 1 disposition was ever durably promoted) — the exact stranded state this recovery
// mode exists to reconcile.
const ALLOWED_LIFECYCLE_FOR_STAGE1_SATISFIED = new Set(["REVIEW", "AUDIT", "CORRECTION"]);

const REQUIRED_STATE = "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2";

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Pure. The exact disposition shape `tools/review-watch/stage2-control-plane-ci-head.mjs`'s own
// `AFFIRMATIVE_DISPOSITION_PATTERN` already recognizes as the ordinary (non-correction) Stage 1
// satisfaction disposition.
export function ordinaryStage1SatisfiedDispositionValue({ head }) {
  return `satisfied at ${head}`;
}

// Pure. Stage 1 review finding on PR #579 (the same finding `finalize-correction-breakpoint.mjs`
// already applies to its own PR-bullet check): a raw-string comparison against the literal text
// "#<pr>" rejects two shapes `control-field-validator.mjs`'s own write-time validator (and
// `next-review-transition-gate.mjs`'s read-time `parseOptionalIssueRefGuarded`) already treat as
// a valid "PR" bullet — a full pull-request URL, and "#<pr>" followed by safe parenthetical
// annotation prose. Parses with the same pointer helper every other control-plane reader trusts,
// compares the *resolved* issue number, and still rejects a URL-shaped reference of the wrong
// kind (an issue URL where a pull request is required).
export function verifyControlPrBulletMatches(body, pr) {
  const prField = parseControlBullet(body, "PR");
  if (prField === null) {
    return {
      ok: false,
      reason:
        `control Issue has no "PR" bullet to verify against (expected a reference to #${pr}) -- refusing to ` +
        "persist a Stage 1 disposition onto a control Issue that is not actually tracking this PR",
    };
  }
  const prPointer = parseExecutionPointer(prField);
  if (!prPointer.ok) {
    return { ok: false, reason: `control Issue's PR bullet ${JSON.stringify(prField)} is malformed: ${prPointer.reason}` };
  }
  const wrongKindRef = extractUrlPointerKinds(prField).find((p) => p.kind !== "pull");
  if (wrongKindRef) {
    return {
      ok: false,
      reason:
        `control Issue's PR bullet ${JSON.stringify(prField)} names a ${wrongKindRef.kind}-kind reference ` +
        `(#${wrongKindRef.number}), but the "PR" field requires a pull-kind reference`,
    };
  }
  if (prPointer.issue !== pr) {
    return {
      ok: false,
      reason:
        `control Issue's PR bullet ${JSON.stringify(prField)} resolves to #${prPointer.issue}, expected #${pr} -- ` +
        "refusing to persist a Stage 1 disposition onto a control Issue that is not actually tracking this PR",
    };
  }
  return { ok: true };
}

// Pure. True only when `raw` (a control Issue's own "Stage 1" bullet value) already looks like
// the distinct `correction-satisfied at ... (reviewed ...)` disposition #576/#577 owns —
// `--recover true` mode must never touch that stranded shape (issue #586 non-goal).
export function looksLikeCorrectionSatisfiedBullet(raw) {
  return typeof raw === "string" && /^correction-satisfied\b/i.test(raw.trim());
}

// Pure. Composes the proposed control body: verifies the current Lifecycle and "PR" bullet are
// ones this breakpoint is authorized to act against, then upserts only the "Stage 1" bullet via
// `upsertControlBullet` — every other field (Execution, PR, Stage 2, Lifecycle, Route, Blocker,
// Founder decision) is left exactly as-is. Shared by both the forward path and `--recover`
// mode, so the two converge on identical durable output.
export function composeStage1SatisfiedControlBody(body, { pr, head }) {
  const currentLifecycle = parseControlBullet(body, "Lifecycle") ?? parseHeadingField(body, "State");
  if (currentLifecycle === null || !ALLOWED_LIFECYCLE_FOR_STAGE1_SATISFIED.has(currentLifecycle.trim())) {
    return {
      ok: false,
      reason:
        `control Issue's current Lifecycle (${JSON.stringify(currentLifecycle)}) is not one of the recognized ` +
        `values this breakpoint is authorized to write over (${[...ALLOWED_LIFECYCLE_FOR_STAGE1_SATISFIED].join(", ")})`,
    };
  }
  const prCheck = verifyControlPrBulletMatches(body, pr);
  if (!prCheck.ok) return prCheck;

  const existingStage1 = parseControlBullet(body, "Stage 1");
  if (looksLikeCorrectionSatisfiedBullet(existingStage1)) {
    return {
      ok: false,
      reason:
        `control Issue's "Stage 1" bullet ${JSON.stringify(existingStage1)} already carries a distinct ` +
        "correction-satisfied disposition -- refusing to overwrite #576/#577's own disposition with an ordinary one",
    };
  }

  const stage1Value = ordinaryStage1SatisfiedDispositionValue({ head });
  const next = upsertControlBullet(body, "Stage 1", stage1Value);
  return { ok: true, body: next, stage1Value };
}

// Pure. Re-parses a freshly-read control body and confirms it actually carries the exact
// `Stage 1` disposition bullet just composed — distinct from trusting
// `write-control-snapshot.mjs`'s own return value.
export function verifyFinalizedStage1SatisfiedBody(freshBody, { head }) {
  const expected = ordinaryStage1SatisfiedDispositionValue({ head });
  const stage1Field = parseControlBullet(freshBody, "Stage 1");
  if (stage1Field === null || stage1Field.trim() !== expected) {
    return { ok: false, reason: `fresh read-back's Stage 1 bullet is ${JSON.stringify(stage1Field)}, expected ${JSON.stringify(expected)}` };
  }
  return { ok: true };
}

function unverified({ pr, reason }) {
  return {
    exitCode: 2,
    state: "STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED",
    pr,
    reason,
    message: `STAGE1_SATISFIED_BREAKPOINT_UNVERIFIED ${pr}`,
  };
}

// Async. Recovery-mode evidence derivation (issue #586 Required behavior #10): independently
// re-derives ordinary Stage 1 satisfaction directly against the PR's own live (post-merge)
// `headRefOid`, bypassing the pre-merge composed gate entirely (it no longer applies once the PR
// has actually merged). Returns `{ ok: true, head }` or `{ ok: false, reason }`; never throws.
async function deriveRecoveredStage1Head({ repo, pr, prView }, { stage1GateRunImpl }) {
  if (!prView || prView.state !== "MERGED") {
    return { ok: false, reason: `--recover true requires the PR to already be MERGED; PR #${pr} is ${JSON.stringify(prView?.state ?? null)}` };
  }
  const head = prView.headRefOid;
  if (typeof head !== "string" || !head.trim()) {
    return { ok: false, reason: `PR #${pr} is MERGED but carries no live headRefOid to recover a head from` };
  }
  let stage1Result;
  try {
    stage1Result = await stage1GateRunImpl({ repo, number: pr, head });
  } catch (err) {
    return { ok: false, reason: `stage1-gate.mjs threw during recovery re-derivation: ${err.message}` };
  }
  if (!stage1Result || typeof stage1Result.exitCode !== "number") {
    return { ok: false, reason: "stage1-gate.mjs produced no usable result during recovery re-derivation" };
  }
  if (stage1Result.state === "EXEMPT") {
    return { ok: true, head };
  }
  if (stage1Result.state === "RESPONSE_RECEIVED" && isCleanStage1Response(stage1Result)) {
    return { ok: true, head };
  }
  return {
    ok: false,
    reason:
      `stage1-gate.mjs resolved ${JSON.stringify(stage1Result.state)} at the PR's merged head, not a genuine ` +
      "clean-pass/exempt disposition -- refusing to manufacture ordinary Stage 1 satisfaction during recovery",
  };
}

// `ghIssueViewImpl`, `ghPrViewImpl`, `runNextReviewTransitionGateImpl`, `stage1GateRunImpl`, and
// `writeControlSnapshotImpl` are injected so tests can drive `run` end-to-end without touching
// the real network, `gh` CLI, or the full composed gates (which themselves need their own
// network injection) — see this script's own test file for the fixture shapes.
export async function run(
  { repo, controlIssue = null, executionIssue = null, pr, head = null, recover = false },
  {
    ghIssueViewImpl = defaultGhIssueView,
    ghPrViewImpl = defaultGhPrView,
    runNextReviewTransitionGateImpl = runNextReviewTransitionGate,
    stage1GateRunImpl = stage1GateRun,
    writeControlSnapshotImpl = checkWriteControlSnapshot,
  } = {},
) {
  if (!isPositiveInteger(pr)) {
    return { exitCode: 1, message: "Missing/invalid required arg: --pr must be a positive integer." };
  }
  if ((controlIssue === null) !== (executionIssue === null)) {
    return {
      exitCode: 1,
      message: "--control-issue and --execution-issue must be supplied together, or both omitted for direct-reference mode.",
    };
  }
  if (controlIssue !== null && !isPositiveInteger(controlIssue)) {
    return { exitCode: 1, message: "Invalid arg: --control-issue must be a positive integer." };
  }
  if (executionIssue !== null && !isPositiveInteger(executionIssue)) {
    return { exitCode: 1, message: "Invalid arg: --execution-issue must be a positive integer." };
  }
  if (head !== null && !isNonEmptyString(head)) {
    return { exitCode: 1, message: "Invalid arg: --head, when given, must be a non-empty string." };
  }
  if (recover && controlIssue === null) {
    return { exitCode: 1, message: "--recover true requires --control-issue/--execution-issue -- there is no stranded control-Issue state to reconcile in direct-reference mode." };
  }

  let prView;
  try {
    prView = await ghPrViewImpl({ repo, pr });
  } catch (err) {
    return unverified({ pr, reason: `gh pr view failed for PR #${pr}: ${err.message}` });
  }

  if (head !== null) {
    const headCheck = verifyPrHeadIsCurrent(prView, head);
    if (!headCheck.ok) return unverified({ pr, reason: headCheck.reason });
  }

  let body = null;
  if (controlIssue !== null) {
    try {
      body = await ghIssueViewImpl({ repo, controlIssue });
    } catch (err) {
      return { exitCode: 1, message: `gh issue view failed for ${repo ?? "<repo>"}#${controlIssue}: ${err.message}` };
    }
    const executionCheck = verifyExecutionMatches(body, executionIssue);
    if (!executionCheck.ok) return unverified({ pr, reason: executionCheck.reason });
    const linkageCheck = verifyPrLinkage(prView ?? {}, executionIssue);
    if (!linkageCheck.ok) return unverified({ pr, reason: linkageCheck.reason });
    const prBulletCheck = verifyControlPrBulletMatches(body, pr);
    if (!prBulletCheck.ok) return unverified({ pr, reason: prBulletCheck.reason });
  }

  let authorizedHead;

  if (recover) {
    const existingStage1 = parseControlBullet(body, "Stage 1");
    if (looksLikeCorrectionSatisfiedBullet(existingStage1)) {
      return unverified({
        pr,
        reason:
          `control Issue's "Stage 1" bullet ${JSON.stringify(existingStage1)} already carries a distinct ` +
          "correction-satisfied disposition -- --recover true never reconciles that stranded shape (it belongs to #576/#577's own recovery)",
      });
    }
    const recovered = await deriveRecoveredStage1Head({ repo, pr, prView }, { stage1GateRunImpl });
    if (!recovered.ok) return unverified({ pr, reason: recovered.reason });
    authorizedHead = recovered.head;
  } else {
    let gateResult;
    try {
      gateResult =
        controlIssue !== null
          ? await runNextReviewTransitionGateImpl({ repo, controlIssue })
          : await runNextReviewTransitionGateImpl({ repo, pr, head: head ?? prView?.headRefOid, issue: executionIssue ?? "none" });
    } catch (err) {
      return unverified({ pr, reason: `next-review-transition-gate.mjs threw: ${err.message}` });
    }
    if (!gateResult || typeof gateResult.exitCode !== "number") {
      return unverified({ pr, reason: "next-review-transition-gate.mjs produced no usable result." });
    }
    if (gateResult.state !== REQUIRED_STATE) {
      return unverified({
        pr,
        reason:
          `next-review-transition-gate.mjs resolved ${JSON.stringify(gateResult.state)} (exitCode ${gateResult.exitCode}), ` +
          `not ${REQUIRED_STATE} -- refusing to manufacture ordinary Stage 1 satisfaction from any other verdict` +
          `${gateResult.reason ? `: ${gateResult.reason}` : ""}`,
      });
    }
    if (gateResult.pr !== pr) {
      return unverified({ pr, reason: `next-review-transition-gate.mjs resolved its verdict against PR #${gateResult.pr}, not the given --pr #${pr}` });
    }
    if (typeof gateResult.head !== "string" || !gateResult.head.trim()) {
      return unverified({ pr, reason: `next-review-transition-gate.mjs's ${REQUIRED_STATE} verdict carries no usable head` });
    }
    authorizedHead = gateResult.head;
  }

  // TOCTOU guard (mirrors finalize-correction-breakpoint.mjs's own Stage 1 review finding on PR
  // #579): re-fetch the PR's live head immediately before reporting success/persisting, so a
  // superseding push landed after the evidence above was derived can never be finalized as the
  // head that was actually reviewed/merged.
  let latestPrView;
  try {
    latestPrView = await ghPrViewImpl({ repo, pr });
  } catch (err) {
    return unverified({ pr, reason: `pre-finalize PR re-read failed: ${err.message}` });
  }
  const freshHeadCheck = verifyPrHeadIsCurrent(latestPrView, authorizedHead);
  if (!freshHeadCheck.ok) return unverified({ pr, reason: freshHeadCheck.reason });

  if (controlIssue === null) {
    return {
      exitCode: 0,
      state: "STAGE1_SATISFIED_VERIFIED",
      pr,
      head: authorizedHead,
      message: `STAGE1_SATISFIED_VERIFIED ${pr}`,
    };
  }

  // Re-read the control Issue immediately before composing/writing rather than reusing the body
  // fetched above, before the gate/recovery evidence calls just ran — mirrors
  // finalize-pr-breakpoint.mjs's and finalize-correction-breakpoint.mjs's own Stage 1 review
  // finding fix, so a concurrent edit to any other field survives into this write, and a
  // concurrent retarget of Execution/PR is caught rather than silently overwritten.
  let latestBody;
  try {
    latestBody = await ghIssueViewImpl({ repo, controlIssue });
  } catch (err) {
    return unverified({ pr, reason: `pre-write control re-read failed: ${err.message}` });
  }
  const latestExecutionCheck = verifyExecutionMatches(latestBody, executionIssue);
  if (!latestExecutionCheck.ok) return unverified({ pr, reason: latestExecutionCheck.reason });

  const composed = composeStage1SatisfiedControlBody(latestBody, { pr, head: authorizedHead });
  if (!composed.ok) return unverified({ pr, reason: composed.reason });

  let writeResult;
  try {
    writeResult = await writeControlSnapshotImpl({ repo, controlIssue, proposedBody: composed.body });
  } catch (err) {
    return unverified({ pr, reason: `write-control-snapshot.mjs threw: ${err.message}` });
  }
  if (writeResult.exitCode !== 0 || writeResult.state !== "WRITTEN") {
    return unverified({ pr, reason: `write-control-snapshot.mjs did not report WRITTEN (${JSON.stringify(writeResult)})` });
  }

  let freshBody;
  try {
    freshBody = await ghIssueViewImpl({ repo, controlIssue });
  } catch (err) {
    return unverified({ pr, reason: `post-write read-back failed: ${err.message}` });
  }
  const verification = verifyFinalizedStage1SatisfiedBody(freshBody, { head: authorizedHead });
  if (!verification.ok) return unverified({ pr, reason: verification.reason });

  return {
    exitCode: 0,
    state: "FINALIZED",
    controlIssue,
    executionIssue,
    pr,
    head: authorizedHead,
    stage1: composed.stage1Value,
    message: `FINALIZED ${controlIssue} ${executionIssue} ${pr}`,
  };
}

function defaultGhIssueView({ repo, controlIssue }) {
  const args = ["issue", "view", String(controlIssue), "--json", "body"];
  if (repo) args.push("--repo", repo);
  const raw = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(raw).body ?? "";
}

function defaultGhPrView({ repo, pr }) {
  const args = ["pr", "view", String(pr), "--json", "headRefName,headRefOid,body,state"];
  if (repo) args.push("--repo", repo);
  const raw = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(raw);
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
  const args = parseArgs(process.argv.slice(2));

  let resolvedRepo = args.repo;
  if (!resolvedRepo) {
    const identity = resolveRepoIdentity();
    if (!identity.ok) {
      console.error(`Could not determine the current repository identity (--repo was not supplied): ${identity.reason}`);
      process.exit(1);
      return;
    }
    resolvedRepo = identity.repo;
  }

  const controlIssue = args["control-issue"] != null ? Number(args["control-issue"]) : null;
  const executionIssue = args["execution-issue"] != null ? Number(args["execution-issue"]) : null;
  const pr = args.pr != null ? Number(args.pr) : null;
  const head = args.head ?? null;
  const recover = args.recover === "true" || args.recover === "1";

  const result = await run({ repo: resolvedRepo, controlIssue, executionIssue, pr, head, recover });

  if (result.exitCode === 1) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  if (result.exitCode === 2) {
    console.error(JSON.stringify(result));
    console.log(result.message);
    process.exit(2);
    return;
  }
  console.error(JSON.stringify(result));
  console.log(result.message);
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("finalize-stage1-satisfied-breakpoint.mjs")) {
  main();
}
