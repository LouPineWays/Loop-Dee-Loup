#!/usr/bin/env node
// Single authoritative pre-merge completion gate for docs/bounded-review-cycle.md Stage 1
// steps 8-9. Composes stage1-gate.mjs's Stage 1 evidence check and lifecycle-gate.mjs
// `merge-ready`'s work-issue closing-reference check into one fail-closed result, so a
// review-worthy PR's merge-ready/CLEAN transition depends on one command instead of an
// executor remembering to invoke two independent ones.
//
// Issue #214: YouTubery PR #49 carried `Closes #48`, completed Stage 1, and merged — the
// merging session simply never ran `lifecycle-gate.mjs merge-ready` alongside
// `stage1-gate.mjs`, so GitHub auto-closed issue #48 ahead of its Stage 2 audit. Both gates
// were individually correct (issues #135 and #156); the gap was that nothing made the two
// mandatory invocations one mechanically-required transition. `post-audit --recover true`
// caught and reversed the resulting premature closure (see docs/bounded-review-cycle.md's
// "Premature-closure recovery" section), but only after the invariant had already been
// violated — this script exists to prevent that violation earlier, not to replace recovery
// as defense in depth.
//
// This module does not reimplement either check: it calls stage1-gate.mjs's `run` and
// lifecycle-gate.mjs's `checkMergeReady` and combines their results. A caller cannot obtain
// a successful composed result by running, or by this script accepting, only one of the two
// — both must independently report success.
//
// Composed exit codes (distinct from either component's own exit codes, so a component
// result can never be mistaken for the composed one):
//   0 — PRE_MERGE_READY / PRE_MERGE_READY_NO_WORK_ISSUE (or, with `--reviewed-head`, their
//       PRE_MERGE_READY_CORRECTION_SATISFIED[/_NO_WORK_ISSUE] counterparts below): both
//       components succeeded.
//   2 — BLOCKED: at least one component reported a non-error blocking state (Stage 1
//       NOT_REQUESTED/PENDING, or lifecycle BLOCKED_CLOSING_REFERENCE). `blockedBy` names
//       which component(s) and their own state.
//   1 — OPERATIONAL_ERROR / MALFORMED_GATE_OUTPUT: a required argument was missing or
//       malformed, an underlying `gh` call failed, or a component returned output that
//       could not be trusted (missing/invalid exitCode). Never treated as a pass.
//
// Usage:
//   node tools/review-watch/merge-ready-gate.mjs \
//     --repo OWNER/REPO --pr 50 --head <sha> --issue 151
//   node tools/review-watch/merge-ready-gate.mjs \
//     --repo OWNER/REPO --pr 50 --head <sha> --issue none
//
// Correction-satisfied heads (issue #454, Stage 1 review finding on PR #459): when Stage 1's
// own leg reports NOT_REQUESTED at `--head` (no fresh trigger exists at a corrected head —
// see docs/bounded-review-cycle.md's "Correction-satisfied disposition" section), pass
// `--reviewed-head <frozen-reviewed-sha>` (the head the one-round `@codex review` actually
// reviewed) so this script — the single documented authoritative pre-merge command
// (docs/bounded-review-cycle.md step 8/10) — can also succeed for that head instead of
// permanently blocking it. This composes `stage1-correction-gate.mjs`'s own `checkCorrectionDelta`
// exactly the way `tools/orchestration/next-review-transition-gate.mjs` already does for its
// own STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2 verdict — the P1 gap this closes is
// that, before this, that verdict authorized merge without this documented command itself ever
// being able to agree: a conforming executor following step 10 (which requires this exact
// script to exit 0) had no way to reach exit 0 for a corrected head, even though the
// orchestration verdict said merge was authorized. `--reviewed-head` is never attempted, and
// costs no extra `gh` call, unless Stage 1's own leg is already NOT_REQUESTED — the common
// (non-correction) path is unchanged.
//
// Required CI/check evidence (issue #1129, control #953; live #951/#950/PR #952 reproduction): a
// head can be Stage 1 satisfied / correction-satisfied and still have a FAILED required CI run
// (head dcbfe195... failed run 37624396190, yet the deterministic path authorized merge). Merge
// authorization therefore also requires `checkRequiredCi` (below) to report CI_PASSED for the
// exact current PR head. This is a separate third leg: Stage 1 correction satisfaction is still
// recorded as the true Stage 1 fact it is; only the merge-authorizing composition consults CI. The
// leg is evaluated only when the other legs would otherwise pass (no extra `gh` calls on blocked
// paths) and `combineMergeReadyResult` fails closed (never exit 0) when it is absent. Composed
// BLOCKED `blockedBy` gains {component: "ci", state} (CI_FAILED, CI_PENDING,
// CI_REQUIRED_CHECK_MISSING, CI_HEAD_MISMATCH); an unreadable/ambiguous/unauthorized read is exit 1.
//
// The two base composed checks remain individually invocable (`stage1-gate.mjs`,
// `lifecycle-gate.mjs merge-ready`) for diagnostics or targeted testing of one half only —
// neither one's individual success is, on its own, grounds to merge or report a slice
// complete. Use this script for the actual pre-merge decision.
//
// Tests: node --test tools/review-watch/merge-ready-gate.test.mjs

