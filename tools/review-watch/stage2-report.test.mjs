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

// -- isCompletedStage2AuditReport: reviewedHeadCommit is diagnostic-only, never an alternative
// target-identity signal (issue #335, audit #334). An earlier revision of this fix accepted
// `reviewedHeadCommit` as an `||` alternative to `mergeCommit`; a Stage 1 review finding on that
// PR proved this unsafe with a concrete counterexample (below) and required reverting to a
// strictly mandatory `mergeCommit` check, using `reviewedHeadCommit` only to sharpen the failure
// `reason` text. -------------------------------------------------------------------------------

const REVIEWED_HEAD = "82651b3c8026ba118bb3bbf22c1dee6a09d27670";

test("isCompletedStage2AuditReport: a response naming only the trusted reviewed head (not the merge commit) is still rejected — reviewedHeadCommit never substitutes for mergeCommit", () => {
  const body = validReport({ commit: REVIEWED_HEAD }); // response cites the reviewed head, not MERGE_COMMIT
  const result = isCompletedStage2AuditReport(body, { mergeCommit: MERGE_COMMIT, reviewedHeadCommit: REVIEWED_HEAD });
  assert.equal(result.complete, false);
  assert.equal(result.verdict, null);
  assert.ok(
    result.reasons.some((r) => r.includes("merge commit") && r.includes("reviewed head")),
    `expected a reason distinguishing the reviewed-head citation from the missing merge commit, got: ${result.reasons}`,
  );
});

// Stage 1 review finding, issue #335: the exact unsafe scenario an earlier `||`-based revision of
// this fix would have wrongly accepted. The response names an INCORRECT merge commit (not
// MERGE_COMMIT) while still correctly citing the trusted reviewedHeadCommit for the workflow-check
// item — under the rejected `||` design this would have passed target identity even though the
// response's own claimed audit target is wrong. This must fail closed.
test("isCompletedStage2AuditReport: a response naming an INCORRECT merge commit while also citing the correct reviewedHeadCommit is still rejected (the exact unsafe scenario Stage 1 review caught)", () => {
  const incorrectMergeCommit = "1234567890abcdef1234567890abcdef12345678";
  const body = [
    `Stage 2 audit of the merge commit \`${incorrectMergeCommit}\`.`, // wrong — not MERGE_COMMIT
    "",
    "### Verification checklist",
    "",
    `1. Confirmed the control-plane workflow ran against frozen reviewed head \`${REVIEWED_HEAD}\` — CONFIRMED`,
    "2. Confirmed no regressions — CONFIRMED",
    "3. Verified evidence beyond the first 200 characters is read — CONFIRMED",
    "",
    "Verdict: CLEAN",
  ].join("\n");
  const result = isCompletedStage2AuditReport(body, { mergeCommit: MERGE_COMMIT, reviewedHeadCommit: REVIEWED_HEAD });
  assert.equal(result.complete, false, "an incorrect merge-commit claim must not be forgiven merely because the reviewed head also appears");
  assert.equal(result.verdict, null);
});

test("isCompletedStage2AuditReport: a response naming the exact merge commit still passes regardless of whether reviewedHeadCommit is also given", () => {
  const result = isCompletedStage2AuditReport(validReport(), { mergeCommit: MERGE_COMMIT, reviewedHeadCommit: REVIEWED_HEAD });
  assert.equal(result.complete, true);
});

test("isCompletedStage2AuditReport: a response naming an unrelated SHA (matching neither mergeCommit nor reviewedHeadCommit) is rejected with the generic reason", () => {
  const unrelated = "deadbeef00000000000000000000000000000000";
  const result = isCompletedStage2AuditReport(validReport({ commit: unrelated }), {
    mergeCommit: MERGE_COMMIT,
    reviewedHeadCommit: REVIEWED_HEAD,
  });
  assert.equal(result.complete, false);
  assert.ok(result.reasons.some((r) => r.includes("merge commit") && !r.includes("reviewed head")));
});

