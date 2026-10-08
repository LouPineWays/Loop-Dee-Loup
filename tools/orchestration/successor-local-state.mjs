// Local-only successor workspace classification -- issue #968 (control #951; live #867/#868/#869).
//
// `successor-integration-preflight.mjs` (issue #950) answers "is there a successor PR?" from
// GitHub alone. A successor attempt that was interrupted before its first push exists only as a
// local branch (and usually an LDL-created worktree), so a remote-only check misreports it as
// NO_SUCCESSOR and every fresh controller re-discovers the same unpushed branch. This module
// classifies that machine-local state. It is read-only except `reclaimLocalSuccessor`, which is
// invoked only for a STALE_RECLAIMABLE verdict.
//
// Identity: local branch `issue-<execution>-successor-of-<predecessor>-attempt-<k>`. Exactly one
// such branch may exist; more than one is ambiguous. Attribution of its worktree (if any) requires
// the worktree to be a non-primary LDL-owned checkout: either its lock reason is this module's
// PR-head binding shape for the same predecessor PR, or it sits under `.claude/worktrees/`.
//
// Liveness evidence (never file mtime / index activity, which cannot distinguish a live worker
// from a crashed one, and never provider session inventory, which #441 showed is incomplete):
// whether any process still holds the worktree path. Windows: a rename probe (a directory that is
// any process's cwd or holds an open handle cannot be renamed). Linux: /proc/<pid>/cwd scan.
// Anything else (or an unreadable probe) is UNKNOWN, which is never treated as free.
//
//   LIVE_OWNED        path held by a live process (or git index.lock present) -> no duplicate dispatch
//   RESUMABLE         attributable, path free, unique work (commits ahead / in-progress operation /
//                     dirty tree) -> one fresh worker adopts it
//   STALE_RECLAIMABLE attributable, path free, clean tree, no operation in progress -> bounded
//                     retirement (commits, if any, archived under refs/ldl/reclaimed/) then restart
//   AMBIGUOUS         everything else -> fail closed with evidence; nothing is touched
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readlinkSync, renameSync } from "node:fs";
import { normalizePathForComparison } from "./classify-primary-path-lock.mjs";
import { parseBindingLockReason } from "./pr-head-checkout-preflight.mjs";

const SHA_RE = /^[0-9a-f]{40}$/i;

function git(args, { cwd, allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

export function parseWorktreePorcelain(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), branch: null, locked: false, lockedReason: null };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "locked" || line.startsWith("locked ")) {
      cur.locked = true;
      cur.lockedReason = line.length > 6 ? line.slice(7) : null;
    }
  }
  return out;
}

// Process-holds-path probe. Returns "OCCUPIED" | "FREE" | "UNKNOWN".
export function defaultProbeOccupancy(path) {
  if (!existsSync(path)) return "FREE";
  if (process.platform === "win32") {
    const probe = `${path}.ldl-occupancy-probe`;
    if (existsSync(probe)) return "UNKNOWN";
    try {
      renameSync(path, probe);
    } catch (err) {
      return err && (err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES") ? "OCCUPIED" : "UNKNOWN";
    }
    try {
      renameSync(probe, path);
    } catch {
      return "UNKNOWN"; // could not restore: surface as unprovable, never as free
    }
    return "FREE";
  }
  if (process.platform === "linux") {
    try {
      const want = normalizePathForComparison(path);
      for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
        let cwd;
        try {
          cwd = readlinkSync(`/proc/${pid}/cwd`);
        } catch {
          continue;
        }
        const c = normalizePathForComparison(cwd);
        if (c === want || c.startsWith(`${want}/`)) return "OCCUPIED";
      }
      return "FREE";
    } catch {
      return "UNKNOWN";
    }
  }
  return "UNKNOWN";
}

