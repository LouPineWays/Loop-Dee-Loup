// Tests for tools/review-watch/lifecycle-gate.mjs. All `gh` access is faked via the injected
// `ghPrViewImpl`/`ghIssueViewImpl`/`ghApiImpl`/`ghReopenImpl`/`ghCommentImpl` options — never
// touch the real network or `gh` CLI here. Run with:
// node --test tools/review-watch/lifecycle-gate.test.mjs
//
// Covers the regression case (PR #154 / Issue #151), the numbered verification list in issue
// #156, and the Stage 1 inline review findings on this PR's own PR #186 (closing-keyword
// repository qualification, form-field anchoring, CLEAN-verdict provenance, nonnumeric
// --issue, and partial recovery failure).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  checkCloseAudit,
  checkCloseWorkIssue,
  checkMergeReady,
  checkPostAudit,
  checkRecordVerdict,
  findClosingKeywordMatch,
  isNoWorkIssueSentinel,
  normalizeIssueNumber,
  normalizeSearchIssuesPage,
  parseArgs,
  parseCorrectsAuditRef,
  parseFormField,
  parseFormFieldBlock,
  parseMergeCommitRef,
  parseReviewedHeadCommitRef,
  parseStage2Verdict,
  parseVerificationChecklistRef,
  parseWorkIssueRef,
  recoverPrematureClosure,
  replaceVerdictField,
} from "./lifecycle-gate.mjs";
import { triggerCommentBody } from "./trigger.mjs";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
function readFixture(name) {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8").trimEnd();
}

const MERGE_COMMIT = "b281dbd5e7590b8ac2992753cd875f5e6472d556";

// A *completed* Stage 2 audit report (issue #230's evidence contract: references the exact
// merge commit, states an explicit verdict, and shows verification-results content) on an
// issue-comments thread, for tests that need checkPostAudit's CLEAN-verdict provenance check to
// find one. This replaces an earlier, looser "genuine response" fixture that this same contract
// would now correctly reject — see the dedicated kickoff/incomplete-response tests below for
// the shapes that must still fail.
function completedAuditThread({
  triggerTime = "2026-08-20T00:00:00Z",
  responseTime = "2026-08-20T00:05:00Z",
  verdict = "CLEAN",
  commit = MERGE_COMMIT,
} = {}) {
  const body = [
    `${verdict} — Stage 2 audit of the merge commit \`${commit}\`.`,
    "",
    "### Verification checklist",
    "",
    "1. Confirmed the change against the merge commit — CONFIRMED",
    "2. Confirmed no regressions in adjacent behavior — CONFIRMED",
    "",
    `Verdict: ${verdict}`,
  ].join("\n");
  return [
    { id: 1, body: triggerCommentBody(), created_at: triggerTime },
    { id: 2, user: { login: "chatgpt-codex-connector[bot]" }, body, created_at: responseTime },
  ];
}

// The exact reproduced defect from issue #229: a kickoff acknowledgement followed by a task
// link, with no commit reference, no explicit verdict, and no verification content. A genuine
// response (it is not BLOCKED/refused/a setup prompt), but not a completed audit report.
function kickoffOnlyThread({ triggerTime = "2026-08-20T00:00:00Z", responseTime = "2026-08-20T00:00:42Z" } = {}) {
  return [
    { id: 1, body: triggerCommentBody(), created_at: triggerTime },
    {
      id: 2,
      user: { login: "chatgpt-codex-connector[bot]" },
      body: "Starting #178.\n\n [View task →](https://chatgpt.com/s/cd_6a953a6d05888191ac802c3305e114db)",
      created_at: responseTime,
    },
  ];
}

// A genuine response that is *substantive but incomplete* — unlike kickoffOnlyThread above, it
// states an explicit verdict and references the merge commit (two of the three completed-report
// signals), but shows no verification-results content — the same shape as the real #446/#380
// terse bot replies. Used for tests that need RESPONSE_UNUSABLE to still apply once a genuine
// response is more than a bare progress/kickoff acknowledgement (issue #447's Stage 1 correction:
// the founder-required distinction between "progress-only" and "substantive but unusable").
function substantiveIncompleteThread({
  triggerTime = "2026-08-20T00:00:00Z",
  responseTime = "2026-08-20T00:00:42Z",
  commit = MERGE_COMMIT,
} = {}) {
  return [
    { id: 1, body: triggerCommentBody(), created_at: triggerTime },
    {
      id: 2,
      user: { login: "chatgpt-codex-connector[bot]" },
      body: `CLEAN — audited merge commit \`${commit}\`; no actionable findings. Next: None.`,
      created_at: responseTime,
    },
  ];
}

function auditBodyWithCommit({ workIssue = 151, verdict = "PENDING", commit = MERGE_COMMIT }) {
  return `### Work issue\n\n#${workIssue}\n\n### Exact merge commit\n\n${commit}\n\n### Verdict\n\n${verdict}\n`;
}

// Like auditBodyWithCommit, but also carries a "Verification checklist" field — for tests of
// issue #268 finding 2's completeness check, which compares a response's own checklist
// walk-through against this field's requested item count.
function auditBodyWithChecklist({ workIssue = 151, verdict = "PENDING", commit = MERGE_COMMIT, checklist }) {
  return (
    `### Work issue\n\n#${workIssue}\n\n### Exact merge commit\n\n${commit}\n\n` +
    `### Verification checklist\n\n${checklist}\n\n### Verdict\n\n${verdict}\n`
  );
}

// Like auditBodyWithChecklist, but also carries a real "Stage 1 inline review disposition" field
// naming a frozen reviewed head — for issue #335's checkPostAudit end-to-end tests, which verify
// parseReviewedHeadCommitRef's output actually reaches isCompletedStage2AuditReport as
// reviewedHeadCommit (diagnostic-only; it never satisfies target identity on its own).
function auditBodyWithReviewedHead({ workIssue = 151, verdict = "PENDING", commit = MERGE_COMMIT, reviewedHead, checklist = null }) {
  const checklistBlock = checklist ? `### Verification checklist\n\n${checklist}\n\n` : "";
  return (
    `### Work issue\n\n#${workIssue}\n\n### Exact merge commit\n\n${commit}\n\n` +
    `### Stage 1 inline review disposition\n\nOne inline @codex review round at frozen head \`${reviewedHead}\`: (link). ` +
    `No findings; no second round requested.\n\n${checklistBlock}### Verdict\n\n${verdict}\n`
  );
}

// -- normalizeIssueNumber ----------------------------------------------------------------

test("normalizeIssueNumber: accepts a bare integer and a '#'-prefixed one", () => {
  assert.equal(normalizeIssueNumber(151), "151");
  assert.equal(normalizeIssueNumber("151"), "151");
  assert.equal(normalizeIssueNumber("#151"), "151");
  assert.equal(normalizeIssueNumber(" #151 "), "151");
});

test("normalizeIssueNumber: rejects non-numeric input (Stage 1 review finding on PR #186)", () => {
  assert.equal(normalizeIssueNumber("abc"), null);
  assert.equal(normalizeIssueNumber("151abc"), null);
  assert.equal(normalizeIssueNumber(""), null);
  assert.equal(normalizeIssueNumber(undefined), null);
});

test("normalizeIssueNumber: rejects 0 and #0 (Stage 2 audit finding on issue #187)", () => {
  assert.equal(normalizeIssueNumber(0), null);
  assert.equal(normalizeIssueNumber("0"), null);
  assert.equal(normalizeIssueNumber("#0"), null);
  assert.equal(normalizeIssueNumber("00"), null);
});

// -- isNoWorkIssueSentinel (issue #190) --------------------------------------------------

test("isNoWorkIssueSentinel: matches only the literal, case-insensitive 'none'", () => {
  assert.equal(isNoWorkIssueSentinel("none"), true);
  assert.equal(isNoWorkIssueSentinel("None"), true);
  assert.equal(isNoWorkIssueSentinel(" NONE "), true);
});

test("isNoWorkIssueSentinel: does not treat an omitted/empty/non-'none' value as the sentinel", () => {
  assert.equal(isNoWorkIssueSentinel(undefined), false);
  assert.equal(isNoWorkIssueSentinel(null), false);
  assert.equal(isNoWorkIssueSentinel(""), false);
  assert.equal(isNoWorkIssueSentinel("151"), false);
  assert.equal(isNoWorkIssueSentinel("n/a"), false);
});

// -- findClosingKeywordMatch ------------------------------------------------------------

test("findClosingKeywordMatch: matches Fixes #N (the PR #154 regression case)", () => {
  assert.equal(findClosingKeywordMatch("Fixes #151", 151), "Fixes #151");
});

test("findClosingKeywordMatch: matches every documented closing keyword and case variant", () => {
  for (const word of ["close", "closes", "closed", "Close", "CLOSES", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
    assert.ok(findClosingKeywordMatch(`${word} #151`, 151), `expected "${word} #151" to match`);
  }
});

test("findClosingKeywordMatch: does not match a non-closing reference (Addresses/Implements)", () => {
  assert.equal(findClosingKeywordMatch("Addresses #151", 151), null);
  assert.equal(findClosingKeywordMatch("Implements #151", 151), null);
});

test("findClosingKeywordMatch: does not match a longer issue number sharing a prefix", () => {
  assert.equal(findClosingKeywordMatch("Fixes #1510", 151), null);
});

test("findClosingKeywordMatch: matches with a colon between keyword and number", () => {
  assert.equal(findClosingKeywordMatch("Fixes: #151", 151), "Fixes: #151");
});

test("findClosingKeywordMatch: returns null for empty/undefined text", () => {
  assert.equal(findClosingKeywordMatch(undefined, 151), null);
  assert.equal(findClosingKeywordMatch("", 151), null);
});

test("findClosingKeywordMatch: matches a repository-qualified closing reference (Stage 1 review finding on PR #186)", () => {
  assert.equal(findClosingKeywordMatch("Fixes owner/repo#151", 151, "owner/repo"), "Fixes owner/repo#151");
});

test("findClosingKeywordMatch: a qualified reference to a different repository does not match this repo's issue", () => {
  assert.equal(findClosingKeywordMatch("Fixes other/repo#151", 151, "owner/repo"), null);
});

test("findClosingKeywordMatch: without a repo argument, a qualified reference still matches (fails closed)", () => {
  assert.equal(findClosingKeywordMatch("Fixes other/repo#151", 151), "Fixes other/repo#151");
});

test("findClosingKeywordMatch: finds a same-repo match even when an earlier different-repo match precedes it", () => {
  const text = "Fixes other/repo#151\n\nAlso Fixes owner/repo#151";
  assert.equal(findClosingKeywordMatch(text, 151, "owner/repo"), "Fixes owner/repo#151");
});

// -- parseFormField / parseStage2Verdict / parseWorkIssueRef ---------------------------

test("parseFormField: reads the first non-blank line under a heading", () => {
  const body = "### Verdict\n\nCLEAN\n\n### Next authorized action\n\nNone\n";
  assert.equal(parseFormField(body, "Verdict"), "CLEAN");
  assert.equal(parseFormField(body, "Next authorized action"), "None");
});

test("parseFormField: returns null when the heading is absent", () => {
  assert.equal(parseFormField("no headings here", "Verdict"), null);
});

test("parseFormField: anchors to the last matching heading, not an embedded example earlier in the body (Stage 1 review finding on PR #186)", () => {
  const body = [
    "### Findings",
    "",
    "The required structure includes a line like:",
    "### Verdict",
    "",
    "CLEAN",
    "",
    "### Verdict",
    "",
    "NOT CLEAN",
  ].join("\n");
  assert.equal(
    parseFormField(body, "Verdict"),
    "NOT CLEAN",
    "the real dropdown-rendered heading is the last one in the body, not text quoted inside an earlier field",
  );
});

test("parseStage2Verdict: accepts PENDING, CLEAN, and NOT CLEAN", () => {
  assert.equal(parseStage2Verdict("### Verdict\n\nPENDING\n"), "PENDING");
  assert.equal(parseStage2Verdict("### Verdict\n\nCLEAN\n"), "CLEAN");
  assert.equal(parseStage2Verdict("### Verdict\n\nNOT CLEAN\n"), "NOT CLEAN");
});

test("parseStage2Verdict: returns null for a missing or malformed field", () => {
  assert.equal(parseStage2Verdict("no verdict field"), null);
  assert.equal(parseStage2Verdict("### Verdict\n\nMaybe?\n"), null);
});

test("parseStage2Verdict: an embedded 'CLEAN' inside the Findings field does not read as the real verdict (Stage 1 review finding on PR #186)", () => {
  const body = ["### Findings", "", "### Verdict", "", "CLEAN", "", "### Verdict", "", "PENDING"].join("\n");
  assert.equal(parseStage2Verdict(body), "PENDING");
});

test("parseWorkIssueRef: reads #N, bare N, and a trailing issue URL", () => {
  assert.equal(parseWorkIssueRef("### Work issue\n\n#151\n"), 151);
  assert.equal(parseWorkIssueRef("### Work issue\n\n151\n"), 151);
  assert.equal(parseWorkIssueRef("### Work issue\n\nhttps://github.com/owner/repo/issues/151\n"), 151);
});

test("parseWorkIssueRef: returns null when the field is absent", () => {
  assert.equal(parseWorkIssueRef("no work issue field"), null);
});

test("parseWorkIssueRef: reads a deliberately typed 'none'/'n/a' as the explicit no-work-issue state (issue #190), case-insensitively", () => {
  assert.equal(parseWorkIssueRef("### Work issue\n\nnone\n"), "none");
  assert.equal(parseWorkIssueRef("### Work issue\n\nNone\n"), "none");
  assert.equal(parseWorkIssueRef("### Work issue\n\nN/A\n"), "none");
});

test("parseMergeCommitRef: reads the Exact merge commit field", () => {
  assert.equal(parseMergeCommitRef(`### Exact merge commit\n\n${MERGE_COMMIT}\n`), MERGE_COMMIT);
});

test("parseMergeCommitRef: returns null when the field is absent", () => {
  assert.equal(parseMergeCommitRef("no merge commit field"), null);
});

test("parseMergeCommitRef: extracts the SHA out of backticks and trailing annotation (the real shape issue #95's audit used)", () => {
  assert.equal(
    parseMergeCommitRef(`### Exact merge commit\n\n\`${MERGE_COMMIT}\` (on \`main\`)\n`),
    MERGE_COMMIT,
  );
});

// -- parseReviewedHeadCommitRef (issue #335) ---------------------------------------------

const ISSUE_330_FROZEN_HEAD = "9d775fc430faa5e236d2670de8e806fc27ca8491";
const ISSUE_334_FROZEN_HEAD = "82651b3c8026ba118bb3bbf22c1dee6a09d27670";

test("parseReviewedHeadCommitRef: reads the real issue #330 'Stage 1 inline review disposition' field text", () => {
  const body =
    "### Stage 1 inline review disposition\n\n" +
    `One inline \`@codex review\` round at frozen head \`${ISSUE_330_FROZEN_HEAD}\`: https://github.com/LouPineWays/Loop-Dee-Loup/pull/329#pullrequestreview-5101906774 (plus 1 inline comment). The finding was valid and fixed in commit \`3b19645\`, then merged unchanged:\n\n` +
    "- **P2 — Recognize bold Markdown labels before anchoring**: ... fixed by stripping Markdown bold emphasis globally first.\n\n" +
    "No second inline round was requested, per Stage 1 step 7.\n\n### Audit scope\n\n...";
  assert.equal(parseReviewedHeadCommitRef(body), ISSUE_330_FROZEN_HEAD);
});

test("parseReviewedHeadCommitRef: reads the real issue #334 'Stage 1 inline review disposition' field text", () => {
  const body = `### Stage 1 inline review disposition\n\n${readFixture("issue-334-review-disposition.txt")}\n\n### Audit scope\n\n...`;
  assert.equal(parseReviewedHeadCommitRef(body), ISSUE_334_FROZEN_HEAD);
});

test("parseReviewedHeadCommitRef: returns null when the field is absent", () => {
  assert.equal(parseReviewedHeadCommitRef("no such field here"), null);
});

test("parseReviewedHeadCommitRef: returns null when the field is present but does not contain the 'frozen ... head `<sha>`' phrase (malformed/unparseable trusted target metadata must fail closed to null, not guess)", () => {
  const body = "### Stage 1 inline review disposition\n\nReviewed at commit `9d775fc430faa5e236d2670de8e806fc27ca8491`, no findings.";
  assert.equal(parseReviewedHeadCommitRef(body), null);
});

test("parseReviewedHeadCommitRef: does not match an unrelated SHA-looking token elsewhere in the block when no 'frozen ... head' phrase precedes it", () => {
  const body =
    "### Stage 1 inline review disposition\n\nFixed in commit `3b19645abc1234567890abcdef1234567890abcd`, then merged unchanged.";
  assert.equal(parseReviewedHeadCommitRef(body), null);
});

test("parseReviewedHeadCommitRef: tolerates extra words between 'frozen' and 'head' (e.g. 'frozen Stage 1 reviewed head')", () => {
  const body = `### Stage 1 inline review disposition\n\nReviewed at the frozen Stage 1 reviewed head \`${ISSUE_330_FROZEN_HEAD}\`.`;
  assert.equal(parseReviewedHeadCommitRef(body), ISSUE_330_FROZEN_HEAD);
});

test("parseWorkIssueRef: does NOT treat GitHub's own '_No response_' marker as the no-work-issue sentinel (Stage 1 review finding on PR #197)", () => {
  // The Work issue field is required precisely so this marker can never legitimately appear;
  // if it somehow does anyway, it must fail closed as malformed (null), not be silently read as
  // an intentional no-work-issue declaration — otherwise an operator who simply forgot to fill
  // in a real work issue on an audit that has one would have that issue's premature-closure
  // protection silently stripped, since a forgotten field and a deliberate declaration would
  // render identically.
  assert.equal(parseWorkIssueRef("### Work issue\n\n_No response_\n"), null);
});

// -- parseFormFieldBlock / parseVerificationChecklistRef ---------------------------------

test("parseFormFieldBlock: reads every line under a heading, not just the first", () => {
  const body = "### Verification checklist\n\n1. Confirm A.\n2. Confirm B.\n3. Confirm C.\n\n### Findings\n\nPending";
  assert.equal(parseFormFieldBlock(body, "Verification checklist"), "1. Confirm A.\n2. Confirm B.\n3. Confirm C.");
});

test("parseFormFieldBlock: returns null when the heading is absent, empty, or '_No response_'", () => {
  assert.equal(parseFormFieldBlock("no headings here", "Verification checklist"), null);
  assert.equal(parseFormFieldBlock("### Verification checklist\n\n### Findings\n\nPending", "Verification checklist"), null);
  assert.equal(parseFormFieldBlock("### Verification checklist\n\n_No response_\n\n### Findings", "Verification checklist"), null);
});

test("parseFormFieldBlock: anchors to the FIRST matching heading — the opposite of parseFormField's last-match convention (Stage 1 review finding on this PR)", () => {
  // "Verification checklist" renders before "Findings" in the template, so a response later
  // pasted into Findings that echoes its own "### Verification checklist" heading (per the
  // required response structure's item 3) sits *after* the real field, not before it — the
  // reverse of Verdict's problem. Matching last would read that pasted, possibly-truncated
  // section as the "requested" checklist instead of the original authored one.
  const body = [
    "### Verification checklist",
    "",
    "1. Confirm the classifier rejects the exact #229 kickoff.",
    "2. Confirm a valid report is still accepted.",
    "3. Verify evidence beyond the first 200 characters is read.",
    "",
    "### Findings",
    "",
    "### Verification checklist",
    "",
    "1. Confirmed the classifier rejects the exact #229 kickoff — CONFIRMED",
    "",
    "### Verdict",
    "",
    "CLEAN",
  ].join("\n");
  assert.equal(
    parseFormFieldBlock(body, "Verification checklist"),
    "1. Confirm the classifier rejects the exact #229 kickoff.\n2. Confirm a valid report is still accepted.\n3. Verify evidence beyond the first 200 characters is read.",
    "must read the original 3-item field, not the shorter 1-item section echoed later inside Findings",
  );
});

test("parseVerificationChecklistRef: reads the audit-control-issue template's Verification checklist field", () => {
  const body = [
    "### Exact merge commit",
    "",
    MERGE_COMMIT,
    "",
    "### Verification checklist",
    "",
    "1. Confirm the classifier rejects the exact #229 kickoff.",
    "2. Confirm a valid report is still accepted.",
    "",
    "### Findings",
    "",
    "Pending — awaiting Stage 2 audit response.",
  ].join("\n");
  assert.equal(
    parseVerificationChecklistRef(body),
    "1. Confirm the classifier rejects the exact #229 kickoff.\n2. Confirm a valid report is still accepted.",
  );
});

// -- checkMergeReady ---------------------------------------------------------------------

test("checkMergeReady: exits 1 when required args are missing", async () => {
  const result = await checkMergeReady({});
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /Missing or invalid required args/);
});

