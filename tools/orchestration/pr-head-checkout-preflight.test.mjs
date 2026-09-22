import test from "node:test";
import assert from "node:assert/strict";

import { classifyCheckoutBinding, defaultNewWorktreePath, run } from "./pr-head-checkout-preflight.mjs";

const TARGET_HEAD = { branch: "worktree-agent-acf4c07f63a440346", sha: "cccccccccccccccccccccccccccccccccccccc" };
const PRIMARY = "C:/Loop-Dee-Loup";

// -------------------------------------------------------------------------------------------
// classifyCheckoutBinding -- pure decision
// -------------------------------------------------------------------------------------------

test("classifyCheckoutBinding: OPERATIONAL_ERROR when the target head cannot be resolved", () => {
  const result = classifyCheckoutBinding({
    targetHead: { branch: null, sha: null },
    currentCheckout: { path: PRIMARY, branch: "main", sha: "aaa" },
    liveWorktrees: [],
    primaryPath: PRIMARY,
  });
  assert.equal(result.verdict, "OPERATIONAL_ERROR");
});

test("classifyCheckoutBinding: ALREADY_AT_HEAD when the invoking checkout already matches branch, commit, and is proven clean", () => {
  const path = `${PRIMARY}/.claude/worktrees/agent-1`;
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path, branch: TARGET_HEAD.branch, sha: TARGET_HEAD.sha, dirty: false },
    liveWorktrees: [{ path, headCommit: TARGET_HEAD.sha, branch: TARGET_HEAD.branch, locked: false, dirty: false }],
    primaryPath: PRIMARY,
  });
  assert.deepEqual(result, { verdict: "ALREADY_AT_HEAD", path });
});

test("classifyCheckoutBinding: DIRTY_CANDIDATE when the invoking checkout matches branch/commit but has local modifications (never ALREADY_AT_HEAD)", () => {
  const path = `${PRIMARY}/.claude/worktrees/agent-1b`;
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path, branch: TARGET_HEAD.branch, sha: TARGET_HEAD.sha, dirty: true },
    liveWorktrees: [{ path, headCommit: TARGET_HEAD.sha, branch: TARGET_HEAD.branch, locked: false, dirty: true }],
    primaryPath: PRIMARY,
  });
  assert.equal(result.verdict, "DIRTY_CANDIDATE");
  assert.equal(result.path, path);
  assert.match(result.reason, /local modifications/);
});

test("classifyCheckoutBinding: DIRTY_CANDIDATE when the invoking checkout's own cleanliness is unknown (fails closed)", () => {
  const path = `${PRIMARY}/.claude/worktrees/agent-1c`;
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path, branch: TARGET_HEAD.branch, sha: TARGET_HEAD.sha, dirty: null },
    liveWorktrees: [{ path, headCommit: TARGET_HEAD.sha, branch: TARGET_HEAD.branch, locked: false, dirty: null }],
    primaryPath: PRIMARY,
  });
  assert.equal(result.verdict, "DIRTY_CANDIDATE");
  assert.match(result.reason, /could not be determined/);
});

// Live #690 reproduction shape: session sits on `main` in the primary checkout; no worktree
// anywhere carries the PR branch at all.
test("classifyCheckoutBinding: #690 reproduction -- on main, no matching worktree -- NEEDS_NEW_WORKTREE", () => {
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path: PRIMARY, branch: "main", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    liveWorktrees: [{ path: PRIMARY, headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", branch: "main", locked: false, dirty: false }],
    primaryPath: PRIMARY,
  });
  assert.deepEqual(result, { verdict: "NEEDS_NEW_WORKTREE", branch: TARGET_HEAD.branch, sha: TARGET_HEAD.sha });
});

test("classifyCheckoutBinding: an unrelated branch/worktree is never accepted as the correction target", () => {
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path: PRIMARY, branch: "main", sha: "aaa" },
    liveWorktrees: [
      { path: `${PRIMARY}/.claude/worktrees/other`, headCommit: "bbb", branch: "totally-unrelated-branch", locked: false, dirty: false },
    ],
    primaryPath: PRIMARY,
  });
  assert.equal(result.verdict, "NEEDS_NEW_WORKTREE");
});