import { execFileSync } from "node:child_process";
import { readGithubPr } from "../orchestration/github-read.mjs";
import { run as runStage1 } from "./stage1-gate.mjs";
import { checkMergeReady } from "./lifecycle-gate.mjs";
// Issue #454, Stage 1 review finding on PR #459: stage1-correction-gate.mjs itself imports
// `stage1DispositionMatchesHead` from tools/orchestration/next-review-transition-gate.mjs,
// which (after this change) imports `run` from this module — a 3-node import cycle
// (this module -> stage1-correction-gate.mjs -> next-review-transition-gate.mjs -> this
// module). Every usage on all three sides only reads the other module's bindings from inside
// function bodies, never at module-top-level, so ESM's live-binding semantics resolve this
// safely regardless of load order — mirrors the 2-node cycle next-review-transition-gate.mjs's
// own module comment already documents for the same reason.
import { checkCorrectionDelta } from "./stage1-correction-gate.mjs";


// -- Required CI/check evidence (issue #1129) -----------------------------------------------------

const CI_PASS = "CI_PASSED";
const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"]);
const NEUTRAL_CONCLUSIONS = new Set(["neutral", "skipped"]);
const NOT_PROTECTED_404 = /Branch not protected|Required status checks not enabled/i;

function isHexSha(value, min = 7) {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${min},40}$`, "i").test(value);
}

function defaultGhApi(path, { paginate = false } = {}) {
  const args = paginate ? ["api", path, "--paginate", "--slurp"] : ["api", path];
  let raw;
  try {
    raw = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = typeof err.stderr === "string" ? err.stderr : (err.stderr?.toString?.() ?? "");
    const e = new Error(`gh api ${path} failed: ${stderr.trim() || err.message}`);
    e.ghStderr = stderr;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`gh api ${path} returned non-JSON output: ${err.message}`);
  }
}

function branchPath(base) {
  if (typeof base !== "string" || base === "") throw new Error("PR base branch is missing");
  return base.split("/").map(encodeURIComponent).join("/");
}

function normalizeRequired(list, label) {
  if (!Array.isArray(list)) throw new Error(`${label} is not an array`);
  return list.map((item) => {
    if (typeof item === "string") return { context: item, appId: null };
    const context = item?.context;
    const appId = item?.app_id ?? item?.integration_id ?? null;
    if (typeof context !== "string" || context === "") throw new Error(`${label} contains an entry without a context`);
    return { context, appId: Number.isInteger(appId) && appId > 0 ? appId : null };
  });
}

// Reads the repository's own authoritative required-check definition for `base`: classic branch
// protection (from the branch summary, falling back to the dedicated endpoint) plus any branch
// ruleset `required_status_checks` rule. Throws on anything unreadable so the caller fails closed.
// An explicitly unprotected branch with no ruleset declares no required checks.
export function readRequiredCheckPolicy({ repo, base }, { ghApiImpl = defaultGhApi } = {}) {
  const bp = branchPath(base);
  const branch = ghApiImpl(`repos/${repo}/branches/${bp}`);
  if (!branch || typeof branch !== "object" || typeof branch.protected !== "boolean") {
    throw new Error("branch summary has no boolean 'protected' field");
  }
  const required = [];
  const sources = [];
  if (branch.protected) {
    const rsc = branch.protection?.required_status_checks;
    if (rsc && typeof rsc === "object") {
      if (rsc.enforcement_level !== "off") {
        const list = Array.isArray(rsc.checks) && rsc.checks.length > 0 ? rsc.checks : (rsc.contexts ?? []);
        required.push(...normalizeRequired(list, "branch protection required_status_checks"));
      }
    } else {
      let dedicated;
      try {
        dedicated = ghApiImpl(`repos/${repo}/branches/${bp}/protection/required_status_checks`);
      } catch (err) {
        const text = err.ghStderr ?? err.message;
        if (!(/HTTP 404/.test(text) && NOT_PROTECTED_404.test(text))) throw err;
        dedicated = null;
      }
      if (dedicated) {
        const list = Array.isArray(dedicated.checks) && dedicated.checks.length > 0 ? dedicated.checks : (dedicated.contexts ?? []);
        required.push(...normalizeRequired(list, "required_status_checks"));
      }
    }
    if (required.length > 0) sources.push("branch-protection");
  }
  const rules = ghApiImpl(`repos/${repo}/rules/branches/${bp}`);
  if (!Array.isArray(rules)) throw new Error("branch rules response is not an array");
  let fromRules = 0;
  for (const rule of rules) {
    if (rule?.type !== "required_status_checks") continue;
    const items = normalizeRequired(rule?.parameters?.required_status_checks, "ruleset required_status_checks");
    fromRules += items.length;
    required.push(...items);
  }
  if (fromRules > 0) sources.push("ruleset");
  return { required, source: sources.length > 0 ? sources.join("+") : "none-declared" };
}

// Pure. Classifies the check-run and legacy-status evidence for exactly `head` against `policy`.
// A declared policy makes only the declared contexts mandatory (each must exist and be `success`
// on this head); with no declared policy every observed check must be complete and non-failing
// (neutral/skipped allowed). Absence of evidence is never green when a context is required.
export function evaluateCiEvidence({ head, policy, checkRuns, statuses }) {
  const entries = [];
  const bad = (message) => ({ exitCode: 1, state: "CI_UNVERIFIABLE", head, message });
  for (const run of checkRuns) {
    if (!run || typeof run !== "object" || typeof run.name !== "string" || typeof run.status !== "string") {
      return bad("a check run entry is malformed");
    }
    if (typeof run.head_sha !== "string" || run.head_sha.toLowerCase() !== head) {
      return bad(`check run ${JSON.stringify(run.name)} is not bound to head ${head}`);
    }
    let state;
    if (run.status !== "completed") state = "pending";
    else if (run.conclusion === "success") state = "passed";
    else if (NEUTRAL_CONCLUSIONS.has(run.conclusion)) state = "neutral";
    else if (FAILED_CONCLUSIONS.has(run.conclusion)) state = "failed";
    else state = "unknown";
    entries.push({ kind: "check_run", name: run.name, appId: run.app?.id ?? null, state });
  }
  for (const status of statuses) {
    if (!status || typeof status.context !== "string" || typeof status.state !== "string") {
      return bad("a commit status entry is malformed");
    }
    const state =
      status.state === "success" ? "passed" : status.state === "pending" ? "pending" : status.state === "failure" || status.state === "error" ? "failed" : "unknown";
    entries.push({ kind: "status", name: status.context, appId: null, state });
  }

  const requiredList = policy.required;
  const blocking = [];
  const missing = [];
  if (requiredList.length > 0) {
    for (const req of requiredList) {
      const matches = entries.filter((e) => e.name === req.context && (req.appId === null || e.appId === req.appId));
      if (matches.length === 0) {
        missing.push(req.context);
        continue;
      }
      // A required context must be `success`; neutral/skipped does not satisfy it.
      for (const m of matches) if (m.state !== "passed") blocking.push({ name: m.name, kind: m.kind, state: m.state });
    }
  } else {
    for (const e of entries) if (e.state !== "passed" && e.state !== "neutral") blocking.push({ name: e.name, kind: e.kind, state: e.state });
  }

  const info = {
    head,
    policy: { source: policy.source, required: requiredList.map((r) => r.context) },
    observed: entries.length,
  };
  const failed = blocking.filter((b) => b.state === "failed" || b.state === "neutral");
  const unknown = blocking.filter((b) => b.state === "unknown");
  const pending = blocking.filter((b) => b.state === "pending");
  const names = (list) => list.map((b) => b.name).join(", ");
  if (failed.length > 0) return { exitCode: 2, state: "CI_FAILED", ...info, blocking: blocking.slice(0, 10), message: `required CI failed at head ${head}: ${names(failed)}` };
  if (unknown.length > 0) {
    return { exitCode: 1, state: "CI_UNVERIFIABLE", ...info, blocking: blocking.slice(0, 10), message: `CI evidence at head ${head} has non-success or unrecognized conclusions: ${names(unknown)}` };
  }
  if (pending.length > 0) return { exitCode: 2, state: "CI_PENDING", ...info, blocking: blocking.slice(0, 10), message: `required CI still pending at head ${head}: ${names(pending)}` };
  if (missing.length > 0) return { exitCode: 2, state: "CI_REQUIRED_CHECK_MISSING", ...info, missing, message: `required check(s) not reported at head ${head}: ${missing.join(", ")}` };
  return { exitCode: 0, state: CI_PASS, ...info };
}

// Reads GitHub's authoritative required-check policy and the check/status evidence for the exact
// current PR head and returns one machine-readable result. Exit codes: 0 CI_PASSED; 2 blocked
// (CI_FAILED, CI_PENDING, CI_REQUIRED_CHECK_MISSING, CI_HEAD_MISMATCH); 1 unverifiable (any
// unreadable, unauthorized, truncated, malformed or ambiguous read -- never treated as success).
// The PR head is read before and after the evidence reads; a changed head is CI_HEAD_MISMATCH.
// This is a conservative read-time binding at the merge handoff, not GitHub-side head protection.
export async function checkRequiredCi({ repo, pr, head }, { ghApiImpl = defaultGhApi, readPrImpl = readGithubPr } = {}) {
  const id = { repo: repo ?? null, pr: pr ?? null };
  const unverifiable = (message) => ({ exitCode: 1, state: "CI_UNVERIFIABLE", ...id, head: head ?? null, message });
  if (!repo || !pr || !isHexSha(head)) return unverifiable("checkRequiredCi requires repo, pr and a commit sha head");
  const wanted = head.toLowerCase();
  try {
    const before = readPrImpl({ repo, number: pr, fields: ["headRefOid", "baseRefName", "state"] });
    if (before.state !== "OPEN") return unverifiable(`PR ${repo}#${pr} is ${before.state}, not OPEN`);
    const live = String(before.headRefOid).toLowerCase();
    if (!live.startsWith(wanted)) {
      return { exitCode: 2, state: "CI_HEAD_MISMATCH", ...id, head: live, message: `PR head ${live} is not the decided head ${wanted}` };
    }
    const policy = readRequiredCheckPolicy({ repo, base: before.baseRefName }, { ghApiImpl });
    const pages = ghApiImpl(`repos/${repo}/commits/${live}/check-runs?per_page=100&filter=latest`, { paginate: true });
    if (!Array.isArray(pages) || pages.some((p) => !p || !Array.isArray(p.check_runs))) throw new Error("check-runs response is malformed");
    const checkRuns = pages.flatMap((p) => p.check_runs);
    const total = pages.length > 0 ? pages[0].total_count : 0;
    if (!Number.isInteger(total) || total !== checkRuns.length) throw new Error(`check-runs list is incomplete (${checkRuns.length} of ${total})`);
    const combined = ghApiImpl(`repos/${repo}/commits/${live}/status?per_page=100`);
    if (!combined || !Array.isArray(combined.statuses) || !Number.isInteger(combined.total_count)) throw new Error("combined status response is malformed");
    if (combined.statuses.length !== combined.total_count) throw new Error(`commit status list is incomplete (${combined.statuses.length} of ${combined.total_count})`);
    if (combined.total_count > 0 && String(combined.sha).toLowerCase() !== live) throw new Error("combined status is not bound to the current head");
    const result = evaluateCiEvidence({ head: live, policy, checkRuns, statuses: combined.statuses });
    const after = readPrImpl({ repo, number: pr, fields: ["headRefOid"] });
    if (String(after.headRefOid).toLowerCase() !== live) {
      return { exitCode: 2, state: "CI_HEAD_MISMATCH", ...id, head: String(after.headRefOid).toLowerCase(), message: `PR head changed from ${live} while CI evidence was read` };
    }
    return { ...id, ...result };
  } catch (err) {
    return unverifiable(`required CI evidence could not be established: ${err.message}`);
  }
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const value = argv[++i];
    args[key] = value;
  }
  return args;
}

