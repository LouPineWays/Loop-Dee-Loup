// Tests for tools/orchestration/ready-dispatch-gate.mjs — issue #321's deterministic
// guard for AGENTS.md's READY immediate-dispatch gate.
//
// Run with:
//   node --test tools/orchestration/ready-dispatch-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseControlBullet,
  parseHeadingField,
  parseHeadingBlock,
  extractActiveExecutionRef,
  isNoneSentinel,
  parseExecutionPointer,
  readExecutionBulletField,
  evaluateReadyDispatchGate,
  classifyAuditIssue,
  checkReadyDispatch,
  verifyRoutedDispatchManifest,
  parseOwnerRepoFromRemoteUrl,
  resolveRepoIdentity,
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

test("real fixture: control Issue #322's body is BLOCKED (issue #368) because Lifecycle is BLOCKED and Blocker is non-none", () => {
  // Issue #368: this fixture used to read as ordinary NOT_READY, which the old AGENTS.md
  // fallback treated as license to fall through into execution reasoning. Both fields
  // here positively assert "stop", so the gate must now return the distinct BLOCKED
  // verdict instead.
  const result = evaluateReadyDispatchGate(ISSUE_322_BODY);
  assert.equal(result.status, "BLOCKED");
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

// Issue #398: the control Issue's own "PR:" bullet used a full GitHub PR URL where every
// other reference field used "#N" — next-review-transition-gate.mjs's AMBIGUOUS verdict
// on that live body was the reproduction for this gap.
test("parseExecutionPointer: a full GitHub issue/PR URL resolves the same as \"#N\"", () => {
  assert.deepEqual(parseExecutionPointer("https://github.com/LouPineWays/Loop-Dee-Loup/pull/413"), { ok: true, issue: 413 });
  assert.deepEqual(parseExecutionPointer("https://github.com/LouPineWays/Loop-Dee-Loup/issues/397"), { ok: true, issue: 397 });
  // A trailing comment anchor must not be swallowed into the numeric id.
  assert.deepEqual(
    parseExecutionPointer("Plan Index https://github.com/LouPineWays/Loop-Dee-Loup/issues/397#issuecomment-5553519600"),
    { ok: true, issue: 397 },
  );
  // The same issue referenced twice, once by "#N" and once by URL, is one pointer, not two.
  assert.deepEqual(
    parseExecutionPointer("see #413 — https://github.com/LouPineWays/Loop-Dee-Loup/pull/413"),
    { ok: true, issue: 413 },
  );
  // Two distinct URLs still fail closed as more than one pointer.
  const multi = parseExecutionPointer(
    "https://github.com/LouPineWays/Loop-Dee-Loup/pull/413 and https://github.com/LouPineWays/Loop-Dee-Loup/pull/420",
  );
  assert.equal(multi.ok, false);
});

// Issue #368: the exact control #301 reproduction shape from the incident report.
const CONTROL_301_BODY = `## Current state

- **Lifecycle:** BLOCKED
- **Execution:** #297
- **Route:** implementation worker
- **Blocker:** obtain independently verifiable durable primary evidence for any scored run and/or enough exercisable participant availability to support an authorized terminal conclusion without unverifiable derived data
- **Founder decision:** none
`;

test("evaluateReadyDispatchGate: the exact control #301 reproduction shape is BLOCKED, not ordinary NOT_READY (issue #368)", () => {
  const result = evaluateReadyDispatchGate(CONTROL_301_BODY);
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.reasons.some((r) => r.includes("BLOCKED")));
  assert.ok(result.reasons.some((r) => r.includes("Blocker")));
});

// Issue #370 (Stage 1 finding on #368's PR): `.github/ISSUE_TEMPLATE/parent-execution.yml`'s
// own "State" dropdown never offers the bare word "BLOCKED" — its actual blocking options
// are "BLOCKED_FAILURE" and "BLOCKED_EXTERNAL". A template-shaped control Issue using either
// value must read as BLOCKED, not fall through to ordinary NOT_READY the way the old
// literal-"BLOCKED"-only check let it.
function templateShapedBlockedBody(stateValue) {
  return [
    "### State",
    "",
    stateValue,
    "",
    "### Current state",
    "",
    "- **Execution:** #5",
    "- **Route:** implementation worker",
    "",
    "### Current blocker",
    "",
    "none",
    "",
    "### Founder interrupt",
    "",
    "none",
    "",
  ].join("\n");
}

test("evaluateReadyDispatchGate: a template-shaped body with State: BLOCKED_FAILURE is BLOCKED, not NOT_READY (issue #370)", () => {
  const result = evaluateReadyDispatchGate(templateShapedBlockedBody("BLOCKED_FAILURE"));
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.reasons.some((r) => r.includes("BLOCKED_FAILURE")));
});

test("evaluateReadyDispatchGate: a template-shaped body with State: BLOCKED_EXTERNAL is BLOCKED, not NOT_READY (issue #370)", () => {
  const result = evaluateReadyDispatchGate(templateShapedBlockedBody("BLOCKED_EXTERNAL"));
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.reasons.some((r) => r.includes("BLOCKED_EXTERNAL")));
});