test("checkMergeReady: exits 1 when --issue is not numeric (Stage 1 review finding on PR #186)", async () => {
  const result = await checkMergeReady({ repo: "owner/repo", pr: 154, issue: "abc" });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /positive integer/);
});

test("checkMergeReady: exits 1 (not MERGE_READY) when --issue is 0 (Stage 2 audit finding on issue #187)", async () => {
  const result = await checkMergeReady(
    { repo: "owner/repo", pr: 154, issue: 0 },
    { ghPrViewImpl: async () => ({ closingIssuesReferences: [], commits: [] }) },
  );
  assert.equal(result.exitCode, 1, "a zero issue number must fail closed, not silently report MERGE_READY");
  assert.match(result.message, /positive integer/);
});

test("checkMergeReady: accepts a '#'-prefixed --issue and still detects the closing reference", async () => {
  const result = await checkMergeReady(
    { repo: "owner/repo", pr: 154, issue: "#151" },
    { ghPrViewImpl: async () => ({ closingIssuesReferences: [{ number: 151 }], commits: [] }) },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED_CLOSING_REFERENCE");
});

test("checkMergeReady: BLOCKED — a PR-body closing keyword surfaced via closingIssuesReferences (verification #3)", async () => {
  const result = await checkMergeReady(
    { repo: "owner/repo", pr: 154, issue: 151 },
    { ghPrViewImpl: async () => ({ closingIssuesReferences: [{ number: 151, url: "https://github.com/owner/repo/issues/151" }], commits: [] }) },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED_CLOSING_REFERENCE");
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].source, "closingIssuesReferences");
});

test("checkMergeReady: BLOCKED — a Development-sidebar closing reference, same field as PR-body keywords (verification #4)", async () => {
  // GitHub's closingIssuesReferences makes no distinction between a PR-body keyword and a
  // manually-linked Development-sidebar reference — both sources populate the same field,
  // so this is the same code path and the same test shape as the PR-body case above.
  const result = await checkMergeReady(
    { repo: "owner/repo", pr: 154, issue: 151 },
    { ghPrViewImpl: async () => ({ closingIssuesReferences: [{ number: 151 }], commits: [] }) },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED_CLOSING_REFERENCE");
});

test("checkMergeReady: MERGE_READY — a same-numbered issue in a different repository does not block (Stage 1 review finding on PR #186)", async () => {
  const result = await checkMergeReady(
    { repo: "owner/repo", pr: 154, issue: 151 },
    { ghPrViewImpl: async () => ({ closingIssuesReferences: [{ number: 151, url: "https://github.com/other/repo/issues/151" }], commits: [] }) },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "MERGE_READY");
});

test("checkMergeReady: BLOCKED — a closing keyword in a commit message (verification #5)", async () => {
  const result = await checkMergeReady(
    { repo: "owner/repo", pr: 154, issue: 151 },
    {
      ghPrViewImpl: async () => ({
        closingIssuesReferences: [],
        commits: [{ oid: "abc123", messageHeadline: "Fix the bug", messageBody: "Fixes #151" }],
      }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED_CLOSING_REFERENCE");
  assert.equal(result.violations[0].source, "commit:abc123");
});

test("checkMergeReady: BLOCKED — a repository-qualified closing keyword in a commit message (Stage 1 review finding on PR #186)", async () => {
  const result = await checkMergeReady(
    { repo: "owner/repo", pr: 154, issue: 151 },
    {
      ghPrViewImpl: async () => ({
        closingIssuesReferences: [],
        commits: [{ oid: "abc123", messageHeadline: "Fix the bug", messageBody: "Fixes owner/repo#151" }],
      }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "BLOCKED_CLOSING_REFERENCE");
});

test("checkMergeReady: MERGE_READY — only non-closing references are present (verification #6)", async () => {
  const result = await checkMergeReady(
    { repo: "owner/repo", pr: 154, issue: 151 },
    {
      ghPrViewImpl: async () => ({
        closingIssuesReferences: [],
        commits: [{ oid: "abc123", messageHeadline: "Addresses #151", messageBody: "" }],
      }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "MERGE_READY");
});

// -- checkMergeReady: explicit no-work-issue state (issue #190, reproducing YouTubery PR #19) --

test("checkMergeReady: reproduces the YouTubery PR #19 failure — an undefined --issue fails closed, not MERGE_READY", async () => {
  const result = await checkMergeReady({ repo: "LouPineWays/YouTubery", pr: 19 });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /positive integer/);
  assert.match(result.message, /"none"/);
});

test("checkMergeReady: MERGE_READY_NO_WORK_ISSUE — '--issue none' skips the closing-reference check without inspecting any issue", async () => {
  let ghPrViewCalled = false;
  const result = await checkMergeReady(
    { repo: "LouPineWays/YouTubery", pr: 19, issue: "none" },
    { ghPrViewImpl: async () => { ghPrViewCalled = true; return { closingIssuesReferences: [], commits: [] }; } },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "MERGE_READY_NO_WORK_ISSUE");
  assert.equal(result.workIssue, null);
  assert.equal(ghPrViewCalled, false, "no-work-issue state must not fabricate a lookup against an unrelated issue");
});

test("checkMergeReady: MERGE_READY_NO_WORK_ISSUE still requires --repo and --pr", async () => {
  const result = await checkMergeReady({ issue: "none" });
  assert.equal(result.exitCode, 1);
});

test("checkMergeReady: MERGE_READY — a closing reference to a different issue does not block this one", async () => {
  const result = await checkMergeReady(
    { repo: "owner/repo", pr: 154, issue: 151 },
    { ghPrViewImpl: async () => ({ closingIssuesReferences: [{ number: 999 }], commits: [] }) },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "MERGE_READY");
});

// -- checkPostAudit ------------------------------------------------------------------------

function auditBody({ workIssue = 151, verdict = "PENDING" }) {
  return `### Work issue\n\n#${workIssue}\n\n### Verdict\n\n${verdict}\n`;
}

// A ghApiImpl that returns a completed Stage 2 audit report (issue #230's evidence contract)
// for the audit issue's issue-comments endpoint and an empty array for anything else.
function withCompletedAuditReport(opts) {
  return async (path) => (path.includes("/issues/") ? completedAuditThread(opts) : []);
}

// A ghApiImpl that returns only the exact #229 kickoff-and-task-link reply — a genuine
// response, but not a completed audit report — for the audit issue's issue-comments endpoint.
function withKickoffOnly() {
  return async (path) => (path.includes("/issues/") ? kickoffOnlyThread() : []);
}

// A ghApiImpl that returns only the substantive-but-incomplete reply above — a genuine response
// that shows at least one completed-report signal, just not a complete set — for the audit
// issue's issue-comments endpoint.
function withSubstantiveIncomplete() {
  return async (path) => (path.includes("/issues/") ? substantiveIncompleteThread() : []);
}

// A response that otherwise looks like a completed Stage 2 audit report (issue #230's evidence
// contract) but cites only the trusted frozen reviewed head — never the merge commit — the exact
// shape issue #335/audit #334 demonstrated. This must NOT back CLEAN even with an otherwise-
// complete checklist: reviewedHeadCommit is diagnostic-only (a Stage 1 review finding proved
// letting it substitute for mergeCommit is unsafe), so this thread's target-identity signal
// always fails regardless of checklist completeness.
function reviewedHeadOnlyThread({
  triggerTime = "2026-08-20T00:00:00Z",
  responseTime = "2026-08-20T00:05:00Z",
  verdict = "CLEAN",
  reviewedHead,
  checklistItems = ["1. Confirmed the change against the frozen reviewed head — CONFIRMED", "2. Confirmed no regressions — CONFIRMED"],
} = {}) {
  const body = [
    `${verdict} — Stage 2 audit verified against frozen reviewed head \`${reviewedHead}\`.`,
    "",
    "### Verification checklist",
    "",
    ...checklistItems,
    "",
    `Verdict: ${verdict}`,
  ].join("\n");
  return [
    { id: 1, body: triggerCommentBody(), created_at: triggerTime },
    { id: 2, user: { login: "chatgpt-codex-connector[bot]" }, body, created_at: responseTime },
  ];
}

function withReviewedHeadOnlyReport(opts) {
  return async (path) => (path.includes("/issues/") ? reviewedHeadOnlyThread(opts) : []);
}

test("checkPostAudit: exits 1 when required args are missing", async () => {
  const result = await checkPostAudit({});
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /Missing required args/);
});

test("checkPostAudit: exits 1 when the audit issue has no Work issue field", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    { ghIssueViewImpl: async () => ({ body: "### Verdict\n\nPENDING\n", state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /Work issue/);
});

test("checkPostAudit: exits 1 (operational error, not ACCEPTED_NO_WORK_ISSUE) when Work issue renders GitHub's '_No response_' marker (Stage 1 review finding on PR #197)", async () => {
  // Regression test for the exact scenario the reviewer flagged against an earlier,
  // optional-field version of the template: an audit that DOES gate a real work issue, where
  // the operator simply forgot to fill in the field. It must not be silently accepted as "no
  // work issue applies" — that would strip the real work issue's premature-closure protection.
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    { ghIssueViewImpl: async () => ({ body: "### Work issue\n\n_No response_\n\n### Verdict\n\nCLEAN\n", state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /Work issue/);
});

test("checkPostAudit: OK — work issue open, verdict PENDING (verification #8)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBody({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: async () => [], // no trigger, no response — genuinely still waiting (issue #439)
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK");
  assert.equal(result.verdict, "PENDING");
});

test("checkPostAudit: OK — work issue open, verdict NOT CLEAN (verification #9)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBody({ verdict: "NOT CLEAN" }), state: "OPEN" } : { body: "", state: "OPEN" },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK");
  assert.equal(result.verdict, "NOT CLEAN");
});

test("checkPostAudit: READY_TO_CLOSE — verdict CLEAN backed by a completed audit report, work issue still open (verification #10)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withCompletedAuditReport(),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "READY_TO_CLOSE");
  assert.equal(result.workIssue, 151);
});

test("checkPostAudit: READY_TO_CLOSE — a response's checklist walk-through meeting the audit issue's own requested item count is trusted (issue #268 finding 2)", async () => {
  const requestedChecklist = [
    "1. Confirmed the change against the merge commit.",
    "2. Confirmed no regressions in adjacent behavior.",
  ].join("\n");
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160
          ? { body: auditBodyWithChecklist({ verdict: "CLEAN", checklist: requestedChecklist }), state: "OPEN" }
          : { body: "", state: "OPEN" },
      ghApiImpl: withCompletedAuditReport(),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "READY_TO_CLOSE");
  assert.equal(result.verdict, "CLEAN");
});

test("checkPostAudit: a CLEAN dropdown backed only by a response whose checklist walk-through is shorter than the audit issue's own requested checklist is not trusted (issue #268 finding 2)", async () => {
  const requestedChecklist = [
    "1. Confirm the classifier rejects the exact #229 kickoff.",
    "2. Confirm a valid report is still accepted.",
    "3. Verify evidence beyond the first 200 characters is read.",
  ].join("\n");
  const truncatedResponseThread = () => {
    const body = [
      `CLEAN — Stage 2 audit of the merge commit \`${MERGE_COMMIT}\`.`,
      "",
      "### Verification checklist",
      "",
      "1. Confirmed the classifier rejects the exact #229 kickoff — CONFIRMED",
      "",
      "Verdict: CLEAN",
    ].join("\n");
    return [
      { id: 1, body: triggerCommentBody(), created_at: "2026-08-20T00:00:00Z" },
      { id: 2, user: { login: "chatgpt-codex-connector[bot]" }, body, created_at: "2026-08-20T00:05:00Z" },
    ];
  };
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160
          ? { body: auditBodyWithChecklist({ verdict: "CLEAN", checklist: requestedChecklist }), state: "OPEN" }
          : { body: "", state: "OPEN" },
      ghApiImpl: async (path) => (path.includes("issues") ? truncatedResponseThread() : []),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK", "a checklist walk-through shorter than what was requested must not authorize READY_TO_CLOSE");
  assert.equal(result.verdict, null);
  assert.equal(result.rawVerdict, "CLEAN");
});

test("checkPostAudit: a CLEAN dropdown with no genuine post-trigger response is not trusted (Stage 1 review finding on PR #186)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: async () => [], // no trigger, no response at all
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK", "an unbacked CLEAN must not authorize READY_TO_CLOSE");
  assert.equal(result.verdict, null);
  assert.equal(result.rawVerdict, "CLEAN");
});

test("checkPostAudit: a CLEAN dropdown backed only by the exact #229 kickoff-and-task-link reply is not trusted (issue #230's reproduced defect)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withKickoffOnly(),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK", "a kickoff/acknowledgement alone must not authorize READY_TO_CLOSE");
  assert.equal(result.verdict, null);
  assert.equal(result.rawVerdict, "CLEAN");
});

test("checkPostAudit: a bounded follow-up report after the kickoff is still discoverable and backs CLEAN", async () => {
  // Requirement 4 of issue #230: a later valid report must remain discoverable — this
  // combines the kickoff with a subsequent completed report on the same thread.
  const ghApiImpl = async (path) => {
    if (!path.includes("/issues/")) return [];
    const [trigger, kickoffResponse] = kickoffOnlyThread();
    const [, reportResponse] = completedAuditThread({ responseTime: "2026-08-20T00:10:00Z" });
    return [trigger, kickoffResponse, { ...reportResponse, id: 3 }];
  };
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl,
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "READY_TO_CLOSE");
});

// -- checkPostAudit: reviewedHeadCommit is diagnostic-only end to end (issue #335, audit #334) --
// An earlier revision of this fix let a response naming only the trusted reviewed head back
// CLEAN; a Stage 1 review finding proved that unsafe (see stage2-report.test.mjs's adversarial
// "incorrect merge commit + correct reviewed head" unit test) and required reverting to a
// strictly mandatory merge-commit check end to end, too.

