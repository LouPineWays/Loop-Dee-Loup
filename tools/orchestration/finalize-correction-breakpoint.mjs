#!/usr/bin/env node
// Deterministic Stage 1 correction-satisfied breakpoint finalize step — issue #576.
//
// #576's live #571/PR #573 reproduction: a Stage 1 correction worker committed a consolidated
// fix, pushed a merge-ready head, and stopped at its normal breakpoint (`docs/bounded-review-
// cycle.md`'s "Correction-satisfied disposition" section) without the thin control Issue ever
// durably carrying the `- **Stage 1:** correction-satisfied at <corrected-head> (reviewed
// <reviewed-head>)` disposition that section's own prose says the worker "records ... on the
// control Issue" — nothing mechanically required that write to actually land before the
// breakpoint was accepted as complete. Control #571 stayed `Stage 1: requested`, so
// `tools/orchestration/next-review-transition-gate.mjs` kept resolving `NO_ACTION_YET` forever:
// `resolvePreMergeVerdict`'s `stage1.state === "NOT_REQUESTED"` branch only reaches
// `STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2` when a `correction-satisfied` bullet
// is already present and mechanically verified — it never had one to check.
//
// This script is the mechanical enforcement, modeled directly on
// `tools/orchestration/finalize-pr-breakpoint.mjs`'s (issue #456) own PR/Stage-1 breakpoint
// pattern applied to this distinct, later breakpoint. It composes existing tooling only, never
// reimplements it:
//   - `tools/review-watch/stage1-correction-gate.mjs`'s `checkCorrectionDelta` is the only
//     thing that establishes CORRECTION_SATISFIED evidence — the same mechanical re-derivation
//     `next-review-transition-gate.mjs` itself already trusts (findings-bearing provenance at
//     the reviewed head, strict non-diverged ancestry to the corrected head, head-match at the
//     head being gated). This script never adjudicates that evidence a second way.
//   - `finalize-pr-breakpoint.mjs`'s own exported `verifyExecutionMatches`, `verifyPrLinkage`,
//     and `verifyPrHeadIsCurrent` supply the control/PR/execution-Issue identity and head-
//     freshness checks — the exact same linkage convention and staleness guard that breakpoint
//     already established, reused rather than re-implemented a second way here.
//   - `tools/orchestration/write-control-snapshot.mjs`'s `checkWriteControlSnapshot` performs
//     the only write, validating the proposed body before it ever reaches `gh`.
//   - `tools/orchestration/ready-dispatch-gate.mjs`'s `parseControlBullet`, `parseHeadingField`,
//     and `upsertControlBullet` supply the read/compose primitives on the control body — the
//     same parser/convention every other control-plane script already trusts.
//
// What it persists, and why:
//   - `- **Stage 1:** correction-satisfied at <corrected-head> (reviewed <reviewed-head>)` —
//     the exact disposition shape `tools/review-watch/stage1-correction-gate.mjs`'s own
//     `parseCorrectionSatisfiedDisposition` and `next-review-transition-gate.mjs`'s
//     `resolvePreMergeVerdict` already recognize. Established from durable evidence
//     (`checkCorrectionDelta`'s own CORRECTION_SATISFIED result), never from the caller's own
//     claim that a correction was applied.
//   - Nothing else. `Lifecycle`, `PR`, `Execution`, `Route`, `Blocker`, and `Founder decision`
//     are left exactly as the control Issue already records them -- this breakpoint does not
//     change the PR's review stage (it stays `REVIEW`, or the recognized-but-currently-unused
//     `CORRECTION` value `ready-dispatch-gate.mjs`'s `POST_PR_MID_CYCLE_LIFECYCLE_VALUES`
//     already lists), only whether a corrected head has reached deterministic Stage 1
//     satisfaction without a second Codex round.
//
// Fails closed (`CORRECTION_BREAKPOINT_UNVERIFIED`) rather than reporting ordinary success
// whenever the durable transition cannot be established or verified:
//   - the control Issue's own Execution pointer does not resolve to `--execution-issue`;
//   - the control Issue's own PR pointer does not resolve to `--pr` (a correction disposition
//     must never be persisted onto a control Issue that is not actually tracking this PR);
//   - `--pr` does not itself reference `--execution-issue` via the Shared Contract's own
//     PR-to-execution-Issue linkage convention (`verifyPrLinkage`);
//   - `--corrected-head` is not the PR's own live `headRefOid` — a stale or superseded head
//     must never be finalized as the correction that satisfied Stage 1 (`verifyPrHeadIsCurrent`);
//   - the control Issue's current Lifecycle is not one of the recognized values this breakpoint
//     is authorized to write over (`REVIEW` or `CORRECTION`);
//   - `checkCorrectionDelta` does not report `CORRECTION_SATISFIED` — a stale/unrelated/
//     diverged head pair, a reviewed head with no genuine findings-bearing response, or an
//     operational evidence-gathering failure;
//   - `write-control-snapshot.mjs` does not report `WRITTEN`;
//   - a fresh read-back of the control Issue's body does not show the exact `Stage 1` bullet
//     just composed -- never trusting the write call's own return value.
//
// Direct-reference/no-thin-control flows (issue #576 Required behavior #8): omit
// `--control-issue`/`--execution-issue` entirely. The script still independently verifies the
// correction evidence via `checkCorrectionDelta` and the corrected head's freshness against the
// live PR, then reports `CORRECTION_SATISFIED_VERIFIED` with no control write attempted -- there
// is no thin control Issue to invent, and `next-review-transition-gate.mjs`'s own
// direct-reference mode already accepts a `--stage1-disposition` argument supplied ad hoc at
// gate-check time instead of a persisted control bullet.
//
// Re-running after the disposition is already correctly recorded is a safe idempotent success:
// `checkCorrectionDelta` and the control write/read-back are simply re-derived and re-verified
// against the same evidence, which resolves to the same composed body (issue #576 Required
// behavior #5) -- no separate short-circuit path exists or is needed, mirroring
// `finalize-pr-breakpoint.mjs`'s own idempotence design (Verification scenario 6 there).
//
// On success, prints `FINALIZED <controlIssue> <executionIssue> <pr>` (control-Issue mode) or
// `CORRECTION_SATISFIED_VERIFIED <pr>` (direct-reference mode) to stdout (exit 0). On a
// fail-closed durable-handoff failure, prints `CORRECTION_BREAKPOINT_UNVERIFIED <pr>` to stdout
// (exit 2) -- report that reference verbatim rather than treating the correction breakpoint as
// complete. Full diagnostic detail goes to stderr in both the exit-1 (missing/invalid argument,
// unresolved repository identity) and exit-2 cases.
//
// Usage:
//   node tools/orchestration/finalize-correction-breakpoint.mjs --control-issue 571 \
//     --execution-issue 570 --pr 573 --reviewed-head <sha> --corrected-head <sha>
//   node tools/orchestration/finalize-correction-breakpoint.mjs --pr 573 \
//     --reviewed-head <sha> --corrected-head <sha>   # direct-reference, no thin control
//
// Tests: node --test tools/orchestration/finalize-correction-breakpoint.test.mjs

