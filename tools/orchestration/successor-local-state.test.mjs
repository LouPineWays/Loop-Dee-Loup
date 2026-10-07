// Tests for tools/orchestration/successor-local-state.mjs -- issue #968.
//
// Run with:
//   node --test tools/orchestration/successor-local-state.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectLocalSuccessor, reclaimLocalSuccessor, parseWorktreePorcelain, defaultProbeOccupancy, defaultLocalGit } from "./successor-local-state.mjs";

const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const BRANCH = "issue-868-successor-of-869-attempt-1";
const ID = { executionIssue: 868, predecessorPr: 869 };
const FREE = { probeOccupancy: () => "FREE" };

function fixture() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "ldl-968-")));
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@t");
  g(repo, "config", "user.name", "t");
  g(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "f.txt"), "base\n");
  g(repo, "add", ".");
  g(repo, "commit", "-qm", "base");
  const sha = g(repo, "rev-parse", "HEAD");
  const wtPath = join(repo, ".claude", "worktrees", "pr-869-bind-x");
  mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
  g(repo, "worktree", "add", "-q", "-b", BRANCH, wtPath, sha);
  return { repo, sha, wtPath, target: { ref: "main", sha } };
}
const defaultLocalGitFor = (f) => defaultLocalGit(f.repo);
const inspect = (f, extra = {}, deps = FREE) => inspectLocalSuccessor({ ...ID, target: f.target, cwd: f.repo, ...extra }, deps);
const lockFor = (f, pr) => g(f.repo, "worktree", "lock", "--reason", `ldl-pr-head-binding pr=${pr} sha=${f.sha} branch=x mode=created token=ab12cd34`, f.wtPath);
const commitIn = (cwd, file, text) => {
  writeFileSync(join(cwd, file), text);
  g(cwd, "add", ".");
  g(cwd, "commit", "-qm", `edit ${file}`);
};

test("no local successor branch -> null (remote-only logic decides)", () => {
  const f = fixture();
  g(f.repo, "worktree", "remove", "--force", f.wtPath);
  g(f.repo, "branch", "-D", BRANCH);
  assert.equal(inspect(f), null);
});

test("branch created but nothing done (interrupted before any work) -> STALE_RECLAIMABLE, not a create-new path", () => {
  const r = inspect(fixture());
  assert.equal(r.state, "LOCAL_SUCCESSOR_STALE_RECLAIMABLE");
  assert.equal(r.branch, BRANCH);
});

test("mid-cherry-pick conflict, path free -> RESUMABLE with the same branch and path; repeated runs converge", () => {
  const f = fixture();
  g(f.repo, "branch", "side", f.sha);
  const sideWt = join(f.repo, ".claude", "worktrees", "side");
  g(f.repo, "worktree", "add", "-q", sideWt, "side");
  commitIn(sideWt, "f.txt", "side\n");
  const side = g(sideWt, "rev-parse", "HEAD");
  commitIn(f.wtPath, "f.txt", "other\n");
  assert.throws(() => g(f.wtPath, "cherry-pick", side));
  const r = inspect(f);
  assert.equal(r.state, "LOCAL_SUCCESSOR_RESUMABLE");
  assert.equal(r.progress.operation, "cherry-pick");
  assert.equal(r.branch, BRANCH);
  assert.equal(r.path.split("\\").join("/"), f.wtPath.split("\\").join("/"));
  assert.match(r.action, /do not create a branch or binding/);
  assert.deepEqual(inspect(f), r);
});

test("local commit not pushed -> RESUMABLE and reported unpushed", () => {
  const f = fixture();
  commitIn(f.wtPath, "h.txt", "work\n");
  const r = inspect(f);
  assert.equal(r.state, "LOCAL_SUCCESSOR_RESUMABLE");
  assert.equal(r.progress.commitsAhead, 1);
  assert.equal(r.pushed, false);
});

test("dirty uncommitted tree, no operation -> RESUMABLE (never reclaimed)", () => {
  const f = fixture();
  writeFileSync(join(f.wtPath, "h.txt"), "wip\n");
  const r = inspect(f);
  assert.equal(r.state, "LOCAL_SUCCESSOR_RESUMABLE");
  assert.equal(r.progress.dirty, true);
});

