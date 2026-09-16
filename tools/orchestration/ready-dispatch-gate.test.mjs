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
  isLegacyStage2NotStartedSentinel,
  parseExecutionPointer,
  readExecutionBulletField,
  findNearDuplicateBulletLabels,
  describeExecutionConflict,
  evaluateReadyDispatchGate,
  classifyAuditIssue,
  checkReadyDispatch,
  verifyRoutedDispatchManifest,
  parseOwnerRepoFromRemoteUrl,
  resolveRepoIdentity,
  upsertControlBullet,
  probeExistingPlan,
  probeReplanRequired,
  findExecutionLinkedPr,
  reconcileReadyPrBreakpoint,
  referencesExecutionIssue,
} from "./ready-dispatch-gate.mjs";
import { getActionEnvelope } from "./action-envelope.mjs";

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

// Issue #450 (the #428 live reproduction): the one demonstrated legacy pre-Stage-2 synonym,
// narrowly scoped -- never a broader natural-language acceptance.
test("isLegacyStage2NotStartedSentinel: matches only the exact demonstrated 'not started' synonym, case-insensitively and tolerating trailing explanation", () => {
  assert.equal(isLegacyStage2NotStartedSentinel("not started"), true);
  assert.equal(isLegacyStage2NotStartedSentinel("Not Started"), true);
  assert.equal(isLegacyStage2NotStartedSentinel("not started — audit not yet triggered"), true);
  assert.equal(isLegacyStage2NotStartedSentinel("none"), false);
  assert.equal(isLegacyStage2NotStartedSentinel("pending"), false);
  assert.equal(isLegacyStage2NotStartedSentinel("later"), false);
  assert.equal(isLegacyStage2NotStartedSentinel("not yet"), false);
  assert.equal(isLegacyStage2NotStartedSentinel(""), false);
  assert.equal(isLegacyStage2NotStartedSentinel(null), false);
});

// Stage 1 review finding on PR #569: a trailing explanation that itself carries a parseable
// issue/PR reference contradicts the "Stage 2 has not started" reading and must fail closed
// instead of being treated as the legacy pre-Stage-2 sentinel.
test("isLegacyStage2NotStartedSentinel: rejects a trailing explanation that carries a parseable issue/PR reference", () => {
  assert.equal(isLegacyStage2NotStartedSentinel("not started — previous audit #480"), false);
  assert.equal(
    isLegacyStage2NotStartedSentinel("not started — see https://github.com/LouPineWays/Loop-Dee-Loup/issues/480"),
    false,
  );
  assert.equal(
    isLegacyStage2NotStartedSentinel("not started — see https://github.com/LouPineWays/Loop-Dee-Loup/pull/480"),
    false,
  );
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

test("checkReadyDispatch: reads the control Issue exactly once, plus exactly one narrow execution-linked PR lookup before authorizing READY_TO_DISPATCH (issue #456 unit 456-B)", async () => {
  let issueCalls = 0;
  let prListCalls = 0;
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 311 },
    {
      ghIssueViewImpl: async ({ repo, number }) => {
        issueCalls++;
        assert.equal(repo, "LouPineWays/Loop-Dee-Loup");
        assert.equal(number, 311);
        return { body: ISSUE_311_BODY, state: "OPEN" };
      },
      ghPrListImpl: async ({ repo, executionIssue }) => {
        prListCalls++;
        assert.equal(repo, "LouPineWays/Loop-Dee-Loup");
        assert.equal(executionIssue, 310);
        return [];
      },
    },
  );
  assert.equal(issueCalls, 1);
  assert.equal(prListCalls, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "READY_TO_DISPATCH");
  assert.equal(result.stopAfter, true);
  assert.equal(result.executionIssue, 310);
  assert.equal(result.route, "implementation worker");
  // Issue #486: every verdict this gate returns carries its deterministic action envelope.
  assert.deepEqual(result.actionEnvelope, { mode: "bounded", authorizedActions: ["dispatch-execution-worker"] });
});

test("checkReadyDispatch: a closed control Issue is NOT_READY regardless of body content", async () => {
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 311 },
    { ghIssueViewImpl: async () => ({ body: ISSUE_311_BODY, state: "CLOSED" }) },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "NOT_READY");
  // Issue #486: NOT_READY's envelope is "fallthrough" — it hands off to the Decomposition
  // boundary rather than being policed by the bounded/none action-envelope mechanism.
  assert.deepEqual(result.actionEnvelope, { mode: "fallthrough", authorizedActions: [] });
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
  // Issue #486, corrected by issue #437/#610 Stage 1 finding 1: CONTROL_301_BODY's own
  // Blocker field is non-`none` (free prose, not merely a Founder-decision-only or
  // blocking-Lifecycle-only BLOCKED), so this is exactly the one case AGENTS.md § Session
  // execution's BLOCKED paragraph authorizes a single reconcile-control-blocker.mjs step for
  // before treating BLOCKED as a genuine stop — the gate must expose that as a `chain`
  // envelope, not the unconditional `none` this test asserted before #610. The reconciler
  // itself still fails closed on this exact free-prose shape (no recognized "Blocked by
  // #N..." clause) once actually invoked; that is a separate, already-covered guarantee
  // (reconcile-control-blocker.test.mjs's own Verification case 5), not this test's concern.
  assert.deepEqual(result.actionEnvelope, { mode: "chain", authorizedActions: ["run-reconcile-control-blocker"] });
});