import { execFileSync } from "node:child_process";
import {
  resolveRepoIdentity,
  parseControlBullet,
  parseHeadingField,
  upsertControlBullet,
} from "./ready-dispatch-gate.mjs";
import { verifyExecutionMatches, verifyPrLinkage, verifyPrHeadIsCurrent } from "./finalize-pr-breakpoint.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";
import { checkCorrectionDelta } from "../review-watch/stage1-correction-gate.mjs";

// Lifecycle values this script is authorized to write the `Stage 1` correction disposition
// bullet over. `REVIEW` is the value `finalize-pr-breakpoint.mjs` itself establishes at the PR
// breakpoint and the value the whole Stage 1 cycle -- including a correction pass -- currently
// stays at; `CORRECTION` is the distinct post-PR mid-cycle value `ready-dispatch-gate.mjs`'s own
// `POST_PR_MID_CYCLE_LIFECYCLE_VALUES` already recognizes for exactly this stage, kept available
// even though nothing currently projects it, so this script does not itself have to be revised
// the day something does.
const ALLOWED_LIFECYCLE_FOR_CORRECTION = new Set(["REVIEW", "CORRECTION"]);

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Pure. The exact disposition shape `tools/review-watch/stage1-correction-gate.mjs`'s own
// `parseCorrectionSatisfiedDisposition` and `next-review-transition-gate.mjs` already recognize.
export function correctionSatisfiedDispositionValue({ correctedHead, reviewedHead }) {
  return `correction-satisfied at ${correctedHead} (reviewed ${reviewedHead})`;
}

