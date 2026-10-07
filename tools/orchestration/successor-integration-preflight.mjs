#!/usr/bin/env node
// Deterministic successor-integration preflight -- issue #950 (control #951; live #867/#868/
// stale PR #869 reproduction).
//
// When a correction-satisfied PR has diverged so far from current target `main` that
// `resolve-protected-conflict.mjs` cannot prove a unique mechanical merge (exit 2), ordinary
// technical integration of an already-settled outcome may be re-done in ONE fresh successor PR
// cut from current `main`. This script is the idempotence/identity guard for that route: it never
// mutates anything. It answers exactly one question before the conflict-recovery worker creates a
// successor branch -- "is there already a successor for this execution attempt, or may one be
// created?" -- and fails closed on any stale, mismatched, or ambiguous evidence. Every invocation
// must supply the Stage-1-authorized correction-satisfied predecessor head so neither creation nor
// reuse can proceed from a predecessor that moved after the controller's gate.
//
// Successor identity (all required): an OPEN PR that references the execution Issue via the
// existing linkage convention (`referencesExecutionIssue`: `issue-<N>-` head branch or an
// `Addresses/Implements #<N>` body marker), is not the predecessor, targets the predecessor's own
// base branch, and carries the explicit body marker `Supersedes #<predecessor>`. An open
// execution-linked PR that is not the predecessor and lacks the marker is ambiguous authority and
// fails closed (never silently reused or duplicated).
//
// Output (one JSON line on stdout):
//   NO_SUCCESSOR      exit 0  -- may create one; carries `target` {ref, sha} and a suggested
//                              `branch` (contains `issue-<N>-`, so linkage holds). Pass
//                              `--expect-target <sha>` on a re-check just before pushing to fail
//                              closed (TARGET_MOVED) if main moved during preparation.
//   SUCCESSOR_EXISTS  exit 0  -- reuse `successor`; never create another.
//   FAIL_CLOSED       exit 2  -- `reason` names why; no successor mutation may proceed.
//   LOCAL_SUCCESSOR_LIVE_OWNED | _RESUMABLE | _STALE_RECLAIMABLE  exit 0 -- issue #968: no remote
//                              successor, but one interrupted attempt exists only as a local branch/worktree
//                              (classified by successor-local-state.mjs). Never create another; LIVE_OWNED =>
//                              stop (one worker already owns it); RESUMABLE => adopt `path`/`branch`;
//                              STALE_RECLAIMABLE => rerun with `--reclaim true` to retire it (unlock + remove
//                              the clean LDL worktree, archive any commits under refs/ldl/reclaimed/, delete the
//                              branch), which then returns NO_SUCCESSOR with `reclaimed`. `--worktree <path>`
//                              declares the caller's own successor worktree so the pre-push re-check returns
//                              NO_SUCCESSOR with that same branch.
//   AMBIGUOUS local state fails closed (FAIL_CLOSED, reason AMBIGUOUS_LOCAL_SUCCESSOR) and touches nothing.
// Exit 1 is an operational failure (unreadable GitHub state), never a verdict.
//
// The predecessor PR is never touched: its Stage 1 history is preserved and is not review
// authority for the successor (docs/bounded-review-cycle.md § Successor integration PR).
import { execFileSync } from "node:child_process";
import { readGithubPr } from "./github-read.mjs";
import { inspectLocalSuccessor, reclaimLocalSuccessor } from "./successor-local-state.mjs";
import { defaultGhPrList, referencesExecutionIssue, resolveRepoIdentity } from "./ready-dispatch-gate.mjs";

export function referencesSupersede(body, predecessorPr) {
  return typeof body === "string" && new RegExp(String.raw`\bSupersedes\s*:?\s*#${predecessorPr}(?!\d)`, "i").test(body);
}

const failClosed = (reason, extra = {}) => ({ state: "FAIL_CLOSED", exitCode: 2, reason, ...extra });

function defaultReadTarget({ repo, ref }) {
  const raw = execFileSync("gh", ["api", `repos/${repo}/commits/${encodeURIComponent(ref)}`], { encoding: "utf8" });
  const sha = JSON.parse(raw)?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`malformed REST commit response for ${ref}`);
  return sha;
}

