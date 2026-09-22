#!/usr/bin/env node
// Deterministic PR-head checkout-binding preflight for Stage 1 correction workers -- issue
// #692 (execution slice for control #691).
//
// Problem this closes: a Stage 1 correction worker resolves the target PR's current head
// metadata correctly, then begins source reads/mutations without ever verifying its own
// writable checkout actually represents that head. Live reproduction (PR #690 / execution
// #685 / control #442, 2026-09-21): the correction worker recovered PR #690's current head
// branch (`worktree-agent-acf4c07f63a440346`) and its accepted Stage 1 findings, but the
// dispatched session started in the primary `C:\Loop-Dee-Loup` checkout on `main` -- a fresh
// session's own default worktree/branch, per `docs/operating-model.md` § Worktree startup
// reconciliation -- and its first source read failed because
// `tools/orchestration/classify-primary-path-lock.mjs` existed only on the unmerged PR head.
// The failure surfaced as a misleading "file does not exist" error, never as the actual
// checkout/head mismatch that caused it.
//
// This script is the smallest deterministic check that closes that gap: given a PR number, it
// resolves the PR's *current* head (never a branch name captured earlier -- #692 requirement
// 7), compares it against the invoking checkout's own live branch/commit identity, and either
// confirms the checkout is already correct, safely reuses/reconciles an existing attributable
// worktree already at that head, creates one distinct new worktree for that exact head, or
// fails closed before any source work when none of those is safe. It never mutates the
// primary checkout into the correction branch (#692 requirement 5), never force-checks-out
// over dirty or ambiguous state (#692 non-goals), and treats unknown/undeterminable evidence
// (a worktree whose clean/dirty state cannot be read) the same as this repository's other
// fail-closed conventions (`worktree-preflight.mjs`'s `isDurablyObsolete`,
// `classify-primary-path-lock.mjs`'s protection-state check): never authorization to proceed.
//
// Verdicts (see `classifyCheckoutBinding` for the pure decision, and `run` for the CLI
// wrapper that additionally performs the one safe mutation each success verdict requires):
//
//   ALREADY_AT_HEAD          -- the invoking checkout's own branch and commit already match
//                                the PR's current head exactly, AND is proven clean (Stage 1
//                                review finding on PR #694: matching branch/commit alone never
//                                proved this checkout had no pre-existing local modifications
//                                that correction work would silently sweep into its commit). No
//                                worktree churn (#692 requirement 3); proceed in place.
//   REUSABLE_WORKTREE_AT_HEAD -- exactly one OTHER live worktree already carries the target
//                                branch at the target commit, is not locked, and is proven
//                                clean. Safe to continue there; the caller (a live session)
//                                MUST switch into it with `EnterWorktree({ path })` before any
//                                source read (#692 requirement 3's "actually selected/entered"
//                                half; `format-dispatch-prompt.mjs`'s Stage 1 correction
//                                template mandates this). This is also the authoritative
//                                session-vacancy proof, not merely a formality: git's own
//                                `locked` worktree metadata is administrative-lock state, not an
//                                exclusive claim on the path, so a clean worktree still actively
//                                owned by another live session would pass every check above --
//                                Stage 1 review finding on PR #694. `EnterWorktree` enforces this
//                                repository's own one-session-per-exact-path invariant
//                                (`docs/operating-model.md` § Concurrent subagent directory
//                                isolation) and fails deterministically if another live session
//                                already holds the path; that failure IS the fail-closed signal,
//                                reported the same as any other `CHECKOUT_BINDING_UNVERIFIED`
//                                outcome, never worked around. This reuses existing session/path-
//                                ownership machinery rather than this script re-implementing a
//                                parallel occupancy model it cannot itself observe (a plain
//                                script has no access to live session state -- see
//                                `classify-primary-path-lock.mjs`'s module comment for the same
//                                constraint).
//   CREATED_WORKTREE_AT_HEAD -- no existing worktree carries the target branch anywhere, so
//                                `run` fetched the branch and created one distinct new worktree
//                                on a real local branch at the exact target commit (`git
//                                worktree add -B <branch> <path> <sha>`, upstream set to
//                                `origin/<branch>`) -- never detached (Stage 1 review finding on
//                                PR #694: a detached checkout has no ordinary `git push`
//                                destination for the correction worker's later push) -- under
//                                the primary checkout's own `.claude/worktrees/` root (excluded
//                                from the primary checkout's own index by `.gitignore`, PR #694).
//                                The primary checkout itself is never the target path and is
//                                never checked out onto the correction branch (#692 requirement
//                                5). The caller MUST `EnterWorktree({ path })` before any source
//                                read, same as `REUSABLE_WORKTREE_AT_HEAD` above.
//   STALE_HEAD_MISMATCH      -- exactly one other worktree carries the target branch, is
//                                clean and unlocked, but at an older commit; `run` attempted a
//                                safe `fetch` + `merge --ff-only` reconciliation and it did not
//                                converge on the target commit (a non-fast-forward divergence,
//                                or the fetch/merge itself failed). Fails closed before source
//                                work (#692 required check 3).
//   DIRTY_CANDIDATE          -- the sole candidate checkout for source work -- either the
//                                invoking checkout itself (already at the target branch/commit)
//                                or the one other worktree carrying the target branch -- has
//                                unsafe local changes, or its clean/dirty state could not be
//                                determined at all. Never repurposed (#692 required check 5).
//   BRANCH_OWNED_ELSEWHERE_LOCKED -- the one worktree carrying the target branch is locked.
//                                Never repurposed.
//   AMBIGUOUS                -- more than one live worktree carries the target branch.
//                                Ordering/recency never resolves this; fails closed (#692
//                                required check 6's ambiguity half).
//   NO_SAFE_BINDING          -- either the invoking checkout or the one other worktree carrying
//                                the target branch IS the primary checkout, which is never
//                                repurposed for correction work (#692 requirement 5); or a
//                                required git/gh operation itself failed (fetch, worktree add)
//                                even though classification reached a nominally safe path. The
//                                latter case is distinct from OPERATIONAL_ERROR: classification
//                                succeeded, only the mutation it authorized did not.
//   EXISTING_BRANCH_UNSAFE   -- `NEEDS_NEW_WORKTREE` resolved, but a local branch by the target
//                                name already exists (unattached to any worktree) and its tip is
//                                not the target commit and not safely contained in it (Stage 2
//                                audit finding on #695, Finding 1: `git worktree add -B <branch>
//                                ...` unconditionally resets an existing branch ref, which would
//                                silently discard any unpushed commits on that branch). `run`
//                                verifies containment via `merge-base --is-ancestor` before ever
//                                using `-B`, and fails closed here instead of resetting the ref.
//   OPERATIONAL_ERROR        -- `--pr` missing/invalid, `gh pr view` failed or did not resolve
//                                a head, or the invoking checkout's own git state could not be
//                                read. Not a judgment about the PR or checkout content.
//
// An ordinary unrelated worktree/branch is never a match candidate at all (#692 required check
// 4) -- `classifyCheckoutBinding` only ever considers worktrees whose own branch equals the
// PR's current head branch.
//
// Exit codes mirror this repository's existing finalize-*.mjs breakpoint convention rather
// than `worktree-preflight.mjs`'s "0 unless a git/ledger operation itself failed" convention,
// because the caller here is a live correction worker that must branch on the result before
// doing anything else: 0 for the three verdicts above that mean "proceed" (with a `path` field
// when the worker must `EnterWorktree` there first); 2 for a fail-closed verdict the worker
// must stop and report as `CHECKOUT_BINDING_UNVERIFIED <pr> <verdict>` rather than working
// around; 1 for a missing/invalid argument or an operational failure unrelated to the PR/
// checkout's own content.
//
// Usage:
//   node tools/orchestration/pr-head-checkout-preflight.mjs --pr <N> [--repo <owner/repo>]
//     `--repo` defaults to the invoking checkout's own configured `origin` remote via
//     `ready-dispatch-gate.mjs`'s `resolveRepoIdentity` -- never a hand-typed slug.
//
// Tests: node --test tools/orchestration/pr-head-checkout-preflight.test.mjs

