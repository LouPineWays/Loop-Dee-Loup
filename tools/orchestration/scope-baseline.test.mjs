// Tests for tools/orchestration/scope-baseline.mjs -- issue #1005 (live Audit #1004 / PR #958).
// Run with: node --test tools/orchestration/scope-baseline.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  ScopeState,
  checkScopeBaseline,
  deriveMergeScope,
  extractMergeScopeCommands,
  substituteScopeBase,
  verifyAuditScopeBaseline,
} from "./scope-baseline.mjs";

const MERGE = "d4ef1c57ab45e4d55f24ee78746d1c5347b5770a";
const PARENT = "182c4d9c621bdb7feb547bf6626566f9d4edbcf9";
const STALE = "c2f3676e251ec6b3192c854634d0339d4daa841b";
const FILES = ["docs/bounded-review-cycle.md", "tools/orchestration/next-review-transition-gate.mjs"];
const commit = (over = {}) => ({ sha: MERGE, parents: [PARENT], files: FILES, filesComplete: true, ...over });
const item = (base) => `4. Confirm the diff (\`git diff ${base} ${MERGE}\`) touches only those two files.`;

test("#1004 shape: original-PR-base range is STALE; first-parent range is OK with the two intended files", () => {
  const bad = checkScopeBaseline({ checklist: item(STALE), mergeCommit: MERGE, commit: commit() });
  assert.equal(bad.state, ScopeState.STALE_SCOPE_BASELINE);
  assert.equal(bad.ok, false);
  assert.equal(bad.firstParent, PARENT);
  const good = checkScopeBaseline({ checklist: item(PARENT), mergeCommit: MERGE, commit: commit() });
  assert.equal(good.state, ScopeState.OK);
  assert.deepEqual(good.files, FILES);
});

test("accepted forms: --name-status flags, <merge>^, <merge>~1, two-dot and three-dot ranges", () => {
  for (const text of [
    `git diff --name-status ${PARENT} ${MERGE}`,
    `git diff ${MERGE}^ ${MERGE}`,
    `git diff ${MERGE}~1 ${MERGE}`,
    `git diff ${PARENT}..${MERGE}`,
    `git diff ${PARENT}...${MERGE}`,
  ]) {
    assert.equal(checkScopeBaseline({ checklist: text, mergeCommit: MERGE, commit: commit() }).state, ScopeState.OK, text);
  }
  assert.equal(checkScopeBaseline({ checklist: `git diff ${STALE}..${MERGE}`, mergeCommit: MERGE, commit: commit() }).state, ScopeState.STALE_SCOPE_BASELINE);
});

test("symbolic or short bases cannot be proven to isolate the merge", () => {
  for (const base of ["main", "origin/main", "abc1234", "HEAD~3"]) {
    const r = checkScopeBaseline({ checklist: `git diff ${base} ${MERGE}`, mergeCommit: MERGE, commit: commit() });
    assert.equal(r.state, ScopeState.UNVERIFIABLE_SCOPE_BASELINE, base);
    assert.equal(r.ok, false);
  }
});

test("no scope command for this merge -> NO_SCOPE_COMMAND (ok); diffs against other heads are ignored", () => {
  assert.equal(checkScopeBaseline({ checklist: "1. Confirm A.", mergeCommit: MERGE, commit: commit() }).state, ScopeState.NO_SCOPE_COMMAND);
  assert.equal(extractMergeScopeCommands(`git diff ${STALE} ${"0123456789abcdef0123456789abcdef01234567"}`, MERGE).length, 0);
});

test("missing / untrustworthy merge parent topology fails closed", () => {
  const checklist = item(PARENT);
  for (const c of [null, commit({ parents: [] }), commit({ sha: "0123456789abcdef0123456789abcdef01234567" }), commit({ parents: ["nothex"] })]) {
    assert.equal(checkScopeBaseline({ checklist, mergeCommit: MERGE, commit: c }).state, ScopeState.MERGE_PARENT_UNPROVEN);
  }
});

test("a truncated file list is never reported as the merge's file set", () => {
  const r = checkScopeBaseline({ checklist: item(PARENT), mergeCommit: MERGE, commit: commit({ filesComplete: false }) });
  assert.equal(r.state, ScopeState.OK);
  assert.equal(r.files, null);
});

test("deriveMergeScope uses the first parent, substituteScopeBase touches only the stale SHA", () => {
  assert.deepEqual(deriveMergeScope(commit({ parents: [PARENT, "f".repeat(40)] })), { base: PARENT, head: MERGE, files: FILES });
  assert.equal(deriveMergeScope(commit({ parents: [] })), null);
  const out = substituteScopeBase(item(STALE), STALE, PARENT, MERGE);
  assert.equal(out, item(PARENT));
  assert.equal(substituteScopeBase("keep other text", STALE, PARENT, MERGE), "keep other text");
});

test("verifyAuditScopeBaseline: no read when no scope command; read failure fails closed", async () => {
  let reads = 0;
  const readCommitImpl = async () => {
    reads++;
    throw new Error("boom");
  };
  assert.equal((await verifyAuditScopeBaseline({ repo: "o/r", checklist: "1. A", mergeCommit: MERGE }, { readCommitImpl })).state, ScopeState.NO_SCOPE_COMMAND);
  assert.equal(reads, 0);
  const r = await verifyAuditScopeBaseline({ repo: "o/r", checklist: item(PARENT), mergeCommit: MERGE }, { readCommitImpl });
  assert.equal(r.state, ScopeState.MERGE_PARENT_UNPROVEN);
  assert.equal(reads, 1);
});

test("range operand followed by a pathspec is still a scope command (Stage 1 P2)", () => {
  for (const text of [`git diff ${STALE}..${MERGE} -- tools/`, `git diff ${STALE}...${MERGE} tools/`]) {
    assert.equal(extractMergeScopeCommands(text, MERGE).length, 1, text);
    assert.equal(checkScopeBaseline({ checklist: text, mergeCommit: MERGE, commit: commit() }).state, ScopeState.STALE_SCOPE_BASELINE, text);
  }
});

test("substituteScopeBase rewrites only the scope command's base, not the SHA elsewhere (Stage 1 P2)", () => {
  const text = `3. Verify CI passed on ${STALE}.
` + item(STALE);
  const out = substituteScopeBase(text, STALE, PARENT, MERGE);
  assert.ok(out.startsWith(`3. Verify CI passed on ${STALE}.`));
  assert.ok(out.includes(`git diff ${PARENT} ${MERGE}`));
});