test("classifyCheckoutBinding: REUSABLE_WORKTREE_AT_HEAD reuses a clean, unlocked worktree already at the exact target commit", () => {
  const path = `${PRIMARY}/.claude/worktrees/agent-2`;
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path: PRIMARY, branch: "main", sha: "aaa" },
    liveWorktrees: [{ path, headCommit: TARGET_HEAD.sha, branch: TARGET_HEAD.branch, locked: false, dirty: false }],
    primaryPath: PRIMARY,
  });
  assert.deepEqual(result, { verdict: "REUSABLE_WORKTREE_AT_HEAD", path });
});

test("classifyCheckoutBinding: STALE_WORKTREE when the matching worktree is clean but behind the current head", () => {
  const path = `${PRIMARY}/.claude/worktrees/agent-3`;
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path: PRIMARY, branch: "main", sha: "aaa" },
    liveWorktrees: [{ path, headCommit: "olderoldolderoldolderoldolderoldolderold", branch: TARGET_HEAD.branch, locked: false, dirty: false }],
    primaryPath: PRIMARY,
  });
  assert.equal(result.verdict, "STALE_WORKTREE");
  assert.equal(result.path, path);
});

test("classifyCheckoutBinding: DIRTY_CANDIDATE never repurposes a matching worktree with local modifications", () => {
  const path = `${PRIMARY}/.claude/worktrees/agent-4`;
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path: PRIMARY, branch: "main", sha: "aaa" },
    liveWorktrees: [{ path, headCommit: TARGET_HEAD.sha, branch: TARGET_HEAD.branch, locked: false, dirty: true }],
    primaryPath: PRIMARY,
  });
  assert.equal(result.verdict, "DIRTY_CANDIDATE");
});

test("classifyCheckoutBinding: DIRTY_CANDIDATE when the matching worktree's clean state is unknown (fails closed)", () => {
  const path = `${PRIMARY}/.claude/worktrees/agent-5`;
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path: PRIMARY, branch: "main", sha: "aaa" },
    liveWorktrees: [{ path, headCommit: TARGET_HEAD.sha, branch: TARGET_HEAD.branch, locked: false, dirty: null }],
    primaryPath: PRIMARY,
  });
  assert.equal(result.verdict, "DIRTY_CANDIDATE");
  assert.match(result.reason, /could not be determined/);
});

test("classifyCheckoutBinding: BRANCH_OWNED_ELSEWHERE_LOCKED when the matching worktree is locked", () => {
  const path = `${PRIMARY}/.claude/worktrees/agent-6`;
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path: PRIMARY, branch: "main", sha: "aaa" },
    liveWorktrees: [{ path, headCommit: TARGET_HEAD.sha, branch: TARGET_HEAD.branch, locked: true, lockedReason: "in use", dirty: false }],
    primaryPath: PRIMARY,
  });
  assert.deepEqual(result, { verdict: "BRANCH_OWNED_ELSEWHERE_LOCKED", path, reason: "in use" });
});

test("classifyCheckoutBinding: AMBIGUOUS when more than one live worktree reports the target branch", () => {
  const pathA = `${PRIMARY}/.claude/worktrees/agent-7`;
  const pathB = `${PRIMARY}/.claude/worktrees/agent-8`;
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path: PRIMARY, branch: "main", sha: "aaa" },
    liveWorktrees: [
      { path: pathA, headCommit: TARGET_HEAD.sha, branch: TARGET_HEAD.branch, locked: false, dirty: false },
      { path: pathB, headCommit: TARGET_HEAD.sha, branch: TARGET_HEAD.branch, locked: false, dirty: false },
    ],
    primaryPath: PRIMARY,
  });
  assert.equal(result.verdict, "AMBIGUOUS");
  assert.deepEqual(result.paths, [pathA, pathB]);
});

test("classifyCheckoutBinding: NO_SAFE_BINDING when the target branch is already on the primary checkout", () => {
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path: `${PRIMARY}/.claude/worktrees/agent-9`, branch: "main", sha: "aaa" },
    liveWorktrees: [{ path: PRIMARY, headCommit: TARGET_HEAD.sha, branch: TARGET_HEAD.branch, locked: false, dirty: false }],
    primaryPath: PRIMARY,
  });
  assert.equal(result.verdict, "NO_SAFE_BINDING");
});

