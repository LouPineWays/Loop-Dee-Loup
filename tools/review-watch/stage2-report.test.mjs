// Tests for tools/review-watch/stage2-report.mjs. Pure functions — no `gh`/network access.
// Run with: node --test tools/review-watch/stage2-report.test.mjs
//
// Covers issue #230's reproduced defect (the exact #229 kickoff-and-task-link reply) and the
// state transitions its acceptance criteria call out: a valid completed report, a wrong-commit
// report, a verdict-disagreement report, an empty/no-response case, and evidence beyond the
// first 200 characters (findAllMatches' body_excerpt truncation point).

import test from "node:test";
import assert from "node:assert/strict";
import {
  bodyReferencesCommit,
  extractResponseVerdict,
  hasVerificationEvidence,
  isCompletedStage2AuditReport,
} from "./stage2-report.mjs";

const MERGE_COMMIT = "b281dbd5e7590b8ac2992753cd875f5e6472d556";

function validReport({ commit = MERGE_COMMIT, verdictLine = "Verdict: CLEAN", leading = null } = {}) {
  const lines = [];
  if (leading) lines.push(leading);
  lines.push(
    `Stage 2 audit of the merge commit \`${commit}\`.`,
    "",
    "### Verification checklist",
    "",
    "1. Confirmed the classifier rejects the exact #229 kickoff — CONFIRMED",
    "2. Confirmed a valid report is still accepted — CONFIRMED",
    "3. Verified evidence beyond the first 200 characters is read — CONFIRMED",
    "",
    verdictLine,
  );
  return lines.join("\n");
}

// -- bodyReferencesCommit ------------------------------------------------------------------

test("bodyReferencesCommit: matches the exact full SHA", () => {
  assert.equal(bodyReferencesCommit(`see \`${MERGE_COMMIT}\``, MERGE_COMMIT), true);
});

test("bodyReferencesCommit: matches a 7+ char abbreviated prefix in either direction", () => {
  assert.equal(bodyReferencesCommit(`see ${MERGE_COMMIT.slice(0, 7)}`, MERGE_COMMIT), true);
  assert.equal(bodyReferencesCommit(`see ${MERGE_COMMIT}`, MERGE_COMMIT.slice(0, 10)), true);
});

test("bodyReferencesCommit: case-insensitive", () => {
  assert.equal(bodyReferencesCommit(`see ${MERGE_COMMIT.toUpperCase()}`, MERGE_COMMIT), true);
});

test("bodyReferencesCommit: a different commit does not match", () => {
  assert.equal(bodyReferencesCommit("see deadbeef00000000000000000000000000000000", MERGE_COMMIT), false);
});

test("bodyReferencesCommit: false when text or mergeCommit is missing/empty", () => {
  assert.equal(bodyReferencesCommit("", MERGE_COMMIT), false);
  assert.equal(bodyReferencesCommit(MERGE_COMMIT, ""), false);
  assert.equal(bodyReferencesCommit(MERGE_COMMIT, null), false);
});

test("bodyReferencesCommit: a malformed (non-hex, or under 7 chars) mergeCommit never matches", () => {
  assert.equal(bodyReferencesCommit(`see ${MERGE_COMMIT}`, "not-a-sha"), false);
  assert.equal(bodyReferencesCommit(`see ${MERGE_COMMIT}`, "abc123"), false);
});

// -- extractResponseVerdict -----------------------------------------------------------------

test("extractResponseVerdict: a leading 'CLEAN — ...' status line (issue #95's observed shape)", () => {
  assert.equal(
    extractResponseVerdict("CLEAN — Stage 2 audit of PR #94 at `ed28738`; no actionable findings. Next: None."),
    "CLEAN",
  );
});

test("extractResponseVerdict: a leading 'NOT CLEAN — ...' status line", () => {
  assert.equal(extractResponseVerdict("NOT CLEAN — see findings below."), "NOT CLEAN");
});

test("extractResponseVerdict: a leading status line wrapped in Markdown presentation", () => {
  assert.equal(extractResponseVerdict("**CLEAN** — nothing material remains."), "CLEAN");
  assert.equal(extractResponseVerdict("## CLEAN\n\nnothing material remains."), "CLEAN");
});

test("extractResponseVerdict: a 'Verdict' labelled value on the same line", () => {
  assert.equal(extractResponseVerdict("Verdict: CLEAN"), "CLEAN");
  assert.equal(extractResponseVerdict("**Verdict:** NOT CLEAN"), "NOT CLEAN");
});

