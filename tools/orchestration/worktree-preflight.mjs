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
//     checkout that predates this mechanism): reconciled ONLY under the bounded legacy path --
//     its branch tip must be independently provable as merged into the repository's own default
//     branch, and `git worktree remove` (no `--force`) must itself succeed. Directory-name
//     pattern alone never authorizes removal (requirement/acceptance: "Directory-name pattern
//     alone is insufficient to authorize deletion").
//   - A ledger entry whose live branch no longer matches what was recorded: treated as
//     "ambiguous association" and left untouched.
//   - A ledger entry whose logical lineage (controlIssue, else executionIssue, else its own
//     sessionKey as a never-shared fallback) has NOT been superseded by any other entry with a
//     strictly later `lastConfirmedAt` is "active" for that lineage and left untouched --
//     including a lone predecessor nobody has proven obsolete yet.
//   - A ledger entry whose lineage HAS been superseded (this run's own current entry, or an
//     earlier run's, recorded a *different* path for the same controlIssue/executionIssue more
//     recently) is an eligible predecessor. Safety is then delegated to git itself: `git worktree
//     remove <path>` without `--force` already refuses a dirty, locked, or otherwise unsafe
//     worktree, so this script never reimplements that judgment and never force-deletes.
//
// Removing a worktree only detaches the checkout directory; it never deletes the branch or any
// commit reachable from it, so branch/commit provenance required by Worker Unit Contracts, PRs,
// or correction chains survives retirement untouched (#668 requirement 7/acceptance).
//
// `git worktree prune` runs once at the end, purely to drop administrative metadata for
// checkouts already missing from disk -- never as a substitute for the safety checks above.
//
// Usage:
//   node tools/orchestration/worktree-preflight.mjs
//     [--session-key K] [--control-issue N] [--execution-issue N] [--pr N]
//     [--managed-root PATH] [--dry-run]
//     Registers the CURRENT checkout (cwd) and reconciles its predecessors. This is the normal
//     fresh-session startup invocation.
//
//   node tools/orchestration/worktree-preflight.mjs register --path PATH
//     [--session-key K] [--control-issue N] [--execution-issue N] [--pr N]
//     Registers an out-of-band worktree (e.g. one an isolated Agent-tool dispatch just returned)
//     into the ledger without running reconciliation -- "capture association ... while it is
//     knowable" for a worktree this session did not itself start in.
//
// Exit codes: 0 on a completed run (see the JSON `outcomes` summary for what happened to each
// candidate); 1 on an operational error (git plumbing failed, ledger unreadable/unwritable).
//
// Tests: node --test tools/orchestration/worktree-preflight.test.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
    currentBranch(cwd) {
      return runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
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
  };
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

export function loadLedger(path, { readFileImpl = readFileSync } = {}) {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileImpl(path, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt ledger fails closed to "start fresh" rather than crashing the whole preflight --
    // durable branch/commit state lives in git itself, never only in this cache.
    return [];
  }
}

export function saveLedger(path, ledger, { writeFileImpl = writeFileSync, mkdirImpl = mkdirSync } = {}) {
  mkdirImpl(dirname(path), { recursive: true });
  writeFileImpl(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

// Pure. Lineage key groups entries that describe the same logical execution: controlIssue when
// known, else executionIssue, else the entry's own sessionKey (a fallback that can never be
// shared with any other entry, so an unassociated worktree is never treated as superseded by
// anything -- "directory-name pattern alone is insufficient" applies here too).
export function lineageKeyOf(entry) {
  if (entry.controlIssue != null) return `control:${entry.controlIssue}`;
  if (entry.executionIssue != null) return `execution:${entry.executionIssue}`;
  return `session:${entry.sessionKey}`;
}

// Pure. Inserts or refreshes the ledger entry for `info.path`. Association fields
// (controlIssue/executionIssue/pr) are updated only when explicitly supplied (non-undefined),
// so a later plain reconciliation run never blanks out lineage recorded at registration time.
export function upsertEntry(ledger, info, now) {
  const idx = ledger.findIndex((e) => e.path === info.path);
  const base =
    idx === -1
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
      : { ...ledger[idx] };
  if (idx !== -1) {
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

// Core reconciliation pass. Pure with respect to the outside world except through the injected
// `git`/`now` -- makes the whole decision procedure independently testable without a real
// multi-worktree checkout for every scenario. Returns `{ ledger: <next ledger>, outcomes: {...} }`.
export function reconcile({ ledger, liveWorktrees, currentPath, primaryPath, managedRoot, git, now }) {
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
      // Legacy/unattributed: only reclaim under independently-proven safety (requirement 11).
      const defaultRef = git.resolveDefaultBranchRef(primaryPath);
      const merged = defaultRef && live.headCommit ? git.isAncestor(primaryPath, live.headCommit, defaultRef) : false;
      if (!merged || live.locked) {
        outcomes.legacyRetained.push(live.path);
        continue;
      }
      const result = git.removeWorktree(primaryPath, live.path);
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

    if (live.locked) {
      outcomes.retainedLocked.push(live.path);
      nextLedger = nextLedger.map((e) => (e.path === entry.path ? { ...e, outcome: "retained_locked" } : e));
      continue;
    }

    const result = git.removeWorktree(primaryPath, live.path);
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
  const info = {
    path: targetPath,
    gitCommonDir,
    sessionKey: args["session-key"] || targetPath.split(/[\\/]/).filter(Boolean).pop(),
    branch: args.branch || git.currentBranch(branchCwd),
    commit: args.commit || git.currentCommit(branchCwd),
    controlIssue: args["control-issue"] !== undefined ? toIntOrNull(args["control-issue"]) : undefined,
    executionIssue: args["execution-issue"] !== undefined ? toIntOrNull(args["execution-issue"]) : undefined,
    pr: args.pr !== undefined ? toIntOrNull(args.pr) : undefined,
  };
  const { ledger: ledgerAfterUpsert, entry } = upsertEntry(ledger, info, now);

  if (registerOnly) {
    if (!args["dry-run"]) saveLedger(ledgerPath, ledgerAfterUpsert);
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
  });

  if (!args["dry-run"]) {
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
