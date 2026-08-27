// Tests for tools/review-watch/lifecycle-gate.mjs. All `gh` access is faked via the injected
// `ghPrViewImpl`/`ghIssueViewImpl`/`ghReopenImpl` options — never touch the real network or
// `gh` CLI here. Run with: node --test tools/review-watch/lifecycle-gate.test.mjs
//
// Covers the regression case (PR #154 / Issue #151) and the numbered verification list in
// issue #156.

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkMergeReady,
  checkPostAudit,
  findClosingKeywordMatch,
  parseArgs,
  parseFormField,
  parseStage2Verdict,
  parseWorkIssueRef,
  recoverPrematureClosure,
} from "./lifecycle-gate.mjs";

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

// -- parseFormField / parseStage2Verdict / parseWorkIssueRef ---------------------------

test("parseFormField: reads the first non-blank line under a heading", () => {
  const body = "### Verdict\n\nCLEAN\n\n### Next authorized action\n\nNone\n";
  assert.equal(parseFormField(body, "Verdict"), "CLEAN");
  assert.equal(parseFormField(body, "Next authorized action"), "None");
});

test("parseFormField: returns null when the heading is absent", () => {
  assert.equal(parseFormField("no headings here", "Verdict"), null);
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
  assert.match(result.message, /Missing required args/);
});

test("checkMergeReady: BLOCKED — a PR-body closing keyword surfaced via closingIssuesReferences (verification #3)", async () => {
  const result = await checkMergeReady(
    { repo: "owner/repo", pr: 154, issue: 151 },
    { ghPrViewImpl: async () => ({ closingIssuesReferences: [{ number: 151 }], commits: [] }) },
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

test("checkPostAudit: READY_TO_CLOSE — verdict CLEAN, work issue still open (verification #10)", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBody({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "OPEN" },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "READY_TO_CLOSE");
  assert.equal(result.workIssue, 151);
});

test("checkPostAudit: OK — verdict CLEAN and work issue already closed", async () => {
  const result = await checkPostAudit(
    { repo: "owner/repo", "audit-issue": 160 },
    {
      ghIssueViewImpl: async ({ number }) =>
        number === 160 ? { body: auditBody({ verdict: "CLEAN" }), state: "OPEN" } : { body: "", state: "CLOSED" },
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
  const calls = [];
  const result = await recoverPrematureClosure(
    { repo: "owner/repo", workIssue: 151, auditIssue: 160 },
    { ghReopenImpl: async (args) => calls.push(args) },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.recovered, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { repo: "owner/repo", workIssue: 151, auditIssue: 160 });
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

// -- parseArgs -------------------------------------------------------------------------

test("parseArgs: reads flags including a hyphenated flag name", () => {
  const args = parseArgs(["--repo", "owner/repo", "--audit-issue", "160", "--recover", "true"]);
  assert.equal(args.repo, "owner/repo");
  assert.equal(args["audit-issue"], "160");
  assert.equal(args.recover, "true");
});
