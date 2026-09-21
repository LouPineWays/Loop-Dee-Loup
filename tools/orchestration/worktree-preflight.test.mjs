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
  isDurablyObsolete,
  reconcile,
  runPreflight,
  ledgerPathFor,
  loadLedger,
  saveLedger,
  DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS,
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
  assert.equal(lineageKeyOf({ controlIssue: 667, executionIssue: 668, sessionKey: "s1" }), "issue:667");
  assert.equal(lineageKeyOf({ controlIssue: null, executionIssue: 668, sessionKey: "s1" }), "issue:668");
  assert.equal(lineageKeyOf({ controlIssue: null, executionIssue: null, sessionKey: "s1" }), "session:s1");
});

test("lineageKeyOf is role-neutral: the same issue number keys identically whether recorded as controlIssue or executionIssue (Stage 1 review finding on PR #687)", () => {
  // A fresh `work on #N` session runs the mandatory preflight before the READY gate that would
  // tell it whether #N is a control or an execution issue, so two sessions for the exact same
  // real-world lineage can legitimately guess opposite roles for the identical number. GitHub
  // issue numbers are unique per repository, so folding both roles into one key can never
  // conflate two genuinely different lineages -- it only ever reunites two records of the same one.
  const guessedControl = { controlIssue: 668, executionIssue: null, sessionKey: "a" };
  const guessedExecution = { controlIssue: null, executionIssue: 668, sessionKey: "b" };
  assert.equal(lineageKeyOf(guessedControl), lineageKeyOf(guessedExecution));
});

