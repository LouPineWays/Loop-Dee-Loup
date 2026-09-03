// Tests for tools/review-watch/stage2-report.mjs. Pure functions — no `gh`/network access.
// Run with: node --test tools/review-watch/stage2-report.test.mjs
//
// Covers issue #230's reproduced defect (the exact #229 kickoff-and-task-link reply) and the
// state transitions its acceptance criteria call out: a valid completed report, a wrong-commit
// report, a verdict-disagreement report, an empty/no-response case, and evidence beyond the
// first 200 characters (findAllMatches' body_excerpt truncation point).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  bodyReferencesCommit,
  countNumberedItems,
  countVerificationWalkthroughItems,
  extractResponseVerdict,
  hasCompleteVerificationEvidence,
  hasVerificationEvidence,
  isCompletedStage2AuditReport,
} from "./stage2-report.mjs";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
function readFixture(name) {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8").trimEnd();
}

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

// -- isCompletedStage2AuditReport: reviewedHeadCommit target-identity signal (issue #335, audit
// #334) — a genuine response may reference either the exact merge commit or the audit issue's
// own trusted frozen Stage 1 reviewed head, never any other SHA. -------------------------------

const REVIEWED_HEAD = "82651b3c8026ba118bb3bbf22c1dee6a09d27670";

test("isCompletedStage2AuditReport: a response naming only the trusted reviewed head (not the merge commit) is accepted when reviewedHeadCommit is given", () => {
  const body = validReport({ commit: REVIEWED_HEAD }); // response cites the reviewed head, not MERGE_COMMIT
  const result = isCompletedStage2AuditReport(body, { mergeCommit: MERGE_COMMIT, reviewedHeadCommit: REVIEWED_HEAD });
  assert.equal(result.complete, true);
  assert.equal(result.verdict, "CLEAN");
});

test("isCompletedStage2AuditReport: without reviewedHeadCommit, a response naming only the reviewed head is still rejected (no relaxation unless the caller explicitly supplies the trusted value)", () => {
  const body = validReport({ commit: REVIEWED_HEAD });
  const result = isCompletedStage2AuditReport(body, { mergeCommit: MERGE_COMMIT });
  assert.equal(result.complete, false);
  assert.ok(result.reasons.some((r) => r.includes("merge commit")));
});

test("isCompletedStage2AuditReport: a response naming the exact merge commit still passes when reviewedHeadCommit is also given (both signals accepted, neither required over the other)", () => {
  const result = isCompletedStage2AuditReport(validReport(), { mergeCommit: MERGE_COMMIT, reviewedHeadCommit: REVIEWED_HEAD });
  assert.equal(result.complete, true);
});

test("isCompletedStage2AuditReport: a response naming an unrelated SHA is rejected even when reviewedHeadCommit is given (stays fail-closed)", () => {
  const unrelated = "deadbeef00000000000000000000000000000000";
  const result = isCompletedStage2AuditReport(validReport({ commit: unrelated }), {
    mergeCommit: MERGE_COMMIT,
    reviewedHeadCommit: REVIEWED_HEAD,
  });
  assert.equal(result.complete, false);
  assert.ok(result.reasons.some((r) => r.includes("merge commit") && r.includes("reviewed head")));
});

test("isCompletedStage2AuditReport: a response naming a different PR's head (not this audit's own trusted reviewedHeadCommit) is rejected", () => {
  const differentPrHead = "1234567890abcdef1234567890abcdef12345678";
  const result = isCompletedStage2AuditReport(validReport({ commit: differentPrHead }), {
    mergeCommit: MERGE_COMMIT,
    reviewedHeadCommit: REVIEWED_HEAD,
  });
  assert.equal(result.complete, false);
});

test("isCompletedStage2AuditReport: malformed/missing trusted target metadata (reviewedHeadCommit null) falls back to the merge-commit-only check, exactly as before", () => {
  const result = isCompletedStage2AuditReport(validReport(), { mergeCommit: MERGE_COMMIT, reviewedHeadCommit: null });
  assert.equal(result.complete, true);
  const rejected = isCompletedStage2AuditReport(validReport({ commit: REVIEWED_HEAD }), {
    mergeCommit: MERGE_COMMIT,
    reviewedHeadCommit: null,
  });
  assert.equal(rejected.complete, false);
});