test("checkPostAudit: a response citing only the audit issue's trusted frozen reviewed head (never the merge commit) is still NOT backed, even with an otherwise-complete checklist", async () => {
  const reviewedHead = "82651b3c8026ba118bb3bbf22c1dee6a09d27670";
  const checklist = "1. Confirm the change.\n2. Confirm no regressions.";
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160
          ? { body: auditBodyWithReviewedHead({ verdict: "CLEAN", reviewedHead, checklist }), state: "OPEN" }
          : { body: "", state: "OPEN" },
      ghApiImpl: withReviewedHeadOnlyReport({ reviewedHead }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK", "reviewedHeadCommit must never substitute for the mandatory merge-commit citation");
  assert.equal(result.verdict, null);
  assert.match(result.reportEvidence.reason, /reviewed head/, "the reason should still name the reviewed-head citation for diagnostic clarity");
});

// Stage 1 review finding, issue #335: the exact unsafe scenario an earlier `||`-based revision
// would have wrongly accepted, reproduced end to end through checkPostAudit. The response names
// an INCORRECT merge commit while also citing the audit's own correct, trusted reviewed head.
test("checkPostAudit: a response naming an INCORRECT merge commit while also citing the correct trusted reviewed head is still NOT backed end to end", async () => {
  const reviewedHead = "82651b3c8026ba118bb3bbf22c1dee6a09d27670";
  const checklist = "1. Confirm the change.\n2. Confirm no regressions.";
  const incorrectMergeCommit = "1234567890abcdef1234567890abcdef12345678";
  const adversarialThread = () => {
    const body = [
      `Stage 2 audit of the merge commit \`${incorrectMergeCommit}\`.`, // wrong — not the audit's real commit
      "",
      "### Verification checklist",
      "",
      `1. Confirmed the control-plane workflow ran against frozen reviewed head \`${reviewedHead}\` — CONFIRMED`,
      "2. Confirmed no regressions — CONFIRMED",
      "",
      "Verdict: CLEAN",
    ].join("\n");
    return [
      { id: 1, body: triggerCommentBody(), created_at: "2026-08-20T00:00:00Z" },
      { id: 2, user: { login: "chatgpt-codex-connector[bot]" }, body, created_at: "2026-08-20T00:05:00Z" },
    ];
  };
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160
          ? { body: auditBodyWithReviewedHead({ verdict: "CLEAN", reviewedHead, checklist }), state: "OPEN" }
          : { body: "", state: "OPEN" },
      ghApiImpl: async (path) => (path.includes("/issues/") ? adversarialThread() : []),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(
    result.state,
    "OK",
    "an incorrect merge-commit claim must never be forgiven merely because the response also cites the correct reviewed head",
  );
  assert.equal(result.verdict, null);
});

const ISSUE_334_MERGE_COMMIT = "0c9358ec0f607e2c3fc26ef8049585ab5d655fbe";

test("checkPostAudit: reproduces issue #334's exact live shape end to end — stays correctly unbacked: target identity fails (no merge-commit citation) and checklist completeness independently fails (11 requested, 4 shown)", async () => {
  const auditIssueBody =
    `### Work issue\n\nnone\n\n### Exact merge commit\n\n\`${ISSUE_334_MERGE_COMMIT}\` (on \`main\`)\n\n` +
    `### Stage 1 inline review disposition\n\n${readFixture("issue-334-review-disposition.txt")}\n\n` +
    `### Verification checklist\n\n${readFixture("issue-334-checklist.txt")}\n\n### Verdict\n\nCLEAN\n`;
  const thread = [
    { id: 1, body: triggerCommentBody(), created_at: "2026-09-03T13:40:59Z" },
    {
      id: 2,
      user: { login: "chatgpt-codex-connector[bot]" },
      body: readFixture("issue-334-comment.txt"),
      created_at: "2026-09-03T13:42:53Z",
    },
  ];
  const result = await checkPostAudit(
    { repo: "LouPineWays/Loop-Dee-Loup", "audit-issue": 334 },
    {
      ghIssueViewImpl: async () => ({ body: auditIssueBody, state: "OPEN" }),
      ghApiImpl: async (path) => (path.includes("/issues/") ? thread : []),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK", "Work issue is 'none' and the response is not backed as CLEAN, so this stays OK rather than ACCEPTED_NO_WORK_ISSUE");
  assert.equal(result.verdict, null, "the genuine 4-item response citing only the reviewed head must not back CLEAN");
  assert.match(result.reportEvidence.reason, /merge commit/);
  assert.match(result.reportEvidence.reason, /reviewed head/);
  assert.match(result.reportEvidence.reason, /incomplete/);
});

test("checkPostAudit: a completed report addressing the wrong merge commit does not back CLEAN", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withCompletedAuditReport({ commit: "deadbeef00000000000000000000000000000000" }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK", "a report addressing a different commit must not authorize READY_TO_CLOSE");
  assert.equal(result.verdict, null);
});

test("checkPostAudit: a completed report whose own verdict disagrees with the CLEAN dropdown does not back CLEAN", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withCompletedAuditReport({ verdict: "NOT CLEAN" }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK", "a contradictory response verdict must not authorize READY_TO_CLOSE");
  assert.equal(result.verdict, null);
  assert.equal(result.rawVerdict, "CLEAN");
});

test("checkPostAudit: PREMATURE_CLOSURE — work issue closed and the recorded CLEAN has no genuine response behind it", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "CLOSED" },
      ghApiImpl: async () => [],
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PREMATURE_CLOSURE");
  assert.match(result.message, /no completed Stage 2 audit report/);
});

test("checkPostAudit: PREMATURE_CLOSURE — work issue closed and the recorded CLEAN is backed only by the #229 kickoff reply", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "CLOSED" },
      ghApiImpl: withKickoffOnly(),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PREMATURE_CLOSURE");
  assert.match(result.message, /no completed Stage 2 audit report/);
});

test("checkPostAudit: OK — verdict CLEAN (backed) and work issue already closed", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "CLOSED" },
      ghApiImpl: withCompletedAuditReport(),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK");
});

// -- checkPostAudit: legacy-compatibility preservation for an already-closed work issue --------
// (issue #230 Required layer 8 / Stage 1 review finding on PR #231)

// The exact terse shape issue #95's real, already-accepted audit used: an explicit CLEAN status
// line and the correct commit, but no numbered verification checklist — the strict contract
// (isCompletedStage2AuditReport's default) rejects this, but a work issue already closed under
// it must not be reopened on a fresh recheck.
function legacyShapedCleanThread({ triggerTime = "2026-08-20T00:00:00Z", responseTime = "2026-08-20T00:05:00Z", commit = MERGE_COMMIT } = {}) {
  return [
    { id: 1, body: triggerCommentBody(), created_at: triggerTime },
    {
      id: 2,
      user: { login: "chatgpt-codex-connector[bot]" },
      body: `CLEAN — Stage 2 audit at \`${commit}\`; no actionable findings. Next: None.`,
      created_at: responseTime,
    },
  ];
}

function withLegacyShapedCleanThread(opts) {
  return async (path) => (path.includes("/issues/") ? legacyShapedCleanThread(opts) : []);
}

test("checkPostAudit: OK — a pre-contract terse CLEAN response is preserved (not PREMATURE_CLOSURE) when the work issue is already closed", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "CLOSED" },
      ghApiImpl: withLegacyShapedCleanThread(),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK", "a legacy-shaped CLEAN backing an already-closed work issue must not be reopened");
  assert.equal(result.verdict, "CLEAN");
  assert.equal(result.reportEvidence.legacyCompatible, true);
});

test("checkPostAudit: the legacy-compatibility fallback does not apply to an open work issue — a terse legacy-shaped response cannot authorize a new closure", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withLegacyShapedCleanThread(),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK", "an open work issue must still require the full strict contract, never READY_TO_CLOSE via the legacy fallback");
  assert.equal(result.verdict, null);
});

test("checkPostAudit: the legacy-compatibility fallback still rejects a closed work issue's response addressing the wrong commit", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "CLOSED" },
      ghApiImpl: withLegacyShapedCleanThread({ commit: "deadbeef00000000000000000000000000000000" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PREMATURE_CLOSURE", "a wrong-commit response must not be accepted even under the legacy fallback");
});

test("checkPostAudit: a later, fully complete NOT CLEAN report is never outranked by an older grandfathered CLEAN response (Stage 1 review finding on PR #234)", async () => {
  // A pre-cutoff terse CLEAN response (eligible for legacy grandfathering) followed by a
  // post-cutoff, fully complete NOT CLEAN report on the same thread. The dropdown still says
  // CLEAN (e.g. never updated after the later report landed) and the work issue is closed. The
  // later, definitive NOT CLEAN evidence must win — this must report PREMATURE_CLOSURE, not
  // silently accept the older grandfathered CLEAN as still-authoritative.
  const ghApiImpl = async (path) => {
    if (!path.includes("/issues/")) return [];
    const [trigger] = legacyShapedCleanThread({ responseTime: "2026-08-20T00:05:00Z" });
    const legacyClean = legacyShapedCleanThread({ responseTime: "2026-08-20T00:05:00Z" })[1];
    const [, laterNotClean] = completedAuditThread({ verdict: "NOT CLEAN", responseTime: "2026-09-01T00:00:00Z" });
    return [trigger, { ...legacyClean, id: 2 }, { ...laterNotClean, id: 3 }];
  };
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "CLOSED" },
      ghApiImpl,
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PREMATURE_CLOSURE", "a later definitive NOT CLEAN report must not be shadowed by an older grandfathered CLEAN");
  assert.equal(result.verdict, null);
});

test("checkPostAudit: a post-contract terse CLEAN response on a closed work issue is NOT preserved by the legacy fallback (Stage 2 audit finding on PR #231, issue #233)", async () => {
  // Being closed alone is not evidence of being historical: a *new* audit response posted after
  // the contract existed, formatted in the terse legacy shape, must not silently mask a genuine
  // premature closure just because something closed the work issue in the meantime.
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "CLOSED" },
      ghApiImpl: withLegacyShapedCleanThread({ responseTime: "2026-09-01T00:00:00Z" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PREMATURE_CLOSURE", "a post-cutoff terse response must never qualify for the legacy-compatibility fallback");
  assert.equal(result.verdict, null);
});

test("checkPostAudit: PREMATURE_CLOSURE — work issue closed with no CLEAN verdict (verification #11, the PR #154/#151 regression)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBody({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "CLOSED" },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PREMATURE_CLOSURE");
  assert.equal(result.workIssue, 151);
  assert.equal(result.verdict, "PENDING");
});

test("checkPostAudit: PREMATURE_CLOSURE — work issue closed and verdict is NOT CLEAN", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBody({ verdict: "NOT CLEAN" }), state: "OPEN" } : { body: "", state: "CLOSED" },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PREMATURE_CLOSURE");
});

// -- checkPostAudit: explicit no-work-issue state (issue #190) -------------------------

function noWorkIssueAuditBody({ verdict = "PENDING", commit = MERGE_COMMIT }) {
  return `### Work issue\n\nnone\n\n### Exact merge commit\n\n${commit}\n\n### Verdict\n\n${verdict}\n`;
}

test("checkPostAudit: OK — no work issue, verdict PENDING; no implementation issue is fetched", async () => {
  let issueViewCalls = 0;
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) => {
        issueViewCalls++;
        return number === 160 ? { body: noWorkIssueAuditBody({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" };
      },
      ghApiImpl: async () => [], // no trigger, no response — genuinely still waiting (issue #439)
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK");
  assert.equal(result.workIssue, null);
  assert.equal(result.verdict, "PENDING");
  assert.equal(issueViewCalls, 1, "only the audit issue itself should be fetched — no work issue to look up");
});

test("checkPostAudit: OK — no work issue, verdict NOT CLEAN, remains non-accepted", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    { ghIssueViewImpl: async () => ({ body: noWorkIssueAuditBody({ verdict: "NOT CLEAN" }), state: "OPEN" }) },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK");
  assert.equal(result.verdict, "NOT CLEAN");
});

test("checkPostAudit: no work issue, CLEAN dropdown with no genuine response is not trusted", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async () => ({ body: noWorkIssueAuditBody({ verdict: "CLEAN" }), state: "OPEN" }),
      ghApiImpl: async () => [],
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK", "an unbacked CLEAN must not authorize acceptance even with no work issue");
  assert.equal(result.verdict, null);
  assert.equal(result.rawVerdict, "CLEAN");
});

test("checkPostAudit: ACCEPTED_NO_WORK_ISSUE — a genuine backed CLEAN verdict with no work issue, no issue-close action attempted", async () => {
  let issueViewCalls = 0;
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async () => {
        issueViewCalls++;
        return { body: noWorkIssueAuditBody({ verdict: "CLEAN" }), state: "OPEN" };
      },
      ghApiImpl: withCompletedAuditReport(),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "ACCEPTED_NO_WORK_ISSUE");
  assert.equal(result.workIssue, null);
  assert.equal(result.verdict, "CLEAN");
  assert.equal(issueViewCalls, 1, "no implementation issue exists to close, so only the audit issue itself is fetched");
});

test("checkPostAudit: the audit issue and work issue are read as distinct issues, never confused (verification #12)", async () => {
  const seenNumbers = [];
  await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) => {
        seenNumbers.push(number);
        return number === 160 ? { body: auditBody({ verdict: "PENDING" }), state: "OPEN" } : { body: "irrelevant", state: "OPEN" };
      },
      ghApiImpl: async () => [], // no trigger, no response — never touch the real network here
    },
  );
  assert.deepEqual(seenNumbers, [160, 151], "must read the audit issue (160) and the distinct work issue (151) it names");
});

// -- checkPostAudit: REPORT_READY_TO_RECORD (issue #439, the live #408/#436 gap) -------------
// A completed report already exists on the thread (of either verdict) but the durable Verdict
// field is still PENDING/malformed. Must report the new REPORT_READY_TO_RECORD state instead of
// the generic OK/PENDING fallthrough — never inferred as "no completed response has landed."

test("checkPostAudit: REPORT_READY_TO_RECORD — work issue open, Verdict PENDING, a completed CLEAN report already exists (verification #1)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withCompletedAuditReport({ verdict: "CLEAN" }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "REPORT_READY_TO_RECORD", "a completed report must not be mistaken for 'no response yet'");
  assert.equal(result.rawVerdict, "PENDING");
  assert.equal(result.workIssue, 151);
  assert.equal(result.reportEvidence.verdict, "CLEAN");
});

test("checkPostAudit: REPORT_READY_TO_RECORD — work issue open, Verdict PENDING, a completed NOT CLEAN report already exists (verification #2)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withCompletedAuditReport({ verdict: "NOT CLEAN" }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "REPORT_READY_TO_RECORD");
  assert.equal(result.reportEvidence.verdict, "NOT CLEAN");
});

test("checkPostAudit: REPORT_READY_TO_RECORD — malformed/missing Verdict field (parses to null) is treated the same as PENDING", async () => {
  const body = `### Work issue\n\n#151\n\n### Exact merge commit\n\n${MERGE_COMMIT}\n`; // no "### Verdict" heading at all
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) => (number === 160 ? { body, state: "OPEN" } : { body: "", state: "OPEN" }),
      ghApiImpl: withCompletedAuditReport(),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "REPORT_READY_TO_RECORD");
  assert.equal(result.rawVerdict, null);
});

test("checkPostAudit: REPORT_READY_TO_RECORD — the explicit no-work-issue state also detects unrecorded completed evidence", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async () => ({ body: noWorkIssueAuditBody({ verdict: "PENDING" }), state: "OPEN" }),
      ghApiImpl: withCompletedAuditReport(),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "REPORT_READY_TO_RECORD");
  assert.equal(result.workIssue, null);
});

test("checkPostAudit: PENDING + no response at all stays true NO_ACTION_YET-shaped OK, not REPORT_READY_TO_RECORD (verification #3)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: async () => [],
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK");
  assert.equal(result.rawVerdict, "PENDING");
});

test("checkPostAudit: PENDING + only the exact #229 kickoff/progress-only response stays ordinary waiting, not RESPONSE_UNUSABLE (issue #447 Stage 1 correction; founder-required regression)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withKickoffOnly(),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(
    result.state,
    "OK",
    "a bare kickoff/progress acknowledgement (the #229 shape) must remain ordinary waiting so the bounded follow-up stays open, not a founder interrupt",
  );
  assert.equal(result.rawVerdict, "PENDING");
});

test("checkPostAudit: RESPONSE_UNUSABLE — PENDING + a genuine substantive-but-incomplete response is not promoted, and is no longer mistaken for ordinary waiting (issue #447; verification #4/#5)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withSubstantiveIncomplete(),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(
    result.state,
    "RESPONSE_UNUSABLE",
    "a genuine response that states a verdict and cites the commit but shows no verification content must not authorize promotion, and must not be reported as ordinary waiting either (issue #447)",
  );
  assert.equal(result.rawVerdict, "PENDING");
  assert.equal(result.reportEvidence.hasGenuineResponse, true);
  assert.equal(result.reportEvidence.hasUnusableGenuineResponse, true);
  assert.equal(result.reportEvidence.backed, false);
});