test("live owner (path occupied) -> LIVE_OWNED regardless of how old the files are", () => {
  const f = fixture();
  const old = new Date(Date.now() - 30 * 86400000);
  utimesSync(f.wtPath, old, old);
  assert.equal(inspect(f, {}, { probeOccupancy: () => "OCCUPIED" }).state, "LOCAL_SUCCESSOR_LIVE_OWNED");
});

test("recent mtime alone is not liveness: free path with fresh mtimes is not LIVE_OWNED", () => {
  const f = fixture();
  const now = new Date();
  utimesSync(f.wtPath, now, now);
  assert.notEqual(inspect(f).state, "LOCAL_SUCCESSOR_LIVE_OWNED");
});

test("unprovable occupancy (probe UNKNOWN) -> fail closed, nothing touched", () => {
  const f = fixture();
  const r = inspect(f, {}, { probeOccupancy: () => "UNKNOWN" });
  assert.equal(r.state, "FAIL_CLOSED");
  assert.match(r.reason, /AMBIGUOUS_LOCAL_SUCCESSOR/);
  assert.ok(existsSync(f.wtPath));
});

test("worktree outside LDL-owned locations (user checkout) -> fail closed", () => {
  const f = fixture();
  g(f.repo, "worktree", "remove", "--force", f.wtPath);
  const other = join(realpathSync(mkdtempSync(join(tmpdir(), "ldl-968-user-"))), "mine");
  g(f.repo, "worktree", "add", "-q", other, BRANCH);
  assert.equal(inspect(f).state, "FAIL_CLOSED");
  assert.ok(existsSync(other));
});

test("binding lock for a different PR -> fail closed; matching binding lock -> attributable", () => {
  const f = fixture();
  lockFor(f, 111);
  assert.equal(inspect(f).state, "FAIL_CLOSED");
  g(f.repo, "worktree", "unlock", f.wtPath);
  lockFor(f, 869);
  assert.equal(inspect(f).state, "LOCAL_SUCCESSOR_STALE_RECLAIMABLE");
});

test("more than one local successor branch -> fail closed (exactly-one invariant)", () => {
  const f = fixture();
  g(f.repo, "branch", "issue-868-successor-of-869-attempt-2", f.sha);
  assert.equal(inspect(f).state, "FAIL_CLOSED");
});

test("the caller's own worktree is CALLER_OWNED so the pre-push re-check keeps the same branch", () => {
  const f = fixture();
  const r = inspect(f, { callerWorktree: f.wtPath, cwd: f.wtPath }, { probeOccupancy: () => "OCCUPIED" });
  assert.equal(r.state, "CALLER_OWNED");
  assert.equal(r.branch, BRANCH);
});

test("a declared --worktree that is not the process's actual checkout fails closed (no CALLER_OWNED)", () => {
  const f = fixture();
  const r = inspect(f, { callerWorktree: f.wtPath }, { probeOccupancy: () => "OCCUPIED" });
  assert.equal(r.state, "FAIL_CLOSED");
  assert.match(r.reason, /not the current checkout/);
});

test("only the expected attempt is inspected; a closed historical attempt branch is ignored", () => {
  const f = fixture();
  g(f.repo, "branch", "issue-868-successor-of-869-attempt-2", f.sha);
  assert.equal(inspect(f, { attempt: 2 }).branch, "issue-868-successor-of-869-attempt-2");
  g(f.repo, "worktree", "remove", "--force", f.wtPath);
  g(f.repo, "branch", "-D", BRANCH);
  commitIn(f.repo, "m.txt", "moved\n");
  assert.equal(inspect(f, { attempt: 3 }), null);
});

test("a pushed attempt is never reclaimable as local-only; unreadable origin fails closed", () => {
  const f = fixture();
  const real = defaultLocalGitFor(f);
  const r = inspect(f, {}, { ...FREE, localGit: { ...real, remoteBranch: () => f.sha } });
  assert.equal(r.state, "FAIL_CLOSED");
  assert.match(r.reason, /already pushed/);
  const u = inspect(f, {}, { ...FREE, localGit: { ...real, remoteBranch: () => undefined } });
  assert.equal(u.state, "FAIL_CLOSED");
});

