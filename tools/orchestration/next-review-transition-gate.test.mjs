// Tests for tools/orchestration/next-review-transition-gate.mjs -- worker unit 397-B's
// deterministic post-PR transition gate, extended by issue #454 unit 454-C for the
// "correction-satisfied" Stage 1 disposition. Every composed check (stage1-gate.mjs's `run`,
// lifecycle-gate.mjs's `checkMergeReady`/`checkPostAudit`, stage1-correction-gate.mjs's
// `checkCorrectionDelta`) is faked via injected
// stage1RunImpl/checkMergeReadyImpl/checkPostAuditImpl/checkCorrectionDeltaImpl -- never touch
// the real network or `gh` CLI here, mirroring tools/review-watch/merge-ready-gate.test.mjs's
// own style.
//
// Run with:
//   node --test tools/orchestration/next-review-transition-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseOptionalIssueRef,
  parseOptionalIssueRefGuarded,
  resolvePreMergeVerdict,
  resolvePostMergeVerdict,
  runNextReviewTransitionGate,
} from "./next-review-transition-gate.mjs";

// -- parseOptionalIssueRef ------------------------------------------------------------------

test("parseOptionalIssueRef: 'none' sentinel, a settled #N reference, missing, and malformed", () => {
  assert.deepEqual(parseOptionalIssueRef("none", "PR"), { kind: "none" });
  assert.deepEqual(parseOptionalIssueRef("None", "PR"), { kind: "none" });
  assert.deepEqual(parseOptionalIssueRef("#376", "PR"), { kind: "issue", issue: 376 });
  assert.deepEqual(parseOptionalIssueRef(null, "PR"), {
    kind: "missing",
    reason: 'no "- **PR:**" bullet found in the control Issue body',
  });
  const invalid = parseOptionalIssueRef("#376 and also #400", "PR");
  assert.equal(invalid.kind, "invalid");
  assert.match(invalid.reason, /#376/);
  assert.match(invalid.reason, /#400/);
  const empty = parseOptionalIssueRef("", "PR");
  assert.equal(empty.kind, "invalid");
});

// -- parseOptionalIssueRefGuarded (issue #493, the #440 near-duplicate-label regression) ----

test("parseOptionalIssueRefGuarded: the exact #440 regression -- stale canonical 'Stage 2: #480' coexisting with live 'Stage 2 (current): #492' fails closed as ambiguous", () => {
  const body = "- **Stage 2:** #480\n- **Stage 2 (current):** #492\n";
  const result = parseOptionalIssueRefGuarded(body, "Stage 2");
  assert.equal(result.kind, "ambiguous");
  assert.match(result.reason, /#480/);
  assert.match(result.reason, /#492/);
  assert.match(result.reason, /Stage 2 \(current\)/);
});

test("parseOptionalIssueRefGuarded: representative (current)/(updated) Stage 2 lookalikes are each rejected", () => {
  assert.equal(parseOptionalIssueRefGuarded("- **Stage 2:** #480\n- **Stage 2 (current):** #492\n", "Stage 2").kind, "ambiguous");
  assert.equal(parseOptionalIssueRefGuarded("- **Stage 2:** #480\n- **Stage 2 (updated):** #492\n", "Stage 2").kind, "ambiguous");
});

test("parseOptionalIssueRefGuarded: PR equivalent -- canonical PR pointer plus an unrecognized near-duplicate PR label cannot silently route through the canonical pointer", () => {
  const result = parseOptionalIssueRefGuarded("- **PR:** #376\n- **PR (current):** #400\n", "PR");
  assert.equal(result.kind, "ambiguous");
  assert.match(result.reason, /#376/);
  assert.match(result.reason, /#400/);
});

// Stage 1 review finding on this PR: a punctuation-delimited qualifier (not just "("-style
// or whitespace) must also be caught, or a stale canonical field stays authoritative.
test("parseOptionalIssueRefGuarded: punctuation-delimited Stage 2 lookalikes (hyphen, slash) fail closed beside the canonical field", () => {
  assert.equal(parseOptionalIssueRefGuarded("- **Stage 2:** #480\n- **Stage 2-current:** #492\n", "Stage 2").kind, "ambiguous");
  assert.equal(parseOptionalIssueRefGuarded("- **Stage 2:** #480\n- **Stage 2/current:** #492\n", "Stage 2").kind, "ambiguous");
});

test("parseOptionalIssueRefGuarded: a punctuation-delimited PR near-duplicate cannot silently route through a stale canonical pointer", () => {
  const result = parseOptionalIssueRefGuarded("- **PR:** #376\n- **PR-current:** #400\n", "PR");
  assert.equal(result.kind, "ambiguous");
  assert.match(result.reason, /#376/);
  assert.match(result.reason, /#400/);
});

test("parseOptionalIssueRefGuarded: normal control -- exactly one canonical value for Stage 2 and PR resolves unchanged", () => {
  assert.deepEqual(parseOptionalIssueRefGuarded("- **Stage 2:** #480\n", "Stage 2"), { kind: "issue", issue: 480 });
  assert.deepEqual(parseOptionalIssueRefGuarded("- **PR:** #376\n", "PR"), { kind: "issue", issue: 376 });
  assert.deepEqual(parseOptionalIssueRefGuarded("- **Stage 2:** none\n", "Stage 2"), { kind: "none" });
});

test("parseOptionalIssueRefGuarded: false-positive control -- unrelated bold bullets/prose containing similar words do not trigger the guard", () => {
  const body =
    "- **PR:** #376\n" +
    "- **Previous PR:** #100\n" +
    "Some prose about Stage 2 review timing does not use the bullet shape.\n";
  assert.deepEqual(parseOptionalIssueRefGuarded(body, "PR"), { kind: "issue", issue: 376 });
});

test("parseOptionalIssueRefGuarded: missing/malformed-value fields retain their existing fail-closed behavior", () => {
  assert.equal(parseOptionalIssueRefGuarded("", "PR").kind, "missing");
  assert.equal(parseOptionalIssueRefGuarded("- **PR:** #376 and also #400\n", "PR").kind, "invalid");
});

// -- resolvePreMergeVerdict ------------------------------------------------------------------

function stage1(state, overrides = {}) {
  const base =
    state === "RESPONSE_RECEIVED"
      ? {
          matches: [{ body_excerpt: "Codex Review: Didn't find any major issues." }],
          unboundGenuineMatches: [],
        }
      : {};
  return { exitCode: state === "NOT_REQUESTED" || state === "PENDING" ? 2 : 0, state, ...base, ...overrides };
}

function mergeReady(state, overrides = {}) {
  return { exitCode: state === "BLOCKED_CLOSING_REFERENCE" ? 2 : 0, state, ...overrides };
}

test("resolvePreMergeVerdict: NOT_REQUESTED -> NO_ACTION_YET", () => {
  const v = resolvePreMergeVerdict({ stage1: stage1("NOT_REQUESTED"), mergeReady: mergeReady("MERGE_READY") });
  assert.equal(v.state, "NO_ACTION_YET");
  assert.equal(v.stopAfter, true);
});

test("resolvePreMergeVerdict: PENDING -> NO_ACTION_YET regardless of merge-ready state", () => {
  const v = resolvePreMergeVerdict({ stage1: stage1("PENDING"), mergeReady: mergeReady("BLOCKED_CLOSING_REFERENCE") });
  assert.equal(v.state, "NO_ACTION_YET");
  assert.equal(v.stopAfter, true);
});

test("resolvePreMergeVerdict: PENDING with findings-bearing unbound genuine matches -> AMBIGUOUS", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("PENDING", {
      matches: [],
      unboundGenuineMatches: [
        { body_excerpt: "### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request." },
      ],
    }),
    mergeReady: mergeReady("MERGE_READY"),
  });
  assert.equal(v.state, "AMBIGUOUS");
  assert.equal(v.stopAfter, true);
  assert.match(v.reason, /unbound genuine matches/);
});

test("resolvePreMergeVerdict: RESPONSE_RECEIVED + MERGE_READY -> STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", () => {
  const v = resolvePreMergeVerdict({ stage1: stage1("RESPONSE_RECEIVED"), mergeReady: mergeReady("MERGE_READY") });
  assert.equal(v.state, "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2");
  assert.equal(v.stopAfter, true);
});

test("resolvePreMergeVerdict: EXEMPT + MERGE_READY_NO_WORK_ISSUE -> STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", () => {
  const v = resolvePreMergeVerdict({ stage1: stage1("EXEMPT"), mergeReady: mergeReady("MERGE_READY_NO_WORK_ISSUE") });
  assert.equal(v.state, "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2");
});

test("resolvePreMergeVerdict: RESPONSE_RECEIVED + BLOCKED_CLOSING_REFERENCE -> STAGE1_CORRECTION_REQUIRED", () => {
  const v = resolvePreMergeVerdict({ stage1: stage1("RESPONSE_RECEIVED"), mergeReady: mergeReady("BLOCKED_CLOSING_REFERENCE") });
  assert.equal(v.state, "STAGE1_CORRECTION_REQUIRED");
  assert.equal(v.stopAfter, true);
  assert.equal("stage1" in v, false);
  assert.equal("mergeReady" in v, false);
});

test("resolvePreMergeVerdict: EXEMPT + BLOCKED_CLOSING_REFERENCE -> STAGE1_CORRECTION_REQUIRED", () => {
  const v = resolvePreMergeVerdict({ stage1: stage1("EXEMPT"), mergeReady: mergeReady("BLOCKED_CLOSING_REFERENCE") });
  assert.equal(v.state, "STAGE1_CORRECTION_REQUIRED");
});

test("resolvePreMergeVerdict: findings-bearing RESPONSE_RECEIVED -> STAGE1_CORRECTION_REQUIRED even when merge-ready is otherwise ready", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("RESPONSE_RECEIVED", {
      matches: [{ body_excerpt: "### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request." }],
      unboundGenuineMatches: [],
    }),
    mergeReady: mergeReady("MERGE_READY"),
  });
  assert.equal(v.state, "STAGE1_CORRECTION_REQUIRED");
});

// PR #435's own live regression: the genuine Codex review body_excerpt for commit
// `30b36035c9` began with an insignificant leading newline before "### 💡 Codex Review",
// which the findings-preamble classifier's `^`-anchored pattern then failed to match --
// silently falling through to NO_ACTION_YET instead of STAGE1_CORRECTION_REQUIRED. Mirrors
// #435's actual evidence shape: a head-marked Stage 1 trigger, four bound inline-finding
// matches, a commit-bound review match whose body_excerpt carries the observed leading
// newline, and a concurrent commit-unbound "No findings" task-summary comment (real live
// evidence: matches neither fixed preamble, and must not itself flip the verdict).
test("resolvePreMergeVerdict: findings-bearing RESPONSE_RECEIVED whose body_excerpt begins with a leading newline (PR #435's own live regression shape) still resolves to STAGE1_CORRECTION_REQUIRED, never NO_ACTION_YET", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("RESPONSE_RECEIVED", {
      matches: [
        { body_excerpt: "**P1 Badge** Close the gated work issue before stopping\n\nWhen `checkPostAudit` returns..." },
        { body_excerpt: "**P1 Badge** Route already-consumed CLEAN audits to close-audit\n\nIn the motivating..." },
        { body_excerpt: "**P2 Badge** Classify closed audit issues before the open-state guard\n\nFor a directly..." },
        { body_excerpt: "**P2 Badge** Fetch all candidate successor audits\n\nOnce a repository has more than..." },
        { body_excerpt: "\n### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request." },
        { body_excerpt: "No findings. The changes are internally consistent, fail closed on ambiguous evidence..." },
      ],
      unboundGenuineMatches: [],
    }),
    mergeReady: mergeReady("MERGE_READY"),
  });
  assert.equal(v.state, "STAGE1_CORRECTION_REQUIRED");
  assert.notEqual(v.state, "NO_ACTION_YET");
});

