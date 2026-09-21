#!/usr/bin/env node
// Deterministic fresh-session worktree startup-reconciliation primitive -- issue #668
// (execution slice for control #667).
//
// Problem this closes: Claude Dispatch opens a fresh `.claude/worktrees/<name>` checkout for
// every new Dispatch session -- not only the worktrees LDL itself requests via the Agent tool's
// `isolation: "worktree"` option (docs/operating-model.md, "Concurrent subagent directory
// isolation"). Neither kind of checkout was ever reclaimed once its session ended, so repeated
// fresh sessions and correction/PR chains accumulated branch-owning directories indefinitely
// (#441/#442 diagnostics; the #639/#638/PR #640 live branch collision against a retained
// `new-session-*` checkout).
//
// Founder decision (#667, 2026-09-21): cleanup is a *fresh-session startup preflight*, never a
// point an outgoing worker self-declares. This script is that preflight. It is deliberately not
// a scheduler, lease service, or daemon (#668 non-goals) -- it is one deterministic script a
// fresh session runs once at the very start of its own work, before substantive execution.
//
// Design summary
// --------------
// A small JSON ledger lives at `<git-common-dir>/ldl/worktrees.json` -- outside every disposable
// worktree checkout (the git common directory is the one location every worktree of a repository
// shares and that survives any single worktree's removal), so association metadata is never lost
// when its own worktree is retired. Each ledger entry records: `path` (the worktree's absolute
// checkout path), `gitCommonDir`, `sessionKey`, `branch`, `commit`, `controlIssue`,
// `executionIssue`, `pr` (nullable lineage fields), `registeredAt`, `lastConfirmedAt`, `retiredAt`,
// and the last-known `outcome`. None of this is machine-specific GitHub authority -- it is local
// resource-lifecycle metadata keyed by durable logical IDs (control/execution Issue numbers,
// PR numbers) precisely so a fresh session on a different machine could, in principle, rebuild
// the same lineage classification from GitHub state alone; the ledger only caches it locally.
//
// Every invocation first upserts the CURRENT checkout (cwd) as an entry, refreshing its
// `lastConfirmedAt` -- this is "capture association at session entry, while it is knowable"
// (#668 requirement 3) and unconditionally excludes the current path from its own run's
// candidate list (requirement 9). Reconciliation then applies to every OTHER live worktree
// found under the managed root (default: `<primary-worktree>/.claude/worktrees`), never to the
// primary/main checkout and never to a path outside that root:
//
//   - No ledger entry at all (legacy/unattributed, e.g. an old `new-session-*` Dispatch
//     checkout that predates this mechanism): reconciled ONLY under the bounded legacy path, and
//     ONLY when independent evidence establishes both durability and staleness -- neither alone
//     is attribution or obsolescence proof. Durability: its branch tip must be independently
//     provable as merged into the repository's own default branch. Staleness: the worktree's own
//     git-administrative directory (its `HEAD` file, updated by any checkout/commit activity in
//     that worktree) must not have been touched within `obsolescenceGracePeriodMs` (default: see
//     `DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS` below; the same test also gates the same-lineage
//     superseded-predecessor branch below) -- a checkout Claude Dispatch just created for a
//     session that has not yet run this preflight to register itself is otherwise
//     indistinguishable from a genuinely abandoned one merely by merged/clean state (Stage 1
//     review finding on PR #683). Unknown activity evidence fails closed to retention. Finally
//     `git worktree remove` (no `--force`) must itself succeed. Directory-name pattern alone
//     never authorizes removal (requirement/acceptance: "Directory-name pattern alone is
//     insufficient to authorize deletion").
//   - A ledger entry whose live branch no longer matches what was recorded: treated as
//     "ambiguous association" and left untouched. Detached-HEAD state is normalized to the same
//     `null` representation on both the registration and live-enumeration paths so a genuinely
//     unchanged detached predecessor compares equal rather than becoming permanently ambiguous
//     (Stage 1 review finding on PR #683).
//   - A ledger entry whose logical lineage (controlIssue, else executionIssue, else its own
//     sessionKey as a never-shared fallback) has NOT been superseded by any other entry with a
//     strictly later `lastConfirmedAt` is "active" for that lineage and left untouched --
//     including a lone predecessor nobody has proven obsolete yet. Reusing an existing checkout
//     path for a genuinely new session (a `sessionKey` that does not match what is already
//     recorded there) never inherits that path's prior lineage merely because IDs were not
//     repeated -- lineage resets to whatever this call explicitly supplies (`null` otherwise)
//     precisely so an unrelated new session can never make an active predecessor from the OLD
//     lineage look superseded (Stage 1 review finding on PR #683). Only a matching `sessionKey`
//     -- i.e. the same session confirming itself again -- is treated as a refresh that preserves
//     unset lineage fields.
//   - A ledger entry whose lineage HAS been superseded (this run's own current entry, or an
//     earlier run's, recorded a *different* path for the same controlIssue/executionIssue more
//     recently) is a CANDIDATE predecessor, never yet an eligible one: a newer registration for
//     the same lineage proves only ordering, never that this older worktree is no longer active
//     or needed (Stage 2 audit finding on issue #686 / control #667 -- the correction to PR #683's
//     original rule, which retired a same-lineage predecessor on registration-order alone). It
//     becomes eligible only once the SAME durability-AND-staleness test the legacy branch above
//     already applies also holds for it: its own commit must be independently provable as an
//     ancestor of the repository's default branch (durability -- the work is captured elsewhere),
//     AND its own git-administrative directory must show no activity within the configured grace
//     period (staleness -- nothing about it looks currently in use). A superseded predecessor that
//     fails either half is retained exactly like a not-yet-superseded one (`retainedActive`) --
//     ordering alone never authorizes removal. Only once BOTH the ordering and the
//     durability/staleness tests hold is safety delegated to git itself: `git worktree remove
//     <path>` without `--force` already refuses a dirty, locked, or otherwise unsafe worktree, so
//     this script never reimplements that judgment and never force-deletes.
//
// Removing a worktree only detaches the checkout directory; it never deletes the branch or any
// commit reachable from it, so branch/commit provenance required by Worker Unit Contracts, PRs,
// or correction chains survives retirement untouched (#668 requirement 7/acceptance).
//
// `git worktree prune` runs once at the end, purely to drop administrative metadata for
// checkouts already missing from disk -- never as a substitute for the safety checks above.
//
// `--dry-run` is observational only: it never removes a worktree, prunes administrative
// metadata, or writes the ledger. Rather than skipping only ledger persistence and prune after
// mutation already happened (the exact defect Stage 1 review found on PR #683), it swaps the
// real `git worktree remove` for a non-mutating `git status`-based check that reports what a
// real removal would find without ever invoking it.
//
// A corrupt or unreadable-but-present ledger file fails the whole run closed with an error --
// it is never silently treated as an empty/fresh ledger, which would discard every recorded
// association and route every managed-root worktree into the bounded legacy path as if none of
// them were ever registered (Stage 1 review finding on PR #683). A genuinely missing ledger file
// (first run ever) is the only case that legitimately starts from an empty ledger.
//
// Usage:
//   node tools/orchestration/worktree-preflight.mjs
//     [--session-key K] [--control-issue N] [--execution-issue N] [--pr N]
//     [--managed-root PATH] [--obsolescence-grace-period-ms N] [--dry-run true]
//     (`--legacy-grace-period-ms` remains accepted as a compatibility alias for the renamed
//     `--obsolescence-grace-period-ms` -- Stage 1 review finding on this PR.)
//     Registers the CURRENT checkout (cwd) and reconciles its predecessors. This is the normal
//     fresh-session startup invocation -- AGENTS.md's own mandatory form of this command supplies
//     `--control-issue`/`--execution-issue` whenever this session's own founder instruction or
//     dispatch prompt already names one (nearly always): passing an already-known identity here is
//     not the "manual optional flag" the #686 Stage 2 audit's second finding warned against, it is
//     the required substitution of a value this session already has. Omitting both when neither is
//     genuinely known falls back to a session-scoped identity that can never match any other
//     session's, so it registers safely but reconciles no cross-session predecessor by design --
//     never an error, merely narrower scope than the mandatory form provides. When the fresh
//     session genuinely cannot yet tell whether its known number is a control or execution issue
//     (the READY gate that determines this has not run yet), pass it as either flag -- lineage
//     grouping is role-neutral by issue number (Stage 1 review finding on this PR, `lineageKeyOf`),
//     so a later session that learns the correct role still reconciles the same lineage.
//
//   node tools/orchestration/worktree-preflight.mjs register --path PATH
//     [--session-key K] [--control-issue N] [--execution-issue N] [--pr N]
//     Registers an out-of-band worktree (e.g. one an isolated Agent-tool dispatch just returned)
//     into the ledger without running reconciliation -- "capture association ... while it is
//     knowable" for a worktree this session did not itself start in.
//
// Exit codes: 0 on a completed run (see the JSON `outcomes` summary for what happened to each
// candidate); 1 on an operational error (git plumbing failed, ledger corrupt/unwritable).
//
// Tests: node --test tools/orchestration/worktree-preflight.test.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// A legacy/unattributed worktree -- or, since the #686 Stage 2 audit correction, an attributed
// same-lineage predecessor that a newer registration has merely superseded by ordering -- is only
// ever reclaimed once its own administrative activity is at least this old. See
// `worktreeLastActivityAt` and `isDurablyObsolete` below. This is the "positive evidence of
// staleness" the merged/clean check alone cannot provide (Stage 1 review finding on PR #683): a
// checkout Claude Dispatch just created for a session that has not yet run this preflight to
// register itself is otherwise indistinguishable, by merged/clean state alone, from one genuinely
// abandoned -- and, per the #686 correction, a same-lineage predecessor that IS still actively
// running is otherwise indistinguishable, by registration-order alone, from one that is finished.
export const DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------------------------
// Git plumbing (thin, injectable so tests never require the real repository under test to be a
// deep multi-worktree checkout unless a test specifically wants one).
// ---------------------------------------------------------------------------------------------

