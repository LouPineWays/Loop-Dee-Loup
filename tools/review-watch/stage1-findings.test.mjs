// Tests for tools/review-watch/stage1-findings.mjs. Run with:
//   node --test tools/review-watch/stage1-findings.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { isCleanReviewResponse, isFindingsBearingResponse, isFormalReviewEndpoint } from "./stage1-findings.mjs";

test("isFormalReviewEndpoint: accepts pull-comments (inline review comment)", () => {
  assert.equal(isFormalReviewEndpoint("pull-comments"), true);
});

test("isFormalReviewEndpoint: accepts pull-reviews (review submission)", () => {
  assert.equal(isFormalReviewEndpoint("pull-reviews"), true);
});

test("isFormalReviewEndpoint: rejects issue-comments (plain PR conversation comment)", () => {
  assert.equal(isFormalReviewEndpoint("issue-comments"), false);
});

test("isFormalReviewEndpoint: rejects an unknown/malformed endpoint name rather than guessing", () => {
  assert.equal(isFormalReviewEndpoint("combined"), false);
  assert.equal(isFormalReviewEndpoint(undefined), false);
});

test("isCleanReviewResponse: recognizes the exact existing 'Reviewed. No issues found.' fixture", () => {
  assert.equal(isCleanReviewResponse("Reviewed. No issues found."), true);
});

test("isCleanReviewResponse: recognizes 'Reviewed after retry. No issues found.'", () => {
  assert.equal(isCleanReviewResponse("Reviewed after retry. No issues found."), true);
});

test("isCleanReviewResponse: recognizes a head-specific 'Reviewed head B. No issues found.'", () => {
  assert.equal(isCleanReviewResponse("Reviewed head B. No issues found."), true);
});

test("isCleanReviewResponse: recognizes a bare 'LGTM'", () => {
  assert.equal(isCleanReviewResponse("LGTM"), true);
});

test("isCleanReviewResponse: recognizes 'Looks good to me.'", () => {
  assert.equal(isCleanReviewResponse("Looks good to me."), true);
});

test("isCleanReviewResponse: recognizes 'No actionable findings.'", () => {
  assert.equal(isCleanReviewResponse("No actionable findings."), true);
});

test("isCleanReviewResponse: recognizes 'Looks correct, no issues found.' (consumer-sync-gate.test.mjs YouTubery #98 regression fixture)", () => {
  assert.equal(isCleanReviewResponse("Looks correct, no issues found."), true);
});

test("isCleanReviewResponse: recognizes Codex's own fixed clean-pass preamble 'Codex Review: Didn't find any major issues.' (consumer-sync-gate.mjs's CLEAN_REVIEW_PATTERN, observed live on PRs #257/#266)", () => {
  assert.equal(isCleanReviewResponse("Codex Review: Didn't find any major issues. Nice work!"), true);
});

test("isCleanReviewResponse: recognizes a Markdown-heading-wrapped clean reply", () => {
  assert.equal(isCleanReviewResponse("### No issues found."), true);
});

test("isCleanReviewResponse: rejects Codex's own other known fixed findings-bearing preamble '### 💡 Codex Review...' (next-review-transition-gate.mjs's/consumer-sync-gate.mjs's FINDINGS_PREAMBLE_PATTERN, observed live on PRs #275/#276)", () => {
  const body = "### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.";
  assert.equal(isCleanReviewResponse(body), false);
  assert.equal(isFindingsBearingResponse(body), true);
});

test("isCleanReviewResponse: rejects the exact PR #637 findings-bearing reply", () => {
  const body =
    "## Review finding\n\n- **P1 — Validate authority-envelope field types instead of truthiness.** " +
    "The classifier promises that malformed trigger shapes fail closed, but all three authorized paths " +
    "currently accept arbitrary truthy values.";
  assert.equal(isCleanReviewResponse(body), false);
});

test("isCleanReviewResponse: rejects a clean-sounding opening clause that continues into a real finding", () => {
  assert.equal(
    isCleanReviewResponse("Looks good overall, except for one blocking issue: the token is logged in plaintext."),
    false,
    "a 'looks good' phrase that is not the entire (trimmed) response must not short-circuit past a real finding that follows it",
  );
});

test("isCleanReviewResponse: rejects a longer clean-sounding reply that exceeds the anchored allowlist (safe-direction tradeoff)", () => {
  assert.equal(
    isCleanReviewResponse(
      "Reviewed the diff. No issues found. All checks pass, tests are comprehensive, and the code follows existing patterns well.",
    ),
    false,
    "only the narrow, exact-match clean phrasing is recognized; a wordier reply defaults to findings-bearing, the safe (over-cautious) direction",
  );
});

test("isCleanReviewResponse: false for empty/undefined input", () => {
  assert.equal(isCleanReviewResponse(""), false);
  assert.equal(isCleanReviewResponse(undefined), false);
});

test("isFindingsBearingResponse: is the exact inverse of isCleanReviewResponse", () => {
  assert.equal(isFindingsBearingResponse("LGTM"), false);
  assert.equal(isFindingsBearingResponse("Reviewed. No issues found."), false);
  assert.equal(
    isFindingsBearingResponse(
      "## Review finding\n\n- **P1 — Validate authority-envelope field types instead of truthiness.**",
    ),
    true,
  );
});

test("isFindingsBearingResponse: defaults to true (fail-closed) for ordinary review prose with no recognized clean phrase", () => {
  assert.equal(
    isFindingsBearingResponse("Reviewed the diff. Note: the reviewer cannot have write permission under this workflow, by design."),
    true,
  );
});

test("isCleanReviewResponse: does not treat an explicit textual commit citation as changing classification (issue #638 required check 6)", () => {
  // A plain comment that cites a commit by hand is still ordinary findings-bearing prose to
  // this classifier — this module never substitutes parsed commit-citation text for GitHub's
  // own review-object provenance; that distinction is stage1-gate.mjs's endpoint check, not
  // this content classifier.
  const body = "Reviewed commit: aa344fce02c3b3fcfc9427c79d443d73211ec6af. P1: missing null check on line 42.";
  assert.equal(isCleanReviewResponse(body), false);
  assert.equal(isFindingsBearingResponse(body), true);
});