// Issue #437/#610 Stage 1 finding 1: a BLOCKED verdict caused solely by a non-`none` Founder
// decision (Blocker itself reads "none") has no reconciliation step to run — reconcile-
// control-blocker.mjs only ever reconciles a Blocker field, never a Founder decision — so its
// envelope must stay the unconditional `none` this mechanism always returned, not become
// `chain` merely because the verdict is BLOCKED.
test("checkReadyDispatch: a BLOCKED control Issue caused only by a non-none Founder decision keeps the unconditional 'none' envelope (Stage 1 finding 1)", async () => {
  const body = "- **Lifecycle:** READY\n- **Execution:** #5\n- **Route:** implementation worker\n- **Blocker:** none\n- **Founder decision:** ship the growth-hack banner or not?\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 500 },
    { ghIssueViewImpl: async () => ({ body, state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "BLOCKED");
  assert.deepEqual(result.actionEnvelope, { mode: "none", authorizedActions: [] });
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
  // Stage 1 finding on PR #534 (issue #486): a post-PR mid-cycle NOT_READY carries
  // `postPrLifecycle` so action-envelope.mjs classifies it as `chain` (must route through
  // next-review-transition-gate.mjs), never AGENTS.md's ordinary unpoliced NOT_READY fallthrough.
  assert.equal(result.postPrLifecycle, "EXECUTING");
  assert.deepEqual(result.actionEnvelope, {
    mode: "chain",
    authorizedActions: ["run-next-review-transition-gate"],
  });
});

test("checkReadyDispatch: NOT_READY for a genuinely pre-PR/unrecognized reason (not one of the five post-PR mid-cycle Lifecycle values) stays plain fallthrough", async () => {
  const body = "- **Lifecycle:** SOMETHING_ELSE\n- **Execution:** #5\n- **Route:** implementation worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 401 },
    { ghIssueViewImpl: async () => ({ body, state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "NOT_READY");
  assert.ok(!("postPrLifecycle" in result));
  assert.deepEqual(result.actionEnvelope, { mode: "fallthrough", authorizedActions: [] });
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

test("checkReadyDispatch: a directly-dispatched Audit Issue that is already CLOSED still classifies as AUDIT_ISSUE_DETECTED, never the generic 'is CLOSED, not OPEN' NOT_READY (Stage 1 review finding on PR #435: the open-state guard previously ran before audit classification, so a closed canonical Audit Issue could never reach next-review-transition-gate.mjs's own idempotent ALREADY_TERMINAL result)", async () => {
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 9006 },
    { ghIssueViewImpl: async () => ({ body: auditIssueBody("CLEAN"), state: "CLOSED" }) },
  );
  assert.equal(result.exitCode, 9);
  assert.equal(result.state, "AUDIT_ISSUE_DETECTED");
  assert.equal(result.auditIssue, 9006);
  assert.equal(result.nextCommand, "node tools/orchestration/next-review-transition-gate.mjs --audit-issue 9006");
  // Issue #486: AUDIT_ISSUE_DETECTED's envelope is "chain" — it authorizes exactly one
  // further gate invocation, whose own verdict then governs everything after that.
  assert.deepEqual(result.actionEnvelope, { mode: "chain", authorizedActions: ["run-next-review-transition-gate"] });
});

test("checkReadyDispatch: missing required args fails closed with exit 1", async () => {
  const result = await checkReadyDispatch({ repo: null, controlIssue: null });
  assert.equal(result.exitCode, 1);
  // Issue #486: an operational error is not a verdict on control-Issue content at all, so it
  // must never carry an actionEnvelope that could be mistaken for one.
  assert.ok(!("actionEnvelope" in result));
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
      ghPrListImpl: async () => [],
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
      ghPrListImpl: async () => [],
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
      ghPrListImpl: async () => [],
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

test("checkReadyDispatch: the literal live #408 body reports exit 5, state READY_TO_DISPATCH_PLANNING, from a single control-Issue read, when no plan exists yet (397-E; issue #498 unit 498-A's idempotent-recovery probe correctly finds nothing to recover)", async () => {
  let calls = 0;
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 408 },
    {
      ghIssueViewImpl: async () => {
        calls++;
        return { body: ISSUE_408_BODY, state: "OPEN" };
      },
      // Issue #498 unit 498-A: checkReadyDispatch now probes for an already-existing plan
      // before authorizing a fresh planning dispatch. Injected here (rather than left to the
      // real default, which would call the real `gh` CLI against a live issue) so this test
      // stays network-isolated, matching this file's existing injection convention.
      parseExecutionPlanImpl: async () => ({ exitCode: 2, ok: false, errors: ["fixture: no Plan Index yet"] }),
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 5);
  assert.equal(result.state, "READY_TO_DISPATCH_PLANNING");
  assert.equal(result.stopAfter, true);
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

test("checkReadyDispatch: a #398-shaped PLAN_READY body reports exit 6, state READY_TO_RUN_DISPATCH_MANIFEST, from a single control-Issue read, when no manifest exists yet (397-E; issue #498 unit 498-A's idempotent-recovery probe correctly finds nothing to recover)", async () => {
  let calls = 0;
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 398 },
    {
      ghIssueViewImpl: async () => {
        calls++;
        return { body: ISSUE_398_PLAN_READY_BODY, state: "OPEN" };
      },
      // Issue #498 unit 498-A: checkReadyDispatch now probes for an already-verified
      // manifest before authorizing a fresh Route/Prepare run. Injected here (rather than
      // left to the real default `gh` CLI call) so this test stays network-isolated.
      parseExecutionPlanImpl: async () => ({ exitCode: 2, ok: false, errors: ["fixture: no Dispatch Manifest yet"] }),
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 6);
  assert.equal(result.state, "READY_TO_RUN_DISPATCH_MANIFEST");
  assert.equal(result.stopAfter, true);
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

// -- Issue #493: near-duplicate control bullet labels (the #440 regression) ------------------

test("findNearDuplicateBulletLabels: detects Stage 2 (current)/(updated)/note lookalikes coexisting with the canonical field", () => {
  const body = "- **Stage 2:** #480\n- **Stage 2 (current):** #492\n- **Stage 2 (updated):** #493\n- **Stage 2 note:** see below\n";
  const conflicts = findNearDuplicateBulletLabels(body, "Stage 2");
  assert.deepEqual(
    conflicts.map((c) => c.label).sort(),
    ["Stage 2 (current)", "Stage 2 (updated)", "Stage 2 note"].sort(),
  );
});

test("findNearDuplicateBulletLabels: exact canonical match alone is never flagged", () => {
  assert.deepEqual(findNearDuplicateBulletLabels("- **Stage 2:** #480\n", "Stage 2"), []);
});

// Stage 1 review finding on this PR: the original boundary recognized only whitespace/"("
// and missed punctuation-delimited qualifiers, which could still leave a stale canonical
// field authoritative (e.g. "Stage 2-current" beside canonical "Stage 2").
test("findNearDuplicateBulletLabels: punctuation-delimited Stage 2 lookalikes (hyphen, slash, bracket, em-dash) are each flagged", () => {
  const body =
    "- **Stage 2:** #480\n" +
    "- **Stage 2-current:** #492\n" +
    "- **Stage 2/current:** #493\n" +
    "- **Stage 2[current]:** #494\n" +
    "- **Stage 2—current:** #495\n";
  const conflicts = findNearDuplicateBulletLabels(body, "Stage 2");
  assert.deepEqual(
    conflicts.map((c) => c.label).sort(),
    ["Stage 2-current", "Stage 2/current", "Stage 2[current]", "Stage 2—current"].sort(),
  );
});

test("findNearDuplicateBulletLabels: the punctuation-boundary rule applies equally to PR and Execution", () => {
  assert.equal(findNearDuplicateBulletLabels("- **PR:** #376\n- **PR-current:** #400\n", "PR").length, 1);
  assert.equal(
    findNearDuplicateBulletLabels("- **Execution:** #310\n- **Execution-current:** #999\n", "Execution", [
      "Execution issue",
    ]).length,
    1,
  );
});

test("findNearDuplicateBulletLabels: a longer alphanumeric word/token sharing only a character prefix is never a near-duplicate", () => {
  assert.deepEqual(findNearDuplicateBulletLabels("- **Stage 20:** #480\n", "Stage 2"), []);
  assert.deepEqual(findNearDuplicateBulletLabels("- **PR:** #376\n- **Precondition:** #400\n", "PR"), []);
});

test("findNearDuplicateBulletLabels: an allowed alias is recognized, never flagged as a near-duplicate of the canonical label", () => {
  const body = "- **Execution:** #310\n- **Execution issue:** #310\n";
  assert.deepEqual(findNearDuplicateBulletLabels(body, "Execution", ["Execution issue"]), []);
});

test("findNearDuplicateBulletLabels: false-positive control -- unrelated bold bullets and prose merely containing the word do not trigger the guard", () => {
  const body =
    "- **Previous Stage 2:** #100\n" +
    "- **Parent execution issue:** #200\n" +
    "Some ordinary prose mentioning PR review and Execution planning does not use the bullet shape at all.\n" +
    "- **Route:** implementation worker\n";
  assert.deepEqual(findNearDuplicateBulletLabels(body, "Stage 2"), []);
  assert.deepEqual(findNearDuplicateBulletLabels(body, "PR"), []);
  assert.deepEqual(findNearDuplicateBulletLabels(body, "Execution", ["Execution issue"]), []);
});

test("readExecutionBulletField: a recognized Execution bullet coexisting with an unrecognized near-duplicate label is a conflict", () => {
  const result = readExecutionBulletField("- **Execution:** #310\n- **Execution (current):** #407\n");
  assert.equal(result.conflict, true);
  assert.equal(result.nearDuplicate, true);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].label, "Execution (current)");
});

test("readExecutionBulletField: an unrecognized near-duplicate of the live 'Execution issue' spelling is also a conflict", () => {
  const result = readExecutionBulletField("- **Execution issue:** #407\n- **Execution issue (updated):** #408\n");
  assert.equal(result.conflict, true);
  assert.equal(result.nearDuplicate, true);
});

test("describeExecutionConflict: composes a distinct reason for the near-duplicate-label shape vs. the alias-mismatch shape", () => {
  const aliasMismatch = describeExecutionConflict({ conflict: true, legacy: "#310", liveSpelling: "#407" });
  assert.match(aliasMismatch, /#310/);
  assert.match(aliasMismatch, /#407/);

  const nearDup = describeExecutionConflict({
    conflict: true,
    nearDuplicate: true,
    matches: [{ label: "Execution (current)", raw: "#407" }],
  });
  assert.match(nearDup, /Execution \(current\)/);
  assert.match(nearDup, /#407/);
  assert.match(nearDup, /near-duplicate/i);
});

test("evaluateReadyDispatchGate: an unrecognized Execution near-duplicate label fails closed to NOT_READY, never silently dispatching against the canonical value", () => {
  const body =
    "- **Lifecycle:** READY\n- **Execution:** #310\n- **Execution (current):** #999\n- **Route:** implementation worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "NOT_READY");
  assert.ok(!("executionIssue" in result));
  assert.ok(result.reasons.some((r) => r.toLowerCase().includes("near-duplicate")));
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

test("checkReadyDispatch: PLAN_READY reports exit 6, state READY_TO_RUN_DISPATCH_MANIFEST, when no manifest exists yet (issue #498 unit 498-A's idempotent-recovery probe correctly finds nothing to recover)", async () => {
  const body =
    "- **Lifecycle:** PLAN_READY\n- **Execution:** #407\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 408 },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      parseExecutionPlanImpl: async () => ({ exitCode: 2, ok: false, errors: ["fixture: no Dispatch Manifest yet"] }),
    },
  );
  assert.equal(result.exitCode, 6);
  assert.equal(result.state, "READY_TO_RUN_DISPATCH_MANIFEST");
  assert.equal(result.stopAfter, true);
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
  assert.equal(result.stopAfter, true);
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

// Stage 1 review finding on PR #521 (P2): the checks above only confirmed the manifest
// comment's own heading and Plan Index backlink -- a manifest with zero, duplicate, or
// extra per-unit "route=.../dispatch_ready=..." entries relative to the Plan Index's own
// Units list used to pass this probe anyway, letting checkReadyDispatch project
// Lifecycle: ROUTED with no authoritative unit routes for the Execute stage.

function manifestFixture({ repo = "LouPineWays/Loop-Dee-Loup", executionIssue = 407, units, manifestUnitLines }) {
  const planIndexUrl = `https://github.com/${repo}/issues/${executionIssue}#issuecomment-100`;
  const manifestUrl = `https://github.com/${repo}/issues/${executionIssue}#issuecomment-200`;
  return {
    repo,
    executionIssue,
    parseExecutionPlanImpl: async () => ({
      exitCode: 0,
      ok: true,
      repo,
      executionIssue,
      plan: {
        planIndex: { commentId: 100, url: planIndexUrl, dispatchManifest: manifestUrl },
        units,
      },
    }),
    ghCommentViewImpl: async () => ({
      id: 200,
      html_url: manifestUrl,
      issue_url: `https://api.github.com/repos/${repo}/issues/${executionIssue}`,
      body:
        `## Dispatch Manifest (v1)\n\n- **Plan index:** ${planIndexUrl}\n` +
        manifestUnitLines.map((line) => `- ${line}\n`).join(""),
    }),
  };
}

test("verifyRoutedDispatchManifest: succeeds when every Plan Index unit has exactly one matching manifest entry", async () => {
  const fixture = manifestFixture({
    units: { "498-A": {}, "498-B": {} },
    manifestUnitLines: [
      "498-A: route=stronger/general worker dispatch_ready=true note=none",
      "498-B: route=stronger/general worker dispatch_ready=false note=blocked on 498-A",
    ],
  });
  const { repo, executionIssue, ...impls } = fixture;
  const result = await verifyRoutedDispatchManifest({ repo, executionIssue }, impls);
  assert.equal(result.ok, true);
});

test("verifyRoutedDispatchManifest: fails closed when the manifest is missing an entry for a Plan Index unit", async () => {
  const fixture = manifestFixture({
    units: { "498-A": {}, "498-B": {} },
    manifestUnitLines: ["498-A: route=stronger/general worker dispatch_ready=true note=none"],
  });
  const { repo, executionIssue, ...impls } = fixture;
  const result = await verifyRoutedDispatchManifest({ repo, executionIssue }, impls);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing entries for unit\(s\): 498-B/);
});

test("verifyRoutedDispatchManifest: fails closed on a duplicate manifest entry for the same unit", async () => {
  const fixture = manifestFixture({
    units: { "498-A": {} },
    manifestUnitLines: [
      "498-A: route=stronger/general worker dispatch_ready=true note=none",
      "498-A: route=stronger/general worker dispatch_ready=false note=stale duplicate",
    ],
  });
  const { repo, executionIssue, ...impls } = fixture;
  const result = await verifyRoutedDispatchManifest({ repo, executionIssue }, impls);
  assert.equal(result.ok, false);
  assert.match(result.reason, /duplicate entries for unit\(s\): 498-A/);
});

test("verifyRoutedDispatchManifest: fails closed on a manifest entry for a unit not in the Plan Index", async () => {
  const fixture = manifestFixture({
    units: { "498-A": {} },
    manifestUnitLines: [
      "498-A: route=stronger/general worker dispatch_ready=true note=none",
      "498-Z: route=stronger/general worker dispatch_ready=true note=unknown unit",
    ],
  });
  const { repo, executionIssue, ...impls } = fixture;
  const result = await verifyRoutedDispatchManifest({ repo, executionIssue }, impls);
  assert.equal(result.ok, false);
  assert.match(result.reason, /entries for unit\(s\) not in the Plan Index: 498-Z/);
});

test("verifyRoutedDispatchManifest: fails closed on a manifest with the required heading and backlink but zero unit entries", async () => {
  const fixture = manifestFixture({ units: { "498-A": {}, "498-B": {} }, manifestUnitLines: [] });
  const { repo, executionIssue, ...impls } = fixture;
  const result = await verifyRoutedDispatchManifest({ repo, executionIssue }, impls);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing entries for unit\(s\): 498-A, 498-B/);
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
  assert.equal(result.stopAfter, true);
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

// Issue #444 unit 444-A: the #439/#440/#443 live reproduction -- EXECUTION_COMPLETE must
// never return READY_TO_DISPATCH_INTEGRATION once the control body's own "PR"/"Stage 1"
// bullets already show the execution crossed the PR/review boundary. Covers #444's own
// seven-item Verification list directly (scenarios 1-6 below; scenario 7, the broader
// tools/orchestration/**.test.mjs run, is a suite-level verification step, not a unit test).

test("evaluateReadyDispatchGate: EXECUTION_COMPLETE Verification scenario 1 -- PR: none, Stage 1: none still returns READY_TO_DISPATCH_INTEGRATION (both bullets present-and-none)", () => {
  const body =
    "- **Lifecycle:** EXECUTION_COMPLETE\n- **Execution:** #407\n- **Route:** integration worker\n- **PR:** none\n- **Stage 1:** none\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "READY_TO_DISPATCH_INTEGRATION");
  assert.equal(result.executionIssue, 407);
});

test("evaluateReadyDispatchGate: EXECUTION_COMPLETE Verification scenario 2 -- PR already recorded (Stage 1: none) never returns integration dispatch", () => {
  const body =
    "- **Lifecycle:** EXECUTION_COMPLETE\n- **Execution:** #439\n- **Route:** integration worker\n- **PR:** #443\n- **Stage 1:** none\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "NOT_READY");
  assert.equal(result.postPrLifecycle, "EXECUTION_COMPLETE_PR_ESTABLISHED");
  assert.ok(result.reasons.some((r) => r.includes("PR is already recorded") && r.includes("#443")));
});

test("evaluateReadyDispatchGate: EXECUTION_COMPLETE Verification scenario 3 -- Stage 1: requested alone (Lifecycle still EXECUTION_COMPLETE, PR: none) never returns integration dispatch", () => {
  const body =
    "- **Lifecycle:** EXECUTION_COMPLETE\n- **Execution:** #439\n- **Route:** integration worker\n- **PR:** none\n- **Stage 1:** requested\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "NOT_READY");
  assert.equal(result.postPrLifecycle, "EXECUTION_COMPLETE_PR_ESTABLISHED");
  assert.ok(result.reasons.some((r) => r.includes("Stage 1 is already") && r.includes("requested")));
});

test("evaluateReadyDispatchGate: EXECUTION_COMPLETE Verification scenario 4 -- the real #440 fixture (PR #443 + Stage 1 requested at head 911cac6d6bd56059020574ad4de5ef3f54d552cd) returns a deterministic post-PR/non-integration result", () => {
  const body =
    "- **Execution issue:** #439\n" +
    "- **Lifecycle:** EXECUTION_COMPLETE\n" +
    "- **Route:** bounded implementation worker (unit 439-A) — DONE\n" +
    "- **PR:** #443 (https://github.com/LouPineWays/Loop-Dee-Loup/pull/443), head 911cac6d6bd56059020574ad4de5ef3f54d552cd\n" +
    "- **Stage 1:** requested\n" +
    "- **Stage 2:** none\n" +
    "- **Blocker:** none\n" +
    "- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body);
  assert.notEqual(result.status, "READY_TO_DISPATCH_INTEGRATION");
  assert.equal(result.status, "NOT_READY");
  assert.equal(result.postPrLifecycle, "EXECUTION_COMPLETE_PR_ESTABLISHED");
  const envelope = getActionEnvelope(result.status, result);
  assert.equal(envelope.mode, "chain");
  assert.deepEqual(envelope.authorizedActions, ["run-next-review-transition-gate"]);
});

test("checkReadyDispatch: the real #440 fixture never reports exit 8/READY_TO_DISPATCH_INTEGRATION", async () => {
  const body =
    "- **Execution issue:** #439\n" +
    "- **Lifecycle:** EXECUTION_COMPLETE\n" +
    "- **Route:** bounded implementation worker (unit 439-A) — DONE\n" +
    "- **PR:** #443 (https://github.com/LouPineWays/Loop-Dee-Loup/pull/443), head 911cac6d6bd56059020574ad4de5ef3f54d552cd\n" +
    "- **Stage 1:** requested\n" +
    "- **Stage 2:** none\n" +
    "- **Blocker:** none\n" +
    "- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 440 },
    { ghIssueViewImpl: async () => ({ body, state: "OPEN" }) },
  );
  assert.notEqual(result.exitCode, 8);
  assert.notEqual(result.state, "READY_TO_DISPATCH_INTEGRATION");
  assert.equal(result.state, "NOT_READY");
  assert.equal(result.postPrLifecycle, "EXECUTION_COMPLETE_PR_ESTABLISHED");
});

test("evaluateReadyDispatchGate: EXECUTION_COMPLETE Verification scenario 5 -- a malformed/conflicting PR field fails closed, never integration dispatch", () => {
  const notNoneNotReference =
    "- **Lifecycle:** EXECUTION_COMPLETE\n- **Execution:** #439\n- **Route:** integration worker\n- **PR:** pending review\n- **Stage 1:** none\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result1 = evaluateReadyDispatchGate(notNoneNotReference);
  assert.equal(result1.status, "NOT_READY");
  assert.equal(result1.postPrLifecycle, "EXECUTION_COMPLETE_PR_ESTABLISHED");

  const nearDuplicateLabel =
    "- **Lifecycle:** EXECUTION_COMPLETE\n- **Execution:** #439\n- **Route:** integration worker\n- **PR:** none\n- **PR (current):** #443\n- **Stage 1:** none\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result2 = evaluateReadyDispatchGate(nearDuplicateLabel);
  assert.equal(result2.status, "NOT_READY");
  assert.equal(result2.postPrLifecycle, "EXECUTION_COMPLETE_PR_ESTABLISHED");
  assert.ok(result2.reasons.some((r) => r.includes("ambiguous")));
});

test("evaluateReadyDispatchGate: EXECUTION_COMPLETE Verification scenario 6 -- READY_FOR_PLAN/PLAN_READY/ROUTED/READY ignore a present PR/Stage 1 bullet (scoped strictly to EXECUTION_COMPLETE)", () => {
  const readyFor =
    "- **Lifecycle:** READY_FOR_PLAN\n- **Execution:** #407\n- **Route:** planning worker\n- **PR:** #443\n- **Stage 1:** requested\n- **Blocker:** none\n- **Founder decision:** none\n";
  assert.equal(evaluateReadyDispatchGate(readyFor).status, "READY_TO_DISPATCH_PLANNING");

  const planReady =
    "- **Lifecycle:** PLAN_READY\n- **Execution:** #407\n- **Route:** planning worker\n- **PR:** #443\n- **Stage 1:** requested\n- **Blocker:** none\n- **Founder decision:** none\n";
  assert.equal(evaluateReadyDispatchGate(planReady).status, "READY_TO_RUN_DISPATCH_MANIFEST");

  const routed =
    "- **Lifecycle:** ROUTED\n- **Execution:** #407\n- **Route:** planning worker\n- **PR:** #443\n- **Stage 1:** requested\n- **Blocker:** none\n- **Founder decision:** none\n";
  assert.equal(evaluateReadyDispatchGate(routed).status, "READY_TO_VERIFY_DISPATCH_MANIFEST");

  const ready =
    "- **Lifecycle:** READY\n- **Execution:** #407\n- **Route:** planning worker\n- **PR:** #443\n- **Stage 1:** requested\n- **Blocker:** none\n- **Founder decision:** none\n";
  assert.equal(evaluateReadyDispatchGate(ready).status, "READY_TO_DISPATCH");
});

test("evaluateReadyDispatchGate: EXECUTION_COMPLETE with both PR and Stage 1 bullets simply absent still returns READY_TO_DISPATCH_INTEGRATION (existing fixture shape unaffected)", () => {
  const body =
    "- **Lifecycle:** EXECUTION_COMPLETE\n- **Execution:** #407\n- **Route:** integration worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "READY_TO_DISPATCH_INTEGRATION");
});

// Issue #558 Stage 1 correction, finding 1 (P2): a noncanonical "PR ..." bullet must never
// manufacture PR/review-boundary state on its own when no canonical "- **PR:**" bullet is
// present at all -- negative control for the near-duplicate scan now being gated on
// `parseControlBullet(body, "PR") !== null`.
test("evaluateReadyDispatchGate: EXECUTION_COMPLETE with a noncanonical 'PR notes' bullet and no canonical PR bullet still returns READY_TO_DISPATCH_INTEGRATION (no false ambiguity)", () => {
  const body =
    "- **Lifecycle:** EXECUTION_COMPLETE\n- **Execution:** #407\n- **Route:** integration worker\n- **PR notes:** not created yet\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "READY_TO_DISPATCH_INTEGRATION");
  assert.equal(result.executionIssue, 407);
});

// Issue #558 Stage 1 correction, finding 2 (P1): a stale `Lifecycle: EXECUTION_COMPLETE` with
// an already-established PR/Stage 1 boundary must resolve to exactly one deterministic next
// action -- chain to next-review-transition-gate.mjs -- under both the machine action envelope
// and (per the AGENTS.md edit accompanying this correction) the governing prose, never a
// decomposition/free-reasoning fallthrough and never a repeat Integration/PR dispatch.
test("evaluateReadyDispatchGate + getActionEnvelope: established PR/Stage 1 under stale EXECUTION_COMPLETE yields exactly one deterministic post-PR continuation, never fallthrough and never a repeat integration dispatch", () => {
  const body =
    "- **Lifecycle:** EXECUTION_COMPLETE\n- **Execution:** #439\n- **Route:** integration worker\n- **PR:** #443\n- **Stage 1:** requested\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = evaluateReadyDispatchGate(body);
  assert.equal(result.status, "NOT_READY");
  assert.notEqual(result.status, "READY_TO_DISPATCH_INTEGRATION");
  assert.equal(result.postPrLifecycle, "EXECUTION_COMPLETE_PR_ESTABLISHED");

  const envelope = getActionEnvelope(result.status, result);
  // "chain" (never "fallthrough" or "bounded"/"none") is the one mode that both matches
  // AGENTS.md's own "does not fall through to free reasoning either" exception and hands off
  // to exactly one further deterministic gate invocation.
  assert.equal(envelope.mode, "chain");
  assert.deepEqual(envelope.authorizedActions, ["run-next-review-transition-gate"]);
});

// Issue #498 unit 498-A: durable thin-control-state projection at the PLAN_READY/ROUTED
// breakpoints (the 2026-09-10 #500 stranded-state fix), plus the stopAfter contract on
// every pre-PR terminal verdict.

test("upsertControlBullet: replaces an existing bullet's value in place, preserving surrounding lines", () => {
  const body = "- **Lifecycle:** PLAN_READY\n- **Execution:** #407\n- **Route:** planning worker\n";
  const next = upsertControlBullet(body, "Lifecycle", "ROUTED");
  assert.equal(next, "- **Lifecycle:** ROUTED\n- **Execution:** #407\n- **Route:** planning worker\n");
});

test("upsertControlBullet: case-insensitive on the label, matching parseControlBullet's own read-side convention", () => {
  const body = "- **lifecycle:** PLAN_READY\n";
  const next = upsertControlBullet(body, "Lifecycle", "ROUTED");
  assert.equal(next, "- **Lifecycle:** ROUTED\n");
});

test("upsertControlBullet: inserts a brand-new bullet immediately after the Lifecycle bullet when the label is absent", () => {
  const body = "- **Lifecycle:** READY_FOR_PLAN\n- **Execution:** #407\n- **Route:** planning worker\n";
  const next = upsertControlBullet(body, "Plan", "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100");
  assert.equal(
    next,
    "- **Lifecycle:** READY_FOR_PLAN\n" +
      "- **Plan:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100\n" +
      "- **Execution:** #407\n- **Route:** planning worker\n",
  );
});

test("upsertControlBullet: appends the bullet when even a Lifecycle bullet is absent to anchor against", () => {
  const body = "Some legacy unsplit Issue body with no control bullets at all.";
  const next = upsertControlBullet(body, "Plan", "https://example.com/issues/1#issuecomment-1");
  assert.equal(next, "Some legacy unsplit Issue body with no control bullets at all.\n- **Plan:** https://example.com/issues/1#issuecomment-1\n");
});

test("upsertControlBullet: chained calls compose Lifecycle-then-Plan updates, matching the READY_TO_PROJECT_PLAN_READY proposedBody shape", () => {
  const body = "- **Lifecycle:** READY_FOR_PLAN\n- **Execution:** #407\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const next = upsertControlBullet(
    upsertControlBullet(body, "Lifecycle", "PLAN_READY"),
    "Plan",
    "https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100",
  );
  assert.equal(
    next,
    "- **Lifecycle:** PLAN_READY\n" +
      "- **Plan:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/407#issuecomment-100\n" +
      "- **Execution:** #407\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n",
  );
});

// Stage 1 review finding on PR #521 (P2): a template-shaped control body (no ad hoc
// "- **Lifecycle:**" bullet at all -- .github/ISSUE_TEMPLATE/parent-execution.yml renders
// "### State" instead) used to have "Lifecycle" updates always append a brand-new bullet
// at the very end of the body -- landing inside the template's final "### Next slice /
// resulting slices" block -- while leaving the canonical "### State" value stale and
// contradictory. Updating "### State" in place, and placing any other ad hoc bullet (e.g.
// "Plan") inside the template's own "### Current state" field, closes both halves of the
// finding.

function templateShapedBody() {
  return [
    "### State",
    "",
    "READY_FOR_PLAN",
    "",
    "### Accepted outcome",
    "",
    "Ship the thing.",
    "",
    "### Current state",
    "",
    "- **Execution:** #500",
    "- **Route:** planning worker",
    "",
    "### Settled decisions",
    "",
    "None.",
    "",
    "### Current blocker",
    "",
    "None.",
    "",
    "### Founder interrupt",
    "",
    "None.",
    "",
    "### Next slice / resulting slices",
    "",
    "None.",
    "",
  ].join("\n");
}

test("upsertControlBullet: on a template-shaped body, a Lifecycle update replaces the ### State heading's own value in place", () => {
  const next = upsertControlBullet(templateShapedBody(), "Lifecycle", "PLAN_READY");
  const lines = next.split("\n");
  const stateHeadingIdx = lines.indexOf("### State");
  assert.equal(lines[stateHeadingIdx + 2], "PLAN_READY");
  // No stray ad hoc "- **Lifecycle:**" bullet was introduced anywhere in the body.
  assert.ok(!lines.some((l) => /^-\s*\*\*Lifecycle:\*\*/i.test(l)));
});

test("upsertControlBullet: on a template-shaped body, a non-Lifecycle bullet (Plan) is placed inside ### Current state, not past ### Next slice", () => {
  const next = upsertControlBullet(
    templateShapedBody(),
    "Plan",
    "https://github.com/LouPineWays/Loop-Dee-Loup/issues/500#issuecomment-1",
  );
  const lines = next.split("\n");
  const currentStateIdx = lines.indexOf("### Current state");
  const settledDecisionsIdx = lines.indexOf("### Settled decisions");
  const planLineIdx = lines.findIndex((l) => /^-\s*\*\*Plan:\*\*/i.test(l));
  assert.ok(planLineIdx > currentStateIdx && planLineIdx < settledDecisionsIdx);
  // The last block (Next slice / resulting slices) is untouched.
  const nextSliceIdx = lines.indexOf("### Next slice / resulting slices");
  assert.equal(lines[nextSliceIdx + 2], "None.");
});

test("upsertControlBullet: chained Lifecycle-then-Plan on a template-shaped body converges ### State and adds Plan to ### Current state", () => {
  const next = upsertControlBullet(
    upsertControlBullet(templateShapedBody(), "Lifecycle", "PLAN_READY"),
    "Plan",
    "https://github.com/LouPineWays/Loop-Dee-Loup/issues/500#issuecomment-1",
  );
  const lines = next.split("\n");
  const stateHeadingIdx = lines.indexOf("### State");
  assert.equal(lines[stateHeadingIdx + 2], "PLAN_READY");
  const currentStateIdx = lines.indexOf("### Current state");
  const settledDecisionsIdx = lines.indexOf("### Settled decisions");
  const planLineIdx = lines.findIndex((l) => /^-\s*\*\*Plan:\*\*/i.test(l));
  assert.ok(planLineIdx > currentStateIdx && planLineIdx < settledDecisionsIdx);
});

// Stage 1 review finding on PR #544 (issue #542's close-control.mjs correction): a
// template-shaped body's "Blocker"/"Founder decision" updates used to fall through to the
// generic "insert a new ad hoc bullet inside ### Current state" branch instead of the
// template's own dedicated "### Current blocker"/"### Founder interrupt" heading fields --
// leaving those headings' own stale, contradictory text in place even after terminalization
// claimed a truthful "none" state.

test("upsertControlBullet: on a template-shaped body, a Blocker update replaces the ### Current blocker heading's own value in place", () => {
  const body = templateShapedBody().replace("### Current blocker\n\nNone.", "### Current blocker\n\nWaiting on founder input.");
  const next = upsertControlBullet(body, "Blocker", "none");
  const lines = next.split("\n");
  const headingIdx = lines.indexOf("### Current blocker");
  assert.equal(lines[headingIdx + 2], "none");
  // No stray ad hoc "- **Blocker:**" bullet was introduced anywhere in the body.
  assert.ok(!lines.some((l) => /^-\s*\*\*Blocker:\*\*/i.test(l)));
});

test("upsertControlBullet: on a template-shaped body, a Founder decision update replaces the ### Founder interrupt heading's own value in place", () => {
  const body = templateShapedBody().replace("### Founder interrupt\n\nNone.", "### Founder interrupt\n\nPricing model TBD.");
  const next = upsertControlBullet(body, "Founder decision", "none");
  const lines = next.split("\n");
  const headingIdx = lines.indexOf("### Founder interrupt");
  assert.equal(lines[headingIdx + 2], "none");
  assert.ok(!lines.some((l) => /^-\s*\*\*Founder decision:\*\*/i.test(l)));
});

test("upsertControlBullet: chained Lifecycle/Blocker/Founder-decision updates on a template-shaped body converge every dedicated heading, none stray into ### Current state", () => {
  const body = templateShapedBody()
    .replace("### Current blocker\n\nNone.", "### Current blocker\n\nWaiting on founder input.")
    .replace("### Founder interrupt\n\nNone.", "### Founder interrupt\n\nPricing model TBD.");
  const next = upsertControlBullet(
    upsertControlBullet(upsertControlBullet(body, "Lifecycle", "DONE"), "Blocker", "none"),
    "Founder decision",
    "none",
  );
  const lines = next.split("\n");
  assert.equal(lines[lines.indexOf("### State") + 2], "DONE");
  assert.equal(lines[lines.indexOf("### Current blocker") + 2], "none");
  assert.equal(lines[lines.indexOf("### Founder interrupt") + 2], "none");
  assert.ok(!lines.some((l) => /^-\s*\*\*(Blocker|Founder decision):\*\*/i.test(l)));
});

// Issue #581's own #577 live reproduction: a hybrid body carrying *both* the canonical
// "### State" heading and a redundant ad hoc "- **Lifecycle:**" bullet. A lifecycle
// transition run through upsertControlBullet must converge both representations to the same
// new value, never silently update only one (the exact #577 drift: "### State" stayed READY
// while "- **Lifecycle:**" alone advanced to REVIEW).

function hybridTemplateShapedBody(lifecycleValue) {
  return templateShapedBody()
    .replace("READY_FOR_PLAN", lifecycleValue)
    .replace("### Current state\n\n- **Execution:** #500", `### Current state\n\n- **Lifecycle:** ${lifecycleValue}\n- **Execution:** #500`);
}

test("upsertControlBullet: #577 hybrid equal values — a Lifecycle update converges both ### State and the ad hoc bullet to the new value", () => {
  const body = hybridTemplateShapedBody("READY");
  const next = upsertControlBullet(body, "Lifecycle", "REVIEW");
  const lines = next.split("\n");
  const stateHeadingIdx = lines.indexOf("### State");
  assert.equal(lines[stateHeadingIdx + 2], "REVIEW");
  const bulletLine = lines.find((l) => /^-\s*\*\*Lifecycle:\*\*/i.test(l));
  assert.equal(bulletLine, "- **Lifecycle:** REVIEW");
  // Still exactly one of each representation — no duplicate bullet/heading manufactured.
  assert.equal(lines.filter((l) => l.trim() === "### State").length, 1);
  assert.equal(lines.filter((l) => /^-\s*\*\*Lifecycle:\*\*/i.test(l)).length, 1);
});

test("upsertControlBullet: #577 exact reproduction — replaying the READY-to-REVIEW transition against the exact contradictory shape converges to one coherent value", () => {
  // The literal #577 shape named in #581: "### State" reads READY while the redundant ad hoc
  // bullet already reads REVIEW (i.e. the bullet had already drifted ahead before this
  // transition runs again) -- proves the fix converges even a pre-existing disagreement to
  // the transition's own new value, rather than only handling the equal-values case.
  const body = hybridTemplateShapedBody("READY").replace("- **Lifecycle:** READY", "- **Lifecycle:** REVIEW");
  const next = upsertControlBullet(body, "Lifecycle", "REVIEW");
  const lines = next.split("\n");
  const stateHeadingIdx = lines.indexOf("### State");
  assert.equal(lines[stateHeadingIdx + 2], "REVIEW");
  const bulletLine = lines.find((l) => /^-\s*\*\*Lifecycle:\*\*/i.test(l));
  assert.equal(bulletLine, "- **Lifecycle:** REVIEW");
});

test("upsertControlBullet: hybrid body — repeated (idempotent) transition to the same value manufactures no duplicate fields", () => {
  const once = upsertControlBullet(hybridTemplateShapedBody("READY"), "Lifecycle", "REVIEW");
  const twice = upsertControlBullet(once, "Lifecycle", "REVIEW");
  assert.equal(twice, once);
  const lines = twice.split("\n");
  assert.equal(lines.filter((l) => l.trim() === "### State").length, 1);
  assert.equal(lines.filter((l) => /^-\s*\*\*Lifecycle:\*\*/i.test(l)).length, 1);
});

test("upsertControlBullet: a legacy Lifecycle-bullet-only body (no ### State heading at all) still updates only the bullet, unaffected by the hybrid fix", () => {
  const body = "- **Lifecycle:** READY\n- **Execution:** #497\n- **Route:** implementation worker\n";
  const next = upsertControlBullet(body, "Lifecycle", "REVIEW");
  assert.equal(next, "- **Lifecycle:** REVIEW\n- **Execution:** #497\n- **Route:** implementation worker\n");
  assert.ok(!next.includes("### State"));
});

test("probeExistingPlan: alreadyPlanned true with the canonical Plan Index URL when a valid plan already exists (the #500 shape)", async () => {
  const result = await probeExistingPlan(
    { repo: "LouPineWays/Loop-Dee-Loup", executionIssue: 500 },
    {
      parseExecutionPlanImpl: async () => ({
        exitCode: 0,
        ok: true,
        plan: { planIndex: { url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/500#issuecomment-1" } },
      }),
    },
  );
  assert.deepEqual(result, { alreadyPlanned: true, planIndexUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/500#issuecomment-1" });
});

test("probeExistingPlan: alreadyPlanned false for the ordinary 'no plan yet' case (exitCode 2)", async () => {
  const result = await probeExistingPlan(
    { repo: "LouPineWays/Loop-Dee-Loup", executionIssue: 500 },
    { parseExecutionPlanImpl: async () => ({ exitCode: 2, ok: false, errors: ["no Plan Index comment"] }) },
  );
  assert.equal(result.alreadyPlanned, false);
  assert.equal(result.operationalError, undefined);
});

test("probeExistingPlan: operationalError true (never silently read as 'no plan yet') when the read itself fails (exitCode 1)", async () => {
  const result = await probeExistingPlan(
    { repo: "LouPineWays/Loop-Dee-Loup", executionIssue: 500 },
    { parseExecutionPlanImpl: async () => ({ exitCode: 1, message: "gh api call failed: network error" }) },
  );
  assert.equal(result.alreadyPlanned, false);
  assert.equal(result.operationalError, true);
  assert.match(result.reason, /network error/);
});

test("checkReadyDispatch: READY_FOR_PLAN with an already-existing valid plan converges to READY_TO_PROJECT_PLAN_READY (exit 10) instead of dispatching planning again (the #500 stranded-state fix)", async () => {
  const body =
    "- **Lifecycle:** READY_FOR_PLAN\n- **Execution:** #500\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 501 },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      parseExecutionPlanImpl: async () => ({
        exitCode: 0,
        ok: true,
        plan: { planIndex: { url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/500#issuecomment-1" } },
      }),
    },
  );
  assert.equal(result.exitCode, 10);
  assert.equal(result.state, "READY_TO_PROJECT_PLAN_READY");
  assert.equal(result.stopAfter, true);
  assert.equal(result.executionIssue, 500);
  assert.equal(result.planIndexUrl, "https://github.com/LouPineWays/Loop-Dee-Loup/issues/500#issuecomment-1");
  assert.equal(
    result.proposedBody,
    "- **Lifecycle:** PLAN_READY\n" +
      "- **Plan:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/500#issuecomment-1\n" +
      "- **Execution:** #500\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n",
  );
});

test("checkReadyDispatch: READY_FOR_PLAN reports ERROR (exit 1), not a false planning dispatch, when the plan-existence probe fails operationally", async () => {
  const body =
    "- **Lifecycle:** READY_FOR_PLAN\n- **Execution:** #500\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 501 },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      parseExecutionPlanImpl: async () => ({ exitCode: 1, message: "gh api call failed: network error" }),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.notEqual(result.state, "READY_TO_DISPATCH_PLANNING");
  assert.match(result.message, /operational failure/i);
});

test("checkReadyDispatch: PLAN_READY with an already-verified manifest converges to READY_TO_PROJECT_ROUTED (exit 11) instead of re-running Route/Prepare (#498 Live reproduction C)", async () => {
  const body =
    "- **Lifecycle:** PLAN_READY\n- **Execution:** #500\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 501 },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      parseExecutionPlanImpl: async () => ({
        exitCode: 0,
        ok: true,
        repo: "LouPineWays/Loop-Dee-Loup",
        executionIssue: 500,
        plan: {
          planIndex: {
            commentId: 100,
            url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/500#issuecomment-100",
            dispatchManifest: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/500#issuecomment-200",
          },
        },
      }),
      ghCommentViewImpl: async () => ({
        id: 200,
        html_url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/500#issuecomment-200",
        issue_url: "https://api.github.com/repos/LouPineWays/Loop-Dee-Loup/issues/500",
        body:
          "## Dispatch Manifest (v1)\n\n- **Plan index:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/500#issuecomment-100\n",
      }),
    },
  );
  assert.equal(result.exitCode, 11);
  assert.equal(result.state, "READY_TO_PROJECT_ROUTED");
  assert.equal(result.stopAfter, true);
  assert.equal(result.executionIssue, 500);
  assert.equal(result.manifestUrl, "https://github.com/LouPineWays/Loop-Dee-Loup/issues/500#issuecomment-200");
  assert.equal(
    result.proposedBody,
    "- **Lifecycle:** ROUTED\n- **Execution:** #500\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n",
  );
});

test("checkReadyDispatch: PLAN_READY reports ERROR (exit 1), not a false manifest-prep dispatch, when the manifest-verification probe fails operationally", async () => {
  const body =
    "- **Lifecycle:** PLAN_READY\n- **Execution:** #500\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 501 },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      parseExecutionPlanImpl: async () => ({ exitCode: 1, message: "gh api call failed: network error" }),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.notEqual(result.state, "READY_TO_RUN_DISPATCH_MANIFEST");
  assert.match(result.message, /operational failure/i);
});

// Issue #498 unit 498-B: REPLAN_REQUIRED as a compact, reference-only control breakpoint --
// closing the #407/#408 and #454/#455 (via #434) live reproductions, where a controller that
// received prepare-dispatch-manifest.mjs's own fail-closed REPLAN_REQUIRED result out-of-band
// then read Worker Unit Contract bodies, the Shared Contract body, and router/parser source to
// diagnose it by hand instead of dispatching a planning-correction worker by reference.

test("probeReplanRequired: replanRequired true with plan index URL, failing unit ids, and a reason composed from each entry's own note", async () => {
  const result = await probeReplanRequired(
    { repo: "LouPineWays/Loop-Dee-Loup", executionIssue: 498 },
    {
      runPrepareDispatchManifestImpl: async () => ({
        exitCode: 0,
        ok: true,
        plan: { planIndex: { url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-100" } },
        entries: [
          { unitId: "498-A", route: "REPLAN_REQUIRED", dispatchReady: false, note: "capability class \"bogus\" does not resolve" },
          { unitId: "498-B", route: "stronger/general worker", dispatchReady: true, note: "no prerequisites" },
        ],
      }),
    },
  );
  assert.deepEqual(result, {
    replanRequired: true,
    planIndexUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-100",
    replanRequiredUnitIds: ["498-A"],
    reason: '498-A: capability class "bogus" does not resolve',
  });
});

test("probeReplanRequired: replanRequired false for the ordinary case (every unit routes deterministically)", async () => {
  const result = await probeReplanRequired(
    { repo: "LouPineWays/Loop-Dee-Loup", executionIssue: 498 },
    {
      runPrepareDispatchManifestImpl: async () => ({
        exitCode: 0,
        ok: true,
        plan: { planIndex: { url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-100" } },
        entries: [{ unitId: "498-A", route: "stronger/general worker", dispatchReady: true, note: "no prerequisites" }],
      }),
    },
  );
  assert.deepEqual(result, { replanRequired: false });
});

test("probeReplanRequired: stays silent (replanRequired false) for a malformed/unparseable plan (exitCode 2) -- not this probe's own diagnosis to report", async () => {
  const result = await probeReplanRequired(
    { repo: "LouPineWays/Loop-Dee-Loup", executionIssue: 498 },
    { runPrepareDispatchManifestImpl: async () => ({ exitCode: 2, ok: false, errors: ["fixture: no Plan Index comment"] }) },
  );
  assert.deepEqual(result, { replanRequired: false });
});

test("probeReplanRequired: operationalError true (never silently read as 'no replan needed') when computing routes itself fails", async () => {
  const result = await probeReplanRequired(
    { repo: "LouPineWays/Loop-Dee-Loup", executionIssue: 498 },
    { runPrepareDispatchManifestImpl: async () => ({ exitCode: 1, message: "gh api call failed: network error" }) },
  );
  assert.equal(result.replanRequired, false);
  assert.equal(result.operationalError, true);
  assert.match(result.reason, /network error/);
});

const PLAN_READY_BODY_498 =
  "- **Lifecycle:** PLAN_READY\n- **Execution:** #498\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";

test("checkReadyDispatch: PLAN_READY with a plan that would route a unit to REPLAN_REQUIRED reports exit 12, state REPLAN_REQUIRED, with compact reference-only fields and route 'planning worker'", async () => {
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 500 },
    {
      ghIssueViewImpl: async () => ({ body: PLAN_READY_BODY_498, state: "OPEN" }),
      // verifyRoutedDispatchManifest's own probe: no Dispatch manifest pointer settled yet --
      // the ordinary shape for a genuine PLAN_READY control Issue that has not yet reached
      // Route/Prepare.
      parseExecutionPlanImpl: async () => ({
        exitCode: 0,
        ok: true,
        plan: { planIndex: { url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-100", dispatchManifest: "none" } },
      }),
      runPrepareDispatchManifestImpl: async () => ({
        exitCode: 0,
        ok: true,
        plan: { planIndex: { url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-100" } },
        entries: [
          { unitId: "498-A", route: "REPLAN_REQUIRED", dispatchReady: false, note: "capability class \"bogus\" does not resolve" },
        ],
      }),
    },
  );
  assert.equal(result.exitCode, 12);
  assert.equal(result.state, "REPLAN_REQUIRED");
  assert.equal(result.stopAfter, true);
  assert.equal(result.controlIssue, 500);
  assert.equal(result.executionIssue, 498);
  assert.equal(result.planIndexUrl, "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-100");
  assert.deepEqual(result.replanRequiredUnitIds, ["498-A"]);
  assert.match(result.reason, /498-A: capability class "bogus" does not resolve/);
  // The verdict never invents a default/fuzzy worker route on the controller's behalf --
  // "planning worker" is always the literal value, the same capability READY_FOR_PLAN's own
  // Route field already requires, never re-derived from the failing unit(s)' own capability
  // text.
  assert.equal(result.route, "planning worker");
});

// Verification step 5/7 equivalent (execution Issue #498): after a planning-correction worker
// persists a corrected plan (every unit now routes deterministically), the identical control
// Issue re-evaluated by this same gate converges on the ordinary READY_TO_RUN_DISPATCH_MANIFEST
// boundary -- the exact same stop boundary a plan that never hit REPLAN_REQUIRED would reach.
// No special-cased "recovered from REPLAN_REQUIRED" verdict shape exists or is needed.
test("checkReadyDispatch: a corrected plan (no unit routes to REPLAN_REQUIRED any more) converges on the identical READY_TO_RUN_DISPATCH_MANIFEST boundary as an initially valid plan", async () => {
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 500 },
    {
      ghIssueViewImpl: async () => ({ body: PLAN_READY_BODY_498, state: "OPEN" }),
      parseExecutionPlanImpl: async () => ({
        exitCode: 0,
        ok: true,
        plan: { planIndex: { url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-100", dispatchManifest: "none" } },
      }),
      runPrepareDispatchManifestImpl: async () => ({
        exitCode: 0,
        ok: true,
        plan: { planIndex: { url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-100" } },
        entries: [{ unitId: "498-A", route: "stronger/general worker", dispatchReady: true, note: "no prerequisites" }],
      }),
    },
  );
  assert.equal(result.exitCode, 6);
  assert.equal(result.state, "READY_TO_RUN_DISPATCH_MANIFEST");
  assert.equal(result.stopAfter, true);
  assert.equal(result.executionIssue, 498);
});

// Stage 1 review finding on this PR (P2): once a REPLAN_REQUIRED correction publishes a new
// canonical Plan Index comment, the control Issue's own "- **Plan:**" bullet -- set the first
// time this same Issue converged PLAN_READY, now naming the *rejected* plan -- must be
// reconciled before routing/manifest preparation continues, mirroring the
// produce -> verify -> project -> stop invariant unit 498-A already established.
const PLAN_READY_BODY_498_STALE_PLAN =
  "- **Lifecycle:** PLAN_READY\n" +
  "- **Plan:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-1\n" +
  "- **Execution:** #498\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";

test("checkReadyDispatch: PLAN_READY with a stale 'Plan:' bullet reconverges to READY_TO_PROJECT_PLAN_READY (exit 10) instead of routing off the rejected plan", async () => {
  let manifestRunCalls = 0;
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 500 },
    {
      ghIssueViewImpl: async () => ({ body: PLAN_READY_BODY_498_STALE_PLAN, state: "OPEN" }),
      parseExecutionPlanImpl: async () => ({
        exitCode: 0,
        ok: true,
        plan: { planIndex: { url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-2", dispatchManifest: "none" } },
      }),
      // Proves the stale-pointer reconvergence stops before manifest preparation/routing ever
      // runs in this same invocation -- exactly the correction contract's "only a later fresh
      // invocation may continue to manifest preparation/routing" requirement.
      runPrepareDispatchManifestImpl: async () => {
        manifestRunCalls++;
        throw new Error("must not run Route/Prepare while the control Issue's Plan bullet is still stale");
      },
    },
  );
  assert.equal(manifestRunCalls, 0);
  assert.equal(result.exitCode, 10);
  assert.equal(result.state, "READY_TO_PROJECT_PLAN_READY");
  assert.equal(result.stopAfter, true);
  assert.equal(result.executionIssue, 498);
  assert.equal(result.planIndexUrl, "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-2");
  assert.equal(
    result.proposedBody,
    "- **Lifecycle:** PLAN_READY\n" +
      "- **Plan:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-2\n" +
      "- **Execution:** #498\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n",
  );
});

test("checkReadyDispatch: PLAN_READY with a 'Plan:' bullet that already matches the canonical plan proceeds through the ordinary manifest-preparation path unchanged (idempotent)", async () => {
  const body =
    "- **Lifecycle:** PLAN_READY\n" +
    "- **Plan:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-100\n" +
    "- **Execution:** #498\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 500 },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      parseExecutionPlanImpl: async () => ({
        exitCode: 0,
        ok: true,
        plan: { planIndex: { url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-100", dispatchManifest: "none" } },
      }),
      runPrepareDispatchManifestImpl: async () => ({
        exitCode: 0,
        ok: true,
        plan: { planIndex: { url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-100" } },
        entries: [{ unitId: "498-A", route: "stronger/general worker", dispatchReady: true, note: "no prerequisites" }],
      }),
    },
  );
  assert.equal(result.exitCode, 6);
  assert.equal(result.state, "READY_TO_RUN_DISPATCH_MANIFEST");
});

test("checkReadyDispatch: PLAN_READY with a 'Plan:' bullet reports ERROR (exit 1), not a false projection, when reading the canonical plan for staleness comparison fails operationally", async () => {
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 500 },
    {
      ghIssueViewImpl: async () => ({ body: PLAN_READY_BODY_498_STALE_PLAN, state: "OPEN" }),
      parseExecutionPlanImpl: async () => ({ exitCode: 1, message: "gh api call failed: network error" }),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.notEqual(result.state, "READY_TO_PROJECT_PLAN_READY");
  assert.match(result.message, /operational failure/i);
});

test("checkReadyDispatch: PLAN_READY reports ERROR (exit 1), not a false REPLAN_REQUIRED/dispatch verdict, when computing unit routes itself fails operationally", async () => {
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 500 },
    {
      ghIssueViewImpl: async () => ({ body: PLAN_READY_BODY_498, state: "OPEN" }),
      parseExecutionPlanImpl: async () => ({
        exitCode: 0,
        ok: true,
        plan: { planIndex: { url: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-100", dispatchManifest: "none" } },
      }),
      runPrepareDispatchManifestImpl: async () => ({ exitCode: 1, message: "gh api call failed: network error" }),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.notEqual(result.state, "REPLAN_REQUIRED");
  assert.match(result.message, /operational failure/i);
});

// Issue #498 unit 498-A: an explicitly injected `parseExecutionPlanImpl` (this file's existing
// network-isolation convention) must never be silently bypassed by a second, uninjected
// real-`gh`-backed plan parse inside this gate's own REPLAN_REQUIRED probe -- the effective
// default `runPrepareDispatchManifestImpl` threads the same injected `parseExecutionPlanImpl`
// through instead of independently defaulting to the real plan parser.
test("checkReadyDispatch: PLAN_READY's REPLAN_REQUIRED probe reuses the already-injected parseExecutionPlanImpl by default, never a second uninjected real plan parse", async () => {
  let parseCalls = 0;
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 500 },
    {
      ghIssueViewImpl: async () => ({ body: PLAN_READY_BODY_498, state: "OPEN" }),
      parseExecutionPlanImpl: async () => {
        parseCalls++;
        // Malformed/unparseable from this probe's point of view -- exercises the exitCode 2
        // "not this probe's own concern" branch inside probeReplanRequired without ever
        // touching a real `gh`-backed plan parser.
        return { exitCode: 2, ok: false, errors: ["fixture: no Dispatch Manifest yet"] };
      },
    },
  );
  assert.ok(parseCalls >= 1, "the injected parseExecutionPlanImpl must have been used at least once");
  assert.equal(result.exitCode, 6);
  assert.equal(result.state, "READY_TO_RUN_DISPATCH_MANIFEST");
});

// --- Issue #456 unit 456-B: PR-breakpoint reconciliation --------------------------------
//
// Two independent live reproductions this unit closes:
//   #448 shape (#456 Verification scenario 1) — a plain READY control Issue whose own "PR"
//     bullet says "none" even though execution Issue #447 already produced PR #453.
//   #539/#540 shape (#456 Verification scenario 2) — a ROUTED control Issue whose Dispatch
//     Manifest still marks unit 537-A dispatch_ready=true even though that unit's own Worker
//     Unit Contract already recorded State: DONE with PR #540.
// Plus the manifest negative control (scenario 3), the true pre-PR negative control
// (scenario 7 — already covered above by the updated "reads the control Issue exactly once
// ... " test and its siblings, which inject a `ghPrListImpl` finding nothing and still reach
// READY_TO_DISPATCH), and the #444 separation negative control (scenario 8).

test("findExecutionLinkedPr: matches a PR via the branch-name linkage convention", () => {
  const prList = [
    { number: 453, url: "https://github.com/LouPineWays/Loop-Dee-Loup/pull/453", state: "OPEN", headRefName: "issue-447-stage2-response-unusable", body: "unrelated body" },
  ];
  const pr = findExecutionLinkedPr(prList, 447);
  assert.equal(pr.number, 453);
});

test("findExecutionLinkedPr: matches a PR via the PR-body '#N' linkage convention", () => {
  const prList = [{ number: 540, url: "https://github.com/LouPineWays/Loop-Dee-Loup/pull/540", state: "MERGED", headRefName: "some-other-branch", body: "Addresses #537" }];
  const pr = findExecutionLinkedPr(prList, 537);
  assert.equal(pr.number, 540);
});

test("findExecutionLinkedPr: never matches a longer number sharing the same leading digits (issue 447 vs PR body '#4470' or branch 'issue-4470-')", () => {
  const prList = [
    { number: 1, url: "u1", state: "OPEN", headRefName: "issue-4470-unrelated", body: "unrelated" },
    { number: 2, url: "u2", state: "OPEN", headRefName: "some-branch", body: "Addresses #4470" },
  ];
  assert.equal(findExecutionLinkedPr(prList, 447), null);
});

test("referencesExecutionIssue: Stage 1 finding on PR #547 — a bare '#N' mention that is not the Addresses/Implements marker does not count as linkage", () => {
  assert.equal(referencesExecutionIssue({ headRefName: "some-other-branch", body: "See also #447 for background; unrelated to this change." }, 447), false);
});

test("referencesExecutionIssue: still matches the documented 'Addresses #N' and 'Implements #N' markers", () => {
  assert.equal(referencesExecutionIssue({ headRefName: "b", body: "Addresses #447." }, 447), true);
  assert.equal(referencesExecutionIssue({ headRefName: "b", body: "Implements #447 per the Shared Contract." }, 447), true);
});

test("findExecutionLinkedPr: a bare '#N' background mention does not misclassify an unrelated PR as execution-linked (Stage 1 finding on PR #547)", () => {
  const prList = [{ number: 999, url: "u999", state: "OPEN", headRefName: "some-other-branch", body: "See also #447 for background; unrelated to this change." }];
  assert.equal(findExecutionLinkedPr(prList, 447), null);
});

test("findExecutionLinkedPr: returns null when nothing references the execution Issue (the ordinary pre-PR case)", () => {
  assert.equal(findExecutionLinkedPr([], 447), null);
  assert.equal(findExecutionLinkedPr([{ number: 1, url: "u1", state: "OPEN", headRefName: "unrelated-branch", body: "no reference here" }], 447), null);
});

test("findExecutionLinkedPr: prefers an OPEN PR over a CLOSED/MERGED one; ties break to the numerically highest number", () => {
  const prList = [
    { number: 100, url: "u100", state: "MERGED", headRefName: "issue-447-old-attempt", body: "" },
    { number: 200, url: "u200", state: "OPEN", headRefName: "issue-447-current", body: "" },
  ];
  assert.equal(findExecutionLinkedPr(prList, 447).number, 200);

  const bothOpen = [
    { number: 300, url: "u300", state: "OPEN", headRefName: "issue-447-a", body: "" },
    { number: 301, url: "u301", state: "OPEN", headRefName: "issue-447-b", body: "" },
  ];
  assert.equal(findExecutionLinkedPr(bothOpen, 447).number, 301);
});

test("reconcileReadyPrBreakpoint: crossed:true when a linked PR is found", async () => {
  const result = await reconcileReadyPrBreakpoint(
    { repo: "LouPineWays/Loop-Dee-Loup", executionIssue: 447 },
    { ghPrListImpl: async () => [{ number: 453, url: "https://github.com/LouPineWays/Loop-Dee-Loup/pull/453", state: "OPEN", headRefName: "issue-447-x", body: "" }] },
  );
  assert.equal(result.crossed, true);
  assert.equal(result.pr.number, 453);
});

test("reconcileReadyPrBreakpoint: crossed:false when the narrow lookup finds nothing (the ordinary pre-PR case)", async () => {
  const result = await reconcileReadyPrBreakpoint(
    { repo: "LouPineWays/Loop-Dee-Loup", executionIssue: 447 },
    { ghPrListImpl: async () => [] },
  );
  assert.equal(result.crossed, false);
  assert.ok(!result.operationalError);
});

test("reconcileReadyPrBreakpoint: an operational failure in the lookup itself is reported distinctly, never silently read as crossed:false", async () => {
  const result = await reconcileReadyPrBreakpoint(
    { repo: "LouPineWays/Loop-Dee-Loup", executionIssue: 447 },
    { ghPrListImpl: async () => { throw new Error("gh api rate limited"); } },
  );
  assert.equal(result.crossed, false);
  assert.equal(result.operationalError, true);
  assert.match(result.reason, /gh api rate limited/);
});

test("checkReadyDispatch: #448 reproduction -- Lifecycle READY / PR none / Stage 1 none, but execution Issue #447 already has PR #453 -- reconciles to NOT_READY, never READY_TO_DISPATCH (#456 Verification scenario 1)", async () => {
  const body =
    "- **Lifecycle:** READY\n- **Execution:** #447\n- **Route:** implementation worker\n" +
    "- **PR:** none\n- **Stage 1:** none\n- **Blocker:** none\n- **Founder decision:** none\n";
  let prListCalls = 0;
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 448 },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      ghPrListImpl: async ({ repo, executionIssue }) => {
        prListCalls++;
        assert.equal(repo, "LouPineWays/Loop-Dee-Loup");
        assert.equal(executionIssue, 447);
        return [
          {
            number: 453,
            url: "https://github.com/LouPineWays/Loop-Dee-Loup/pull/453",
            state: "OPEN",
            headRefName: "issue-447-stage2-response-unusable",
            body: "Addresses #447",
          },
        ];
      },
    },
  );
  assert.equal(prListCalls, 1);
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "NOT_READY");
  assert.ok(!("executionIssue" in result), "NOT_READY never authorizes a fresh dispatch reference");
  assert.ok(result.reasons.some((r) => r.includes("pull/453") && r.includes("already")));
  // A no-action/fallthrough verdict never becomes a bounded dispatch authorization.
  assert.deepEqual(result.actionEnvelope, { mode: "fallthrough", authorizedActions: [] });
});

test("checkReadyDispatch: true pre-PR negative control -- Lifecycle READY / PR none, and no linked PR actually exists -- still dispatches normally (#456 Verification scenario 7)", async () => {
  const body =
    "- **Lifecycle:** READY\n- **Execution:** #447\n- **Route:** implementation worker\n" +
    "- **PR:** none\n- **Stage 1:** none\n- **Blocker:** none\n- **Founder decision:** none\n";
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 448 },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      ghPrListImpl: async () => [],
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "READY_TO_DISPATCH");
  assert.equal(result.executionIssue, 447);
});

// Manifest-path fixture mirroring manifestFixture() above but allowing each unit's own live
// Worker Unit Contract `state` to be specified — this reconciliation reads exactly that field
// (parsed.plan.units[unitId].state), never the Plan Index's own possibly-stale `indexState`.
function manifestFixtureWithUnitStates({ repo = "LouPineWays/Loop-Dee-Loup", executionIssue = 537, unitStates, manifestUnitLines }) {
  const planIndexUrl = `https://github.com/${repo}/issues/${executionIssue}#issuecomment-100`;
  const manifestUrl = `https://github.com/${repo}/issues/${executionIssue}#issuecomment-200`;
  const units = Object.fromEntries(Object.entries(unitStates).map(([unitId, state]) => [unitId, { state }]));
  return {
    repo,
    executionIssue,
    parseExecutionPlanImpl: async () => ({
      exitCode: 0,
      ok: true,
      repo,
      executionIssue,
      plan: {
        planIndex: { commentId: 100, url: planIndexUrl, dispatchManifest: manifestUrl },
        units,
      },
    }),
    ghCommentViewImpl: async () => ({
      id: 200,
      html_url: manifestUrl,
      issue_url: `https://api.github.com/repos/${repo}/issues/${executionIssue}`,
      body:
        `## Dispatch Manifest (v1)\n\n- **Plan index:** ${planIndexUrl}\n` +
        manifestUnitLines.map((line) => `- ${line}\n`).join(""),
    }),
  };
}

test("verifyRoutedDispatchManifest: reconciles a dispatch_ready=true unit already recording State: DONE into alreadyDoneUnitIds, excluded from dispatchReadyUnitIds (#456 Verification scenario 2, the #537/#539/#540 shape)", async () => {
  const fixture = manifestFixtureWithUnitStates({
    unitStates: { "537-A": "DONE" },
    manifestUnitLines: ["537-A: route=stronger/general worker dispatch_ready=true note=none"],
  });
  const { repo, executionIssue, ...impls } = fixture;
  const result = await verifyRoutedDispatchManifest({ repo, executionIssue }, impls);
  assert.equal(result.ok, true);
  assert.deepEqual(result.dispatchReadyUnitIds, []);
  assert.deepEqual(result.alreadyDoneUnitIds, ["537-A"]);
});

test("verifyRoutedDispatchManifest: reconciles State: DONE followed by a completion note (the real Worker Unit Contract shape, not the bare 'DONE' fixture) into alreadyDoneUnitIds", async () => {
  const fixture = manifestFixtureWithUnitStates({
    unitStates: { "537-A": "DONE — implemented the fix; node --test passes 12/12." },
    manifestUnitLines: ["537-A: route=stronger/general worker dispatch_ready=true note=none"],
  });
  const { repo, executionIssue, ...impls } = fixture;
  const result = await verifyRoutedDispatchManifest({ repo, executionIssue }, impls);
  assert.equal(result.ok, true);
  assert.deepEqual(result.dispatchReadyUnitIds, []);
  assert.deepEqual(result.alreadyDoneUnitIds, ["537-A"]);
});

test("verifyRoutedDispatchManifest: a state merely starting with 'done' as a different word (e.g. 'DONESKIP') is not treated as DONE", async () => {
  const fixture = manifestFixtureWithUnitStates({
    unitStates: { "537-A": "DONESKIP — not a real state value" },
    manifestUnitLines: ["537-A: route=stronger/general worker dispatch_ready=true note=none"],
  });
  const { repo, executionIssue, ...impls } = fixture;
  const result = await verifyRoutedDispatchManifest({ repo, executionIssue }, impls);
  assert.equal(result.ok, true);
  assert.deepEqual(result.dispatchReadyUnitIds, ["537-A"]);
  assert.deepEqual(result.alreadyDoneUnitIds, []);
});

test("verifyRoutedDispatchManifest: a genuinely non-DONE, dependency-ready unit stays in dispatchReadyUnitIds (#456 Verification scenario 3, manifest negative control)", async () => {
  const fixture = manifestFixtureWithUnitStates({
    unitStates: { "498-A": "IN_PROGRESS" },
    manifestUnitLines: ["498-A: route=stronger/general worker dispatch_ready=true note=none"],
  });
  const { repo, executionIssue, ...impls } = fixture;
  const result = await verifyRoutedDispatchManifest({ repo, executionIssue }, impls);
  assert.equal(result.ok, true);
  assert.deepEqual(result.dispatchReadyUnitIds, ["498-A"]);
  assert.deepEqual(result.alreadyDoneUnitIds, []);
});

test("verifyRoutedDispatchManifest: a mixed wave excludes only the already-DONE unit, keeping the genuinely pending one dispatchable", async () => {
  const fixture = manifestFixtureWithUnitStates({
    unitStates: { "498-A": "DONE", "498-B": "PLANNED" },
    manifestUnitLines: [
      "498-A: route=stronger/general worker dispatch_ready=true note=none",
      "498-B: route=stronger/general worker dispatch_ready=true note=none",
    ],
  });
  const { repo, executionIssue, ...impls } = fixture;
  const result = await verifyRoutedDispatchManifest({ repo, executionIssue }, impls);
  assert.equal(result.ok, true);
  assert.deepEqual(result.dispatchReadyUnitIds, ["498-B"]);
  assert.deepEqual(result.alreadyDoneUnitIds, ["498-A"]);
});

test("checkReadyDispatch: #539/#540 reproduction -- Lifecycle ROUTED with a stale dispatch_ready=true manifest entry whose unit already recorded DONE -- reconciles to NOT_READY, never dispatches 537-A again (#456 Verification scenario 2)", async () => {
  const body =
    "- **Lifecycle:** ROUTED\n- **Execution:** #537\n- **Route:** planning worker\n" +
    "- **PR:** none\n- **Stage 1:** none\n- **Stage 2:** none\n- **Blocker:** none\n- **Founder decision:** none\n";
  const fixture = manifestFixtureWithUnitStates({
    executionIssue: 537,
    unitStates: { "537-A": "DONE" },
    manifestUnitLines: ["537-A: route=stronger/general worker dispatch_ready=true note=none"],
  });
  const { repo, executionIssue, ...impls } = fixture;
  const result = await checkReadyDispatch(
    { repo, controlIssue: 539 },
    { ghIssueViewImpl: async () => ({ body, state: "OPEN" }), ...impls },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "NOT_READY");
  assert.equal(result.executionIssue, undefined);
  assert.ok(result.reasons.some((r) => r.includes("537-A") && r.includes("DONE")));
  assert.deepEqual(result.actionEnvelope, { mode: "fallthrough", authorizedActions: [] });
});

test("checkReadyDispatch: ROUTED with a mixed wave still dispatches the genuinely pending unit, reporting the excluded DONE unit for transparency", async () => {
  const body =
    "- **Lifecycle:** ROUTED\n- **Execution:** #498\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  const fixture = manifestFixtureWithUnitStates({
    executionIssue: 498,
    unitStates: { "498-A": "DONE", "498-B": "PLANNED" },
    manifestUnitLines: [
      "498-A: route=stronger/general worker dispatch_ready=true note=none",
      "498-B: route=stronger/general worker dispatch_ready=true note=none",
    ],
  });
  const { repo, executionIssue, ...impls } = fixture;
  const result = await checkReadyDispatch(
    { repo, controlIssue: 500 },
    { ghIssueViewImpl: async () => ({ body, state: "OPEN" }), ...impls },
  );
  assert.equal(result.exitCode, 7);
  assert.equal(result.state, "READY_TO_DISPATCH_UNITS");
  assert.deepEqual(result.dispatchReadyUnitIds, ["498-B"]);
  assert.deepEqual(result.alreadyDoneUnitIds, ["498-A"]);
});

test("checkReadyDispatch: EXECUTION_COMPLETE (#444/#445's own Integration-dispatch path) is unaffected by this unit's reconciliation -- no PR lookup, no manifest reconciliation (#456 Verification scenario 8, the #444 separation negative control)", async () => {
  const body =
    "- **Lifecycle:** EXECUTION_COMPLETE\n- **Execution:** #498\n- **Route:** integration worker\n- **Blocker:** none\n- **Founder decision:** none\n";
  let prListCalls = 0;
  const result = await checkReadyDispatch(
    { repo: "LouPineWays/Loop-Dee-Loup", controlIssue: 500 },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      ghPrListImpl: async () => {
        prListCalls++;
        return [];
      },
    },
  );
  assert.equal(prListCalls, 0, "456-B's reconciliation must never run for the separate EXECUTION_COMPLETE/#444 path");
  assert.equal(result.exitCode, 8);
  assert.equal(result.state, "READY_TO_DISPATCH_INTEGRATION");
  assert.equal(result.executionIssue, 498);
});
