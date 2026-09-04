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
  evaluateReadyDispatchGate,
  checkReadyDispatch,
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
