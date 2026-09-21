import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseWorktreeListPorcelain,
  lineageKeyOf,
  upsertEntry,
  isSuperseded,
  reconcile,
  runPreflight,
  ledgerPathFor,
  loadLedger,
  saveLedger,
} from "./worktree-preflight.mjs";

// -------------------------------------------------------------------------------------------
// Pure-logic tests
// -------------------------------------------------------------------------------------------

test("parseWorktreeListPorcelain parses paths, branches, locked and detached entries", () => {
  const text = [
    "worktree /repo",
    "HEAD aaaaaaa",
    "branch refs/heads/main",
    "",
    "worktree /repo/.claude/worktrees/agent-1",
    "HEAD bbbbbbb",
    "branch refs/heads/feature-1",
    "",
    "worktree /repo/.claude/worktrees/agent-2",
    "HEAD ccccccc",
    "locked stale",
    "branch refs/heads/feature-2",
    "",
    "worktree /repo/.claude/worktrees/agent-3",
    "HEAD ddddddd",
    "detached",
  ].join("\n");

  const parsed = parseWorktreeListPorcelain(text);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed[0], { path: "/repo", headCommit: "aaaaaaa", branch: "main", locked: false, lockedReason: null, prunable: false });
  assert.equal(parsed[1].branch, "feature-1");
  assert.equal(parsed[2].locked, true);
  assert.equal(parsed[2].lockedReason, "stale");
  assert.equal(parsed[2].branch, "feature-2");
  assert.equal(parsed[3].branch, null);
});

test("lineageKeyOf prefers controlIssue, then executionIssue, then a never-shared sessionKey fallback", () => {
  assert.equal(lineageKeyOf({ controlIssue: 667, executionIssue: 668, sessionKey: "s1" }), "control:667");
  assert.equal(lineageKeyOf({ controlIssue: null, executionIssue: 668, sessionKey: "s1" }), "execution:668");
  assert.equal(lineageKeyOf({ controlIssue: null, executionIssue: null, sessionKey: "s1" }), "session:s1");
});