function runGit(args, { cwd } = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function defaultGitImpl() {
  return {
    gitCommonDir(cwd) {
      return runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
    },
    toplevel(cwd) {
      return runGit(["rev-parse", "--show-toplevel"], { cwd });
    },
    // Detached HEAD normalizes to `null`, the same representation `parseWorktreeListPorcelain`
    // already uses for a live `detached` worktree -- `git rev-parse --abbrev-ref HEAD` otherwise
    // returns the literal string `"HEAD"`, permanently mismatching the live enumeration and
    // making a legitimately-associated detached predecessor unretireable (Stage 1 review finding
    // on PR #683).
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
    // Returns { ok: true } on success, { ok: false, reason } on any failure -- deliberately
    // never retried with `--force`. Git itself is the safety check: it refuses a dirty,
    // locked, or otherwise-unsafe worktree with a non-zero exit before this script ever sees a
    // result to interpret.
    removeWorktree(cwd, path) {
      try {
        runGit(["worktree", "remove", path], { cwd });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: String(err.stderr || err.message || err).trim() };
      }
    },
    // Non-mutating stand-in for `removeWorktree`, used only under `--dry-run` (issue: dry-run
    // must never call the real mutating removal -- Stage 1 review finding on PR #683). Reports
    // whether a real `git worktree remove` would currently succeed without ever invoking it,
    // ledger-writing, or pruning. `git status --porcelain` mirrors the one precondition this
    // script itself does not already check independently (locked state is checked separately);
    // it is not byte-for-byte identical to git's own internal remove precondition, but it never
    // mutates the worktree it inspects.
    checkRemovable(_cwd, path) {
      try {
        const status = runGit(["status", "--porcelain"], { cwd: path });
        if (status) return { ok: false, reason: "worktree contains modified or untracked files" };
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: String(err.stderr || err.message || err).trim() };
      }
    },
    // Returns an ISO timestamp for the most recent git-administrative activity recorded for the
    // worktree at `path` (its own `HEAD` file, updated by any checkout/commit inside it), or
    // `null` when it cannot be determined -- callers must fail closed on `null` rather than
    // treating unknown activity as either stale or fresh.
    worktreeLastActivityAt(_cwd, path) {
      try {
        const gitDir = runGit(["rev-parse", "--absolute-git-dir"], { cwd: path });
        return statSync(`${gitDir}/HEAD`).mtime.toISOString();
      } catch {
        return null;
      }
    },
    prune(cwd) {
      try {
        runGit(["worktree", "prune"], { cwd });
      } catch {
        // Purely administrative cleanup; a failure here is never fatal to the run.
      }
    },
    // Resolves the repository's own default-branch ref, trying the most authoritative source
    // first. Returns null if none resolve (e.g. no remote configured) -- legacy reclamation
    // then has no durability evidence available and must leave that worktree untouched.
    resolveDefaultBranchRef(cwd) {
      try {
        const symbolic = runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd });
        if (symbolic) return symbolic;
      } catch {
        // fall through
      }
      for (const candidate of ["refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"]) {
        try {
          runGit(["rev-parse", "--verify", "--quiet", candidate], { cwd });
          return candidate;
        } catch {
          // try next candidate
        }
      }
      return null;
    },
    isAncestor(cwd, commit, ref) {
      try {
        runGit(["merge-base", "--is-ancestor", commit, ref], { cwd });
        return true;
      } catch {
        return false;
      }
    },
    // `merge-base --is-ancestor` can never see a SQUASH merge: this repository's own normal
    // merge path (AGENTS.md's bounded review cycle references "the squash-merge commit message
    // GitHub proposes" throughout) replaces the branch's commit(s) with one brand-new commit on
    // the default branch whose parents do not include the branch tip, so the ancestor check
    // above is permanently false for every properly-merged worktree -- defeating durability
    // proof entirely and letting every reclaimed-in-practice worktree accumulate forever (Stage
    // 1 review finding on this PR). Detects squash-merge content-equivalence instead: the total
    // change the branch introduced since its merge-base, compared via `git patch-id`'s
    // content-stable hash against the total change already on the default branch since that same
    // merge-base. Patch-id (not a per-commit `git cherry` comparison) is used specifically
    // because it is robust to the branch having any number of its own commits collapsed into the
    // single squash commit -- `git cherry` only matches when commit boundaries line up on both
    // sides, which a squash by definition breaks. Returns false (never treated as merged)
    // whenever any step cannot be established -- unknown/undeterminable content evidence fails
    // closed exactly like every other durability signal in this file.
    isContentMergedIntoDefault(cwd, commit, ref) {
      try {
        const mergeBase = runGit(["merge-base", commit, ref], { cwd });
        if (!mergeBase) return false;
        const branchPatchId = diffPatchId(cwd, mergeBase, commit);
        const defaultPatchId = diffPatchId(cwd, mergeBase, ref);
        if (!branchPatchId || !defaultPatchId) return false;
        return branchPatchId === defaultPatchId;
      } catch {
        return false;
      }
    },
  };
}