function hasTrustworthyExitCode(result) {
  return result !== null && typeof result === "object" && [0, 1, 2].includes(result.exitCode);
}

// Pure. The composed decision itself, factored out of `run` so a caller that has already
// computed stage1/lifecycle/(optionally) correctionDelta results elsewhere — specifically
// tools/orchestration/next-review-transition-gate.mjs's own pre-merge resolution — can reuse
// this *exact* authoritative combining logic instead of re-deriving an equivalent decision a
// second way (the P1 finding on PR #459: a second, parallel combination could silently
// diverge from what this documented script itself would report for the same evidence).
// `correctionDelta` is optional and, when present, is expected to already be
// stage1-correction-gate.mjs's `checkCorrectionDelta` result for this same reviewed/corrected
// head pair — this function does not fetch it itself.
export function combineMergeReadyResult({ stage1, lifecycle, correctionDelta = null, ci = null }, identifiers = {}) {
  const correctionSatisfied = !!(
    correctionDelta &&
    hasTrustworthyExitCode(correctionDelta) &&
    correctionDelta.exitCode === 0 &&
    correctionDelta.state === "CORRECTION_SATISFIED"
  );

  // A component that returns output this gate cannot trust (a missing/invalid exitCode —
  // e.g. an injected fake that returns undefined, or a future component bug) must never be
  // silently treated as passing. This is requirement #2's "a required underlying check
  // cannot execute or return a trustworthy result" clause.
  if (!hasTrustworthyExitCode(stage1) || !hasTrustworthyExitCode(lifecycle) || (correctionDelta && !hasTrustworthyExitCode(correctionDelta))) {
    return {
      exitCode: 1,
      state: "MALFORMED_GATE_OUTPUT",
      ...identifiers,
      stage1,
      lifecycle,
      ...(correctionDelta ? { correctionDelta } : {}),
      message:
        "One or both underlying gates returned output without a trustworthy exitCode (0, 1, or 2); " +
        "the composed pre-merge gate fails closed rather than assuming success.",
    };
  }

  // Operational failure in any component dominates: the composed result is untrustworthy,
  // not merely blocked, so this is reported distinctly from a normal BLOCKED state.
  if (stage1.exitCode === 1 || lifecycle.exitCode === 1 || (correctionDelta && correctionDelta.exitCode === 1)) {
    const messages = [];
    if (stage1.exitCode === 1) messages.push(`stage1-gate: ${stage1.message}`);
    if (lifecycle.exitCode === 1) messages.push(`lifecycle-gate merge-ready: ${lifecycle.message}`);
    if (correctionDelta && correctionDelta.exitCode === 1) messages.push(`stage1-correction-gate: ${correctionDelta.message}`);
    return {
      exitCode: 1,
      state: "OPERATIONAL_ERROR",
      ...identifiers,
      stage1,
      lifecycle,
      ...(correctionDelta ? { correctionDelta } : {}),
      message: messages.join(" | "),
    };
  }

  // Stage 1's leg is only still "blocking" here when a correction-satisfied delta did not
  // resolve it — a plain NOT_REQUESTED with no reviewed head supplied, or one whose
  // checkCorrectionDelta evidence itself came back HEAD_MISMATCH/NOT_SATISFIED, keeps
  // blocking exactly as before this change.
  const stage1Blocked = stage1.exitCode === 2 && !correctionSatisfied;

  if (stage1Blocked || lifecycle.exitCode === 2) {
    const blockedBy = [];
    if (stage1Blocked) blockedBy.push({ component: "stage1", state: stage1.state });
    if (lifecycle.exitCode === 2) blockedBy.push({ component: "lifecycle", state: lifecycle.state });
    return {
      exitCode: 2,
      state: "BLOCKED",
      blockedBy,
      ...identifiers,
      stage1,
      lifecycle,
      ...(correctionDelta ? { correctionDelta } : {}),
    };
  }

  // Issue #1129: every other leg would pass, so required-CI evidence for the exact head is now the
  // deciding prerequisite. Absent/untrustworthy evidence fails closed (never exit 0).
  const ciResult = (exitCode, state, extra) => ({
    exitCode,
    state,
    ...(exitCode === 2 ? { blockedBy: [{ component: "ci", state: ci.state }] } : {}),
    ...identifiers,
    stage1,
    lifecycle,
    ...(correctionDelta ? { correctionDelta } : {}),
    ci,
    ...extra,
  });
  if (!hasTrustworthyExitCode(ci)) {
    return ciResult(1, "MALFORMED_GATE_OUTPUT", {
      message: "Required CI evidence was not supplied (or lacks a trustworthy exitCode); the composed pre-merge gate fails closed.",
    });
  }
  if (ci.exitCode === 1) return ciResult(1, "OPERATIONAL_ERROR", { message: `required-ci: ${ci.message}` });
  if (ci.exitCode === 2) return ciResult(2, "BLOCKED", {});
  if (
    ci.state !== CI_PASS ||
    typeof ci.head !== "string" ||
    typeof identifiers.head !== "string" ||
    identifiers.head === "" ||
    !ci.head.toLowerCase().startsWith(identifiers.head.toLowerCase())
  ) {
    return ciResult(1, "MALFORMED_GATE_OUTPUT", {
      message: "Required CI evidence is not a CI_PASSED result bound to the gated head; the composed pre-merge gate fails closed.",
    });
  }

  const noWorkIssue = lifecycle.state === "MERGE_READY_NO_WORK_ISSUE";
  return {
    exitCode: 0,
    state: correctionSatisfied
      ? noWorkIssue
        ? "PRE_MERGE_READY_CORRECTION_SATISFIED_NO_WORK_ISSUE"
        : "PRE_MERGE_READY_CORRECTION_SATISFIED"
      : noWorkIssue
        ? "PRE_MERGE_READY_NO_WORK_ISSUE"
        : "PRE_MERGE_READY",
    ...identifiers,
    stage1,
    lifecycle,
    ...(correctionDelta ? { correctionDelta } : {}),
    ci,
  };
}

