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
//                                `run` fetched the branch, atomically established a real local
//                                branch at the exact target commit via a `git update-ref`
//                                compare-and-swap (Stage 1 review finding on PR #696, Finding P1
//                                -- never the resetting `worktree add -B`), and attached a new
//                                worktree to it with plain `worktree add` (upstream set to
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
//   EXISTING_BRANCH_UNSAFE   -- `NEEDS_NEW_WORKTREE` resolved, but either (a) a local branch by
//                                the target name already exists (unattached to any worktree) and
//                                its tip is not the target commit and not safely contained in it
//                                (Stage 2 audit finding on #695, Finding 1: the original `git
//                                worktree add -B <branch> ...` unconditionally reset an existing
//                                branch ref, which would silently discard any unpushed commits on
//                                that branch -- `run` verifies containment via `merge-base
//                                --is-ancestor` before ever writing the ref), or (b) that same
//                                branch ref changed concurrently between this preflight's
//                                observation and its atomic `update-ref` compare-and-swap (Stage 1
//                                review finding on PR #696, Finding P1) -- the CAS itself failed,
//                                so nothing was mutated. Either way this fails closed here instead
//                                of resetting or overwriting the ref.
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
// Issue #703: the verdicts above are the legacy *in-worker* binding mode, which relies on the
// spawned worker rebinding itself afterwards via `EnterWorktree`. That post-spawn rebind is not
// available on every agent substrate (the #514 / #689 / PR #700 recurrence), so the Stage 1
// correction dispatch path no longer uses it: see the "Pre-spawn binding" section below
// (`--reserve-from-gate` / `--reserve` / `--verify-binding` / `--release-binding`). The legacy
// mode is kept unchanged for its #692 regression coverage and any caller whose substrate can
// rebind.
//
// Usage:
//   node tools/orchestration/pr-head-checkout-preflight.mjs --pr <N> [--repo <owner/repo>]
//     (legacy in-worker mode)
//   <gate JSON> | node tools/orchestration/pr-head-checkout-preflight.mjs --reserve-from-gate
//     (controller, before spawn; pipe the output into format-dispatch-prompt.mjs)
//   node tools/orchestration/pr-head-checkout-preflight.mjs --reserve --pr <N>
//   node tools/orchestration/pr-head-checkout-preflight.mjs --verify-binding <token> --pr <N>
//     (worker's first action, run from the reserved path)
//   node tools/orchestration/pr-head-checkout-preflight.mjs --release-binding <token>
//     `--repo` defaults to the invoking checkout's own configured `origin` remote via
//     `ready-dispatch-gate.mjs`'s `resolveRepoIdentity` -- never a hand-typed slug.
//
// Tests: node --test tools/orchestration/pr-head-checkout-preflight.test.mjs

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveRepoIdentity } from "./ready-dispatch-gate.mjs";
import { parseWorktreeListPorcelain } from "./worktree-preflight.mjs";
import { normalizePathForComparison } from "./classify-primary-path-lock.mjs";
import { getActionEnvelope } from "./action-envelope.mjs";

// Issue #703 Stage 1 correction (P1 finding on PR #710): this process's own absolute path to
// itself -- the controller's authoritative copy of this script, loaded from wherever the
// controller's own checkout lives, never a path relative to any candidate/reserved checkout
// (see the "Pre-spawn binding" section below and `reserve`'s `scriptPath` field for why).
export const SELF_SCRIPT_PATH = fileURLToPath(import.meta.url);

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function reasonOf(err) {
  return String(err?.stderr || err?.message || err).trim();
}