test("checkReadyDispatch: a template-shaped control Issue with State: BLOCKED_FAILURE reports exit 4, state BLOCKED (issue #370)", async () => {
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 301 },
    { ghIssueViewImpl: async () => ({ body: templateShapedBlockedBody("BLOCKED_FAILURE"), state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.length > 0);
  assert.ok(result.reasons.some((r) => r.includes("BLOCKED_FAILURE")));
  assert.ok(!("executionIssue" in result));
});

test("checkReadyDispatch: a template-shaped control Issue with State: BLOCKED_EXTERNAL reports exit 4, state BLOCKED (issue #370)", async () => {
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 301 },
    { ghIssueViewImpl: async () => ({ body: templateShapedBlockedBody("BLOCKED_EXTERNAL"), state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.length > 0);
  assert.ok(result.reasons.some((r) => r.includes("BLOCKED_EXTERNAL")));
  assert.ok(!("executionIssue" in result));
});

test("evaluateReadyDispatchGate: a non-'none' Blocker alone (otherwise READY-shaped) is BLOCKED, not a fallthrough NOT_READY (issue #368)", () => {
  const body =
    "- **Lifecycle:** READY\n- **Execution:** #5\n- **Route:** implementation worker\n- **Blocker:** waiting on an external dependency\n- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reasons.length, 1);
  assert.ok(result.reasons[0].includes("Blocker"));
});

test("evaluateReadyDispatchGate: an unresolved Founder decision alone (otherwise READY-shaped) is BLOCKED, not a fallthrough NOT_READY (issue #368)", () => {
  const body =
    "- **Lifecycle:** READY\n- **Execution:** #5\n- **Route:** implementation worker\n- **Blocker:** none\n- **Founder decision:** choose between option A and option B\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.reasons.length, 1);
  assert.ok(result.reasons[0].includes("Founder decision"));
});

test("evaluateReadyDispatchGate: EXECUTING/VERIFYING/REVIEW/AUDIT/CORRECTION with Blocker/Founder decision both none stay NOT_READY, never BLOCKED (issue #368 AC: authorized mid-lifecycle continuation is not converted into a founder blocker)", () => {
  for (const state of ["EXECUTING", "VERIFYING", "REVIEW", "AUDIT", "CORRECTION"]) {
    const body = `- **Lifecycle:** ${state}\n- **Execution:** #5\n- **Route:** implementation worker\n- **Blocker:** none\n- **Founder decision:** none\n`;
    const result = evaluateReadyDispatchGate(body);
    assert.equal(result.status, "NOT_READY", `expected NOT_READY (not BLOCKED) for lifecycle ${state}`);
  }
});

test("evaluateReadyDispatchGate: a legacy unsplit Issue with no control-state shape at all stays ordinary NOT_READY fallback, never BLOCKED (issue #368)", () => {
  const body = "This is a plain legacy issue body with no Current-state bullet block at all.";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "NOT_READY");
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

test("parseHeadingField: reads a GitHub issue-form '### Heading' field, distinct from the bullet convention (Stage 1 finding, PR #323)", () => {
  const body = "### State\n\nREADY\n\n### Current blocker\n\nnone\n\n### Founder interrupt\n\n_No response_\n";
  assert.equal(parseHeadingField(body, "State"), "READY");
  assert.equal(parseHeadingField(body, "Current blocker"), "none");
  // GitHub's own "no answer" marker for an unanswered optional field reads as absent,
  // not as literal text.
  assert.equal(parseHeadingField(body, "Founder interrupt"), null);
  assert.equal(parseHeadingField(body, "Nonexistent"), null);
});

test("evaluateReadyDispatchGate: a control Issue shaped like the real shipped parent-execution.yml template (### headings, no bullets) is still readable (Stage 1 P1 finding, PR #323)", () => {
  // Mirrors what GitHub actually renders from .github/ISSUE_TEMPLATE/parent-execution.yml
  // — no "- **Lifecycle:**"/"Execution"/"Route" bullets exist in that template at all.
  const templateShapedBody = [
    "### Source item",
    "",
    "#123",
    "",
    "### State",
    "",
    "READY",
    "",
    "### Accepted outcome",
    "",
    "Some outcome.",
    "",
    "### Current state",
    "",
    "- **Execution:** #310",
    "- **Route:** implementation worker",
    "",
    "### Minimum authority",
    "",
    "See #310.",
    "",
    "### Current blocker",
    "",
    "none",
    "",
    "### Founder interrupt",
    "",
    "none",
    "",
  ].join("\n");
  const result = evaluateReadyDispatchGate(templateShapedBody);
  assert.equal(result.status, "READY_TO_DISPATCH");
  assert.equal(result.executionIssue, 310);
  assert.equal(result.route, "implementation worker");
});

test("evaluateReadyDispatchGate: Lifecycle/Blocker/Founder-decision fall back to template headings even with no Execution/Route bullets present anywhere but Minimum authority", () => {
  const body = [
    "### State",
    "",
    "READY",
    "",
    "### Minimum authority",
    "",
    "Active execution Issue: #77. See docs/operating-model.md.",
    "",
    "### Current blocker",
    "",
    "none",
    "",
    "### Founder interrupt",
    "",
    "none",
    "",
    "- **Route:** implementation worker",
  ].join("\n");
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "READY_TO_DISPATCH");
  assert.equal(result.executionIssue, 77);
});

test("parseHeadingBlock: reads the entire multiline field, not just its first line (Stage 2 audit finding, PR #323)", () => {
  const body = "### Minimum authority\n\nActive execution Issue:\n- #77\n\n### Current blocker\n\nnone\n";
  assert.equal(parseHeadingBlock(body, "Minimum authority"), "Active execution Issue:\n- #77");
  assert.equal(parseHeadingBlock(body, "Nonexistent"), null);
  assert.equal(parseHeadingBlock("### Minimum authority\n\n_No response_\n", "Minimum authority"), null);
});

test("extractActiveExecutionRef: isolates the labeled entry, ignoring an unrelated '#N' reference elsewhere in the same block (Stage 1 finding, PR #325)", () => {
  assert.equal(extractActiveExecutionRef("Active execution Issue: #77\nAlso see #50 for background."), "#77");
  assert.equal(extractActiveExecutionRef("Active execution Issue:\n- #77\n\nAlso required: #50"), "#77");
  assert.equal(extractActiveExecutionRef("Also required: #50\nNo active-execution label here."), null);
  assert.equal(extractActiveExecutionRef(null), null);
});

test("extractActiveExecutionRef: an unrelated reference two lines below an empty label entry is never picked up (Stage 2 audit finding, PR #325 — the exact adversarial input Codex reported)", () => {
  const block = "Active execution Issue:\nPending founder-selected routing details\nAlso required for context: #50";
  assert.equal(extractActiveExecutionRef(block), null);
});

test("extractActiveExecutionRef: a historical/superseded or negated mention of the label phrase is never treated as the authoritative entry (Stage 2 audit finding, PR #327 — the exact adversarial input Codex reported)", () => {
  assert.equal(extractActiveExecutionRef("Previous active execution Issue: #50\nActive execution Issue: #77"), "#77");
  assert.equal(extractActiveExecutionRef("Do not use #50 as the active execution Issue: it is closed."), null);
  // A genuine bullet-prefixed label line still counts — anchoring strips a leading list
  // marker before checking, it does not require the label to start at column 0.
  assert.equal(extractActiveExecutionRef("- Active execution Issue: #77"), "#77");
});

test("extractActiveExecutionRef: recognizes the repository's own '- **Label:**' bold-bullet convention (Stage 1 finding, PR #329)", () => {
  assert.equal(extractActiveExecutionRef("- **Active execution Issue:** #77"), "#77");
  assert.equal(extractActiveExecutionRef("**Active execution Issue:** #77"), "#77");
  assert.equal(extractActiveExecutionRef("- **Active execution Issue:**\n- #77"), "#77");
});

test("evaluateReadyDispatchGate: a 'Minimum authority' block with an empty Active-execution entry never dispatches to a later, unrelated authority reference (Stage 2 audit finding, PR #325)", () => {
  const body = [
    "### State",
    "",
    "READY",
    "",
    "### Minimum authority",
    "",
    "Active execution Issue:",
    "Pending founder-selected routing details",
    "Also required for context: #50",
    "",
    "### Current blocker",
    "",
    "none",
    "",
    "### Founder interrupt",
    "",
    "none",
    "",
    "- **Route:** implementation worker",
  ].join("\n");
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "NOT_READY");
  assert.ok(!("executionIssue" in result));
});

test("evaluateReadyDispatchGate: a superseded 'Previous active execution Issue' line never outranks the genuine label entry (Stage 2 audit finding, PR #327)", () => {
  const body = [
    "### State",
    "",
    "READY",
    "",
    "### Minimum authority",
    "",
    "Previous active execution Issue: #50",
    "Active execution Issue: #77",
    "",
    "### Current blocker",
    "",
    "none",
    "",
    "### Founder interrupt",
    "",
    "none",
    "",
    "- **Route:** implementation worker",
  ].join("\n");
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "READY_TO_DISPATCH");
  assert.equal(result.executionIssue, 77);
});