test("checkPostAudit: RESPONSE_UNUSABLE — a #229-shaped kickoff followed by a later genuine, non-progress, substantive-but-incomplete reply still resolves RESPONSE_UNUSABLE (issue #447 Stage 1 correction; founder-required regression)", async () => {
  const ghApiImpl = async (path) => {
    if (!path.includes("/issues/")) return [];
    const [trigger, kickoffResponse] = kickoffOnlyThread();
    const [, substantiveResponse] = substantiveIncompleteThread({ responseTime: "2026-08-20T00:05:00Z" });
    return [trigger, kickoffResponse, { ...substantiveResponse, id: 3 }];
  };
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl,
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(
    result.state,
    "RESPONSE_UNUSABLE",
    "a progress-only kickoff followed by a genuine substantive-but-incomplete reply must still resolve RESPONSE_UNUSABLE — progress-only tolerance never masks a real unusable response later on the same thread",
  );
  assert.equal(result.reportEvidence.genuineResponsesSeen, 2, "both the kickoff and the substantive reply are genuine candidates");
  assert.equal(result.reportEvidence.hasUnusableGenuineResponse, true);
});

test("checkPostAudit: RESPONSE_UNUSABLE — PENDING + a completed-looking response addressing the wrong merge commit is not promoted, and is no longer mistaken for ordinary waiting (issue #447; verification #5)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withCompletedAuditReport({ commit: "deadbeef00000000000000000000000000000000" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "RESPONSE_UNUSABLE", "a wrong-commit response must never be promoted, but must still surface as a distinct unusable-response state");
  assert.equal(result.reportEvidence.hasGenuineResponse, true);
});

test("checkPostAudit: RESPONSE_UNUSABLE — PENDING + a completed-looking response whose checklist walk-through is shorter than requested is not promoted, and is no longer mistaken for ordinary waiting (issue #447; verification #5)", async () => {
  const requestedChecklist = ["1. Confirm A.", "2. Confirm B.", "3. Confirm C."].join("\n");
  const truncatedThread = () => {
    const body = [
      `CLEAN — Stage 2 audit of the merge commit \`${MERGE_COMMIT}\`.`,
      "",
      "### Verification checklist",
      "",
      "1. Confirmed A — CONFIRMED",
      "",
      "Verdict: CLEAN",
    ].join("\n");
    return [
      { id: 1, body: triggerCommentBody(), created_at: "2026-08-20T00:00:00Z" },
      { id: 2, user: { login: "chatgpt-codex-connector[bot]" }, body, created_at: "2026-08-20T00:05:00Z" },
    ];
  };
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160
          ? { body: auditBodyWithChecklist({ verdict: "PENDING", checklist: requestedChecklist }), state: "OPEN" }
          : { body: "", state: "OPEN" },
      ghApiImpl: async (path) => (path.includes("/issues/") ? truncatedThread() : []),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "RESPONSE_UNUSABLE", "an incomplete checklist walk-through must never be promoted, but must still surface as a distinct unusable-response state");
  assert.equal(result.workIssue, 151);
});