test("resolvePreMergeVerdict: findings-bearing RESPONSE_RECEIVED + Stage 1 disposition satisfied at this head + MERGE_READY -> STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("RESPONSE_RECEIVED", {
      matches: [{ body_excerpt: "### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request." }],
      unboundGenuineMatches: [],
    }),
    mergeReady: mergeReady("MERGE_READY"),
    stage1Disposition: "satisfied at 1234abc",
  }, { head: "1234abcdef9876" });
  assert.equal(v.state, "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2");
});

test("resolvePreMergeVerdict: negative Stage 1 disposition text does not satisfy merge even when it names the current head", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("RESPONSE_RECEIVED", {
      matches: [{ body_excerpt: "### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request." }],
      unboundGenuineMatches: [],
    }),
    mergeReady: mergeReady("MERGE_READY"),
    stage1Disposition: "not satisfied at 1234abc",
  }, { head: "1234abcdef9876" });
  assert.equal(v.state, "STAGE1_CORRECTION_REQUIRED");
});

test("resolvePreMergeVerdict: an affirmative Stage 1 disposition without an exact-head sha does not satisfy merge", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("RESPONSE_RECEIVED", {
      matches: [{ body_excerpt: "### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request." }],
      unboundGenuineMatches: [],
    }),
    mergeReady: mergeReady("MERGE_READY"),
    stage1Disposition: "satisfied",
  }, { head: "1234abcdef9876" });
  assert.equal(v.state, "STAGE1_CORRECTION_REQUIRED");
});

test("resolvePreMergeVerdict: NOT_REQUESTED + stale/non-head-scoped Stage 1 disposition still stays NO_ACTION_YET", () => {
  const v = resolvePreMergeVerdict(
    {
      stage1: stage1("NOT_REQUESTED"),
      mergeReady: mergeReady("MERGE_READY"),
      stage1Disposition: "satisfied at 1234abc",
    },
    { head: "fffffff1234567" },
  );
  assert.equal(v.state, "NO_ACTION_YET");
});

// -- resolvePreMergeVerdict: correctionDelta (issue #454, unit 454-C) ------------------------

function correctionDelta(state, overrides = {}) {
  const base =
    state === "CORRECTION_SATISFIED" || state === "NOT_SATISFIED" || state === "HEAD_MISMATCH"
      ? { reviewedHead: "reviewed1234567", correctedHead: "corrected1234567" }
      : {};
  return { exitCode: state === "CORRECTION_SATISFIED" ? 0 : 2, state, ...base, ...overrides };
}