// Stage 1 review finding on PR #696 (this preflight's own Stage 2 correction): comparing
// `path === primaryPath` as raw strings lets the same primary checkout evade the "never
// repurpose the primary checkout" guard on Windows through case/separator variation alone
// (`C:/Loop-Dee-Loup` vs `c:\loop-dee-loup`). Reuse `classify-primary-path-lock.mjs`'s own
// host-aware `normalizePathForComparison` rather than re-deriving path-identity semantics here.
// Two unrelated paths that both fail to normalize (empty/non-string) are never considered equal.
function isSamePath(a, b) {
  const na = normalizePathForComparison(a);
  const nb = normalizePathForComparison(b);
  return na !== null && nb !== null && na === nb;
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
    if (isSamePath(currentCheckout.path, primaryPath)) {
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
    if (isSamePath(w.path, primaryPath)) {
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
    // Stage 1 review finding on PR #696 (this preflight's own Stage 2 correction, Finding P1):
    // a separate read-then-ancestry-check followed by a later, unconditional `-B` reset left a
    // TOCTOU window -- a concurrent process could move the shared local branch ref after the
    // safety check but before this write, and `-B` would still silently reset (and discard)
    // whatever the ref pointed to by then. Establishing the branch's target commit is now a
    // single atomic `git update-ref` compare-and-swap: it succeeds only if the ref still holds
    // exactly the value this preflight observed and validated as safe (`expectedOldSha`, or the
    // all-zero SHA when no ref existed at observation time), and fails -- with no mutation at
    // all -- if anything moved it in between. Only after that CAS succeeds does this attach a
    // worktree to the now-known-correct branch with plain `worktree add` (never `-b`/`-B`),
    // which cannot itself reset or discard anything. Upstream is set to origin/<branch> rather
    // than leaving a detached HEAD -- Stage 1 review finding on PR #694: a detached checkout has
    // no ordinary `git push` destination, so the correction worker's later "push it" step would
    // need to guess an explicit `HEAD:<branch>` refspec the dispatch contract never specifies.
    // Safe by construction: this is only ever called from the `NEEDS_NEW_WORKTREE` path, reached
    // only when no worktree anywhere -- including the current checkout, which `git worktree
    // list` always includes -- already carries this branch, so attaching a worktree to it here
    // can never collide with an existing checkout of the same branch (#692 requirement 7).
    establishBranchAtSha(cwd, branch, sha, expectedOldSha) {
      const zeroSha = "0".repeat(40);
      try {
        // A zero old-value is git's own idiom for "this ref must not already exist" -- exactly
        // what `expectedOldSha === null` (no local branch observed) means here.
        runGit(["update-ref", `refs/heads/${branch}`, sha, expectedOldSha ?? zeroSha], { cwd });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
    },
    addExistingBranchWorktree(primaryCwd, path, branch) {
      try {
        runGit(["worktree", "add", path, branch], { cwd: primaryCwd });
        runGit(["branch", `--set-upstream-to=origin/${branch}`, branch], { cwd: path });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
    },
    // Stage 2 audit finding on #695 (Finding 1): the original `addBranchWorktree` used `-B`,
    // which resets an existing branch ref rather than refusing to touch it. This resolves
    // whether a local branch by this name already exists at all, independent of whether any
    // worktree currently checks it out -- `null` means no such ref exists (the ordinary, safe
    // case). Stage 1 review finding on PR #696 (Finding P2): `git rev-parse --verify --quiet`
    // exits 1 with no output for a genuinely absent ref, but any other failure (a corrupt
    // repository, an unreadable object database, etc.) must not collapse into that same "absent"
    // signal -- doing so would authorize the resetting branch-creation path on unproven ground.
    // Only the specific documented "absent ref" exit is treated as absence; every other failure
    // is rethrown so the caller fails closed instead of silently proceeding.
    localBranchTip(cwd, branch) {
      try {
        return runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd });
      } catch (err) {
        if (err && err.status === 1) return null;
        throw err;
      }
    },
    // True only when `ancestorSha` is reachable from `descendantSha` -- i.e. moving the branch
    // ref from `ancestorSha` to `descendantSha` cannot discard any commit, because everything at
    // `ancestorSha` is already contained in `descendantSha`'s history. Any non-zero exit
    // (not-an-ancestor, diverged history, or an unresolvable object) fails closed to `false`,
    // matching this module's other unknown-evidence-never-authorizes convention.
    isAncestor(cwd, ancestorSha, descendantSha) {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", ancestorSha, descendantSha], { cwd });
        return true;
      } catch {
        return false;
      }
    },
    // -- Issue #703 pre-spawn binding plumbing (see the "Pre-spawn binding" section below) ----
    // `null` when the remote-tracking ref cannot be resolved -- never guessed.
    remoteBranchSha(cwd, branch) {
      try {
        return runGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd });
      } catch {
        return null;
      }
    },
    // One git operation creates the worktree AND places the exclusive reservation lock, so no
    // window exists in which the new path is present but unreserved. `git worktree add` itself
    // refuses an already-existing non-empty path and `-b` refuses an already-existing branch name,
    // so a fresh, token-unique path/branch can never be one another live session already holds.
    addLockedBindingWorktree(primaryCwd, path, localBranch, sha, lockReason) {
      try {
        runGit(["worktree", "add", "--lock", "--reason", lockReason, "-b", localBranch, path, sha], { cwd: primaryCwd });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
    },
    // `git worktree lock` fails if the worktree is already locked -- an atomic exclusive claim.
    lockWorktree(cwd, path, lockReason) {
      try {
        runGit(["worktree", "lock", "--reason", lockReason, path], { cwd });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
    },
    unlockWorktree(cwd, path) {
      try {
        runGit(["worktree", "unlock", path], { cwd });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
    },
    // Never `--force`: git itself refuses to remove a worktree with local modifications.
    removeWorktree(cwd, path) {
      try {
        runGit(["worktree", "remove", path], { cwd });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
    },
    deleteLocalBranch(cwd, branch) {
      try {
        runGit(["branch", "-D", branch], { cwd });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
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

// =============================================================================================
// Pre-spawn binding (issue #703, control #691)
// =============================================================================================
//
// Demonstrated failure this closes (the `work on #514` / execution #689 / PR #700 recurrence):
// the dispatch template above made the *spawned* correction worker responsible for moving
// itself onto the PR-head checkout after it started (`EnterWorktree({ path })`). Repository
// selection/creation succeeded every time; the step that dead-ended was the runtime rebind. A
// worker spawned with agent-tool worktree isolation was already pinned to a different sandbox
// worktree, and a retry without explicit isolation still hit the spawned-subagent `EnterWorktree`
// restriction, so the only way forward was the parent session doing the correction itself.
//
// Provider-independent invariant (docs/operating-model.md § PR-head checkout preflight for
// Stage 1 correction): a correction worker's execution surface -- one exact PR-head checkout,
// exclusively reserved for that one worker -- is settled deterministically BEFORE the worker is
// spawned, and the worker's first action only *verifies* that surface; it never has to perform
// a post-spawn workspace transition its agent substrate may not allow. How the worker then
// operates from the reserved path (absolute paths, a per-command `cd`, a spawn-time working
// directory, or an entry operation where the substrate genuinely supports one) is a runtime
// adapter detail, not the invariant.
//
// Three operations, all keyed by an opaque per-reservation token:
//
//   reserve        -- run by the controller before spawn. Always creates one fresh worktree at a
//                     token-unique path on a token-unique local branch at the exact current head
//                     commit, created and locked by one `git worktree add --lock`
//                     (RESERVED_CREATED). The primary checkout is never eligible, and is simply
//                     bypassed rather than dead-ending the way the legacy `run()` path's
//                     NO_SAFE_BINDING did. The reservation is a `git worktree lock` whose reason
//                     records pr/sha/branch/mode/token. Occupancy is proven by construction: a
//                     fresh path did not exist before `worktree add` created it (git refuses an
//                     existing path), and the lock atomically fails if anyone else already holds
//                     it. Locked worktrees are also never retired by worktree-preflight.mjs.
//
//                     Stage 1 finding P1 on PR #710: an earlier revision also let the invoking
//                     checkout be reserved "in place" (no worktree churn) whenever it already
//                     happened to sit at the exact target head, proven exclusive only by `git
//                     worktree lock` -- an administrative/pruning-exclusion primitive, not proof
//                     no other live process or session is using the path. This script has no
//                     access to live session state to prove otherwise, so that path is removed:
//                     `reserve` always creates a fresh, construction-proven-exclusive worktree.
//   verify-binding -- the worker's mandatory first action, run from the reserved path, using the
//                     CONTROLLER's own absolute copy of this script (`reserve`'s `scriptPath`
//                     field, threaded through `checkoutBinding` -- see `reserveFromGate` and
//                     Stage 1 finding P1 on PR #710 below). Proves that the command actually
//                     executed inside the reserved checkout (not the worker's spawn-time sandbox
//                     -- WRONG_CHECKOUT), that the reservation is this token's and this PR's,
//                     that the checkout is not the primary, is clean, and that its commit still
//                     equals the PR's *current* head re-read from GitHub at verification time (a
//                     head that advanced after reservation fails closed as STALE_HEAD_MISMATCH --
//                     a reservation never authorizes a stale commit). The output's `pushRefspec`
//                     (`HEAD:<pr-branch>`) is a plain, non-forced push, so a head that advances
//                     after verification is still refused by git itself.
//
//                     Stage 1 finding P1 on PR #710: `format-dispatch-prompt.mjs`'s generated
//                     prompt runs this step with the worker's cwd set to the reserved/candidate
//                     checkout -- exactly the untrusted PR content this reservation exists to
//                     evaluate. A relative `tools/orchestration/pr-head-checkout-preflight.mjs`
//                     invoked from there would load THAT checkout's own (possibly outdated or
//                     PR-modified) copy of this file rather than the controller's, letting the
//                     candidate being corrected certify its own binding contract. The dispatch
//                     prompt now names `scriptPath` -- the controller's own absolute path to this
//                     module, captured at `reserve` time before the worker even exists -- so
//                     verification code is always controller-authoritative even while it
//                     evaluates the reserved checkout's own live state as its cwd.
//   release-binding -- unlocks the reservation; the created worktree is also removed (never
//                     forced) once it is clean and its commit is proven contained in the PR branch
//                     on origin, so no unpushed work can be discarded.
//
//                     Stage 1 finding P2 on PR #710: the generated dispatch prompt runs this step
//                     from inside the reserved checkout itself (there is no other checkout for
//                     the worker to run it from), which used to unconditionally keep (never
//                     remove) the worktree -- deleting a directory that is a running process's
//                     own OS-level working directory fails on this repository's Windows hosts, so
//                     every ordinary successful correction leaked its generated worktree/branch.
//                     `release-binding` now moves this process's own working directory out of the
//                     reserved path first when invoked from inside it, then evaluates
//                     clean/pushed/removal exactly as it would from anywhere else.
//
// Verdicts: RESERVED_CREATED / BINDING_VERIFIED / RELEASED (exit 0); OCCUPIED_CANDIDATE /
// DIRTY_CANDIDATE / STALE_HEAD_MISMATCH / NO_SAFE_BINDING / WRONG_CHECKOUT / BINDING_NOT_FOUND /
// BINDING_MISMATCH / AMBIGUOUS (exit 2, fail closed); OPERATIONAL_ERROR (1). A failed `reserve`
// (piped through `reserveFromGate`) surfaces as its own terminal `CHECKOUT_BINDING_UNVERIFIED`
// verdict state -- see `reserveFromGate`'s own comment and Stage 1 finding P2 on PR #710 below
// for why that is a distinct recognized action-envelope state, not a violation of
// STAGE1_CORRECTION_REQUIRED's own bounded envelope.

export const BINDING_LOCK_PREFIX = "ldl-pr-head-binding";

export function formatBindingLockReason({ pr, sha, branch, mode, token }) {
  return `${BINDING_LOCK_PREFIX} pr=${pr} sha=${sha} branch=${branch} mode=${mode} token=${token}`;
}

// Pure. `null` for anything that is not exactly this module's own reservation shape -- a lock
// placed by anyone/anything else is never read as one of ours.
//
// `mode: "in-place"` is legacy-only (Stage 1 finding P1 on PR #710 removed the code path that
// creates it -- see `reserve`'s own comment) but is still parsed here, and `releaseBinding` still
// refuses to remove a binding in that mode, purely as a fail-closed guard against a lock reason
// a pre-#710 controller may have already written before this fix deployed.
export function parseBindingLockReason(reason) {
  if (typeof reason !== "string") return null;
  const tokens = reason.trim().split(/\s+/);
  if (tokens[0] !== BINDING_LOCK_PREFIX) return null;
  const fields = {};
  for (const t of tokens.slice(1)) {
    const eq = t.indexOf("=");
    if (eq <= 0) return null;
    fields[t.slice(0, eq)] = t.slice(eq + 1);
  }
  const pr = Number(fields.pr);
  if (!isPositiveInteger(pr) || !fields.sha || !fields.branch || !fields.token) return null;
  if (fields.mode !== "created" && fields.mode !== "in-place") return null;
  return { pr, sha: fields.sha, branch: fields.branch, mode: fields.mode, token: fields.token };
}

export function defaultBindingWorktreePath(primaryPath, pr, token) {
  return `${primaryPath}/.claude/worktrees/pr-${pr}-bind-${sanitizeForPath(token)}`;
}

export function bindingLocalBranch(pr, token) {
  return `ldl-bind/pr-${pr}-${sanitizeForPath(token)}`;
}

function defaultTokenImpl() {
  return randomBytes(4).toString("hex");
}

async function resolveTargetHead(ghPrViewImpl, repo, pr) {
  let prView;
  try {
    prView = await ghPrViewImpl({ repo, pr });
  } catch (err) {
    return { error: { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `gh pr view failed for PR #${pr}: ${reasonOf(err)}` } };
  }
  const head = { branch: prView?.headRefName ?? null, sha: prView?.headRefOid ?? null };
  if (!head.branch || !head.sha) {
    return { error: { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `PR #${pr} did not resolve a headRefName/headRefOid` } };
  }
  return { head };
}

function readCheckoutState(git, cwd) {
  const path = git.toplevel(cwd);
  const worktrees = parseWorktreeListPorcelain(git.worktreeListPorcelain(cwd));
  return {
    path,
    branch: git.currentBranch(cwd),
    sha: git.currentCommit(cwd),
    worktrees,
    primaryPath: worktrees[0]?.path ?? path,
  };
}

function pushRefspecFor(branch) {
  return `HEAD:${branch}`;
}

export async function reserve(
  { repo, pr, cwd = process.cwd(), expectedHead = null },
  { ghPrViewImpl = defaultGhPrView, git = defaultGitImpl(), tokenImpl = defaultTokenImpl, bindingPathImpl = defaultBindingWorktreePath } = {},
) {
  if (!isPositiveInteger(pr)) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: "--pr is required and must be a positive integer" };
  }
  const { head, error } = await resolveTargetHead(ghPrViewImpl, repo, pr);
  if (error) return error;
  // Stage 1 review finding on PR #719 (issue #665, P2 -- the TOCTOU gap): `expectedHead` pins
  // a reservation to the exact head a caller has already authorized (e.g. the `correctedHead`
  // `next-review-transition-gate.mjs`'s STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT verdict
  // gated its conflict verdict against). Without this check, `reserve` would happily bind
  // whatever the PR's live head happens to be at reservation time -- a commit that landed on
  // the PR after the gate ran, and that never passed the transition authorizing recovery,
  // could silently become the worker's starting point. Reusing STALE_HEAD_MISMATCH (rather than
  // inventing a parallel verdict) keeps this the same fail-closed "a reservation never
  // authorizes a stale/unexpected commit" meaning the verdict already carries elsewhere in this
  // function.
  if (expectedHead && head.sha !== expectedHead) {
    return {
      exitCode: 2,
      verdict: "STALE_HEAD_MISMATCH",
      reason: `PR #${pr}'s live head is ${head.sha}, not the gated corrected head ${expectedHead} -- the PR head advanced after the conflict verdict was produced`,
    };
  }

  let state;
  try {
    state = readCheckoutState(git, cwd);
  } catch (err) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `could not read current checkout/worktree state: ${reasonOf(err)}` };
  }
  const token = tokenImpl();
  const base = { pr, sha: head.sha, branch: head.branch, token, pushRefspec: pushRefspecFor(head.branch) };

  // Issue #703 Stage 1 correction (P1 finding on PR #710): the invoking checkout already being
  // at the exact target head was previously trusted as an "in place, no churn" reservation,
  // proven exclusive only by `git worktree lock` -- an administrative/pruning-exclusion
  // primitive, not evidence that no other live process or session is using the path (this
  // script has no access to live session state -- see `classify-primary-path-lock.mjs`'s own
  // module comment for the same constraint). Trusting it could hand a writer into a checkout
  // another live session genuinely still owns, contradicting the exact-path single-session
  // exclusivity this reservation exists to guarantee. No genuine occupancy primitive is
  // available here, so this always creates one fresh, token-unique worktree instead -- its
  // occupancy is then proven by construction (a path that did not exist before `git worktree
  // add --lock` created it, and a lock that atomically fails if anything else already holds it),
  // never inferred from "clean and already at head". `state.path`/`state.worktrees` above are
  // still read for their `primaryPath` derivation (and to fail closed if the checkout's own git
  // state cannot be read at all); the invoking checkout itself is otherwise never inspected.
  const fetchResult = git.fetchBranch(state.primaryPath, head.branch);
  if (!fetchResult.ok) {
    return { exitCode: 2, verdict: "NO_SAFE_BINDING", reason: `fetch failed: ${fetchResult.reason}` };
  }
  const remoteSha = git.remoteBranchSha(state.primaryPath, head.branch);
  if (remoteSha !== head.sha) {
    return {
      exitCode: 2,
      verdict: "STALE_HEAD_MISMATCH",
      reason: `origin/${head.branch} resolved to ${remoteSha ?? "(unresolvable)"}, not the PR's current head ${head.sha}`,
    };
  }
  const path = bindingPathImpl(state.primaryPath, pr, token);
  const localBranch = bindingLocalBranch(pr, token);
  const added = git.addLockedBindingWorktree(state.primaryPath, path, localBranch, head.sha, formatBindingLockReason({ ...base, mode: "created" }));
  if (!added.ok) {
    return { exitCode: 2, verdict: "NO_SAFE_BINDING", path, reason: `reserved worktree creation failed: ${added.reason}` };
  }
  // `scriptPath` is THIS process's own absolute path -- the controller's authoritative copy,
  // never the reserved checkout's own (possibly PR-modified or out-of-date) copy. Threaded
  // through `reserveFromGate` into `checkoutBinding` so `format-dispatch-prompt.mjs` can tell
  // the worker to invoke verification by this absolute path (Stage 1 finding P1 on PR #710:
  // a relative `tools/orchestration/pr-head-checkout-preflight.mjs`, run with the worker's cwd
  // inside the reserved/candidate checkout, would load THAT PR's own copy of this file instead).
  return { exitCode: 0, verdict: "RESERVED_CREATED", path, mode: "created", localBranch, scriptPath: SELF_SCRIPT_PATH, ...base };
}

function findBinding(worktrees, token) {
  return worktrees
    .map((w) => ({ worktree: w, binding: w.locked ? parseBindingLockReason(w.lockedReason) : null }))
    .filter((m) => m.binding && m.binding.token === token);
}

export async function verifyBinding(
  { repo, pr, token, cwd = process.cwd() },
  { ghPrViewImpl = defaultGhPrView, git = defaultGitImpl() } = {},
) {
  if (!isPositiveInteger(pr) || typeof token !== "string" || !token) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: "--verify-binding <token> and --pr <N> are both required" };
  }
  let state;
  try {
    state = readCheckoutState(git, cwd);
  } catch (err) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `could not read current checkout/worktree state: ${reasonOf(err)}` };
  }
  const matches = findBinding(state.worktrees, token);
  if (matches.length === 0) {
    return { exitCode: 2, verdict: "BINDING_NOT_FOUND", reason: `no worktree holds reservation ${token}` };
  }
  if (matches.length > 1) {
    return { exitCode: 2, verdict: "AMBIGUOUS", reason: `more than one worktree claims reservation ${token}`, paths: matches.map((m) => m.worktree.path) };
  }
  const [{ worktree, binding }] = matches;
  if (binding.pr !== pr) {
    return { exitCode: 2, verdict: "BINDING_MISMATCH", path: worktree.path, reason: `reservation ${token} is for PR #${binding.pr}, not PR #${pr}` };
  }
  if (isSamePath(worktree.path, state.primaryPath)) {
    return { exitCode: 2, verdict: "NO_SAFE_BINDING", path: worktree.path, reason: "the reserved checkout is the primary checkout" };
  }
  if (!isSamePath(state.path, worktree.path)) {
    return {
      exitCode: 2,
      verdict: "WRONG_CHECKOUT",
      path: worktree.path,
      reason: `verification ran in ${state.path}, not the reserved checkout ${worktree.path}`,
    };
  }
  const { head, error } = await resolveTargetHead(ghPrViewImpl, repo, pr);
  if (error) return error;
  if (head.sha !== binding.sha || head.branch !== binding.branch || state.sha !== head.sha) {
    return {
      exitCode: 2,
      verdict: "STALE_HEAD_MISMATCH",
      path: worktree.path,
      reason: `PR head is ${head.branch}@${head.sha}; reservation recorded ${binding.branch}@${binding.sha}; checkout is at ${state.sha}`,
    };
  }
  const dirty = git.isDirty(worktree.path);
  if (dirty !== false) {
    return {
      exitCode: 2,
      verdict: "DIRTY_CANDIDATE",
      path: worktree.path,
      reason: dirty === true ? "reserved checkout contains local modifications" : "reserved checkout cleanliness could not be determined",
    };
  }
  return {
    exitCode: 0,
    verdict: "BINDING_VERIFIED",
    path: worktree.path,
    pr,
    sha: head.sha,
    branch: head.branch,
    token,
    pushRefspec: pushRefspecFor(head.branch),
  };
}

