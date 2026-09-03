// Tests for tools/orchestration/ready-dispatch-gate.mjs — issue #321's deterministic
// guard for AGENTS.md's READY immediate-dispatch gate.
//
// Run with:
//   node --test tools/orchestration/ready-dispatch-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseControlBullet,
  isNoneSentinel,
  parseExecutionPointer,
  evaluateReadyDispatchGate,
  checkReadyDispatch,
} from "./ready-dispatch-gate.mjs";

// Issue #311's real body (control Issue for execution Issue #310) — a genuine
// READY-and-satisfied control Issue.
const ISSUE_311_BODY = `## Outcome

LDL can produce privacy-minimal diagnostic traces for explicitly marked proving/debug sessions so orchestration reasoning can be reviewed without expanding normal telemetry into transcript/reasoning collection.

## Execution contract

**#310** — authoritative thick execution Issue.

Do not reproduce #310's extraction, privacy, artifact, verification, or transcript-handling requirements here. Workers read #310 directly.

## Current state

- **Lifecycle:** READY
- **Execution:** #310
- **Route:** implementation worker
- **PR:** none
- **Stage 1:** none
- **Stage 2:** none
- **Blocker:** none
- **Founder decision:** none — founder selected explicit opt-in diagnostic capture (Option A)

## Completion

Complete when #310 reaches its required CLEAN/verified terminal state.
`;

// Issue #322's real body — a control Issue deliberately BLOCKED because the gate itself
// was under repair; must never read as dispatch-ready.
const ISSUE_322_BODY = `## Outcome

LDL obtains a trustworthy clean fresh READY split-control proof after correcting the now-directly-reproduced post-#314 controller-boundary regression.

## Execution contract

**#321** — authoritative thick execution Issue.

## Current state

- **Lifecycle:** BLOCKED
- **Execution:** #321
- **Route:** implementation/diagnostic worker
- **PR:** none
- **Stage 1:** none
- **Stage 2:** none
- **Blocker:** the READY thin-control path itself is the defect under repair — a fresh \`work on #322\` controller read this complete control state and then immediately loaded #321 instead of dispatching it by reference
- **Founder decision:** none
`;

test("real fixture: control Issue #311's body is READY_TO_DISPATCH with execution #310, route implementation worker", () => {
  const result = evaluateReadyDispatchGate(ISSUE_311_BODY);
  assert.equal(result.status, "READY_TO_DISPATCH");
  assert.equal(result.executionIssue, 310);
  assert.equal(result.route, "implementation worker");
});

test("real fixture: control Issue #322's body is NOT_READY because Lifecycle is BLOCKED, not READY", () => {
  const result = evaluateReadyDispatchGate(ISSUE_322_BODY);
  assert.equal(result.status, "NOT_READY");
  assert.ok(result.reasons.some((r) => r.includes("BLOCKED")));
  // The Blocker field is also non-"none" here — both must not be silently inferred from
  // each other (operating-model.md: "blocker and founder-decision state are separate,
  // explicitly-checked fields, never inferred from the presence of the others").
  assert.ok(result.reasons.some((r) => r.includes("Blocker")));
});

test("parseControlBullet: case-insensitive label, last occurrence wins, trailing explanation preserved", () => {
  assert.equal(parseControlBullet(ISSUE_311_BODY, "Lifecycle"), "READY");
  assert.equal(
    parseControlBullet(ISSUE_311_BODY, "Founder decision"),
    "none — founder selected explicit opt-in diagnostic capture (Option A)",
  );
  assert.equal(parseControlBullet("no bullets here", "Lifecycle"), null);
  const bodyWithEarlierMention = "- **Lifecycle:** EXECUTING (stale quote)\n\n## Current state\n\n- **Lifecycle:** READY\n";
  assert.equal(parseControlBullet(bodyWithEarlierMention, "Lifecycle"), "READY");
});

test("isNoneSentinel: bare \"none\" and \"none — explanation\" both count; a real blocker does not", () => {
  assert.equal(isNoneSentinel("none"), true);
  assert.equal(isNoneSentinel("None"), true);
  assert.equal(isNoneSentinel("none — founder selected explicit opt-in diagnostic capture"), true);
  assert.equal(isNoneSentinel("the READY thin-control path itself is the defect under repair"), false);
  assert.equal(isNoneSentinel(""), false);
  assert.equal(isNoneSentinel(null), false);
});