test("resolvePreMergeVerdict: NOT_REQUESTED + CORRECTION_SATISFIED + MERGE_READY -> STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2, carrying reviewedHead/correctedHead", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("NOT_REQUESTED"),
    mergeReady: mergeReady("MERGE_READY"),
    correctionDelta: correctionDelta("CORRECTION_SATISFIED"),
  });
  assert.equal(v.state, "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2");
  assert.equal(v.stopAfter, true);
  assert.equal(v.reviewedHead, "reviewed1234567");
  assert.equal(v.correctedHead, "corrected1234567");
});

test("resolvePreMergeVerdict: NOT_REQUESTED + CORRECTION_SATISFIED + MERGE_READY_NO_WORK_ISSUE -> STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("NOT_REQUESTED"),
    mergeReady: mergeReady("MERGE_READY_NO_WORK_ISSUE"),
    correctionDelta: correctionDelta("CORRECTION_SATISFIED"),
  });
  assert.equal(v.state, "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2");
});

test("resolvePreMergeVerdict: NOT_REQUESTED + CORRECTION_SATISFIED + BLOCKED_CLOSING_REFERENCE -> STAGE1_CORRECTION_REQUIRED", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("NOT_REQUESTED"),
    mergeReady: mergeReady("BLOCKED_CLOSING_REFERENCE"),
    correctionDelta: correctionDelta("CORRECTION_SATISFIED"),
  });
  assert.equal(v.state, "STAGE1_CORRECTION_REQUIRED");
  assert.equal(v.stopAfter, true);
});

test("resolvePreMergeVerdict: NOT_REQUESTED + CORRECTION_SATISFIED + an unrecognized-but-exitCode-0 merge-ready state still resolves to STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2 (P1 finding on PR #459: authorization is derived from merge-ready-gate.mjs's own combineMergeReadyResult, which -- like the real lifecycle-gate.mjs merge-ready check it composes -- trusts exitCode as authoritative, never a state-string allowlist a real component's exitCode-0 output could fall outside of)", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("NOT_REQUESTED"),
    mergeReady: mergeReady("SOMETHING_NEW"),
    correctionDelta: correctionDelta("CORRECTION_SATISFIED"),
  });
  assert.equal(v.state, "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2");
});

test("resolvePreMergeVerdict: NOT_REQUESTED + CORRECTION_SATISFIED + an operational-error mergeReady result falls through to the bottom-of-function AMBIGUOUS, never NO_ACTION_YET or a silent merge authorization", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("NOT_REQUESTED"),
    mergeReady: { exitCode: 1, state: "OPERATIONAL_ERROR", message: "lifecycle-gate merge-ready threw" },
    correctionDelta: correctionDelta("CORRECTION_SATISFIED"),
  });
  assert.equal(v.state, "AMBIGUOUS");
  assert.notEqual(v.state, "NO_ACTION_YET");
  assert.notEqual(v.state, "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2");
});

test("resolvePreMergeVerdict: NOT_REQUESTED + NOT_SATISFIED -> AMBIGUOUS, carrying the underlying reason", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("NOT_REQUESTED"),
    mergeReady: mergeReady("MERGE_READY"),
    correctionDelta: correctionDelta("NOT_SATISFIED", { reason: "reviewed head has no findings-bearing match" }),
  });
  assert.equal(v.state, "AMBIGUOUS");
  assert.equal(v.stopAfter, true);
  assert.match(v.reason, /reviewed head has no findings-bearing match/);
});

test("resolvePreMergeVerdict: NOT_REQUESTED + HEAD_MISMATCH -> NO_ACTION_YET (unchanged from today's behavior with no disposition at all)", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("NOT_REQUESTED"),
    mergeReady: mergeReady("MERGE_READY"),
    correctionDelta: correctionDelta("HEAD_MISMATCH"),
  });
  assert.equal(v.state, "NO_ACTION_YET");
  assert.equal(v.stopAfter, true);
});

test("resolvePreMergeVerdict: NOT_REQUESTED + no correction-satisfied-shaped disposition present at all -> NO_ACTION_YET", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("NOT_REQUESTED"),
    mergeReady: mergeReady("MERGE_READY"),
    correctionDelta: null,
  });
  assert.equal(v.state, "NO_ACTION_YET");
  assert.equal(v.stopAfter, true);
});

test("resolvePreMergeVerdict: NOT_REQUESTED + an operational error from checkCorrectionDelta -> AMBIGUOUS, never silently treated as a state", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("NOT_REQUESTED"),
    mergeReady: mergeReady("MERGE_READY"),
    correctionDelta: { exitCode: 1, message: "gh api compare call failed" },
  });
  assert.equal(v.state, "AMBIGUOUS");
  assert.match(v.reason, /checkCorrectionDelta/);
});

test("resolvePreMergeVerdict: NOT_REQUESTED + malformed correctionDelta (no exitCode) fails closed to AMBIGUOUS", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("NOT_REQUESTED"),
    mergeReady: mergeReady("MERGE_READY"),
    correctionDelta: { state: "CORRECTION_SATISFIED" },
  });
  assert.equal(v.state, "AMBIGUOUS");
});

test("resolvePreMergeVerdict: RESPONSE_RECEIVED without clean-pass or findings preamble (kickoff/ack shape) -> NO_ACTION_YET", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("RESPONSE_RECEIVED", {
      matches: [{ body_excerpt: "Starting review... I will report back with findings." }],
      unboundGenuineMatches: [],
    }),
    mergeReady: mergeReady("MERGE_READY"),
  });
  assert.equal(v.state, "NO_ACTION_YET");
});

test("resolvePreMergeVerdict: findings-bearing unbound genuine matches participate in correction routing", () => {
  const v = resolvePreMergeVerdict({
    stage1: stage1("RESPONSE_RECEIVED", {
      matches: [{ body_excerpt: "Codex Review: Didn't find any major issues." }],
      unboundGenuineMatches: [
        { body_excerpt: "### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request." },
      ],
    }),
    mergeReady: mergeReady("MERGE_READY"),
  });
  assert.equal(v.state, "STAGE1_CORRECTION_REQUIRED");
});

test("resolvePreMergeVerdict: an operational error from either composed check -> AMBIGUOUS, never silently treated as a state", () => {
  const v1 = resolvePreMergeVerdict({
    stage1: { exitCode: 1, message: "gh api call failed" },
    mergeReady: mergeReady("MERGE_READY"),
  });
  assert.equal(v1.state, "AMBIGUOUS");
  assert.equal(v1.stopAfter, true);
  assert.match(v1.reason, /stage1-gate operational error/);

  const v2 = resolvePreMergeVerdict({
    stage1: stage1("RESPONSE_RECEIVED"),
    mergeReady: { exitCode: 1, message: "gh pr view failed" },
  });
  assert.equal(v2.state, "AMBIGUOUS");
  assert.match(v2.reason, /lifecycle-gate merge-ready operational error/);
});

test("resolvePreMergeVerdict: malformed component output (no exitCode) fails closed to AMBIGUOUS", () => {
  const v = resolvePreMergeVerdict({ stage1: { state: "RESPONSE_RECEIVED" }, mergeReady: mergeReady("MERGE_READY") });
  assert.equal(v.state, "AMBIGUOUS");
  assert.equal(v.stopAfter, true);
});