export async function releaseBinding(
  { token, cwd = process.cwd() },
  { git = defaultGitImpl(), chdir = process.chdir.bind(process) } = {},
) {
  if (typeof token !== "string" || !token) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: "--release-binding <token> is required" };
  }
  let state;
  try {
    state = readCheckoutState(git, cwd);
  } catch (err) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `could not read current checkout/worktree state: ${reasonOf(err)}` };
  }
  const matches = findBinding(state.worktrees, token);
  if (matches.length !== 1) {
    return { exitCode: 2, verdict: matches.length === 0 ? "BINDING_NOT_FOUND" : "AMBIGUOUS", reason: `reservation ${token} matched ${matches.length} worktrees` };
  }
  const [{ worktree, binding }] = matches;
  const unlocked = git.unlockWorktree(state.primaryPath, worktree.path);
  if (!unlocked.ok) {
    return { exitCode: 2, verdict: "OCCUPIED_CANDIDATE", path: worktree.path, reason: `unlock failed: ${unlocked.reason}` };
  }
  const kept = (why) => ({ exitCode: 0, verdict: "RELEASED", path: worktree.path, removed: false, keptReason: why });
  // Defense in depth only: `reserve` above never produces a "in-place" mode binding any more
  // (the P1 fix above), so this branch is unreachable from that path today. It stays as a
  // fail-closed guard against a legacy lock reason written by pre-#710 code, whose worktree this
  // function never created and must never remove.
  if (binding.mode !== "created") return kept("only a created reservation's worktree is ever removed");
  // Issue #703 Stage 1 correction (P2 finding on PR #710): the generated dispatch prompt has the
  // worker run --release-binding from inside the reserved checkout itself -- there is no other
  // checkout for it to run this from. A directory that is a running process's own OS-level
  // current working directory cannot be removed on this repository's Windows hosts, even by a
  // different subprocess targeting it by path, so the prior unconditional early return here
  // (kept, never removed) meant every normal successful correction left its generated worktree
  // and local binding branch behind. Move this process's own working directory out of the
  // reserved path first -- to the primary checkout, which every git mutation below already uses
  // as its own cwd -- then evaluate clean/pushed/removal exactly as when release runs from
  // elsewhere. `chdir` is injectable so a caller that cannot tolerate a global cwd change can
  // supply its own relocation.
  if (isSamePath(state.path, worktree.path)) {
    try {
      chdir(state.primaryPath);
    } catch (err) {
      return kept(`could not leave the reserved checkout before evaluating removal: ${reasonOf(err)}`);
    }
  }
  if (git.isDirty(worktree.path) !== false) return kept("reserved checkout is not proven clean");
  const fetched = git.fetchBranch(state.primaryPath, binding.branch);
  const remoteSha = fetched.ok ? git.remoteBranchSha(state.primaryPath, binding.branch) : null;
  const tip = worktree.headCommit;
  if (!remoteSha || !tip || !(tip === remoteSha || git.isAncestor(state.primaryPath, tip, remoteSha))) {
    return kept(`reserved commit is not proven contained in origin/${binding.branch}`);
  }
  const removed = git.removeWorktree(state.primaryPath, worktree.path);
  if (!removed.ok) return kept(`worktree removal failed: ${removed.reason}`);
  if (worktree.branch && worktree.branch === bindingLocalBranch(binding.pr, binding.token)) {
    git.deleteLocalBranch(state.primaryPath, worktree.branch);
  }
  return { exitCode: 0, verdict: "RELEASED", path: worktree.path, removed: true };
}