test("upsertEntry creates a new entry and refreshes an existing one without blanking unset fields", () => {
  const { ledger: l1, entry: e1 } = upsertEntry([], { path: "/p1", gitCommonDir: "/repo/.git", sessionKey: "s1", branch: "b1", commit: "c1", controlIssue: 10 }, "2026-01-01T00:00:00.000Z");
  assert.equal(l1.length, 1);
  assert.equal(e1.controlIssue, 10);
  assert.equal(e1.executionIssue, null);

  // Re-registration without passing controlIssue must preserve the previously recorded value.
  const { ledger: l2, entry: e2 } = upsertEntry(l1, { path: "/p1", gitCommonDir: "/repo/.git", sessionKey: "s1", branch: "b1", commit: "c2" }, "2026-01-02T00:00:00.000Z");
  assert.equal(l2.length, 1);
  assert.equal(e2.controlIssue, 10, "controlIssue must survive a re-registration that does not pass it");
  assert.equal(e2.commit, "c2");
  assert.equal(e2.lastConfirmedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(e2.outcome, null, "re-registration clears any previously retained/retired outcome");
});

test("isSuperseded is true only when another entry with the same lineage was confirmed later", () => {
  const a = { path: "/a", controlIssue: 667, sessionKey: "sa", lastConfirmedAt: "2026-01-01T00:00:00.000Z" };
  const bEarlier = { path: "/b", controlIssue: 667, sessionKey: "sb", lastConfirmedAt: "2025-12-31T00:00:00.000Z" };
  const bLater = { path: "/b", controlIssue: 667, sessionKey: "sb", lastConfirmedAt: "2026-01-02T00:00:00.000Z" };
  const cUnrelated = { path: "/c", controlIssue: 999, sessionKey: "sc", lastConfirmedAt: "2026-01-03T00:00:00.000Z" };

  assert.equal(isSuperseded(a, [a, bEarlier]), false, "an earlier sibling never supersedes");
  assert.equal(isSuperseded(a, [a, bLater]), true, "a later sibling with the same lineage supersedes");
  assert.equal(isSuperseded(a, [a, cUnrelated]), false, "a later entry with a different lineage never supersedes");
});

function fakeGit({ removals = {}, mergedCommits = new Set(), defaultRef = "refs/heads/main" } = {}) {
  const removed = [];
  return {
    removeWorktree(_cwd, path) {
      removed.push(path);
      const forced = removals[path];
      if (forced) return forced;
      return { ok: true };
    },
    resolveDefaultBranchRef() {
      return defaultRef;
    },
    isAncestor(_cwd, commit) {
      return mergedCommits.has(commit);
    },
    prune() {},
    _removed: removed,
  };
}

test("reconcile: current and primary paths are never candidates", () => {
  const git = fakeGit();
  const { outcomes } = reconcile({
    ledger: [],
    liveWorktrees: [
      { path: "/repo", headCommit: "aaa", branch: "main", locked: false },
      { path: "/repo/.claude/worktrees/current", headCommit: "bbb", branch: "b", locked: false },
    ],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git,
    now: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(git._removed, []);
  assert.deepEqual(outcomes.retired, []);
  assert.deepEqual(outcomes.ineligibleUnrelated, []);
});

test("reconcile: a live worktree outside the managed root is ineligible/untouched", () => {
  const git = fakeGit();
  const { outcomes } = reconcile({
    ledger: [],
    liveWorktrees: [{ path: "/somewhere/else/user-checkout", headCommit: "zzz", branch: "user-branch", locked: false }],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git,
    now: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(outcomes.ineligibleUnrelated, ["/somewhere/else/user-checkout"]);
  assert.deepEqual(git._removed, []);
});

test("reconcile: a ledger entry already absent from disk is marked already_absent and never touched", () => {
  const git = fakeGit();
  const ledger = [{ path: "/repo/.claude/worktrees/gone", sessionKey: "s1", controlIssue: 1, lastConfirmedAt: "2026-01-01T00:00:00.000Z", outcome: null }];
  const { outcomes, ledger: next } = reconcile({
    ledger,
    liveWorktrees: [],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git,
    now: "2026-01-02T00:00:00.000Z",
  });
  assert.deepEqual(outcomes.alreadyAbsent, ["/repo/.claude/worktrees/gone"]);
  assert.equal(next[0].outcome, "already_absent");
  assert.deepEqual(git._removed, []);
});

test("reconcile: legacy unattributed worktree is reclaimed only when merged and clean", () => {
  const merged = fakeGit({ mergedCommits: new Set(["mergedsha"]) });
  const { outcomes: mergedOutcomes } = reconcile({
    ledger: [],
    liveWorktrees: [{ path: "/repo/.claude/worktrees/new-session-old", headCommit: "mergedsha", branch: "old", locked: false }],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git: merged,
    now: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(mergedOutcomes.legacyReclaimed, ["/repo/.claude/worktrees/new-session-old"]);

  const unmerged = fakeGit({ mergedCommits: new Set() });
  const { outcomes: unmergedOutcomes } = reconcile({
    ledger: [],
    liveWorktrees: [{ path: "/repo/.claude/worktrees/new-session-old", headCommit: "unmergedsha", branch: "old", locked: false }],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git: unmerged,
    now: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(unmergedOutcomes.legacyRetained, ["/repo/.claude/worktrees/new-session-old"]);
  assert.deepEqual(unmerged._removed, []);
});

test("reconcile: a ledger entry with a mismatched live branch is retained as ambiguous", () => {
  const git = fakeGit();
  const ledger = [{ path: "/repo/.claude/worktrees/p", sessionKey: "s1", branch: "expected-branch", controlIssue: 1, lastConfirmedAt: "2026-01-01T00:00:00.000Z" }];
  const { outcomes } = reconcile({
    ledger,
    liveWorktrees: [{ path: "/repo/.claude/worktrees/p", headCommit: "x", branch: "unexpected-branch", locked: false }],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git,
    now: "2026-01-02T00:00:00.000Z",
  });
  assert.deepEqual(outcomes.retainedAmbiguous, ["/repo/.claude/worktrees/p"]);
  assert.deepEqual(git._removed, []);
});

test("reconcile: a not-yet-superseded predecessor is retained as active", () => {
  const git = fakeGit();
  const ledger = [{ path: "/repo/.claude/worktrees/p", sessionKey: "s1", branch: "b", controlIssue: 1, lastConfirmedAt: "2026-01-01T00:00:00.000Z" }];
  const { outcomes } = reconcile({
    ledger,
    liveWorktrees: [{ path: "/repo/.claude/worktrees/p", headCommit: "x", branch: "b", locked: false }],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git,
    now: "2026-01-02T00:00:00.000Z",
  });
  assert.deepEqual(outcomes.retainedActive, ["/repo/.claude/worktrees/p"]);
  assert.deepEqual(git._removed, []);
});

test("reconcile: a superseded, locked predecessor is retained (never force-unlocked)", () => {
  const git = fakeGit();
  const ledger = [
    { path: "/repo/.claude/worktrees/p", sessionKey: "s1", branch: "b", controlIssue: 1, lastConfirmedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/repo/.claude/worktrees/current", sessionKey: "s2", branch: "b2", controlIssue: 1, lastConfirmedAt: "2026-01-02T00:00:00.000Z" },
  ];
  const { outcomes } = reconcile({
    ledger,
    liveWorktrees: [
      { path: "/repo/.claude/worktrees/p", headCommit: "x", branch: "b", locked: true },
      { path: "/repo/.claude/worktrees/current", headCommit: "y", branch: "b2", locked: false },
    ],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git,
    now: "2026-01-03T00:00:00.000Z",
  });
  assert.deepEqual(outcomes.retainedLocked, ["/repo/.claude/worktrees/p"]);
  assert.deepEqual(git._removed, []);
});

test("reconcile: a superseded, dirty predecessor is retained without force (git itself refuses)", () => {
  const git = fakeGit({ removals: { "/repo/.claude/worktrees/p": { ok: false, reason: "contains modified or untracked files" } } });
  const ledger = [
    { path: "/repo/.claude/worktrees/p", sessionKey: "s1", branch: "b", controlIssue: 1, lastConfirmedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/repo/.claude/worktrees/current", sessionKey: "s2", branch: "b2", controlIssue: 1, lastConfirmedAt: "2026-01-02T00:00:00.000Z" },
  ];
  const { outcomes, ledger: next } = reconcile({
    ledger,
    liveWorktrees: [
      { path: "/repo/.claude/worktrees/p", headCommit: "x", branch: "b", locked: false },
      { path: "/repo/.claude/worktrees/current", headCommit: "y", branch: "b2", locked: false },
    ],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git,
    now: "2026-01-03T00:00:00.000Z",
  });
  assert.equal(outcomes.retainedDirty.length, 1);
  assert.equal(outcomes.retainedDirty[0].path, "/repo/.claude/worktrees/p");
  assert.match(outcomes.retainedDirty[0].reason, /modified or untracked/);
  assert.equal(next.find((e) => e.path === "/repo/.claude/worktrees/p").outcome, "retained_dirty");
});

test("reconcile: a superseded, clean predecessor is retired and its branch/commit is untouched by the ledger", () => {
  const git = fakeGit();
  const ledger = [
    { path: "/repo/.claude/worktrees/p", sessionKey: "s1", branch: "b", commit: "c1", controlIssue: 1, lastConfirmedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/repo/.claude/worktrees/current", sessionKey: "s2", branch: "b2", controlIssue: 1, lastConfirmedAt: "2026-01-02T00:00:00.000Z" },
  ];
  const { outcomes, ledger: next } = reconcile({
    ledger,
    liveWorktrees: [
      { path: "/repo/.claude/worktrees/p", headCommit: "c1", branch: "b", locked: false },
      { path: "/repo/.claude/worktrees/current", headCommit: "y", branch: "b2", locked: false },
    ],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git,
    now: "2026-01-03T00:00:00.000Z",
  });
  assert.deepEqual(outcomes.retired, ["/repo/.claude/worktrees/p"]);
  assert.deepEqual(git._removed, ["/repo/.claude/worktrees/p"]);
  const retiredEntry = next.find((e) => e.path === "/repo/.claude/worktrees/p");
  assert.equal(retiredEntry.outcome, "retired");
  assert.equal(retiredEntry.commit, "c1", "the retired entry keeps its own last-known commit for provenance");
});

test("reconcile is idempotent: retiring the same predecessor twice reports already_absent the second time", () => {
  const git = fakeGit();
  let ledger = [
    { path: "/repo/.claude/worktrees/p", sessionKey: "s1", branch: "b", controlIssue: 1, lastConfirmedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/repo/.claude/worktrees/current", sessionKey: "s2", branch: "b2", controlIssue: 1, lastConfirmedAt: "2026-01-02T00:00:00.000Z" },
  ];
  const live = [
    { path: "/repo/.claude/worktrees/p", headCommit: "x", branch: "b", locked: false },
    { path: "/repo/.claude/worktrees/current", headCommit: "y", branch: "b2", locked: false },
  ];
  const first = reconcile({ ledger, liveWorktrees: live, currentPath: "/repo/.claude/worktrees/current", primaryPath: "/repo", managedRoot: "/repo/.claude/worktrees", git, now: "2026-01-03T00:00:00.000Z" });
  assert.deepEqual(first.outcomes.retired, ["/repo/.claude/worktrees/p"]);

  // Second run: git worktree list no longer reports the removed path (as real git would after
  // a successful `git worktree remove`).
  const second = reconcile({
    ledger: first.ledger,
    liveWorktrees: [{ path: "/repo/.claude/worktrees/current", headCommit: "y", branch: "b2", locked: false }],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git,
    now: "2026-01-04T00:00:00.000Z",
  });
  assert.deepEqual(second.outcomes.alreadyAbsent, ["/repo/.claude/worktrees/p"]);
  assert.deepEqual(second.outcomes.retired, []);
});

test("loadLedger/saveLedger round-trip and loadLedger fails closed to [] on a corrupt file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-worktree-ledger-"));
  try {
    const path = ledgerPathFor(join(dir, ".git"));
    assert.equal(loadLedger(path).length, 0, "missing ledger loads as empty");

    saveLedger(path, [{ path: "/x" }]);
    assert.deepEqual(loadLedger(path), [{ path: "/x" }]);

    mkdirSync(join(dir, ".git", "ldl"), { recursive: true });
    writeFileSync(path, "not json", "utf8");
    assert.deepEqual(loadLedger(path), [], "a corrupt ledger fails closed to empty rather than throwing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------------------------
// End-to-end tests against real temporary git repositories and real `git worktree` operations.
// -------------------------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "ldl-worktree-e2e-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

test("end-to-end: a superseded predecessor Dispatch worktree is actually removed while current/dirty/unrelated survive", () => {
  const repo = makeRepo();
  try {
    const worktreesRoot = join(repo, ".claude", "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });

    const predecessorPath = join(worktreesRoot, "new-session-predecessor").replace(/\\/g, "/");
    const dirtyPath = join(worktreesRoot, "new-session-dirty").replace(/\\/g, "/");
    const currentPath = join(worktreesRoot, "agent-current").replace(/\\/g, "/");

    git(repo, ["worktree", "add", "-b", "predecessor-branch", predecessorPath]);
    git(repo, ["worktree", "add", "-b", "dirty-branch", dirtyPath]);
    git(repo, ["worktree", "add", "-b", "current-branch", currentPath]);
    writeFileSync(join(dirtyPath, "uncommitted.txt"), "wip\n");

    // Register the predecessor and the dirty worktree under the SAME control-issue lineage,
    // then register `current` under the same lineage with a later timestamp -- reproducing the
    // #639/#638 correction-chain shape (PR A's session worktree superseded by a fresh session
    // for the same control lineage).
    const args1 = { "control-issue": "42" };
    const result1 = runPreflight({ args: { ...args1, _: ["register"], path: predecessorPath }, cwd: predecessorPath, now: "2026-01-01T00:00:00.000Z" });
    assert.equal(result1.exitCode, 0);
    const resultDirty = runPreflight({ args: { ...args1, _: ["register"], path: dirtyPath }, cwd: dirtyPath, now: "2026-01-01T00:00:05.000Z" });
    assert.equal(resultDirty.exitCode, 0);

    const preflight = runPreflight({ args: { "control-issue": "42" }, cwd: currentPath, now: "2026-01-02T00:00:00.000Z" });
    assert.equal(preflight.exitCode, 0);
    assert.deepEqual(preflight.result.retired, [predecessorPath]);
    assert.equal(preflight.result.retainedDirty.length, 1);
    assert.equal(preflight.result.retainedDirty[0].path, dirtyPath);

    assert.equal(existsSync(predecessorPath), false, "the superseded, clean predecessor checkout was actually removed from disk");
    assert.equal(existsSync(dirtyPath), true, "the dirty predecessor checkout was left untouched");
    assert.equal(existsSync(currentPath), true, "the current session's own checkout is always excluded");

    const worktreesAfter = git(repo, ["worktree", "list"]);
    assert.ok(!worktreesAfter.includes("new-session-predecessor"), "git itself no longer lists the retired worktree");
    assert.ok(worktreesAfter.includes("dirty-branch"), "the dirty worktree's branch is still checked out");

    // Idempotence: a second preflight run from `current` must not error and must report the
    // already-removed predecessor as already_absent rather than attempting it again.
    const second = runPreflight({ args: { "control-issue": "42" }, cwd: currentPath, now: "2026-01-03T00:00:00.000Z" });
    assert.equal(second.exitCode, 0);
    assert.deepEqual(second.result.retired, []);
    assert.deepEqual(second.result.alreadyAbsent, [predecessorPath]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("end-to-end: an unassociated (unknown-lineage) worktree is left untouched even under the managed root", () => {
  const repo = makeRepo();
  try {
    const worktreesRoot = join(repo, ".claude", "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });
    const unknownPath = join(worktreesRoot, "hand-made-checkout").replace(/\\/g, "/");
    const currentPath = join(worktreesRoot, "agent-current").replace(/\\/g, "/");

    git(repo, ["worktree", "add", "-b", "hand-made-branch", unknownPath]);
    // Give the branch a commit unique to itself so it is genuinely NOT an ancestor of main --
    // otherwise its tip trivially equals main's and would be indistinguishable from "already
    // merged".
    writeFileSync(join(unknownPath, "unique.txt"), "unmerged work\n");
    git(unknownPath, ["add", "."]);
    git(unknownPath, ["commit", "-q", "-m", "unmerged work"]);
    git(repo, ["worktree", "add", "-b", "current-branch", currentPath]);
    // `unknownPath` is never registered in the ledger and its branch is not merged into main --
    // it must be retained under the bounded legacy path, never removed on directory-name alone.

    const result = runPreflight({ args: { "control-issue": "99" }, cwd: currentPath, now: "2026-01-01T00:00:00.000Z" });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.result.legacyRetained, [unknownPath]);
    assert.equal(existsSync(unknownPath), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("end-to-end: a fully merged legacy worktree with no ledger entry is reclaimed", () => {
  const repo = makeRepo();
  try {
    const worktreesRoot = join(repo, ".claude", "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });
    const legacyPath = join(worktreesRoot, "new-session-legacy").replace(/\\/g, "/");
    const currentPath = join(worktreesRoot, "agent-current").replace(/\\/g, "/");

    git(repo, ["worktree", "add", "-b", "legacy-branch", legacyPath]);
    // Fast-forward main to include legacy-branch's tip, so it is provably merged/durable.
    git(repo, ["merge", "-q", "legacy-branch"]);
    git(repo, ["worktree", "add", "-b", "current-branch", currentPath]);

    const result = runPreflight({ args: {}, cwd: currentPath, now: "2026-01-01T00:00:00.000Z" });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.result.legacyReclaimed, [legacyPath]);
    assert.equal(existsSync(legacyPath), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("end-to-end: the primary checkout is never a reconciliation candidate", () => {
  const repo = makeRepo();
  try {
    const worktreesRoot = join(repo, ".claude", "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });
    const currentPath = join(worktreesRoot, "agent-current").replace(/\\/g, "/");
    git(repo, ["worktree", "add", "-b", "current-branch", currentPath]);

    const result = runPreflight({ args: {}, cwd: currentPath, now: "2026-01-01T00:00:00.000Z" });
    assert.equal(result.exitCode, 0);
    const allTouched = [...result.result.retired, ...result.result.legacyReclaimed, ...result.result.legacyRetained];
    assert.ok(!allTouched.includes(repo.replace(/\\/g, "/")));
    assert.equal(existsSync(join(repo, "README.md")), true, "the primary checkout is untouched");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
