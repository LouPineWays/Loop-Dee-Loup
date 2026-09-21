// Tests for tools/orchestration/execution-authority-gate.mjs — issue #630's deterministic
// negative/positive coverage for the content-vs-execution-authority boundary.
//
// Run with:
//   node --test tools/orchestration/execution-authority-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { classifyExecutionAuthority } from "./execution-authority-gate.mjs";

// --- Negative case: the PR #628 failure shape -----------------------------------------

test("PR #628 shape: an owner-authored Stage 1 guidance comment is not execution authority", () => {
  const result = classifyExecutionAuthority({
    origin: "comment",
    commentAuthor: "LouPineWays",
    commentTrusted: true,
    commentUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/pull/628#issuecomment-5705748185",
    body: "Please also handle the edge case where the branch is missing.",
  });
  assert.equal(result.authorized, false);
  assert.match(result.reason, /semantic input only/);
});

test("PR #628 shape: a Codex Cloud task started from that comment is not execution authority", () => {
  const result = classifyExecutionAuthority({
    origin: "task_start_from_comment",
    sourceCommentUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/pull/628#issuecomment-5705748185",
  });
  assert.equal(result.authorized, false);
  assert.match(result.reason, /semantic input only/);
});

test("a trusted comment (#462/#463 context) remains non-authoritative for mutation", () => {
  const trusted = classifyExecutionAuthority({ origin: "comment", commentTrusted: true, commentAuthor: "founder" });
  const untrusted = classifyExecutionAuthority({ origin: "comment", commentTrusted: false, commentAuthor: "anon" });
  assert.equal(trusted.authorized, false);
  assert.equal(untrusted.authorized, false);
});

test("comment content that itself names a control/execution Issue does not become authority", () => {
  // A comment quoting "#630"/"#631" is still just content — it does not resolve into a
  // durable envelope on its own; only an actual control_plane_dispatch trigger does.
  const result = classifyExecutionAuthority({
    origin: "comment",
    body: "Please dispatch execution Issue #630 per controlling Issue #631.",
  });
  assert.equal(result.authorized, false);
});

test("an unrecognized or missing origin fails closed", () => {
  assert.equal(classifyExecutionAuthority({}).authorized, false);
  assert.equal(classifyExecutionAuthority({ origin: "webhook_ping" }).authorized, false);
  assert.equal(classifyExecutionAuthority(null).authorized, false);
  assert.equal(classifyExecutionAuthority(undefined).authorized, false);
  assert.equal(classifyExecutionAuthority("comment").authorized, false);
  assert.equal(classifyExecutionAuthority([]).authorized, false);
});

// --- `@codex review` stays reviewer-only, even under this boundary ---------------------

test("an actual @codex review invocation is not execution authority", () => {
  const result = classifyExecutionAuthority({ origin: "codex_review", pr: 628 });
  assert.equal(result.authorized, false);
  assert.match(result.reason, /reviewer-only/);
});

// --- Positive case: this dispatch's own reference triple authorizes mutation -----------