// Returns `git patch-id --stable`'s content hash for the total diff from `from` to `to`, or
// `null` when there is no diff (an empty patch has no stable id) or the underlying git commands
// fail. `--stable` pins the hash to a form independent of the invoking git version's defaults, so
// two separately-computed ids for equivalent content always compare equal.
function diffPatchId(cwd, from, to) {
  const diff = execFileSync("git", ["diff", `${from}..${to}`], { cwd, encoding: "utf8" });
  if (!diff.trim()) return null;
  const out = execFileSync("git", ["patch-id", "--stable"], { cwd, encoding: "utf8", input: diff }).trim();
  const [id] = out.split(/\s+/);
  return id || null;
}

// Parses `git worktree list --porcelain` output into an array of
// `{ path, headCommit, branch, locked, lockedReason, prunable }`. `branch` is null for a
// detached-HEAD worktree. Pure -- no I/O.
export function parseWorktreeListPorcelain(text) {
  const blocks = String(text ?? "")
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split("\n");
    const entry = { path: null, headCommit: null, branch: null, locked: false, lockedReason: null, prunable: false };
    for (const line of lines) {
      if (line.startsWith("worktree ")) entry.path = line.slice("worktree ".length).trim();
      else if (line.startsWith("HEAD ")) entry.headCommit = line.slice("HEAD ".length).trim();
      else if (line.startsWith("branch ")) entry.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      else if (line === "detached") entry.branch = null;
      else if (line === "locked" || line.startsWith("locked ")) {
        entry.locked = true;
        entry.lockedReason = line === "locked" ? null : line.slice("locked ".length).trim();
      } else if (line === "prunable" || line.startsWith("prunable ")) {
        entry.prunable = true;
      }
    }
    return entry;
  });
}