test("extractResponseVerdict: a 'Verdict' heading with the value on the next non-blank line", () => {
  assert.equal(extractResponseVerdict("### Verdict\n\nCLEAN"), "CLEAN");
});

test("extractResponseVerdict: null when no verdict token is present", () => {
  assert.equal(extractResponseVerdict("Starting #178."), null);
  assert.equal(extractResponseVerdict(""), null);
  assert.equal(extractResponseVerdict(null), null);
});

test("extractResponseVerdict: an unrelated later mention of CLEAN/NOT CLEAN with no label or leading position is not read as the verdict", () => {
  assert.equal(extractResponseVerdict("Reviewed the diff.\n\nThe helper function itself looks clean, will report back."), null);
});

test("extractResponseVerdict: findings prose that merely contains the word 'verdict' does not short-circuit before the real labelled verdict (Stage 1 review finding on PR #231)", () => {
  const body = [
    "### Findings",
    "",
    "1. Prevent a CLEAN verdict from overriding contradictory evidence — see below.",
    "",
    "### Verdict",
    "",
    "NOT CLEAN",
  ].join("\n");
  assert.equal(extractResponseVerdict(body), "NOT CLEAN");
});

// -- hasVerificationEvidence -----------------------------------------------------------------

test("hasVerificationEvidence: true with a 'verif...' mention and a numbered item", () => {
  assert.equal(hasVerificationEvidence("Verification checklist:\n1. Confirmed the fix."), true);
});

test("hasVerificationEvidence: false with only a mention, no numbered item", () => {
  assert.equal(hasVerificationEvidence("I verified the fix works."), false);
});

test("hasVerificationEvidence: false with only a numbered item, no verification mention", () => {
  assert.equal(hasVerificationEvidence("1. The fix looks correct."), false);
});

test("hasVerificationEvidence: false for empty/undefined", () => {
  assert.equal(hasVerificationEvidence(""), false);
  assert.equal(hasVerificationEvidence(undefined), false);
});

// -- isCompletedStage2AuditReport ------------------------------------------------------------

test("isCompletedStage2AuditReport: reproduces the exact #229 kickoff-and-task-link reply as incomplete (issue #230's reproduced defect)", () => {
  const body = "Starting #178.\n\n [View task →](https://chatgpt.com/s/cd_6a953a6d05888191ac802c3305e114db)";
  const result = isCompletedStage2AuditReport(body, { mergeCommit: MERGE_COMMIT });
  assert.equal(result.complete, false);
  assert.equal(result.verdict, null);
  assert.ok(result.reasons.length > 0);
});

test("isCompletedStage2AuditReport: a valid completed report is accepted", () => {
  const result = isCompletedStage2AuditReport(validReport(), { mergeCommit: MERGE_COMMIT });
  assert.equal(result.complete, true);
  assert.equal(result.verdict, "CLEAN");
  assert.deepEqual(result.reasons, []);
});

test("isCompletedStage2AuditReport: accepts the leading-status-line shape as well as the labelled shape", () => {
  const body = validReport({ verdictLine: "", leading: `CLEAN — audit of \`${MERGE_COMMIT}\`.` });
  const result = isCompletedStage2AuditReport(body, { mergeCommit: MERGE_COMMIT });
  assert.equal(result.complete, true);
  assert.equal(result.verdict, "CLEAN");
});

test("isCompletedStage2AuditReport: a report addressing the wrong commit is rejected", () => {
  const wrongCommit = "deadbeef00000000000000000000000000000000";
  const result = isCompletedStage2AuditReport(validReport({ commit: wrongCommit }), { mergeCommit: MERGE_COMMIT });
  assert.equal(result.complete, false);
  assert.equal(result.verdict, null);
  assert.ok(result.reasons.some((r) => r.includes("merge commit")));
});

test("isCompletedStage2AuditReport: an empty body is rejected", () => {
  const result = isCompletedStage2AuditReport("", { mergeCommit: MERGE_COMMIT });
  assert.equal(result.complete, false);
  assert.equal(result.verdict, null);
});

test("isCompletedStage2AuditReport: evaluates evidence beyond the first 200 characters (the commit/verdict/checklist all fall well past it)", () => {
  const padding = "Reviewing the merge commit and every changed file in detail. ".repeat(6); // > 200 chars
  const body = padding + "\n\n" + validReport();
  assert.ok(body.length > 200, "fixture must exceed the 200-char excerpt this test guards against");
  const result = isCompletedStage2AuditReport(body, { mergeCommit: MERGE_COMMIT });
  assert.equal(result.complete, true, "evidence past the first 200 characters must still be considered");
});