test("an authorized control-plane dispatch (this Issue #630/#631 shape) is execution authority", () => {
  const result = classifyExecutionAuthority({
    origin: "control_plane_dispatch",
    controlIssue: 631,
    executionIssue: 630,
    route: "bounded implementation worker / control-plane correction",
  });
  assert.equal(result.authorized, true);
  assert.match(result.reason, /control #631/);
  assert.match(result.reason, /execution #630/);
});

test("control-plane dispatch missing any envelope field fails closed", () => {
  assert.equal(
    classifyExecutionAuthority({ origin: "control_plane_dispatch", executionIssue: 630, route: "worker" }).authorized,
    false,
  );
  assert.equal(
    classifyExecutionAuthority({ origin: "control_plane_dispatch", controlIssue: 631, route: "worker" }).authorized,
    false,
  );
  assert.equal(
    classifyExecutionAuthority({ origin: "control_plane_dispatch", controlIssue: 631, executionIssue: 630 }).authorized,
    false,
  );
});

test("an explicit founder chat instruction is execution authority", () => {
  const result = classifyExecutionAuthority({ origin: "founder_direct", founderInstruction: "work on #631" });
  assert.equal(result.authorized, true);
});

test("founder_direct with no actual instruction reference fails closed", () => {
  const result = classifyExecutionAuthority({ origin: "founder_direct" });
  assert.equal(result.authorized, false);
});

test("an authorized Stage 1/Stage 2 correction dispatch is execution authority", () => {
  const stage1 = classifyExecutionAuthority({ origin: "correction_dispatch", controlIssue: 631, pr: 628 });
  const stage2 = classifyExecutionAuthority({ origin: "correction_dispatch", controlIssue: 631, auditIssue: 629 });
  assert.equal(stage1.authorized, true);
  assert.equal(stage2.authorized, true);
});

// Stage 1 review finding (inline P2, "Preserve authorized direct-reference corrections"):
// next-review-transition-gate.mjs's STAGE1_CORRECTION_REQUIRED/STAGE2_CORRECTION_REQUIRED
// verdicts, and both correction prompt formatters, already support a genuine
// controlIssue: null / absent direct-reference shape (no thin control Issue exists).
// Requiring controlIssue unconditionally would strand those authorized corrections.
test("a direct-reference correction dispatch with no thin control Issue is still execution authority", () => {
  const stage1 = classifyExecutionAuthority({ origin: "correction_dispatch", pr: 628 });
  const stage2 = classifyExecutionAuthority({ origin: "correction_dispatch", auditIssue: 629 });
  assert.equal(stage1.authorized, true);
  assert.match(stage1.reason, /direct-reference/);
  assert.equal(stage2.authorized, true);
});

test("correction dispatch missing both a controlIssue and a PR/Audit reference fails closed", () => {
  assert.equal(classifyExecutionAuthority({ origin: "correction_dispatch" }).authorized, false);
  assert.equal(classifyExecutionAuthority({ origin: "correction_dispatch", controlIssue: 631 }).authorized, false);
});

// --- Malformed truthy values must fail closed, not merely missing fields ---------------
// Stage 1 review finding (top-level P1 + inline "Validate envelope values before granting
// authority"): every positive path previously accepted arbitrary truthy values —
// controlIssue: "not-an-issue", executionIssue: {}, route: [], an object-valued
// founderInstruction, and controlIssue: "x" alongside pr: [] all produced authorized: true.

test("control-plane dispatch with malformed truthy fields fails closed", () => {
  assert.equal(
    classifyExecutionAuthority({
      origin: "control_plane_dispatch",
      controlIssue: "not-an-issue",
      executionIssue: {},
      route: [],
    }).authorized,
    false,
  );
  assert.equal(
    classifyExecutionAuthority({ origin: "control_plane_dispatch", controlIssue: -1, executionIssue: 630, route: "worker" })
      .authorized,
    false,
  );
  assert.equal(
    classifyExecutionAuthority({ origin: "control_plane_dispatch", controlIssue: 631, executionIssue: 630, route: "   " })
      .authorized,
    false,
  );
});

test("founder_direct with an object-valued or empty founderInstruction fails closed", () => {
  assert.equal(
    classifyExecutionAuthority({ origin: "founder_direct", founderInstruction: { text: "work on #631" } }).authorized,
    false,
  );
  assert.equal(classifyExecutionAuthority({ origin: "founder_direct", founderInstruction: "   " }).authorized, false);
});

test("correction dispatch with malformed truthy fields fails closed", () => {
  assert.equal(
    classifyExecutionAuthority({ origin: "correction_dispatch", controlIssue: "x", pr: [] }).authorized,
    false,
  );
  assert.equal(
    classifyExecutionAuthority({ origin: "correction_dispatch", controlIssue: "x", pr: 628 }).authorized,
    false,
  );
  assert.equal(
    classifyExecutionAuthority({ origin: "correction_dispatch", auditIssue: -1 }).authorized,
    false,
  );
});

// --- Pre-PR pipeline dispatch envelopes (Stage 1 review finding, inline P1 "Recognize the
// actual pre-PR dispatch envelopes") ----------------------------------------------------

test("planning and integration dispatches are execution authority without a route field", () => {
  const planning = classifyExecutionAuthority({ origin: "planning_dispatch", controlIssue: 631, executionIssue: 630 });
  const integration = classifyExecutionAuthority({ origin: "integration_dispatch", controlIssue: 631, executionIssue: 630 });
  assert.equal(planning.authorized, true);
  assert.equal(integration.authorized, true);
});

test("planning/integration dispatch with malformed or missing fields fails closed", () => {
  assert.equal(
    classifyExecutionAuthority({ origin: "planning_dispatch", controlIssue: "631", executionIssue: 630 }).authorized,
    false,
  );
  assert.equal(classifyExecutionAuthority({ origin: "integration_dispatch", controlIssue: 631 }).authorized, false);
});

test("a worker-unit dispatch is execution authority via its unit/shared-contract comment URLs", () => {
  const result = classifyExecutionAuthority({
    origin: "worker_unit_dispatch",
    unitCommentUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/630#issuecomment-1",
    parentExecutionIssue: 630,
    sharedContractUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/630#issuecomment-2",
  });
  assert.equal(result.authorized, true);
});

test("a worker-unit dispatch with a malformed comment URL or issue number fails closed", () => {
  assert.equal(
    classifyExecutionAuthority({
      origin: "worker_unit_dispatch",
      unitCommentUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/630",
      parentExecutionIssue: 630,
      sharedContractUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/630#issuecomment-2",
    }).authorized,
    false,
  );
  assert.equal(
    classifyExecutionAuthority({
      origin: "worker_unit_dispatch",
      unitCommentUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/630#issuecomment-1",
      parentExecutionIssue: "630",
      sharedContractUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/630#issuecomment-2",
    }).authorized,
    false,
  );
});

// Stage 2 audit finding on this PR (#677, P1 "Worker-unit dispatch accepts non-GitHub URLs
// as durable execution authority"): isCommentUrl only checked for an http(s) scheme and a
// trailing `#issuecomment-<digits>` fragment, so an adversarial probe classified
// non-GitHub and lookalike-host URLs as authorized worker-unit dispatches. These reproduce
// that exact probe and must all fail closed.
test("a worker-unit dispatch with a non-GitHub or lookalike-host comment URL fails closed", () => {
  const goodShared = "https://github.com/LouPineWays/Loop-Dee-Loup/issues/630#issuecomment-2";

  assert.equal(
    classifyExecutionAuthority({
      origin: "worker_unit_dispatch",
      unitCommentUrl: "https://evil.example/fake#issuecomment-1",
      parentExecutionIssue: 630,
      sharedContractUrl: goodShared,
    }).authorized,
    false,
  );
  assert.equal(
    classifyExecutionAuthority({
      origin: "worker_unit_dispatch",
      unitCommentUrl: "http://example.com/#issuecomment-999",
      parentExecutionIssue: 630,
      sharedContractUrl: goodShared,
    }).authorized,
    false,
  );
  assert.equal(
    classifyExecutionAuthority({
      origin: "worker_unit_dispatch",
      unitCommentUrl: "https://github.com.evil.example/issues/1#issuecomment-2",
      parentExecutionIssue: 630,
      sharedContractUrl: goodShared,
    }).authorized,
    false,
  );
  assert.equal(
    classifyExecutionAuthority({
      origin: "worker_unit_dispatch",
      unitCommentUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/630#issuecomment-1",
      parentExecutionIssue: 630,
      sharedContractUrl: "https://github.com.evil.example/issues/1#issuecomment-2",
    }).authorized,
    false,
  );
});

test("a worker-unit dispatch accepts a GitHub pull-request comment URL", () => {
  const result = classifyExecutionAuthority({
    origin: "worker_unit_dispatch",
    unitCommentUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/pull/637#issuecomment-5712321853",
    parentExecutionIssue: 630,
    sharedContractUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/630#issuecomment-2",
  });
  assert.equal(result.authorized, true);
});