test("resolvePreMergeVerdict: an unrecognized state combination fails closed to AMBIGUOUS rather than guessing", () => {
  const v = resolvePreMergeVerdict({ stage1: stage1("SOMETHING_NEW"), mergeReady: mergeReady("MERGE_READY") });
  assert.equal(v.state, "AMBIGUOUS");
  assert.match(v.reason, /SOMETHING_NEW/);
});

test("resolvePreMergeVerdict: carries the given context through on every verdict", () => {
  const v = resolvePreMergeVerdict(
    { stage1: stage1("RESPONSE_RECEIVED"), mergeReady: mergeReady("MERGE_READY") },
    { repo: "o/r", pr: 376, head: "abc", issue: 375, controlIssue: 322 },
  );
  assert.equal(v.repo, "o/r");
  assert.equal(v.pr, 376);
  assert.equal(v.head, "abc");
  assert.equal(v.issue, 375);
  assert.equal(v.controlIssue, 322);
});

// -- resolvePostMergeVerdict -----------------------------------------------------------------

function postAudit(state, overrides = {}) {
  return { exitCode: state === "PREMATURE_CLOSURE" || state === "RESPONSE_UNUSABLE" ? 2 : 0, state, ...overrides };
}

test("resolvePostMergeVerdict: READY_TO_CLOSE -> STAGE2_CLOSE_READY", () => {
  const v = resolvePostMergeVerdict({ postAudit: postAudit("READY_TO_CLOSE", { verdict: "CLEAN", workIssue: 379 }) });
  assert.equal(v.state, "STAGE2_CLOSE_READY");
  assert.equal(v.stopAfter, true);
});

test("resolvePostMergeVerdict: ACCEPTED_NO_WORK_ISSUE -> STAGE2_CLOSE_READY", () => {
  const v = resolvePostMergeVerdict({ postAudit: postAudit("ACCEPTED_NO_WORK_ISSUE", { verdict: "CLEAN", workIssue: null }) });
  assert.equal(v.state, "STAGE2_CLOSE_READY");
});

// Issue #407 unit 407-B, carried one step further by a Stage 1 review finding on PR #435:
// `close-audit` alone deliberately never touches the gated work issue (Shared Contract item
// 3), so `nextCommand` must also close it when READY_TO_CLOSE names a real one -- otherwise a
// CLEAN cycle leaves the work issue open indefinitely, one step down from the original
// #380/#384 defect this whole mechanism exists to fix.
test("resolvePostMergeVerdict: READY_TO_CLOSE with a real gated work issue carries a deterministic close-work-issue-then-close-audit nextCommand (Stage 1 review finding on PR #435)", () => {
  const v = resolvePostMergeVerdict(
    { postAudit: postAudit("READY_TO_CLOSE", { verdict: "CLEAN", workIssue: 379 }) },
    { repo: "LouPineWays/Loop-Dee-Loup", auditIssue: 380 },
  );
  assert.equal(v.state, "STAGE2_CLOSE_READY");
  assert.equal(
    v.nextCommand,
    "node tools/review-watch/lifecycle-gate.mjs close-work-issue --repo LouPineWays/Loop-Dee-Loup --work-issue 379 --audit-issue 380 && " +
      "node tools/review-watch/lifecycle-gate.mjs close-audit --repo LouPineWays/Loop-Dee-Loup --audit-issue 380",
  );
});

test("resolvePostMergeVerdict: ACCEPTED_NO_WORK_ISSUE carries only the audit-only close-audit nextCommand (no work issue exists to close)", () => {
  const v = resolvePostMergeVerdict(
    { postAudit: postAudit("ACCEPTED_NO_WORK_ISSUE", { verdict: "CLEAN", workIssue: null }) },
    { repo: "LouPineWays/Loop-Dee-Loup", auditIssue: 384 },
  );
  assert.equal(v.state, "STAGE2_CLOSE_READY");
  assert.equal(
    v.nextCommand,
    "node tools/review-watch/lifecycle-gate.mjs close-audit --repo LouPineWays/Loop-Dee-Loup --audit-issue 384",
  );
});

test("resolvePostMergeVerdict: OK with rawVerdict NOT CLEAN -> STAGE2_CORRECTION_REQUIRED", () => {
  const v = resolvePostMergeVerdict({ postAudit: postAudit("OK", { rawVerdict: "NOT CLEAN", verdict: "NOT CLEAN" }) });
  assert.equal(v.state, "STAGE2_CORRECTION_REQUIRED");
  assert.equal(v.stopAfter, true);
  assert.equal("postAudit" in v, false);
});

test("resolvePostMergeVerdict: OK with rawVerdict PENDING -> NO_ACTION_YET", () => {
  const v = resolvePostMergeVerdict({ postAudit: postAudit("OK", { rawVerdict: "PENDING", verdict: "PENDING" }) });
  assert.equal(v.state, "NO_ACTION_YET");
});

test("resolvePostMergeVerdict: OK with rawVerdict null (no response yet) -> NO_ACTION_YET", () => {
  const v = resolvePostMergeVerdict({ postAudit: postAudit("OK", { rawVerdict: null, verdict: null }) });
  assert.equal(v.state, "NO_ACTION_YET");
});

test("resolvePostMergeVerdict: OK with rawVerdict CLEAN but not backed by a completed report (verdict nulled) -> NO_ACTION_YET, not STAGE2_CLOSE_READY", () => {
  // lifecycle-gate.mjs's checkPostAudit nulls out `verdict` (keeping `rawVerdict: "CLEAN"`)
  // when no completed Stage 2 report backs the dropdown value yet -- this must not be
  // silently treated as ready to close.
  const v = resolvePostMergeVerdict({ postAudit: postAudit("OK", { rawVerdict: "CLEAN", verdict: null }) });
  assert.equal(v.state, "NO_ACTION_YET");
});

// Stage 1 review finding on PR #435: the motivating resume case -- the work issue is already
// closed but its backed-CLEAN audit was never consumed -- reaches checkPostAudit's generic
// `OK` branch (never `READY_TO_CLOSE`, which requires the work issue to still be open) as
// `verdict: "CLEAN"` / `workIssueState: "CLOSED"`, and previously fell through to
// `NO_ACTION_YET` below, preserving the exact #380/#384 defect. Must route to
// `STAGE2_CLOSE_READY` too, audit-only -- the work issue is already closed, so `nextCommand`
// must never re-attempt closing it.
test("resolvePostMergeVerdict: OK with verdict CLEAN and workIssueState CLOSED (already-consumed CLEAN, work issue closed but audit issue still open) -> STAGE2_CLOSE_READY, audit-only nextCommand", () => {
  const v = resolvePostMergeVerdict(
    { postAudit: postAudit("OK", { rawVerdict: "CLEAN", verdict: "CLEAN", workIssueState: "CLOSED", workIssue: 379 }) },
    { repo: "LouPineWays/Loop-Dee-Loup", auditIssue: 380 },
  );
  assert.equal(v.state, "STAGE2_CLOSE_READY");
  assert.equal(v.stopAfter, true);
  assert.equal(
    v.nextCommand,
    "node tools/review-watch/lifecycle-gate.mjs close-audit --repo LouPineWays/Loop-Dee-Loup --audit-issue 380",
  );
});