test("checkPostAudit: a settled NOT CLEAN dropdown is unaffected by this fix — its existing branch is never re-checked for report evidence", async () => {
  let apiCalls = 0;
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "NOT CLEAN" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: async (path) => {
        apiCalls++;
        return path.includes("/issues/") ? completedAuditThread({ verdict: "CLEAN" }) : [];
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK");
  assert.equal(result.rawVerdict, "NOT CLEAN");
  assert.equal(apiCalls, 0, "a settled NOT CLEAN dropdown's existing (unmodified) branch never fetches report evidence at all");
});

test("checkPostAudit: PREMATURE_CLOSURE still fires unchanged for a closed work issue with an unrecorded PENDING verdict, even when a completed report exists (this fix narrows only the open-work-issue OK fallthrough)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "CLOSED" },
      ghApiImpl: withCompletedAuditReport({ verdict: "CLEAN" }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PREMATURE_CLOSURE");
});

// -- checkPostAudit: reproduces the live #436 evidence (issue #439's required fixture) --------
// Real audit #436's completed comment 5571784678 (frozen into fixtures/issue-436-comment.txt),
// checklist (fixtures/issue-436-checklist.txt), and Stage 1 review disposition
// (fixtures/issue-436-review-disposition.txt), replayed against the audit issue body's Verdict
// field projected back to PENDING — its actual pre-promotion state when this defect was
// observed (control #408, work issue #407, exact merge commit
// 8fe3ddc42141d383740dde786da13b79022e1acd).

const ISSUE_436_MERGE_COMMIT = "8fe3ddc42141d383740dde786da13b79022e1acd";

function issue436AuditBody({ verdict = "PENDING" } = {}) {
  return (
    `### Work issue\n\n#407\n\n### Exact merge commit\n\n\`${ISSUE_436_MERGE_COMMIT}\`\n\n` +
    `### Stage 1 inline review disposition\n\n${readFixture("issue-436-review-disposition.txt")}\n\n` +
    `### Verification checklist\n\n${readFixture("issue-436-checklist.txt")}\n\n` +
    `### Findings\n\nPending — awaiting Stage 2 audit response.\n\n### Verdict\n\n${verdict}\n`
  );
}

function issue436Thread() {
  return [
    { id: 1, body: triggerCommentBody(), created_at: "2026-09-07T14:01:34Z" },
    {
      id: 2,
      user: { login: "chatgpt-codex-connector[bot]" },
      body: readFixture("issue-436-comment.txt"),
      created_at: "2026-09-07T14:04:07Z",
    },
  ];
}

test("checkPostAudit: reproduces the live #408/#436 regression — a genuinely completed CLEAN report at PENDING resolves to REPORT_READY_TO_RECORD, not NO_ACTION_YET-shaped OK", async () => {
  const result = await checkPostAudit(
    { repo: "LouPineWays/Loop-Dee-Loup", "audit-issue": 436 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 436 ? { body: issue436AuditBody({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: async (path) => (path.includes("/issues/") ? issue436Thread() : []),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(
    result.state,
    "REPORT_READY_TO_RECORD",
    "the real #436 completed CLEAN report must be mechanically recognized before durable promotion, never described as absent",
  );
  assert.equal(result.workIssue, 407);
  assert.equal(result.rawVerdict, "PENDING");
  assert.equal(result.reportEvidence.verdict, "CLEAN");
});

// -- checkPostAudit: RESPONSE_UNUSABLE (issue #447) -----------------------------------------
// State C: a genuine, provenance-valid bot response has landed post-trigger, but none of the
// genuine bot response(s) on the thread is a completed Stage 2 audit report — distinct from
// state A (no genuine response at all, ordinary NO_ACTION_YET-shaped OK, unchanged) and state B
// (a completed report exists, REPORT_READY_TO_RECORD, unchanged). Must not be reported as
// ordinary waiting, must never accept a structurally complete-looking non-bot report as
// assurance, and must never itself retrigger or mutate anything.

const ISSUE_446_MERGE_COMMIT = "816646bc0183fbd4035b71cde57c9955de52648c";

function issue446AuditBody({ verdict = "PENDING" } = {}) {
  return `### Work issue\n\n#439\n\n### Exact merge commit\n\n\`${ISSUE_446_MERGE_COMMIT}\`\n\n### Verdict\n\n${verdict}\n`;
}

// Real live #446 thread (2026-09-08): the trigger, a detailed structurally-complete-looking
// report posted under non-bot `LouPineWays` provenance (never a candidate at all — only
// bot-authored comments are ever considered), and the actual genuine
// `chatgpt-codex-connector[bot]` reply, which is too terse (no verification-results content) to
// satisfy the completed-report contract.
function issue446Thread() {
  return [
    { id: 1, body: triggerCommentBody(), created_at: "2026-09-08T10:54:09Z" },
    { id: 2, user: { login: "LouPineWays" }, body: readFixture("issue-446-nonbot-report.txt"), created_at: "2026-09-08T10:56:48Z" },
    {
      id: 3,
      user: { login: "chatgpt-codex-connector[bot]" },
      body: readFixture("issue-446-comment.txt"),
      created_at: "2026-09-08T10:57:07Z",
    },
  ];
}

test("checkPostAudit: reproduces live #446 — a genuine terse bot CLEAN reply alongside a detailed non-bot report resolves to RESPONSE_UNUSABLE, never accepting the non-bot report as assurance", async () => {
  const result = await checkPostAudit(
    { repo: "LouPineWays/Loop-Dee-Loup", "audit-issue": 446 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 446 ? { body: issue446AuditBody({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: async (path) => (path.includes("/issues/") ? issue446Thread() : []),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(
    result.state,
    "RESPONSE_UNUSABLE",
    "the real #446 terse genuine bot reply must not be reported as ordinary NO_ACTION_YET-shaped waiting",
  );
  assert.equal(result.workIssue, 439);
  assert.equal(result.rawVerdict, "PENDING");
  assert.equal(result.reportEvidence.backed, false, "the non-bot LouPineWays report must never back a CLEAN closure");
  assert.equal(result.reportEvidence.hasGenuineResponse, true);
  assert.equal(
    result.reportEvidence.hasUnusableGenuineResponse,
    true,
    "the terse CLEAN reply states a verdict and cites the commit — it is substantive, not a bare kickoff, so it still triggers RESPONSE_UNUSABLE",
  );
  assert.equal(result.reportEvidence.genuineResponsesSeen, 1, "the LouPineWays comment is never even a candidate — only the bot reply is");
});

const ISSUE_380_MERGE_COMMIT = "3947b0e03be816a483d8cc7117241f86f13b081c";

function issue380AuditBody({ verdict = "PENDING" } = {}) {
  return `### Work issue\n\n#374\n\n### Exact merge commit\n\n${ISSUE_380_MERGE_COMMIT}\n\n### Verdict\n\n${verdict}\n`;
}

// Real live #380 first round (2026-09-04, before the re-trigger that produced its eventual
// complete round-2 report): same split-provenance shape as #446 — a detailed non-bot report
// followed by a genuine bot reply that is complete-looking (references the merge commit, states
// an explicit verdict) but shows no verification-results content, so it fails the completed-
// report contract's third signal.
function issue380Round1Thread() {
  return [
    { id: 1, body: triggerCommentBody(), created_at: "2026-09-04T14:17:12Z" },
    { id: 2, user: { login: "LouPineWays" }, body: "Stage 2 audit report — detailed non-bot findings.", created_at: "2026-09-04T14:19:20Z" },
    {
      id: 3,
      user: { login: "chatgpt-codex-connector[bot]" },
      body: readFixture("issue-380-round1-comment.txt"),
      created_at: "2026-09-04T14:19:56Z",
    },
  ];
}

test("checkPostAudit: reproduces live #380's first round — the same split-provenance/incomplete-response classification as #446 applies without special-casing issue numbers", async () => {
  const result = await checkPostAudit(
    { repo: "LouPineWays/Loop-Dee-Loup", "audit-issue": 380 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 380 ? { body: issue380AuditBody({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: async (path) => (path.includes("/issues/") ? issue380Round1Thread() : []),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "RESPONSE_UNUSABLE");
  assert.equal(result.workIssue, 374);
  assert.equal(result.reportEvidence.hasGenuineResponse, true);
  assert.equal(result.reportEvidence.hasUnusableGenuineResponse, true);
  assert.equal(result.reportEvidence.backed, false);
});

test("checkPostAudit: the explicit no-work-issue state stays ordinary waiting for a bare #229 kickoff, not RESPONSE_UNUSABLE (issue #447 Stage 1 correction)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async () => ({ body: noWorkIssueAuditBody({ verdict: "PENDING" }), state: "OPEN" }),
      ghApiImpl: withKickoffOnly(),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK");
  assert.equal(result.workIssue, null);
});

test("checkPostAudit: RESPONSE_UNUSABLE — the explicit no-work-issue state also distinguishes a genuine substantive-but-unusable response from true waiting", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async () => ({ body: noWorkIssueAuditBody({ verdict: "PENDING" }), state: "OPEN" }),
      ghApiImpl: withSubstantiveIncomplete(),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "RESPONSE_UNUSABLE");
  assert.equal(result.workIssue, null);
  assert.equal(result.reportEvidence.hasGenuineResponse, true);
  assert.equal(result.reportEvidence.hasUnusableGenuineResponse, true);
});

test("checkPostAudit: a non-genuine-only response (BLOCKED) stays true state-A waiting, never RESPONSE_UNUSABLE", async () => {
  const blockedOnlyThread = () => [
    { id: 1, body: triggerCommentBody(), created_at: "2026-08-20T00:00:00Z" },
    {
      id: 2,
      user: { login: "chatgpt-codex-connector[bot]" },
      body: "BLOCKED — sandboxed environment cannot reach the merge commit.",
      created_at: "2026-08-20T00:00:30Z",
    },
  ];
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: async (path) => (path.includes("/issues/") ? blockedOnlyThread() : []),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK", "a BLOCKED-only reply is not a genuine response, so this remains true waiting (issue #259's retry authority), not RESPONSE_UNUSABLE");
  assert.equal(result.rawVerdict, "PENDING");
});

test("checkPostAudit: idempotent — re-evaluating RESPONSE_UNUSABLE against unchanged durable evidence reports the same state with no mutation performed", async () => {
  const ghApiImpl = withSubstantiveIncomplete();
  const ghIssueViewImpl = async ({ number }) =>
    number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" };
  const first = await checkPostAudit({ repo: "owner/repo", "audit-issue": 160 }, { ghIssueViewImpl, ghApiImpl });
  const second = await checkPostAudit({ repo: "owner/repo", "audit-issue": 160 }, { ghIssueViewImpl, ghApiImpl });
  assert.equal(first.state, "RESPONSE_UNUSABLE");
  assert.equal(second.state, "RESPONSE_UNUSABLE");
  assert.deepEqual(first.reportEvidence, second.reportEvidence, "unchanged durable evidence must resolve to the same result every time");
});

test("checkPostAudit: idempotent — re-evaluating a bare #229 kickoff against unchanged durable evidence stays ordinary waiting every time, no mutation, retrigger, or poll side effect", async () => {
  const ghApiImpl = withKickoffOnly();
  const ghIssueViewImpl = async ({ number }) =>
    number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" };
  const first = await checkPostAudit({ repo: "owner/repo", "audit-issue": 160 }, { ghIssueViewImpl, ghApiImpl });
  const second = await checkPostAudit({ repo: "owner/repo", "audit-issue": 160 }, { ghIssueViewImpl, ghApiImpl });
  assert.equal(first.state, "OK");
  assert.equal(second.state, "OK");
  assert.equal(first.rawVerdict, "PENDING");
  assert.equal(second.rawVerdict, "PENDING");
});

test("checkPostAudit: late recovery — once a genuine complete bot report lands after the unusable one, the very next evaluation reports REPORT_READY_TO_RECORD instead", async () => {
  const withLateCompleteReport = async (path) => {
    if (!path.includes("/issues/")) return [];
    const [trigger, kickoffResponse] = kickoffOnlyThread();
    const [, completeResponse] = completedAuditThread({ responseTime: "2026-08-20T00:10:00Z", commit: MERGE_COMMIT });
    return [trigger, kickoffResponse, { ...completeResponse, id: 3 }];
  };
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withLateCompleteReport,
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(
    result.state,
    "REPORT_READY_TO_RECORD",
    "recovery from RESPONSE_UNUSABLE resumes automatically once a genuine complete report lands, with no special-cased recovery transition",
  );
  assert.equal(result.reportEvidence.verdict, "CLEAN");
});

// -- recoverPrematureClosure ---------------------------------------------------------------

test("recoverPrematureClosure: reopens the work issue and records why", async () => {
  const reopenCalls = [];
  const commentCalls = [];
  const result = await recoverPrematureClosure(
    { repo: "owner/repo", workIssue: 151, auditIssue: 160 },
    {
      ghReopenImpl: async (args) => reopenCalls.push(args),
      ghCommentImpl: async (args) => commentCalls.push(args),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.recovered, true);
  assert.equal(result.commentPosted, true);
  assert.equal(reopenCalls.length, 1);
  assert.equal(commentCalls.length, 1);
});

test("recoverPrematureClosure: reports a BLOCKED handoff instead of silently accepting the premature closure when reopen fails", async () => {
  const result = await recoverPrematureClosure(
    { repo: "owner/repo", workIssue: 151, auditIssue: 160 },
    {
      ghReopenImpl: async () => {
        throw new Error("insufficient permission");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.recovered, false);
  assert.match(result.message, /BLOCKED/);
  assert.match(result.message, /founder reopens/);
});

test("recoverPrematureClosure: a reopen that succeeds but a comment that fails still reports the issue as recovered (Stage 1 review finding on PR #186)", async () => {
  const result = await recoverPrematureClosure(
    { repo: "owner/repo", workIssue: 151, auditIssue: 160 },
    {
      ghReopenImpl: async () => {},
      ghCommentImpl: async () => {
        throw new Error("transient network error");
      },
    },
  );
  assert.equal(result.exitCode, 0, "the issue is genuinely open again; this must not be reported as a blocked failure");
  assert.equal(result.recovered, true);
  assert.equal(result.commentPosted, false);
  assert.match(result.message, /could not post the durable explanation comment/);
});

// -- parseArgs -------------------------------------------------------------------------

test("parseArgs: reads flags including a hyphenated flag name", () => {
  const args = parseArgs(["--repo", "owner/repo", "--audit-issue", "160", "--recover", "true"]);
  assert.equal(args.repo, "owner/repo");
  assert.equal(args["audit-issue"], "160");
  assert.equal(args.recover, "true");
});

// -- replaceVerdictField (issue #439) ----------------------------------------------------

test("replaceVerdictField: replaces the first non-blank line under the LAST matching '### Verdict' heading, the same anchor parseFormField reads", () => {
  const body = "### Work issue\n\n#151\n\n### Verdict\n\nPENDING\n\n### Next authorized action\n\nPending audit.\n";
  const updated = replaceVerdictField(body, "CLEAN");
  assert.equal(parseStage2Verdict(updated), "CLEAN");
  assert.match(updated, /### Work issue\n\n#151/, "every other field must be preserved verbatim");
  assert.match(updated, /### Next authorized action\n\nPending audit\./);
});

test("replaceVerdictField: anchors to the LAST heading, not an earlier quoted example (mirrors parseFormField's own anchor)", () => {
  const body = ["### Findings", "", "### Verdict", "", "CLEAN", "", "### Verdict", "", "PENDING"].join("\n");
  const updated = replaceVerdictField(body, "NOT CLEAN");
  assert.equal(parseStage2Verdict(updated), "NOT CLEAN");
});

// Stage 1 review finding on this PR: an earlier revision returned null for both cases below,
// which made record-verdict exit 1 on a REPORT_READY_TO_RECORD state it could never fulfill,
// permanently blocking a genuinely completed audit. Both must now deterministically repair the
// field instead of failing closed.

test("replaceVerdictField: repairs a missing '### Verdict' heading by appending a fresh section, preserving every existing section verbatim", () => {
  const body = "### Work issue\n\n#151\n\n### Exact merge commit\n\nabc123\n";
  const updated = replaceVerdictField(body, "CLEAN");
  assert.notEqual(updated, null, "a missing heading must be repaired, not failed closed");
  assert.equal(parseStage2Verdict(updated), "CLEAN", "must round-trip through the same parser record-verdict itself uses");
  assert.match(updated, /### Work issue\n\n#151/, "every existing section must be preserved verbatim");
  assert.match(updated, /### Exact merge commit\n\nabc123/, "every existing section must be preserved verbatim");
});

test("replaceVerdictField: repairs a missing '### Verdict' heading against an empty body", () => {
  const updated = replaceVerdictField("", "NOT CLEAN");
  assert.notEqual(updated, null);
  assert.equal(parseStage2Verdict(updated), "NOT CLEAN");
});

test("replaceVerdictField: repairs an empty '### Verdict' field (heading present, no non-blank value line before the next heading) by inserting the value, preserving neighboring sections", () => {
  const body = "### Work issue\n\n#151\n\n### Verdict\n\n### Next authorized action\n\nPending audit.\n";
  const updated = replaceVerdictField(body, "CLEAN");
  assert.notEqual(updated, null, "an empty rendered field must be repaired, not failed closed");
  assert.equal(parseStage2Verdict(updated), "CLEAN");
  assert.match(updated, /### Work issue\n\n#151/, "every other field must be preserved verbatim");
  assert.match(updated, /### Next authorized action\n\nPending audit\./, "every other field must be preserved verbatim");
});

test("replaceVerdictField: repairs an empty '### Verdict' field at the very end of the body (heading present, nothing but blank lines follow)", () => {
  const updated = replaceVerdictField("### Findings\n\nPending\n\n### Verdict\n\n", "NOT CLEAN");
  assert.notEqual(updated, null);
  assert.equal(parseStage2Verdict(updated), "NOT CLEAN");
  assert.match(updated, /### Findings\n\nPending/, "the neighboring section must be preserved verbatim");
});

// Stage 2 audit finding on issue #480: the missing-heading repair previously stripped trailing
// whitespace from the existing body (`src.replace(/\s+$/, "")`) before appending the new section,
// mutating pre-existing content instead of preserving it byte-for-byte. These pin the exact
// pre-existing bytes — including trailing whitespace the audit requirement says must survive.

test("replaceVerdictField: repairing a missing heading preserves the existing body byte-for-byte, including trailing whitespace", () => {
  const bodyWithTrailingWhitespace = "### Work issue\n\n#151\n\n### Exact merge commit\n\nabc123\n\n   \n";
  const updated = replaceVerdictField(bodyWithTrailingWhitespace, "CLEAN");
  assert.notEqual(updated, null);
  assert.ok(
    updated.startsWith(bodyWithTrailingWhitespace),
    "the pre-existing body, trailing whitespace included, must be preserved byte-for-byte, not trimmed before appending",
  );
  assert.equal(parseStage2Verdict(updated), "CLEAN");
});

test("replaceVerdictField: repairing a missing heading against a body with no trailing newline still preserves it exactly and appends a blank-line separator", () => {
  const bodyNoTrailingNewline = "### Exact merge commit\n\nabc123";
  const updated = replaceVerdictField(bodyNoTrailingNewline, "NOT CLEAN");
  assert.equal(updated, "### Exact merge commit\n\nabc123\n\n### Verdict\n\nNOT CLEAN\n");
  assert.equal(parseStage2Verdict(updated), "NOT CLEAN");
});

// -- checkRecordVerdict (issue #439) ------------------------------------------------------
// The deterministic, idempotent, fail-closed-on-conflict promotion command
// REPORT_READY_TO_RECORD authorizes. Reuses checkPostAudit internally for evidence, then
// re-reads the audit issue fresh immediately before mutating it.

test("checkRecordVerdict: exits 1 when required args are missing", async () => {
  const result = await checkRecordVerdict({});
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /Missing required args/);
});

test("checkRecordVerdict: RECORDED — promotes a completed CLEAN report over a PENDING dropdown, posting one explanatory comment", async () => {
  const auditBodyPending = auditBodyWithCommit({ verdict: "PENDING" });
  const editCalls = [];
  const commentCalls = [];
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyPending, state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withCompletedAuditReport({ verdict: "CLEAN" }),
      ghEditImpl: async (a) => editCalls.push(a),
      ghCommentImpl: async (a) => commentCalls.push(a),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "RECORDED");
  assert.equal(result.verdict, "CLEAN");
  assert.equal(editCalls.length, 1);
  assert.equal(editCalls[0].repo, "owner/repo");
  assert.equal(editCalls[0].auditIssue, 160);
  assert.equal(parseStage2Verdict(editCalls[0].body), "CLEAN", "the mutated body must carry the promoted verdict where the parser itself reads it");
  assert.equal(commentCalls.length, 1);
  assert.match(commentCalls[0].verdict, /CLEAN/);
  assert.equal(result.commentPosted, true);
});

test("checkRecordVerdict: RECORDED — promotes a completed NOT CLEAN report over a PENDING dropdown", async () => {
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withCompletedAuditReport({ verdict: "NOT CLEAN" }),
      ghEditImpl: async () => {},
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "RECORDED");
  assert.equal(result.verdict, "NOT CLEAN");
});

// Stage 1 review finding on this PR: a completed report whose audit issue has no '### Verdict'
// heading at all, or has the heading with no value, previously made record-verdict exit 1 (via
// replaceVerdictField returning null) even though checkPostAudit had just reported
// REPORT_READY_TO_RECORD for exactly this body — permanently blocking a genuinely completed
// audit. Both must now promote successfully.

test("checkRecordVerdict: RECORDED — repairs a completely missing '### Verdict' heading rather than exiting 1", async () => {
  const bodyMissingVerdict = `### Work issue\n\n#151\n\n### Exact merge commit\n\n${MERGE_COMMIT}\n`;
  const editCalls = [];
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: bodyMissingVerdict, state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withCompletedAuditReport({ verdict: "CLEAN" }),
      ghEditImpl: async (a) => editCalls.push(a),
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "RECORDED");
  assert.equal(result.verdict, "CLEAN");
  assert.equal(editCalls.length, 1);
  assert.equal(parseStage2Verdict(editCalls[0].body), "CLEAN", "the repaired body must round-trip through the same parser");
  assert.equal(parseWorkIssueRef(editCalls[0].body), 151, "the pre-existing Work issue field must be preserved");
});

test("checkRecordVerdict: RECORDED — repairs an empty '### Verdict' field (heading present, no value) rather than exiting 1", async () => {
  const bodyEmptyVerdict =
    `### Work issue\n\n#151\n\n### Exact merge commit\n\n${MERGE_COMMIT}\n\n### Verdict\n\n### Next authorized action\n\nPending audit.\n`;
  const editCalls = [];
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: bodyEmptyVerdict, state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withCompletedAuditReport({ verdict: "NOT CLEAN" }),
      ghEditImpl: async (a) => editCalls.push(a),
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "RECORDED");
  assert.equal(result.verdict, "NOT CLEAN");
  assert.equal(editCalls.length, 1);
  assert.equal(parseStage2Verdict(editCalls[0].body), "NOT CLEAN");
  assert.match(editCalls[0].body, /### Next authorized action\n\nPending audit\./, "the neighboring field must be preserved");
});

test("checkRecordVerdict: no completed report exists yet — passes checkPostAudit's own OK result through unchanged, no mutation attempted", async () => {
  const editCalls = [];
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: async () => [],
      ghEditImpl: async (a) => editCalls.push(a),
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK", "checkPostAudit's own vocabulary is passed through verbatim rather than an invented state");
  assert.equal(editCalls.length, 0);
});

test("checkRecordVerdict: idempotent rerun after a prior RECORDED — reaches the existing post-audit transition (READY_TO_CLOSE) without a duplicate mutation (verification #6)", async () => {
  const editCalls = [];
  const commentCalls = [];
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      // The durable field is already the settled, evidence-backed CLEAN — as it would be
      // immediately after a prior successful RECORDED run.
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withCompletedAuditReport({ verdict: "CLEAN" }),
      ghEditImpl: async (a) => editCalls.push(a),
      ghCommentImpl: async (a) => commentCalls.push(a),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "READY_TO_CLOSE", "a settled, evidence-backed verdict reaches checkPostAudit's own existing path exactly as if set by hand");
  assert.equal(editCalls.length, 0, "never a duplicate mutation");
  assert.equal(commentCalls.length, 0, "never a duplicate comment");
});

test("checkRecordVerdict: ALREADY_RECORDED — the fresh re-read immediately before mutating already shows the evidence-backed verdict recorded (closes the race window)", async () => {
  let issueViewCalls = 0;
  const editCalls = [];
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) => {
        if (number !== 160) return { body: "", state: "OPEN" };
        issueViewCalls++;
        // First read (inside checkPostAudit) sees PENDING; the second, fresh re-read
        // (immediately before mutating) sees CLEAN already recorded — simulating a
        // concurrent recording between the two reads.
        return { body: auditBodyWithCommit({ verdict: issueViewCalls === 1 ? "PENDING" : "CLEAN" }), state: "OPEN" };
      },
      ghApiImpl: withCompletedAuditReport({ verdict: "CLEAN" }),
      ghEditImpl: async (a) => editCalls.push(a),
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "ALREADY_RECORDED");
  assert.equal(result.verdict, "CLEAN");
  assert.equal(editCalls.length, 0, "an already-matching durable field must never be re-mutated");
});

test("checkRecordVerdict: CONFLICTING_VERDICT — the fresh re-read shows a different, already-settled verdict than the evidence found; fails closed, never overwritten (verification #7)", async () => {
  let issueViewCalls = 0;
  const editCalls = [];
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) => {
        if (number !== 160) return { body: "", state: "OPEN" };
        issueViewCalls++;
        // First read sees PENDING (so checkPostAudit finds CLEAN evidence and reports
        // REPORT_READY_TO_RECORD); the fresh re-read sees NOT CLEAN already recorded by some
        // other means — a genuine conflict that must never be silently overwritten.
        return { body: auditBodyWithCommit({ verdict: issueViewCalls === 1 ? "PENDING" : "NOT CLEAN" }), state: "OPEN" };
      },
      ghApiImpl: withCompletedAuditReport({ verdict: "CLEAN" }),
      ghEditImpl: async (a) => editCalls.push(a),
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CONFLICTING_VERDICT");
  assert.equal(result.recordedVerdict, "NOT CLEAN");
  assert.equal(result.evidenceVerdict, "CLEAN");
  assert.equal(editCalls.length, 0, "a conflicting already-recorded verdict must never be silently overwritten");
  assert.match(result.message, /never silently overwritten/);
});

// Stage 2 audit finding on issue #480: the single fresh re-read above (used both for the
// ALREADY_RECORDED/CONFLICTING_VERDICT check and as the evidence-revalidation input) is itself
// captured *before* the findStage2ReportEvidence network round trip. A concurrent invocation
// recording a settled verdict during that round trip — after the fresh read, before the edit —
// was not caught by that single check. These pin the fix: a *second*, final re-read taken
// immediately before the edit, re-running the same checks against it.

test("checkRecordVerdict: ALREADY_RECORDED — a concurrent recording lands during the evidence-revalidation call itself, after the first fresh re-read; the final re-read immediately before editing catches it", async () => {
  let issueViewCalls = 0;
  const editCalls = [];
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) => {
        if (number !== 160) return { body: "", state: "OPEN" };
        issueViewCalls++;
        // Calls 1 (inside checkPostAudit) and 2 (the fresh re-read before evidence
        // revalidation) both still see PENDING — a naive single-recheck design would pass both
        // and proceed straight to the edit. Only call 3, the final re-read taken *after* the
        // evidence-revalidation network call and immediately before the edit, sees the verdict a
        // concurrent invocation recorded while that network call was in flight.
        return { body: auditBodyWithCommit({ verdict: issueViewCalls <= 2 ? "PENDING" : "CLEAN" }), state: "OPEN" };
      },
      ghApiImpl: withCompletedAuditReport({ verdict: "CLEAN" }),
      ghEditImpl: async (a) => editCalls.push(a),
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "ALREADY_RECORDED");
  assert.equal(result.verdict, "CLEAN");
  assert.equal(
    editCalls.length,
    0,
    "a verdict recorded during the evidence-revalidation call must never be overwritten by a stale-read edit",
  );
});

test("checkRecordVerdict: CONFLICTING_VERDICT — a concurrent conflicting recording lands during the evidence-revalidation call; the final re-read immediately before editing catches it", async () => {
  let issueViewCalls = 0;
  const editCalls = [];
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) => {
        if (number !== 160) return { body: "", state: "OPEN" };
        issueViewCalls++;
        // Calls 1 and 2 both see PENDING; only the final re-read (call 3), taken after the
        // evidence-revalidation network call, sees NOT CLEAN recorded by a concurrent invocation
        // while that call was in flight — a genuine conflict against this invocation's own CLEAN
        // evidence that must never be silently overwritten.
        return { body: auditBodyWithCommit({ verdict: issueViewCalls <= 2 ? "PENDING" : "NOT CLEAN" }), state: "OPEN" };
      },
      ghApiImpl: withCompletedAuditReport({ verdict: "CLEAN" }),
      ghEditImpl: async (a) => editCalls.push(a),
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CONFLICTING_VERDICT");
  assert.equal(result.recordedVerdict, "NOT CLEAN");
  assert.equal(result.evidenceVerdict, "CLEAN");
  assert.equal(editCalls.length, 0, "a conflicting concurrent recording must never be silently overwritten");
});

// Stage 1 review finding on PR #491: reparsing only the verdict from the final pre-edit read is
// not enough — a concurrent edit could change the evidence-bearing context (Exact merge commit /
// Verification checklist) while leaving Verdict PENDING throughout, so freshReportEvidence would
// still be validated against a context the final body no longer carries. This must fail closed
// rather than record a verdict against a contract this invocation never actually revalidated.

test("checkRecordVerdict: fails closed when the evidence-bearing 'Exact merge commit' context changes between evidence revalidation and the final pre-edit read, even though Verdict stays PENDING throughout", async () => {
  const OTHER_COMMIT = "d281dbd5e7590b8ac2992753cd875f5e6472d999";
  let issueViewCalls = 0;
  const editCalls = [];
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) => {
        if (number !== 160) return { body: "", state: "OPEN" };
        issueViewCalls++;
        // Calls 1 (inside checkPostAudit) and 2 (the read used to revalidate report evidence)
        // both see the original merge commit with Verdict still PENDING; only the final pre-edit
        // read (call 3) sees a concurrently-edited 'Exact merge commit' field — Verdict itself
        // never changes, so a verdict-only recheck would miss this entirely.
        return {
          body: auditBodyWithCommit({ verdict: "PENDING", commit: issueViewCalls <= 2 ? MERGE_COMMIT : OTHER_COMMIT }),
          state: "OPEN",
        };
      },
      ghApiImpl: withCompletedAuditReport({ verdict: "CLEAN" }),
      ghEditImpl: async (a) => editCalls.push(a),
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /evidence-bearing context/);
  assert.match(result.message, /Re-run record-verdict/);
  assert.equal(editCalls.length, 0, "a verdict validated against a since-changed context must never be recorded");
});

// Stage 1 review finding on this PR: the fresh issue-body re-read alone does not close the race
// Codex identified, because postAudit.reportEvidence can already be stale by the time the
// mutation step runs — a newer completed report may land on the thread in between. These tests
// mock checkPostAuditImpl directly to hand back exactly that stale evidence, so the only way
// each test can pass is if checkRecordVerdict re-evaluates findStage2ReportEvidence itself
// against the fresh body (via the real, un-mocked ghApiImpl) rather than trusting the evidence
// checkPostAudit already computed a moment earlier.

test("checkRecordVerdict: revalidates report evidence before writing — a newer completed report with the opposite verdict lands between the evidence check and the mutation, and the newer one is recorded, not the stale one", async () => {
  const editCalls = [];
  const commentCalls = [];
  const staleReportEvidence = {
    backed: true,
    verdict: "NOT CLEAN",
    responsesSeen: 1,
    matchedCommentUrl: "https://github.com/owner/repo/issues/160#issuecomment-1",
    legacyCompatible: false,
  };
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      // Mocked to hand back exactly the stale evidence checkPostAudit would have computed a
      // moment before a newer completed report landed on the thread.
      checkPostAuditImpl: async () => ({
        exitCode: 0,
        state: "REPORT_READY_TO_RECORD",
        workIssue: 151,
        auditIssue: 160,
        rawVerdict: "PENDING",
        reportEvidence: staleReportEvidence,
      }),
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      // The revalidation step's own findStage2ReportEvidence call — the real, un-mocked
      // ghApiImpl — sees a newer completed report with the opposite verdict (CLEAN), the
      // authoritative one per findStage2ReportEvidence's own "latest complete response wins"
      // contract.
      ghApiImpl: withCompletedAuditReport({ verdict: "CLEAN" }),
      ghEditImpl: async (a) => editCalls.push(a),
      ghCommentImpl: async (a) => commentCalls.push(a),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "RECORDED");
  assert.equal(
    result.verdict,
    "CLEAN",
    "the newer, authoritative report's verdict must be recorded, never the stale one checkPostAudit computed a moment earlier",
  );
  assert.equal(editCalls.length, 1);
  assert.equal(parseStage2Verdict(editCalls[0].body), "CLEAN");
  assert.equal(commentCalls.length, 1);
  assert.match(commentCalls[0].verdict, /CLEAN/);
});

test("checkRecordVerdict: CONFLICTING_VERDICT compares against the freshly-revalidated authoritative report, not checkPostAudit's stale evidence", async () => {
  const editCalls = [];
  const staleReportEvidence = {
    backed: true,
    verdict: "NOT CLEAN",
    responsesSeen: 1,
    matchedCommentUrl: "https://github.com/owner/repo/issues/160#issuecomment-1",
    legacyCompatible: false,
  };
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      checkPostAuditImpl: async () => ({
        exitCode: 0,
        state: "REPORT_READY_TO_RECORD",
        workIssue: 151,
        auditIssue: 160,
        rawVerdict: "PENDING",
        reportEvidence: staleReportEvidence,
      }),
      // The fresh re-read shows NOT CLEAN already recorded (e.g. by a concurrent invocation
      // that itself recorded the once-current stale evidence) — a genuine conflict against the
      // newer, authoritative CLEAN report the revalidation step below finds.
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "NOT CLEAN" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withCompletedAuditReport({ verdict: "CLEAN" }),
      ghEditImpl: async (a) => editCalls.push(a),
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "CONFLICTING_VERDICT");
  assert.equal(result.recordedVerdict, "NOT CLEAN");
  assert.equal(
    result.evidenceVerdict,
    "CLEAN",
    "must compare against the freshly-revalidated report, not the stale evidence checkPostAudit computed a moment earlier",
  );
  assert.equal(editCalls.length, 0);
});

test("checkRecordVerdict: fails closed as an operational error when revalidation no longer finds any completed report backing a verdict", async () => {
  const editCalls = [];
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      checkPostAuditImpl: async () => ({
        exitCode: 0,
        state: "REPORT_READY_TO_RECORD",
        workIssue: 151,
        auditIssue: 160,
        rawVerdict: "PENDING",
        reportEvidence: { backed: true, verdict: "CLEAN", responsesSeen: 1, matchedCommentUrl: "https://x", legacyCompatible: false },
      }),
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      // Revalidation finds nothing backing any verdict on the thread.
      ghApiImpl: async () => [],
      ghEditImpl: async (a) => editCalls.push(a),
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /Revalidation found no completed Stage 2 report/);
  assert.equal(editCalls.length, 0);
});

test("checkRecordVerdict: a gh issue edit failure is a plain operational error, not a fabricated RECORDED", async () => {
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withCompletedAuditReport({ verdict: "CLEAN" }),
      ghEditImpl: async () => {
        throw new Error("insufficient permission");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh issue edit failed/);
});

test("checkRecordVerdict: a comment-post failure after a successful edit still reports RECORDED, naming the comment error", async () => {
  const result = await checkRecordVerdict(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBodyWithCommit({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withCompletedAuditReport({ verdict: "CLEAN" }),
      ghEditImpl: async () => {},
      ghCommentImpl: async () => {
        throw new Error("transient network error");
      },
    },
  );
  assert.equal(result.exitCode, 0, "the field is genuinely recorded; this must not be reported as a blocked failure");
  assert.equal(result.state, "RECORDED");
  assert.equal(result.commentPosted, false);
  assert.match(result.message, /could not post the durable explanation comment/);
});

// -- checkRecordVerdict: reproduces the live #436 evidence end to end -----------------------

test("checkRecordVerdict: promotes the real #436 completed CLEAN report over its actual pre-promotion PENDING state", async () => {
  const editCalls = [];
  const result = await checkRecordVerdict(
    { repo: "LouPineWays/Loop-Dee-Loup", "audit-issue": 436 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 436 ? { body: issue436AuditBody({ verdict: "PENDING" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: async (path) => (path.includes("/issues/") ? issue436Thread() : []),
      ghEditImpl: async (a) => editCalls.push(a),
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "RECORDED");
  assert.equal(result.verdict, "CLEAN");
  assert.equal(editCalls.length, 1);
  assert.equal(parseStage2Verdict(editCalls[0].body), "CLEAN");
  assert.equal(parseWorkIssueRef(editCalls[0].body), 407, "every other field, including Work issue, must survive the mutation unchanged");
});

// -- checkCloseAudit (issue #407) --------------------------------------------------------
// Deterministic, idempotent audit-issue terminalization predicate and close-out command,
// correcting #380/#384 (a CLEAN, fully-consumed audit could still sit open indefinitely,
// since post-audit above only ever closes the *work* issue) and the #396->#406
// correction-chain gap (a superseded NOT CLEAN predecessor had no mechanical route to
// terminal state even once its successor reached CLEAN). Six fixture-driven regression
// classes, per 407-A's own Worker Unit Contract: open-CLEAN/open-work, open-CLEAN/closed-work,
// correction-chain supersession, active-PENDING negative control, invalid/incomplete-report
// negative control, and idempotent rerun on an already-closed audit.

function closeAuditBody({ workIssue = "#306", commit = MERGE_COMMIT, verdict = "PENDING", checklist = "1. Confirm A.\n2. Confirm B." }) {
  return (
    `### Work issue\n\n${workIssue}\n\n### Exact merge commit\n\n${commit}\n\n` +
    `### Verification checklist\n\n${checklist}\n\n### Verdict\n\n${verdict}\n`
  );
}

// A ghApiImpl that dispatches a distinct completed/incomplete thread per audit-issue number —
// findStage2ReportEvidence's endpoint path is `repos/<repo>/issues/<auditIssue>/comments`, so
// this is what lets a multi-issue correction-chain fixture give each audit issue its own
// evidence independently.
function ghApiForThreads(threadsByAuditIssue) {
  return async (path) => {
    for (const [number, thread] of Object.entries(threadsByAuditIssue)) {
      if (path.includes(`/issues/${number}/comments`)) return thread;
    }
    return [];
  };
}

// -- Class 1/2: this audit's own verdict is backed CLEAN, closed regardless of the (never even
// fetched) gated work issue's state — the #380/#384 fix itself.

test("checkCloseAudit: CLOSE_READY (dry-run) / CLOSED (real run) — backed CLEAN, work issue field names a presumed-open issue", async () => {
  let issueViewCalls = 0;
  const ghIssueViewImpl = async ({ number }) => {
    issueViewCalls++;
    assert.equal(number, 160, "checkCloseAudit must never fetch the gated work issue at all — only the audit issue itself");
    return { body: closeAuditBody({ workIssue: "#151", verdict: "CLEAN" }), state: "OPEN", createdAt: "2026-09-05T00:00:00Z" };
  };
  const ghApiImpl = withCompletedAuditReport();

  const dryRunResult = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 160, "dry-run": "true" },
    { ghIssueViewImpl, ghApiImpl },
  );
  assert.equal(dryRunResult.exitCode, 0);
  assert.equal(dryRunResult.state, "CLOSE_READY");
  assert.equal(dryRunResult.auditIssue, 160);

  const closeCalls = [];
  const commentCalls = [];
  const realResult = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl,
      ghApiImpl,
      ghCloseImpl: async (a) => closeCalls.push(a),
      ghCommentImpl: async (a) => commentCalls.push(a),
    },
  );
  assert.equal(realResult.exitCode, 0);
  assert.equal(realResult.state, "CLOSED");
  assert.equal(realResult.commentPosted, true);
  assert.equal(closeCalls.length, 1);
  assert.deepEqual(closeCalls[0], { repo: "owner/repo", auditIssue: 160 });
  assert.equal(commentCalls.length, 1);
  assert.match(commentCalls[0].body, /backed CLEAN/);
  assert.equal(issueViewCalls, 2, "one gh issue view per checkCloseAudit call — never a second one for the work issue");
});

test("checkCloseAudit: CLOSE_READY (dry-run) / CLOSED (real run) — backed CLEAN, work issue field names a presumed-closed issue (the exact #380/#384 shape: identical outcome either way, since work-issue state is never consulted)", async () => {
  const ghIssueViewImpl = async () => ({
    body: closeAuditBody({ workIssue: "#999", verdict: "CLEAN" }),
    state: "OPEN",
    createdAt: "2026-09-05T00:00:00Z",
  });
  const ghApiImpl = withCompletedAuditReport();

  const dryRunResult = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 161, "dry-run": "true" },
    { ghIssueViewImpl, ghApiImpl },
  );
  assert.equal(dryRunResult.state, "CLOSE_READY");

  const closeCalls = [];
  const realResult = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 161 },
    { ghIssueViewImpl, ghApiImpl, ghCloseImpl: async (a) => closeCalls.push(a), ghCommentImpl: async () => {} },
  );
  assert.equal(realResult.state, "CLOSED");
  assert.equal(closeCalls.length, 1, "closes identically regardless of the (unfetched) work issue's presumed open/closed state");
});

// -- Class 3: correction-chain supersession (#396->#406) ---------------------------------

function chainAuditFixture({ workIssue, commit = MERGE_COMMIT, verdict, createdAt }) {
  return { body: closeAuditBody({ workIssue, commit, verdict }), state: "OPEN", createdAt };
}

test("checkCloseAudit: SUPERSEDED_CLOSE_READY (dry-run) / SUPERSEDED_CLOSED (real run) — a NOT CLEAN predecessor is superseded by a distinct, later CLOSE_READY successor naming the same work issue, across a 5-issue correction chain shaped like #396->#400->#402->#404->#406", async () => {
  const workIssue = "#306";
  const chain = {
    396: chainAuditFixture({ workIssue, verdict: "NOT CLEAN", createdAt: "2026-09-05T09:59:55Z" }),
    400: chainAuditFixture({ workIssue, verdict: "NOT CLEAN", createdAt: "2026-09-05T11:00:00Z" }),
    402: chainAuditFixture({ workIssue, verdict: "NOT CLEAN", createdAt: "2026-09-05T12:00:00Z" }),
    404: chainAuditFixture({ workIssue, verdict: "NOT CLEAN", createdAt: "2026-09-05T13:00:00Z" }),
    406: chainAuditFixture({ workIssue, verdict: "CLEAN", createdAt: "2026-09-05T14:00:00Z" }),
  };
  const ghIssueViewImpl = async ({ number }) => chain[number];
  const ghIssueListImpl = async () => Object.entries(chain).map(([number, data]) => ({ number: Number(number), ...data }));
  const ghApiImpl = ghApiForThreads({ 406: completedAuditThread({ verdict: "CLEAN" }) });

  const dryRunResult = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 396, "dry-run": "true" },
    { ghIssueViewImpl, ghIssueListImpl, ghApiImpl },
  );
  assert.equal(dryRunResult.exitCode, 0);
  assert.equal(dryRunResult.state, "SUPERSEDED_CLOSE_READY");
  assert.equal(dryRunResult.supersededBy, 406);

  const closeCalls = [];
  const commentCalls = [];
  const realResult = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 396 },
    {
      ghIssueViewImpl,
      ghIssueListImpl,
      ghApiImpl,
      ghCloseImpl: async (a) => closeCalls.push(a),
      ghCommentImpl: async (a) => commentCalls.push(a),
    },
  );
  assert.equal(realResult.exitCode, 0);
  assert.equal(realResult.state, "SUPERSEDED_CLOSED");
  assert.equal(closeCalls.length, 1);
  assert.deepEqual(closeCalls[0], { repo: "owner/repo", auditIssue: 396 });
  assert.equal(commentCalls.length, 1);
  assert.match(commentCalls[0].body, /#406/);
  assert.match(commentCalls[0].body, /CLOSE_READY\/CLOSED/);
});

test("checkCloseAudit: a later CLOSE_READY audit naming a DIFFERENT work issue never supersedes (fail-closed supersession evidence rule)", async () => {
  const chain = {
    500: chainAuditFixture({ workIssue: "#306", verdict: "NOT CLEAN", createdAt: "2026-09-05T09:00:00Z" }),
    501: chainAuditFixture({ workIssue: "#999", verdict: "CLEAN", createdAt: "2026-09-05T10:00:00Z" }),
  };
  const ghIssueViewImpl = async ({ number }) => chain[number];
  const ghIssueListImpl = async () => Object.entries(chain).map(([number, data]) => ({ number: Number(number), ...data }));
  const ghApiImpl = ghApiForThreads({ 501: completedAuditThread({ verdict: "CLEAN" }) });

  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 500, "dry-run": "true" },
    { ghIssueViewImpl, ghIssueListImpl, ghApiImpl },
  );
  assert.equal(result.state, "NOT_TERMINAL_YET", "a CLOSE_READY audit for an unrelated work issue must never supersede this one");
});

