// Tests for tools/review-watch/merge-ready-gate.mjs. Both components (stage1-gate.mjs's
// `run` and lifecycle-gate.mjs's `checkMergeReady`) are faked via the injected
// `stage1RunImpl`/`checkMergeReadyImpl` options — never touch the real network or `gh` CLI
// here. Run with:
// node --test tools/review-watch/merge-ready-gate.test.mjs
//
// Covers issue #214's numbered verification list: the YouTubery PR #49/#48 regression shape
// (valid Stage 1 evidence plus a closing reference), every documented blocked/operational-
// error path, the explicit no-work-issue sentinel, and malformed-component fail-closed
// behavior.

import test from "node:test";
import assert from "node:assert/strict";
import {
  run,
  parseArgs,
  combineMergeReadyResult,
  checkRequiredCi,
  evaluateCiEvidence,
  readRequiredCheckPolicy,
} from "./merge-ready-gate.mjs";

const ARGS = { repo: "LouPineWays/YouTubery", pr: "49", head: "abc123", issue: "48" };

function stage1Result(overrides = {}) {
  return { exitCode: 0, state: "RESPONSE_RECEIVED", triggerTimestamp: "2026-08-20T00:00:00Z", ...overrides };
}

function lifecycleResult(overrides = {}) {
  return { exitCode: 0, state: "MERGE_READY", ...overrides };
}

// Issue #1129: merge authorization also requires required-CI evidence bound to the gated head;
// the legacy tests exercise OTHER legs, so a passing CI result is injected by default.
function passingCi(head = ARGS.head) {
  return { exitCode: 0, state: "CI_PASSED", head };
}

function impls({ stage1 = stage1Result(), lifecycle = lifecycleResult(), ci = passingCi() } = {}) {
  return {
    stage1RunImpl: async () => stage1,
    checkMergeReadyImpl: async () => lifecycle,
    checkRequiredCiImpl: async () => ci,
  };
}

// -- parseArgs ----------------------------------------------------------------------------

test("parseArgs: reads --repo/--pr/--head/--issue", () => {
  assert.deepEqual(parseArgs(["--repo", "o/r", "--pr", "5", "--head", "sha", "--issue", "9"]), {
    repo: "o/r",
    pr: "5",
    head: "sha",
    issue: "9",
  });
});

// -- success paths --------------------------------------------------------------------------

test("run: both components succeed -> PRE_MERGE_READY, exit 0", async () => {
  const result = await run(ARGS, impls());
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "PRE_MERGE_READY");
  assert.equal(result.repo, ARGS.repo);
  assert.equal(result.pr, ARGS.pr);
  assert.equal(result.head, ARGS.head);
  assert.equal(result.issue, ARGS.issue);
});