export function defaultLocalGit(cwd) {
  return {
    primaryPath: () => normalizePathForComparison(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd }).replace(/[\\/]\.git$/, "")),
    worktrees: () => parseWorktreePorcelain(git(["worktree", "list", "--porcelain"], { cwd })),
    branches: (prefix) => git(["for-each-ref", "--format=%(refname:short) %(objectname)", `refs/heads/${prefix}`], { cwd }).split(/\r?\n/).filter(Boolean).map((l) => {
      const [name, sha] = l.split(" ");
      return { name, sha };
    }),
    hasCommit: (sha) => git(["cat-file", "-e", `${sha}^{commit}`], { cwd, allowFail: true } ) !== null,
    mergeBase: (a, b) => git(["merge-base", a, b], { cwd, allowFail: true }),
    aheadCount: (base, tip) => Number(git(["rev-list", "--count", `${base}..${tip}`], { cwd })),
    status: (path) => git(["status", "--porcelain"], { cwd: path }),
    inProgress: (path) => {
      const found = [];
      for (const [name, marker] of [["cherry-pick", "CHERRY_PICK_HEAD"], ["merge", "MERGE_HEAD"], ["revert", "REVERT_HEAD"], ["rebase", "rebase-merge"], ["rebase", "rebase-apply"], ["lock", "index.lock"]]) {
        const p = git(["rev-parse", "--path-format=absolute", "--git-path", marker], { cwd: path, allowFail: true });
        if (p && existsSync(p)) found.push(name);
      }
      return found;
    },
    currentWorktree: () => {
      const top = git(["rev-parse", "--show-toplevel"], { cwd, allowFail: true });
      return top ? normalizePathForComparison(top) : null;
    },
    remoteBranch: (branch) => {
      // Three-way result: sha = present, null = origin readable and branch CONFIRMED absent,
      // undefined = unprovable (no origin, or lookup failed). Unprovable is never "absent" (#970).
      if (git(["remote", "get-url", "origin"], { cwd, allowFail: true }) === null) return undefined;
      const out = git(["ls-remote", "--heads", "origin", branch], { cwd, allowFail: true });
      if (out === null) return undefined; // unreadable
      const m = /^([0-9a-f]{40})\s/i.exec(out);
      return m ? m[1] : null;
    },
  };
}

const ambiguous = (reason, extra = {}) => ({ state: "FAIL_CLOSED", exitCode: 2, reason: `AMBIGUOUS_LOCAL_SUCCESSOR: ${reason}`, ...extra });

function attributable(w, predecessorPr, primaryPath) {
  if (normalizePathForComparison(w.path) === primaryPath) return "worktree is the primary checkout";
  if (w.locked) {
    const b = parseBindingLockReason(w.lockedReason ?? "");
    if (!b) return "worktree is locked by something other than an LDL checkout binding";
    if (Number(b.pr) !== predecessorPr) return `worktree binding is for PR #${b.pr}, not #${predecessorPr}`;
    return null;
  }
  return /[\\/]\.claude[\\/]worktrees[\\/]/.test(w.path) ? null : "worktree is not under .claude/worktrees and not an LDL binding";
}

