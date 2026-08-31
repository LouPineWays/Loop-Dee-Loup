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
import {
  checkMergeReady,
  checkPostAudit,
  findClosingKeywordMatch,
  isNoWorkIssueSentinel,
  normalizeIssueNumber,
  parseArgs,
  parseFormField,
  parseMergeCommitRef,
  parseStage2Verdict,
  parseWorkIssueRef,
  recoverPrematureClosure,
} from "./lifecycle-gate.mjs";
import { triggerCommentBody } from "./trigger.mjs";

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

function auditBodyWithCommit({ workIssue = 151, verdict = "PENDING", commit = MERGE_COMMIT }) {
  return `### Work issue\n\n#${workIssue}\n\n### Exact merge commit\n\n${commit}\n\n### Verdict\n\n${verdict}\n`;
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

test("parseWorkIssueRef: does NOT treat GitHub's own '_No response_' marker as the no-work-issue sentinel (Stage 1 review finding on PR #197)", () => {
  // The Work issue field is required precisely so this marker can never legitimately appear;
  // if it somehow does anyway, it must fail closed as malformed (null), not be silently read as
  // an intentional no-work-issue declaration — otherwise an operator who simply forgot to fill
  // in a real work issue on an audit that has one would have that issue's premature-closure
  // protection silently stripped, since a forgotten field and a deliberate declaration would
  // render identically.
  assert.equal(parseWorkIssueRef("### Work issue\n\n_No response_\n"), null);
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
    },
  );
  assert.deepEqual(seenNumbers, [160, 151], "must read the audit issue (160) and the distinct work issue (151) it names");
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