import { execFileSync } from "node:child_process";
import { resolveRepoIdentity } from "./ready-dispatch-gate.mjs";
import { parseWorktreeListPorcelain } from "./worktree-preflight.mjs";

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function reasonOf(err) {
  return String(err?.stderr || err?.message || err).trim();
}

// ---------------------------------------------------------------------------------------------
// Pure decision. See the module comment above for the full verdict contract.
//
// `liveWorktrees` need only contain entries whose `branch` could plausibly equal
// `targetHead.branch` -- `run` below resolves `dirty` lazily, only for a genuine single match,
// specifically so this never has to run `git status` against every worktree on the machine.
// Passing the full raw list is also safe: entries with a different branch are ignored here
// exactly as they would be if pre-filtered.
// ---------------------------------------------------------------------------------------------
export function classifyCheckoutBinding({ targetHead, currentCheckout, liveWorktrees, primaryPath }) {
  if (!targetHead || typeof targetHead.branch !== "string" || !targetHead.branch || typeof targetHead.sha !== "string" || !targetHead.sha) {
    return { verdict: "OPERATIONAL_ERROR", reason: "target PR head branch/sha could not be resolved" };
  }
  if (!currentCheckout || typeof currentCheckout.path !== "string" || !currentCheckout.path) {
    return { verdict: "OPERATIONAL_ERROR", reason: "current checkout identity could not be resolved" };
  }

  if (currentCheckout.branch === targetHead.branch && currentCheckout.sha === targetHead.sha) {
    // Stage 2 audit finding on #695 (issue #695 Finding 2): matching branch+commit alone was
    // being treated as sufficient for ALREADY_AT_HEAD before this ever compared the invoking
    // checkout's own path against `primaryPath` -- the primary-path rejection below only ever
    // fired for the separate "one other worktree carries the branch" case, so a primary
    // checkout that happened to already sit on the PR branch/commit slipped past the "primary
    // checkout is never repurposed for correction work" invariant entirely (#692 requirement
    // 5). Reject it here, before considering cleanliness, exactly like the equivalent check in
    // the worktree-match branch below.
    if (currentCheckout.path === primaryPath) {
      return {
        verdict: "NO_SAFE_BINDING",
        reason: "the invoking checkout is the primary checkout, which is never repurposed for correction work",
        path: currentCheckout.path,
      };
    }
    // Stage 1 review finding on PR #694: matching branch+commit alone is not proof this is safe
    // to correct in place -- pre-existing local modifications on this exact checkout would be
    // silently swept into the correction commit as this is the worker's first source-work gate.
    // Unknown cleanliness (`dirty` not positively `false`) fails closed exactly like every other
    // unknown-evidence check in this module.
    if (currentCheckout.dirty !== false) {
      return {
        verdict: "DIRTY_CANDIDATE",
        path: currentCheckout.path,
        reason:
          currentCheckout.dirty === true
            ? "current checkout contains local modifications"
            : "current checkout cleanliness could not be determined",
      };
    }
    return { verdict: "ALREADY_AT_HEAD", path: currentCheckout.path };
  }

  const list = Array.isArray(liveWorktrees) ? liveWorktrees : [];
  const matches = list.filter((w) => w && w.branch === targetHead.branch);

  if (matches.length > 1) {
    return {
      verdict: "AMBIGUOUS",
      reason: "more than one live worktree reports the target PR branch",
      paths: matches.map((m) => m.path),
    };
  }

  if (matches.length === 1) {
    const [w] = matches;
    if (w.path === primaryPath) {
      // The primary checkout is never repurposed as a correction target, even when it
      // happens to already carry the target branch by some out-of-band action -- #692
      // requirement 5. Fail closed rather than silently authorizing continued work there.
      return {
        verdict: "NO_SAFE_BINDING",
        reason: "the target branch is checked out on the primary checkout, which is never repurposed for correction work",
        path: w.path,
      };
    }
    if (w.locked) {
      return { verdict: "BRANCH_OWNED_ELSEWHERE_LOCKED", path: w.path, reason: w.lockedReason ?? "worktree is locked" };
    }
    // Unknown dirty state (`null`/`undefined`) fails closed exactly like every other
    // unknown-evidence check in this repository (`worktree-preflight.mjs`'s
    // `isDurablyObsolete`, `classify-primary-path-lock.mjs`'s protection-state check) --
    // only a positively-proven `false` authorizes reuse.
    if (w.dirty !== false) {
      return {
        verdict: "DIRTY_CANDIDATE",
        path: w.path,
        reason: w.dirty === true ? "worktree contains local modifications" : "worktree cleanliness could not be determined",
      };
    }
    if (w.headCommit === targetHead.sha) {
      return { verdict: "REUSABLE_WORKTREE_AT_HEAD", path: w.path };
    }
    return { verdict: "STALE_WORKTREE", path: w.path, currentCommit: w.headCommit, targetSha: targetHead.sha };
  }

  return { verdict: "NEEDS_NEW_WORKTREE", branch: targetHead.branch, sha: targetHead.sha };
}