// Returns null when no local successor state exists for this execution/predecessor pair.
export function inspectLocalSuccessor(
  { executionIssue, predecessorPr, target, attempt = null, callerWorktree = null, cwd = process.cwd() },
  { localGit = defaultLocalGit(cwd), probeOccupancy = defaultProbeOccupancy } = {},
) {
  const prefix = `issue-${executionIssue}-successor-of-${predecessorPr}-attempt-`;
  // Only the expected current attempt is inspected when known: a surviving branch of a closed
  // historical attempt is not this attempt's local state.
  const re = new RegExp(`^${prefix}${Number.isInteger(attempt) && attempt > 0 ? attempt : "\\d+"}$`);
  const branches = localGit.branches(`${prefix}*`).filter((b) => re.test(b.name));
  if (branches.length === 0) {
    // Audit #970: a canonical successor pushed by an interrupted worker may exist only on origin.
    // Positively confirm remote absence before the caller may treat this as "no successor".
    const expected = Number.isInteger(attempt) && attempt > 0 ? `${prefix}${attempt}` : `${prefix}*`;
    const remoteOnly = localGit.remoteBranch(expected);
    if (remoteOnly === null) return null;
    return ambiguous(
      remoteOnly === undefined
        ? "cannot read origin to prove no successor branch was already pushed; not authorizing a new successor"
        : `successor branch ${expected} already exists on origin (${remoteOnly}) with no local copy and no open PR; reuse it (fetch and check it out) instead of creating another`,
      { branch: expected, remoteSha: remoteOnly ?? null },
    );
  }
  if (branches.length > 1) return ambiguous(`multiple local successor branches (${branches.map((b) => b.name).join(", ")})`, { branches: branches.map((b) => b.name) });
  const { name: branch, sha: tip } = branches[0];
  const base = { branch, tip, target };
  if (!SHA_RE.test(target?.sha ?? "") || !localGit.hasCommit(target.sha)) {
    return ambiguous(`target ${target?.sha} is not present locally; cannot revalidate`, base);
  }
  const mergeBase = localGit.mergeBase(target.sha, tip);
  if (!mergeBase) return ambiguous("branch shares no history with the target", base);
  const ahead = localGit.aheadCount(mergeBase, tip);
  const targetMoved = mergeBase.toLowerCase() !== target.sha.toLowerCase();
  const wts = localGit.worktrees().filter((w) => w.branch === branch);
  if (wts.length > 1) return ambiguous("branch is checked out in more than one worktree", { ...base, paths: wts.map((w) => w.path) });
  const wt = wts[0] && existsSync(wts[0].path) ? wts[0] : null;
  const remoteSha = localGit.remoteBranch(branch);
  // Audit #972: unprovable origin (undefined) must fail closed for every classification, not only
  // reclaimable ones; never collapse it into remoteSha:null / pushed:false.
  if (remoteSha === undefined) {
    return ambiguous("cannot read origin to prove whether the successor branch was already pushed; not authorizing", base);
  }
  const remote = { remoteSha, pushed: Boolean(remoteSha) };
  // A pushed (or unprovably-unpushed) attempt must never be retired as local-only: recreating the
  // branch would collide with the divergent remote ref and strand the required successor PR.
  const reclaimable = (payload) =>
    remoteSha === null
      ? payload
      : ambiguous(
          remoteSha === undefined
            ? "cannot read origin to prove the successor branch was never pushed; not reclaiming"
            : `successor branch ${branch} is already pushed to origin (${remoteSha}) without an open PR; not reclaimable as local-only -- reconcile the remote attempt instead`,
          { ...base, path: payload.path ?? null },
        );

  if (wt) {
    const why = attributable(wt, predecessorPr, localGit.primaryPath());
    if (why) return ambiguous(why, { ...base, path: wt.path });
    if (callerWorktree && normalizePathForComparison(wt.path) === normalizePathForComparison(callerWorktree)) {
      const actual = localGit.currentWorktree?.() ?? null;
      if (!actual || actual !== normalizePathForComparison(callerWorktree)) {
        return ambiguous(`--worktree ${callerWorktree} is not the current checkout (${actual ?? "unknown"}); run preflight from inside the declared worktree`, { ...base, path: wt.path });
      }
      return { state: "CALLER_OWNED", branch, path: wt.path, targetMoved, ...remote };
    }
    const occupancy = probeOccupancy(wt.path);
    if (occupancy === "OCCUPIED") {
      return { state: "LOCAL_SUCCESSOR_LIVE_OWNED", exitCode: 0, ...base, path: wt.path, evidence: "worktree path is held by a live process", ...remote };
    }
    if (occupancy !== "FREE") return ambiguous("cannot prove whether a live worker holds the worktree path (occupancy probe unavailable)", { ...base, path: wt.path });
    const ops = localGit.inProgress(wt.path);
    if (ops.includes("lock")) {
      return { state: "LOCAL_SUCCESSOR_LIVE_OWNED", exitCode: 0, ...base, path: wt.path, evidence: "git index.lock present", ...remote };
    }
    const dirty = localGit.status(wt.path).length > 0;
    const unique = ahead > 0 || ops.length > 0 || dirty;
    const progress = { commitsAhead: ahead, operation: ops[0] ?? null, dirty, targetMoved };
    if (!unique) {
      return reclaimable({ state: "LOCAL_SUCCESSOR_STALE_RECLAIMABLE", exitCode: 0, ...base, path: wt.path, progress, ...remote });
    }
    if (targetMoved && (ops.length > 0 || dirty)) {
      return ambiguous(`target moved (branch base ${mergeBase}) while uncommitted/in-progress work exists; not resumable or reclaimable without losing work`, { ...base, path: wt.path, progress });
    }
    if (targetMoved) {
      return reclaimable({ state: "LOCAL_SUCCESSOR_STALE_RECLAIMABLE", exitCode: 0, ...base, path: wt.path, progress, archive: true, ...remote });
    }
    return {
      state: "LOCAL_SUCCESSOR_RESUMABLE",
      exitCode: 0,
      ...base,
      path: wt.path,
      progress,
      ...remote,
      action: `resume in ${wt.path} on ${branch} (do not create a branch or binding); finish any ${ops[0] ?? "in-progress"} operation, then rerun preflight with --worktree ${wt.path} --expect-target ${target.sha} before pushing`,
    };
  }

  // Branch exists without any worktree: no process can hold a path, work (if any) is committed.
  if (ahead === 0) return reclaimable({ state: "LOCAL_SUCCESSOR_STALE_RECLAIMABLE", exitCode: 0, ...base, path: null, progress: { commitsAhead: 0, targetMoved }, ...remote });
  if (targetMoved) return reclaimable({ state: "LOCAL_SUCCESSOR_STALE_RECLAIMABLE", exitCode: 0, ...base, path: null, progress: { commitsAhead: ahead, targetMoved }, archive: true, ...remote });
  return {
    state: "LOCAL_SUCCESSOR_RESUMABLE",
    exitCode: 0,
    ...base,
    path: null,
    progress: { commitsAhead: ahead, operation: null, dirty: false, targetMoved },
    ...remote,
    action: `check out existing ${branch} (no worktree holds it); do not create a new branch; rerun preflight with --expect-target ${target.sha} before pushing`,
  };
}