export function evaluateSuccessor({ executionIssue, predecessor, linkedPrs, predecessorPr, candidateBase }) {
  if (predecessor.state === "MERGED") return failClosed(`predecessor PR #${predecessorPr} is already merged`);
  if (!referencesExecutionIssue(predecessor, executionIssue)) {
    return failClosed(`predecessor PR #${predecessorPr} does not reference execution Issue #${executionIssue}`);
  }
  const others = (linkedPrs ?? []).filter((pr) => pr.number !== predecessorPr);
  const merged = others.filter((pr) => pr.state === "MERGED" && referencesSupersede(pr.body, predecessorPr));
  if (merged.length > 0) return failClosed(`successor PR #${merged[0].number} is already merged; execution attempt is not open for integration`);
  const open = others.filter((pr) => pr.state === "OPEN");
  const marked = open.filter((pr) => referencesSupersede(pr.body, predecessorPr));
  const unmarked = open.filter((pr) => !referencesSupersede(pr.body, predecessorPr));
  if (unmarked.length > 0) {
    return failClosed(
      `open execution-linked PR(s) ${unmarked.map((p) => `#${p.number}`).join(", ")} do not declare "Supersedes #${predecessorPr}" -- ambiguous current-PR authority`,
    );
  }
  if (marked.length > 1) return failClosed(`multiple open successors (${marked.map((p) => `#${p.number}`).join(", ")}) -- ambiguous current-PR authority`);
  if (marked.length === 1) {
    const base = candidateBase(marked[0]);
    if (base !== predecessor.baseRefName) {
      return failClosed(`successor #${marked[0].number} targets ${base}, predecessor targets ${predecessor.baseRefName}`);
    }
    return { state: "SUCCESSOR_EXISTS", exitCode: 0, successor: marked[0].number, predecessor: predecessorPr };
  }
  if (predecessor.state !== "OPEN") return failClosed(`predecessor PR #${predecessorPr} is ${predecessor.state} and no successor exists`);
  return null;
}

export function run(
  { repo, executionIssue, predecessorPr, expectedPredecessorHead, expectTarget = null, worktree = null, reclaim = false },
  {
    readPr = (n, fields) => readGithubPr({ repo, number: n, fields }),
    listLinked = defaultGhPrList,
    readTarget = defaultReadTarget,
    inspectLocal = inspectLocalSuccessor,
    reclaimLocal = reclaimLocalSuccessor,
  } = {},
) {
  if (!Number.isInteger(executionIssue) || executionIssue <= 0 || !Number.isInteger(predecessorPr) || predecessorPr <= 0) {
    return failClosed("--execution-issue and --predecessor-pr must be positive integers");
  }
  if (typeof expectedPredecessorHead !== "string" || !/^[0-9a-f]{40}$/i.test(expectedPredecessorHead)) {
    return failClosed("--expect-predecessor-head must be a 40-character commit SHA");
  }
  const predecessor = readPr(predecessorPr, ["state", "headRefName", "headRefOid", "baseRefName", "body"]);
  if (
    typeof predecessor.headRefOid !== "string" ||
    predecessor.headRefOid.toLowerCase() !== expectedPredecessorHead.toLowerCase()
  ) {
    return failClosed(
      `PREDECESSOR_HEAD_MISMATCH: PR #${predecessorPr} is ${predecessor.headRefOid ?? "unknown"}, expected ${expectedPredecessorHead}`,
    );
  }
  const linkedPrs = listLinked({ repo, executionIssue });
  const verdict = evaluateSuccessor({
    executionIssue,
    predecessor,
    linkedPrs,
    predecessorPr,
    candidateBase: (pr) => readPr(pr.number, ["baseRefName"]).baseRefName,
  });
  if (verdict) return verdict;
  const sha = readTarget({ repo, ref: predecessor.baseRefName });
  if (expectTarget && sha.toLowerCase() !== String(expectTarget).toLowerCase()) {
    return failClosed(`TARGET_MOVED: ${predecessor.baseRefName} is ${sha}, expected ${expectTarget}`);
  }
  const priorClosedSuccessors = (linkedPrs ?? []).filter(
    (pr) => pr.number !== predecessorPr && pr.state === "CLOSED" && referencesSupersede(pr.body, predecessorPr),
  ).length;
  const target = { ref: predecessor.baseRefName, sha };
  const attempt = priorClosedSuccessors + 1;
  let branch = `issue-${executionIssue}-successor-of-${predecessorPr}-attempt-${attempt}`;
  // Issue #968: no remote successor is not "no successor" -- an interrupted attempt may exist only
  // as a local branch/worktree. Classify it before ever suggesting creation of another.
  const inspectArgs = { executionIssue, predecessorPr, target, attempt, callerWorktree: worktree };
  let local = inspectLocal(inspectArgs);
  let reclaimed;
  if (local?.state === "LOCAL_SUCCESSOR_STALE_RECLAIMABLE" && reclaim) {
    reclaimed = reclaimLocal(local, { predecessorPr, revalidate: () => inspectLocal(inspectArgs) });
    local = null;
  }
  if (local?.state === "CALLER_OWNED") {
    branch = local.branch; // the caller's own worktree is the one successor; re-check passes with the same branch
  } else if (local) {
    return { ...local, predecessor: predecessorPr, target };
  }
  return {
    state: "NO_SUCCESSOR",
    exitCode: 0,
    predecessor: predecessorPr,
    target,
    branch,
    ...(reclaimed ? { reclaimed } : {}),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let repo = args.repo;
  if (!repo) {
    const identity = resolveRepoIdentity();
    if (!identity.ok) {
      console.error(`Could not determine repository identity: ${identity.reason}`);
      process.exit(1);
    }
    repo = identity.repo;
  }
  let result;
  try {
    result = run({
      repo,
      executionIssue: Number(args["execution-issue"]),
      predecessorPr: Number(args["predecessor-pr"]),
      expectedPredecessorHead: args["expect-predecessor-head"] ?? null,
      expectTarget: args["expect-target"] ?? null,
      worktree: args.worktree ?? null,
      reclaim: args.reclaim === "true",
    });
  } catch (err) {
    console.error(`successor-integration-preflight: ${err.message}`);
    process.exit(1);
  }
  const { exitCode, ...out } = result;
  console.log(JSON.stringify(out));
  process.exit(exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("successor-integration-preflight.mjs")) main();