// Pipeline stage between `next-review-transition-gate.mjs` and `format-dispatch-prompt.mjs`:
// a findings-bearing STAGE1_CORRECTION_REQUIRED verdict, or a STAGE1_CORRECTION_SATISFIED_
// MERGE_CONFLICT verdict (issue #665's conflict-recovery worker -- Stage 1 review finding on
// PR #719, P1: this recovery worker mutates source exactly like a findings correction worker
// does, so dispatching it without the same exclusive PR-head reservation reintroduces the
// path/worktree ambiguity this reservation pipeline exists to prevent), gains `checkoutBinding`
// (the settled surface the formatter requires); every other verdict passes through unchanged.
// A failed reservation replaces the verdict with CHECKOUT_BINDING_UNVERIFIED, which the
// formatter refuses to render, so no worker is ever spawned without a settled surface.
//
// The conflict-recovery case also pins the reservation to `gate.correctedHead` (the exact head
// `next-review-transition-gate.mjs` gated its conflict verdict against, via `reserve`'s own
// `expectedHead` check above) -- Stage 1 review finding on PR #719, P2: without this pin, a
// commit that lands on the PR after the gate ran, but before reservation, would silently
// become the worker's starting point without ever having passed the transition that
// authorized recovery.
export async function reserveFromGate(gate, { repo, cwd } = {}, deps = {}) {
  const isFindingsCorrection = gate?.state === "STAGE1_CORRECTION_REQUIRED" && gate.correctionReason !== "closing-reference";
  const isConflictRecovery = gate?.state === "STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT";
  if (!gate || (!isFindingsCorrection && !isConflictRecovery)) {
    return { exitCode: 0, output: gate };
  }
  const expectedHead = isConflictRecovery ? gate.correctedHead : null;
  const result = await reserve({ repo, pr: gate.pr, cwd, expectedHead }, deps);
  if (result.exitCode !== 0) {
    // Issue #703 Stage 1 correction (P2 finding on PR #710): a failed reservation must reach a
    // terminal, no-dispatch outcome that is itself representable as compliant -- the original
    // STAGE1_CORRECTION_REQUIRED envelope authorizes exactly `["reserve-correction-checkout",
    // "dispatch-correction-worker"]` in order, so a controller that correctly stops here (never
    // dispatching) would otherwise always be reported as missing the required dispatch action.
    // CHECKOUT_BINDING_UNVERIFIED is its own recognized verdict state in action-envelope.mjs
    // (mode "none", zero further authorized actions) precisely so compliance is checked against
    // THIS terminal verdict for whatever the controller does after receiving it, not against the
    // original bounded envelope the failed reservation never got to satisfy.
    const state = "CHECKOUT_BINDING_UNVERIFIED";
    return {
      exitCode: result.exitCode,
      output: {
        state,
        pr: gate.pr,
        verdict: result.verdict,
        reason: result.reason ?? result.message ?? null,
        stopAfter: true,
        actionEnvelope: getActionEnvelope(state),
      },
    };
  }
  const { path, token, sha, branch, mode, verdict, scriptPath } = result;
  return { exitCode: 0, output: { ...gate, checkoutBinding: { path, token, sha, branch, mode, verdict, scriptPath } } };
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
      // still exist unattached to any worktree -- the original `-B` reset would silently discard
      // it. Only proceed when no such ref exists, it already IS the target commit, or its tip is
      // safely contained in the target commit (no unique commits would be discarded).
      //
      // Stage 1 review finding on PR #696 (Finding P2): a failed lookup must never be read as
      // "no such branch" -- `localBranchTip` now rethrows anything other than the specific
      // documented "ref absent" exit, so that ambiguity fails closed here instead of silently
      // authorizing the branch-creation path on unproven ground.
      let existingTip;
      try {
        existingTip = git.localBranchTip(primaryPath, targetHead.branch);
      } catch (err) {
        return {
          exitCode: 2,
          verdict: "NO_SAFE_BINDING",
          reason: `could not determine whether local branch "${targetHead.branch}" already exists: ${reasonOf(err)}`,
        };
      }
      if (existingTip && existingTip !== targetHead.sha && !git.isAncestor(primaryPath, existingTip, targetHead.sha)) {
        return {
          exitCode: 2,
          verdict: "EXISTING_BRANCH_UNSAFE",
          branch: targetHead.branch,
          reason: "a local branch with this name already exists and is not safely contained in the PR's current head; refusing to reset it",
        };
      }
      // Stage 1 review finding on PR #696 (Finding P1): establish the branch's target commit via
      // one atomic compare-and-swap against exactly the tip this preflight just validated as
      // safe (or its absence). If any concurrent process moved the ref in between, the CAS
      // itself fails and nothing is mutated -- this is what makes the safety check above
      // atomic with the write, closing the prior read-then-reset TOCTOU window.
      const casResult = git.establishBranchAtSha(primaryPath, targetHead.branch, targetHead.sha, existingTip);
      if (!casResult.ok) {
        return {
          exitCode: 2,
          verdict: "EXISTING_BRANCH_UNSAFE",
          branch: targetHead.branch,
          reason: `local branch "${targetHead.branch}" changed concurrently and was not safely established at the target commit: ${casResult.reason}`,
        };
      }
      const addResult = git.addExistingBranchWorktree(primaryPath, path, targetHead.branch);
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

// Value-less flags (`--reserve`, `--reserve-from-gate`) never consume the following token.
const BOOLEAN_FLAGS = new Set(["reserve", "reserve-from-gate"]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.has(name)) args[name] = true;
    else args[name] = argv[++i];
  }
  return args;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

function toIntOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // release-binding needs no GitHub identity at all.
  if (args["release-binding"] !== undefined) {
    const result = await releaseBinding({ token: args["release-binding"] });
    if (result.message) console.error(result.message);
    console.log(JSON.stringify(result));
    process.exit(result.exitCode);
    return;
  }

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

  if (args["reserve-from-gate"]) {
    let gate;
    try {
      gate = JSON.parse(readStdin());
    } catch (err) {
      console.error(`pr-head-checkout-preflight.mjs: could not parse gate JSON on stdin: ${err.message}`);
      process.exit(1);
      return;
    }
    const { exitCode, output } = await reserveFromGate(gate, { repo: resolvedRepo });
    console.log(JSON.stringify(output));
    process.exit(exitCode);
    return;
  }

  const pr = toIntOrNull(args.pr);
  let result;
  if (args.reserve) result = await reserve({ repo: resolvedRepo, pr });
  else if (args["verify-binding"] !== undefined) result = await verifyBinding({ repo: resolvedRepo, pr, token: args["verify-binding"] });
  else result = await run({ repo: resolvedRepo, pr });
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