// ---------------------------------------------------------------------------------------------
// Ledger (pure read/write + pure decision logic; I/O isolated to loadLedger/saveLedger).
// ---------------------------------------------------------------------------------------------

export function ledgerPathFor(gitCommonDir) {
  return `${gitCommonDir}/ldl/worktrees.json`;
}

// A genuinely missing ledger file (first run ever at this git-common-dir) legitimately starts
// from an empty ledger. A ledger file that EXISTS but is truncated, malformed, or otherwise
// unreadable/unparseable must never be treated the same way: silently substituting `[]` would
// discard every recorded association and route every currently-live managed-root worktree into
// the bounded legacy path as if none of them were ever registered -- exactly the failure mode
// Stage 1 review found on PR #683. This throws instead, so the whole run fails closed with an
// explicit error (surfaced by `main()` as a non-zero exit) rather than reconciling on
// manufactured "fresh ledger" evidence.
export function loadLedger(path, { readFileImpl = readFileSync } = {}) {
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileImpl(path, "utf8");
  } catch (err) {
    throw new Error(`worktree ledger at ${path} exists but could not be read: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`worktree ledger at ${path} is corrupt (invalid JSON): ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`worktree ledger at ${path} is corrupt (expected a JSON array)`);
  }
  return parsed;
}