test("isCompletedStage2AuditReport: malformed/missing trusted target metadata (reviewedHeadCommit null) behaves exactly like the pre-#335 merge-commit-only check", () => {
  const result = isCompletedStage2AuditReport(validReport(), { mergeCommit: MERGE_COMMIT, reviewedHeadCommit: null });
  assert.equal(result.complete, true);
  const rejected = isCompletedStage2AuditReport(validReport({ commit: REVIEWED_HEAD }), {
    mergeCommit: MERGE_COMMIT,
    reviewedHeadCommit: null,
  });
  assert.equal(rejected.complete, false);
  assert.ok(rejected.reasons.some((r) => r === "does not reference the exact target merge commit"));
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
  assert.equal(result.complete, true, "the incidental merge-prefix match is unaffected by reviewedHeadCommit also being supplied");
});

// -- isCompletedStage2AuditReport: exact #334 reproduction (issue #335) -------------------------
// Real audit body/response fixtures, not paraphrased reconstructions. #334's requested checklist
// has 11 items; Codex's genuine response cites only the frozen reviewed head, never the merge
// commit, and shows a 4-item status-marker walk-through. This audit remains correctly PENDING —
// not backed — after issue #335's fix: target identity still fails (mergeCommit is mandatory and
// was never cited), and checklist completeness independently still fails (a real coverage gap:
// items 6 and 9 are never addressed anywhere in the response, not mere reporting condensation).
// Retaining the strict requirement here is the documented, deliberate outcome of issue #335's own
// fallback ("if that cannot be made deterministic and fail-closed, retain the merge-commit
// requirement") once Stage 1 review proved the alternative unsafe.

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

test("isCompletedStage2AuditReport: issue #334's real response stays correctly unbacked — target identity fails (no merge-commit citation, and reviewedHeadCommit is diagnostic-only) and checklist completeness independently fails (11 requested, 4 shown)", () => {
  const result = isCompletedStage2AuditReport(ISSUE_334_COMMENT, {
    mergeCommit: ISSUE_334_MERGE_COMMIT,
    reviewedHeadCommit: ISSUE_334_REVIEWED_HEAD,
    requestedChecklist: ISSUE_334_CHECKLIST,
  });
  assert.equal(result.complete, false);
  assert.equal(result.verdict, null);
  assert.equal(result.reasons.length, 2, "both the target-identity and checklist-completeness signals must independently fail");
  assert.ok(result.reasons.some((r) => r.includes("merge commit") && r.includes("reviewed head")));
  assert.ok(result.reasons.some((r) => r.includes("incomplete")));
});

