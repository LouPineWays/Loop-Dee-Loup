// Tests for tools/orchestration/next-review-transition-gate.mjs -- worker unit 397-B's
// deterministic post-PR transition gate. Every composed check (stage1-gate.mjs's `run`,
// lifecycle-gate.mjs's `checkMergeReady`/`checkPostAudit`) is faked via injected
// stage1RunImpl/checkMergeReadyImpl/checkPostAuditImpl -- never touch the real network or
// `gh` CLI here, mirroring tools/review-watch/merge-ready-gate.test.mjs's own style.
//
// Run with:
//   node --test tools/orchestration/next-review-transition-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseOptionalIssueRef,
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
  return { exitCode: state === "PREMATURE_CLOSURE" ? 2 : 0, state, ...overrides };
}

test("resolvePostMergeVerdict: READY_TO_CLOSE -> STAGE2_CLOSE_READY", () => {
  const v = resolvePostMergeVerdict({ postAudit: postAudit("READY_TO_CLOSE", { verdict: "CLEAN" }) });
  assert.equal(v.state, "STAGE2_CLOSE_READY");
  assert.equal(v.stopAfter, true);
});

test("resolvePostMergeVerdict: ACCEPTED_NO_WORK_ISSUE -> STAGE2_CLOSE_READY", () => {
  const v = resolvePostMergeVerdict({ postAudit: postAudit("ACCEPTED_NO_WORK_ISSUE", { verdict: "CLEAN" }) });
  assert.equal(v.state, "STAGE2_CLOSE_READY");
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