export function saveLedger(path, ledger, { writeFileImpl = writeFileSync, mkdirImpl = mkdirSync } = {}) {
  mkdirImpl(dirname(path), { recursive: true });
  writeFileImpl(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

// Pure. Lineage key groups entries that describe the same logical execution: controlIssue when
// known, else executionIssue, else the entry's own sessionKey (a fallback that can never be
// shared with any other entry, so an unassociated worktree is never treated as superseded by
// anything -- "directory-name pattern alone is insufficient" applies here too).
//
// Deliberately role-NEUTRAL: an entry with `controlIssue: 5` and another with
// `executionIssue: 5` key identically (`issue:5`), rather than to distinguishable
// `control:5`/`execution:5` strings. AGENTS.md's mandatory startup form runs before a fresh
// `work on #N` session can know whether `#N` is itself the control issue or an execution/
// legacy issue -- the READY gate that determines this is the very next step, not something the
// preflight call can wait for -- so different sessions for the exact same real-world lineage can
// legitimately guess opposite roles for the same number (Stage 1 review finding on this PR). A
// role-keyed split would then never let one supersede or reconcile the other. This is safe
// specifically because GitHub issue numbers are unique per repository: `#5` denotes exactly one
// issue with exactly one true role, so folding `control:5` and `execution:5` into one key can
// never conflate two genuinely different lineages -- it only ever reunites two records of the
// same one under whichever role each session guessed.
export function lineageKeyOf(entry) {
  if (entry.controlIssue != null) return `issue:${entry.controlIssue}`;
  if (entry.executionIssue != null) return `issue:${entry.executionIssue}`;
  return `session:${entry.sessionKey}`;
}

// Pure. Inserts or refreshes the ledger entry for `info.path`. Association fields
// (controlIssue/executionIssue/pr) are updated only when explicitly supplied (non-undefined) --
// EXCEPT that reusing an already-registered path under a DIFFERENT `sessionKey` is a new session,
// never a same-session refresh, and must never inherit the prior occupant's lineage merely
// because this call did not repeat its IDs: a fresh session for unrelated (or no) work that
// happens to reuse a path -- most plausibly the persistent primary checkout -- would otherwise be
// recorded as the newest member of the OLD lineage, making an active predecessor worktree from
// that old control/execution issue look superseded and eligible for removal (Stage 1 review
// finding on PR #683). Only a matching `sessionKey` is treated as the same session confirming
// itself again, which preserves unset lineage fields exactly as before.
export function upsertEntry(ledger, info, now) {
  const idx = ledger.findIndex((e) => e.path === info.path);
  const previous = idx === -1 ? null : ledger[idx];
  const isContinuation = previous != null && info.sessionKey != null && previous.sessionKey === info.sessionKey;
  const base =
    previous == null
      ? {
          path: info.path,
          gitCommonDir: info.gitCommonDir,
          sessionKey: info.sessionKey,
          branch: info.branch,
          commit: info.commit,
          controlIssue: info.controlIssue ?? null,
          executionIssue: info.executionIssue ?? null,
          pr: info.pr ?? null,
          registeredAt: now,
          lastConfirmedAt: now,
          retiredAt: null,
          outcome: null,
        }
      : {
          ...previous,
          // A new session reusing this path resets stale lineage before this call's own explicit
          // values (below) are applied; a continuation preserves it, as before.
          controlIssue: isContinuation ? previous.controlIssue : null,
          executionIssue: isContinuation ? previous.executionIssue : null,
          pr: isContinuation ? previous.pr : null,
        };
  if (previous != null) {
    base.sessionKey = info.sessionKey;
    base.branch = info.branch ?? base.branch;
    base.commit = info.commit ?? base.commit;
    if (info.controlIssue !== undefined) base.controlIssue = info.controlIssue;
    if (info.executionIssue !== undefined) base.executionIssue = info.executionIssue;
    if (info.pr !== undefined) base.pr = info.pr;
    base.lastConfirmedAt = now;
    base.retiredAt = null;
    base.outcome = null;
  }
  const next = idx === -1 ? [...ledger, base] : [...ledger.slice(0, idx), base, ...ledger.slice(idx + 1)];
  return { ledger: next, entry: base };
}

// Pure. True when some OTHER entry with the same lineage key has a strictly later
// lastConfirmedAt than `entry` -- i.e. a fresher checkout exists for the same logical
// control/execution work, so `entry` is a retireable predecessor rather than merely idle.
export function isSuperseded(entry, ledger) {
  const key = lineageKeyOf(entry);
  return ledger.some(
    (other) => other.path !== entry.path && lineageKeyOf(other) === key && new Date(other.lastConfirmedAt).getTime() > new Date(entry.lastConfirmedAt).getTime(),
  );
}

// ---------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------

function isUnderRoot(path, root) {
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(normalizedRoot);
}

// Removal attempt shared by both the legacy and superseded-predecessor branches below. Under
// `--dry-run` this calls the non-mutating `checkRemovable` instead of the real `removeWorktree`,
// so a dry run never removes a worktree regardless of which branch decided it was eligible
// (Stage 1 review finding on PR #683: the previous dry-run guard only skipped ledger/prune AFTER
// the real removal had already run).
function attemptRemoval(git, primaryPath, path, dryRun) {
  return dryRun ? git.checkRemovable(primaryPath, path) : git.removeWorktree(primaryPath, path);
}

// Pure decision, impure only through the injected `git`. True only when BOTH independently hold
// for the live worktree `live`:
//   - durability: its own head commit is a provable ancestor of the repository's resolved default
//     branch, so whatever it contains is captured elsewhere and this specific checkout is no
//     longer uniquely required;
//   - staleness: its own git-administrative directory (its `HEAD` file) shows no activity within
//     `gracePeriodMs`.
// Neither alone is obsolescence proof. This was originally the legacy/unattributed branch's own
// test (Stage 1 review finding on PR #683: "merged and clean" alone never proves no live session
// still owns the checkout). The #686 Stage 2 audit found the SAME gap one level up: `reconcile`'s
// same-lineage branch treated a newer registration's mere existence as sufficient obsolescence
// proof for an older, still-possibly-active predecessor sharing that lineage. This helper is now
// shared by both branches below so a same-lineage predecessor is never removed on registration-
// order alone -- ordering (`isSuperseded`) establishes which entry is the candidate; this
// establishes whether removing it is actually safe. Unknown/undeterminable activity evidence
// fails closed to `false`.
//
// Durability accepts either an ordinary ancestor (fast-forward/merge-commit) or a content-
// equivalent squash merge (`isContentMergedIntoDefault` -- Stage 1 review finding on this PR:
// `isAncestor` alone can never see this repository's own normal squash-merge path).
//
// `entryLastConfirmedAt` (optional) is the OWNING session's own most recent ledger
// self-confirmation for this exact worktree -- set only by that worktree's own preflight
// invocation, so it is a genuine (if coarse) liveness signal distinct from git-administrative
// mtime, which a session that reads/tests/reviews without committing never refreshes (Stage 1
// review finding on this PR). Folding in the LATER of the two signals closes the gap for a
// session that registered recently but has not since touched `HEAD`; it does not, by itself,
// prove a still-running session with no recent registration and no recent commit is inactive --
// a continuous liveness/heartbeat signal would require a lease-service-like mechanism #668's own
// non-goals explicitly rule out ("deliberately not a scheduler, lease service, or daemon"), so
// this remains a best-effort mitigation bounded by that design constraint, not a complete proof.
export function isDurablyObsolete(git, primaryPath, live, now, gracePeriodMs, entryLastConfirmedAt = null) {
  const defaultRef = git.resolveDefaultBranchRef(primaryPath);
  const merged =
    defaultRef && live.headCommit
      ? git.isAncestor(primaryPath, live.headCommit, defaultRef) ||
        Boolean(git.isContentMergedIntoDefault?.(primaryPath, live.headCommit, defaultRef))
      : false;
  if (!merged) return false;
  const gitActivityAt = git.worktreeLastActivityAt(primaryPath, live.path);
  if (gitActivityAt == null && entryLastConfirmedAt == null) return false;
  const gitActivityMs = gitActivityAt == null ? -Infinity : new Date(gitActivityAt).getTime();
  const confirmedMs = entryLastConfirmedAt == null ? -Infinity : new Date(entryLastConfirmedAt).getTime();
  const lastActivityMs = Math.max(gitActivityMs, confirmedMs);
  return new Date(now).getTime() - lastActivityMs >= gracePeriodMs;
}

// Core reconciliation pass. Pure with respect to the outside world except through the injected
// `git`/`now` -- makes the whole decision procedure independently testable without a real
// multi-worktree checkout for every scenario. Returns `{ ledger: <next ledger>, outcomes: {...} }`.
export function reconcile({
  ledger,
  liveWorktrees,
  currentPath,
  primaryPath,
  managedRoot,
  git,
  now,
  dryRun = false,
  obsolescenceGracePeriodMs = DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS,
}) {
  const outcomes = {
    current: currentPath,
    retired: [],
    alreadyAbsent: [],
    retainedDirty: [],
    retainedLocked: [],
    retainedActive: [],
    retainedAmbiguous: [],
    legacyReclaimed: [],
    legacyRetained: [],
    ineligibleUnrelated: [],
  };

  let nextLedger = ledger;
  const liveByPath = new Map(liveWorktrees.map((w) => [w.path, w]));

  // First, reconcile every ledger entry whose checkout has already disappeared from disk
  // (removed manually, or by a prior run) -- idempotent no-op bookkeeping only.
  nextLedger = nextLedger.map((entry) => {
    if (entry.path === currentPath) return entry;
    if (liveByPath.has(entry.path)) return entry;
    if (entry.outcome === "already_absent") return entry; // already recorded; nothing to do
    outcomes.alreadyAbsent.push(entry.path);
    return { ...entry, retiredAt: entry.retiredAt ?? now, outcome: "already_absent" };
  });

  for (const live of liveWorktrees) {
    if (live.path === currentPath) continue;
    if (live.path === primaryPath) continue;
    if (!isUnderRoot(live.path, managedRoot)) {
      outcomes.ineligibleUnrelated.push(live.path);
      continue;
    }

    const entry = nextLedger.find((e) => e.path === live.path);

    if (!entry) {
      // Legacy/unattributed: only reclaim under independently-proven durability AND staleness
      // (requirement 11; Stage 1 review finding on PR #683 for the staleness half -- "merged and
      // clean" alone proves durability, never that no live/not-yet-registered session still owns
      // this checkout). Unknown activity evidence fails closed to retention.
      if (live.locked || !isDurablyObsolete(git, primaryPath, live, now, obsolescenceGracePeriodMs)) {
        outcomes.legacyRetained.push(live.path);
        continue;
      }
      const result = attemptRemoval(git, primaryPath, live.path, dryRun);
      if (result.ok) {
        outcomes.legacyReclaimed.push(live.path);
      } else {
        outcomes.legacyRetained.push({ path: live.path, reason: result.reason });
      }
      continue;
    }

    if (entry.branch !== live.branch) {
      outcomes.retainedAmbiguous.push(live.path);
      nextLedger = nextLedger.map((e) => (e.path === entry.path ? { ...e, outcome: "retained_ambiguous" } : e));
      continue;
    }

    if (!isSuperseded(entry, nextLedger)) {
      outcomes.retainedActive.push(live.path);
      nextLedger = nextLedger.map((e) => (e.path === entry.path ? { ...e, outcome: "retained_active" } : e));
      continue;
    }

    // A newer same-lineage registration proves ORDERING only, never obsolescence (Stage 2 audit
    // finding on #686 / control #667). Apply the identical durability-AND-staleness test the
    // legacy branch above already uses before treating this candidate as removal-eligible -- a
    // superseded predecessor that is not independently proven durable and stale is retained
    // exactly like one that has not been superseded at all. Unlike the legacy branch, a same-
    // lineage candidate HAS its own ledger entry, so its own most recent self-confirmation
    // (`entry.lastConfirmedAt`) is passed as an additional liveness signal alongside git-
    // administrative mtime (Stage 1 review finding on this PR).
    if (!isDurablyObsolete(git, primaryPath, live, now, obsolescenceGracePeriodMs, entry.lastConfirmedAt)) {
      outcomes.retainedActive.push(live.path);
      nextLedger = nextLedger.map((e) => (e.path === entry.path ? { ...e, outcome: "retained_active" } : e));
      continue;
    }

    if (live.locked) {
      outcomes.retainedLocked.push(live.path);
      nextLedger = nextLedger.map((e) => (e.path === entry.path ? { ...e, outcome: "retained_locked" } : e));
      continue;
    }

    const result = attemptRemoval(git, primaryPath, live.path, dryRun);
    if (result.ok) {
      outcomes.retired.push(live.path);
      nextLedger = nextLedger.map((e) => (e.path === entry.path ? { ...e, retiredAt: now, outcome: "retired" } : e));
    } else {
      outcomes.retainedDirty.push({ path: live.path, reason: result.reason });
      nextLedger = nextLedger.map((e) => (e.path === entry.path ? { ...e, outcome: "retained_dirty" } : e));
    }
  }

  return { ledger: nextLedger, outcomes };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

function toIntOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function runPreflight({ args, git = defaultGitImpl(), now = new Date().toISOString(), cwd = process.cwd() } = {}) {
  const gitCommonDir = git.gitCommonDir(cwd);
  const primaryPath = parseWorktreeListPorcelain(git.worktreeListPorcelain(cwd))[0]?.path ?? git.toplevel(cwd);
  const currentPath = git.toplevel(cwd);
  const managedRoot = args["managed-root"] || `${primaryPath}/.claude/worktrees`;
  const ledgerPath = ledgerPathFor(gitCommonDir);
  const ledger = loadLedger(ledgerPath);

  const registerOnly = Array.isArray(args._) && args._[0] === "register";
  const targetPath = registerOnly ? args.path : currentPath;
  if (registerOnly && !targetPath) {
    return { exitCode: 1, message: "register requires --path" };
  }
  // In `register` mode the target worktree is not necessarily the invoking process's own cwd
  // (e.g. registering an isolated Agent-tool worktree from the orchestrating session's own
  // directory), so branch/commit are always read directly from the target path itself -- never
  // assumed from the caller's cwd. `--branch`/`--commit` remain available to override when the
  // target path is not (or is no longer) a live worktree to inspect directly.
  const branchCwd = registerOnly ? targetPath : cwd;
  // The default sessionKey folds in `now` (not just the path's own basename) precisely so a
  // genuinely NEW session reusing an already-registered path -- without an explicit
  // `--session-key` -- is never mistaken by `upsertEntry` for the same session confirming itself
  // again, which would otherwise let it inherit and refresh that path's stale prior lineage
  // (Stage 1 review finding on PR #683). A caller that legitimately wants same-session refresh
  // semantics across multiple invocations passes an explicit, stable `--session-key`.
  const info = {
    path: targetPath,
    gitCommonDir,
    sessionKey: args["session-key"] || `${targetPath.split(/[\\/]/).filter(Boolean).pop()}-${now}`,
    branch: args.branch || git.currentBranch(branchCwd),
    commit: args.commit || git.currentCommit(branchCwd),
    controlIssue: args["control-issue"] !== undefined ? toIntOrNull(args["control-issue"]) : undefined,
    executionIssue: args["execution-issue"] !== undefined ? toIntOrNull(args["execution-issue"]) : undefined,
    pr: args.pr !== undefined ? toIntOrNull(args.pr) : undefined,
  };
  const { ledger: ledgerAfterUpsert, entry } = upsertEntry(ledger, info, now);
  const dryRun = Boolean(args["dry-run"]);
  // `--legacy-grace-period-ms` was this option's name before this PR broadened its scope beyond
  // the legacy branch and renamed it to `--obsolescence-grace-period-ms`. The already-merged
  // predecessor (PR #683) documented the old name as the mandatory form's own flag, so a caller
  // that has not yet picked up the rename must not have its configured window silently replaced
  // by the default (Stage 1 review finding on this PR). Accepted as a compatibility alias with
  // `--obsolescence-grace-period-ms` taking precedence when both are supplied.
  const obsolescenceGracePeriodMs =
    args["obsolescence-grace-period-ms"] !== undefined
      ? (toIntOrNull(args["obsolescence-grace-period-ms"]) ?? DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS)
      : args["legacy-grace-period-ms"] !== undefined
        ? (toIntOrNull(args["legacy-grace-period-ms"]) ?? DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS)
        : DEFAULT_OBSOLESCENCE_GRACE_PERIOD_MS;

  if (registerOnly) {
    if (!dryRun) saveLedger(ledgerPath, ledgerAfterUpsert);
    return { exitCode: 0, result: { registered: entry } };
  }

  const liveWorktrees = parseWorktreeListPorcelain(git.worktreeListPorcelain(cwd));
  const { ledger: finalLedger, outcomes } = reconcile({
    ledger: ledgerAfterUpsert,
    liveWorktrees,
    currentPath,
    primaryPath,
    managedRoot,
    git,
    now,
    dryRun,
    obsolescenceGracePeriodMs,
  });

  if (!dryRun) {
    saveLedger(ledgerPath, finalLedger);
    git.prune(primaryPath);
  }

  return { exitCode: 0, result: outcomes };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = runPreflight({ args });
  } catch (err) {
    console.error(`worktree-preflight failed: ${err.message}`);
    process.exit(1);
    return;
  }
  if (result.exitCode !== 0) {
    console.error(result.message);
    process.exit(result.exitCode);
    return;
  }
  console.log(JSON.stringify(result.result));
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("worktree-preflight.mjs")) {
  main();
}