test("isCompletedStage2AuditReport: the #330 shape (an incidental short merge-prefix inside an unrelated git-log command) still passes on the merge-commit signal alone, unaffected by reviewedHeadCommit being present or absent", () => {
  const incidental = [
    "Verified via `git log --format='%H%x09%s%n%b' 748f806^..0e04348 | rg -in 'fixes'`.",
    "",
    "### Verification checklist",
    "",
    "1. Confirmed A — CONFIRMED",
    "",
    "Verdict: CLEAN",
  ].join("\n");
  const result = isCompletedStage2AuditReport(incidental, {
    mergeCommit: "0e04348fb764a364e9d910bfc8074ed9e1339df1",
    reviewedHeadCommit: "9d775fc430faa5e236d2670de8e806fc27ca8491",
  });
  assert.equal(result.complete, true, "incidental prefix match must keep working once a reviewedHeadCommit is also supplied");
});

// -- isCompletedStage2AuditReport: exact #334 reproduction (issue #335) -------------------------
// Real audit body/response fixtures, not paraphrased reconstructions. #334's requested checklist
// has 11 items; Codex's genuine response cites only the frozen reviewed head (never the merge
// commit) and shows a 4-item status-marker walk-through — so target identity now passes (via
// reviewedHeadCommit) but checklist completeness still correctly fails: this is a real coverage
// gap (checklist items 6 and 9 are never addressed anywhere in the response), not mere reporting
// condensation, so the two independent failure reasons are demonstrated to resolve independently.

const ISSUE_334_MERGE_COMMIT = "0c9358ec0f607e2c3fc26ef8049585ab5d655fbe";
const ISSUE_334_REVIEWED_HEAD = "82651b3c8026ba118bb3bbf22c1dee6a09d27670";
const ISSUE_334_COMMENT = readFixture("issue-334-comment.txt");
const ISSUE_334_CHECKLIST = readFixture("issue-334-checklist.txt");

test("bodyReferencesCommit: issue #334's real response never restates the merge commit itself", () => {
  assert.equal(bodyReferencesCommit(ISSUE_334_COMMENT, ISSUE_334_MERGE_COMMIT), false);
});

test("bodyReferencesCommit: issue #334's real response does reference its trusted frozen reviewed head", () => {
  assert.equal(bodyReferencesCommit(ISSUE_334_COMMENT, ISSUE_334_REVIEWED_HEAD), true);
});

test("isCompletedStage2AuditReport: issue #334's real response now passes target identity via reviewedHeadCommit, but still correctly fails checklist completeness (11 requested, 4 shown) — a genuine coverage gap, not safe condensation", () => {
  const result = isCompletedStage2AuditReport(ISSUE_334_COMMENT, {
    mergeCommit: ISSUE_334_MERGE_COMMIT,
    reviewedHeadCommit: ISSUE_334_REVIEWED_HEAD,
    requestedChecklist: ISSUE_334_CHECKLIST,
  });
  assert.equal(result.complete, false, "checklist items 6 and 9 are never addressed anywhere in the response — this is a real gap");
  assert.equal(result.verdict, null);
  assert.equal(result.reasons.length, 1, "only the checklist-completeness signal should fail now that target identity is satisfied");
  assert.ok(result.reasons[0].includes("incomplete"));
});