test("resolvePostMergeVerdict: OK with verdict CLEAN but workIssueState still OPEN is not the already-consumed shape -> falls through to NO_ACTION_YET unchanged", () => {
  // Defensive: checkPostAudit's own branching means CLEAN + still-open should always resolve
  // to READY_TO_CLOSE, never plain OK -- but this gate must not itself invent a STAGE2_CLOSE_READY
  // result from workIssueState alone without also requiring a backed CLEAN verdict.
  const v = resolvePostMergeVerdict({
    postAudit: postAudit("OK", { rawVerdict: "CLEAN", verdict: "CLEAN", workIssueState: "OPEN", workIssue: 379 }),
  });
  assert.equal(v.state, "NO_ACTION_YET");
});

// -- REPORT_READY_TO_RECORD -> STAGE2_REPORT_READY_TO_RECORD (issue #439, the live #408/#436
// gap) -----------------------------------------------------------------------------------------

test("resolvePostMergeVerdict: REPORT_READY_TO_RECORD -> STAGE2_REPORT_READY_TO_RECORD, carrying the exact record-verdict nextCommand", () => {
  const v = resolvePostMergeVerdict(
    { postAudit: postAudit("REPORT_READY_TO_RECORD", { rawVerdict: "PENDING", reportEvidence: { verdict: "CLEAN" } }) },
    { repo: "LouPineWays/Loop-Dee-Loup", auditIssue: 436 },
  );
  assert.equal(v.state, "STAGE2_REPORT_READY_TO_RECORD");
  assert.equal(v.stopAfter, true);
  assert.equal(
    v.nextCommand,
    "node tools/review-watch/lifecycle-gate.mjs record-verdict --repo LouPineWays/Loop-Dee-Loup --audit-issue 436",
  );
});

test("resolvePostMergeVerdict: REPORT_READY_TO_RECORD with a NOT CLEAN-backed report also maps to STAGE2_REPORT_READY_TO_RECORD (promotion is verdict-agnostic; correction routing happens after a fresh gate re-run)", () => {
  const v = resolvePostMergeVerdict(
    { postAudit: postAudit("REPORT_READY_TO_RECORD", { rawVerdict: null, reportEvidence: { verdict: "NOT CLEAN" } }) },
    { repo: "owner/repo", auditIssue: 160 },
  );
  assert.equal(v.state, "STAGE2_REPORT_READY_TO_RECORD");
  assert.equal(
    v.nextCommand,
    "node tools/review-watch/lifecycle-gate.mjs record-verdict --repo owner/repo --audit-issue 160",
  );
});

// -- RESPONSE_UNUSABLE -> STAGE2_RESPONSE_UNUSABLE (issue #447, live reproductions #446 and
// #380's first round) -------------------------------------------------------------------------

test("resolvePostMergeVerdict: RESPONSE_UNUSABLE -> STAGE2_RESPONSE_UNUSABLE, a distinct fail-closed stop, never ordinary NO_ACTION_YET and never generic AMBIGUOUS", () => {
  const v = resolvePostMergeVerdict(
    {
      postAudit: postAudit("RESPONSE_UNUSABLE", {
        rawVerdict: "PENDING",
        workIssue: 439,
        reportEvidence: { backed: false, hasGenuineResponse: true, genuineResponsesSeen: 1 },
      }),
    },
    { repo: "LouPineWays/Loop-Dee-Loup", auditIssue: 446 },
  );
  assert.equal(v.state, "STAGE2_RESPONSE_UNUSABLE");
  assert.equal(v.stopAfter, true);
  assert.equal(v.postAudit.reportEvidence.hasGenuineResponse, true, "the exact genuine-response evidence must reach the composed verdict, not be summarized away");
});

test("resolvePostMergeVerdict: RESPONSE_UNUSABLE carries no nextCommand — it authorizes a bounded recovery/founder-interrupt stop, never an automatic mutation", () => {
  const v = resolvePostMergeVerdict(
    { postAudit: postAudit("RESPONSE_UNUSABLE", { rawVerdict: "PENDING", workIssue: 374 }) },
    { repo: "LouPineWays/Loop-Dee-Loup", auditIssue: 380 },
  );
  assert.equal(v.state, "STAGE2_RESPONSE_UNUSABLE");
  assert.equal("nextCommand" in v, false, "unlike STAGE2_CLOSE_READY/STAGE2_REPORT_READY_TO_RECORD, this state must never carry an automatic next mutation");
});

test("resolvePostMergeVerdict: PREMATURE_CLOSURE -> AMBIGUOUS (a recoverable-but-abnormal state this read-only gate does not resolve on its own)", () => {
  const v = resolvePostMergeVerdict({ postAudit: postAudit("PREMATURE_CLOSURE", { verdict: null, rawVerdict: null }) });
  assert.equal(v.state, "AMBIGUOUS");
  assert.equal(v.stopAfter, true);
});

test("resolvePostMergeVerdict: an operational error -> AMBIGUOUS", () => {
  const v = resolvePostMergeVerdict({ postAudit: { exitCode: 1, message: "gh issue view failed" } });
  assert.equal(v.state, "AMBIGUOUS");
  assert.match(v.reason, /operational error/);
});

test("resolvePostMergeVerdict: malformed component output (no exitCode) fails closed to AMBIGUOUS", () => {
  const v = resolvePostMergeVerdict({ postAudit: { state: "OK" } });
  assert.equal(v.state, "AMBIGUOUS");
});

// -- runNextReviewTransitionGate: direct-reference mode --------------------------------------

test("runNextReviewTransitionGate: direct --pr/--head/--issue mode resolves without any control-Issue read", async () => {
  let issueReadCalls = 0;
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", pr: "376", head: "sha1", issue: "375" },
    {
      ghIssueViewImpl: async () => {
        issueReadCalls++;
        return { body: "", state: "OPEN" };
      },
      stage1RunImpl: async (args) => {
        assert.equal(args.repo, "o/r");
        assert.equal(args.number, "376");
        assert.equal(args.head, "sha1");
        return stage1("RESPONSE_RECEIVED");
      },
      checkMergeReadyImpl: async (args) => {
        assert.equal(args.pr, "376");
        assert.equal(args.issue, "375");
        return { exitCode: 0, state: "MERGE_READY" };
      },
    },
  );
  assert.equal(issueReadCalls, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2");
  assert.equal(result.stopAfter, true);
});

