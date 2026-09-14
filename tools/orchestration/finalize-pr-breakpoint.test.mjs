// Tests for tools/orchestration/finalize-pr-breakpoint.mjs — issue #456 unit 456-A's
// deterministic PR/Stage-1 breakpoint finalize step.
//
// Run with:
//   node --test tools/orchestration/finalize-pr-breakpoint.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  run,
  verifyExecutionMatches,
  determineStage1Value,
  composeFinalizedControlBody,
  verifyFinalizedBody,
} from "./finalize-pr-breakpoint.mjs";

const READY_BODY = `## Current state

- **Lifecycle:** READY
- **Execution:** #447
- **Route:** implementation worker
- **PR:** none
- **Stage 1:** none
- **Blocker:** none
- **Founder decision:** none
`;

const EXECUTION_COMPLETE_BODY = `## Current state

- **Lifecycle:** EXECUTION_COMPLETE
- **Execution:** #537
- **Route:** stronger/general worker
- **PR:** none
- **Stage 1:** none
- **Blocker:** none
- **Founder decision:** none
`;

// -- Pure helpers --------------------------------------------------------------------------

test("verifyExecutionMatches: accepts a control body whose Execution pointer names the given execution Issue", () => {
  const result = verifyExecutionMatches(READY_BODY, 447);
  assert.equal(result.ok, true);
});

test("verifyExecutionMatches: rejects a mismatched Execution pointer — never finalize against the wrong control Issue", () => {
  const result = verifyExecutionMatches(READY_BODY, 999);
  assert.equal(result.ok, false);
  assert.match(result.reason, /names #447, not the given --execution-issue #999/);
});

test("verifyExecutionMatches: rejects a control body with no Execution bullet at all", () => {
  const result = verifyExecutionMatches("- **Lifecycle:** READY\n", 447);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no Execution\/Execution issue bullet/);
});

test("determineStage1Value: EXEMPT carries the recorded exemption reason verbatim", () => {
  const result = determineStage1Value({ exitCode: 0, state: "EXEMPT", reason: "docs typo fix, not review-worthy" });
  assert.deepEqual(result, { ok: true, value: "exempt: docs typo fix, not review-worthy" });
});

test("determineStage1Value: PENDING and RESPONSE_RECEIVED both resolve to \"requested\"", () => {
  assert.deepEqual(determineStage1Value({ exitCode: 2, state: "PENDING" }), { ok: true, value: "requested" });
  assert.deepEqual(determineStage1Value({ exitCode: 0, state: "RESPONSE_RECEIVED" }), { ok: true, value: "requested" });
});