// Bounded retirement of one STALE_RECLAIMABLE attempt. Re-validates state itself, never forces.
// `revalidate` re-runs the full inspection immediately before mutation; any change from the
// earlier snapshot (state, tip, path, archive need) aborts without touching anything.
export function reclaimLocalSuccessor(local, { cwd = process.cwd(), predecessorPr, revalidate } = {}) {
  if (local?.state !== "LOCAL_SUCCESSOR_STALE_RECLAIMABLE") throw new Error("reclaim requires a STALE_RECLAIMABLE verdict");
  if (typeof revalidate !== "function") throw new Error("reclaim requires a revalidate callback");
  const fresh = revalidate();
  if (
    fresh?.state !== "LOCAL_SUCCESSOR_STALE_RECLAIMABLE" ||
    fresh.branch !== local.branch ||
    fresh.tip !== local.tip ||
    (fresh.path ?? null) !== (local.path ?? null) ||
    Boolean(fresh.archive) !== Boolean(local.archive)
  ) {
    throw new Error("successor local state changed since inspection; refusing to reclaim");
  }
  const actions = [];
  if (local.path) {
    const lock = parseWorktreePorcelain(git(["worktree", "list", "--porcelain"], { cwd })).find((w) => normalizePathForComparison(w.path) === normalizePathForComparison(local.path));
    if (lock?.locked) {
      const binding = parseBindingLockReason(lock.lockedReason ?? "");
      if (!binding || Number(binding.pr) !== predecessorPr) throw new Error("refusing to unlock a worktree that is not this predecessor's LDL binding");
      git(["worktree", "unlock", local.path], { cwd });
      actions.push("unlocked");
    }
    git(["worktree", "remove", local.path], { cwd }); // no --force: a dirty tree is refused
    actions.push("worktree-removed");
  }
  if (local.archive) {
    const ref = `refs/ldl/reclaimed/${local.branch}-${local.tip.slice(0, 8)}`;
    git(["update-ref", ref, local.tip], { cwd });
    actions.push(`archived:${ref}`);
  }
  git(["update-ref", "-d", `refs/heads/${local.branch}`, local.tip], { cwd }); // compare-and-delete: refuses if the ref advanced
  actions.push("branch-removed");
  return actions;
}
