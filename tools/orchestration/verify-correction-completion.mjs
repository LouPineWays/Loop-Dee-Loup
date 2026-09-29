#!/usr/bin/env node
// Read-only Stage 1 correction-completion postcondition verifier — issue #764 (control #577).
//
// Live #726/#725/PR #763 recurrence: a findings-bearing Stage 1 correction worker pushed a
// corrected head but never ran `finalize-correction-breakpoint.mjs` (issue #576/#611 made that
// step mandatory only in the dispatch prompt -- worker instruction-following), so control #726
// stayed `Stage 1: requested` and a fresh `session-entry-gate.mjs` resolved `NOT_REQUESTED ->
// NO_ACTION_YET` with an empty action envelope. This script is the deterministic enforcement
// primitive that check needs: it never writes anything and never adjudicates correction
// evidence a second way. It re-derives, from durable state read fresh, whether the correction
// transition is actually complete:
//   - the control Issue's Execution pointer resolves to --execution-issue and the PR resolves to
//     --pr with the Shared Contract linkage (same helpers finalize-correction-breakpoint.mjs uses);
//   - the PR's live head is not the reviewed head (a correction actually changed it);
//   - the control Issue's `Stage 1` bullet is exactly the canonical
//     `correction-satisfied at <live head> (reviewed <reviewed head>)` disposition
//     (`verifyFinalizedCorrectionBody`), and the control's PR/Lifecycle are ones that disposition
//     may sit on (`composeCorrectionControlBody`);
//   - `checkCorrectionDelta` independently still reports CORRECTION_SATISFIED for that pair.
// Anything else -- omitted finalizer, stale/moved head, failed read -- is
// `CORRECTION_BREAKPOINT_UNVERIFIED` (exit 2). Operational argument errors are exit 1.
//
// `action-envelope-hook.mjs`'s SubagentStop handler calls this when the controller's own
// STAGE1_CORRECTION_REQUIRED (findings) dispatch marker is present, so the correction worker
// cannot stop with a success-shaped handoff while this fails.
//
// Usage:
//   node tools/orchestration/verify-correction-completion.mjs --control-issue N \
//     --execution-issue N --pr N --reviewed-head <sha>
//
// Tests: node --test tools/orchestration/verify-correction-completion.test.mjs

import { execFileSync } from "node:child_process";
import { resolveRepoIdentity } from "./ready-dispatch-gate.mjs";
import { verifyExecutionMatches, verifyPrLinkage, verifyPrHeadIsCurrent } from "./finalize-pr-breakpoint.mjs";
import { composeCorrectionControlBody, verifyFinalizedCorrectionBody } from "./finalize-correction-breakpoint.mjs";
import { checkCorrectionDelta } from "../review-watch/stage1-correction-gate.mjs";