// Pure. Composes the proposed control body: verifies the current Lifecycle and PR bullet are
// ones this breakpoint is authorized to act against, then upserts only the `Stage 1` bullet via
// `upsertControlBullet` -- every other field (Execution, Route, Lifecycle, Blocker, Founder
// decision) is left exactly as-is. Distinct from `finalize-pr-breakpoint.mjs`'s
// `composeFinalizedControlBody`: this breakpoint never transitions Lifecycle and never touches
// PR/Stage 2 -- it only ever exists once those are already durably established.
export function composeCorrectionControlBody(body, { pr, correctedHead, reviewedHead }) {
  const currentLifecycle = parseControlBullet(body, "Lifecycle") ?? parseHeadingField(body, "State");
  if (currentLifecycle === null || !ALLOWED_LIFECYCLE_FOR_CORRECTION.has(currentLifecycle.trim())) {
    return {
      ok: false,
      reason:
        `control Issue's current Lifecycle (${JSON.stringify(currentLifecycle)}) is not one of the recognized ` +
        `values this correction breakpoint is authorized to write over (${[...ALLOWED_LIFECYCLE_FOR_CORRECTION].join(", ")})`,
    };
  }
  const prField = parseControlBullet(body, "PR");
  if (prField === null || prField.trim() !== `#${pr}`) {
    return {
      ok: false,
      reason: `control Issue's PR bullet is ${JSON.stringify(prField)}, expected "#${pr}" -- refusing to persist a ` +
        "correction disposition onto a control Issue that is not actually tracking this PR",
    };
  }
  const stage1Value = correctionSatisfiedDispositionValue({ correctedHead, reviewedHead });
  const next = upsertControlBullet(body, "Stage 1", stage1Value);
  return { ok: true, body: next, stage1Value };
}

// Pure. Re-parses a freshly-read control body and confirms it actually carries the exact
// `Stage 1` correction-satisfied bullet just composed -- distinct from trusting
// `write-control-snapshot.mjs`'s own return value.
export function verifyFinalizedCorrectionBody(freshBody, { correctedHead, reviewedHead }) {
  const expected = correctionSatisfiedDispositionValue({ correctedHead, reviewedHead });
  const stage1Field = parseControlBullet(freshBody, "Stage 1");
  if (stage1Field === null || stage1Field.trim() !== expected) {
    return {
      ok: false,
      reason: `fresh read-back's Stage 1 bullet is ${JSON.stringify(stage1Field)}, expected ${JSON.stringify(expected)}`,
    };
  }
  return { ok: true };
}

function unverified({ pr, reason }) {
  return {
    exitCode: 2,
    state: "CORRECTION_BREAKPOINT_UNVERIFIED",
    pr,
    reason,
    message: `CORRECTION_BREAKPOINT_UNVERIFIED ${pr}`,
  };
}