// Stage 2 audit finding on #695, Finding 2: a clean primary checkout already sitting on the
// exact target branch/commit was reaching ALREADY_AT_HEAD before the primary-path guard (above)
// was ever evaluated for this shape -- the guard only fired in the separate "one other worktree
// carries the branch" branch. This is the regression the audit required.
test("classifyCheckoutBinding: NO_SAFE_BINDING when the invoking checkout IS the primary checkout and already matches the target branch/commit (never ALREADY_AT_HEAD)", () => {
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path: PRIMARY, branch: TARGET_HEAD.branch, sha: TARGET_HEAD.sha, dirty: false },
    liveWorktrees: [{ path: PRIMARY, headCommit: TARGET_HEAD.sha, branch: TARGET_HEAD.branch, locked: false, dirty: false }],
    primaryPath: PRIMARY,
  });
  assert.equal(result.verdict, "NO_SAFE_BINDING");
  assert.equal(result.path, PRIMARY);
});

// Same shape, but the primary checkout is additionally dirty -- the primary-path rejection must
// still take priority over (and be reached before) the dirty check, not merely happen to agree
// with it.
test("classifyCheckoutBinding: NO_SAFE_BINDING when the invoking checkout IS the primary checkout, matches the target branch/commit, and is dirty", () => {
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path: PRIMARY, branch: TARGET_HEAD.branch, sha: TARGET_HEAD.sha, dirty: true },
    liveWorktrees: [{ path: PRIMARY, headCommit: TARGET_HEAD.sha, branch: TARGET_HEAD.branch, locked: false, dirty: true }],
    primaryPath: PRIMARY,
  });
  assert.equal(result.verdict, "NO_SAFE_BINDING");
});

// Stage 1 review finding on PR #696 (Finding P2): a literal `path === primaryPath` comparison
// lets the same primary checkout evade the "never repurpose the primary checkout" guard on
// Windows through case/separator variation alone. These two cases cover both the "invoking
// checkout IS primary" branch and the "one other worktree carries the branch and IS primary"
// branch, each with a differently-spelled but equivalent primary path.
test("classifyCheckoutBinding: NO_SAFE_BINDING when the invoking checkout is the primary checkout under a different case/separator spelling", () => {
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    // Same path as PRIMARY ("C:/Loop-Dee-Loup"), spelled with backslashes and different case.
    currentCheckout: { path: "c:\\loop-dee-loup", branch: TARGET_HEAD.branch, sha: TARGET_HEAD.sha, dirty: false },
    liveWorktrees: [{ path: "c:\\loop-dee-loup", headCommit: TARGET_HEAD.sha, branch: TARGET_HEAD.branch, locked: false, dirty: false }],
    primaryPath: PRIMARY,
  });
  assert.equal(result.verdict, "NO_SAFE_BINDING");
});

test("classifyCheckoutBinding: NO_SAFE_BINDING when the one worktree carrying the target branch is the primary checkout under a different case/separator spelling", () => {
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path: `${PRIMARY}/.claude/worktrees/agent-9`, branch: "main", sha: "aaa" },
    // Same path as PRIMARY, spelled with backslashes and different case.
    liveWorktrees: [{ path: "C:\\LOOP-DEE-LOUP", headCommit: TARGET_HEAD.sha, branch: TARGET_HEAD.branch, locked: false, dirty: false }],
    primaryPath: PRIMARY,
  });
  assert.equal(result.verdict, "NO_SAFE_BINDING");
});

test("classifyCheckoutBinding: a genuinely non-primary worktree at the exact PR head still reaches ALREADY_AT_HEAD/REUSABLE_WORKTREE_AT_HEAD despite path normalization", () => {
  const path = `${PRIMARY}/.claude/worktrees/agent-normalized`;
  const result = classifyCheckoutBinding({
    targetHead: TARGET_HEAD,
    currentCheckout: { path: PRIMARY, branch: "main", sha: "aaa" },
    liveWorktrees: [{ path, headCommit: TARGET_HEAD.sha, branch: TARGET_HEAD.branch, locked: false, dirty: false }],
    primaryPath: PRIMARY,
  });
  assert.deepEqual(result, { verdict: "REUSABLE_WORKTREE_AT_HEAD", path });
});

