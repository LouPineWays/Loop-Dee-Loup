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
  normalizeIssueNumber,
  parseArgs,
  parseFormField,
  parseStage2Verdict,
  parseWorkIssueRef,
  recoverPrematureClosure,
} from "./lifecycle-gate.mjs";
import { triggerCommentBody } from "./trigger.mjs";

// A genuine post-trigger Codex response on an issue-comments thread, for tests that need
// checkPostAudit's CLEAN-verdict provenance check to find one.
function genuineAuditThread({ triggerTime = "2026-08-20T00:00:00Z", responseTime = "2026-08-20T00:05:00Z" } = {}) {
  return [
    { id: 1, body: triggerCommentBody(), created_at: triggerTime },
    { id: 2, user: { login: "chatgpt-codex-connector[bot]" }, body: "Reviewed the merge commit. Nothing material remains.", created_at: responseTime },
  ];
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

// A ghApiImpl that returns a genuine post-trigger response for the audit issue's
// issue-comments endpoint and an empty array for anything else.
function withGenuineResponse() {
  return async (path) => (path.includes("/issues/") ? genuineAuditThread() : []);
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

test("checkPostAudit: READY_TO_CLOSE — verdict CLEAN backed by a genuine response, work issue still open (verification #10)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBody({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: withGenuineResponse(),
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
        number === 160 ? { body: auditBody({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "OPEN" },
      ghApiImpl: async () => [], // no trigger, no response at all
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK", "an unbacked CLEAN must not authorize READY_TO_CLOSE");
  assert.equal(result.verdict, null);
  assert.equal(result.rawVerdict, "CLEAN");
});

test("checkPostAudit: PREMATURE_CLOSURE — work issue closed and the recorded CLEAN has no genuine response behind it", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBody({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "CLOSED" },
      ghApiImpl: async () => [],
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PREMATURE_CLOSURE");
  assert.match(result.message, /no genuine post-trigger Codex response/);
});

test("checkPostAudit: OK — verdict CLEAN (backed) and work issue already closed", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBody({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "CLOSED" },
      ghApiImpl: withGenuineResponse(),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "OK");
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