test("isCompletedStage2AuditReport: a BLOCKED reply is rejected the same way as any other non-genuine response", () => {
  const result = isCompletedStage2AuditReport("BLOCKED — checkout unavailable.", { mergeCommit: MERGE_COMMIT });
  assert.equal(result.complete, false);
});

test("isCompletedStage2AuditReport: a self-referential permission-refusal reply is rejected", () => {
  const result = isCompletedStage2AuditReport("I tried to push a fix. I don't have write access.", { mergeCommit: MERGE_COMMIT });
  assert.equal(result.complete, false);
});

test("isCompletedStage2AuditReport: reports every failed signal when multiple are missing", () => {
  const result = isCompletedStage2AuditReport("Looks fine to me.", { mergeCommit: MERGE_COMMIT });
  assert.equal(result.complete, false);
  assert.equal(result.reasons.length, 3);
});

test("isCompletedStage2AuditReport: a NOT CLEAN report is not misread as CLEAN via a findings sentence that merely mentions the word 'verdict' (Stage 1 review finding on PR #231)", () => {
  const body = validReport({ verdictLine: "### Verdict\n\nNOT CLEAN" }).replace(
    "1. Confirmed the classifier rejects the exact #229 kickoff — CONFIRMED",
    "1. Prevent a CLEAN verdict from overriding contradictory evidence — CONFIRMED",
  );
  const result = isCompletedStage2AuditReport(body, { mergeCommit: MERGE_COMMIT });
  assert.equal(result.complete, true);
  assert.equal(result.verdict, "NOT CLEAN", "must read the real trailing Verdict field, not the findings prose mentioning the word");
});

test("isCompletedStage2AuditReport: a refusal disclosed past the first 200 characters is still rejected (Stage 1 review finding on PR #231)", () => {
  // The commit/verdict/checklist all sit within the first 200 characters; the self-referential
  // refusal only appears later in the body. An earlier revision only classified the 200-char
  // excerpt for genuineness, so this refusal was invisible to that check.
  const body = [
    `CLEAN — audit of \`${MERGE_COMMIT}\`.`,
    "",
    "### Verification checklist",
    "",
    "1. Confirmed the fix — CONFIRMED",
    "",
    "Verdict: CLEAN",
    "",
    "I also tried to push a small formatting fix directly. I don't have write access to this branch.",
  ].join("\n");
  assert.ok(body.indexOf("write access") > 200, "the refusal must fall past the 200-char excerpt boundary for this test to be meaningful");
  const result = isCompletedStage2AuditReport(body, { mergeCommit: MERGE_COMMIT });
  assert.equal(result.complete, false, "a refused mutation attempt anywhere in the body must not back a completed report");
});

// -- isCompletedStage2AuditReport: requireVerificationEvidence (legacy-compatibility mode) ----

test("isCompletedStage2AuditReport: requireVerificationEvidence: false accepts a terse legacy-shaped CLEAN response with no checklist", () => {
  const legacy = `CLEAN — Stage 2 audit of PR #94 at \`${MERGE_COMMIT}\`; no actionable findings. Next: None.`;
  const strict = isCompletedStage2AuditReport(legacy, { mergeCommit: MERGE_COMMIT });
  assert.equal(strict.complete, false, "the strict default must still reject the terse legacy shape");

  const relaxed = isCompletedStage2AuditReport(legacy, { mergeCommit: MERGE_COMMIT, requireVerificationEvidence: false });
  assert.equal(relaxed.complete, true, "legacy-compatibility mode must accept it");
  assert.equal(relaxed.verdict, "CLEAN");
});

test("isCompletedStage2AuditReport: requireVerificationEvidence: false still requires the correct commit and an explicit verdict", () => {
  const wrongCommit = isCompletedStage2AuditReport("CLEAN — audit of `deadbeef00000000000000000000000000000000`.", {
    mergeCommit: MERGE_COMMIT,
    requireVerificationEvidence: false,
  });
  assert.equal(wrongCommit.complete, false, "legacy-compatibility mode must not accept a report addressing a different commit");

  const noVerdict = isCompletedStage2AuditReport(`Looked at \`${MERGE_COMMIT}\`, nothing else to add.`, {
    mergeCommit: MERGE_COMMIT,
    requireVerificationEvidence: false,
  });
  assert.equal(noVerdict.complete, false, "legacy-compatibility mode must not accept a response with no explicit verdict");
});
