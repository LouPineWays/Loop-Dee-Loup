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
import { run, parseArgs } from "./merge-ready-gate.mjs";

const ARGS = { repo: "LouPineWays/YouTubery", pr: "49", head: "abc123", issue: "48" };

function stage1Result(overrides = {}) {
  return { exitCode: 0, state: "RESPONSE_RECEIVED", triggerTimestamp: "2026-08-20T00:00:00Z", ...overrides };
}

function lifecycleResult(overrides = {}) {
  return { exitCode: 0, state: "MERGE_READY", ...overrides };
}

function impls({ stage1 = stage1Result(), lifecycle = lifecycleResult() } = {}) {
  return {
    stage1RunImpl: async () => stage1,
    checkMergeReadyImpl: async () => lifecycle,
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

test("run: a successful Stage 1 result alone cannot be represented as the authoritative merge-ready result", async () => {
  // Stage 1 succeeds but lifecycle is blocked: the composed result must not be a success.
  const result = await run(
    ARGS,
    impls({ lifecycle: lifecycleResult({ exitCode: 2, state: "BLOCKED_CLOSING_REFERENCE", violations: [] }) }),
  );
  assert.notEqual(result.exitCode, 0);
  assert.notEqual(result.state, "PRE_MERGE_READY");
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
  });
  assert.equal(result.exitCode, 0);
  assert.equal(stage1Args.repo, ARGS.repo);
  assert.equal(stage1Args.number, ARGS.pr);
  assert.equal(stage1Args.head, ARGS.head);
  assert.equal(lifecycleArgs.repo, ARGS.repo);
  assert.equal(lifecycleArgs.pr, ARGS.pr);
  assert.equal(lifecycleArgs.issue, ARGS.issue);
});