// `stage1RunImpl`/`checkMergeReadyImpl`/`checkCorrectionDeltaImpl` are injected so tests can
// drive `run` end-to-end against fakes for every component without touching the real network
// or `gh` CLI.
export async function run(
  args,
  { stage1RunImpl = runStage1, checkMergeReadyImpl = checkMergeReady, checkCorrectionDeltaImpl = checkCorrectionDelta, checkRequiredCiImpl = checkRequiredCi } = {},
) {
  const { repo, pr, head, issue } = args;
  const reviewedHead = args.reviewedHead ?? args["reviewed-head"] ?? null;
  const identifiers = { repo: repo ?? null, pr: pr ?? null, head: head ?? null, issue: issue ?? null };

  let stage1;
  try {
    stage1 = await stage1RunImpl({ repo, number: pr, head, ...(args.bot ? { bot: args.bot } : {}) });
  } catch (err) {
    stage1 = { exitCode: 1, message: `stage1-gate threw: ${err.message}` };
  }

  let lifecycle;
  try {
    lifecycle = await checkMergeReadyImpl({ repo, pr, issue });
  } catch (err) {
    lifecycle = { exitCode: 1, message: `lifecycle-gate merge-ready threw: ${err.message}` };
  }

  // Issue #454, Stage 1 review finding on PR #459 (the P1 finding): only ever attempted when
  // Stage 1's own leg is already blocked as NOT_REQUESTED at `head` (nothing to correct
  // otherwise) and the caller supplied `--reviewed-head` — no extra `gh` call on the common
  // (non-correction) path. Mirrors next-review-transition-gate.mjs's own
  // parseCorrectionSatisfiedDisposition-gated call to the same checkCorrectionDelta.
  let correctionDelta = null;
  if (hasTrustworthyExitCode(stage1) && stage1.exitCode === 2 && stage1.state === "NOT_REQUESTED" && reviewedHead) {
    try {
      correctionDelta = await checkCorrectionDeltaImpl({ repo, pr, reviewedHead, correctedHead: head, gatedHead: head });
    } catch (err) {
      correctionDelta = { exitCode: 1, message: `stage1-correction-gate threw: ${err.message}` };
    }
  }

  // Issue #1129: fetched only when the other legs would otherwise pass -- no extra `gh` calls on a
  // path already blocked/errored for a different reason.
  let ci = null;
  const otherLegsPass =
    hasTrustworthyExitCode(stage1) &&
    hasTrustworthyExitCode(lifecycle) &&
    lifecycle.exitCode === 0 &&
    (stage1.exitCode === 0 ||
      (stage1.exitCode === 2 && correctionDelta && correctionDelta.exitCode === 0 && correctionDelta.state === "CORRECTION_SATISFIED"));
  if (otherLegsPass) {
    try {
      ci = await checkRequiredCiImpl({ repo, pr, head });
    } catch (err) {
      ci = { exitCode: 1, state: "CI_UNVERIFIABLE", message: `required-ci threw: ${err.message}` };
    }
  }

  return combineMergeReadyResult({ stage1, lifecycle, correctionDelta, ci }, identifiers);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await run(args);
  if (result.exitCode === 1) {
    console.error(result.message ?? JSON.stringify(result));
  } else {
    console.log(JSON.stringify(result));
  }
  process.exit(result.exitCode);
}

// Only run as a CLI when invoked directly, not when the test file imports these functions.
if (process.argv[1] && process.argv[1].endsWith("merge-ready-gate.mjs")) {
  main();
}