function isPositiveInteger(v) {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

// One consistent PR-view + control-body snapshot: the live head is still `liveHead`, the control
// Execution/PR/lifecycle linkage holds, and the canonical correction-satisfied disposition is
// present for exactly (liveHead, reviewed). Run for the initial read and again for the final one.
function checkSnapshot(prView, body, { liveHead, reviewed, controlIssue, executionIssue, pr }) {
  const headCheck = verifyPrHeadIsCurrent(prView, liveHead);
  if (!headCheck.ok) return headCheck;
  const executionCheck = verifyExecutionMatches(body, executionIssue);
  if (!executionCheck.ok) return executionCheck;
  const linkage = verifyPrLinkage(prView, executionIssue);
  if (!linkage.ok) return linkage;
  const composed = composeCorrectionControlBody(body, { pr, correctedHead: liveHead, reviewedHead: reviewed });
  if (!composed.ok) return composed;
  const durable = verifyFinalizedCorrectionBody(body, { correctedHead: liveHead, reviewedHead: reviewed });
  if (!durable.ok) return { ok: false, reason: `control #${controlIssue} lacks the canonical correction-satisfied disposition: ${durable.reason}` };
  return { ok: true };
}

function unverified(pr, reason) {
  return { exitCode: 2, state: "CORRECTION_BREAKPOINT_UNVERIFIED", pr, reason, message: `CORRECTION_BREAKPOINT_UNVERIFIED ${pr}` };
}

export async function verifyCorrectionCompletion(
  { repo, controlIssue, executionIssue, pr, reviewedHead },
  { ghIssueViewImpl = defaultGhIssueView, ghPrViewImpl = defaultGhPrView, checkCorrectionDeltaImpl = checkCorrectionDelta } = {},
) {
  if (!isPositiveInteger(pr) || !isPositiveInteger(controlIssue) || !isPositiveInteger(executionIssue)) {
    return { exitCode: 1, message: "--control-issue, --execution-issue, and --pr must be positive integers." };
  }
  if (typeof reviewedHead !== "string" || !reviewedHead.trim()) {
    return { exitCode: 1, message: "--reviewed-head is required (the frozen head Stage 1 reviewed)." };
  }
  const reviewed = reviewedHead.trim();

  let prView;
  let body;
  try {
    prView = await ghPrViewImpl({ repo, pr });
    body = await ghIssueViewImpl({ repo, controlIssue });
  } catch (err) {
    return unverified(pr, `fresh durable read failed: ${err.message}`);
  }
  const liveHead = prView?.headRefOid;
  if (typeof liveHead !== "string" || !liveHead) return unverified(pr, "PR view carried no live head.");
  if (liveHead.toLowerCase() === reviewed.toLowerCase()) {
    return unverified(pr, `PR head is still the reviewed head ${reviewed}; no correction was pushed.`);
  }
  const snapshot = checkSnapshot(prView, body, { liveHead, reviewed, controlIssue, executionIssue, pr });
  if (!snapshot.ok) return unverified(pr, snapshot.reason);

  let delta;
  try {
    delta = await checkCorrectionDeltaImpl({ repo, pr, reviewedHead: reviewed, correctedHead: liveHead, gatedHead: liveHead });
  } catch (err) {
    return unverified(pr, `checkCorrectionDelta threw: ${err.message}`);
  }
  if (!delta || delta.exitCode === 1 || delta.state !== "CORRECTION_SATISFIED") {
    return unverified(pr, delta?.reason ?? delta?.message ?? "checkCorrectionDelta did not report CORRECTION_SATISFIED.");
  }
  // Both mutable authorities (PR head and control snapshot) can move during the reads above: a
  // success is only ever based on a final fresh read of BOTH, re-running the full durable checks.
  let latest;
  let latestBody;
  try {
    latest = await ghPrViewImpl({ repo, pr });
    latestBody = await ghIssueViewImpl({ repo, controlIssue });
  } catch (err) {
    return unverified(pr, `final durable re-read failed: ${err.message}`);
  }
  const finalSnapshot = checkSnapshot(latest, latestBody, { liveHead, reviewed, controlIssue, executionIssue, pr });
  if (!finalSnapshot.ok) return unverified(pr, `final freshness check: ${finalSnapshot.reason}`);

  return { exitCode: 0, state: "CORRECTION_COMPLETE_VERIFIED", pr, correctedHead: liveHead, reviewedHead: reviewed, message: `CORRECTION_COMPLETE_VERIFIED ${pr}` };
}

function defaultGhIssueView({ repo, controlIssue }) {
  const args = ["issue", "view", String(controlIssue), "--json", "body"];
  if (repo) args.push("--repo", repo);
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" })).body ?? "";
}

function defaultGhPrView({ repo, pr }) {
  const args = ["pr", "view", String(pr), "--json", "headRefName,headRefOid,body,state"];
  if (repo) args.push("--repo", repo);
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let repo = args.repo;
  if (!repo) {
    const identity = resolveRepoIdentity();
    if (!identity.ok) {
      console.error(`Could not determine repository identity: ${identity.reason}`);
      process.exit(1);
      return;
    }
    repo = identity.repo;
  }
  const num = (v) => (v != null ? Number(v) : null);
  const result = await verifyCorrectionCompletion({
    repo,
    controlIssue: num(args["control-issue"]),
    executionIssue: num(args["execution-issue"]),
    pr: num(args.pr),
    reviewedHead: args["reviewed-head"] ?? null,
  });
  if (result.exitCode === 1) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  console.error(JSON.stringify(result));
  console.log(result.message);
  process.exit(result.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("verify-correction-completion.mjs")) {
  main();
}