// ---------------------------------------------------------------------------------------------
// Git/gh plumbing (thin, injectable for tests -- mirrors `worktree-preflight.mjs`'s
// `defaultGitImpl` shape).
// ---------------------------------------------------------------------------------------------

function runGit(args, { cwd } = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function defaultGitImpl() {
  return {
    toplevel(cwd) {
      return runGit(["rev-parse", "--show-toplevel"], { cwd });
    },
    currentBranch(cwd) {
      const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
      return branch === "HEAD" ? null : branch;
    },
    currentCommit(cwd) {
      return runGit(["rev-parse", "HEAD"], { cwd });
    },
    worktreeListPorcelain(cwd) {
      return runGit(["worktree", "list", "--porcelain"], { cwd });
    },
    // `null` on failure -- unreadable state must fail closed to "unknown", never "clean"
    // (see `classifyCheckoutBinding`'s dirty handling above).
    isDirty(path) {
      try {
        return runGit(["status", "--porcelain"], { cwd: path }).length > 0;
      } catch {
        return null;
      }
    },
    fetchBranch(cwd, branch) {
      try {
        runGit(["fetch", "origin", branch], { cwd });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
    },
    // Fast-forward only: refuses (rather than rewriting) local commits not reachable from the
    // fetched branch, and refuses a genuinely diverged history -- this script never forces a
    // reconciliation, it only ever accepts the git-proven-safe one (#692 requirement 6's
    // "stale... local state disagrees... and cannot be reconciled mechanically" case).
    ffOnlyMergeToBranch(path, branch) {
      try {
        runGit(["merge", "--ff-only", `origin/${branch}`], { cwd: path });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
    },
    // Checked out on a real local branch -- created/reset (`-B`) at the exact target commit this
    // preflight verified, never merely origin/<branch>'s current tip -- with its upstream set to
    // origin/<branch>, rather than a detached HEAD. Stage 1 review finding on PR #694: a detached
    // checkout has no ordinary `git push` destination, so the correction worker's later "push it"
    // step would need to guess an explicit `HEAD:<branch>` refspec the dispatch contract never
    // specifies; an ordinary `git push` now works unmodified. Safe by construction: this is only
    // ever called from the `NEEDS_NEW_WORKTREE` path, reached only when no worktree anywhere --
    // including the current checkout, which `git worktree list` always includes -- already
    // carries this branch, so `-B` can never collide with an existing checkout of the same
    // branch (#692 requirement 7).
    addBranchWorktree(primaryCwd, path, branch, sha) {
      try {
        runGit(["worktree", "add", "-B", branch, path, sha], { cwd: primaryCwd });
        runGit(["branch", `--set-upstream-to=origin/${branch}`, branch], { cwd: path });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
    },
    // Stage 2 audit finding on #695 (Finding 1): `addBranchWorktree` above uses `-B`, which
    // resets an existing branch ref rather than refusing to touch it. This resolves whether a
    // local branch by this name already exists at all, independent of whether any worktree
    // currently checks it out -- `null` means no such ref exists (the ordinary, safe case).
    localBranchTip(cwd, branch) {
      try {
        return runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd });
      } catch {
        return null;
      }
    },
    // True only when `ancestorSha` is reachable from `descendantSha` -- i.e. resetting the
    // branch ref from `ancestorSha` to `descendantSha` via `-B` cannot discard any commit,
    // because everything at `ancestorSha` is already contained in `descendantSha`'s history.
    // Any non-zero exit (not-an-ancestor, diverged history, or an unresolvable object) fails
    // closed to `false`, matching this module's other unknown-evidence-never-authorizes
    // convention.
    isAncestor(cwd, ancestorSha, descendantSha) {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", ancestorSha, descendantSha], { cwd });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function defaultGhPrView({ repo, pr }) {
  const args = ["pr", "view", String(pr), "--json", "headRefName,headRefOid"];
  if (repo) args.push("--repo", repo);
  const raw = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(raw);
}

function sanitizeForPath(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function defaultNewWorktreePath(primaryPath, pr, branch) {
  return `${primaryPath}/.claude/worktrees/pr-${pr}-${sanitizeForPath(branch)}`;
}

// ---------------------------------------------------------------------------------------------
// CLI-facing run(): resolves live state, classifies, and performs exactly the one safe
// mutation ("reuse and reconcile" or "create") each success verdict authorizes.
// ---------------------------------------------------------------------------------------------
export async function run(
  { repo, pr, cwd = process.cwd() },
  { ghPrViewImpl = defaultGhPrView, git = defaultGitImpl(), newWorktreePathImpl = defaultNewWorktreePath } = {},
) {
  if (!isPositiveInteger(pr)) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: "--pr is required and must be a positive integer" };
  }

  let prView;
  try {
    prView = await ghPrViewImpl({ repo, pr });
  } catch (err) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `gh pr view failed for PR #${pr}: ${reasonOf(err)}` };
  }
  const targetHead = { branch: prView?.headRefName ?? null, sha: prView?.headRefOid ?? null };
  if (!targetHead.branch || !targetHead.sha) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `PR #${pr} did not resolve a headRefName/headRefOid` };
  }

  let currentCheckout;
  let primaryPath;
  let rawWorktrees;
  try {
    currentCheckout = {
      path: git.toplevel(cwd),
      branch: git.currentBranch(cwd),
      sha: git.currentCommit(cwd),
    };
    rawWorktrees = parseWorktreeListPorcelain(git.worktreeListPorcelain(cwd));
    primaryPath = rawWorktrees[0]?.path ?? currentCheckout.path;
    // Only resolved for a genuine branch+commit match against the target head -- the same
    // "never run git status against every candidate" discipline the worktree-match branch below
    // already follows; an unrelated current checkout never needs its dirty state at all.
    if (currentCheckout.branch === targetHead.branch && currentCheckout.sha === targetHead.sha) {
      currentCheckout.dirty = git.isDirty(currentCheckout.path);
    }
  } catch (err) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `could not read current checkout/worktree state: ${reasonOf(err)}` };
  }

  // Resolve `dirty` only for a genuine single branch match -- never for every worktree on the
  // machine (module comment above).
  const branchMatches = rawWorktrees.filter((w) => w.branch === targetHead.branch);
  const enrichedWorktrees =
    branchMatches.length === 1
      ? [{ ...branchMatches[0], dirty: git.isDirty(branchMatches[0].path) }]
      : branchMatches;

  const classification = classifyCheckoutBinding({ targetHead, currentCheckout, liveWorktrees: enrichedWorktrees, primaryPath });

  switch (classification.verdict) {
    case "ALREADY_AT_HEAD":
    case "REUSABLE_WORKTREE_AT_HEAD":
      return { exitCode: 0, ...classification };

    case "STALE_WORKTREE": {
      const fetchResult = git.fetchBranch(classification.path, targetHead.branch);
      if (!fetchResult.ok) {
        return { exitCode: 2, verdict: "STALE_HEAD_MISMATCH", path: classification.path, reason: `fetch failed: ${fetchResult.reason}` };
      }
      const mergeResult = git.ffOnlyMergeToBranch(classification.path, targetHead.branch);
      if (!mergeResult.ok) {
        return { exitCode: 2, verdict: "STALE_HEAD_MISMATCH", path: classification.path, reason: `fast-forward reconciliation failed: ${mergeResult.reason}` };
      }
      const resultingSha = git.currentCommit(classification.path);
      if (resultingSha !== targetHead.sha) {
        return {
          exitCode: 2,
          verdict: "STALE_HEAD_MISMATCH",
          path: classification.path,
          reason: "worktree still does not match the target head after fast-forward reconciliation",
        };
      }
      return { exitCode: 0, verdict: "REUSABLE_WORKTREE_AT_HEAD", path: classification.path };
    }

    case "NEEDS_NEW_WORKTREE": {
      const path = newWorktreePathImpl(primaryPath, pr, targetHead.branch);
      const fetchResult = git.fetchBranch(primaryPath, targetHead.branch);
      if (!fetchResult.ok) {
        return { exitCode: 2, verdict: "NO_SAFE_BINDING", reason: `fetch failed: ${fetchResult.reason}` };
      }
      // Stage 2 audit finding on #695 (Finding 1): no worktree anywhere checks out this branch
      // (that is what got us into NEEDS_NEW_WORKTREE), but a local branch ref by this name can
      // still exist unattached to any worktree -- `addBranchWorktree`'s `-B` would silently
      // reset it. Only proceed when no such ref exists, it already IS the target commit, or its
      // tip is safely contained in the target commit (no unique commits would be discarded).
      const existingTip = git.localBranchTip(primaryPath, targetHead.branch);
      if (existingTip && existingTip !== targetHead.sha && !git.isAncestor(primaryPath, existingTip, targetHead.sha)) {
        return {
          exitCode: 2,
          verdict: "EXISTING_BRANCH_UNSAFE",
          branch: targetHead.branch,
          reason: "a local branch with this name already exists and is not safely contained in the PR's current head; refusing to reset it",
        };
      }
      const addResult = git.addBranchWorktree(primaryPath, path, targetHead.branch, targetHead.sha);
      if (!addResult.ok) {
        return { exitCode: 2, verdict: "NO_SAFE_BINDING", reason: `worktree creation failed: ${addResult.reason}` };
      }
      return { exitCode: 0, verdict: "CREATED_WORKTREE_AT_HEAD", path };
    }

    case "DIRTY_CANDIDATE":
    case "BRANCH_OWNED_ELSEWHERE_LOCKED":
    case "AMBIGUOUS":
    case "NO_SAFE_BINDING":
      return { exitCode: 2, ...classification };

    case "OPERATIONAL_ERROR":
      return { exitCode: 1, ...classification };

    /* c8 ignore next 2 -- unreachable: every classifyCheckoutBinding verdict is handled above */
    default:
      return { exitCode: 2, verdict: "NO_SAFE_BINDING", reason: `unrecognized classification verdict: ${classification.verdict}` };
  }
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    args[a.slice(2)] = argv[++i];
  }
  return args;
}

function toIntOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let resolvedRepo = args.repo;
  if (!resolvedRepo) {
    const identity = resolveRepoIdentity();
    if (!identity.ok) {
      console.error(`Could not determine the current repository identity (--repo was not supplied): ${identity.reason}`);
      process.exit(1);
      return;
    }
    resolvedRepo = identity.repo;
  }

  const pr = toIntOrNull(args.pr);
  const result = await run({ repo: resolvedRepo, pr });
  if (result.message) {
    if (result.exitCode === 0) console.log(result.message);
    else console.error(result.message);
  }
  console.log(JSON.stringify(result));
  process.exit(result.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("pr-head-checkout-preflight.mjs")) {
  main();
}