test("checkCloseAudit: an earlier (not later-created) CLOSE_READY audit naming the same work issue never supersedes (createdAt comparison, not issue-number order)", async () => {
  const chain = {
    600: chainAuditFixture({ workIssue: "#306", verdict: "CLEAN", createdAt: "2026-09-01T00:00:00Z" }), // earlier, backed CLEAN
    601: chainAuditFixture({ workIssue: "#306", verdict: "NOT CLEAN", createdAt: "2026-09-05T00:00:00Z" }), // the audit under test
  };
  const ghIssueViewImpl = async ({ number }) => chain[number];
  const ghIssueListImpl = async () => Object.entries(chain).map(([number, data]) => ({ number: Number(number), ...data }));
  const ghApiImpl = ghApiForThreads({ 600: completedAuditThread({ verdict: "CLEAN" }) });

  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 601, "dry-run": "true" },
    { ghIssueViewImpl, ghIssueListImpl, ghApiImpl },
  );
  assert.equal(result.state, "NOT_TERMINAL_YET", "an earlier CLOSE_READY audit is not a later successor and must never supersede");
});

// -- Class 4: active-PENDING negative control ---------------------------------------------

test("checkCloseAudit: NOT_TERMINAL_YET — active PENDING verdict, no successor exists (negative control)", async () => {
  const ghIssueViewImpl = async () => ({
    body: closeAuditBody({ workIssue: "#306", verdict: "PENDING" }),
    state: "OPEN",
    createdAt: "2026-09-05T09:00:00Z",
  });
  const ghIssueListImpl = async () => [];
  const result = await checkCloseAudit({ repo: "owner/repo", "audit-issue": 160 }, { ghIssueViewImpl, ghIssueListImpl });
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "NOT_TERMINAL_YET");
  assert.equal(result.rawVerdict, "PENDING");
});

// -- Class 5: invalid/incomplete-report negative control -----------------------------------

test("checkCloseAudit: NOT_TERMINAL_YET — CLEAN dropdown unbacked by a completed Stage 2 report (the #229 kickoff shape), no successor exists (negative control)", async () => {
  const ghIssueViewImpl = async () => ({
    body: closeAuditBody({ workIssue: "#306", verdict: "CLEAN" }),
    state: "OPEN",
    createdAt: "2026-09-05T09:00:00Z",
  });
  const ghApiImpl = withKickoffOnly();
  const ghIssueListImpl = async () => [];
  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    { ghIssueViewImpl, ghApiImpl, ghIssueListImpl },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "NOT_TERMINAL_YET");
  assert.equal(result.rawVerdict, "CLEAN");
});

// -- Class 6: idempotent rerun on an already-closed audit -----------------------------------