test("parseExecutionPointer: exactly one #N is ok; zero or multiple fail closed", () => {
  assert.deepEqual(parseExecutionPointer("#310"), { ok: true, issue: 310 });
  assert.deepEqual(parseExecutionPointer("See #310 for details"), { ok: true, issue: 310 });
  assert.equal(parseExecutionPointer("none").ok, false);
  assert.equal(parseExecutionPointer("").ok, false);
  assert.equal(parseExecutionPointer(null).ok, false);
  // Two distinct execution pointers is not "one current execution pointer".
  const multi = parseExecutionPointer("#310 and also #318");
  assert.equal(multi.ok, false);
  assert.ok(multi.reason.includes("#310"));
  assert.ok(multi.reason.includes("#318"));
});

test("evaluateReadyDispatchGate: missing Blocker/Founder-decision fields fail closed, never assumed 'none'", () => {
  const body = "- **Lifecycle:** READY\n- **Execution:** #5\n- **Route:** implementation worker\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "NOT_READY");
  assert.ok(result.reasons.some((r) => r.includes("Blocker")));
  assert.ok(result.reasons.some((r) => r.includes("Founder decision")));
});

test("evaluateReadyDispatchGate: EXECUTING/VERIFYING/REVIEW/AUDIT/CORRECTION are all NOT_READY, not just BLOCKED", () => {
  for (const state of ["EXECUTING", "VERIFYING", "REVIEW", "AUDIT", "CORRECTION"]) {
    const body = `- **Lifecycle:** ${state}\n- **Execution:** #5\n- **Route:** implementation worker\n- **Blocker:** none\n- **Founder decision:** none\n`;
    const result = evaluateReadyDispatchGate(body);
    assert.equal(result.status, "NOT_READY", `expected NOT_READY for lifecycle ${state}`);
  }
});

test("evaluateReadyDispatchGate: an unsettled Route (missing or 'none') is NOT_READY even with every other field satisfied", () => {
  const missingRoute = "- **Lifecycle:** READY\n- **Execution:** #5\n- **Blocker:** none\n- **Founder decision:** none\n";
  assert.equal(evaluateReadyDispatchGate(missingRoute).status, "NOT_READY");

  const noneRoute = "- **Lifecycle:** READY\n- **Execution:** #5\n- **Route:** none\n- **Blocker:** none\n- **Founder decision:** none\n";
  assert.equal(evaluateReadyDispatchGate(noneRoute).status, "NOT_READY");
});

test("checkReadyDispatch: never calls gh more than once, and never for anything but the control Issue itself", async () => {
  let calls = 0;
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 311 },
    {
      ghIssueViewImpl: async ({ repo, number }) => {
        calls++;
        assert.equal(repo, "LouPineWays/Loop-Dee-Loup");
        assert.equal(number, 311);
        return { body: ISSUE_311_BODY, state: "OPEN" };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "READY_TO_DISPATCH");
  assert.equal(result.executionIssue, 310);
  assert.equal(result.route, "implementation worker");
});

test("checkReadyDispatch: a closed control Issue is NOT_READY regardless of body content", async () => {
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 311 },
    { ghIssueViewImpl: async () => ({ body: ISSUE_311_BODY, state: "CLOSED" }) },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "NOT_READY");
});

test("checkReadyDispatch: a NOT_READY control Issue (real #322 fixture) reports exit 3 with reasons, never dispatches", async () => {
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 322 },
    { ghIssueViewImpl: async () => ({ body: ISSUE_322_BODY, state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "NOT_READY");
  assert.ok(result.reasons.length > 0);
  assert.ok(!("executionIssue" in result));
});

test("checkReadyDispatch: missing required args fails closed with exit 1", async () => {
  const result = await checkReadyDispatch({ repo: null, controlIssue: null });
  assert.equal(result.exitCode, 1);
});

test("checkReadyDispatch: a gh failure (e.g. issue not found) fails closed with exit 1, not a false NOT_READY", async () => {
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 999999 },
    {
      ghIssueViewImpl: async () => {
        throw new Error("could not resolve to an Issue");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.ok(result.message.includes("999999"));
});