// -------------------------------------------------------------------------------------------
// defaultNewWorktreePath
// -------------------------------------------------------------------------------------------

test("defaultNewWorktreePath sanitizes the branch name and stays under the primary checkout's managed root", () => {
  const path = defaultNewWorktreePath(PRIMARY, 690, "worktree/agent-acf4c07f63a440346");
  assert.equal(path, `${PRIMARY}/.claude/worktrees/pr-690-worktree-agent-acf4c07f63a440346`);
});

// -------------------------------------------------------------------------------------------
// run() -- CLI wrapper with injected git/gh
// -------------------------------------------------------------------------------------------

function gitStub(overrides = {}) {
  return {
    toplevel: () => PRIMARY,
    currentBranch: () => "main",
    currentCommit: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    worktreeListPorcelain: () => `worktree ${PRIMARY}\nHEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbranch refs/heads/main\n`,
    isDirty: () => false,
    fetchBranch: () => ({ ok: true }),
    ffOnlyMergeToBranch: () => ({ ok: true }),
    establishBranchAtSha: () => ({ ok: true }),
    addExistingBranchWorktree: () => ({ ok: true }),
    localBranchTip: () => null,
    isAncestor: () => true,
    ...overrides,
  };
}

test("run: OPERATIONAL_ERROR (exit 1) when --pr is missing/invalid", async () => {
  const result = await run({ repo: "o/r", pr: null }, { git: gitStub() });
  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, "OPERATIONAL_ERROR");
});

test("run: OPERATIONAL_ERROR (exit 1) when gh pr view fails", async () => {
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      git: gitStub(),
      ghPrViewImpl: async () => {
        throw new Error("gh: not found");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, "OPERATIONAL_ERROR");
});

test("run: #690 reproduction -- primary checkout on main, no matching worktree -- creates a branch worktree at the exact head and exits 0", async () => {
  let addedPath = null;
  let addedBranch = null;
  let casArgs = null;
  let fetchedFrom = null;
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        fetchBranch: (cwd) => {
          fetchedFrom = cwd;
          return { ok: true };
        },
        establishBranchAtSha: (cwd, branch, sha, expectedOldSha) => {
          casArgs = { cwd, branch, sha, expectedOldSha };
          return { ok: true };
        },
        addExistingBranchWorktree: (primaryCwd, path, branch) => {
          addedPath = path;
          addedBranch = branch;
          return { ok: true };
        },
      }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "CREATED_WORKTREE_AT_HEAD");
  assert.equal(addedBranch, TARGET_HEAD.branch);
  assert.equal(addedPath, result.path);
  assert.equal(fetchedFrom, PRIMARY);
  assert.equal(casArgs.branch, TARGET_HEAD.branch);
  assert.equal(casArgs.sha, TARGET_HEAD.sha);
  assert.equal(casArgs.expectedOldSha, null);
  assert.equal(casArgs.cwd, PRIMARY);
});

test("run: created worktree is checked out on a real branch (never detached) so an ordinary git push can reach the PR", async () => {
  let addExistingArgs = null;
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        addExistingBranchWorktree: (primaryCwd, path, branch) => {
          // Mirrors defaultGitImpl's real addExistingBranchWorktree: `worktree add <path>
          // <branch>` (branch already established at the target commit by the preceding CAS)
          // then `branch --set-upstream-to=origin/<branch>` -- captured here only to assert the
          // CALL SHAPE `run()` requests, not to re-implement git plumbing.
          addExistingArgs = { primaryCwd, path, branch };
          return { ok: true };
        },
      }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(addExistingArgs.branch, TARGET_HEAD.branch);
  assert.equal(addExistingArgs.primaryCwd, PRIMARY);
});