test("run: valid Stage 1 evidence plus only a non-closing reference (Addresses #48) can pass", async () => {
  const result = await run(
    ARGS,
    impls({ lifecycle: lifecycleResult({ state: "MERGE_READY" }) }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "PRE_MERGE_READY");
});

test("run: explicit --issue none reports PRE_MERGE_READY_NO_WORK_ISSUE while Stage 1 is still enforced", async () => {
  const result = await run(
    { ...ARGS, issue: "none" },
    impls({ lifecycle: lifecycleResult({ state: "MERGE_READY_NO_WORK_ISSUE", workIssue: null }) }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "PRE_MERGE_READY_NO_WORK_ISSUE");
});

// -- YouTubery #49/#48 regression shape and closing-reference variants ----------------------

test("run: valid Stage 1 evidence plus a PR-body Closes #48 reference (YouTubery #49/#48 regression) -> BLOCKED, never a successful result", async () => {
  const result = await run(
    ARGS,
    impls({
      lifecycle: lifecycleResult({
        exitCode: 2,
        state: "BLOCKED_CLOSING_REFERENCE",
        violations: [{ source: "closingIssuesReferences", detail: "PR carries a GitHub closing reference to issue #48." }],
      }),
    }),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED");
  assert.deepEqual(result.blockedBy, [{ component: "lifecycle", state: "BLOCKED_CLOSING_REFERENCE" }]);
  assert.equal(result.lifecycle.violations[0].source, "closingIssuesReferences");
});

test("run: valid Stage 1 evidence plus a Development-sidebar closing reference -> BLOCKED", async () => {
  // Both a PR-body closing keyword and a Development-sidebar link surface through the same
  // closingIssuesReferences field (see lifecycle-gate.mjs's own comment on that field's
  // coverage), so this exercises the same BLOCKED_CLOSING_REFERENCE path as the PR-body case.
  const result = await run(
    ARGS,
    impls({
      lifecycle: lifecycleResult({
        exitCode: 2,
        state: "BLOCKED_CLOSING_REFERENCE",
        violations: [{ source: "closingIssuesReferences", detail: "Development-sidebar closing link to issue #48." }],
      }),
    }),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED");
});

test("run: valid Stage 1 evidence plus a relevant commit-message closing keyword -> BLOCKED", async () => {
  const result = await run(
    ARGS,
    impls({
      lifecycle: lifecycleResult({
        exitCode: 2,
        state: "BLOCKED_CLOSING_REFERENCE",
        violations: [{ source: "commit:deadbeef", detail: 'Commit message contains a closing keyword for issue #48: "Fixes #48".' }],
      }),
    }),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED");
});

// -- Stage 1 blocking states ------------------------------------------------------------

test("run: missing Stage 1 trigger (NOT_REQUESTED) blocks before merge-ready, regardless of lifecycle result", async () => {
  const result = await run(ARGS, impls({ stage1: stage1Result({ exitCode: 2, state: "NOT_REQUESTED" }) }));
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED");
  assert.deepEqual(result.blockedBy, [{ component: "stage1", state: "NOT_REQUESTED" }]);
});

test("run: Stage 1 trigger with no genuine response (PENDING) is non-zero", async () => {
  const result = await run(ARGS, impls({ stage1: stage1Result({ exitCode: 2, state: "PENDING" }) }));
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED");
});

// Issue #616: a PR that self-declares a `Stage 1 exemption:` marker conflicting with a
// mandatory-review control-plane path never reaches stage1-gate.mjs's EXEMPT state — it
// falls through to the ordinary NOT_REQUESTED/PENDING/RESPONSE_RECEIVED evaluation instead,
// carrying a `rejectedExemption` field (see stage1-gate.test.mjs for that component's own
// coverage). This composed-gate regression proves the #615-shaped PR (docs/diagnostic-
// traces/*.md changed, self-declared exemption) still cannot become PRE_MERGE_READY through
// that rejected marker: the same NOT_REQUESTED/PENDING component states that already block
// an ordinary un-exempted PR block this one too, and merge-ready-gate.mjs needs no special-
// casing of `rejectedExemption` itself to enforce that — it never looks at that field.
test("run: a #615-shaped rejected exemption (NOT_REQUESTED with rejectedExemption) still blocks composed pre-merge readiness", async () => {
  const rejectedExemptionStage1 = stage1Result({
    exitCode: 2,
    state: "NOT_REQUESTED",
    rejectedExemption: {
      reason: "evidence-only diagnostic trace, not review-worthy.",
      conflictingPaths: ["docs/diagnostic-traces/441-a.md"],
    },
  });
  const result = await run(ARGS, impls({ stage1: rejectedExemptionStage1 }));
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED");
  assert.deepEqual(result.blockedBy, [{ component: "stage1", state: "NOT_REQUESTED" }]);
  assert.notEqual(result.state, "PRE_MERGE_READY");
});

test("run: a successful Stage 1 result alone cannot be represented as the authoritative merge-ready result", async () => {
  // Stage 1 succeeds but lifecycle is blocked: the composed result must not be a success.
  const result = await run(
    ARGS,
    impls({ lifecycle: lifecycleResult({ exitCode: 2, state: "BLOCKED_CLOSING_REFERENCE", violations: [] }) }),
  );
  assert.notEqual(result.exitCode, 0);
  assert.notEqual(result.state, "PRE_MERGE_READY");
});

// -- correction-satisfied heads (issue #454, Stage 1 review finding on PR #459) -------------
//
// P1 finding: the corrected-head verdict previously authorized merge via
// next-review-transition-gate.mjs's own private composition without this documented
// authoritative command (docs/bounded-review-cycle.md step 8/10) ever being able to agree.
// These tests drive `--reviewed-head` end-to-end through this script's own composed result.

function correctionImpls({ stage1 = stage1Result({ exitCode: 2, state: "NOT_REQUESTED" }), lifecycle = lifecycleResult(), correctionDelta } = {}) {
  return {
    stage1RunImpl: async () => stage1,
    checkMergeReadyImpl: async () => lifecycle,
    checkCorrectionDeltaImpl: async () => correctionDelta,
    checkRequiredCiImpl: async () => passingCi(),
  };
}

test("run: NOT_REQUESTED stage1 + CORRECTION_SATISFIED delta + MERGE_READY lifecycle -> PRE_MERGE_READY_CORRECTION_SATISFIED, exit 0", async () => {
  const result = await run(
    { ...ARGS, reviewedHead: "reviewed-sha" },
    correctionImpls({ correctionDelta: { exitCode: 0, state: "CORRECTION_SATISFIED", reviewedHead: "reviewed-sha", correctedHead: ARGS.head } }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "PRE_MERGE_READY_CORRECTION_SATISFIED");
  assert.equal(result.correctionDelta.state, "CORRECTION_SATISFIED");
});

test("run: NOT_REQUESTED stage1 + CORRECTION_SATISFIED delta + MERGE_READY_NO_WORK_ISSUE lifecycle -> PRE_MERGE_READY_CORRECTION_SATISFIED_NO_WORK_ISSUE", async () => {
  const result = await run(
    { ...ARGS, reviewedHead: "reviewed-sha" },
    correctionImpls({
      lifecycle: lifecycleResult({ state: "MERGE_READY_NO_WORK_ISSUE" }),
      correctionDelta: { exitCode: 0, state: "CORRECTION_SATISFIED" },
    }),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "PRE_MERGE_READY_CORRECTION_SATISFIED_NO_WORK_ISSUE");
});

test("run: NOT_REQUESTED stage1 + CORRECTION_SATISFIED delta but lifecycle still BLOCKED_CLOSING_REFERENCE -> BLOCKED naming only the lifecycle component", async () => {
  const result = await run(
    { ...ARGS, reviewedHead: "reviewed-sha" },
    correctionImpls({
      lifecycle: lifecycleResult({ exitCode: 2, state: "BLOCKED_CLOSING_REFERENCE" }),
      correctionDelta: { exitCode: 0, state: "CORRECTION_SATISFIED" },
    }),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED");
  assert.deepEqual(result.blockedBy, [{ component: "lifecycle", state: "BLOCKED_CLOSING_REFERENCE" }]);
});

test("run: NOT_REQUESTED stage1 + HEAD_MISMATCH correction delta stays BLOCKED on stage1, unchanged from the no-correction case", async () => {
  const result = await run(
    { ...ARGS, reviewedHead: "reviewed-sha" },
    correctionImpls({ correctionDelta: { exitCode: 2, state: "HEAD_MISMATCH" } }),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED");
  assert.deepEqual(result.blockedBy, [{ component: "stage1", state: "NOT_REQUESTED" }]);
});

test("run: NOT_REQUESTED stage1 + NOT_SATISFIED correction delta stays BLOCKED on stage1", async () => {
  const result = await run(
    { ...ARGS, reviewedHead: "reviewed-sha" },
    correctionImpls({ correctionDelta: { exitCode: 2, state: "NOT_SATISFIED", reason: "no findings-bearing match" } }),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED");
  assert.deepEqual(result.blockedBy, [{ component: "stage1", state: "NOT_REQUESTED" }]);
});

test("run: an operational error from checkCorrectionDeltaImpl is reported as OPERATIONAL_ERROR, not silently BLOCKED", async () => {
  const result = await run(
    { ...ARGS, reviewedHead: "reviewed-sha" },
    correctionImpls({ correctionDelta: { exitCode: 1, message: "compare failed" } }),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.state, "OPERATIONAL_ERROR");
  assert.match(result.message, /stage1-correction-gate/);
  assert.match(result.message, /compare failed/);
});

test("run: no --reviewed-head supplied never invokes checkCorrectionDeltaImpl, even when stage1 is NOT_REQUESTED (no wasted gh call on the common path)", async () => {
  let called = false;
  const result = await run(ARGS, {
    stage1RunImpl: async () => stage1Result({ exitCode: 2, state: "NOT_REQUESTED" }),
    checkMergeReadyImpl: async () => lifecycleResult(),
    checkCorrectionDeltaImpl: async () => {
      called = true;
      return { exitCode: 0, state: "CORRECTION_SATISFIED" };
    },
  });
  assert.equal(called, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED");
});

test("run: --reviewed-head is never consulted when stage1 already succeeds (RESPONSE_RECEIVED)", async () => {
  let called = false;
  const result = await run(
    { ...ARGS, reviewedHead: "reviewed-sha" },
    {
      stage1RunImpl: async () => stage1Result(),
      checkMergeReadyImpl: async () => lifecycleResult(),
      checkRequiredCiImpl: async () => passingCi(),
      checkCorrectionDeltaImpl: async () => {
        called = true;
        return { exitCode: 0, state: "CORRECTION_SATISFIED" };
      },
    },
  );
  assert.equal(called, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "PRE_MERGE_READY");
});

// -- operational failures -----------------------------------------------------------------

test("run: an accidentally omitted work issue fails closed as an operational error, not 'none'", async () => {
  const { issue, ...withoutIssue } = ARGS;
  const result = await run(
    withoutIssue,
    impls({
      lifecycle: {
        exitCode: 1,
        message: 'Missing or invalid required args: --repo, --pr are required, and --issue must be a positive integer.',
      },
    }),
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.state, "OPERATIONAL_ERROR");
  assert.match(result.message, /lifecycle-gate merge-ready/);
});

test("run: a gh failure inside stage1-gate propagates as an operational error", async () => {
  const result = await run(ARGS, {
    stage1RunImpl: async () => {
      throw new Error("gh api call failed");
    },
    checkMergeReadyImpl: async () => lifecycleResult(),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.state, "OPERATIONAL_ERROR");
  assert.match(result.message, /stage1-gate/);
  assert.match(result.message, /gh api call failed/);
});

test("run: operational error dominates a simultaneous blocked state in the other component", async () => {
  const result = await run(ARGS, {
    stage1RunImpl: async () => stage1Result({ exitCode: 2, state: "PENDING" }),
    checkMergeReadyImpl: async () => ({ exitCode: 1, message: "gh pr view failed" }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.state, "OPERATIONAL_ERROR");
});

// -- malformed component output ------------------------------------------------------------

test("run: malformed output (no exitCode) from a component fails closed rather than being treated as a pass", async () => {
  const result = await run(ARGS, {
    stage1RunImpl: async () => ({ state: "RESPONSE_RECEIVED" }), // no exitCode
    checkMergeReadyImpl: async () => lifecycleResult(),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.state, "MALFORMED_GATE_OUTPUT");
});

test("run: undefined component output fails closed", async () => {
  const result = await run(ARGS, {
    stage1RunImpl: async () => stage1Result(),
    checkMergeReadyImpl: async () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.state, "MALFORMED_GATE_OUTPUT");
});

// -- identifiers and argument mapping -------------------------------------------------------

test("run: records the repository, PR, frozen head, and work issue evaluated even on a blocked result", async () => {
  const result = await run(ARGS, impls({ stage1: stage1Result({ exitCode: 2, state: "NOT_REQUESTED" }) }));
  assert.equal(result.repo, ARGS.repo);
  assert.equal(result.pr, ARGS.pr);
  assert.equal(result.head, ARGS.head);
  assert.equal(result.issue, ARGS.issue);
});

test("run: maps --pr to stage1-gate's --number and passes --head/--issue to the right component", async () => {
  let stage1Args;
  let lifecycleArgs;
  const result = await run(ARGS, {
    stage1RunImpl: async (args) => {
      stage1Args = args;
      return stage1Result();
    },
    checkMergeReadyImpl: async (args) => {
      lifecycleArgs = args;
      return lifecycleResult();
    },
    checkRequiredCiImpl: async () => passingCi(),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(stage1Args.repo, ARGS.repo);
  assert.equal(stage1Args.number, ARGS.pr);
  assert.equal(stage1Args.head, ARGS.head);
  assert.equal(lifecycleArgs.repo, ARGS.repo);
  assert.equal(lifecycleArgs.pr, ARGS.pr);
  assert.equal(lifecycleArgs.issue, ARGS.issue);
});

// -- Issue #1129: exact-head required CI/check evidence --------------------------------------------

const H = "af52e922c2e4839cb1f6ae0dabcd91faaf2b5ad5";
const FAILED_H = "dcbfe19591931eac29038deac510acfcfc76b0df";

test("run: CI failed on the gated head -> BLOCKED by ci, never exit 0 (the #951/#950/PR #952 dcbfe195 shape)", async () => {
  const result = await run(
    { ...ARGS, head: FAILED_H },
    impls({ ci: { exitCode: 2, state: "CI_FAILED", head: FAILED_H, message: "required CI failed" } }),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED");
  assert.deepEqual(result.blockedBy, [{ component: "ci", state: "CI_FAILED" }]);
});

test("run: CI pending, missing and head-mismatch are all BLOCKED by ci", async () => {
  for (const state of ["CI_PENDING", "CI_REQUIRED_CHECK_MISSING", "CI_HEAD_MISMATCH"]) {
    const result = await run(ARGS, impls({ ci: { exitCode: 2, state, head: ARGS.head } }));
    assert.equal(result.exitCode, 2, state);
    assert.deepEqual(result.blockedBy, [{ component: "ci", state }]);
  }
});

test("run: unreadable/ambiguous CI evidence is OPERATIONAL_ERROR (exit 1), never success", async () => {
  const result = await run(ARGS, impls({ ci: { exitCode: 1, state: "CI_UNVERIFIABLE", message: "HTTP 403" } }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.state, "OPERATIONAL_ERROR");
  assert.match(result.message, /HTTP 403/);
});

test("run: a throwing CI check is OPERATIONAL_ERROR", async () => {
  const result = await run(ARGS, { ...impls(), checkRequiredCiImpl: async () => { throw new Error("boom"); } });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /boom/);
});

test("run: CI_PASSED bound to a different head than the gated head fails closed (older-head green)", async () => {
  const result = await run(ARGS, impls({ ci: { exitCode: 0, state: "CI_PASSED", head: "0000000000000000000000000000000000000000" } }));
  assert.equal(result.exitCode, 1);
  assert.equal(result.state, "MALFORMED_GATE_OUTPUT");
});

test("run: CI is not consulted when another leg already blocks (no wasted gh call)", async () => {
  let called = false;
  const result = await run(ARGS, {
    ...impls({ stage1: stage1Result({ exitCode: 2, state: "PENDING" }) }),
    checkRequiredCiImpl: async () => { called = true; return passingCi(); },
  });
  assert.equal(called, false);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.blockedBy, [{ component: "stage1", state: "PENDING" }]);
});

test("combineMergeReadyResult: absent CI evidence can never yield exit 0", () => {
  const result = combineMergeReadyResult({ stage1: stage1Result(), lifecycle: lifecycleResult() }, { head: H });
  assert.equal(result.exitCode, 1);
  assert.equal(result.state, "MALFORMED_GATE_OUTPUT");
});

test("combineMergeReadyResult: correction-satisfied path also requires passing CI", () => {
  const input = {
    stage1: stage1Result({ exitCode: 2, state: "NOT_REQUESTED" }),
    lifecycle: lifecycleResult(),
    correctionDelta: { exitCode: 0, state: "CORRECTION_SATISFIED" },
  };
  const blocked = combineMergeReadyResult({ ...input, ci: { exitCode: 2, state: "CI_FAILED", head: FAILED_H } }, { head: FAILED_H });
  assert.equal(blocked.exitCode, 2);
  const ok = combineMergeReadyResult({ ...input, ci: { exitCode: 0, state: "CI_PASSED", head: H } }, { head: H });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.state, "PRE_MERGE_READY_CORRECTION_SATISFIED");
});

// -- checkRequiredCi / evaluateCiEvidence / readRequiredCheckPolicy -----------------------------

const UNPROTECTED = { protected: false };
function runOf(name, conclusion, { status = "completed", sha = H, appId = 15368 } = {}) {
  return { name, status, conclusion, head_sha: sha, app: { id: appId } };
}
function fakeGh({ branch = UNPROTECTED, rules = [], runs = [], statuses = [], sha = H, extra = {} } = {}) {
  const calls = [];
  const impl = (path, opts = {}) => {
    calls.push(path);
    if (extra[path]) return typeof extra[path] === "function" ? extra[path]() : extra[path];
    if (/\/rules\/branches\//.test(path)) return rules;
    if (/\/branches\/[^/]+$/.test(path)) return branch;
    if (/\/check-runs/.test(path)) return opts.paginate ? [{ total_count: runs.length, check_runs: runs }] : { total_count: runs.length, check_runs: runs };
    if (/\/status\?/.test(path)) return { state: "success", total_count: statuses.length, sha, statuses };
    throw new Error("unexpected path " + path);
  };
  impl.calls = calls;
  return impl;
}
function prReader(heads) {
  let i = 0;
  return ({ fields }) => {
    const head = heads[Math.min(i++, heads.length - 1)];
    const out = {};
    for (const f of fields) out[f] = f === "headRefOid" ? head : f === "baseRefName" ? "main" : "OPEN";
    return out;
  };
}
const CI_ARGS = { repo: "o/r", pr: "952", head: H };

test("checkRequiredCi: all observed checks green on the current head, no declared policy -> CI_PASSED (the af52e922 / run 37626653304 positive case)", async () => {
  const result = await checkRequiredCi(CI_ARGS, { ghApiImpl: fakeGh({ runs: [runOf("verify", "success")] }), readPrImpl: prReader([H, H]) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "CI_PASSED");
  assert.equal(result.head, H);
  assert.equal(result.policy.source, "none-declared");
});

test("checkRequiredCi: a failed run on the current head -> CI_FAILED exit 2 (the dcbfe195 / run 37624396190 shape)", async () => {
  const result = await checkRequiredCi(
    { ...CI_ARGS, head: FAILED_H },
    { ghApiImpl: fakeGh({ runs: [runOf("verify", "failure", { sha: FAILED_H })] }), readPrImpl: prReader([FAILED_H]) },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CI_FAILED");
  assert.equal(result.blocking[0].name, "verify");
});

test("checkRequiredCi: pending (in_progress/queued) checks -> CI_PENDING, not success", async () => {
  for (const status of ["in_progress", "queued"]) {
    const result = await checkRequiredCi(CI_ARGS, {
      ghApiImpl: fakeGh({ runs: [runOf("verify", null, { status })] }),
      readPrImpl: prReader([H]),
    });
    assert.equal(result.state, "CI_PENDING", status);
    assert.equal(result.exitCode, 2);
  }
});

test("checkRequiredCi: checks that are green only on an OLDER head never authorize the newer head (check-run head_sha mismatch fails closed)", async () => {
  const result = await checkRequiredCi(CI_ARGS, {
    ghApiImpl: fakeGh({ runs: [runOf("verify", "success", { sha: FAILED_H })] }),
    readPrImpl: prReader([H]),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.state, "CI_UNVERIFIABLE");
});

test("checkRequiredCi: the PR head differing from the decided head -> CI_HEAD_MISMATCH exit 2 (a newer green head cannot authorize an older decision)", async () => {
  const result = await checkRequiredCi(
    { ...CI_ARGS, head: FAILED_H },
    { ghApiImpl: fakeGh({ runs: [runOf("verify", "success")] }), readPrImpl: prReader([H]) },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CI_HEAD_MISMATCH");
});

test("checkRequiredCi: the PR head changing while evidence is read -> CI_HEAD_MISMATCH", async () => {
  const result = await checkRequiredCi(CI_ARGS, {
    ghApiImpl: fakeGh({ runs: [runOf("verify", "success")] }),
    readPrImpl: prReader([H, FAILED_H]),
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CI_HEAD_MISMATCH");
});

test("checkRequiredCi: a short abbreviated decided head still binds to the full live head", async () => {
  const result = await checkRequiredCi(
    { ...CI_ARGS, head: H.slice(0, 10) },
    { ghApiImpl: fakeGh({ runs: [runOf("verify", "success")] }), readPrImpl: prReader([H]) },
  );
  assert.equal(result.state, "CI_PASSED");
  assert.equal(result.head, H);
});

test("checkRequiredCi: declared required checks -- missing context -> CI_REQUIRED_CHECK_MISSING; skipped does not satisfy; success does", async () => {
  const protectedBranch = { protected: true, protection: { required_status_checks: { enforcement_level: "everyone", contexts: ["verify"], checks: [{ context: "verify", app_id: 15368 }] } } };
  const missing = await checkRequiredCi(CI_ARGS, { ghApiImpl: fakeGh({ branch: protectedBranch, runs: [runOf("other", "success")] }), readPrImpl: prReader([H]) });
  assert.equal(missing.state, "CI_REQUIRED_CHECK_MISSING");
  assert.deepEqual(missing.missing, ["verify"]);
  const skipped = await checkRequiredCi(CI_ARGS, { ghApiImpl: fakeGh({ branch: protectedBranch, runs: [runOf("verify", "skipped")] }), readPrImpl: prReader([H]) });
  assert.equal(skipped.exitCode, 2);
  assert.equal(skipped.state, "CI_FAILED");
  const ok = await checkRequiredCi(CI_ARGS, { ghApiImpl: fakeGh({ branch: protectedBranch, runs: [runOf("verify", "success"), runOf("flaky-optional", "failure")] }), readPrImpl: prReader([H]) });
  assert.equal(ok.state, "CI_PASSED");
  assert.equal(ok.policy.source, "branch-protection");
  const wrongApp = await checkRequiredCi(CI_ARGS, { ghApiImpl: fakeGh({ branch: protectedBranch, runs: [runOf("verify", "success", { appId: 1 })] }), readPrImpl: prReader([H]) });
  assert.equal(wrongApp.state, "CI_REQUIRED_CHECK_MISSING");
});

test("checkRequiredCi: ruleset required_status_checks are honored", async () => {
  const rules = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "verify", integration_id: 15368 }] } }];
  const result = await checkRequiredCi(CI_ARGS, { ghApiImpl: fakeGh({ rules, runs: [] }), readPrImpl: prReader([H]) });
  assert.equal(result.state, "CI_REQUIRED_CHECK_MISSING");
});

test("checkRequiredCi: conflicting duplicate runs for one context (success + failure) -> CI_FAILED", async () => {
  const result = await checkRequiredCi(CI_ARGS, {
    ghApiImpl: fakeGh({ runs: [runOf("verify", "success"), runOf("verify", "failure", { appId: 99 })] }),
    readPrImpl: prReader([H]),
  });
  assert.equal(result.state, "CI_FAILED");
});

test("checkRequiredCi: a failing legacy commit status blocks; pending status -> CI_PENDING", async () => {
  const failing = await checkRequiredCi(CI_ARGS, { ghApiImpl: fakeGh({ statuses: [{ context: "ci/legacy", state: "failure" }] }), readPrImpl: prReader([H]) });
  assert.equal(failing.state, "CI_FAILED");
  const pending = await checkRequiredCi(CI_ARGS, { ghApiImpl: fakeGh({ statuses: [{ context: "ci/legacy", state: "pending" }] }), readPrImpl: prReader([H]) });
  assert.equal(pending.state, "CI_PENDING");
});

test("checkRequiredCi: unreadable/ambiguous evidence fails closed to exit 1", async () => {
  const cases = {
    "policy 403": fakeGh({ extra: { "repos/o/r/branches/main": () => { throw new Error("HTTP 403"); } } }),
    "branch summary without boolean protected": fakeGh({ branch: {} }),
    "rules not an array": fakeGh({ rules: {} }),
    "unrecognized conclusion": fakeGh({ runs: [runOf("verify", "mystery")] }),
    "truncated check-run list": fakeGh({ extra: { [`repos/o/r/commits/${H}/check-runs?per_page=100&filter=latest`]: [{ total_count: 5, check_runs: [runOf("verify", "success")] }] } }),
    "truncated status list": fakeGh({ extra: { [`repos/o/r/commits/${H}/status?per_page=100`]: { total_count: 3, sha: H, statuses: [] } } }),
    "malformed check run": fakeGh({ runs: [{ nope: true }] }),
  };
  for (const [label, ghApiImpl] of Object.entries(cases)) {
    const result = await checkRequiredCi(CI_ARGS, { ghApiImpl, readPrImpl: prReader([H]) });
    assert.equal(result.exitCode, 1, label);
    assert.equal(result.state, "CI_UNVERIFIABLE", label);
  }
  const closed = await checkRequiredCi(CI_ARGS, { ghApiImpl: fakeGh(), readPrImpl: ({ fields }) => ({ headRefOid: H, baseRefName: "main", state: "MERGED" }) });
  assert.equal(closed.exitCode, 1);
  const noHead = await checkRequiredCi({ repo: "o/r", pr: "1", head: "not-a-sha" }, { ghApiImpl: fakeGh(), readPrImpl: prReader([H]) });
  assert.equal(noHead.exitCode, 1);
});

test("readRequiredCheckPolicy: protected branch lacking a readable summary falls back to the dedicated endpoint; 'not enabled' 404 means none; other errors throw", () => {
  const dedicatedPath = "repos/o/r/branches/main/protection/required_status_checks";
  const policy = readRequiredCheckPolicy(
    { repo: "o/r", base: "main" },
    { ghApiImpl: fakeGh({ branch: { protected: true }, extra: { [dedicatedPath]: { contexts: ["verify"] } } }) },
  );
  assert.deepEqual(policy.required, [{ context: "verify", appId: null }]);
  const e404 = () => { const e = new Error("gh api failed"); e.ghStderr = "gh: Required status checks not enabled (HTTP 404)"; throw e; };
  const none = readRequiredCheckPolicy({ repo: "o/r", base: "main" }, { ghApiImpl: fakeGh({ branch: { protected: true }, extra: { [dedicatedPath]: e404 } }) });
  assert.deepEqual(none, { required: [], source: "none-declared" });
  const e404other = () => { const e = new Error("gh api failed"); e.ghStderr = "gh: Not Found (HTTP 404)"; throw e; };
  assert.throws(() => readRequiredCheckPolicy({ repo: "o/r", base: "main" }, { ghApiImpl: fakeGh({ branch: { protected: true }, extra: { [dedicatedPath]: e404other } }) }));
});

test("evaluateCiEvidence: no declared policy, zero observed checks -> CI_PASSED with observed 0 (nothing is required; recorded explicitly)", () => {
  const result = evaluateCiEvidence({ head: H, policy: { required: [], source: "none-declared" }, checkRuns: [], statuses: [] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.observed, 0);
});