test("evaluateReadyDispatchGate: a 'Minimum authority' block naming both the active execution Issue and another required issue still resolves to exactly the labeled one (Stage 1 finding, PR #325 — the exact false negative Codex reported)", () => {
  const body = [
    "### State",
    "",
    "READY",
    "",
    "### Minimum authority",
    "",
    "Active execution Issue: #77",
    "Also required for context: #50",
    "",
    "### Current blocker",
    "",
    "none",
    "",
    "### Founder interrupt",
    "",
    "none",
    "",
    "- **Route:** implementation worker",
  ].join("\n");
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "READY_TO_DISPATCH");
  assert.equal(result.executionIssue, 77);
});

test("evaluateReadyDispatchGate: an Execution pointer on a later line of a multiline 'Minimum authority' block is still found (Stage 2 audit finding, PR #323 — the exact false negative Codex reported)", () => {
  const body = [
    "### State",
    "",
    "READY",
    "",
    "### Minimum authority",
    "",
    "Active execution Issue:",
    "- #77",
    "",
    "### Current blocker",
    "",
    "none",
    "",
    "### Founder interrupt",
    "",
    "none",
    "",
    "- **Route:** implementation worker",
  ].join("\n");
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "READY_TO_DISPATCH");
  assert.equal(result.executionIssue, 77);
});

test("evaluateReadyDispatchGate: a self-referential Execution pointer (control Issue naming itself) is NOT_READY (Stage 1 finding, PR #323)", () => {
  const body = "- **Lifecycle:** READY\n- **Execution:** #42\n- **Route:** implementation worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body, 42);
  assert.equal(result.status, "NOT_READY");
  assert.ok(result.reasons.some((r) => r.includes("#42") && r.includes("itself")));

  // A genuinely different execution pointer on the same control Issue number is fine.
  const okResult = evaluateReadyDispatchGate(body.replace("#42", "#41"), 42);
  assert.equal(okResult.status, "READY_TO_DISPATCH");
  assert.equal(okResult.executionIssue, 41);

  // Omitting controlIssueNumber (the pure function's default) skips this check —
  // callers that don't have their own control Issue number handy still get the rest of
  // the gate's protection.
  assert.equal(evaluateReadyDispatchGate(body).status, "READY_TO_DISPATCH");
});