test("run: already-correct head is a no-op that reports ALREADY_AT_HEAD (exit 0)", async () => {
  // The invoking checkout is a non-primary worktree already at the target branch/commit -- the
  // primary checkout itself (a separate `main` entry below) is untouched. See the dedicated
  // NO_SAFE_BINDING test below for the case where the invoking checkout IS the primary.
  const agentPath = `${PRIMARY}/.claude/worktrees/agent-current`;
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        toplevel: () => agentPath,
        currentBranch: () => TARGET_HEAD.branch,
        currentCommit: () => TARGET_HEAD.sha,
        worktreeListPorcelain: () =>
          [
            `worktree ${PRIMARY}`,
            "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/main",
            "",
            `worktree ${agentPath}`,
            `HEAD ${TARGET_HEAD.sha}`,
            `branch refs/heads/${TARGET_HEAD.branch}`,
          ].join("\n"),
      }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "ALREADY_AT_HEAD");
  assert.equal(result.path, agentPath);
});

// Stage 2 audit finding on #695, Finding 2, exercised through the `run()` CLI wrapper (the
// `classifyCheckoutBinding` unit tests above cover the same fix at the pure-decision level).
test("run: a clean primary checkout already at the target branch/commit is rejected with NO_SAFE_BINDING, never ALREADY_AT_HEAD (exit 2)", async () => {
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        currentBranch: () => TARGET_HEAD.branch,
        currentCommit: () => TARGET_HEAD.sha,
        worktreeListPorcelain: () => `worktree ${PRIMARY}\nHEAD ${TARGET_HEAD.sha}\nbranch refs/heads/${TARGET_HEAD.branch}\n`,
      }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "NO_SAFE_BINDING");
  assert.equal(result.path, PRIMARY);
});

test("run: reuses an existing clean worktree already at the target head (exit 0, no worktree creation)", async () => {
  const existingPath = `${PRIMARY}/.claude/worktrees/agent-existing`;
  let addCalled = false;
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        worktreeListPorcelain: () =>
          [
            `worktree ${PRIMARY}`,
            "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/main",
            "",
            `worktree ${existingPath}`,
            `HEAD ${TARGET_HEAD.sha}`,
            `branch refs/heads/${TARGET_HEAD.branch}`,
          ].join("\n"),
        addDetachedWorktree: () => {
          addCalled = true;
          return { ok: true };
        },
      }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "REUSABLE_WORKTREE_AT_HEAD");
  assert.equal(result.path, existingPath);
  assert.equal(addCalled, false);
});

test("run: stale-head negative -- fast-forward reconciliation succeeds and reports REUSABLE_WORKTREE_AT_HEAD", async () => {
  const existingPath = `${PRIMARY}/.claude/worktrees/agent-stale`;
  let mergeCalled = false;
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        worktreeListPorcelain: () =>
          [
            `worktree ${PRIMARY}`,
            "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/main",
            "",
            `worktree ${existingPath}`,
            "HEAD olderoldolderoldolderoldolderoldolderold",
            `branch refs/heads/${TARGET_HEAD.branch}`,
          ].join("\n"),
        ffOnlyMergeToBranch: () => {
          mergeCalled = true;
          return { ok: true };
        },
        // After the merge, the worktree's own HEAD reads as the target sha -- `currentCommit`
        // is called generically against the reconciled path.
        currentCommit: (cwd) => (cwd === existingPath ? TARGET_HEAD.sha : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      }),
    },
  );
  assert.equal(mergeCalled, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "REUSABLE_WORKTREE_AT_HEAD");
  assert.equal(result.path, existingPath);
});

test("run: stale-head negative -- non-fast-forward divergence fails closed to STALE_HEAD_MISMATCH (exit 2)", async () => {
  const existingPath = `${PRIMARY}/.claude/worktrees/agent-diverged`;
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        worktreeListPorcelain: () =>
          [
            `worktree ${PRIMARY}`,
            "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/main",
            "",
            `worktree ${existingPath}`,
            "HEAD olderoldolderoldolderoldolderoldolderold",
            `branch refs/heads/${TARGET_HEAD.branch}`,
          ].join("\n"),
        ffOnlyMergeToBranch: () => ({ ok: false, reason: "not possible to fast-forward, aborting" }),
      }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "STALE_HEAD_MISMATCH");
  assert.equal(result.path, existingPath);
});