test("runNextReviewTransitionGate: direct --pr/--head/--issue mode accepts --stage1-disposition and resolves a correction-satisfied head to STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2 (Stage 1 review finding on PR #459)", async () => {
  let issueReadCalls = 0;
  let correctionDeltaCalls = 0;
  const result = await runNextReviewTransitionGate(
    {
      repo: "o/r",
      pr: "376",
      head: "0009c54b18",
      issue: "375",
      stage1Disposition: "correction-satisfied at 0009c54b18 (reviewed 30b36035c9)",
    },
    {
      ghIssueViewImpl: async () => {
        issueReadCalls++;
        return { body: "", state: "OPEN" };
      },
      stage1RunImpl: async () => stage1("NOT_REQUESTED"),
      checkMergeReadyImpl: async () => ({ exitCode: 0, state: "MERGE_READY" }),
      checkCorrectionDeltaImpl: async (args) => {
        correctionDeltaCalls++;
        assert.equal(args.reviewedHead, "30b36035c9");
        assert.equal(args.correctedHead, "0009c54b18");
        return { exitCode: 0, state: "CORRECTION_SATISFIED", reviewedHead: "30b36035c9", correctedHead: "0009c54b18" };
      },
    },
  );
  assert.equal(issueReadCalls, 0);
  assert.equal(correctionDeltaCalls, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2");
});

test("runNextReviewTransitionGate: direct --pr/--head/--issue mode without --stage1-disposition never invokes checkCorrectionDeltaImpl (unchanged default behavior)", async () => {
  let correctionDeltaCalls = 0;
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", pr: "376", head: "sha1", issue: "375" },
    {
      ghIssueViewImpl: async () => ({ body: "", state: "OPEN" }),
      stage1RunImpl: async () => stage1("NOT_REQUESTED"),
      checkMergeReadyImpl: async () => ({ exitCode: 0, state: "MERGE_READY" }),
      checkCorrectionDeltaImpl: async () => {
        correctionDeltaCalls++;
        throw new Error("should never be called when no correction-satisfied disposition is supplied");
      },
    },
  );
  assert.equal(correctionDeltaCalls, 0);
  assert.equal(result.state, "NO_ACTION_YET");
});

test("runNextReviewTransitionGate: direct --pr without --head fails closed with exit 1", async () => {
  const result = await runNextReviewTransitionGate({ repo: "o/r", pr: "376" });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--head/);
});

test("runNextReviewTransitionGate: direct --pr/--head without --issue fails closed with exit 1", async () => {
  const result = await runNextReviewTransitionGate({ repo: "o/r", pr: "376", head: "sha1" });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--issue/);
});

test("runNextReviewTransitionGate: direct --audit-issue mode resolves without any control-Issue read", async () => {
  let issueReadCalls = 0;
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", auditIssue: "378" },
    {
      ghIssueViewImpl: async () => {
        issueReadCalls++;
        return { body: "", state: "OPEN" };
      },
      checkPostAuditImpl: async (args) => {
        assert.equal(args.repo, "o/r");
        assert.equal(args["audit-issue"], "378");
        return { exitCode: 0, state: "READY_TO_CLOSE", verdict: "CLEAN" };
      },
    },
  );
  assert.equal(issueReadCalls, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "STAGE2_CLOSE_READY");
});

test("runNextReviewTransitionGate: direct --audit-issue mode resolves REPORT_READY_TO_RECORD to STAGE2_REPORT_READY_TO_RECORD, exit 0, with the exact record-verdict nextCommand (issue #439)", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", auditIssue: "436" },
    {
      checkPostAuditImpl: async (args) => {
        assert.equal(args["audit-issue"], "436");
        return { exitCode: 0, state: "REPORT_READY_TO_RECORD", rawVerdict: "PENDING", reportEvidence: { verdict: "CLEAN" } };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "STAGE2_REPORT_READY_TO_RECORD");
  assert.equal(result.stopAfter, true);
  assert.equal(result.nextCommand, "node tools/review-watch/lifecycle-gate.mjs record-verdict --repo o/r --audit-issue 436");
});

test("runNextReviewTransitionGate: direct --audit-issue mode resolves RESPONSE_UNUSABLE to STAGE2_RESPONSE_UNUSABLE, exit 4, a distinct fail-closed stop (issue #447)", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: "LouPineWays/Loop-Dee-Loup", auditIssue: "446" },
    {
      checkPostAuditImpl: async (args) => {
        assert.equal(args["audit-issue"], "446");
        return {
          exitCode: 2,
          state: "RESPONSE_UNUSABLE",
          rawVerdict: "PENDING",
          workIssue: 439,
          reportEvidence: { backed: false, hasGenuineResponse: true, genuineResponsesSeen: 1 },
        };
      },
    },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "STAGE2_RESPONSE_UNUSABLE");
  assert.equal(result.stopAfter, true);
});

test("runNextReviewTransitionGate: --audit-issue takes precedence over --control-issue when both are given", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322", auditIssue: "378" },
    {
      ghIssueViewImpl: async () => {
        throw new Error("should never be called");
      },
      checkPostAuditImpl: async () => ({ exitCode: 0, state: "READY_TO_CLOSE", verdict: "CLEAN" }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "STAGE2_CLOSE_READY");
});

// -- runNextReviewTransitionGate: control-Issue mode -------------------------------------------

const CONTROL_BODY_PRE_MERGE = `## Current state

- **Lifecycle:** REVIEW
- **Execution:** #375
- **Route:** implementation worker
- **PR:** #376
- **Stage 1:** requested
- **Stage 2:** none
- **Blocker:** none
- **Founder decision:** none
`;

const CONTROL_BODY_PRE_MERGE_SATISFIED = `## Current state

- **Lifecycle:** REVIEW
- **Execution:** #375
- **Route:** implementation worker
- **PR:** #376
- **Stage 1:** satisfied at 1234abc
- **Stage 2:** none
- **Blocker:** none
- **Founder decision:** none
`;

const CONTROL_BODY_POST_MERGE = `## Current state

- **Lifecycle:** AUDIT
- **Execution:** #375
- **Route:** implementation worker
- **PR:** #376
- **Stage 1:** satisfied
- **Stage 2:** #378
- **Blocker:** none
- **Founder decision:** none
`;

const CONTROL_BODY_NEITHER = `## Current state

- **Lifecycle:** EXECUTING
- **Execution:** #375
- **Route:** implementation worker
- **PR:** none
- **Stage 1:** none
- **Stage 2:** none
- **Blocker:** none
- **Founder decision:** none
`;

test("runNextReviewTransitionGate: control-Issue mode with a settled PR (no Stage 2 yet) resolves the pre-merge phase, deriving head live", async () => {
  let prHeadReadFor = null;
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    {
      ghIssueViewImpl: async ({ number }) => {
        assert.equal(number, "322");
        return { body: CONTROL_BODY_PRE_MERGE, state: "OPEN" };
      },
      ghPrHeadImpl: async ({ number }) => {
        prHeadReadFor = number;
        return "livehead123";
      },
      stage1RunImpl: async (args) => {
        assert.equal(args.number, 376);
        assert.equal(args.head, "livehead123");
        return stage1("RESPONSE_RECEIVED");
      },
      checkMergeReadyImpl: async (args) => {
        assert.equal(args.pr, 376);
        assert.equal(args.issue, 375);
        return { exitCode: 0, state: "MERGE_READY" };
      },
    },
  );
  assert.equal(prHeadReadFor, 376);
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2");
  assert.equal(result.controlIssue, 322);
});

test("runNextReviewTransitionGate: Stage 1 satisfied text does not override NOT_REQUESTED at a different live head", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    {
      ghIssueViewImpl: async ({ number }) => {
        assert.equal(number, "322");
        return { body: CONTROL_BODY_PRE_MERGE_SATISFIED, state: "OPEN" };
      },
      ghPrHeadImpl: async () => "deadbeefcafef00d",
      stage1RunImpl: async () => ({ exitCode: 2, state: "NOT_REQUESTED" }),
      checkMergeReadyImpl: async () => ({ exitCode: 0, state: "MERGE_READY" }),
    },
  );
  assert.equal(result.state, "NO_ACTION_YET");
});