test("determineStage1Value: NOT_REQUESTED fails closed — the caller's claim that Stage 1 was requested is not backed by evidence", () => {
  const result = determineStage1Value({ exitCode: 2, state: "NOT_REQUESTED" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /NOT_REQUESTED/);
});

test("determineStage1Value: an operational stage1-gate failure also fails closed", () => {
  const result = determineStage1Value({ exitCode: 1, message: "gh pr view failed" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /gh pr view failed/);
});

test("composeFinalizedControlBody: from READY, sets PR/Stage 1/Lifecycle and leaves every other field untouched", () => {
  const result = composeFinalizedControlBody(READY_BODY, { pr: 453, stage1Value: "requested" });
  assert.equal(result.ok, true);
  assert.match(result.body, /- \*\*PR:\*\* #453/);
  assert.match(result.body, /- \*\*Stage 1:\*\* requested/);
  assert.match(result.body, /- \*\*Lifecycle:\*\* REVIEW/);
  assert.match(result.body, /- \*\*Execution:\*\* #447/);
  assert.match(result.body, /- \*\*Route:\*\* implementation worker/);
  assert.match(result.body, /- \*\*Blocker:\*\* none/);
  assert.match(result.body, /- \*\*Founder decision:\*\* none/);
});

test("composeFinalizedControlBody: from EXECUTION_COMPLETE (Integration/PR worker route), also transitions to REVIEW", () => {
  const result = composeFinalizedControlBody(EXECUTION_COMPLETE_BODY, { pr: 540, stage1Value: "requested" });
  assert.equal(result.ok, true);
  assert.match(result.body, /- \*\*Lifecycle:\*\* REVIEW/);
  assert.match(result.body, /- \*\*PR:\*\* #540/);
});

test("composeFinalizedControlBody: re-running against an already-finalized REVIEW body is a safe no-op (idempotence)", () => {
  const alreadyFinalized = READY_BODY.replace("- **Lifecycle:** READY", "- **Lifecycle:** REVIEW").replace("- **PR:** none", "- **PR:** #453").replace("- **Stage 1:** none", "- **Stage 1:** requested");
  const result = composeFinalizedControlBody(alreadyFinalized, { pr: 453, stage1Value: "requested" });
  assert.equal(result.ok, true);
  assert.equal(result.body, alreadyFinalized);
});

test("composeFinalizedControlBody: refuses to overwrite a Lifecycle value it was not authorized to transition from (e.g. mid-cycle AUDIT)", () => {
  const auditBody = READY_BODY.replace("- **Lifecycle:** READY", "- **Lifecycle:** AUDIT");
  const result = composeFinalizedControlBody(auditBody, { pr: 453, stage1Value: "requested" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not one of the recognized pre-finalize values/);
});

test("verifyFinalizedBody: accepts a fresh body carrying the exact composed bullets", () => {
  const composed = composeFinalizedControlBody(READY_BODY, { pr: 453, stage1Value: "requested" });
  const result = verifyFinalizedBody(composed.body, { pr: 453, stage1Value: "requested" });
  assert.equal(result.ok, true);
});

test("verifyFinalizedBody: rejects a fresh read-back that does not actually carry the PR bullet just composed (e.g. the gh write silently no-oped)", () => {
  const result = verifyFinalizedBody(READY_BODY, { pr: 453, stage1Value: "requested" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /PR bullet/);
});

// -- run(): end-to-end with injected implementations ----------------------------------------

function makeStage1GateStub(result) {
  return async () => result;
}

test("run(): Verification scenario 4 — normal direct-worker PR creation persists PR+Stage1+Lifecycle, verified by a fresh read-back", async () => {
  let currentBody = READY_BODY;
  const writeCalls = [];
  const result = await run(
    { repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" },
    {
      ghIssueViewImpl: async () => currentBody,
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 2, state: "PENDING", triggerTimestamp: "2026-01-01T00:00:00Z" }),
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        writeCalls.push(proposedBody);
        currentBody = proposedBody; // simulate the durable write actually landing
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "FINALIZED");
  assert.equal(result.message, "FINALIZED 448 447 453");
  assert.equal(writeCalls.length, 1);
  assert.match(writeCalls[0], /- \*\*PR:\*\* #453/);
  assert.match(writeCalls[0], /- \*\*Stage 1:\*\* requested/);
  assert.match(writeCalls[0], /- \*\*Lifecycle:\*\* REVIEW/);
});

test("run(): a recorded Stage 1 exemption is persisted verbatim from durable PR-body evidence, not from the caller's own claim", async () => {
  let currentBody = EXECUTION_COMPLETE_BODY;
  const result = await run(
    { repo: "owner/repo", controlIssue: 539, executionIssue: 537, pr: 540, head: "6dc93ac" },
    {
      ghIssueViewImpl: async () => currentBody,
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 0, state: "EXEMPT", reason: "consumer-sync PR, not review-worthy" }),
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        currentBody = proposedBody;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stage1, "exempt: consumer-sync PR, not review-worthy");
  assert.match(currentBody, /- \*\*Stage 1:\*\* exempt: consumer-sync PR, not review-worthy/);
});

test("run(): Verification scenario 5 — a control-write failure fails closed with PR_BREAKPOINT_UNVERIFIED, control body left unchanged", async () => {
  const originalBody = READY_BODY;
  let currentBody = originalBody;
  const result = await run(
    { repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" },
    {
      ghIssueViewImpl: async () => currentBody,
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 2, state: "PENDING" }),
      writeControlSnapshotImpl: async () => ({ exitCode: 2, state: "REJECTED", errors: ["simulated validation rejection"] }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PR_BREAKPOINT_UNVERIFIED");
  assert.equal(result.message, "PR_BREAKPOINT_UNVERIFIED 448 447 453");
  assert.equal(currentBody, originalBody, "the durable control body must be left exactly as it was on a write failure");
});

test("run(): a caller claiming the PR crossed the breakpoint when no Stage 1 trigger actually exists fails closed, never reporting ordinary success", async () => {
  let writeAttempted = false;
  const result = await run(
    { repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" },
    {
      ghIssueViewImpl: async () => READY_BODY,
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 2, state: "NOT_REQUESTED" }),
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PR_BREAKPOINT_UNVERIFIED");
  assert.equal(writeAttempted, false, "NOT_REQUESTED must be caught before any write is even attempted");
});

test("run(): Verification scenario 6 — idempotence: repeated finalize against the same PR/head does not corrupt the control body or re-trigger anything", async () => {
  let currentBody = READY_BODY;
  const stage1Calls = [];
  const deps = {
    ghIssueViewImpl: async () => currentBody,
    stage1GateRunImpl: async (args) => {
      stage1Calls.push(args);
      return { exitCode: 2, state: "PENDING" };
    },
    writeControlSnapshotImpl: async ({ proposedBody }) => {
      currentBody = proposedBody;
      return { exitCode: 0, state: "WRITTEN" };
    },
  };
  const first = await run({ repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" }, deps);
  const bodyAfterFirst = currentBody;
  const second = await run({ repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" }, deps);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(currentBody, bodyAfterFirst, "a second finalize against the same already-finalized state must not further mutate the control body");
  assert.equal(stage1Calls.length, 2, "finalize itself never posts a trigger — it only re-reads existing Stage 1 evidence each time, so no duplicate trigger is possible");
});

test("run(): a mismatched --execution-issue fails closed rather than finalizing against the wrong control Issue", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 448, executionIssue: 999, pr: 453, head: "579188a" },
    {
      ghIssueViewImpl: async () => READY_BODY,
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 2, state: "PENDING" }),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PR_BREAKPOINT_UNVERIFIED");
});

test("run(): a write-control-snapshot success whose fresh read-back does not actually reflect it fails closed (never trusts the write call's own return value)", async () => {
  const result = await run(
    { repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" },
    {
      ghIssueViewImpl: async () => READY_BODY, // never actually updated, simulating a silent gh no-op
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 2, state: "PENDING" }),
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PR_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /PR bullet/);
});

test("run(): operational error on missing/invalid required args, distinct from PR_BREAKPOINT_UNVERIFIED", async () => {
  const result = await run({ repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "" });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--head is required/);
});

test("run(): true pre-PR negative control is not this script's concern — a control Issue with no PR should never be pointed at this script at all, but if it is, no execution/Lifecycle mismatch means the composed body simply names the given PR", async () => {
  // This script is only ever invoked once a PR genuinely exists (per its own dispatch-prompt
  // wiring); it has no independent way to prove a PR number is real beyond stage1-gate.mjs's
  // own `gh pr view` call succeeding, which the injected stub always allows here.
  let currentBody = READY_BODY;
  const result = await run(
    { repo: "owner/repo", controlIssue: 448, executionIssue: 447, pr: 453, head: "579188a" },
    {
      ghIssueViewImpl: async () => currentBody,
      stage1GateRunImpl: makeStage1GateStub({ exitCode: 2, state: "PENDING" }),
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        currentBody = proposedBody;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
});