test("checkCloseAudit: ALREADY_TERMINAL — a safe no-op on an already-closed audit issue, even without --dry-run (idempotent rerun, no mutation attempted)", async () => {
  let apiCalls = 0;
  let listCalls = 0;
  let closeCalls = 0;
  let commentCalls = 0;
  const ghIssueViewImpl = async () => ({
    body: closeAuditBody({ workIssue: "#306", verdict: "CLEAN" }),
    state: "CLOSED",
    createdAt: "2026-09-05T09:00:00Z",
  });
  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl,
      ghApiImpl: async () => {
        apiCalls++;
        return [];
      },
      ghIssueListImpl: async () => {
        listCalls++;
        return [];
      },
      ghCloseImpl: async () => {
        closeCalls++;
      },
      ghCommentImpl: async () => {
        commentCalls++;
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "ALREADY_TERMINAL");
  assert.equal(result.auditIssue, 160);
  assert.equal(apiCalls, 0, "no evidence evaluation is needed for an already-terminal audit");
  assert.equal(listCalls, 0, "no supersession search is needed for an already-terminal audit");
  assert.equal(closeCalls, 0, "must never attempt to close an already-closed issue");
  assert.equal(commentCalls, 0, "must never post a duplicate explanatory comment");
});

test("checkCloseAudit: ALREADY_TERMINAL is reported identically with --dry-run true (no mutation impls are even reachable)", async () => {
  const ghIssueViewImpl = async () => ({ body: closeAuditBody({ verdict: "CLEAN" }), state: "CLOSED", createdAt: "2026-09-05T09:00:00Z" });
  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 160, "dry-run": "true" },
    { ghIssueViewImpl },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "ALREADY_TERMINAL");
});

// -- Operational errors --------------------------------------------------------------------

test("checkCloseAudit: exits 1 when required args are missing", async () => {
  const result = await checkCloseAudit({});
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /Missing required args/);
});

test("checkCloseAudit: exits 1 when gh issue view fails", async () => {
  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    { ghIssueViewImpl: async () => { throw new Error("not found"); } },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh issue view failed/);
});

test("checkCloseAudit: a close-call failure is reported as an operational error and never followed by a comment attempt", async () => {
  let commentCalls = 0;
  const ghIssueViewImpl = async () => ({
    body: closeAuditBody({ workIssue: "#306", verdict: "CLEAN" }),
    state: "OPEN",
    createdAt: "2026-09-05T00:00:00Z",
  });
  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl,
      ghApiImpl: withCompletedAuditReport(),
      ghCloseImpl: async () => {
        throw new Error("insufficient permission");
      },
      ghCommentImpl: async () => {
        commentCalls++;
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh issue close failed/);
  assert.equal(commentCalls, 0, "must not attempt the explanatory comment when closing itself failed");
});

test("checkCloseAudit: a comment-post failure after a successful close still reports the close (never a failed exit), naming the comment failure", async () => {
  const ghIssueViewImpl = async () => ({
    body: closeAuditBody({ workIssue: "#306", verdict: "CLEAN" }),
    state: "OPEN",
    createdAt: "2026-09-05T00:00:00Z",
  });
  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl,
      ghApiImpl: withCompletedAuditReport(),
      ghCloseImpl: async () => {},
      ghCommentImpl: async () => {
        throw new Error("transient network error");
      },
    },
  );
  assert.equal(result.exitCode, 0, "the issue is genuinely closed; this must not be reported as a blocked failure");
  assert.equal(result.state, "CLOSED");
  assert.equal(result.commentPosted, false);
  assert.match(result.message, /could not post the durable explanation comment/);
});

// -- checkCloseAudit: correction-chain provenance (issue #513) ---------------------------------
// Generalizes the #396->#406 Work-issue-match supersession fix so a predecessor audit is found and
// retired even when the chain includes an intermediate audit recording no Work issue at all --
// the live #506 (Work issue #497) -> #508 (Work issue: none) -> #512 (Work issue #497, CLEAN)
// regression fixture this unit reconciles. parseCorrectsAuditRef reads the same recurring sentence
// every live correction audit already writes into its own "Stage 1 inline review disposition"
// field ("This is itself a correction PR responding to a prior Stage 2 NOT CLEAN verdict on audit
// issue #N.").

function correctsSentence(predecessorAuditIssue) {
  return (
    `Stage 1 inline review at frozen head \`${MERGE_COMMIT}\` returned findings; fixed in a correction commit. ` +
    `This is itself a correction PR responding to a prior Stage 2 NOT CLEAN verdict on audit issue #${predecessorAuditIssue}.`
  );
}

function chainFixtureWithCorrects({ workIssue = "none", commit = MERGE_COMMIT, verdict, createdAt, corrects = null }) {
  // A real audit-control-issue always has a "Stage 1 inline review disposition" field (required
  // by the template) whether or not it is itself a correction responding to a prior verdict --
  // hasCanonicalAuditShape's predecessor-shape check (Stage 1 review finding on PR #515) relies on
  // this field's mere presence, distinct from parseCorrectsAuditRef's separate check for the
  // "corrects" phrase specifically inside it.
  const dispositionBody =
    corrects !== null ? correctsSentence(corrects) : "Stage 1 inline review at frozen head `abc123` found no issues.";
  return {
    body:
      `### Work issue\n\n${workIssue}\n\n### Exact merge commit\n\n${commit}\n\n` +
      `### Stage 1 inline review disposition\n\n${dispositionBody}\n\n` +
      `### Verification checklist\n\n1. Confirm A.\n\n### Verdict\n\n${verdict}\n`,
    state: "OPEN",
    createdAt,
  };
}

test("parseCorrectsAuditRef: reads the predecessor audit issue number from the live recurring correction sentence", () => {
  assert.equal(parseCorrectsAuditRef(chainFixtureWithCorrects({ verdict: "NOT CLEAN", createdAt: "x", corrects: 506 }).body), 506);
});

test("parseCorrectsAuditRef: returns null when the field is absent (an ordinary, non-correction audit)", () => {
  assert.equal(parseCorrectsAuditRef(closeAuditBody({ verdict: "PENDING" })), null);
});

test("parseCorrectsAuditRef: returns null for unrelated prose in the same field that never uses the recurring phrase", () => {
  const body = "### Stage 1 inline review disposition\n\nStage 1 inline review at frozen head `abc123` found no issues.\n\n### Verdict\n\nCLEAN\n";
  assert.equal(parseCorrectsAuditRef(body), null);
});

// Verification cases 1 & 3 (live regression fixture; no-work intermediate): reproduces the exact
// #506 (Work issue #497) -> #508 (Work issue: none) -> #512 (Work issue #497, CLEAN) shape with
// fictional numbers, and closes the no-work-issue middle audit via direct invocation using only
// correction-chain provenance -- the Work-issue-match strategy alone can never find this, since
// the middle audit's own Work issue field is "none".
test("checkCloseAudit: SUPERSEDED_CLOSE_READY / SUPERSEDED_CLOSED — a no-work-issue intermediate audit resolves via correction-chain provenance alone, and cascades to retire its own predecessor in the same call", async () => {
  const chain = {
    700: chainFixtureWithCorrects({ workIssue: "#497", verdict: "NOT CLEAN", createdAt: "2026-09-05T09:00:00Z" }),
    701: chainFixtureWithCorrects({ workIssue: "none", verdict: "NOT CLEAN", createdAt: "2026-09-05T10:00:00Z", corrects: 700 }),
    702: chainFixtureWithCorrects({ workIssue: "#497", verdict: "CLEAN", createdAt: "2026-09-05T11:00:00Z", corrects: 701 }),
  };
  const ghIssueViewImpl = async ({ number }) => chain[number];
  const ghIssueListImpl = async () => Object.entries(chain).map(([number, data]) => ({ number: Number(number), ...data }));
  const ghApiImpl = ghApiForThreads({ 702: completedAuditThread({ verdict: "CLEAN" }) });

  const dryRunResult = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 701, "dry-run": "true" },
    { ghIssueViewImpl, ghIssueListImpl, ghApiImpl },
  );
  assert.equal(dryRunResult.state, "SUPERSEDED_CLOSE_READY");
  assert.equal(dryRunResult.supersededBy, 702, "the no-work-issue audit resolves via its own corrects-chain pointer, not a Work-issue match");

  const closeCalls = [];
  const commentCalls = [];
  const realResult = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 701 },
    {
      ghIssueViewImpl,
      ghIssueListImpl,
      ghApiImpl,
      ghCloseImpl: async (a) => closeCalls.push(a),
      ghCommentImpl: async (a) => commentCalls.push(a),
    },
  );
  assert.equal(realResult.exitCode, 0);
  assert.equal(realResult.state, "SUPERSEDED_CLOSED");
  // Requirement 7: closing #701 also retires its own predecessor #700 in this same call, with no
  // separate operator invocation against #700's own issue number.
  assert.equal(realResult.retiredPredecessors.length, 1);
  assert.equal(realResult.retiredPredecessors[0].auditIssue, 700);
  assert.equal(realResult.retiredPredecessors[0].supersededBy, 701);
  assert.deepEqual(
    closeCalls.map((c) => c.auditIssue),
    [701, 700],
  );
  assert.equal(commentCalls.length, 2);
  assert.match(commentCalls[0].body, /#702/, "the audit's own close comment names the corrects-chain successor it was resolved through");
  assert.match(commentCalls[1].body, /#701/, "the cascaded predecessor's close comment names the audit that named it as corrected");
});

// Verification case 2: a two-level predecessor chain -- direct invocation on the *earliest* audit
// (#700) must recurse through the intermediate (#701, itself not backed CLEAN) to find the
// terminal CLEAN audit (#702), not stop at the first non-CLEAN hop.
test("checkCloseAudit: a two-level correction chain resolves via recursive corrects-chain search, invoked directly on the earliest predecessor", async () => {
  const chain = {
    700: chainFixtureWithCorrects({ workIssue: "#497", verdict: "NOT CLEAN", createdAt: "2026-09-05T09:00:00Z" }),
    701: chainFixtureWithCorrects({ workIssue: "none", verdict: "NOT CLEAN", createdAt: "2026-09-05T10:00:00Z", corrects: 700 }),
    702: chainFixtureWithCorrects({ workIssue: "#497", verdict: "CLEAN", createdAt: "2026-09-05T11:00:00Z", corrects: 701 }),
  };
  const ghIssueViewImpl = async ({ number }) => chain[number];
  const ghIssueListImpl = async () => Object.entries(chain).map(([number, data]) => ({ number: Number(number), ...data }));
  const ghApiImpl = ghApiForThreads({ 702: completedAuditThread({ verdict: "CLEAN" }) });

  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 700, "dry-run": "true" },
    { ghIssueViewImpl, ghIssueListImpl, ghApiImpl },
  );
  assert.equal(result.state, "SUPERSEDED_CLOSE_READY");
  assert.equal(result.supersededBy, 702, "must recurse past the intermediate #701 (not itself backed CLEAN) to the terminal #702");
});

// Requirement 7 / the pipeline's own invocation pattern: `close-audit` is only ever run by the
// live pipeline against the current/latest audit issue. Closing the terminal audit directly (via
// its own backed-CLEAN verdict) must, in the very same call, cascade backward through the whole
// correction chain -- so a human is never required to separately discover and invoke close-audit
// against #700 or #701's own issue numbers.
test("checkCloseAudit: closing the terminal CLEAN audit cascades to retire the full multi-level predecessor chain in one call", async () => {
  const chain = {
    700: chainFixtureWithCorrects({ workIssue: "#497", verdict: "NOT CLEAN", createdAt: "2026-09-05T09:00:00Z" }),
    701: chainFixtureWithCorrects({ workIssue: "none", verdict: "NOT CLEAN", createdAt: "2026-09-05T10:00:00Z", corrects: 700 }),
    702: chainFixtureWithCorrects({ workIssue: "#497", verdict: "CLEAN", createdAt: "2026-09-05T11:00:00Z", corrects: 701 }),
  };
  const ghIssueViewImpl = async ({ number }) => chain[number];
  const ghApiImpl = ghApiForThreads({ 702: completedAuditThread({ verdict: "CLEAN" }) });

  const closeCalls = [];
  const commentCalls = [];
  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 702 },
    {
      ghIssueViewImpl,
      ghApiImpl,
      ghCloseImpl: async (a) => closeCalls.push(a),
      ghCommentImpl: async (a) => commentCalls.push(a),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "CLOSED", "own-backed-CLEAN close, no successor search needed for #702 itself");
  assert.equal(result.retiredPredecessors.length, 2, "both #701 and #700 are retired in the same call");
  assert.deepEqual(
    result.retiredPredecessors.map((r) => r.auditIssue),
    [701, 700],
  );
  assert.deepEqual(closeCalls.map((c) => c.auditIssue), [702, 701, 700]);
});

// Verification case 4 (active negative control): a NOT CLEAN predecessor whose corrects-chain
// pointer names a real, later-created audit that itself never reaches backed CLEAN must remain
// open -- an unresolved correction chain is not evidence of supersession.
test("checkCloseAudit: NOT_TERMINAL_YET — a corrects-chain pointer to a still-unresolved successor leaves the predecessor open (active negative control)", async () => {
  const chain = {
    710: chainFixtureWithCorrects({ workIssue: "none", verdict: "NOT CLEAN", createdAt: "2026-09-05T09:00:00Z" }),
    711: chainFixtureWithCorrects({ workIssue: "none", verdict: "NOT CLEAN", createdAt: "2026-09-05T10:00:00Z", corrects: 710 }),
  };
  const ghIssueViewImpl = async ({ number }) => chain[number];
  const ghIssueListImpl = async () => Object.entries(chain).map(([number, data]) => ({ number: Number(number), ...data }));
  const ghApiImpl = async () => [];

  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 710, "dry-run": "true" },
    { ghIssueViewImpl, ghIssueListImpl, ghApiImpl },
  );
  assert.equal(result.state, "NOT_TERMINAL_YET", "the chain's own successor (#711) is itself not backed CLEAN, so nothing here proves supersession yet");
});

// Verification case 5 (unrelated-newer negative control): a later, unrelated CLEAN audit that
// never names this audit as its corrects-chain predecessor (and shares no Work issue) must never
// supersede it, merely by existing and being newer.
test("checkCloseAudit: NOT_TERMINAL_YET — an unrelated newer CLEAN audit naming a different corrects-chain predecessor never supersedes", async () => {
  const chain = {
    720: chainFixtureWithCorrects({ workIssue: "none", verdict: "NOT CLEAN", createdAt: "2026-09-05T09:00:00Z" }),
    // Unrelated: created later, backed CLEAN, but its own corrects-chain pointer (and Work issue)
    // name a completely different audit, not #720.
    721: chainFixtureWithCorrects({ workIssue: "#999", verdict: "CLEAN", createdAt: "2026-09-05T10:00:00Z", corrects: 999 }),
  };
  const ghIssueViewImpl = async ({ number }) => chain[number];
  const ghIssueListImpl = async () => Object.entries(chain).map(([number, data]) => ({ number: Number(number), ...data }));
  const ghApiImpl = ghApiForThreads({ 721: completedAuditThread({ verdict: "CLEAN" }) });

  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 720, "dry-run": "true" },
    { ghIssueViewImpl, ghIssueListImpl, ghApiImpl },
  );
  assert.equal(result.state, "NOT_TERMINAL_YET");
});

// Verification case 6 (malformed/contradictory provenance fails closed), forward-search side: a
// candidate naming this audit as its corrects-chain predecessor but created at or before it is
// contradictory provenance (a real successor must be created after what it corrects) and must
// never be treated as a match.
test("checkCloseAudit: NOT_TERMINAL_YET — a corrects-chain pointer from a candidate NOT created after this audit is contradictory provenance and fails closed", async () => {
  const chain = {
    730: chainFixtureWithCorrects({ workIssue: "none", verdict: "NOT CLEAN", createdAt: "2026-09-05T10:00:00Z" }),
    // Claims to correct #730 but was created *before* it -- contradictory, never a real successor.
    731: chainFixtureWithCorrects({ workIssue: "none", verdict: "CLEAN", createdAt: "2026-09-05T09:00:00Z", corrects: 730 }),
  };
  const ghIssueViewImpl = async ({ number }) => chain[number];
  const ghIssueListImpl = async () => Object.entries(chain).map(([number, data]) => ({ number: Number(number), ...data }));
  const ghApiImpl = ghApiForThreads({ 731: completedAuditThread({ verdict: "CLEAN" }) });

  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 730, "dry-run": "true" },
    { ghIssueViewImpl, ghIssueListImpl, ghApiImpl },
  );
  assert.equal(result.state, "NOT_TERMINAL_YET");
});

