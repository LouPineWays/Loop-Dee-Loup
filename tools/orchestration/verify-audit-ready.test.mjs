// Tests for tools/orchestration/verify-audit-ready.mjs (issue #740: the #691/#737/PR #738/#739
// merge-commit vs corrected/CI-head substitution).
//
// Run with: node --test tools/orchestration/verify-audit-ready.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { run } from "./verify-audit-ready.mjs";

const MERGE = "5d588a5034e13fc32cbd733a224d57715a033667";
const CI_HEAD = "bd4a32cacefb7521f50ab73075c8e1105b8f7be0";

function auditBody({ pr = 738, work = "#737", commit = MERGE, checklistHead = CI_HEAD } = {}) {
  return [
    "### Merged PR", "", `https://github.com/o/r/pull/${pr}`, "",
    "### Work issue", "", work, "",
    "### Exact merge commit", "", `\`${commit}\``, "",
    "### Stage 1 inline review disposition", "", "correction-satisfied", "",
    "### Audit scope", "", "Complete diff.", "",
    "### Verification checklist", "", `1. Control-plane CI passed at pre-merge head ${checklistHead}.`, "",
  ].join("\n");
}

const prView = { state: "MERGED", mergeCommit: { oid: MERGE } };
const deps = (body, { list } = {}) => ({
  ghPrViewImpl: async () => prView,
  ghAuditIssueViewImpl: async () => ({ state: "OPEN", body }),
  ghIssueListImpl: async () => list ?? [{ number: 739, title: "[Audit] x", body, state: "OPEN", createdAt: "2026-09-23T00:00:00Z" }],
});
const args = { repo: "o/r", pr: 738, executionIssue: 737, auditIssue: 739 };

test("resolve mode prints the PR's actual merge commit, not the corrected/CI head", async () => {
  const r = await run({ repo: "o/r", pr: 738 }, deps(""));
  assert.equal(r.exitCode, 0);
  assert.equal(r.message, `MERGE_COMMIT ${MERGE}`);
  assert.notEqual(r.mergeCommitOid, CI_HEAD);
});

test("positive: merge commit in field and distinct CI head in checklist -> AUDIT_READY", async () => {
  const r = await run(args, deps(auditBody()));
  assert.equal(r.message, "AUDIT_READY #739");
  assert.equal(r.exitCode, 0);
});

test("negative: Audit body uses the corrected/CI head as Exact merge commit -> never AUDIT_READY", async () => {
  const r = await run(args, deps(auditBody({ commit: CI_HEAD })));
  assert.equal(r.exitCode, 2);
  assert.match(r.message, /^AUDIT_PREPARATION_FAILED /);
  assert.doesNotMatch(r.message, /AUDIT_READY/);
  assert.match(r.message, new RegExp(MERGE));
});

test("wrong PR or wrong work issue fails closed", async () => {
  assert.match((await run(args, deps(auditBody({ pr: 737 })))).message, /^AUDIT_PREPARATION_FAILED .*Merged PR/);
  assert.match((await run(args, deps(auditBody({ work: "#736" })))).message, /^AUDIT_PREPARATION_FAILED .*Work issue/);
});

test("incomplete shell and unmerged PR fail closed", async () => {
  const shell = ["### Work issue", "", "#737", "", "### Exact merge commit", "", MERGE, ""].join("\n");
  assert.equal((await run(args, deps(shell))).exitCode, 2);
  const r = await run(args, { ...deps(auditBody()), ghPrViewImpl: async () => ({ state: "OPEN", mergeCommit: null }) });
  assert.match(r.message, /^AUDIT_PREPARATION_FAILED /);
});

test("read-back happens: the persisted issue is fetched after the PR and its body is what is validated", async () => {
  const calls = [];
  const d = deps(auditBody());
  const r = await run(args, {
    ghPrViewImpl: async (a) => (calls.push("pr"), d.ghPrViewImpl(a)),
    ghAuditIssueViewImpl: async (a) => (calls.push("audit"), d.ghAuditIssueViewImpl(a)),
    ghIssueListImpl: async (a) => (calls.push("list"), d.ghIssueListImpl(a)),
  });
  assert.deepEqual(calls, ["pr", "audit", "list"]);
  assert.equal(r.exitCode, 0);
});

test("retry with a wrong-identity duplicate open: ambiguity or wrong candidate fails closed, no trigger path exists", async () => {
  const good = auditBody();
  const bad = auditBody({ commit: CI_HEAD });
  // Wrong-identity candidate is not a match, so a sole correct one still verifies...
  const ok = await run(args, deps(good, { list: [
    { number: 739, title: "[Audit] a", body: bad, state: "OPEN", createdAt: "2026-09-23T00:00:00Z" },
    { number: 750, title: "[Audit] b", body: good, state: "OPEN", createdAt: "2026-09-24T00:00:00Z" },
  ] }));
  assert.equal(ok.exitCode, 2); // 750 is the sole match, not the given 739
  const okRight = await run({ ...args, auditIssue: 750 }, deps(good, { list: [
    { number: 739, title: "[Audit] a", body: bad, state: "OPEN", createdAt: "2026-09-23T00:00:00Z" },
    { number: 750, title: "[Audit] b", body: good, state: "OPEN", createdAt: "2026-09-24T00:00:00Z" },
  ] }));
  assert.equal(okRight.message, "AUDIT_READY #750");
  // ...but two correct duplicates are ambiguous.
  const dup = await run(args, deps(good, { list: [
    { number: 739, title: "[Audit] a", body: good, state: "OPEN", createdAt: "2026-09-23T00:00:00Z" },
    { number: 750, title: "[Audit] b", body: good, state: "OPEN", createdAt: "2026-09-24T00:00:00Z" },
  ] }));
  assert.match(dup.message, /^AUDIT_PREPARATION_FAILED .*also matches/);
});

test("invalid args are operational errors", async () => {
  assert.equal((await run({ repo: "o/r", pr: null }, deps(""))).exitCode, 1);
  assert.equal((await run({ repo: "o/r", pr: 1, executionIssue: 2 }, deps(""))).exitCode, 1);
});

test("a Merged PR URL from a different repository with the same PR number is rejected", async () => {
  const other = auditBody().replace("github.com/o/r/pull/738", "github.com/x/y/pull/738");
  const r = await run(args, deps(other, { list: [] }));
  assert.equal(r.exitCode, 2);
  assert.match(r.message, /^AUDIT_PREPARATION_FAILED .*Merged PR/);
  // Same repo, different case, and a bare #N both still pass.
  assert.equal((await run(args, deps(auditBody().replace("o/r", "O/R")))).exitCode, 0);
  assert.equal((await run(args, deps(auditBody().replace("https://github.com/o/r/pull/738", "#738")))).exitCode, 0);
});

test("a freshly created valid Audit Issue succeeds even when Search has not indexed it yet", async () => {
  const r = await run(args, deps(auditBody(), { list: [] }));
  assert.equal(r.message, "AUDIT_READY #739");
});

test("a Search failure still fails closed", async () => {
  const d = deps(auditBody());
  const r = await run(args, { ...d, ghIssueListImpl: async () => { throw new Error("boom"); } });
  assert.match(r.message, /^AUDIT_PREPARATION_FAILED /);
});