test("run: dirty candidate negative -- never repurposed, fails closed (exit 2)", async () => {
  const existingPath = `${PRIMARY}/.claude/worktrees/agent-dirty`;
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        worktreeListPorcelain: () =>
          [
            `worktree ${PRIMARY}`,
            "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/main",
            "",
            `worktree ${existingPath}`,
            `HEAD ${TARGET_HEAD.sha}`,
            `branch refs/heads/${TARGET_HEAD.branch}`,
          ].join("\n"),
        isDirty: () => true,
      }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "DIRTY_CANDIDATE");
  assert.equal(result.path, existingPath);
});

test("run: branch-owned-elsewhere (locked) fails closed (exit 2) rather than repurposing", async () => {
  const existingPath = `${PRIMARY}/.claude/worktrees/agent-locked`;
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        worktreeListPorcelain: () =>
          [
            `worktree ${PRIMARY}`,
            "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "branch refs/heads/main",
            "",
            `worktree ${existingPath}`,
            `HEAD ${TARGET_HEAD.sha}`,
            "locked",
            `branch refs/heads/${TARGET_HEAD.branch}`,
          ].join("\n"),
      }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "BRANCH_OWNED_ELSEWHERE_LOCKED");
});

// Stage 2 audit finding on #695, Finding 1: `git worktree add -B <branch> ...` resets an
// existing local branch ref rather than refusing to touch it. These three tests cover the
// safe-proceed, safe-reset, and fail-closed shapes of the new pre-check.

test("run: NEEDS_NEW_WORKTREE proceeds normally when no local branch by that name exists", async () => {
  let casExpectedOldSha = "not-yet-set";
  let addExistingCalled = false;
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        localBranchTip: () => null,
        establishBranchAtSha: (cwd, branch, sha, expectedOldSha) => {
          casExpectedOldSha = expectedOldSha;
          return { ok: true };
        },
        addExistingBranchWorktree: () => {
          addExistingCalled = true;
          return { ok: true };
        },
      }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "CREATED_WORKTREE_AT_HEAD");
  assert.equal(addExistingCalled, true);
  // No local branch was observed -- the CAS must be told to expect absence (`null`), never a
  // fabricated sha, so a concurrently-created branch causes the CAS itself to fail closed.
  assert.equal(casExpectedOldSha, null);
});

test("run: NEEDS_NEW_WORKTREE proceeds when an existing local branch's tip is safely contained in the target head (no unpushed commits would be lost)", async () => {
  let isAncestorArgs = null;
  let casArgs = null;
  let addExistingCalled = false;
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        localBranchTip: () => "olderoldolderoldolderoldolderoldolderold",
        isAncestor: (cwd, ancestorSha, descendantSha) => {
          isAncestorArgs = { cwd, ancestorSha, descendantSha };
          return true;
        },
        establishBranchAtSha: (cwd, branch, sha, expectedOldSha) => {
          casArgs = { cwd, branch, sha, expectedOldSha };
          return { ok: true };
        },
        addExistingBranchWorktree: () => {
          addExistingCalled = true;
          return { ok: true };
        },
      }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "CREATED_WORKTREE_AT_HEAD");
  assert.equal(addExistingCalled, true);
  assert.equal(isAncestorArgs.ancestorSha, "olderoldolderoldolderoldolderoldolderold");
  assert.equal(isAncestorArgs.descendantSha, TARGET_HEAD.sha);
  assert.equal(isAncestorArgs.cwd, PRIMARY);
  // The CAS's expected old value is exactly the observed tip -- a concurrent mover away from
  // this value must make the CAS itself fail, not silently overwrite the newer value.
  assert.equal(casArgs.expectedOldSha, "olderoldolderoldolderoldolderoldolderold");
  assert.equal(casArgs.sha, TARGET_HEAD.sha);
});