// Verification case 6, cascade/backward side: once a terminal audit closes, a predecessor whose
// *own* corrects-chain pointer is contradictory (names an issue not created before it) must be
// left untouched and reported in predecessorChainNotes, without blocking the terminal audit's own
// legitimate close or any earlier, valid part of the chain.
test("checkCloseAudit: the predecessor cascade fails closed on a contradictory mid-chain pointer, closing the terminal audit but not any predecessor beyond the break", async () => {
  const chain = {
    // #740's own corrects-chain pointer (to #741) is contradictory: #741 was NOT created before
    // #740, so the cascade must stop there without closing #740 or looking further back.
    740: chainFixtureWithCorrects({ workIssue: "none", verdict: "NOT CLEAN", createdAt: "2026-09-05T08:00:00Z", corrects: 741 }),
    741: chainFixtureWithCorrects({ workIssue: "none", verdict: "NOT CLEAN", createdAt: "2026-09-05T09:00:00Z" }),
    742: chainFixtureWithCorrects({ workIssue: "#497", verdict: "CLEAN", createdAt: "2026-09-05T11:00:00Z", corrects: 740 }),
  };
  const ghIssueViewImpl = async ({ number }) => chain[number];
  const ghApiImpl = ghApiForThreads({ 742: completedAuditThread({ verdict: "CLEAN" }) });

  const closeCalls = [];
  const commentCalls = [];
  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 742 },
    {
      ghIssueViewImpl,
      ghApiImpl,
      ghCloseImpl: async (a) => closeCalls.push(a),
      ghCommentImpl: async (a) => commentCalls.push(a),
    },
  );
  assert.equal(result.state, "CLOSED", "the terminal audit's own backed-CLEAN close is unaffected by a downstream predecessor's bad provenance");
  assert.equal(result.retiredPredecessors.length, 1, "#740 itself still retires cleanly (its own pointer to #741 is what's contradictory, not #742's pointer to #740)");
  assert.equal(result.retiredPredecessors[0].auditIssue, 740);
  assert.equal(result.predecessorChainNotes.length, 1);
  assert.equal(result.predecessorChainNotes[0].auditIssue, 741);
  assert.match(result.predecessorChainNotes[0].reason, /contradictory provenance/);
  assert.deepEqual(closeCalls.map((c) => c.auditIssue), [742, 740], "must never close #741, the contradictory-provenance predecessor");
});

// Verification case 7 (idempotence): rerunning close-audit against the terminal audit after a
// successful cascade retirement is a safe no-op -- no duplicate close or comment, for the
// terminal audit or any already-retired predecessor.
test("checkCloseAudit: rerunning close-audit after a successful cascade retirement is idempotent (ALREADY_TERMINAL, no mutation)", async () => {
  // Simulates post-retirement state: all three issues are already closed.
  const chain = {
    700: chainFixtureWithCorrects({ workIssue: "#497", verdict: "NOT CLEAN", createdAt: "2026-09-05T09:00:00Z" }),
    701: chainFixtureWithCorrects({ workIssue: "none", verdict: "NOT CLEAN", createdAt: "2026-09-05T10:00:00Z", corrects: 700 }),
    702: chainFixtureWithCorrects({ workIssue: "#497", verdict: "CLEAN", createdAt: "2026-09-05T11:00:00Z", corrects: 701 }),
  };
  for (const number of Object.keys(chain)) chain[number].state = "CLOSED";
  const ghIssueViewImpl = async ({ number }) => chain[number];

  for (const auditIssue of [700, 701, 702]) {
    let apiCalls = 0;
    let closeCalls = 0;
    let commentCalls = 0;
    const result = await checkCloseAudit(
      { repo: "owner/repo", "audit-issue": auditIssue },
      {
        ghIssueViewImpl,
        ghApiImpl: async () => {
          apiCalls++;
          return [];
        },
        ghCloseImpl: async () => {
          closeCalls++;
        },
        ghCommentImpl: async () => {
          commentCalls++;
        },
      },
    );
    assert.equal(result.state, "ALREADY_TERMINAL", `#${auditIssue} must report ALREADY_TERMINAL on rerun`);
    assert.equal(apiCalls, 0);
    assert.equal(closeCalls, 0, `must never re-attempt closing #${auditIssue}`);
    assert.equal(commentCalls, 0, `must never post a duplicate comment for #${auditIssue}`);
  }
});

// -- Stage 1 review findings on PR #515 (predecessor-chain retirement hardening) -----------

// P1: a manually entered predecessor number that is a typo naming some older, open, non-audit
// issue must never be closed unconditionally merely because it exists and predates the current
// audit -- it must have the canonical Stage 2 audit-control-issue shape too.
test("checkCloseAudit: the predecessor cascade fails closed on a correctsAuditRef pointer naming an issue with no canonical audit shape (likely a typo)", async () => {
  const chain = {
    // #742's own disposition field has a typo: it names #750 (an ordinary, unrelated open issue
    // with no audit-control-issue fields at all), not the real predecessor #741.
    741: chainFixtureWithCorrects({ workIssue: "none", verdict: "NOT CLEAN", createdAt: "2026-09-05T09:00:00Z" }),
    750: { body: "Just an ordinary open issue about something unrelated.", state: "OPEN", createdAt: "2026-09-05T08:00:00Z" },
    742: chainFixtureWithCorrects({ workIssue: "#497", verdict: "CLEAN", createdAt: "2026-09-05T11:00:00Z", corrects: 750 }),
  };
  const ghIssueViewImpl = async ({ number }) => chain[number];
  const ghApiImpl = ghApiForThreads({ 742: completedAuditThread({ verdict: "CLEAN" }) });

  const closeCalls = [];
  const commentCalls = [];
  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 742 },
    {
      ghIssueViewImpl,
      ghApiImpl,
      ghCloseImpl: async (a) => closeCalls.push(a),
      ghCommentImpl: async (a) => commentCalls.push(a),
    },
  );
  assert.equal(result.state, "CLOSED", "the terminal audit's own backed-CLEAN close is unaffected by a bad predecessor pointer");
  assert.equal(result.retiredPredecessors.length, 0, "the mistyped reference must never be retired");
  assert.equal(result.predecessorChainNotes.length, 1);
  assert.equal(result.predecessorChainNotes[0].auditIssue, 750);
  assert.match(result.predecessorChainNotes[0].reason, /canonical Stage 2 audit-control-issue shape/);
  assert.deepEqual(closeCalls.map((c) => c.auditIssue), [742], "must never close #750, the mistyped non-audit reference");
  assert.equal(commentCalls.length, 1, "only the terminal audit's own close comment is posted");
});

// P2: closing a predecessor can fail transiently (e.g. a flaky `gh issue close` call); a later
// rerun against the (already-closed) terminal audit must retry and complete the cascade rather
// than leaving the predecessor open permanently behind an ALREADY_TERMINAL fast path.
test("checkCloseAudit: a transient predecessor-close failure is retried and completed on a later rerun against the already-terminal audit", async () => {
  const chain = {
    700: chainFixtureWithCorrects({ workIssue: "#497", verdict: "NOT CLEAN", createdAt: "2026-09-05T09:00:00Z" }),
    701: chainFixtureWithCorrects({ workIssue: "none", verdict: "NOT CLEAN", createdAt: "2026-09-05T10:00:00Z", corrects: 700 }),
    702: chainFixtureWithCorrects({ workIssue: "#497", verdict: "CLEAN", createdAt: "2026-09-05T11:00:00Z", corrects: 701 }),
  };
  const ghIssueViewImpl = async ({ number }) => chain[number];
  const ghApiImpl = ghApiForThreads({ 702: completedAuditThread({ verdict: "CLEAN" }) });

  // First run: closing #702 succeeds and cascades into #701, but the close of #701 itself fails
  // transiently. The cascade stops there (never reaching #700), and #702 is left closed.
  let failNextClose = true;
  const firstCloseCalls = [];
  const firstResult = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 702 },
    {
      ghIssueViewImpl,
      ghApiImpl,
      ghCloseImpl: async (a) => {
        firstCloseCalls.push(a.auditIssue);
        if (a.auditIssue === 701 && failNextClose) throw new Error("transient gh failure");
        chain[a.auditIssue].state = "CLOSED";
      },
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(firstResult.state, "CLOSED");
  assert.equal(chain[702].state, "CLOSED");
  assert.equal(chain[701].state, "OPEN", "the failed close must leave #701 open, not silently marked retired");
  assert.equal(chain[700].state, "OPEN", "the cascade must not reach #700 past the #701 failure");
  assert.equal(firstResult.retiredPredecessors.length, 0);
  assert.equal(firstResult.predecessorChainNotes.length, 1);
  assert.equal(firstResult.predecessorChainNotes[0].auditIssue, 701);
  assert.match(firstResult.predecessorChainNotes[0].reason, /gh issue close failed/);

  // Second run: #702 is now already closed (ALREADY_TERMINAL), but the cascade must still retry
  // and this time succeed, retiring both #701 and #700.
  failNextClose = false;
  const secondCloseCalls = [];
  const secondResult = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 702 },
    {
      ghIssueViewImpl,
      ghApiImpl,
      ghCloseImpl: async (a) => {
        secondCloseCalls.push(a.auditIssue);
        chain[a.auditIssue].state = "CLOSED";
      },
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(secondResult.state, "ALREADY_TERMINAL");
  assert.deepEqual(secondCloseCalls, [701, 700], "must never re-attempt closing the already-closed #702 itself");
  assert.equal(secondResult.retiredPredecessors.length, 2);
  assert.equal(chain[701].state, "CLOSED");
  assert.equal(chain[700].state, "CLOSED");
});

// P2: more than one later audit can independently name the same predecessor -- an abandoned or
// still-unresolved first correction attempt, and a fresh replacement correction that actually
// reaches backed CLEAN. The search must not stop at the first (dead-end) branch.
test("checkCloseAudit: findCorrectionChainSuccessor explores every sibling branch naming the same predecessor, not only the first found", async () => {
  const chain = {
    800: chainFixtureWithCorrects({ workIssue: "none", verdict: "NOT CLEAN", createdAt: "2026-09-05T09:00:00Z" }),
    // Abandoned first correction attempt: names #800 as its predecessor, but is itself never
    // resolved (still PENDING, no further correction of its own).
    801: chainFixtureWithCorrects({ workIssue: "none", verdict: "PENDING", createdAt: "2026-09-05T10:00:00Z", corrects: 800 }),
    // Replacement correction, created later, also naming #800 -- and this one reaches CLEAN.
    802: chainFixtureWithCorrects({ workIssue: "#497", verdict: "CLEAN", createdAt: "2026-09-05T11:00:00Z", corrects: 800 }),
  };
  const ghIssueViewImpl = async ({ number }) => chain[number];
  const ghIssueListImpl = async () => Object.entries(chain).map(([number, data]) => ({ number: Number(number), ...data }));
  const ghApiImpl = ghApiForThreads({ 802: completedAuditThread({ verdict: "CLEAN" }) });

  const result = await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 800, "dry-run": "true" },
    { ghIssueViewImpl, ghIssueListImpl, ghApiImpl },
  );
  assert.equal(result.state, "SUPERSEDED_CLOSE_READY", "the abandoned #801 sibling must not cause this to report NOT_TERMINAL_YET");
  assert.equal(result.supersededBy, 802, "must find the sibling branch that actually reaches backed CLEAN");
});

// P2: the explanatory comment posted on a retired predecessor must name the *successor's* own
// field as the source of the correction pointer, never the predecessor's own field (the pointer
// runs forward: the newer issue's body says it corrects the older one, not the reverse).
test("checkCloseAudit: the cascaded predecessor close comment attributes the corrects-chain pointer to the successor, not to the predecessor's own field", async () => {
  const chain = {
    700: chainFixtureWithCorrects({ workIssue: "#497", verdict: "NOT CLEAN", createdAt: "2026-09-05T09:00:00Z" }),
    701: chainFixtureWithCorrects({ workIssue: "none", verdict: "NOT CLEAN", createdAt: "2026-09-05T10:00:00Z", corrects: 700 }),
    702: chainFixtureWithCorrects({ workIssue: "#497", verdict: "CLEAN", createdAt: "2026-09-05T11:00:00Z", corrects: 701 }),
  };
  const ghIssueViewImpl = async ({ number }) => chain[number];
  const ghApiImpl = ghApiForThreads({ 702: completedAuditThread({ verdict: "CLEAN" }) });

  const commentCalls = [];
  await checkCloseAudit(
    { repo: "owner/repo", "audit-issue": 702 },
    {
      ghIssueViewImpl,
      ghApiImpl,
      ghCloseImpl: async () => {},
      ghCommentImpl: async (a) => commentCalls.push(a),
    },
  );
  const commentOn701 = commentCalls.find((c) => c.auditIssue === 701);
  const commentOn700 = commentCalls.find((c) => c.auditIssue === 700);
  assert.match(commentOn701.body, /#702's own "Stage 1 inline review disposition" field records/, "#701's comment must attribute the pointer to #702's own field, not #701's own");
  assert.doesNotMatch(commentOn701.body, /this audit issue's own "Stage 1 inline review disposition" field records that it is corrected/);
  assert.match(commentOn700.body, /#701's own "Stage 1 inline review disposition" field records/, "#700's comment must attribute the pointer to #701's own field, not #700's own");
});

// -- normalizeSearchIssuesPage (Stage 1 review finding on PR #435: real pagination for
// defaultGhIssueList's candidate-successor search, replacing a fixed 200-issue --limit that
// silently dropped candidates past it) ------------------------------------------------------

test("normalizeSearchIssuesPage: maps REST Search API items to the { number, title, body, state, createdAt } shape checkCloseAudit's candidate walk expects", () => {
  const page = {
    total_count: 2,
    items: [
      { number: 396, title: "[Audit] #306", body: "body 396", state: "closed", created_at: "2026-09-05T09:59:55Z" },
      { number: 406, title: "[Audit] #306", body: "body 406", state: "open", created_at: "2026-09-05T14:00:00Z" },
    ],
  };
  assert.deepEqual(normalizeSearchIssuesPage(page), [
    { number: 396, title: "[Audit] #306", body: "body 396", state: "CLOSED", createdAt: "2026-09-05T09:59:55Z" },
    { number: 406, title: "[Audit] #306", body: "body 406", state: "OPEN", createdAt: "2026-09-05T14:00:00Z" },
  ]);
});

test("normalizeSearchIssuesPage: filters out pull requests matching the same search text (the Search API returns both issues and PRs)", () => {
  const page = {
    items: [
      { number: 9001, title: "[Audit] pr mention", body: "a PR, not an audit issue", state: "open", created_at: "2026-09-05T09:00:00Z", pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/9001" } },
      { number: 396, title: "[Audit] #306", body: "body 396", state: "closed", created_at: "2026-09-05T09:59:55Z" },
    ],
  };
  const result = normalizeSearchIssuesPage(page);
  assert.equal(result.length, 1);
  assert.equal(result[0].number, 396);
});

test("normalizeSearchIssuesPage: an empty or missing items array normalizes to an empty array", () => {
  assert.deepEqual(normalizeSearchIssuesPage({ items: [] }), []);
  assert.deepEqual(normalizeSearchIssuesPage({}), []);
});

// -- checkCloseWorkIssue (Stage 1 review finding on PR #435: STAGE2_CLOSE_READY's own
// nextCommand previously never closed the gated work issue at all -- close-audit deliberately
// never touches it, per issue #407 Shared Contract item 3) ----------------------------------

test("checkCloseWorkIssue: CLOSED — an open work issue is closed with a durable comment naming the backing Stage 2 audit evidence", async () => {
  const ghIssueViewImpl = async ({ number }) => {
    assert.equal(number, 379);
    return { state: "OPEN" };
  };
  const closeCalls = [];
  const commentCalls = [];
  const result = await checkCloseWorkIssue(
    { repo: "owner/repo", "work-issue": 379, "audit-issue": 380 },
    {
      ghIssueViewImpl,
      ghCloseImpl: async (a) => closeCalls.push(a),
      ghCommentImpl: async (a) => commentCalls.push(a),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "CLOSED");
  assert.equal(result.workIssue, 379);
  assert.equal(closeCalls.length, 1);
  assert.deepEqual(closeCalls[0], { repo: "owner/repo", workIssue: 379 });
  assert.equal(commentCalls.length, 1);
  assert.equal(commentCalls[0].workIssue, 379);
  assert.equal(commentCalls[0].auditIssue, 380);
});

test("checkCloseWorkIssue: ALREADY_TERMINAL — a safe no-op on a work issue already closed, no close or comment attempted (idempotent rerun)", async () => {
  const ghIssueViewImpl = async () => ({ state: "CLOSED" });
  const result = await checkCloseWorkIssue(
    { repo: "owner/repo", "work-issue": 379, "audit-issue": 380 },
    {
      ghIssueViewImpl,
      ghCloseImpl: async () => assert.fail("must not attempt to close an already-closed work issue"),
      ghCommentImpl: async () => assert.fail("must not comment on an already-closed work issue"),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "ALREADY_TERMINAL");
  assert.equal(result.workIssue, 379);
});

test("checkCloseWorkIssue: a comment-post failure after a successful close still reports the close (never a failed exit), naming the comment failure", async () => {
  const ghIssueViewImpl = async () => ({ state: "OPEN" });
  const result = await checkCloseWorkIssue(
    { repo: "owner/repo", "work-issue": 379, "audit-issue": 380 },
    {
      ghIssueViewImpl,
      ghCloseImpl: async () => {},
      ghCommentImpl: async () => {
        throw new Error("transient network error");
      },
    },
  );
  assert.equal(result.exitCode, 0, "the issue is genuinely closed; this must not be reported as a blocked failure");
  assert.equal(result.state, "CLOSED");
  assert.equal(result.commentPosted, false);
  assert.match(result.message, /could not post the durable explanation comment/);
});

test("checkCloseWorkIssue: exits 1 when required args are missing", async () => {
  const result = await checkCloseWorkIssue({ repo: "owner/repo", "work-issue": 379 });
  assert.equal(result.exitCode, 1);
});

test("checkCloseWorkIssue: exits 1 when gh issue view fails", async () => {
  const result = await checkCloseWorkIssue(
    { repo: "owner/repo", "work-issue": 379, "audit-issue": 380 },
    { ghIssueViewImpl: async () => { throw new Error("not found"); } },
  );
  assert.equal(result.exitCode, 1);
});