// -- runNextReviewTransitionGate: correction-satisfied disposition (issue #454, unit 454-C) --

const CONTROL_BODY_PRE_MERGE_CORRECTION_SATISFIED = `## Current state

- **Lifecycle:** REVIEW
- **Execution:** #375
- **Route:** implementation worker
- **PR:** #376
- **Stage 1:** correction-satisfied at 0009c54b18 (reviewed 30b36035c9)
- **Stage 2:** none
- **Blocker:** none
- **Founder decision:** none
`;

test("runNextReviewTransitionGate: control-Issue mode with a correction-satisfied Stage 1 disposition and MERGE_READY resolves to STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2, invoking checkCorrectionDeltaImpl with the parsed heads and the live gated head", async () => {
  let correctionDeltaCallArgs = null;
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    {
      ghIssueViewImpl: async () => ({ body: CONTROL_BODY_PRE_MERGE_CORRECTION_SATISFIED, state: "OPEN" }),
      ghPrHeadImpl: async () => "0009c54b18",
      stage1RunImpl: async () => ({ exitCode: 2, state: "NOT_REQUESTED" }),
      checkMergeReadyImpl: async () => ({ exitCode: 0, state: "MERGE_READY" }),
      checkCorrectionDeltaImpl: async (args) => {
        correctionDeltaCallArgs = args;
        return { exitCode: 0, state: "CORRECTION_SATISFIED", reviewedHead: "30b36035c9", correctedHead: "0009c54b18" };
      },
    },
  );
  assert.deepEqual(correctionDeltaCallArgs, {
    repo: "o/r",
    pr: 376,
    reviewedHead: "30b36035c9",
    correctedHead: "0009c54b18",
    gatedHead: "0009c54b18",
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2");
  assert.equal(result.stopAfter, true);
  assert.equal(result.reviewedHead, "30b36035c9");
  assert.equal(result.correctedHead, "0009c54b18");
});

test("runNextReviewTransitionGate: control-Issue mode with a correction-satisfied disposition but BLOCKED_CLOSING_REFERENCE resolves to STAGE1_CORRECTION_REQUIRED", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    {
      ghIssueViewImpl: async () => ({ body: CONTROL_BODY_PRE_MERGE_CORRECTION_SATISFIED, state: "OPEN" }),
      ghPrHeadImpl: async () => "0009c54b18",
      stage1RunImpl: async () => ({ exitCode: 2, state: "NOT_REQUESTED" }),
      checkMergeReadyImpl: async () => ({ exitCode: 2, state: "BLOCKED_CLOSING_REFERENCE" }),
      checkCorrectionDeltaImpl: async () => ({ exitCode: 0, state: "CORRECTION_SATISFIED", reviewedHead: "30b36035c9", correctedHead: "0009c54b18" }),
    },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "STAGE1_CORRECTION_REQUIRED");
});

test("runNextReviewTransitionGate: control-Issue mode with a correction-satisfied disposition whose evidence does not check out (NOT_SATISFIED) resolves to AMBIGUOUS", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    {
      ghIssueViewImpl: async () => ({ body: CONTROL_BODY_PRE_MERGE_CORRECTION_SATISFIED, state: "OPEN" }),
      ghPrHeadImpl: async () => "0009c54b18",
      stage1RunImpl: async () => ({ exitCode: 2, state: "NOT_REQUESTED" }),
      checkMergeReadyImpl: async () => ({ exitCode: 0, state: "MERGE_READY" }),
      checkCorrectionDeltaImpl: async () => ({
        exitCode: 2,
        state: "NOT_SATISFIED",
        reviewedHead: "30b36035c9",
        correctedHead: "0009c54b18",
        reason: "compare(30b36035c9...0009c54b18) reported status \"identical\"",
      }),
    },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "AMBIGUOUS");
  assert.match(result.reason, /compare\(30b36035c9\.\.\.0009c54b18\)/);
});

test("runNextReviewTransitionGate: control-Issue mode with a correction-satisfied disposition naming a different (stale) head than the live gated head resolves to NO_ACTION_YET (HEAD_MISMATCH)", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    {
      ghIssueViewImpl: async () => ({ body: CONTROL_BODY_PRE_MERGE_CORRECTION_SATISFIED, state: "OPEN" }),
      ghPrHeadImpl: async () => "somesupersededhead",
      stage1RunImpl: async () => ({ exitCode: 2, state: "NOT_REQUESTED" }),
      checkMergeReadyImpl: async () => ({ exitCode: 0, state: "MERGE_READY" }),
      checkCorrectionDeltaImpl: async () => ({
        exitCode: 2,
        state: "HEAD_MISMATCH",
        reviewedHead: "30b36035c9",
        correctedHead: "0009c54b18",
        gatedHead: "somesupersededhead",
      }),
    },
  );
  assert.equal(result.state, "NO_ACTION_YET");
});

test("runNextReviewTransitionGate: control-Issue mode with no correction-satisfied-shaped Stage 1 disposition at all never invokes checkCorrectionDeltaImpl (no wasted gh call on the common path)", async () => {
  let correctionDeltaCalls = 0;
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    {
      ghIssueViewImpl: async () => ({ body: CONTROL_BODY_PRE_MERGE, state: "OPEN" }),
      ghPrHeadImpl: async () => "livehead123",
      stage1RunImpl: async () => ({ exitCode: 2, state: "NOT_REQUESTED" }),
      checkMergeReadyImpl: async () => ({ exitCode: 0, state: "MERGE_READY" }),
      checkCorrectionDeltaImpl: async () => {
        correctionDeltaCalls++;
        throw new Error("should never be called when no correction-satisfied disposition parses");
      },
    },
  );
  assert.equal(correctionDeltaCalls, 0);
  assert.equal(result.state, "NO_ACTION_YET");
});

test("runNextReviewTransitionGate: control-Issue mode never invokes checkCorrectionDeltaImpl when stage1-gate is not NOT_REQUESTED, even if a correction-satisfied disposition is present (a fresh Stage 1 round already applies)", async () => {
  let correctionDeltaCalls = 0;
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    {
      ghIssueViewImpl: async () => ({ body: CONTROL_BODY_PRE_MERGE_CORRECTION_SATISFIED, state: "OPEN" }),
      ghPrHeadImpl: async () => "0009c54b18",
      stage1RunImpl: async () => stage1("RESPONSE_RECEIVED"),
      checkMergeReadyImpl: async () => ({ exitCode: 0, state: "MERGE_READY" }),
      checkCorrectionDeltaImpl: async () => {
        correctionDeltaCalls++;
        throw new Error("should never be called when stage1-gate is not NOT_REQUESTED");
      },
    },
  );
  assert.equal(correctionDeltaCalls, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2");
});