test("isCompletedStage2AuditReport: issue #334's real response without reviewedHeadCommit fails the same way, just with the generic (less specific) target-identity reason", () => {
  const result = isCompletedStage2AuditReport(ISSUE_334_COMMENT, {
    mergeCommit: ISSUE_334_MERGE_COMMIT,
    requestedChecklist: ISSUE_334_CHECKLIST,
  });
  assert.equal(result.complete, false);
  assert.equal(result.reasons.length, 2);
  assert.ok(result.reasons.some((r) => r === "does not reference the exact target merge commit"));
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

// Issue #381: a genuine, complete 6-item numbered "Verification results" walk-through (matching
// this issue's 6-item requested checklist), followed by an unrelated "### Checks" section of 5
// literal-command bullets shaped identically to a marker-bullet checklist item ("- ✅ `cmd`").
// Exact real response body (comment 5541924356 on issue #380) and its exact real requested
// checklist (issue #380's own "Verification checklist" field), not paraphrased reconstructions.
const ISSUE_381_COMMIT = "3947b0e03be816a483d8cc7117241f86f13b081c";
const ISSUE_381_COMMENT = readFixture("issue-381-comment.txt");
const ISSUE_381_CHECKLIST = readFixture("issue-381-checklist.txt");

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

// Issue #335: #330's target-identity pass relies on the incidental short merge-prefix `0e04348`
// inside its response's unrelated `git log 748f806^..0e04348` command — not an intentional
// restatement. #330's real response also intentionally cites its own frozen reviewed head
// (`9d775fc430faa5e236d2670de8e806fc27ca8491`, in its `gh api .../commits/9d775fc.../check-runs`
// verification line) while checking the required control-plane-workflow item. issue #335
// investigated letting that intentional citation independently satisfy target identity, but a
// Stage 1 review finding proved that unsafe (see the adversarial "incorrect merge commit + correct
// reviewed head" test above) — so this instead demonstrates the corrected, safe behavior: with a
// deliberately WRONG mergeCommit, #330's real response is correctly REJECTED even though it
// intentionally cites the correct reviewedHeadCommit, exactly the fail-closed outcome issue #335's
// own fallback requires once the relaxation could not be proven safe.
test("isCompletedStage2AuditReport: issue #330's real response, given a deliberately wrong mergeCommit, is correctly rejected despite intentionally citing the correct reviewedHeadCommit (proves the fix does not reopen the unsafe #335 scenario)", () => {
  const wrongMergeCommit = "deadbeef00000000000000000000000000000000";
  const result = isCompletedStage2AuditReport(ISSUE_330_COMMENT, {
    mergeCommit: wrongMergeCommit,
    reviewedHeadCommit: "9d775fc430faa5e236d2670de8e806fc27ca8491",
    requestedChecklist: ISSUE_330_CHECKLIST,
  });
  assert.equal(result.complete, false, "an incorrect mergeCommit must never be forgiven merely because the response also cites the correct reviewedHeadCommit");
  assert.equal(result.verdict, null);
});

// Issue #353: a genuine, substantively complete Stage 2 response numbered every checklist item
// with its own pass/fail glyph ("1. ✅ ...", "2. ✅ ...", ..., "5. ✅ ...") but never used the
// literal word "verify"/"verification"/etc. anywhere in the body — `hasVerificationEvidence`'s
// unconditional `VERIFICATION_MENTION_PATTERN` gate rejected it outright despite an unambiguous
// five-item walk-through matching its 5-item requested checklist exactly. Fixtures are the exact
// real response body and the exact real requested checklist text (issue #353's own
// "Verification checklist" field), not paraphrased reconstructions.

const ISSUE_353_COMMIT = "cd87a9c9ffe72338b1ff1d8a240ced9d9eb49750";
const ISSUE_353_COMMENT = readFixture("issue-353-comment.txt");
const ISSUE_353_CHECKLIST = readFixture("issue-353-checklist.txt");

test("hasVerificationEvidence: true for a numbered status-marker checklist ('1. ✅ ...') that never uses the word 'verif...'", () => {
  assert.equal(hasVerificationEvidence("1. ✅ Confirmed the fix works.\n2. ✅ Tests pass."), true);
});

test("hasVerificationEvidence: a bare numbered list with no status-marker glyph still requires a 'verif...' mention (unchanged behavior)", () => {
  assert.equal(hasVerificationEvidence("1. The fix looks correct.\n2. Tests pass."), false);
});

test("countVerificationWalkthroughItems: reproduces issue #353's real response — 5 numbered status-marker items, matching its 5-item requested checklist", () => {
  assert.equal(countVerificationWalkthroughItems(ISSUE_353_COMMENT), 5);
  assert.equal(countNumberedItems(ISSUE_353_CHECKLIST), 5);
});

test("hasCompleteVerificationEvidence: issue #353's real response satisfies its real 5-item requested checklist via the numbered status-marker shape, despite never using the word 'verif...'", () => {
  assert.equal(hasCompleteVerificationEvidence(ISSUE_353_COMMENT, ISSUE_353_CHECKLIST), true);
});

test("isCompletedStage2AuditReport: reproduces issue #353's real genuine CLEAN Stage 2 response as complete — content-complete but previously misclassified as showing no verification-results content at all", () => {
  const result = isCompletedStage2AuditReport(ISSUE_353_COMMENT, {
    mergeCommit: ISSUE_353_COMMIT,
    requestedChecklist: ISSUE_353_CHECKLIST,
  });
  assert.equal(result.complete, true);
  assert.equal(result.verdict, "CLEAN");
  assert.deepEqual(result.reasons, []);
});

test("isCompletedStage2AuditReport: a numbered status-marker checklist truncated partway through the requested items is still rejected (issue #268 finding 2 applies equally to the numbered-marker shape)", () => {
  const truncated = `Merge commit \`${MERGE_COMMIT}\`.\n\n1. ✅ First check.\n2. ✅ Second check.\n\nVerdict: CLEAN`;
  const requestedChecklist = "1. a\n2. b\n3. c\n4. d\n5. e\n";
  const result = isCompletedStage2AuditReport(truncated, { mergeCommit: MERGE_COMMIT, requestedChecklist });
  assert.equal(result.complete, false);
  assert.ok(result.reasons.some((r) => r.includes("checklist walk-through is incomplete")));
});

// Stage 1 review finding on PR #354 (two P1s against the first revision of the #353 fix above).

test("hasVerificationEvidence: a numbered run with a marker on only its first item is NOT evidence — every item in the selected run must carry the glyph, not merely one line anywhere (Stage 1 finding 1, PR #354)", () => {
  // The exact adversarial input Codex reported: item 1 carries a real marker, items 2-3 are
  // unmarked findings-shaped lines with no verification content at all. Before this finding was
  // fixed, testing NUMBERED_MARKER_ITEM_PATTERN against the whole body let this pass evidence
  // detection while countVerificationWalkthroughItems still counted all 3 lines as "verified".
  const mixedRun = "1. ✅ Checked A\n2. Finding B\n3. Finding C";
  assert.equal(hasVerificationEvidence(mixedRun), false);
});

test("hasVerificationEvidence: a lone unrelated status bullet in findings prose is NOT evidence without a 'verif...' mention — the bulleted marker shape keeps its original word-mention requirement (Stage 1 finding 2, PR #354)", () => {
  // The exact adversarial input Codex reported: a single "- ✅ ..." bullet embedded in ordinary
  // findings prose, no verification section, no "verif..." word anywhere. Before this finding
  // was fixed, extending the numbered-marker shape's mention-free path to the bulleted-marker
  // shape too let this satisfy a single-item requested checklist on its own.
  const loneBulletInProse = "Findings: we already fixed the reported issue.\n- ✅ Fixed the finding.";
  assert.equal(hasVerificationEvidence(loneBulletInProse), false);
});

test("hasVerificationEvidence: a numbered run where every item carries a marker is still accepted (the intended #353 fix keeps working after the Stage 1 correction)", () => {
  const fullyMarked = "1. ✅ Checked A\n2. ✅ Checked B\n3. ✅ Checked C";
  assert.equal(hasVerificationEvidence(fullyMarked), true);
});

test("isCompletedStage2AuditReport: the mixed-marker adversarial run from Stage 1 finding 1 does not back a CLEAN verdict even against a matching-length requested checklist", () => {
  const mixedRun = `Merge commit \`${MERGE_COMMIT}\`.\n\n1. ✅ Checked A\n2. Finding B\n3. Finding C\n\nVerdict: CLEAN`;
  const requestedChecklist = "1. a\n2. b\n3. c\n";
  const result = isCompletedStage2AuditReport(mixedRun, { mergeCommit: MERGE_COMMIT, requestedChecklist });
  assert.equal(result.complete, false);
});

test("isCompletedStage2AuditReport: the lone-bullet-in-prose adversarial input from Stage 1 finding 2 does not back a CLEAN verdict against a single-item requested checklist", () => {
  const loneBulletInProse = `Merge commit \`${MERGE_COMMIT}\`.\n\nFindings: we already fixed the reported issue.\n- ✅ Fixed the finding.\n\nVerdict: CLEAN`;
  const requestedChecklist = "1. a\n";
  const result = isCompletedStage2AuditReport(loneBulletInProse, { mergeCommit: MERGE_COMMIT, requestedChecklist });
  assert.equal(result.complete, false);
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

// -- issue #381: a later "### Checks" literal-command-log section must never outrank a complete,
// earlier numbered checklist walk-through merely for using the same status-marker glyphs and
// sitting later in the document.

test("countVerificationWalkthroughItems (issue #381): a complete numbered walk-through is not undercounted by a later, unrelated 'Checks' section of fewer status-marker command bullets", () => {
  const body = [
    "### Verification results",
    "",
    "1. **PASS** — first item.",
    "2. **PASS** — second item.",
    "3. **PASS** — third item.",
    "4. **PASS** — fourth item.",
    "5. **PASS** — fifth item.",
    "6. **PASS** — sixth item.",
    "",
    "### Checks",
    "",
    "- ✅ `command one`",
    "- ✅ `command two`",
    "- ✅ `command three`",
    "- ✅ `command four`",
    "- ✅ `command five`",
    "",
    "Verdict: CLEAN",
  ].join("\n");
  assert.equal(
    countVerificationWalkthroughItems(body),
    6,
    "the correct, earlier, complete 6-item numbered walk-through must win over the later 5-item Checks section",
  );
});

test("hasCompleteVerificationEvidence (issue #381): the synthetic reproduction satisfies its matching 6-item requested checklist", () => {
  const body = [
    "### Verification results",
    "",
    "1. **PASS** — first item.",
    "2. **PASS** — second item.",
    "3. **PASS** — third item.",
    "4. **PASS** — fourth item.",
    "5. **PASS** — fifth item.",
    "6. **PASS** — sixth item.",
    "",
    "### Checks",
    "",
    "- ✅ `command one`",
    "- ✅ `command two`",
    "- ✅ `command three`",
    "- ✅ `command four`",
    "- ✅ `command five`",
    "",
    "Verdict: CLEAN",
  ].join("\n");
  const requestedChecklist = "1. A.\n2. B.\n3. C.\n4. D.\n5. E.\n6. F.";
  assert.equal(hasCompleteVerificationEvidence(body, requestedChecklist), true);
});

test("countVerificationWalkthroughItems (issue #381): a 'Checks' heading at any level, with optional emphasis/colon, is still recognized as a literal-command-log section", () => {
  const body = ["1. one", "2. two", "", "#### **Checks:**", "", "- ✅ `cmd a`", "- ✅ `cmd b`", "- ✅ `cmd c`"].join("\n");
  assert.equal(countVerificationWalkthroughItems(body), 2, "the 2-item numbered run must win, not the 3-item 'Checks:' section");
});

test("countVerificationWalkthroughItems (issue #381): a genuine marker-bullet checklist NOT under a 'Checks' heading still wins the later-run tie-break unaffected (issue #330's Stage 1 finding 1 must not regress)", () => {
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
  assert.equal(countVerificationWalkthroughItems(body), 3, "an unrelated section not literally named 'Checks' must not be masked out");
});

test("countVerificationWalkthroughItems (issue #381): reproduces the real #380/#381 response — the correct 6-item numbered walk-through, not the 5-item 'Checks' section", () => {
  assert.equal(countVerificationWalkthroughItems(ISSUE_381_COMMENT), 6);
  assert.equal(countNumberedItems(ISSUE_381_CHECKLIST), 6);
});

test("hasCompleteVerificationEvidence (issue #381): the real response satisfies its real 6-item requested checklist", () => {
  assert.equal(hasCompleteVerificationEvidence(ISSUE_381_COMMENT, ISSUE_381_CHECKLIST), true);
});

test("isCompletedStage2AuditReport (issue #381): reproduces the real #380 CLEAN Stage 2 response as complete — previously misclassified as incomplete (5 of 6) due to the later 'Checks' section", () => {
  const result = isCompletedStage2AuditReport(ISSUE_381_COMMENT, {
    mergeCommit: ISSUE_381_COMMIT,
    requestedChecklist: ISSUE_381_CHECKLIST,
  });
  assert.equal(result.complete, true);
  assert.equal(result.verdict, "CLEAN");
  assert.deepEqual(result.reasons, []);
});