test("upsertEntry creates a new entry and refreshes an existing one without blanking unset fields", () => {
  const { ledger: l1, entry: e1 } = upsertEntry([], { path: "/p1", gitCommonDir: "/repo/.git", sessionKey: "s1", branch: "b1", commit: "c1", controlIssue: 10 }, "2026-01-01T00:00:00.000Z");
  assert.equal(l1.length, 1);
  assert.equal(e1.controlIssue, 10);
  assert.equal(e1.executionIssue, null);

  // Re-registration without passing controlIssue, but under the SAME sessionKey, must preserve
  // the previously recorded value -- this is the same session confirming itself again.
  const { ledger: l2, entry: e2 } = upsertEntry(l1, { path: "/p1", gitCommonDir: "/repo/.git", sessionKey: "s1", branch: "b1", commit: "c2" }, "2026-01-02T00:00:00.000Z");
  assert.equal(l2.length, 1);
  assert.equal(e2.controlIssue, 10, "controlIssue must survive a re-registration that does not pass it, under the same sessionKey");
  assert.equal(e2.commit, "c2");
  assert.equal(e2.lastConfirmedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(e2.outcome, null, "re-registration clears any previously retained/retired outcome");
});

test("upsertEntry resets stale lineage when a DIFFERENT session reuses an already-registered path (Stage 1 review, PR #683)", () => {
  const { ledger: l1 } = upsertEntry([], { path: "/primary", gitCommonDir: "/repo/.git", sessionKey: "session-a", branch: "b1", commit: "c1", controlIssue: 10 }, "2026-01-01T00:00:00.000Z");

  // A fresh session reuses the SAME path with a DIFFERENT sessionKey and does not repeat
  // controlIssue -- it must never inherit the prior session's lineage merely because it did not
  // pass its own IDs.
  const { ledger: l2, entry: e2 } = upsertEntry(l1, { path: "/primary", gitCommonDir: "/repo/.git", sessionKey: "session-b", branch: "b2", commit: "c2" }, "2026-01-02T00:00:00.000Z");
  assert.equal(l2.length, 1);
  assert.equal(e2.controlIssue, null, "a new session reusing this path must not inherit the prior session's controlIssue");
  assert.equal(e2.sessionKey, "session-b");

  // A new session that DOES supply its own lineage explicitly is honored, never blocked by the reset.
  const { entry: e3 } = upsertEntry(l1, { path: "/primary", gitCommonDir: "/repo/.git", sessionKey: "session-c", branch: "b3", commit: "c3", controlIssue: 99 }, "2026-01-03T00:00:00.000Z");
  assert.equal(e3.controlIssue, 99);
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

test("isSuperseded treats a role-mismatched but same-numbered entry as the same lineage (Stage 1 review finding on PR #687)", () => {
  // Session A guessed #668 was the control issue; session B, dispatched later for the exact same
  // real-world lineage, correctly learned it is the execution issue. Before the role-neutral fix,
  // these two entries keyed as `control:668`/`execution:668` and never superseded each other, so
  // the predecessor was never reconciled.
  const guessedControl = { path: "/a", controlIssue: 668, executionIssue: null, sessionKey: "sa", lastConfirmedAt: "2026-01-01T00:00:00.000Z" };
  const guessedExecution = { path: "/b", controlIssue: null, executionIssue: 668, sessionKey: "sb", lastConfirmedAt: "2026-01-02T00:00:00.000Z" };
  assert.equal(isSuperseded(guessedControl, [guessedControl, guessedExecution]), true);
});

test("isDurablyObsolete requires BOTH provable durability (merged into default) AND independent staleness -- neither alone is obsolescence proof (Stage 2 audit finding on #686)", () => {
  const live = { path: "/p", headCommit: "c1", branch: "b" };
  const now = "2026-01-01T12:00:00.000Z";
  const oldActivity = "2020-01-01T00:00:00.000Z";
  const recentActivity = "2026-01-01T11:59:00.000Z"; // 1 minute before `now`

  const mergedAndStale = { resolveDefaultBranchRef: () => "refs/heads/main", isAncestor: () => true, worktreeLastActivityAt: () => oldActivity };
  assert.equal(isDurablyObsolete(mergedAndStale, "/repo", live, now, DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS), true);

  const mergedButRecent = { resolveDefaultBranchRef: () => "refs/heads/main", isAncestor: () => true, worktreeLastActivityAt: () => recentActivity };
  assert.equal(isDurablyObsolete(mergedButRecent, "/repo", live, now, DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS), false, "recently-active state is never obsolete merely because it is merged");

  const staleButUnmerged = { resolveDefaultBranchRef: () => "refs/heads/main", isAncestor: () => false, worktreeLastActivityAt: () => oldActivity };
  assert.equal(isDurablyObsolete(staleButUnmerged, "/repo", live, now, DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS), false, "unmerged state is never obsolete merely because it looks stale");

  const unknownActivity = { resolveDefaultBranchRef: () => "refs/heads/main", isAncestor: () => true, worktreeLastActivityAt: () => null };
  assert.equal(isDurablyObsolete(unknownActivity, "/repo", live, now, DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS), false, "unknown activity evidence fails closed to not-obsolete");
});

test("isDurablyObsolete recognizes squash-merge content-equivalence when raw ancestry cannot (Stage 1 review finding on PR #687)", () => {
  // This repository's own normal merge path is squash-merge: the branch's own commit is NEVER an
  // ancestor of the default branch afterward, only content-equivalent to a new commit on it.
  const live = { path: "/p", headCommit: "c1", branch: "b" };
  const now = "2026-01-01T12:00:00.000Z";
  const oldActivity = "2020-01-01T00:00:00.000Z";

  const squashMergedAndStale = {
    resolveDefaultBranchRef: () => "refs/heads/main",
    isAncestor: () => false,
    isContentMergedIntoDefault: () => true,
    worktreeLastActivityAt: () => oldActivity,
  };
  assert.equal(isDurablyObsolete(squashMergedAndStale, "/repo", live, now, DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS), true);

  const neitherAncestorNorContentMerged = {
    resolveDefaultBranchRef: () => "refs/heads/main",
    isAncestor: () => false,
    isContentMergedIntoDefault: () => false,
    worktreeLastActivityAt: () => oldActivity,
  };
  assert.equal(isDurablyObsolete(neitherAncestorNorContentMerged, "/repo", live, now, DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS), false);

  // A git double that never implements isContentMergedIntoDefault at all (e.g. an older test
  // double) must not throw -- it is treated as "not content-merged" rather than a hard failure.
  const noContentMergeMethod = { resolveDefaultBranchRef: () => "refs/heads/main", isAncestor: () => false, worktreeLastActivityAt: () => oldActivity };
  assert.equal(isDurablyObsolete(noContentMergeMethod, "/repo", live, now, DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS), false);
});

test("isDurablyObsolete folds in the ledger entry's own lastConfirmedAt as an additional liveness signal (Stage 1 review finding on PR #687)", () => {
  // git-administrative mtime is never refreshed by read-only activity (running tests, reviewing,
  // reading files) -- only checkout/commit operations touch it. A predecessor that registered
  // itself (proving it was genuinely alive at that moment) more recently than its own stale HEAD
  // mtime must not be misread as obsolete on HEAD mtime alone.
  const live = { path: "/p", headCommit: "c1", branch: "b" };
  const now = "2026-01-01T12:00:00.000Z";
  const staleHeadMtime = "2020-01-01T00:00:00.000Z";
  const recentlyConfirmed = "2026-01-01T11:59:00.000Z"; // 1 minute before `now`
  const staleConfirmed = "2020-01-01T00:00:00.000Z";
  const git = { resolveDefaultBranchRef: () => "refs/heads/main", isAncestor: () => true, worktreeLastActivityAt: () => staleHeadMtime };

  assert.equal(
    isDurablyObsolete(git, "/repo", live, now, DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS, recentlyConfirmed),
    false,
    "a recent ledger self-confirmation must count as activity even when HEAD mtime looks stale",
  );
  assert.equal(
    isDurablyObsolete(git, "/repo", live, now, DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS, staleConfirmed),
    true,
    "a stale ledger confirmation does not itself block obsolescence when HEAD mtime is also stale",
  );
  assert.equal(
    isDurablyObsolete(git, "/repo", live, now, DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS, null),
    true,
    "omitting entryLastConfirmedAt (e.g. the legacy/unattributed branch, which has no ledger entry) behaves exactly as before",
  );
});

function fakeGit({
  removals = {},
  mergedCommits = new Set(),
  // Commits durably merged only via squash-merge content-equivalence, never raw ancestry -- a
  // separate set so tests can exercise the two durability paths independently (Stage 1 review
  // finding on PR #687).
  squashMergedCommits = new Set(),
  defaultRef = "refs/heads/main",
  // Default every candidate to "long stale" so existing tests that don't care about the
  // staleness gate (finding 1, PR #683) keep exercising the merged/clean/locked logic they were
  // written for; tests that specifically cover the staleness gate override this per-path.
  lastActivityAt = {},
  defaultLastActivityAt = "2020-01-01T00:00:00.000Z",
  checkRemovableResults = {},
} = {}) {
  const removed = [];
  const checked = [];
  return {
    removeWorktree(_cwd, path) {
      removed.push(path);
      const forced = removals[path];
      if (forced) return forced;
      return { ok: true };
    },
    checkRemovable(_cwd, path) {
      checked.push(path);
      const forced = checkRemovableResults[path];
      if (forced) return forced;
      return { ok: true };
    },
    resolveDefaultBranchRef() {
      return defaultRef;
    },
    isAncestor(_cwd, commit) {
      return mergedCommits.has(commit);
    },
    isContentMergedIntoDefault(_cwd, commit) {
      return squashMergedCommits.has(commit);
    },
    worktreeLastActivityAt(_cwd, path) {
      return Object.prototype.hasOwnProperty.call(lastActivityAt, path) ? lastActivityAt[path] : defaultLastActivityAt;
    },
    prune() {},
    _removed: removed,
    _checked: checked,
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

test("reconcile: legacy unattributed worktree is reclaimed only when merged, clean, AND independently proven stale", () => {
  const path = "/repo/.claude/worktrees/new-session-old";
  const merged = fakeGit({ mergedCommits: new Set(["mergedsha"]), lastActivityAt: { [path]: "2020-01-01T00:00:00.000Z" } });
  const { outcomes: mergedOutcomes } = reconcile({
    ledger: [],
    liveWorktrees: [{ path, headCommit: "mergedsha", branch: "old", locked: false }],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git: merged,
    now: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(mergedOutcomes.legacyReclaimed, [path]);

  const unmerged = fakeGit({ mergedCommits: new Set(), lastActivityAt: { [path]: "2020-01-01T00:00:00.000Z" } });
  const { outcomes: unmergedOutcomes } = reconcile({
    ledger: [],
    liveWorktrees: [{ path, headCommit: "unmergedsha", branch: "old", locked: false }],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git: unmerged,
    now: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(unmergedOutcomes.legacyRetained, [path]);
  assert.deepEqual(unmerged._removed, []);
});

test("reconcile: a merged, clean, but recently-active unregistered worktree is retained -- staleness evidence is required, not merely merged/clean state (Stage 1 review, PR #683)", () => {
  const path = "/repo/.claude/worktrees/new-session-just-created";
  const now = "2026-01-01T12:00:00.000Z";
  // Its own administrative activity is only 1 minute old -- well inside the default grace
  // period -- reproducing a session whose own preflight has not yet registered it.
  const recentlyActive = fakeGit({ mergedCommits: new Set(["mergedsha"]), lastActivityAt: { [path]: "2026-01-01T11:59:00.000Z" } });
  const { outcomes } = reconcile({
    ledger: [],
    liveWorktrees: [{ path, headCommit: "mergedsha", branch: "fresh", locked: false }],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git: recentlyActive,
    now,
  });
  assert.deepEqual(outcomes.legacyRetained, [path]);
  assert.deepEqual(recentlyActive._removed, [], "a recently-active unregistered worktree must never actually be removed");
});

test("reconcile: an unregistered worktree whose staleness cannot be determined fails closed to retention", () => {
  const path = "/repo/.claude/worktrees/new-session-unknown-activity";
  const unknownActivity = fakeGit({ mergedCommits: new Set(["mergedsha"]), lastActivityAt: { [path]: null } });
  const { outcomes } = reconcile({
    ledger: [],
    liveWorktrees: [{ path, headCommit: "mergedsha", branch: "old", locked: false }],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git: unknownActivity,
    now: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(outcomes.legacyRetained, [path]);
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

test("reconcile: a superseded same-lineage predecessor that is NOT independently proven durable/stale remains active -- a newer registration establishes ordering, never obsolescence (Stage 2 audit finding on #686)", () => {
  // Plain fakeGit() defaults mergedCommits to empty -- this predecessor's own commit is never
  // proven to be an ancestor of the default branch, i.e. never proven durable -- even though a
  // newer entry for the same lineage was registered a full day later.
  const git = fakeGit();
  const ledger = [
    { path: "/repo/.claude/worktrees/p", sessionKey: "s1", branch: "b", commit: "x", controlIssue: 1, lastConfirmedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/repo/.claude/worktrees/current", sessionKey: "s2", branch: "b2", controlIssue: 1, lastConfirmedAt: "2026-01-02T00:00:00.000Z" },
  ];
  const { outcomes } = reconcile({
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
  assert.deepEqual(outcomes.retainedActive, ["/repo/.claude/worktrees/p"], "registration order alone must never make an unproven-obsolete predecessor removal-eligible");
  assert.deepEqual(git._removed, []);
});

test("reconcile: a superseded, locked predecessor is retained (never force-unlocked)", () => {
  const git = fakeGit({ mergedCommits: new Set(["x"]) });
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
  const git = fakeGit({ mergedCommits: new Set(["x"]), removals: { "/repo/.claude/worktrees/p": { ok: false, reason: "contains modified or untracked files" } } });
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

test("reconcile: a superseded, clean predecessor is retired only once independently proven durable AND stale, and its branch/commit is untouched by the ledger (Stage 2 audit finding on #686)", () => {
  const git = fakeGit({ mergedCommits: new Set(["c1"]) });
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

test("reconcile: a superseded, clean predecessor squash-merged into default is retired even though raw ancestry cannot see it (Stage 1 review finding on PR #687)", () => {
  // `mergedCommits` is deliberately empty -- only `squashMergedCommits` proves durability here,
  // reproducing this repository's own normal squash-merge path, where the branch's own commit is
  // never an ancestor of the default branch afterward.
  const git = fakeGit({ mergedCommits: new Set(), squashMergedCommits: new Set(["c1"]) });
  const ledger = [
    { path: "/repo/.claude/worktrees/p", sessionKey: "s1", branch: "b", commit: "c1", controlIssue: 1, lastConfirmedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/repo/.claude/worktrees/current", sessionKey: "s2", branch: "b2", controlIssue: 1, lastConfirmedAt: "2026-01-02T00:00:00.000Z" },
  ];
  const { outcomes } = reconcile({
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
});

test("reconcile: a role-mismatched same-numbered predecessor (guessed controlIssue vs. guessed executionIssue) is still recognized as superseded and retired (Stage 1 review finding on PR #687)", () => {
  const git = fakeGit({ mergedCommits: new Set(["c1"]) });
  const ledger = [
    { path: "/repo/.claude/worktrees/p", sessionKey: "s1", branch: "b", commit: "c1", controlIssue: 668, executionIssue: null, lastConfirmedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/repo/.claude/worktrees/current", sessionKey: "s2", branch: "b2", controlIssue: null, executionIssue: 668, lastConfirmedAt: "2026-01-02T00:00:00.000Z" },
  ];
  const { outcomes } = reconcile({
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
});

test("reconcile: --dry-run reports a would-be retirement without ever calling the real removal, and the superseded predecessor is untouched (Stage 1 review, PR #683)", () => {
  const git = fakeGit({ mergedCommits: new Set(["c1"]) });
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
    dryRun: true,
  });
  assert.deepEqual(outcomes.retired, ["/repo/.claude/worktrees/p"], "dry-run still reports what WOULD be retired");
  assert.deepEqual(git._removed, [], "dry-run must never invoke the real (mutating) removeWorktree");
  assert.deepEqual(git._checked, ["/repo/.claude/worktrees/p"], "dry-run uses the non-mutating check instead");
  const entry = next.find((e) => e.path === "/repo/.claude/worktrees/p");
  assert.equal(entry.outcome, "retired", "the in-memory outcome reflects the dry-run result, but runPreflight never persists it (see e2e dry-run test)");
});

test("reconcile: --dry-run also suppresses the real removal for the legacy/unattributed path", () => {
  const path = "/repo/.claude/worktrees/new-session-old";
  const git = fakeGit({ mergedCommits: new Set(["mergedsha"]), lastActivityAt: { [path]: "2020-01-01T00:00:00.000Z" } });
  const { outcomes } = reconcile({
    ledger: [],
    liveWorktrees: [{ path, headCommit: "mergedsha", branch: "old", locked: false }],
    currentPath: "/repo/.claude/worktrees/current",
    primaryPath: "/repo",
    managedRoot: "/repo/.claude/worktrees",
    git,
    now: "2026-01-01T00:00:00.000Z",
    dryRun: true,
  });
  assert.deepEqual(outcomes.legacyReclaimed, [path]);
  assert.deepEqual(git._removed, []);
  assert.deepEqual(git._checked, [path]);
});

test("reconcile is idempotent: retiring the same predecessor twice reports already_absent the second time", () => {
  const git = fakeGit({ mergedCommits: new Set(["x"]) });
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

test("loadLedger/saveLedger round-trip; a genuinely missing ledger loads empty but a corrupt PRESENT one throws (Stage 1 review, PR #683)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-worktree-ledger-"));
  try {
    const path = ledgerPathFor(join(dir, ".git"));
    assert.equal(loadLedger(path).length, 0, "a genuinely missing ledger file loads as empty -- the legitimate first-run case");

    saveLedger(path, [{ path: "/x" }]);
    assert.deepEqual(loadLedger(path), [{ path: "/x" }]);

    mkdirSync(join(dir, ".git", "ldl"), { recursive: true });
    writeFileSync(path, "not json", "utf8");
    assert.throws(
      () => loadLedger(path),
      /corrupt/i,
      "a ledger file that EXISTS but is unparseable must fail the whole run closed with an error, never silently substitute an empty ledger",
    );

    writeFileSync(path, JSON.stringify({ not: "an array" }), "utf8");
    assert.throws(() => loadLedger(path), /corrupt/i, "a present but non-array ledger also fails closed rather than silently becoming []");
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

test("end-to-end: two CLEAN same-lineage worktrees, one registered later -- the older is retained, never removed merely because a newer registration exists (Stage 2 audit finding on #686)", () => {
  const repo = makeRepo();
  try {
    const worktreesRoot = join(repo, ".claude", "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });

    const predecessorPath = join(worktreesRoot, "new-session-predecessor").replace(/\\/g, "/");
    const currentPath = join(worktreesRoot, "agent-current").replace(/\\/g, "/");

    git(repo, ["worktree", "add", "-b", "predecessor-branch", predecessorPath]);
    git(repo, ["worktree", "add", "-b", "current-branch", currentPath]);

    // Register the predecessor under a control-issue lineage, then register `current` under the
    // SAME lineage with a later timestamp -- reproducing the #639/#638 correction-chain shape (PR
    // A's session worktree superseded by a fresh session for the same control lineage). This is
    // also the documented MANDATORY invocation shape: both calls supply the control-issue
    // identity this session's own dispatch already names.
    const args1 = { "control-issue": "42" };
    const result1 = runPreflight({ args: { ...args1, _: ["register"], path: predecessorPath }, cwd: predecessorPath, now: "2026-01-01T00:00:00.000Z" });
    assert.equal(result1.exitCode, 0);

    // The predecessor worktree was created moments ago (real git-administrative activity is
    // fresh), and this preflight run's own `now` is a fabricated PAST timestamp relative to that
    // real activity -- standing in for "the predecessor session might still genuinely be running
    // right now". Both worktrees are clean. A newer same-lineage registration existing is not, by
    // itself, proof the predecessor is done: it must remain retained-active rather than being
    // removed on ordering alone (the exact defect the #686 Stage 2 audit found in PR #683's
    // original supersession rule).
    const preflight = runPreflight({ args: { "control-issue": "42" }, cwd: currentPath, now: "2026-01-02T00:00:00.000Z" });
    assert.equal(preflight.exitCode, 0);
    assert.deepEqual(preflight.result.retired, [], "a still-recently-active same-lineage predecessor must never be retired merely because a newer registration exists");
    assert.deepEqual(preflight.result.retainedActive, [predecessorPath]);

    assert.equal(existsSync(predecessorPath), true, "the still-active predecessor checkout survives");
    assert.equal(existsSync(currentPath), true, "the current session's own checkout is always excluded");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("end-to-end: a superseded same-lineage predecessor retires once independently proven durable AND stale, not merely because a newer registration exists (Stage 2 audit finding on #686)", () => {
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

    const args1 = { "control-issue": "42" };
    runPreflight({ args: { ...args1, _: ["register"], path: predecessorPath }, cwd: predecessorPath, now: "2026-01-01T00:00:00.000Z" });
    runPreflight({ args: { ...args1, _: ["register"], path: dirtyPath }, cwd: dirtyPath, now: "2026-01-01T00:00:05.000Z" });

    // Real wall-clock `now`, and the obsolescence grace period explicitly collapsed to zero,
    // stand in for "enough real time has passed to independently prove the predecessor is no
    // longer active" -- the same pattern the pre-existing legacy-reclamation e2e test below
    // already uses. Neither worktree diverged from `main`, so both are trivially provable
    // ancestors of it (durability); with staleness now trivially satisfied too, the clean
    // predecessor becomes genuinely removal-eligible.
    const preflight = runPreflight({ args: { "control-issue": "42", "obsolescence-grace-period-ms": "0" }, cwd: currentPath, now: new Date().toISOString() });
    assert.equal(preflight.exitCode, 0);
    assert.deepEqual(preflight.result.retired, [predecessorPath]);
    assert.equal(preflight.result.retainedDirty.length, 1);
    assert.equal(preflight.result.retainedDirty[0].path, dirtyPath);

    assert.equal(existsSync(predecessorPath), false, "the superseded, clean, durably-obsolete predecessor checkout was actually removed from disk");
    assert.equal(existsSync(dirtyPath), true, "the dirty predecessor checkout was left untouched");
    assert.equal(existsSync(currentPath), true, "the current session's own checkout is always excluded");

    const worktreesAfter = git(repo, ["worktree", "list"]);
    assert.ok(!worktreesAfter.includes("new-session-predecessor"), "git itself no longer lists the retired worktree");
    assert.ok(worktreesAfter.includes("dirty-branch"), "the dirty worktree's branch is still checked out");

    // Idempotence: a second preflight run from `current` must not error and must report the
    // already-removed predecessor as already_absent rather than attempting it again.
    const second = runPreflight({ args: { "control-issue": "42", "obsolescence-grace-period-ms": "0" }, cwd: currentPath, now: new Date().toISOString() });
    assert.equal(second.exitCode, 0);
    assert.deepEqual(second.result.retired, []);
    assert.deepEqual(second.result.alreadyAbsent, [predecessorPath]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("end-to-end: --legacy-grace-period-ms is still honored as a compatibility alias for the renamed --obsolescence-grace-period-ms, which takes precedence when both are supplied (Stage 1 review finding on PR #687)", () => {
  const repo = makeRepo();
  try {
    const worktreesRoot = join(repo, ".claude", "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });

    const predecessorPath = join(worktreesRoot, "new-session-predecessor").replace(/\\/g, "/");
    const currentPath = join(worktreesRoot, "agent-current").replace(/\\/g, "/");

    git(repo, ["worktree", "add", "-b", "predecessor-branch", predecessorPath]);
    git(repo, ["worktree", "add", "-b", "current-branch", currentPath]);

    const args1 = { "control-issue": "77" };
    runPreflight({ args: { ...args1, _: ["register"], path: predecessorPath }, cwd: predecessorPath, now: "2026-01-01T00:00:00.000Z" });

    // Old alias alone, collapsed to zero: still honored, not silently ignored in favor of the
    // untouched 30-minute default.
    const viaAlias = runPreflight({ args: { "control-issue": "77", "legacy-grace-period-ms": "0" }, cwd: currentPath, now: new Date().toISOString() });
    assert.equal(viaAlias.exitCode, 0);
    assert.deepEqual(viaAlias.result.retired, [predecessorPath], "the pre-rename flag name must still take effect, not silently fall back to the default window");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("end-to-end: --obsolescence-grace-period-ms takes precedence over --legacy-grace-period-ms when both are supplied", () => {
  const repo = makeRepo();
  try {
    const worktreesRoot = join(repo, ".claude", "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });

    const predecessorPath = join(worktreesRoot, "new-session-predecessor").replace(/\\/g, "/");
    const currentPath = join(worktreesRoot, "agent-current").replace(/\\/g, "/");

    git(repo, ["worktree", "add", "-b", "predecessor-branch", predecessorPath]);
    git(repo, ["worktree", "add", "-b", "current-branch", currentPath]);

    const args1 = { "control-issue": "78" };
    runPreflight({ args: { ...args1, _: ["register"], path: predecessorPath }, cwd: predecessorPath, now: "2026-01-01T00:00:00.000Z" });

    // The alias says "collapse to zero"; the current flag name says "keep the huge default
    // window". The current name must win, so the predecessor is retained, not retired.
    const bothSupplied = runPreflight({
      args: { "control-issue": "78", "legacy-grace-period-ms": "0", "obsolescence-grace-period-ms": String(DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS * 1000) },
      cwd: currentPath,
      now: new Date().toISOString(),
    });
    assert.equal(bothSupplied.exitCode, 0);
    assert.deepEqual(bothSupplied.result.retired, [], "the current flag name must take precedence over the deprecated alias, not the other way around");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("end-to-end: a predecessor whose branch was squash-merged for real (git merge --squash) becomes durably obsolete via content-equivalence, never via raw ancestry (Stage 1 review finding on PR #687)", () => {
  const repo = makeRepo();
  try {
    const worktreesRoot = join(repo, ".claude", "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });

    const predecessorPath = join(worktreesRoot, "new-session-squashed").replace(/\\/g, "/");
    const currentPath = join(worktreesRoot, "agent-current-squash").replace(/\\/g, "/");

    git(repo, ["worktree", "add", "-b", "squash-feature-branch", predecessorPath]);
    // Two commits on the feature branch, so a per-commit `git cherry` comparison against a single
    // squashed commit on main could never match -- only a total-diff content comparison can.
    writeFileSync(join(predecessorPath, "feature-a.txt"), "a\n");
    git(predecessorPath, ["add", "."]);
    git(predecessorPath, ["commit", "-q", "-m", "feature commit 1"]);
    writeFileSync(join(predecessorPath, "feature-b.txt"), "b\n");
    git(predecessorPath, ["add", "."]);
    git(predecessorPath, ["commit", "-q", "-m", "feature commit 2"]);
    const featureHead = git(predecessorPath, ["rev-parse", "HEAD"]);

    // Squash-merge the feature branch into `main` from the primary checkout, exactly this
    // repository's own normal merge path -- the resulting commit on `main` has no ancestry link
    // back to `featureHead` at all.
    git(repo, ["merge", "--squash", "squash-feature-branch"]);
    git(repo, ["commit", "-q", "-m", "Squash-merge squash-feature-branch"]);
    const mergeCommitIsAncestor = (() => {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", featureHead, "main"], { cwd: repo });
        return true;
      } catch {
        return false;
      }
    })();
    assert.equal(mergeCommitIsAncestor, false, "sanity check: the feature branch's own commit must NOT be an ancestor of main after a squash merge");

    git(repo, ["worktree", "add", "-b", "current-squash-branch", currentPath]);

    runPreflight({ args: { "control-issue": "91", _: ["register"], path: predecessorPath }, cwd: predecessorPath, now: "2026-01-01T00:00:00.000Z" });

    const preflight = runPreflight({ args: { "control-issue": "91", "obsolescence-grace-period-ms": "0" }, cwd: currentPath, now: new Date().toISOString() });
    assert.equal(preflight.exitCode, 0);
    assert.deepEqual(preflight.result.retired, [predecessorPath], "a genuinely squash-merged predecessor must be reclaimed via content-equivalence, not left to accumulate forever");
    assert.equal(existsSync(predecessorPath), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("end-to-end: the bare no-argument form can never reconcile a same-lineage predecessor -- the mandatory startup invocation must supply the known control/execution identity explicitly (Stage 2 audit finding on #686)", () => {
  const repo = makeRepo();
  try {
    const worktreesRoot = join(repo, ".claude", "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });
    const predecessorPath = join(worktreesRoot, "new-session-predecessor-bare").replace(/\\/g, "/");
    const currentPath = join(worktreesRoot, "agent-current-bare").replace(/\\/g, "/");

    git(repo, ["worktree", "add", "-b", "predecessor-bare-branch", predecessorPath]);
    git(repo, ["worktree", "add", "-b", "current-bare-branch", currentPath]);

    // The predecessor session ran the BARE, argument-less form the pre-#686-correction AGENTS.md
    // text authorized as the normal fresh-session invocation, even though a control/execution
    // Issue number was in fact knowable to its own dispatch prompt.
    const predecessorRun = runPreflight({ args: {}, cwd: predecessorPath, now: "2026-01-01T00:00:00.000Z" });
    assert.equal(predecessorRun.exitCode, 0);

    // A fresh session for the SAME logical lineage later also runs the bare form.
    const currentRun = runPreflight({ args: {}, cwd: currentPath, now: "2026-01-02T00:00:00.000Z" });
    assert.equal(currentRun.exitCode, 0);
    // Each bare invocation falls back to its own never-shared session-scoped lineage key
    // (`session:<path-basename>-<timestamp>`), so the two sessions can never recognize each other
    // as the same lineage -- the predecessor is left retained-active indefinitely, reproducing the
    // accumulation gap #686 found in the previously-documented mandatory form.
    assert.deepEqual(currentRun.result.retired, [], "the bare form can never supersede a predecessor -- known lineage identity must be supplied explicitly");
    assert.deepEqual(currentRun.result.retainedActive, [predecessorPath]);
    assert.equal(existsSync(predecessorPath), true);
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

test("end-to-end: a fully merged legacy worktree with no ledger entry is reclaimed once independently proven stale", () => {
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

    // A real, just-created worktree's own administrative activity is only moments old, so under
    // the DEFAULT grace period it must be retained -- merged/clean alone is not staleness
    // evidence (Stage 1 review finding on PR #683).
    const tooRecent = runPreflight({ args: {}, cwd: currentPath, now: new Date().toISOString() });
    assert.equal(tooRecent.exitCode, 0);
    assert.deepEqual(tooRecent.result.legacyRetained, [legacyPath]);
    assert.equal(existsSync(legacyPath), true, "a recently-created legacy worktree survives the default grace period");

    // With the grace period explicitly collapsed to zero (this run stands in for "enough real
    // time has passed"), the same merged/clean worktree is now reclaimed.
    const result = runPreflight({ args: { "obsolescence-grace-period-ms": "0" }, cwd: currentPath, now: new Date().toISOString() });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.result.legacyReclaimed, [legacyPath]);
    assert.equal(existsSync(legacyPath), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("end-to-end: a superseded DETACHED-HEAD predecessor retires -- registration and live enumeration must agree on detached state (Stage 1 review, PR #683)", () => {
  const repo = makeRepo();
  try {
    const worktreesRoot = join(repo, ".claude", "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });

    const predecessorPath = join(worktreesRoot, "agent-detached-predecessor").replace(/\\/g, "/");
    const currentPath = join(worktreesRoot, "agent-current").replace(/\\/g, "/");

    // Detach HEAD in the predecessor worktree (no branch checked out), exactly what
    // `git worktree list --porcelain` reports as `branch: null`.
    const headCommit = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["worktree", "add", "--detach", predecessorPath, headCommit]);
    git(repo, ["worktree", "add", "-b", "current-branch", currentPath]);

    const args1 = { "control-issue": "68" };
    const result1 = runPreflight({ args: { ...args1, _: ["register"], path: predecessorPath }, cwd: predecessorPath, now: "2026-01-01T00:00:00.000Z" });
    assert.equal(result1.exitCode, 0);
    assert.equal(result1.result.registered.branch, null, "a detached predecessor registers with branch: null, not the literal string HEAD");

    // Real wall-clock `now` plus a collapsed grace period stand in for "enough time has passed to
    // independently prove the predecessor obsolete" (Stage 2 audit finding on #686) -- the point
    // of this test is detached-HEAD normalization, not the durability/staleness gate itself.
    const preflight = runPreflight({ args: { "control-issue": "68", "obsolescence-grace-period-ms": "0" }, cwd: currentPath, now: new Date().toISOString() });
    assert.equal(preflight.exitCode, 0);
    assert.deepEqual(preflight.result.retainedAmbiguous, [], "a genuinely unchanged detached predecessor must never be misclassified as ambiguous");
    assert.deepEqual(preflight.result.retired, [predecessorPath], "the superseded detached predecessor is retireable, closing the accumulation gap for repeated detached Dispatch sessions");
    assert.equal(existsSync(predecessorPath), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("end-to-end: a new session reusing the PERSISTENT PRIMARY checkout without IDs cannot inherit stale lineage and supersede an active sibling worktree (Stage 1 review, PR #683)", () => {
  const repo = makeRepo();
  try {
    const worktreesRoot = join(repo, ".claude", "worktrees");
    mkdirSync(worktreesRoot, { recursive: true });
    const siblingPath = join(worktreesRoot, "agent-active-sibling").replace(/\\/g, "/");
    git(repo, ["worktree", "add", "-b", "sibling-branch", siblingPath]);

    // An earlier session ran the preflight from the PRIMARY checkout itself while associated
    // with control-issue 68 (a plausible top-level-controller invocation).
    const primaryFirst = runPreflight({ args: { "control-issue": "68", "session-key": "session-old" }, cwd: repo, now: "2026-01-01T00:00:00.000Z" });
    assert.equal(primaryFirst.exitCode, 0);

    // A genuinely active worktree for the SAME control issue registers itself later -- it is now
    // the newest (non-superseded) member of lineage control:68.
    const siblingReg = runPreflight({ args: { "control-issue": "68" }, cwd: siblingPath, now: "2026-01-01T00:00:05.000Z" });
    assert.equal(siblingReg.exitCode, 0);
    assert.deepEqual(siblingReg.result.retired, []);

    // A completely UNRELATED fresh session later runs the plain, documented no-ID invocation
    // from the persistent primary checkout again -- it repeats neither --session-key nor
    // --control-issue.
    const newSession = runPreflight({ args: {}, cwd: repo, now: "2026-01-02T00:00:00.000Z" });
    assert.equal(newSession.exitCode, 0);
    // The primary's own re-registration must not inherit control-issue 68's lineage, so it must
    // never make `siblingPath` -- a genuinely active worktree for that lineage -- look superseded
    // and eligible for removal (the exact defect Stage 1 review found on PR #683).
    assert.deepEqual(newSession.result.retired, [], "the active sibling from the OLD lineage must never be retired just because an unrelated new session reused the primary checkout's path");
    assert.equal(existsSync(siblingPath), true);
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