test("run: NEEDS_NEW_WORKTREE fails closed to EXISTING_BRANCH_UNSAFE (exit 2) rather than resetting a diverged local branch with unpushed commits, and never calls establishBranchAtSha or addExistingBranchWorktree", async () => {
  let establishCalled = false;
  let addExistingCalled = false;
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        localBranchTip: () => "unpushedunpushedunpushedunpushedunpushed",
        isAncestor: () => false,
        establishBranchAtSha: () => {
          establishCalled = true;
          return { ok: true };
        },
        addExistingBranchWorktree: () => {
          addExistingCalled = true;
          return { ok: true };
        },
      }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "EXISTING_BRANCH_UNSAFE");
  assert.equal(result.branch, TARGET_HEAD.branch);
  assert.equal(establishCalled, false);
  assert.equal(addExistingCalled, false);
});

test("run: NEEDS_NEW_WORKTREE proceeds without an ancestor check when the existing local branch's tip already equals the target sha", async () => {
  let isAncestorCalled = false;
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        localBranchTip: () => TARGET_HEAD.sha,
        isAncestor: () => {
          isAncestorCalled = true;
          return false;
        },
      }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "CREATED_WORKTREE_AT_HEAD");
  assert.equal(isAncestorCalled, false);
});

// Stage 1 review finding on PR #696 (Finding P1): a separate read-then-ancestry check followed
// by an unconditional reset left a TOCTOU window -- a concurrent ref move between observation
// and mutation could still be silently discarded. The atomic `establishBranchAtSha` compare-
// and-swap must itself fail closed when that race is detected, rather than overwriting it.
test("run: NEEDS_NEW_WORKTREE fails closed to EXISTING_BRANCH_UNSAFE (exit 2) when the branch ref changed concurrently between observation and the atomic CAS", async () => {
  let addExistingCalled = false;
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        localBranchTip: () => "olderoldolderoldolderoldolderoldolderold",
        isAncestor: () => true,
        establishBranchAtSha: () => ({ ok: false, reason: "fatal: cannot lock ref: is at a different value" }),
        addExistingBranchWorktree: () => {
          addExistingCalled = true;
          return { ok: true };
        },
      }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "EXISTING_BRANCH_UNSAFE");
  assert.equal(result.branch, TARGET_HEAD.branch);
  assert.equal(addExistingCalled, false);
});

// Stage 1 review finding on PR #696 (Finding P2): a failed branch-existence lookup must never
// be read as "branch absent" -- doing so would authorize the resetting/creation path on
// unproven ground. `localBranchTip` now rethrows anything other than the documented "ref
// absent" exit, and `run` must fail closed on that, distinctly from proceeding.
test("run: NEEDS_NEW_WORKTREE fails closed to NO_SAFE_BINDING (exit 2) when the local-branch-existence lookup itself fails, never treating it as absence", async () => {
  let establishCalled = false;
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        localBranchTip: () => {
          throw new Error("fatal: unable to read ref database");
        },
        establishBranchAtSha: () => {
          establishCalled = true;
          return { ok: true };
        },
      }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "NO_SAFE_BINDING");
  assert.match(result.reason, /unable to read ref database/);
  assert.equal(establishCalled, false);
});

test("run: no safe local binding -- worktree creation itself fails -- reports NO_SAFE_BINDING (exit 2), never a downstream missing-file error", async () => {
  const result = await run(
    { repo: "o/r", pr: 690 },
    {
      ghPrViewImpl: async () => ({ headRefName: TARGET_HEAD.branch, headRefOid: TARGET_HEAD.sha }),
      git: gitStub({
        addExistingBranchWorktree: () => ({ ok: false, reason: "fatal: could not create work tree dir" }),
      }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "NO_SAFE_BINDING");
});

// -------------------------------------------------------------------------------------------
// Regression: current correction breakpoint/finalizer, Stage 1 transition, worktree startup/
// cleanup, and path-scope/control-plane machinery this preflight sits alongside are untouched
// by this module -- it exports no state and mutates nothing at import time.
// -------------------------------------------------------------------------------------------

test("module exposes only the documented pure/CLI surface", async () => {
  const mod = await import("./pr-head-checkout-preflight.mjs");
  assert.equal(typeof mod.classifyCheckoutBinding, "function");
  assert.equal(typeof mod.defaultGitImpl, "function");
  assert.equal(typeof mod.defaultNewWorktreePath, "function");
  assert.equal(typeof mod.run, "function");
});