test("runNextReviewTransitionGate: control-Issue mode honors an explicit --head, skipping the PR-head read", async () => {
  let prHeadReadCalls = 0;
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322", head: "explicit-sha" },
    {
      ghIssueViewImpl: async () => ({ body: CONTROL_BODY_PRE_MERGE, state: "OPEN" }),
      ghPrHeadImpl: async () => {
        prHeadReadCalls++;
        return "should-not-be-used";
      },
      stage1RunImpl: async (args) => {
        assert.equal(args.head, "explicit-sha");
        return stage1("RESPONSE_RECEIVED");
      },
      checkMergeReadyImpl: async () => ({ exitCode: 0, state: "MERGE_READY" }),
    },
  );
  assert.equal(prHeadReadCalls, 0);
  assert.equal(result.exitCode, 0);
});

test("runNextReviewTransitionGate: the exact #440 regression -- stale 'Stage 2: #480' plus live 'Stage 2 (current): #492' fails closed as AMBIGUOUS before either audit reference can select a Stage 2 transition, never calling checkPostAudit", async () => {
  const body = CONTROL_BODY_POST_MERGE.replace("- **Stage 2:** #378", "- **Stage 2:** #480\n- **Stage 2 (current):** #492");
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      checkPostAuditImpl: async () => {
        throw new Error("should never be called -- the near-duplicate guard must fail closed first");
      },
    },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "AMBIGUOUS");
  assert.match(result.reason, /#480/);
  assert.match(result.reason, /#492/);
});

// Stage 1 review finding on this PR: the same #440 shape recurs with a punctuation-delimited
// qualifier instead of a parenthetical, and must fail closed the same way end to end.
test("runNextReviewTransitionGate: a punctuation-delimited Stage 2 near-duplicate ('Stage 2-current') fails closed as AMBIGUOUS the same way as the parenthetical form", async () => {
  const body = CONTROL_BODY_POST_MERGE.replace("- **Stage 2:** #378", "- **Stage 2:** #480\n- **Stage 2-current:** #492");
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      checkPostAuditImpl: async () => {
        throw new Error("should never be called -- the near-duplicate guard must fail closed first");
      },
    },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "AMBIGUOUS");
  assert.match(result.reason, /#480/);
  assert.match(result.reason, /#492/);
});

test("runNextReviewTransitionGate: control-Issue mode with a settled Stage 2 (Audit) reference resolves the post-merge phase", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    {
      ghIssueViewImpl: async () => ({ body: CONTROL_BODY_POST_MERGE, state: "OPEN" }),
      checkPostAuditImpl: async (args) => {
        assert.equal(args["audit-issue"], 378);
        return { exitCode: 0, state: "OK", rawVerdict: "NOT CLEAN", verdict: "NOT CLEAN" };
      },
    },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "STAGE2_CORRECTION_REQUIRED");
  assert.equal(result.controlIssue, 322);
  assert.equal(result.auditIssue, 378);
});

test("runNextReviewTransitionGate: closed control Issues fail closed before transition resolution", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    {
      ghIssueViewImpl: async () => ({ body: CONTROL_BODY_PRE_MERGE, state: "CLOSED" }),
    },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "AMBIGUOUS");
  assert.match(result.reason, /not OPEN/);
});

test("runNextReviewTransitionGate: control-Issue mode with neither PR nor Stage 2 settled -> AMBIGUOUS, exit 4", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    { ghIssueViewImpl: async () => ({ body: CONTROL_BODY_NEITHER, state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "AMBIGUOUS");
  assert.match(result.reason, /neither a settled "PR" nor "Stage 2" reference/);
});

test("runNextReviewTransitionGate: a malformed Stage 2 reference fails closed to AMBIGUOUS without ever calling checkPostAudit", async () => {
  const body = CONTROL_BODY_PRE_MERGE.replace("- **Stage 2:** none", "- **Stage 2:** #378 and also #400");
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      checkPostAuditImpl: async () => {
        throw new Error("should never be called for a malformed reference");
      },
    },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "AMBIGUOUS");
  assert.match(result.reason, /Stage 2 \(Audit\) reference is malformed/);
});

test("runNextReviewTransitionGate: a malformed Execution reference on an otherwise pre-merge-shaped control Issue fails closed to AMBIGUOUS", async () => {
  const body = CONTROL_BODY_PRE_MERGE.replace("- **Execution:** #375", "- **Execution:** none");
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      stage1RunImpl: async () => {
        throw new Error("should never be called when Execution is malformed");
      },
    },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "AMBIGUOUS");
  assert.match(result.reason, /Execution reference/);
});

test("runNextReviewTransitionGate: control-Issue mode accepts the live 'Execution issue' spelling", async () => {
  const body = CONTROL_BODY_PRE_MERGE.replace("- **Execution:** #375", "- **Execution issue:** #375");
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "322" },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      ghPrHeadImpl: async () => "livehead123",
      stage1RunImpl: async () => stage1("RESPONSE_RECEIVED"),
      checkMergeReadyImpl: async () => mergeReady("MERGE_READY"),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2");
});

test("runNextReviewTransitionGate: missing every required arg fails closed with exit 1", async () => {
  const result = await runNextReviewTransitionGate({ repo: "o/r" });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--control-issue/);
});

test("runNextReviewTransitionGate: a gh issue view failure for --control-issue fails closed with exit 1", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "999" },
    {
      ghIssueViewImpl: async () => {
        throw new Error("could not resolve to an Issue");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /999/);
});

test("runNextReviewTransitionGate: the normal path (no explicit --repo) resolves repository identity via resolveRepoIdentityImpl", async () => {
  let sawRepo = null;
  const result = await runNextReviewTransitionGate(
    { controlIssue: "322" },
    {
      resolveRepoIdentityImpl: () => ({ ok: true, repo: "LouPineWays/Loop-Dee-Loup" }),
      ghIssueViewImpl: async ({ repo }) => {
        sawRepo = repo;
        return { body: CONTROL_BODY_NEITHER, state: "OPEN" };
      },
    },
  );
  assert.equal(sawRepo, "LouPineWays/Loop-Dee-Loup");
  assert.equal(result.repo, "LouPineWays/Loop-Dee-Loup");
});

test("runNextReviewTransitionGate: a repository-identity resolution failure is a distinct ERROR (exit 1), and never reads the control Issue", async () => {
  let issueReadCalls = 0;
  const result = await runNextReviewTransitionGate(
    { controlIssue: "322" },
    {
      resolveRepoIdentityImpl: () => ({ ok: false, reason: "no configured origin remote" }),
      ghIssueViewImpl: async () => {
        issueReadCalls++;
        return { body: CONTROL_BODY_NEITHER, state: "OPEN" };
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(issueReadCalls, 0);
  assert.match(result.message, /repository identity/);
});

// -- the #408-shaped live proof this plan's own root-cause finding describes -----------------

test("runNextReviewTransitionGate: a #375-shaped mid-cycle control Issue (PR requested, Stage 1 pending) resolves to NO_ACTION_YET, never a hand-composed multi-step sequence", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "375" },
    {
      ghIssueViewImpl: async () => ({ body: CONTROL_BODY_PRE_MERGE, state: "OPEN" }),
      ghPrHeadImpl: async () => "sha-at-trigger",
      stage1RunImpl: async () => ({ exitCode: 2, state: "PENDING", triggerTimestamp: "2026-09-01T00:00:00Z" }),
      checkMergeReadyImpl: async () => ({ exitCode: 0, state: "MERGE_READY" }),
    },
  );
  assert.equal(result.state, "NO_ACTION_YET");
  assert.equal(result.stopAfter, true);
});