test("isCompletedStage2AuditReport: issue #334's real response without reviewedHeadCommit fails on both target identity and checklist completeness (the exact pre-fix behavior)", () => {
  const result = isCompletedStage2AuditReport(ISSUE_334_COMMENT, {
    mergeCommit: ISSUE_334_MERGE_COMMIT,
    requestedChecklist: ISSUE_334_CHECKLIST,
  });
  assert.equal(result.complete, false);
  assert.equal(result.reasons.length, 2);
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

test("extractResponseVerdict: a prose sentence that merely opens with the bare word 'Verdict' (no colon, more text on the same line) is not read as a label (issue #268 finding 1)", () => {
  const body = ["Verdict handling must not allow CLEAN to override evidence.", "", "Verdict: NOT CLEAN"].join("\n");
  assert.equal(extractResponseVerdict(body), "NOT CLEAN");
});

test("extractResponseVerdict: a bare prose sentence opening with 'Verdict' and no real label anywhere returns null (issue #268 finding 1)", () => {
  assert.equal(extractResponseVerdict("Verdict handling must not allow CLEAN to override evidence."), null);
});

// -- extractResponseVerdict: combined "Stage 2 Audit ... <verdict>" heading (issue #259 recurred
// a second time on issue #278) --------------------------------------------------------------

test("extractResponseVerdict: a combined 'Stage 2 Audit Verdict: **CLEAN**' heading (issue #259's observed shape)", () => {
  assert.equal(extractResponseVerdict("## Stage 2 Audit Verdict: **CLEAN**\n\nSome report body follows."), "CLEAN");
});

test("extractResponseVerdict: a combined 'Stage 2 Audit — NOT CLEAN' heading (issue #278's observed shape)", () => {
  assert.equal(extractResponseVerdict("## Stage 2 Audit — NOT CLEAN\n\nSome report body follows."), "NOT CLEAN");
});

test("extractResponseVerdict: a genuine sentence that merely mentions 'Stage 2 Audit' later in a sentence, not as the line's own opening, is not read as a verdict declaration", () => {
  assert.equal(
    extractResponseVerdict("Reviewed the diff for compliance with the Stage 2 Audit process described in the runbook."),
    null,
  );
});

test("extractResponseVerdict: a 'Stage 2 Audit' heading merely naming its topic, with no declaring separator before the token, is not read as a verdict (Stage 1 review finding on PR #279)", () => {
  // Reproduces the exact false positive Codex found: a heading about the topic of clean-close
  // behavior, not a declaration of this report's own verdict.
  assert.equal(extractResponseVerdict("## Stage 2 Audit of clean-close behavior\n\nFindings below."), null);
});

test("extractResponseVerdict: a 'Stage 2 Audit' heading mentioning both tokens without a declaring separator falls through to a real Verdict line, never picks the wrong (first) token (Stage 1 review finding on PR #279)", () => {
  // Reproduces Codex's second scenario: the heading alone must not resolve the verdict --
  // MUST fall through to the actual "Verdict: NOT CLEAN" label line elsewhere in the body,
  // not stop at the first CLEAN/NOT CLEAN token it happens to see on the heading line.
  const body =
    "## Stage 2 Audit status was CLEAN, now NOT CLEAN\n\nSome findings.\n\nVerdict: NOT CLEAN";
  assert.equal(extractResponseVerdict(body), "NOT CLEAN");
});

test("extractResponseVerdict: the same ambiguous heading with no real verdict line anywhere else extracts nothing, rather than guessing", () => {
  assert.equal(
    extractResponseVerdict("## Stage 2 Audit status was CLEAN, now NOT CLEAN\n\nSome prose with no verdict label."),
    null,
  );
});

// -- countNumberedItems ------------------------------------------------------------------------

test("countNumberedItems: counts each top-level numbered line", () => {
  assert.equal(countNumberedItems("1. one\n2. two\n3. three"), 3);
  assert.equal(countNumberedItems("1) one\n2) two"), 2);
});

test("countNumberedItems: zero for missing/empty text", () => {
  assert.equal(countNumberedItems(""), 0);
  assert.equal(countNumberedItems(null), 0);
  assert.equal(countNumberedItems(undefined), 0);
});

// -- countVerificationWalkthroughItems -----------------------------------------------------

test("countVerificationWalkthroughItems: counts only the last freshly-restarted-at-1 numbered run, not numbered findings entries earlier in the body (Stage 1 review finding on this PR)", () => {
  const body = [
    "### Findings",
    "",
    "1. First finding — root cause X.",
    "2. Second finding — root cause Y.",
    "",
    "### Verification checklist",
    "",
    "1. Confirmed finding 1 is fixed — CONFIRMED",
    "2. Confirmed finding 2 is fixed — CONFIRMED",
    "3. Confirmed no regressions — CONFIRMED",
  ].join("\n");
  assert.equal(countVerificationWalkthroughItems(body), 3, "must count only the checklist's 3 items, not 5 (2 findings + 3 checklist)");
});

test("countVerificationWalkthroughItems: a checklist truncated after item 1 is not padded out by earlier numbered findings entries", () => {
  const body = [
    "### Findings",
    "",
    "1. First finding — root cause X.",
    "2. Second finding — root cause Y.",
    "",
    "### Verification checklist",
    "",
    "1. Confirmed finding 1 is fixed — CONFIRMED",
  ].join("\n");
  assert.equal(countVerificationWalkthroughItems(body), 1, "must report the truncated checklist's true length (1), not 3 (2 findings + 1 checklist)");
});

test("countVerificationWalkthroughItems: a single numbered list with no earlier findings still counts normally", () => {
  assert.equal(countVerificationWalkthroughItems("1. one\n2. two\n3. three"), 3);
});

test("countVerificationWalkthroughItems: zero for missing/empty text or text with no numbered items", () => {
  assert.equal(countVerificationWalkthroughItems(""), 0);
  assert.equal(countVerificationWalkthroughItems(null), 0);
  assert.equal(countVerificationWalkthroughItems("no numbered content here"), 0);
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

// -- hasCompleteVerificationEvidence ---------------------------------------------------------

test("hasCompleteVerificationEvidence: false when the response's checklist is shorter than what was requested (issue #268 finding 2)", () => {
  const requested = "1. Confirm A.\n2. Confirm B.\n3. Confirm C.";
  const truncatedResponse = "Verification checklist:\n1. Confirmed A — CONFIRMED.";
  assert.equal(hasCompleteVerificationEvidence(truncatedResponse, requested), false);
});

test("hasCompleteVerificationEvidence: true when the response's checklist meets or exceeds the requested count", () => {
  const requested = "1. Confirm A.\n2. Confirm B.";
  const fullResponse = "Verification checklist:\n1. Confirmed A — CONFIRMED.\n2. Confirmed B — CONFIRMED.";
  assert.equal(hasCompleteVerificationEvidence(fullResponse, requested), true);
});

test("hasCompleteVerificationEvidence: false when a truncated checklist is padded out by earlier numbered findings entries (Stage 1 review finding on this PR)", () => {
  const requested = "1. Confirm the classifier rejects the exact #229 kickoff.\n2. Confirm a valid report is still accepted.\n3. Verify evidence beyond the first 200 characters is read.";
  const body = [
    "### Findings",
    "",
    "1. First finding — root cause X.",
    "2. Second finding — root cause Y.",
    "",
    "### Verification checklist",
    "",
    "1. Confirmed the classifier rejects the exact #229 kickoff — CONFIRMED",
  ].join("\n");
  assert.equal(
    hasCompleteVerificationEvidence(body, requested),
    false,
    "2 findings entries + 1 truncated checklist item must not be read as satisfying a 3-item request",
  );
});

test("hasCompleteVerificationEvidence: falls back to presence-only when no requested checklist is given", () => {
  assert.equal(hasCompleteVerificationEvidence("Verification checklist:\n1. Confirmed A.", null), true);
  assert.equal(hasCompleteVerificationEvidence("Verification checklist:\n1. Confirmed A.", ""), true);
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

// -- isCompletedStage2AuditReport: combined "Stage 2 Audit ... <verdict>" heading (issue #259
// recurred a second time on issue #278) -------------------------------------------------------

test("isCompletedStage2AuditReport: accepts a full realistic report opening with the observed '## Stage 2 Audit Verdict: **CLEAN**' heading (issue #259)", () => {
  const body = validReport({ verdictLine: "", leading: "## Stage 2 Audit Verdict: **CLEAN**" });
  const result = isCompletedStage2AuditReport(body, { mergeCommit: MERGE_COMMIT });
  assert.equal(result.complete, true);
  assert.equal(result.verdict, "CLEAN");
  assert.deepEqual(result.reasons, []);
});

test("isCompletedStage2AuditReport: accepts a full realistic report opening with the observed '## Stage 2 Audit — NOT CLEAN' heading (issue #278)", () => {
  const body = validReport({ verdictLine: "", leading: "## Stage 2 Audit — NOT CLEAN" });
  const result = isCompletedStage2AuditReport(body, { mergeCommit: MERGE_COMMIT });
  assert.equal(result.complete, true);
  assert.equal(result.verdict, "NOT CLEAN");
  assert.deepEqual(result.reasons, []);
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

// -- isCompletedStage2AuditReport: requestedChecklist completeness (issue #268 finding 2) ----

const REQUESTED_CHECKLIST = [
  "1. Confirm the classifier rejects the exact #229 kickoff.",
  "2. Confirm a valid report is still accepted.",
  "3. Verify evidence beyond the first 200 characters is read.",
].join("\n");

test("isCompletedStage2AuditReport: a checklist walk-through truncated partway through the requested items is rejected", () => {
  const truncated = [
    `Stage 2 audit of the merge commit \`${MERGE_COMMIT}\`.`,
    "",
    "### Verification checklist",
    "",
    "1. Confirmed the classifier rejects the exact #229 kickoff — CONFIRMED",
    "",
    "Verdict: CLEAN",
  ].join("\n");
  const result = isCompletedStage2AuditReport(truncated, { mergeCommit: MERGE_COMMIT, requestedChecklist: REQUESTED_CHECKLIST });
  assert.equal(result.complete, false);
  assert.equal(result.verdict, null);
  assert.ok(result.reasons.some((r) => r.includes("incomplete")), `expected an incompleteness reason, got: ${result.reasons}`);
});

test("isCompletedStage2AuditReport: a truncated checklist is not accepted merely because earlier numbered findings entries pad the total count (Stage 1 review finding on this PR)", () => {
  const body = [
    `CLEAN — Stage 2 audit of the merge commit \`${MERGE_COMMIT}\`.`,
    "",
    "### Findings",
    "",
    "1. First finding — root cause X, now fixed.",
    "2. Second finding — root cause Y, now fixed.",
    "",
    "### Verification checklist",
    "",
    "1. Confirmed the classifier rejects the exact #229 kickoff — CONFIRMED",
    "",
    "Verdict: CLEAN",
  ].join("\n");
  const result = isCompletedStage2AuditReport(body, { mergeCommit: MERGE_COMMIT, requestedChecklist: REQUESTED_CHECKLIST });
  assert.equal(result.complete, false, "2 findings + 1 checklist item (3 numbered lines total) must not satisfy a 3-item checklist request");
  assert.equal(result.verdict, null);
});

test("isCompletedStage2AuditReport: a checklist walk-through meeting the requested item count is accepted", () => {
  const result = isCompletedStage2AuditReport(validReport(), { mergeCommit: MERGE_COMMIT, requestedChecklist: REQUESTED_CHECKLIST });
  assert.equal(result.complete, true);
  assert.equal(result.verdict, "CLEAN");
});

test("isCompletedStage2AuditReport: requireVerificationEvidence: false ignores requestedChecklist completeness entirely", () => {
  const legacy = `CLEAN — Stage 2 audit of PR #94 at \`${MERGE_COMMIT}\`; no actionable findings. Next: None.`;
  const result = isCompletedStage2AuditReport(legacy, {
    mergeCommit: MERGE_COMMIT,
    requireVerificationEvidence: false,
    requestedChecklist: REQUESTED_CHECKLIST,
  });
  assert.equal(result.complete, true, "legacy-compatibility mode must still accept a terse response regardless of requestedChecklist");
});

// -- status-marker bullet checklist walk-through (issue #330's genuine Stage 2 audit response,
// comment 5525865299): "- ✅ `command` — result" per item, no numbering at all. Fixtures are the
// exact real response body and the exact real requested checklist text (issue #330's own
// "Verification checklist" field), not paraphrased reconstructions.

const ISSUE_330_COMMIT = "0e04348fb764a364e9d910bfc8074ed9e1339df1";
const ISSUE_330_COMMENT = readFixture("issue-330-comment.txt");
const ISSUE_330_CHECKLIST = readFixture("issue-330-checklist.txt");

test("hasVerificationEvidence: true for a status-marker bullet checklist ('- ✅ ...') with no numbering", () => {
  assert.equal(hasVerificationEvidence("### Verification\n\n- ✅ Confirmed the fix works."), true);
});

test("countVerificationWalkthroughItems: counts the trailing contiguous run of status-marker bullet lines when there is no numbered walk-through", () => {
  const body = [
    "### Findings",
    "",
    "No actionable findings.",
    "",
    "### Verification",
    "",
    "- ✅ Confirmed A.",
    "- ✅ Confirmed B.",
    "- ❌ Confirmed C failed.",
  ].join("\n");
  assert.equal(countVerificationWalkthroughItems(body), 3);
});

test("countVerificationWalkthroughItems: an earlier unrelated bulleted line breaks the trailing marker run, isolating it from the checklist section (mirrors the numbered-run isolation test above)", () => {
  const body = [
    "### Findings",
    "",
    "- Some finding, not a checklist item.",
    "",
    "### Verification",
    "",
    "- ✅ Confirmed A.",
    "- ✅ Confirmed B.",
  ].join("\n");
  assert.equal(countVerificationWalkthroughItems(body), 2, "must not count the unrelated Findings bullet as part of the checklist run");
});

test("countVerificationWalkthroughItems: prefers a numbered walk-through over an unrelated marker-bullet list elsewhere in the body", () => {
  const body = [
    "### Findings",
    "",
    "- ✅ Not a checklist, just a status-marker bullet in prose.",
    "",
    "### Verification checklist",
    "",
    "1. Confirmed A.",
    "2. Confirmed B.",
  ].join("\n");
  assert.equal(countVerificationWalkthroughItems(body), 2);
});

test("countVerificationWalkthroughItems: reproduces issue #330's real response — 7 status-marker bullet items, matching its 7-item requested checklist", () => {
  assert.equal(countVerificationWalkthroughItems(ISSUE_330_COMMENT), 7);
  assert.equal(countNumberedItems(ISSUE_330_CHECKLIST), 7);
});

test("hasCompleteVerificationEvidence: issue #330's real response satisfies its real 7-item requested checklist via the status-marker bullet shape", () => {
  assert.equal(hasCompleteVerificationEvidence(ISSUE_330_COMMENT, ISSUE_330_CHECKLIST), true);
});

test("isCompletedStage2AuditReport: reproduces issue #330's real genuine CLEAN Stage 2 response as complete — content-complete but previously misclassified as incomplete for lacking a numbered checklist walk-through", () => {
  const result = isCompletedStage2AuditReport(ISSUE_330_COMMENT, {
    mergeCommit: ISSUE_330_COMMIT,
    requestedChecklist: ISSUE_330_CHECKLIST,
  });
  assert.equal(result.complete, true);
  assert.equal(result.verdict, "CLEAN");
  assert.deepEqual(result.reasons, []);
});

// Issue #335: #330's target-identity pass currently relies solely on the incidental short
// merge-prefix `0e04348` inside its response's unrelated `git log 748f806^..0e04348` command —
// not an intentional restatement. This proves the corrected contract no longer relies on that
// accident as the ONLY proof of target identity: #330's real response also intentionally cites
// its own frozen reviewed head (`9d775fc430faa5e236d2670de8e806fc27ca8491`, in its
// `gh api .../commits/9d775fc.../check-runs` verification line) while checking the required
// control-plane-workflow item — a deliberate citation the reviewedHeadCommit signal now
// recognizes independently, demonstrated here by supplying a deliberately WRONG mergeCommit so
// only the reviewedHeadCommit signal can possibly account for the match.
test("isCompletedStage2AuditReport: issue #330's real response also passes target identity via its intentional reviewedHeadCommit citation alone, independent of the incidental merge-prefix accident", () => {
  const wrongMergeCommit = "deadbeef00000000000000000000000000000000";
  const result = isCompletedStage2AuditReport(ISSUE_330_COMMENT, {
    mergeCommit: wrongMergeCommit,
    reviewedHeadCommit: "9d775fc430faa5e236d2670de8e806fc27ca8491",
    requestedChecklist: ISSUE_330_CHECKLIST,
  });
  assert.equal(result.complete, true, "the real response's own citation of its frozen reviewed head must independently satisfy target identity");
  assert.equal(result.verdict, "CLEAN");
});

test("isCompletedStage2AuditReport: a status-marker checklist truncated partway through the requested items is still rejected (issue #268 finding 2 applies equally to the marker-bullet shape)", () => {
  const requested = "1. Confirm A.\n2. Confirm B.\n3. Confirm C.";
  const truncated = [
    `CLEAN — Stage 2 audit of the merge commit \`${MERGE_COMMIT}\`.`,
    "",
    "### Verification",
    "",
    "- ✅ Confirmed A.",
  ].join("\n");
  const result = isCompletedStage2AuditReport(truncated, { mergeCommit: MERGE_COMMIT, requestedChecklist: requested });
  assert.equal(result.complete, false);
  assert.ok(result.reasons.some((r) => r.includes("incomplete")), `expected an incompleteness reason, got: ${result.reasons}`);
});

// -- PR #331 Stage 1 review findings on the status-marker walk-through support above ----------

const THREE_ITEM_CHECKLIST = "1. Confirm A.\n2. Confirm B.\n3. Confirm C.";

test("countVerificationWalkthroughItems (Stage 1 finding 1): a short numbered findings list must not outrank a complete, later marker-bullet checklist", () => {
  const body = [
    "### Findings",
    "",
    "1. First finding — root cause X, now fixed.",
    "",
    "### Verification",
    "",
    "- ✅ Confirmed A.",
    "- ✅ Confirmed B.",
    "- ✅ Confirmed C.",
  ].join("\n");
  assert.equal(countVerificationWalkthroughItems(body), 3, "the trailing marker checklist (3 items) must win over the earlier 1-item numbered findings list");
  assert.equal(hasCompleteVerificationEvidence(body, THREE_ITEM_CHECKLIST), true);
});

test("countVerificationWalkthroughItems (Stage 1 finding 1): a numbered findings list must not pad out an incomplete, later marker-bullet checklist", () => {
  const body = [
    "### Findings",
    "",
    "1. First finding.",
    "2. Second finding.",
    "3. Third finding.",
    "",
    "### Verification",
    "",
    "- ✅ Confirmed A.",
  ].join("\n");
  assert.equal(countVerificationWalkthroughItems(body), 1, "the trailing marker checklist (1 real item) must win, not the 3 earlier numbered findings");
  assert.equal(hasCompleteVerificationEvidence(body, THREE_ITEM_CHECKLIST), false, "1 real checklist item must not satisfy a 3-item request merely because 3 numbered findings appear earlier");
});

test("countVerificationWalkthroughItems (Stage 1 finding 2): an indented sub-bullet nested under one checklist item is not counted as its own additional top-level item", () => {
  const body = [
    "### Verification",
    "",
    "- ✅ Confirmed the parent check.",
    "  - ✅ Sub-check one.",
    "  - ✅ Sub-check two.",
  ].join("\n");
  assert.equal(countVerificationWalkthroughItems(body), 1, "2 nested sub-bullets under 1 top-level item must not inflate the count to 3");
  assert.equal(
    hasCompleteVerificationEvidence(body, THREE_ITEM_CHECKLIST),
    false,
    "1 real top-level item must not satisfy a 3-item request merely because it has nested sub-bullets",
  );
});

test("countVerificationWalkthroughItems (Stage 1 finding 3): an indented continuation line under a checklist item does not break the walk-through run", () => {
  const body = [
    "### Verification",
    "",
    "- ✅ Confirmed A.",
    "  Additional detail explaining how A was confirmed.",
    "- ✅ Confirmed B.",
    "- ✅ Confirmed C.",
    "  More explanation here too.",
  ].join("\n");
  assert.equal(countVerificationWalkthroughItems(body), 3, "indented continuation lines must not fragment a complete 3-item walk-through into isolated single-item runs");
  assert.equal(hasCompleteVerificationEvidence(body, THREE_ITEM_CHECKLIST), true);
});

test("countVerificationWalkthroughItems (Stage 1 finding 4): a trailing 'Founder judgment required' warning bullet does not shrink or replace a complete marker checklist", () => {
  const body = [
    "### Verification",
    "",
    "- ✅ Confirmed A.",
    "- ✅ Confirmed B.",
    "- ✅ Confirmed C.",
    "- ⚠️ Founder judgment required.",
    "",
    "Verdict: CLEAN",
  ].join("\n");
  assert.equal(countVerificationWalkthroughItems(body), 3, "the founder-judgment warning bullet is not a checklist item and must not be counted or break the run");
  assert.equal(hasCompleteVerificationEvidence(body, THREE_ITEM_CHECKLIST), true);
});

test("countVerificationWalkthroughItems (Stage 1 finding 4): a lone 'Founder judgment required' warning bullet is never accepted as evidence that verification was performed", () => {
  const body = ["Verification was not performed for this commit.", "", "- ⚠️ Founder judgment required.", "", "Verdict: CLEAN"].join("\n");
  assert.equal(countVerificationWalkthroughItems(body), 0);
  assert.equal(hasVerificationEvidence(body), false, "a warning-only bullet with no real checklist must not read as verification evidence");
  assert.equal(hasCompleteVerificationEvidence(body, "1. Confirm X."), false);
});