// `ghIssueViewImpl`, `ghPrViewImpl`, `checkCorrectionDeltaImpl`, and `writeControlSnapshotImpl`
// are injected so tests can drive `run` end-to-end without touching the real network, `gh` CLI,
// or the full `checkCorrectionDelta` (which itself needs its own network injection) -- see this
// script's own test file for the fixture shapes.
export async function run(
  { repo, controlIssue = null, executionIssue = null, pr, reviewedHead, correctedHead },
  {
    ghIssueViewImpl = defaultGhIssueView,
    ghPrViewImpl = defaultGhPrView,
    checkCorrectionDeltaImpl = checkCorrectionDelta,
    writeControlSnapshotImpl = checkWriteControlSnapshot,
  } = {},
) {
  if (!isPositiveInteger(pr)) {
    return { exitCode: 1, message: "Missing/invalid required arg: --pr must be a positive integer." };
  }
  if (!isNonEmptyString(reviewedHead)) {
    return { exitCode: 1, message: "Missing required arg: --reviewed-head is required (the frozen head Stage 1 actually reviewed)." };
  }
  if (!isNonEmptyString(correctedHead)) {
    return { exitCode: 1, message: "Missing required arg: --corrected-head is required (the post-correction PR head)." };
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

  let prView;
  try {
    prView = await ghPrViewImpl({ repo, pr });
  } catch (err) {
    return unverified({ pr, reason: `gh pr view failed for PR #${pr}: ${err.message}` });
  }

  const headCheck = verifyPrHeadIsCurrent(prView, correctedHead);
  if (!headCheck.ok) {
    return unverified({ pr, reason: headCheck.reason });
  }

  if (controlIssue !== null) {
    let body;
    try {
      body = await ghIssueViewImpl({ repo, controlIssue });
    } catch (err) {
      return { exitCode: 1, message: `gh issue view failed for ${repo ?? "<repo>"}#${controlIssue}: ${err.message}` };
    }
    const executionCheck = verifyExecutionMatches(body, executionIssue);
    if (!executionCheck.ok) {
      return unverified({ pr, reason: executionCheck.reason });
    }
    const linkageCheck = verifyPrLinkage(prView ?? {}, executionIssue);
    if (!linkageCheck.ok) {
      return unverified({ pr, reason: linkageCheck.reason });
    }
  }

  let correctionResult;
  try {
    correctionResult = await checkCorrectionDeltaImpl({ repo, pr, reviewedHead, correctedHead, gatedHead: correctedHead });
  } catch (err) {
    return unverified({ pr, reason: `stage1-correction-gate.mjs's checkCorrectionDelta threw: ${err.message}` });
  }
  if (!correctionResult || typeof correctionResult.exitCode !== "number") {
    return unverified({ pr, reason: "checkCorrectionDelta produced no usable result." });
  }
  if (correctionResult.exitCode === 1) {
    return unverified({ pr, reason: `checkCorrectionDelta operational error: ${correctionResult.message}` });
  }
  if (correctionResult.state !== "CORRECTION_SATISFIED") {
    return unverified({
      pr,
      reason: correctionResult.reason ?? `checkCorrectionDelta reported ${JSON.stringify(correctionResult.state)}, not CORRECTION_SATISFIED`,
    });
  }

  if (controlIssue === null) {
    return {
      exitCode: 0,
      state: "CORRECTION_SATISFIED_VERIFIED",
      pr,
      reviewedHead: correctionResult.reviewedHead,
      correctedHead: correctionResult.correctedHead,
      message: `CORRECTION_SATISFIED_VERIFIED ${pr}`,
    };
  }

  // Re-read the control Issue immediately before composing/writing rather than reusing the body
  // fetched above, before the `gh pr view` and `checkCorrectionDelta` calls just ran --
  // mirroring finalize-pr-breakpoint.mjs's own Stage 1 review finding (PR #547) fix, so a
  // concurrent edit to any other field survives into this write instead of being clobbered.
  let latestBody;
  try {
    latestBody = await ghIssueViewImpl({ repo, controlIssue });
  } catch (err) {
    return unverified({ pr, reason: `pre-write control re-read failed: ${err.message}` });
  }

  const composed = composeCorrectionControlBody(latestBody, { pr, correctedHead, reviewedHead });
  if (!composed.ok) {
    return unverified({ pr, reason: composed.reason });
  }

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
  const verification = verifyFinalizedCorrectionBody(freshBody, { correctedHead, reviewedHead });
  if (!verification.ok) {
    return unverified({ pr, reason: verification.reason });
  }

  return {
    exitCode: 0,
    state: "FINALIZED",
    controlIssue,
    executionIssue,
    pr,
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
  const reviewedHead = args["reviewed-head"] ?? null;
  const correctedHead = args["corrected-head"] ?? null;

  const result = await run({ repo: resolvedRepo, controlIssue, executionIssue, pr, reviewedHead, correctedHead });

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

if (process.argv[1] && process.argv[1].endsWith("finalize-correction-breakpoint.mjs")) {
  main();
}