test("checkReadyDispatch: rejects a self-referential Execution pointer end to end", async () => {
  const body = "- **Lifecycle:** READY\n- **Execution:** #322\n- **Route:** implementation worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 322 },
    { ghIssueViewImpl: async () => ({ body, state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "NOT_READY");
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

test("checkReadyDispatch: a BLOCKED control Issue (control #301 reproduction shape) reports exit 4 with reasons, from a single read, never dispatches (issue #368)", async () => {
  let calls = 0;
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 301 },
    {
      ghIssueViewImpl: async () => {
        calls++;
        return { body: CONTROL_301_BODY, state: "OPEN" };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "BLOCKED");
  assert.notEqual(result.exitCode, 3);
  assert.ok(result.reasons.length > 0);
  assert.ok(!("executionIssue" in result));
});

test("checkReadyDispatch: a BLOCKED control Issue (real #322 fixture) reports exit 4 with reasons, never dispatches (issue #368)", async () => {
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 322 },
    { ghIssueViewImpl: async () => ({ body: ISSUE_322_BODY, state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.length > 0);
  assert.ok(!("executionIssue" in result));
});

test("checkReadyDispatch: an ordinary NOT_READY control Issue (mid-cycle lifecycle, no active blocker) still reports exit 3, distinct from BLOCKED's exit 4", async () => {
  const body = "- **Lifecycle:** EXECUTING\n- **Execution:** #5\n- **Route:** implementation worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 400 },
    { ghIssueViewImpl: async () => ({ body, state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "NOT_READY");
});

// --- Issue #407 unit 407-B: AUDIT_ISSUE_DETECTED (the #432 direct-Stage-2-dispatch fix) ----
//
// Synthetic fixture shaped like a real audit-control-issue.yml render (never special-cased
// by a real issue number, per the Shared Contract's fixture-discipline item) — carries the
// three headings classifyAuditIssue requires: "### Verdict" (a real PENDING/CLEAN/NOT CLEAN
// dropdown reading), "### Merged PR", and "### Work issue". A thin control Issue using the
// ad hoc "- **Label:**" bullet convention never has this shape at all.
function auditIssueBody(verdict) {
  return `This issue is a **read-only Stage 2 control boundary**. Modify nothing.

### Merged PR

https://github.com/LouPineWays/Loop-Dee-Loup/pull/9001

### Work issue

#9000

### Exact merge commit

\`abcdef0123456789abcdef0123456789abcdef01\`

### Verdict

${verdict}
`;
}

test("classifyAuditIssue: a real audit-control-issue.yml-shaped body is detected regardless of its current Verdict value", () => {
  assert.equal(classifyAuditIssue(auditIssueBody("PENDING")), true);
  assert.equal(classifyAuditIssue(auditIssueBody("CLEAN")), true);
  assert.equal(classifyAuditIssue(auditIssueBody("NOT CLEAN")), true);
});

test("classifyAuditIssue: a thin control Issue (real #311 fixture) is never misclassified as an Audit Issue", () => {
  assert.equal(classifyAuditIssue(ISSUE_311_BODY), false);
  assert.equal(classifyAuditIssue(ISSUE_322_BODY), false);
});

test("classifyAuditIssue: missing any one of the three required fields fails closed to false", () => {
  const noWorkIssue = auditIssueBody("PENDING").replace(/### Work issue\n\n#9000\n\n/, "");
  const noMergedPr = auditIssueBody("PENDING").replace(/### Merged PR\n\nhttps:\/\/github\.com\/LouPineWays\/Loop-Dee-Loup\/pull\/9001\n\n/, "");
  const noVerdict = auditIssueBody("PENDING").replace(/### Verdict\n\nPENDING\n/, "");
  assert.equal(classifyAuditIssue(noWorkIssue), false);
  assert.equal(classifyAuditIssue(noMergedPr), false);
  assert.equal(classifyAuditIssue(noVerdict), false);
});

test("evaluateReadyDispatchGate: a directly-dispatched Audit Issue returns AUDIT_ISSUE_DETECTED, never NOT_READY, with a correct next-step pointer (issue #407 unit 407-B, the #432 fix)", () => {
  const result = evaluateReadyDispatchGate(auditIssueBody("PENDING"), 9002);
  assert.equal(result.status, "AUDIT_ISSUE_DETECTED");
  assert.equal(result.auditIssue, 9002);
  assert.equal(result.nextCommand, "node tools/orchestration/next-review-transition-gate.mjs --audit-issue 9002");
});

test("evaluateReadyDispatchGate: AUDIT_ISSUE_DETECTED is checked before the generic Lifecycle-bullet path even when the body happens to also carry an unrelated bullet-shaped line", () => {
  const body = auditIssueBody("CLEAN") + "\n- **Lifecycle:** EXECUTING\n";
  const result = evaluateReadyDispatchGate(body, 9003);
  assert.equal(result.status, "AUDIT_ISSUE_DETECTED");
});

test("checkReadyDispatch: a directly-dispatched Audit Issue resolves end to end to exit 9 / AUDIT_ISSUE_DETECTED from a single control-plane read, no source-inspection or ad hoc parsing required (issue #407 unit 407-B)", async () => {
  let calls = 0;
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 9004 },
    {
      ghIssueViewImpl: async ({ repo, number }) => {
        calls++;
        assert.equal(repo, "LouPineWays/Loop-Dee-Loup");
        assert.equal(number, 9004);
        return { body: auditIssueBody("CLEAN"), state: "OPEN" };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 9);
  assert.equal(result.state, "AUDIT_ISSUE_DETECTED");
  assert.equal(result.auditIssue, 9004);
  assert.equal(result.nextCommand, "node tools/orchestration/next-review-transition-gate.mjs --audit-issue 9004");
});

test("checkReadyDispatch: a directly-dispatched Audit Issue with a NOT CLEAN dropdown still classifies as AUDIT_ISSUE_DETECTED — verdict interpretation is next-review-transition-gate.mjs's job, not this gate's", async () => {
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 9005 },
    { ghIssueViewImpl: async () => ({ body: auditIssueBody("NOT CLEAN"), state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 9);
  assert.equal(result.state, "AUDIT_ISSUE_DETECTED");
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

// --- Issue #344: deterministic repository-identity resolution ---------------------------

test("parseOwnerRepoFromRemoteUrl: HTTPS remote, with and without a trailing .git", () => {
  assert.equal(parseOwnerRepoFromRemoteUrl("https://github.com/LouPineWays/Loop-Dee-Loup.git"), "LouPineWays/Loop-Dee-Loup");
  assert.equal(parseOwnerRepoFromRemoteUrl("https://github.com/LouPineWays/Loop-Dee-Loup"), "LouPineWays/Loop-Dee-Loup");
  assert.equal(parseOwnerRepoFromRemoteUrl("https://github.com/LouPineWays/Loop-Dee-Loup/"), "LouPineWays/Loop-Dee-Loup");
});

test("parseOwnerRepoFromRemoteUrl: scp-like SSH remote, with and without a user@ prefix or .git suffix", () => {
  assert.equal(parseOwnerRepoFromRemoteUrl("git@github.com:LouPineWays/Loop-Dee-Loup.git"), "LouPineWays/Loop-Dee-Loup");
  assert.equal(parseOwnerRepoFromRemoteUrl("github.com:LouPineWays/Loop-Dee-Loup"), "LouPineWays/Loop-Dee-Loup");
});

test("parseOwnerRepoFromRemoteUrl: ssh:// scheme form and a GitHub Enterprise host both resolve on owner/repo shape alone", () => {
  assert.equal(parseOwnerRepoFromRemoteUrl("ssh://git@github.com/LouPineWays/Loop-Dee-Loup.git"), "LouPineWays/Loop-Dee-Loup");
  assert.equal(parseOwnerRepoFromRemoteUrl("https://github.mycompany.com/SomeOrg/some-repo.git"), "SomeOrg/some-repo");
});

test("parseOwnerRepoFromRemoteUrl: a consumer repository's own remote resolves to that consumer's identity, never LDL's", () => {
  assert.equal(parseOwnerRepoFromRemoteUrl("git@github.com:SomeConsumer/YouTubery.git"), "SomeConsumer/YouTubery");
});

test("parseOwnerRepoFromRemoteUrl: malformed, empty, or non-string input fails closed to null rather than guessing", () => {
  assert.equal(parseOwnerRepoFromRemoteUrl("not-a-remote-url"), null);
  assert.equal(parseOwnerRepoFromRemoteUrl(""), null);
  assert.equal(parseOwnerRepoFromRemoteUrl("   "), null);
  assert.equal(parseOwnerRepoFromRemoteUrl(null), null);
  assert.equal(parseOwnerRepoFromRemoteUrl(undefined), null);
});

test("resolveRepoIdentity: derives owner/repo from an injected origin remote (no real git/network access)", () => {
  const result = resolveRepoIdentity({ gitRemoteUrlImpl: () => "https://github.com/LouPineWays/Loop-Dee-Loup.git\n" });
  assert.deepEqual(result, { ok: true, repo: "LouPineWays/Loop-Dee-Loup" });
});

test("resolveRepoIdentity: a consumer checkout's remote resolves to the consumer's own repository", () => {
  const result = resolveRepoIdentity({ gitRemoteUrlImpl: () => "git@github.com:SomeConsumer/YouTubery.git" });
  assert.deepEqual(result, { ok: true, repo: "SomeConsumer/YouTubery" });
});

test("resolveRepoIdentity: fails closed (ok: false) when `git remote get-url origin` itself throws (no configured remote)", () => {
  const result = resolveRepoIdentity({
    gitRemoteUrlImpl: () => {
      throw new Error("No such remote 'origin'");
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("origin"));
});

test("resolveRepoIdentity: fails closed (ok: false) when the remote URL doesn't resolve to an owner/repo shape", () => {
  const result = resolveRepoIdentity({ gitRemoteUrlImpl: () => "not-a-remote-url" });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("not-a-remote-url"));
});

test("resolveRepoIdentity: never throws, even when gitRemoteUrlImpl throws a non-Error value (Stage 2 audit finding, issue #348)", () => {
  for (const thrown of [null, undefined, "plain string failure", 42, { code: "ENOENT" }]) {
    assert.doesNotThrow(() => {
      const result = resolveRepoIdentity({
        gitRemoteUrlImpl: () => {
          throw thrown;
        },
      });
      assert.equal(result.ok, false);
      assert.equal(typeof result.reason, "string");
    }, `resolveRepoIdentity threw for injected throw value: ${JSON.stringify(thrown)}`);
  }
});

test("resolveRepoIdentity: never throws even when the thrown value's own inspection (Symbol.toPrimitive/toString/message getter) throws (Stage 1 finding, PR #349)", () => {
  const adversarialValues = [
    // String(err) invokes Symbol.toPrimitive, which itself throws here.
    {
      [Symbol.toPrimitive]() {
        throw new Error("cannot stringify me");
      },
    },
    // An Error-like object whose `message` getter throws, so even the `instanceof Error`
    // branch's own property read is unsafe.
    Object.create(Error.prototype, {
      message: {
        get() {
          throw new Error("message getter exploded");
        },
      },
    }),
  ];
  for (const thrown of adversarialValues) {
    assert.doesNotThrow(() => {
      const result = resolveRepoIdentity({
        gitRemoteUrlImpl: () => {
          throw thrown;
        },
      });
      assert.equal(result.ok, false);
      assert.equal(typeof result.reason, "string");
    }, "resolveRepoIdentity threw while normalizing an adversarial thrown value");
  }
});

test("resolveRepoIdentity: never throws when a genuine Error's own message is a non-string value whose coercion throws (Stage 2 audit finding, issue #350)", () => {
  // A real `Error` (so `err instanceof Error` is true and `err.message` reads back
  // successfully — unlike the throwing-getter case above) whose `.message` was reassigned to
  // an object with a throwing `Symbol.toPrimitive`. Reading `err.message` itself does not
  // throw here; only the later implicit string coercion does — exactly the gap the audit
  // found in the previous fix, which protected reading/branching on `err` but not the final
  // string conversion of whatever it read.
  const nonStringMessage = {
    [Symbol.toPrimitive]() {
      throw new Error("detail coercion exploded");
    },
  };
  const thrown = new Error("initial");
  thrown.message = nonStringMessage;

  assert.doesNotThrow(() => {
    const result = resolveRepoIdentity({
      gitRemoteUrlImpl: () => {
        throw thrown;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, "string");
  }, "resolveRepoIdentity threw while coercing a non-string Error.message to a string");
});

test("checkReadyDispatch: the normal path (no explicit repo) resolves repository identity via resolveRepoIdentityImpl, never a hand-typed value", async () => {
  let sawRepo = null;
  const result = await checkReadyDispatch(
    { controlIssue: 311 },
    {
      resolveRepoIdentityImpl: () => ({ ok: true, repo: "LouPineWays/Loop-Dee-Loup" }),
      ghIssueViewImpl: async ({ repo, number }) => {
        sawRepo = repo;
        assert.equal(number, 311);
        return { body: ISSUE_311_BODY, state: "OPEN" };
      },
    },
  );
  assert.equal(sawRepo, "LouPineWays/Loop-Dee-Loup");
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "READY_TO_DISPATCH");
  assert.equal(result.repo, "LouPineWays/Loop-Dee-Loup");
});

test("checkReadyDispatch: a consumer repository's derived identity is used as-is, never coerced to the LDL source repository", async () => {
  let sawRepo = null;
  const result = await checkReadyDispatch(
    { controlIssue: 311 },
    {
      resolveRepoIdentityImpl: () => ({ ok: true, repo: "SomeConsumer/YouTubery" }),
      ghIssueViewImpl: async ({ repo }) => {
        sawRepo = repo;
        return { body: ISSUE_311_BODY, state: "OPEN" };
      },
    },
  );
  assert.equal(sawRepo, "SomeConsumer/YouTubery");
  assert.equal(result.repo, "SomeConsumer/YouTubery");
});

test("checkReadyDispatch: an explicit --repo override is used verbatim and never triggers repository-identity resolution", async () => {
  let resolveCalls = 0;
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 311 },
    {
      resolveRepoIdentityImpl: () => {
        resolveCalls++;
        return { ok: true, repo: "should-never-be-used/should-never-be-used" };
      },
      ghIssueViewImpl: async () => ({ body: ISSUE_311_BODY, state: "OPEN" }),
    },
  );
  assert.equal(resolveCalls, 0);
  assert.equal(result.repo, "LouPineWays/Loop-Dee-Loup");
});

test("checkReadyDispatch: a repository-identity resolution failure is a distinct ERROR (exit 1), never NOT_READY (exit 3), and never reads the control Issue", async () => {
  let issueReadCalls = 0;
  const result = await checkReadyDispatch(
    { controlIssue: 311 },
    {
      resolveRepoIdentityImpl: () => ({
        ok: false,
        reason: 'the checkout\'s "origin" remote ("not-a-remote-url") is not a recognizable GitHub owner/repo URL',
      }),
      ghIssueViewImpl: async () => {
        issueReadCalls++;
        return { body: ISSUE_311_BODY, state: "OPEN" };
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.notEqual(result.exitCode, 3);
  assert.equal(result.state, undefined);
  assert.ok(result.message.includes("repository identity"));
  assert.equal(issueReadCalls, 0);
});

test("checkReadyDispatch: missing --control-issue fails closed with exit 1 even without attempting repository-identity resolution", async () => {
  let resolveCalls = 0;
  const result = await checkReadyDispatch(
    { controlIssue: null },
    { resolveRepoIdentityImpl: () => { resolveCalls++; return { ok: true, repo: "x/y" }; } },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(resolveCalls, 0);
});

// --- #397: four new pre-PR pipeline Lifecycle values ------------------------------------

// The exact live #408 reproduction shape from #397's Shared Contract root-cause finding —
// literal "- **Execution issue:** #407", not the legacy "- **Execution:**" spelling. 397-B's
// own regression fixture silently normalized "Execution issue:" to "Execution:" before
// exercising the gate, so it never actually proved the gate accepted the production shape;
// live #398/#408 evidence exposed that gap. This is the corrected fixture (397-E).
const ISSUE_408_BODY = `## Current state

- **Lifecycle:** READY_FOR_PLAN
- **Execution issue:** #407
- **Route:** planning worker
- **Blocker:** none
- **Founder decision:** none
`;

test("evaluateReadyDispatchGate: the literal live #408 body ('Execution issue:' spelling) resolves to READY_TO_DISPATCH_PLANNING, not NOT_READY (397-E)", () => {
  const result = evaluateReadyDispatchGate(ISSUE_408_BODY);
  assert.equal(result.status, "READY_TO_DISPATCH_PLANNING");
  assert.equal(result.executionIssue, 407);
  assert.equal(result.route, "planning worker");
});

test("checkReadyDispatch: the literal live #408 body reports exit 5, state READY_TO_DISPATCH_PLANNING, from a single read (397-E)", async () => {
  let calls = 0;
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 408 },
    {
      ghIssueViewImpl: async () => {
        calls++;
        return { body: ISSUE_408_BODY, state: "OPEN" };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 5);
  assert.equal(result.state, "READY_TO_DISPATCH_PLANNING");
  assert.equal(result.executionIssue, 407);
  assert.equal(result.route, "planning worker");
});

// A #398-shaped body — same live "Execution issue:" spelling, but Lifecycle: PLAN_READY
// pointing at #397 (#398's own execution issue) — proving the alias also resolves the
// PLAN_READY transition, not just READY_FOR_PLAN.
const ISSUE_398_PLAN_READY_BODY = `## Control state

- **Lifecycle:** PLAN_READY
- **Execution issue:** #397
- **Route:** planning worker
- **Blocker:** none
- **Founder decision:** none
`;

test("evaluateReadyDispatchGate: a #398-shaped PLAN_READY body ('Execution issue:' spelling) resolves to READY_TO_RUN_DISPATCH_MANIFEST (397-E)", () => {
  const result = evaluateReadyDispatchGate(ISSUE_398_PLAN_READY_BODY);
  assert.equal(result.status, "READY_TO_RUN_DISPATCH_MANIFEST");
  assert.equal(result.executionIssue, 397);
});

test("checkReadyDispatch: a #398-shaped PLAN_READY body reports exit 6, state READY_TO_RUN_DISPATCH_MANIFEST, from a single read (397-E)", async () => {
  let calls = 0;
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 398 },
    {
      ghIssueViewImpl: async () => {
        calls++;
        return { body: ISSUE_398_PLAN_READY_BODY, state: "OPEN" };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 6);
  assert.equal(result.state, "READY_TO_RUN_DISPATCH_MANIFEST");
  assert.equal(result.executionIssue, 397);
});

test("readExecutionBulletField: only 'Execution:' present is read verbatim (legacy control Issues keep working unchanged)", () => {
  const result = readExecutionBulletField("- **Execution:** #310\n");
  assert.deepEqual(result, { conflict: false, value: "#310" });
});

test("readExecutionBulletField: only 'Execution issue:' present is read verbatim (live #398/#408 spelling)", () => {
  const result = readExecutionBulletField("- **Execution issue:** #407\n");
  assert.deepEqual(result, { conflict: false, value: "#407" });
});

test("readExecutionBulletField: both spellings present naming the same issue is not a conflict", () => {
  const result = readExecutionBulletField("- **Execution:** #407\n- **Execution issue:** #407\n");
  assert.equal(result.conflict, false);
  assert.equal(result.value, "#407");
});

test("readExecutionBulletField: both spellings present naming different issues is a conflict", () => {
  const result = readExecutionBulletField("- **Execution:** #310\n- **Execution issue:** #407\n");
  assert.deepEqual(result, { conflict: true, legacy: "#310", liveSpelling: "#407" });
});

test("evaluateReadyDispatchGate: conflicting 'Execution:'/'Execution issue:' pointers fail closed to NOT_READY with an explicit conflict reason, never silently picking one (397-E)", () => {
  const body =
    "- **Lifecycle:** READY_FOR_PLAN\n- **Execution:** #310\n- **Execution issue:** #407\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "NOT_READY");
  assert.ok(!("executionIssue" in result));
  assert.ok(result.reasons.some((r) => r.includes("#310") && r.includes("#407") && r.toLowerCase().includes("ambiguous")));
});

test("checkReadyDispatch: conflicting 'Execution:'/'Execution issue:' pointers report exit 3, state NOT_READY, from a single read (397-E)", async () => {
  const body =
    "- **Lifecycle:** READY\n- **Execution:** #310\n- **Execution issue:** #407\n- **Route:** implementation worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 500 },
    { ghIssueViewImpl: async () => ({ body, state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "NOT_READY");
  assert.ok(!("executionIssue" in result));
});

test("evaluateReadyDispatchGate: READY_FOR_PLAN with any other Route value is NOT_READY, never dispatched with the wrong route", () => {
  const body =
    "- **Lifecycle:** READY_FOR_PLAN\n- **Execution:** #407\n- **Route:** implementation worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "NOT_READY");
  assert.ok(result.reasons.some((r) => r.includes("READY_FOR_PLAN") && r.includes("planning worker")));
});

test("evaluateReadyDispatchGate: READY_FOR_PLAN with an active Blocker is BLOCKED, not NOT_READY (issue #368's split still applies to the new states)", () => {
  const body =
    "- **Lifecycle:** READY_FOR_PLAN\n- **Execution:** #407\n- **Route:** planning worker\n- **Blocker:** waiting on something\n- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "BLOCKED");
});

test("evaluateReadyDispatchGate: PLAN_READY resolves to READY_TO_RUN_DISPATCH_MANIFEST, with no Route-value requirement beyond settled", () => {
  const body =
    "- **Lifecycle:** PLAN_READY\n- **Execution:** #407\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "READY_TO_RUN_DISPATCH_MANIFEST");
  assert.equal(result.executionIssue, 407);
  assert.equal("route" in result, false);
});

test("checkReadyDispatch: PLAN_READY reports exit 6, state READY_TO_RUN_DISPATCH_MANIFEST", async () => {
  const body =
    "- **Lifecycle:** PLAN_READY\n- **Execution:** #407\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 408 },
    { ghIssueViewImpl: async () => ({ body, state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 6);
  assert.equal(result.state, "READY_TO_RUN_DISPATCH_MANIFEST");
  assert.equal(result.executionIssue, 407);
});

test("evaluateReadyDispatchGate: ROUTED requires manifest verification before READY_TO_DISPATCH_UNITS", () => {
  const body =
    "- **Lifecycle:** ROUTED\n- **Execution:** #407\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "READY_TO_VERIFY_DISPATCH_MANIFEST");
  assert.equal(result.executionIssue, 407);
});

test("checkReadyDispatch: ROUTED reports exit 7 only when the manifest pointer and comment are verified", async () => {
  const body =
    "- **Lifecycle:** ROUTED\n- **Execution:** #407\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 408 },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      parseExecutionPlanImpl: async () => ({
        exitCode: 0,
        ok: true,
        repo: "LouPineWays/Loop-Dee-Loup",
        executionIssue: 407,
        plan: {
          planIndex: {
            commentId: 100,
            url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100",
            dispatchManifest: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-200",
          },
        },
      }),
      ghCommentViewImpl: async () => ({
        id: 200,
        html_url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-200",
        issue_url: "https://api.github.com/repos/LouPineWays/Loop-Dee-Loup/issues/407",
        body:
          "## Dispatch Manifest (v1)\n\n- **Plan index:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100\n",
      }),
    },
  );
  assert.equal(result.exitCode, 7);
  assert.equal(result.state, "READY_TO_DISPATCH_UNITS");
  assert.equal(result.manifestCommentId, 200);
  assert.equal(result.manifestUrl, "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-200");
  assert.equal(result.planIndexUrl, "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100");
});

test("checkReadyDispatch: ROUTED with Dispatch manifest pointer 'none' is NOT_READY", async () => {
  const body =
    "- **Lifecycle:** ROUTED\n- **Execution:** #407\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 408 },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      parseExecutionPlanImpl: async () => ({
        exitCode: 0,
        ok: true,
        repo: "LouPineWays/Loop-Dee-Loup",
        executionIssue: 407,
        plan: {
          planIndex: {
            commentId: 100,
            url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100",
            dispatchManifest: "none",
          },
        },
      }),
    },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "NOT_READY");
  assert.ok(result.reasons.some((r) => r.includes("Dispatch manifest pointer")));
});

test("checkReadyDispatch: ROUTED fails closed when referenced manifest belongs to the wrong issue", async () => {
  const body =
    "- **Lifecycle:** ROUTED\n- **Execution:** #407\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 408 },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      parseExecutionPlanImpl: async () => ({
        exitCode: 0,
        ok: true,
        repo: "LouPineWays/Loop-Dee-Loup",
        executionIssue: 407,
        plan: {
          planIndex: {
            commentId: 100,
            url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100",
            dispatchManifest: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-200",
          },
        },
      }),
      ghCommentViewImpl: async () => ({
        id: 200,
        html_url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-200",
        issue_url: "https://api.github.com/repos/LouPineWays/Loop-Dee-Loup/issues/999",
        body:
          "## Dispatch Manifest (v1)\n\n- **Plan index:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100\n",
      }),
    },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "NOT_READY");
  assert.ok(result.reasons.some((r) => r.includes("belongs to issue #999")));
});

test("verifyRoutedDispatchManifest: fails closed when manifest Plan index backlink does not match parsed plan", async () => {
  const result = await verifyRoutedDispatchManifest(
    { repo: "LouPineWays/Loop-Dee-Loup", executionIssue: 407 },
    {
      parseExecutionPlanImpl: async () => ({
        exitCode: 0,
        ok: true,
        repo: "LouPineWays/Loop-Dee-Loup",
        executionIssue: 407,
        plan: {
          planIndex: {
            commentId: 100,
            url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100",
            dispatchManifest: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-200",
          },
        },
      }),
      ghCommentViewImpl: async () => ({
        id: 200,
        html_url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-200",
        issue_url: "https://api.github.com/repos/LouPineWays/Loop-Dee-Loup/issues/407",
        body:
          "## Dispatch Manifest (v1)\n\n- **Plan index:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-999\n",
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /Plan index backlink/i);
});

// Stage 1 review findings on PR #420 -- four regressions, one per finding.

test("verifyRoutedDispatchManifest: a duplicate 'Plan index:' bullet resolves via last-occurrence, matching parseControlBullet's convention, not the first", async () => {
  // The manifest's own body carries two "Plan index" bullets: a correct first one and a
  // conflicting, wrong second one. Before this fix, a bare `.match()` returned the FIRST
  // (correct) bullet, silently accepting an ambiguous/malformed manifest. The established
  // ambiguity-safe convention (parseControlBullet) uses the LAST occurrence instead, so a
  // manifest authored (or concurrently edited) into this shape must fail verification --
  // the last bullet here deliberately does not match the canonical Plan Index URL.
  const result = await verifyRoutedDispatchManifest(
    { repo: "LouPineWays/Loop-Dee-Loup", executionIssue: 407 },
    {
      parseExecutionPlanImpl: async () => ({
        exitCode: 0,
        ok: true,
        repo: "LouPineWays/Loop-Dee-Loup",
        executionIssue: 407,
        plan: {
          planIndex: {
            commentId: 100,
            url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100",
            dispatchManifest: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-200",
          },
        },
      }),
      ghCommentViewImpl: async () => ({
        id: 200,
        html_url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-200",
        issue_url: "https://api.github.com/repos/LouPineWays/Loop-Dee-Loup/issues/407",
        body:
          "## Dispatch Manifest (v1)\n\n" +
          "- **Plan index:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100\n" +
          "- **Plan index:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-999\n",
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /Plan index backlink/i);
  assert.match(result.reason, /999/);
});

test("verifyRoutedDispatchManifest: rejects a Dispatch manifest pointer whose origin differs from the comment's real canonical origin", async () => {
  // Stage 1 review finding: the Plan Index's own Dispatch manifest pointer can be crafted
  // by an attacker to reuse the real repo/issue/commentId path segments under a foreign
  // host (e.g. "https://attacker.example/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-200"),
  // which shares path+fragment with the genuine GitHub comment permalink. Before this fix,
  // identity comparison ignored scheme+host entirely, so repo/issue/commentId equality alone
  // let this pointer pass as if it referenced the real comment. The commentId is still
  // extracted and the real comment #200 is genuinely fetched (repo/executionIssue come from
  // trusted params, not the pointer's host) -- but its real, GitHub-hosted canonical
  // `html_url` must not be treated as matching a pointer whose own origin is foreign.
  const result = await verifyRoutedDispatchManifest(
    { repo: "LouPineWays/Loop-Dee-Loup", executionIssue: 407 },
    {
      parseExecutionPlanImpl: async () => ({
        exitCode: 0,
        ok: true,
        repo: "LouPineWays/Loop-Dee-Loup",
        executionIssue: 407,
        plan: {
          planIndex: {
            commentId: 100,
            url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100",
            dispatchManifest: "https://attacker.example/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-200",
          },
        },
      }),
      ghCommentViewImpl: async () => ({
        id: 200,
        html_url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-200",
        issue_url: "https://api.github.com/repos/LouPineWays/Loop-Dee-Loup/issues/407",
        body:
          "## Dispatch Manifest (v1)\n\n- **Plan index:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100\n",
      }),
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /pointer mismatch/i);
});

test("checkReadyDispatch: ROUTED reports ERROR (exit 1), not NOT_READY, when the execution plan read fails operationally", async () => {
  // Stage 1 review finding: an operational read failure (network/gh api/unresolved repo
  // identity, surfaced here as parse-execution-plan.mjs's own exitCode 1) means authoritative
  // durable state was never actually reached -- distinct from exitCode 2 (state was read but
  // does not parse). Reporting this as NOT_READY would license the controller to fall through
  // to normal issue reasoning per AGENTS.md's NOT_READY contract, which is wrong for a control
  // read that simply never completed.
  const body =
    "- **Lifecycle:** ROUTED\n- **Execution:** #407\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 408 },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      parseExecutionPlanImpl: async () => ({
        exitCode: 1,
        message: "gh api call failed for LouPineWays/Loop-Dee-Loup issue #407 comments: network error",
      }),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.notEqual(result.state, "NOT_READY");
  assert.match(result.message, /operational failure/i);
});

test("checkReadyDispatch: ROUTED reports ERROR (exit 1), not NOT_READY, when the Dispatch manifest comment read-back throws", async () => {
  const body =
    "- **Lifecycle:** ROUTED\n- **Execution:** #407\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 408 },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      parseExecutionPlanImpl: async () => ({
        exitCode: 0,
        ok: true,
        repo: "LouPineWays/Loop-Dee-Loup",
        executionIssue: 407,
        plan: {
          planIndex: {
            commentId: 100,
            url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100",
            dispatchManifest: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-200",
          },
        },
      }),
      ghCommentViewImpl: async () => {
        throw new Error("network error");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.notEqual(result.state, "NOT_READY");
  assert.match(result.message, /operational failure/i);
});

test("evaluateReadyDispatchGate: EXECUTION_COMPLETE resolves to READY_TO_DISPATCH_INTEGRATION", () => {
  const body =
    "- **Lifecycle:** EXECUTION_COMPLETE\n- **Execution:** #407\n- **Route:** integration worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "READY_TO_DISPATCH_INTEGRATION");
  assert.equal(result.executionIssue, 407);
  assert.equal(result.route, "integration worker");
});

test("checkReadyDispatch: EXECUTION_COMPLETE reports exit 8, state READY_TO_DISPATCH_INTEGRATION", async () => {
  const body =
    "- **Lifecycle:** EXECUTION_COMPLETE\n- **Execution:** #407\n- **Route:** integration worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 408 },
    { ghIssueViewImpl: async () => ({ body, state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 8);
  assert.equal(result.state, "READY_TO_DISPATCH_INTEGRATION");
  assert.equal(result.route, "integration worker");
});

test("evaluateReadyDispatchGate: an unresolved Founder decision on a ROUTED control Issue is BLOCKED, not NOT_READY", () => {
  const body =
    "- **Lifecycle:** ROUTED\n- **Execution:** #407\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** choose an option\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "BLOCKED");
});

test("evaluateReadyDispatchGate: PLAN_READY/ROUTED/EXECUTION_COMPLETE still require a settled Execution pointer and Route, and reject a self-referential Execution pointer", () => {
  for (const lifecycle of ["PLAN_READY", "ROUTED", "EXECUTION_COMPLETE"]) {
    const missingExecution = `- **Lifecycle:** ${lifecycle}\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n`;
    assert.equal(evaluateReadyDispatchGate(missingExecution).status, "NOT_READY", `expected NOT_READY for ${lifecycle} with no Execution`);

    const missingRoute = `- **Lifecycle:** ${lifecycle}\n- **Execution:** #407\n- **Blocker:** none\n- **Founder decision:** none\n`;
    assert.equal(evaluateReadyDispatchGate(missingRoute).status, "NOT_READY", `expected NOT_READY for ${lifecycle} with no Route`);

    const selfRef = `- **Lifecycle:** ${lifecycle}\n- **Execution:** #42\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n`;
    const selfRefResult = evaluateReadyDispatchGate(selfRef, 42);
    assert.equal(selfRefResult.status, "NOT_READY", `expected NOT_READY for ${lifecycle} with a self-referential Execution pointer`);
  }
});