test("reclaim aborts, touching nothing, if the successor advanced after inspection", () => {
  const f = fixture();
  const r = inspect(f);
  commitIn(f.wtPath, "late.txt", "late\n");
  assert.throws(() => reclaimLocalSuccessor(r, { cwd: f.repo, predecessorPr: 869, revalidate: () => inspect(f) }), /changed since inspection/);
  assert.ok(existsSync(f.wtPath));
  assert.equal(g(f.repo, "rev-parse", BRANCH), g(f.wtPath, "rev-parse", "HEAD"));
});

test("stale reclaim: clean bound worktree is unlocked+removed and branch deleted; a fresh run sees no local state", () => {
  const f = fixture();
  lockFor(f, 869);
  const actions = reclaimLocalSuccessor(inspect(f), { cwd: f.repo, predecessorPr: 869, revalidate: () => inspect(f) });
  assert.ok(actions.includes("branch-removed"));
  assert.equal(existsSync(f.wtPath), false);
  assert.equal(inspect(f), null);
});

test("reclaim refuses to unlock a binding for another PR", () => {
  const f = fixture();
  lockFor(f, 869);
  const r = inspect(f);
  g(f.repo, "worktree", "unlock", f.wtPath);
  lockFor(f, 111);
  assert.throws(() => reclaimLocalSuccessor(r, { cwd: f.repo, predecessorPr: 869, revalidate: () => inspect(f) }));
  assert.ok(existsSync(f.wtPath));
});

test("moved target with committed work archives the commits under refs/ldl/reclaimed before retiring", () => {
  const f = fixture();
  commitIn(f.wtPath, "h.txt", "work\n");
  const tip = g(f.wtPath, "rev-parse", "HEAD");
  commitIn(f.repo, "m.txt", "moved\n");
  const moved = { target: { ref: "main", sha: g(f.repo, "rev-parse", "main") } };
  const r = inspect(f, moved);
  assert.equal(r.state, "LOCAL_SUCCESSOR_STALE_RECLAIMABLE");
  assert.equal(r.archive, true);
  reclaimLocalSuccessor(r, { cwd: f.repo, predecessorPr: 869, revalidate: () => inspect(f, moved) });
  assert.equal(g(f.repo, "rev-parse", `refs/ldl/reclaimed/${BRANCH}-${tip.slice(0, 8)}`), tip);
});

test("target moved while dirty work exists -> fail closed, work preserved", () => {
  const f = fixture();
  writeFileSync(join(f.wtPath, "h.txt"), "wip\n");
  commitIn(f.repo, "m.txt", "moved\n");
  const r = inspect(f, { target: { ref: "main", sha: g(f.repo, "rev-parse", "main") } });
  assert.equal(r.state, "FAIL_CLOSED");
  assert.ok(existsSync(join(f.wtPath, "h.txt")));
});

test("branch without worktree: no work -> STALE_RECLAIMABLE; committed work -> RESUMABLE", () => {
  const f = fixture();
  g(f.repo, "worktree", "remove", "--force", f.wtPath);
  assert.equal(inspect(f).state, "LOCAL_SUCCESSOR_STALE_RECLAIMABLE");
  g(f.repo, "checkout", "-q", BRANCH);
  commitIn(f.repo, "h.txt", "w\n");
  g(f.repo, "checkout", "-q", "main");
  assert.equal(inspect(f).state, "LOCAL_SUCCESSOR_RESUMABLE");
});

test("parseWorktreePorcelain reads branch and lock reason", () => {
  const w = parseWorktreePorcelain("worktree /a\nHEAD x\nbranch refs/heads/b\nlocked why now\n\nworktree /c\nlocked\n");
  assert.deepEqual(w.map((x) => [x.path, x.branch, x.locked, x.lockedReason]), [["/a", "b", true, "why now"], ["/c", null, true, null]]);
});

test("real occupancy probe: a missing path is FREE", () => {
  assert.equal(defaultProbeOccupancy(join(tmpdir(), "ldl-968-definitely-missing")), "FREE");
});
