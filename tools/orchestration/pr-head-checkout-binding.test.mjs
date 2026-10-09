// Issue #703 (control #691): pre-spawn PR-head checkout binding for Stage 1 correction workers.
//
// Exercises `pr-head-checkout-preflight.mjs`'s reserve / verify-binding / release-binding /
// reserveFromGate operations against REAL git repositories and worktrees (only `gh pr view` is
// stubbed), because the properties under test -- exclusive `git worktree lock` claims, the exact
// path a command actually ran in, and non-forced pushes against an advancing remote -- are git's
// own behavior, not something a stub can prove.
//
// The #514 / #689 / PR #700 recurrence shapes covered here:
//   - spawn-time fixed sandbox: the worker starts in some other worktree (agent-tool isolation)
//     or in the controller's primary checkout (no isolation) -- verification from there is
//     WRONG_CHECKOUT, never silently accepted; from the pre-bound path it is BINDING_VERIFIED
//     with no EnterWorktree/rebind step anywhere in the flow.
//   - occupied target, dirty target, stale head, already-at-head checkout, primary checkout.
//
// Also covers this same PR's own Stage 1 correction (issue #703's own correction pass, findings
// on PR #710): reservation always creates a fresh, construction-proven-exclusive worktree, never
// trusting an already-at-head checkout in place (P1); `scriptPath` names the controller's own
// authoritative copy of this script, distinct from the reserved checkout's own (P1); release run
// from inside the reserved checkout it is releasing still removes it once clean and pushed,
// exercised via the actual generated dispatch-prompt flow (P2); a failed reservation's
// CHECKOUT_BINDING_UNVERIFIED output carries its own terminal actionEnvelope (P2).
//
// Run with: node --test tools/orchestration/pr-head-checkout-binding.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  reserve,
  verifyBinding,
  releaseBinding,
  reserveFromGate,
  findDuplicateJsonKey,
  reserveAndPersistHandoff,
  parseBindingLockReason,
  formatBindingLockReason,
  SELF_SCRIPT_PATH,
} from "./pr-head-checkout-preflight.mjs";
import { getActionEnvelope } from "./action-envelope.mjs";

const PR = 700;
const BRANCH = "worktree-agent-pr700";

// Issue #1031: the execution-Issue reader is injected; legacy tests see an Issue with no intent.
const noIntent = async () => ({ body: "ordinary issue body", state: "OPEN" });

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(cwd, name, content) {
  writeFileSync(join(cwd, name), content);
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", `edit ${name}`);
  return git(cwd, "rev-parse", "HEAD");
}

// A bare "origin", a primary clone on `main`, and the PR head branch pushed to origin from a
// separate "implementation worker" clone (so the primary never has the PR branch checked out).
function makeFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ldl-703-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const primary = join(root, "primary");
  git(root, "clone", "-q", origin, primary);
  for (const repo of [primary]) {
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "commit.gpgsign", "false");
  }
  git(primary, "checkout", "-q", "-b", "main");
  commitFile(primary, "README.md", "base\n");
  git(primary, "push", "-q", "origin", "main");

  const implementer = join(root, "implementer");
  git(root, "clone", "-q", origin, implementer);
  git(implementer, "config", "user.email", "test@example.com");
  git(implementer, "config", "user.name", "test");
  git(implementer, "config", "commit.gpgsign", "false");
  git(implementer, "checkout", "-q", "-b", BRANCH);
  const headSha = commitFile(implementer, "feature.txt", "v1\n");
  git(implementer, "push", "-q", "origin", BRANCH);
  // Make the head commit object available locally (fixtures below build worktrees at it); the
  // primary still never checks the PR branch out.
  git(primary, "fetch", "-q", "origin");

  const prHead = { branch: BRANCH, sha: headSha };
  const ghPrViewImpl = async () => ({ headRefName: prHead.branch, headRefOid: prHead.sha });
  return { root, origin, primary, implementer, prHead, ghPrViewImpl };
}

function lockReasonOf(primary, path) {
  const porcelain = git(primary, "worktree", "list", "--porcelain");
  const block = porcelain.split(/\n\n+/).find((b) => b.split("\n")[0] === `worktree ${path.replace(/\\/g, "/")}` || b.split("\n")[0] === `worktree ${path}`);
  const line = block?.split("\n").find((l) => l.startsWith("locked"));
  return line ? line.replace(/^locked ?/, "") : null;
}

function worktreeCount(primary) {
  return git(primary, "worktree", "list", "--porcelain").split(/\n\n+/).filter(Boolean).length;
}

// -------------------------------------------------------------------------------------------
// Pure lock-reason helpers
// -------------------------------------------------------------------------------------------

test("formatBindingLockReason / parseBindingLockReason round-trip, and foreign lock reasons are never read as a binding", () => {
  const fields = { pr: 700, sha: "a".repeat(40), branch: "b", mode: "created", token: "1a2b3c4d" };
  assert.deepEqual(parseBindingLockReason(formatBindingLockReason(fields)), fields);
  for (const foreign of [null, "", "locked by founder", "ldl-pr-head-binding pr=abc sha=x branch=b mode=created token=t", "ldl-pr-head-binding pr=1 sha=x branch=b mode=weird token=t"]) {
    assert.equal(parseBindingLockReason(foreign), null);
  }
});

// -------------------------------------------------------------------------------------------
// Required check 1 + 2 + 3: exact live recurrence shape, fixed spawn-time sandbox, no-isolation
// -------------------------------------------------------------------------------------------

test("#514/#689/PR #700 shape: controller on primary main reserves a fresh locked PR-head worktree before spawn; the worker verifies it from that path with no rebind", async (t) => {
  const fx = makeFixture(t);
  const reserved = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tok00001" });
  assert.equal(reserved.exitCode, 0, JSON.stringify(reserved));
  assert.equal(reserved.verdict, "RESERVED_CREATED");
  assert.equal(reserved.sha, fx.prHead.sha);
  assert.equal(reserved.pushRefspec, `HEAD:${BRANCH}`);
  // Stage 1 finding P1 on PR #710: `scriptPath` is THIS process's own copy of the script, never
  // a path inside the reserved checkout it just created.
  assert.equal(reserved.scriptPath, SELF_SCRIPT_PATH);
  assert.ok(existsSync(reserved.path));
  assert.equal(git(reserved.path, "rev-parse", "HEAD"), fx.prHead.sha);
  // The primary checkout is untouched: still on main, never the correction target.
  assert.equal(git(fx.primary, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  const lock = parseBindingLockReason(lockReasonOf(fx.primary, reserved.path));
  assert.deepEqual({ pr: lock.pr, token: lock.token, mode: lock.mode, sha: lock.sha }, { pr: PR, token: "tok00001", mode: "created", sha: fx.prHead.sha });

  const verified = await verifyBinding({ repo: "o/r", pr: PR, token: "tok00001", cwd: reserved.path }, { ghPrViewImpl: fx.ghPrViewImpl });
  assert.equal(verified.exitCode, 0, JSON.stringify(verified));
  assert.equal(verified.verdict, "BINDING_VERIFIED");
  assert.equal(verified.pushRefspec, `HEAD:${BRANCH}`);

  // The worker reaches source work on the exact head, commits, and pushes via pushRefspec.
  const corrected = commitFile(reserved.path, "feature.txt", "v2\n");
  git(reserved.path, "push", "-q", "origin", verified.pushRefspec);
  assert.equal(git(fx.origin, "rev-parse", `refs/heads/${BRANCH}`), corrected);
});

test("spawn-time fixed sandbox: a worker still pinned to an unrelated isolation worktree gets WRONG_CHECKOUT, never a silent pass", async (t) => {
  const fx = makeFixture(t);
  const sandbox = join(fx.root, "primary", ".claude", "worktrees", "agent-sandbox");
  git(fx.primary, "worktree", "add", "-q", "-b", "worktree-agent-sandbox", sandbox, "main");
  const reserved = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tok00002" });
  assert.equal(reserved.verdict, "RESERVED_CREATED");
  const fromSandbox = await verifyBinding({ repo: "o/r", pr: PR, token: "tok00002", cwd: sandbox }, { ghPrViewImpl: fx.ghPrViewImpl });
  assert.equal(fromSandbox.exitCode, 2);
  assert.equal(fromSandbox.verdict, "WRONG_CHECKOUT");
  // The same worker, running the verification from the pre-bound path instead, succeeds.
  const fromBound = await verifyBinding({ repo: "o/r", pr: PR, token: "tok00002", cwd: reserved.path }, { ghPrViewImpl: fx.ghPrViewImpl });
  assert.equal(fromBound.verdict, "BINDING_VERIFIED");
});

test("no-isolation retry shape: a worker that inherited the controller's primary checkout gets WRONG_CHECKOUT from there and BINDING_VERIFIED from the bound path", async (t) => {
  const fx = makeFixture(t);
  const reserved = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tok00003" });
  const fromPrimary = await verifyBinding({ repo: "o/r", pr: PR, token: "tok00003", cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl });
  assert.equal(fromPrimary.verdict, "WRONG_CHECKOUT");
  const fromBound = await verifyBinding({ repo: "o/r", pr: PR, token: "tok00003", cwd: reserved.path }, { ghPrViewImpl: fx.ghPrViewImpl });
  assert.equal(fromBound.verdict, "BINDING_VERIFIED");
});

// -------------------------------------------------------------------------------------------
// Required check 4: occupied target
// -------------------------------------------------------------------------------------------

// Stage 1 finding P1 on PR #710: `git worktree lock` is an administrative/pruning-exclusion
// primitive, not proof no other live process or session is using the path -- so a live worktree
// another session already holds, but has never locked, must never be silently accepted as an
// exclusive in-place reservation either. This repository has no primitive to prove such a path
// is genuinely free, so `reserve` no longer trusts placement in an existing checkout at all --
// see "occupancy negative" below.
test("occupied target: a worktree another session already holds via a genuine administrative lock is left untouched; reservation still creates its own fresh worktree", async (t) => {
  const fx = makeFixture(t);
  const other = join(fx.primary, ".claude", "worktrees", "other-session");
  git(fx.primary, "worktree", "add", "-q", "-b", "other-local", other, fx.prHead.sha);
  git(fx.primary, "worktree", "lock", "--reason", "held by another live session", other);
  const result = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tok00004" });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.verdict, "RESERVED_CREATED");
  assert.notEqual(result.path, other);
  // The foreign, already-locked worktree is never touched by an unrelated reservation.
  assert.equal(lockReasonOf(fx.primary, other), "held by another live session");
});

// Issue #703 Stage 1 correction, required check "Occupancy negative" (Stage 1 finding P1 on PR
// #710): a checkout already at the exact target head, live and clean, but carrying no git
// administrative lock at all -- exactly the shape a genuine concurrent session could still be
// actively using despite the absence of a lock, since git's own lock is a pruning-exclusion
// primitive, never an occupancy claim. No occupancy primitive can prove this path is free, so
// `reserve` must never trust it in place; it must always fall back to a fresh, token-unique
// checkout whose occupancy is proven by construction instead (a path that did not exist before
// `worktree add --lock` created it).
test("occupancy negative: a live, unlocked checkout already at the exact head is never reserved in place -- reserve always creates a fresh token-unique checkout", async (t) => {
  const fx = makeFixture(t);
  const wt = join(fx.primary, ".claude", "worktrees", "already-at-head");
  git(fx.primary, "worktree", "add", "-q", "-b", "already-local", wt, fx.prHead.sha);
  const before = worktreeCount(fx.primary);
  const result = await reserve({ repo: "o/r", pr: PR, cwd: wt }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokocc01" });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.verdict, "RESERVED_CREATED");
  assert.notEqual(result.path, wt);
  assert.equal(worktreeCount(fx.primary), before + 1);
  // The pre-existing, still-unlocked worktree is left completely untouched -- never reserved,
  // never removed, never locked out from under whatever might still be using it.
  assert.equal(lockReasonOf(fx.primary, wt), null);
  const verified = await verifyBinding({ repo: "o/r", pr: PR, token: "tokocc01", cwd: result.path }, { ghPrViewImpl: fx.ghPrViewImpl });
  assert.equal(verified.verdict, "BINDING_VERIFIED");
});

// Defense in depth (see `releaseBinding`'s own comment): `reserve` can no longer produce an
// "in-place" mode binding, but a legacy lock reason in that shape -- e.g. written by a
// pre-#710 controller before this fix deployed -- must still never be removed by
// `releaseBinding`; only a "created" reservation's own worktree is ever eligible for removal.
test("release: a legacy in-place-mode lock reason (pre-#710 shape) is never removed, only unlocked", async (t) => {
  const fx = makeFixture(t);
  const wt = join(fx.primary, ".claude", "worktrees", "legacy-in-place");
  git(fx.primary, "worktree", "add", "-q", "-b", "legacy-local", wt, fx.prHead.sha);
  git(
    fx.primary,
    "worktree",
    "lock",
    "--reason",
    formatBindingLockReason({ pr: PR, sha: fx.prHead.sha, branch: BRANCH, mode: "in-place", token: "toklegcy" }),
    wt,
  );
  const released = await releaseBinding({ token: "toklegcy", cwd: fx.primary });
  assert.equal(released.verdict, "RELEASED");
  assert.equal(released.removed, false);
  assert.ok(existsSync(wt));
  assert.equal(lockReasonOf(fx.primary, wt), null);
});

test("occupied target: a fresh reservation never lands on a path that already exists", async (t) => {
  const fx = makeFixture(t);
  const collide = join(fx.primary, ".claude", "worktrees", "pr-700-bind-tokclash");
  execFileSync("git", ["worktree", "add", "-q", "-b", "someone-else", collide, "main"], { cwd: fx.primary });
  writeFileSync(join(collide, "in-use.txt"), "live\n");
  const result = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokclash" });
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "NO_SAFE_BINDING");
  assert.ok(existsSync(join(collide, "in-use.txt")));
});

// -------------------------------------------------------------------------------------------
// Required check 5: dirty / ambiguous
// -------------------------------------------------------------------------------------------

// Stage 1 finding P1 on PR #710: `reserve` no longer inspects the invoking checkout at all (it
// always creates a fresh worktree elsewhere), so a dirty invoking checkout is simply irrelevant
// to reservation now -- it is never touched, never read, never a DIRTY_CANDIDATE source. Dirty
// evidence still matters at `verifyBinding` time, for the RESERVED checkout itself (see "dirty
// target: a reserved checkout that became dirty before verification fails closed" below).
test("dirty target: a dirty invoking checkout does not block reservation -- reserve creates a fresh worktree elsewhere and never touches it", async (t) => {
  const fx = makeFixture(t);
  const wt = join(fx.primary, ".claude", "worktrees", "dirty-at-head");
  git(fx.primary, "worktree", "add", "-q", "-b", "dirty-local", wt, fx.prHead.sha);
  writeFileSync(join(wt, "feature.txt"), "uncommitted\n");
  const result = await reserve({ repo: "o/r", pr: PR, cwd: wt }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokdirty" });
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.verdict, "RESERVED_CREATED");
  assert.notEqual(result.path, wt);
  assert.equal(lockReasonOf(fx.primary, wt), null);
  // The dirty invoking checkout is left exactly as it was.
  assert.equal(git(wt, "status", "--porcelain").length > 0, true);
});

test("dirty target: a reserved checkout that became dirty before verification fails closed", async (t) => {
  const fx = makeFixture(t);
  const reserved = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokdirt2" });
  writeFileSync(join(reserved.path, "stray.txt"), "x\n");
  const result = await verifyBinding({ repo: "o/r", pr: PR, token: "tokdirt2", cwd: reserved.path }, { ghPrViewImpl: fx.ghPrViewImpl });
  assert.equal(result.verdict, "DIRTY_CANDIDATE");
});

test("ambiguous/mismatched reservations fail closed: wrong token and wrong PR", async (t) => {
  const fx = makeFixture(t);
  const reserved = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokamb01" });
  const wrongToken = await verifyBinding({ repo: "o/r", pr: PR, token: "nottoken", cwd: reserved.path }, { ghPrViewImpl: fx.ghPrViewImpl });
  assert.equal(wrongToken.verdict, "BINDING_NOT_FOUND");
  const wrongPr = await verifyBinding({ repo: "o/r", pr: 701, token: "tokamb01", cwd: reserved.path }, { ghPrViewImpl: fx.ghPrViewImpl });
  assert.equal(wrongPr.verdict, "BINDING_MISMATCH");
});

// -------------------------------------------------------------------------------------------
// Required check 6: stale-head race
// -------------------------------------------------------------------------------------------

test("stale-head race: the PR head advances after reservation -- verification fails closed and the stale checkout is never authorized", async (t) => {
  const fx = makeFixture(t);
  const reserved = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokstale" });
  assert.equal(reserved.verdict, "RESERVED_CREATED");
  fx.prHead.sha = commitFile(fx.implementer, "feature.txt", "v1.1 pushed by someone else\n");
  git(fx.implementer, "push", "-q", "origin", BRANCH);
  const result = await verifyBinding({ repo: "o/r", pr: PR, token: "tokstale", cwd: reserved.path }, { ghPrViewImpl: fx.ghPrViewImpl });
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "STALE_HEAD_MISMATCH");
});

test("stale-head race: a head that advances AFTER verification still cannot be overwritten -- the pushRefspec push is non-forced", async (t) => {
  const fx = makeFixture(t);
  const reserved = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokrace2" });
  const verified = await verifyBinding({ repo: "o/r", pr: PR, token: "tokrace2", cwd: reserved.path }, { ghPrViewImpl: fx.ghPrViewImpl });
  assert.equal(verified.verdict, "BINDING_VERIFIED");
  const concurrent = commitFile(fx.implementer, "feature.txt", "concurrent\n");
  git(fx.implementer, "push", "-q", "origin", BRANCH);
  commitFile(reserved.path, "feature.txt", "correction on stale head\n");
  assert.throws(() => git(reserved.path, "push", "-q", "origin", verified.pushRefspec));
  assert.equal(git(fx.origin, "rev-parse", `refs/heads/${BRANCH}`), concurrent);
});

test("stale-head race: origin disagrees with the PR head at reservation time -- fails closed before any worktree is created", async (t) => {
  const fx = makeFixture(t);
  const before = worktreeCount(fx.primary);
  const result = await reserve(
    { repo: "o/r", pr: PR, cwd: fx.primary },
    { ghPrViewImpl: async () => ({ headRefName: BRANCH, headRefOid: "f".repeat(40) }), tokenImpl: () => "tokstal3" },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "STALE_HEAD_MISMATCH");
  assert.equal(worktreeCount(fx.primary), before);
});

// Stage 1 review finding on PR #719 (issue #665's own correction, P2): `expectedHead` pins a
// reservation to the exact head a caller already gated its own verdict against -- closing the
// conflict-recovery TOCTOU gap where a commit landing on the PR between the gate running and
// reservation happening could otherwise silently become the worker's starting point.
test("reserve: expectedHead matching the live PR head reserves normally", async (t) => {
  const fx = makeFixture(t);
  const result = await reserve(
    { repo: "o/r", pr: PR, cwd: fx.primary, expectedHead: fx.prHead.sha },
    { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokpin1" },
  );
  assert.equal(result.verdict, "RESERVED_CREATED");
  assert.equal(result.sha, fx.prHead.sha);
});

test("reserve: expectedHead pins the reservation to the gated head -- a live head that already advanced past it fails closed before any worktree is created", async (t) => {
  const fx = makeFixture(t);
  const before = worktreeCount(fx.primary);
  const gatedHead = fx.prHead.sha;
  fx.prHead.sha = commitFile(fx.implementer, "feature.txt", "v2 landed after the gate ran\n");
  git(fx.implementer, "push", "-q", "origin", BRANCH);
  const result = await reserve(
    { repo: "o/r", pr: PR, cwd: fx.primary, expectedHead: gatedHead },
    { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokpin2" },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "STALE_HEAD_MISMATCH");
  assert.equal(worktreeCount(fx.primary), before);
});

// -------------------------------------------------------------------------------------------
// Required check 7: already-correct checkout -- no longer trusted in place (superseded by Stage
// 1 finding P1 on PR #710; see "occupancy negative" above, which covers this exact shape and
// additionally proves the pre-existing worktree is left untouched).
// -------------------------------------------------------------------------------------------

// -------------------------------------------------------------------------------------------
// Required check 8: primary checkout negative
// -------------------------------------------------------------------------------------------

test("primary-checkout negative: a primary checkout already sitting at the PR head is never reserved -- a fresh worktree is created instead", async (t) => {
  const fx = makeFixture(t);
  git(fx.primary, "fetch", "-q", "origin", BRANCH);
  git(fx.primary, "checkout", "-q", "--detach", fx.prHead.sha);
  const result = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokprim1" });
  assert.equal(result.verdict, "RESERVED_CREATED");
  assert.notEqual(result.path, fx.primary);
  assert.equal(lockReasonOf(fx.primary, fx.primary), null);
  const fromPrimary = await verifyBinding({ repo: "o/r", pr: PR, token: "tokprim1", cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl });
  assert.equal(fromPrimary.verdict, "WRONG_CHECKOUT");
});

// -------------------------------------------------------------------------------------------
// Release
// -------------------------------------------------------------------------------------------

test("release: a created reservation whose commit is pushed is unlocked and removed; its local binding branch is deleted", async (t) => {
  const fx = makeFixture(t);
  const reserved = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokrel01" });
  commitFile(reserved.path, "feature.txt", "v2\n");
  git(reserved.path, "push", "-q", "origin", `HEAD:${BRANCH}`);
  const released = await releaseBinding({ token: "tokrel01", cwd: fx.primary });
  assert.equal(released.verdict, "RELEASED");
  assert.equal(released.removed, true);
  assert.ok(!existsSync(reserved.path));
  assert.equal(git(fx.primary, "branch", "--list", reserved.localBranch), "");
});

test("release: a created reservation with an unpushed commit is unlocked but kept -- nothing is discarded", async (t) => {
  const fx = makeFixture(t);
  const reserved = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokrel02" });
  const unpushed = commitFile(reserved.path, "feature.txt", "local only\n");
  const released = await releaseBinding({ token: "tokrel02", cwd: fx.primary });
  assert.equal(released.verdict, "RELEASED");
  assert.equal(released.removed, false);
  assert.equal(git(reserved.path, "rev-parse", "HEAD"), unpushed);
  assert.equal(lockReasonOf(fx.primary, reserved.path), null);
});

test("release: an unknown token is BINDING_NOT_FOUND and touches nothing", async (t) => {
  const fx = makeFixture(t);
  const result = await releaseBinding({ token: "nosuchtk", cwd: fx.primary });
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "BINDING_NOT_FOUND");
});

// Stage 1 finding P2 on PR #710, required check "Cleanup regression using the actual generated
// prompt flow": `format-dispatch-prompt.mjs`'s findings template has the worker run
// --release-binding from inside the reserved checkout itself (there is no other checkout for it
// to run this from) -- mirrored here by actually moving this test process's own OS-level working
// directory into the reserved path before calling releaseBinding, exactly as a real dispatched
// worker's own terminal session would be positioned. Deleting a directory that is a running
// process's own current directory fails on this repository's Windows hosts even when a different
// subprocess performs the deletion, which is why this regression needs a REAL `process.chdir`
// (not merely passing `cwd: reserved.path` as a logical parameter) to actually exercise the
// failure mode the fix closes.
test("release (actual generated prompt flow): running --release-binding from inside the reserved checkout still removes it once clean and pushed", async (t) => {
  const fx = makeFixture(t);
  const reserved = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokcln01" });
  commitFile(reserved.path, "feature.txt", "v2 from the reserved checkout\n");
  git(reserved.path, "push", "-q", "origin", `HEAD:${BRANCH}`);
  const originalCwd = process.cwd();
  process.chdir(reserved.path);
  try {
    const released = await releaseBinding({ token: "tokcln01", cwd: reserved.path });
    assert.equal(released.verdict, "RELEASED");
    assert.equal(released.removed, true, JSON.stringify(released));
    assert.ok(!existsSync(reserved.path));
  } finally {
    // The reserved path no longer exists -- restore to a directory that still does before any
    // later test (or this file's own fixture cleanup) touches process.cwd() again.
    process.chdir(originalCwd);
  }
});

// Same shape, but with local modifications still present: proves the chdir-away fix does not
// weaken the existing "never remove an unproven-clean checkout" guard -- it is only ever removed
// once clean and pushed, from inside the checkout exactly like from anywhere else.
test("release (actual generated prompt flow): running --release-binding from inside a still-dirty reserved checkout keeps it, never removes", async (t) => {
  const fx = makeFixture(t);
  const reserved = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokcln02" });
  writeFileSync(join(reserved.path, "stray.txt"), "uncommitted\n");
  const originalCwd = process.cwd();
  process.chdir(reserved.path);
  try {
    const released = await releaseBinding({ token: "tokcln02", cwd: reserved.path });
    assert.equal(released.verdict, "RELEASED");
    assert.equal(released.removed, false);
    assert.ok(existsSync(reserved.path));
  } finally {
    process.chdir(originalCwd);
  }
});

// Unit-level proof (injected `chdir`) that the relocation happens exactly when release runs from
// inside the reserved checkout, to `state.primaryPath`, and not at all when release already runs
// from elsewhere -- isolates the exact behavior from the real-OS regressions above.
test("release: chdir is invoked (to the primary checkout) only when release runs from inside the reserved checkout", async (t) => {
  const fx = makeFixture(t);
  const reserved = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokchd01" });
  commitFile(reserved.path, "feature.txt", "v2\n");
  git(reserved.path, "push", "-q", "origin", `HEAD:${BRANCH}`);
  const calls = [];
  const released = await releaseBinding({ token: "tokchd01", cwd: reserved.path }, { chdir: (dir) => calls.push(dir) });
  assert.equal(released.verdict, "RELEASED");
  assert.equal(released.removed, true, JSON.stringify(released));
  // Compare against git's own idea of the primary checkout's path (`rev-parse --show-toplevel`
  // always normalizes to forward slashes) rather than `fx.primary`'s own OS-native JS string --
  // `state.primaryPath` inside releaseBinding is itself git-derived, so this is the correct
  // like-for-like comparison, not a path-separator false negative.
  const primaryToplevel = git(fx.primary, "rev-parse", "--show-toplevel");
  assert.deepEqual(calls, [primaryToplevel]);
});

test("release: chdir is never invoked when release already runs from outside the reserved checkout", async (t) => {
  const fx = makeFixture(t);
  const reserved = await reserve({ repo: "o/r", pr: PR, cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokchd02" });
  commitFile(reserved.path, "feature.txt", "v2\n");
  git(reserved.path, "push", "-q", "origin", `HEAD:${BRANCH}`);
  const calls = [];
  const released = await releaseBinding({ token: "tokchd02", cwd: fx.primary }, { chdir: (dir) => calls.push(dir) });
  assert.equal(released.verdict, "RELEASED");
  assert.equal(released.removed, true, JSON.stringify(released));
  assert.deepEqual(calls, []);
});

// -------------------------------------------------------------------------------------------
// reserveFromGate: the controller's pipeline stage
// -------------------------------------------------------------------------------------------

test("reserveFromGate: a findings STAGE1_CORRECTION_REQUIRED verdict gains checkoutBinding; other verdicts pass through untouched", async (t) => {
  const fx = makeFixture(t);
  const gate = { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, pr: PR, issue: 689, controlIssue: 514, correctionReason: "findings" };
  const out = await reserveFromGate(gate, { repo: "o/r", cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, readIssueImpl: noIntent, tokenImpl: () => "tokgate1" });
  assert.equal(out.exitCode, 0);
  assert.equal(out.output.state, "STAGE1_CORRECTION_REQUIRED");
  assert.equal(out.output.checkoutBinding.token, "tokgate1");
  assert.equal(out.output.checkoutBinding.verdict, "RESERVED_CREATED");
  assert.ok(existsSync(out.output.checkoutBinding.path));
  // Stage 1 finding P1 on PR #710: threaded through into checkoutBinding for
  // format-dispatch-prompt.mjs to use verbatim.
  assert.equal(out.output.checkoutBinding.scriptPath, SELF_SCRIPT_PATH);

  for (const passthrough of [
    { ...gate, correctionReason: "closing-reference" },
    { state: "STAGE2_CORRECTION_REQUIRED", auditIssue: 559 },
    { state: "READY_TO_DISPATCH", controlIssue: 1, executionIssue: 2, route: "r" },
  ]) {
    const result = await reserveFromGate(passthrough, { repo: "o/r", cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.output, passthrough);
  }
});

test("reserveFromGate: a failed reservation becomes CHECKOUT_BINDING_UNVERIFIED (never dispatchable)", async (t) => {
  const fx = makeFixture(t);
  const gate = { state: "STAGE1_CORRECTION_REQUIRED", pr: PR, issue: 689, controlIssue: 514 };
  const out = await reserveFromGate(
    gate,
    { repo: "o/r", cwd: fx.primary },
    { ghPrViewImpl: async () => ({ headRefName: BRANCH, headRefOid: "e".repeat(40) }), readIssueImpl: noIntent, tokenImpl: () => "tokgate2" },
  );
  assert.equal(out.exitCode, 2);
  assert.equal(out.output.state, "CHECKOUT_BINDING_UNVERIFIED");
  assert.equal(out.output.verdict, "STALE_HEAD_MISMATCH");
  assert.equal(out.output.stopAfter, true);
  // Stage 1 finding P2 on PR #710: the failure output carries its own terminal actionEnvelope
  // (mode "none", zero further authorized actions) rather than leaving the original
  // STAGE1_CORRECTION_REQUIRED bounded envelope in force -- a controller that correctly stops
  // here, never dispatching, is then checked for compliance against THIS state.
  assert.deepEqual(out.output.actionEnvelope, getActionEnvelope("CHECKOUT_BINDING_UNVERIFIED"));
  assert.equal(out.output.actionEnvelope.mode, "none");
  assert.deepEqual(out.output.actionEnvelope.authorizedActions, []);
});

// Stage 1 review finding on PR #719 (issue #665's own correction): both accepted findings as one
// dispatch-boundary invariant. P1 -- the conflict-recovery worker mutates source exactly like a
// findings correction worker, so it needs the same pre-spawn exclusive reservation. P2 -- that
// reservation must be pinned to the gate's own `correctedHead`, never "whatever is live now".
test("reserveFromGate: a STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT verdict gains checkoutBinding too, pinned to the gated correctedHead", async (t) => {
  const fx = makeFixture(t);
  const gate = {
    state: "STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT",
    stopAfter: true,
    pr: PR,
    issue: 638,
    controlIssue: 666,
    reviewedHead: "3".repeat(40),
    correctedHead: fx.prHead.sha,
  };
  const out = await reserveFromGate(gate, { repo: "o/r", cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokconf1" });
  assert.equal(out.exitCode, 0);
  assert.equal(out.output.state, "STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT");
  assert.equal(out.output.checkoutBinding.token, "tokconf1");
  assert.equal(out.output.checkoutBinding.verdict, "RESERVED_CREATED");
  assert.equal(out.output.checkoutBinding.sha, fx.prHead.sha);
  assert.equal(out.output.checkoutBinding.scriptPath, SELF_SCRIPT_PATH);
  assert.ok(existsSync(out.output.checkoutBinding.path));
  // reviewedHead/correctedHead/every other verdict field survive the pass-through unchanged.
  assert.equal(out.output.reviewedHead, gate.reviewedHead);
  assert.equal(out.output.correctedHead, gate.correctedHead);
});

// The exact TOCTOU gap this closes: a commit that lands on the PR after
// next-review-transition-gate.mjs produced its verdict, but before reservation runs, must never
// silently become the worker's starting point -- it never passed the transition that authorized
// recovery.
test("reserveFromGate: STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT fails closed to CHECKOUT_BINDING_UNVERIFIED when the PR head already advanced past the gated correctedHead", async (t) => {
  const fx = makeFixture(t);
  const gatedCorrectedHead = fx.prHead.sha;
  fx.prHead.sha = commitFile(fx.implementer, "feature.txt", "v2 landed after the conflict verdict\n");
  git(fx.implementer, "push", "-q", "origin", BRANCH);
  const gate = {
    state: "STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT",
    stopAfter: true,
    pr: PR,
    issue: 638,
    controlIssue: 666,
    reviewedHead: "3".repeat(40),
    correctedHead: gatedCorrectedHead,
  };
  const out = await reserveFromGate(gate, { repo: "o/r", cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokconf2" });
  assert.equal(out.exitCode, 2);
  assert.equal(out.output.state, "CHECKOUT_BINDING_UNVERIFIED");
  assert.equal(out.output.verdict, "STALE_HEAD_MISMATCH");
  assert.equal(out.output.stopAfter, true);
  assert.deepEqual(out.output.actionEnvelope, getActionEnvelope("CHECKOUT_BINDING_UNVERIFIED"));
  assert.equal(out.output.actionEnvelope.mode, "none");
});

// Issue #761 (Stage 2 audit #785 finding): a fresh reservation whose enriched handoff cannot be
// persisted must be released completely, never left as a locked worktree no formatter can consume.
test("reserveAndPersistHandoff: persistence failure after a fresh reservation releases it (nonzero, no handoff, no worktree, no lock)", async (t) => {
  const fx = makeFixture(t);
  const gate = { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, pr: PR, issue: 689, controlIssue: 514, correctionReason: "findings" };
  const before = worktreeCount(fx.primary);
  let reservedPath = null;
  let persisted = null;
  const out = await reserveAndPersistHandoff(
    gate,
    { repo: "o/r", cwd: fx.primary, fromHandoff: true },
    {
      ghPrViewImpl: fx.ghPrViewImpl,
      readIssueImpl: noIntent,
      tokenImpl: () => "tokfail1",
      persist: (o) => {
        // The reservation genuinely exists (locked worktree on disk) when persistence is attempted.
        reservedPath = o.checkoutBinding.path;
        assert.ok(existsSync(reservedPath));
        assert.ok(lockReasonOf(fx.primary, reservedPath));
        persisted = o;
        return false;
      },
    },
  );
  assert.equal(out.persistFailed, true);
  assert.notEqual(out.exitCode, 0);
  assert.ok(persisted, "persist was attempted after the fresh reservation");
  // Cleanup observed, not just an error message: worktree removed, lock gone, count restored.
  assert.equal(existsSync(reservedPath), false);
  assert.equal(worktreeCount(fx.primary), before);
  assert.equal(git(fx.primary, "worktree", "list", "--porcelain").includes("tokfail1"), false);
});

test("reserveAndPersistHandoff: successful persistence keeps the reservation; non-handoff mode never persists", async (t) => {
  const fx = makeFixture(t);
  const gate = { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, pr: PR, issue: 689, controlIssue: 514, correctionReason: "findings" };
  let calls = 0;
  const ok = await reserveAndPersistHandoff(
    gate,
    { repo: "o/r", cwd: fx.primary, fromHandoff: true },
    { ghPrViewImpl: fx.ghPrViewImpl, readIssueImpl: noIntent, tokenImpl: () => "tokokay1", persist: () => (calls++, true) },
  );
  assert.equal(ok.persistFailed, false);
  assert.equal(ok.exitCode, 0);
  assert.equal(calls, 1);
  assert.ok(existsSync(ok.output.checkoutBinding.path));
  const stdin = await reserveAndPersistHandoff(
    gate,
    { repo: "o/r", cwd: fx.primary },
    { ghPrViewImpl: fx.ghPrViewImpl, readIssueImpl: noIntent, tokenImpl: () => "tokokay2", persist: () => (calls++, false) },
  );
  assert.equal(stdin.persistFailed, false);
  assert.equal(calls, 1);
});

// Issue #1023: the ordinary-satisfied conflict verdict reserves the predecessor checkout pinned to
// its `reviewedHead` (no corrected head exists), failing closed on a moved head or a missing pin.
test("#1023 reserveFromGate: STAGE1_SATISFIED_MERGE_CONFLICT gains checkoutBinding pinned to the gated reviewedHead", async (t) => {
  const fx = makeFixture(t);
  const gate = { state: "STAGE1_SATISFIED_MERGE_CONFLICT", stopAfter: true, pr: PR, issue: 964, controlIssue: 963, reviewedHead: fx.prHead.sha };
  const out = await reserveFromGate(gate, { repo: "o/r", cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokord01" });
  assert.equal(out.exitCode, 0);
  assert.equal(out.output.state, "STAGE1_SATISFIED_MERGE_CONFLICT");
  assert.equal(out.output.checkoutBinding.sha, fx.prHead.sha);
  assert.ok(existsSync(out.output.checkoutBinding.path));
  assert.equal(out.output.reviewedHead, gate.reviewedHead);
});

test("#1023 reserveFromGate: STAGE1_SATISFIED_MERGE_CONFLICT fails closed when the PR head moved after the verdict, or when no 40-char reviewedHead pins it", async (t) => {
  const fx = makeFixture(t);
  const gated = fx.prHead.sha;
  const noPin = await reserveFromGate(
    { state: "STAGE1_SATISFIED_MERGE_CONFLICT", stopAfter: true, pr: PR, issue: 964, controlIssue: 963 },
    { repo: "o/r", cwd: fx.primary },
    { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokord02" },
  );
  assert.equal(noPin.exitCode, 2);
  assert.equal(noPin.output.state, "CHECKOUT_BINDING_UNVERIFIED");
  fx.prHead.sha = commitFile(fx.implementer, "feature.txt", "moved after the conflict verdict\n");
  git(fx.implementer, "push", "-q", "origin", BRANCH);
  const moved = await reserveFromGate(
    { state: "STAGE1_SATISFIED_MERGE_CONFLICT", stopAfter: true, pr: PR, issue: 964, controlIssue: 963, reviewedHead: gated },
    { repo: "o/r", cwd: fx.primary },
    { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokord03" },
  );
  assert.equal(moved.exitCode, 2);
  assert.equal(moved.output.verdict, "STALE_HEAD_MISMATCH");
  assert.equal(moved.output.actionEnvelope.mode, "none");
});

// -------------------------------------------------------------------------------------------
// Issue #1031: pre-reservation known-scope executor-substrate authority check
// -------------------------------------------------------------------------------------------

const FENCE = "```";
const grant = (component, paths) => ({ component, paths, intendedChange: "x", verification: "y" });
function issueBody({ planned, grants = [], extra = {} } = {}) {
  const parts = ["intro"];
  if (planned !== undefined) parts.push(`${FENCE}json\n${JSON.stringify({ plannedMutationPaths: planned, ...extra })}\n${FENCE}`);
  if (grants.length) parts.push(`${FENCE}json\n${JSON.stringify({ executorSubstrate: grants })}\n${FENCE}`);
  return parts.join("\n\n");
}
const GATE1031 = { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, pr: PR, issue: 1029, controlIssue: 514, correctionReason: "findings" };
const P1029 = ["tools/review-watch/trigger.mjs", "tools/orchestration/action-envelope.mjs"];
const G_REVIEW = grant("review-control", ["tools/review-watch/trigger.mjs"]);
const G_AUTH = grant("authority-guards", ["tools/orchestration/action-envelope.mjs"]);

async function scoped(t, body, gate = GATE1031, token = "tok1031a", extraDeps = {}) {
  const fx = makeFixture(t);
  const before = worktreeCount(fx.primary);
  const reads = [];
  const out = await reserveFromGate(
    gate,
    { repo: "o/r", cwd: fx.primary },
    { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => token, readIssueImpl: async (a) => (reads.push(a), { body, state: "OPEN" }), ...extraDeps },
  );
  return { fx, out, before, reads, after: () => worktreeCount(fx.primary) };
}

test("#1031 #1029-shaped scope with only review-control stops before reservation naming authority-guards", async (t) => {
  const r = await scoped(t, issueBody({ planned: P1029, grants: [G_REVIEW] }));
  assert.equal(r.out.exitCode, 2);
  assert.equal(r.out.output.state, "KNOWN_SCOPE_AUTHORITY_MISSING");
  assert.equal(r.out.output.verdict, "SUBSTRATE_AUTHORITY_MISSING");
  assert.deepEqual(r.out.output.unauthorizedComponents, ["authority-guards"]);
  assert.equal(r.out.output.stopAfter, true);
  assert.equal(r.out.output.actionEnvelope.mode, "none");
  assert.equal(r.out.output.checkoutBinding, undefined);
  assert.equal(r.after(), r.before, "no worktree reserved");
  assert.equal(r.reads[0].number, 1029);
});

test("#1031 both exact grants: reserves unchanged, and a repeat invocation reuses the reservation", async (t) => {
  const body = issueBody({ planned: P1029, grants: [G_REVIEW, G_AUTH], extra: { executionIssue: 1029, pr: PR } });
  const r = await scoped(t, body);
  assert.equal(r.out.exitCode, 0);
  assert.equal(r.out.output.state, "STAGE1_CORRECTION_REQUIRED");
  assert.ok(existsSync(r.out.output.checkoutBinding.path));
  // Existing idempotency lives in the CLI handoff path (an already-bound handoff is returned
  // as-is, see main()); the new check adds no state, so a repeated missing-grant stop is
  // side-effect free and deterministic.
  const missing = issueBody({ planned: P1029, grants: [G_REVIEW] });
  const first = await scoped(t, missing, GATE1031, "tok1031e");
  const second = await reserveFromGate(GATE1031, { repo: "o/r", cwd: first.fx.primary }, { ghPrViewImpl: first.fx.ghPrViewImpl, tokenImpl: () => "tok1031f", readIssueImpl: async () => ({ body: missing }) });
  assert.deepEqual(second.output, first.out.output);
  assert.equal(first.after(), first.before);
});

test("#1031 grant naming the component but excluding the planned path is not adjacent-path permission", async (t) => {
  const r = await scoped(t, issueBody({ planned: P1029, grants: [G_REVIEW, grant("authority-guards", ["tools/orchestration/other.mjs"])] }));
  assert.equal(r.out.exitCode, 2);
  assert.equal(r.out.output.verdict, "SUBSTRATE_AUTHORITY_MISSING");
  assert.deepEqual(r.out.output.paths, ["tools/orchestration/action-envelope.mjs"]);
  assert.equal(r.after(), r.before);
});

test("#1031 test-only planned paths take the ordinary WORK_PRODUCT route; absent intent leaves dispatch unchanged", async (t) => {
  const a = await scoped(t, issueBody({ planned: ["tools/review-watch/trigger.test.mjs"] }));
  assert.equal(a.out.exitCode, 0);
  assert.ok(a.out.output.checkoutBinding);
  const b = await scoped(t, issueBody({ grants: [G_REVIEW] }), GATE1031, "tok1031c");
  assert.equal(b.out.exitCode, 0);
  assert.ok(b.out.output.checkoutBinding);
});

test("#1031 present-but-malformed or ambiguous intent fails closed without reserving", async (t) => {
  const dup = `${issueBody({ planned: ["a.test.mjs"] })}\n\n${issueBody({ planned: ["b.test.mjs"] })}`;
  const cases = [
    issueBody({ planned: [] }),
    issueBody({ planned: "tools/review-watch/trigger.mjs" }),
    issueBody({ planned: ["ok.test.mjs", 5] }),
    `${FENCE}json\n{"plannedMutationPaths": [oops\n${FENCE}`,
    dup,
  ];
  for (const body of cases) {
    const r = await scoped(t, body);
    assert.equal(r.out.exitCode, 2);
    assert.equal(r.out.output.state, "KNOWN_SCOPE_AUTHORITY_MISSING");
    assert.equal(r.out.output.verdict, "PLANNED_SCOPE_MALFORMED");
    assert.equal(r.after(), r.before);
  }
});

test("#1031 stale intent identity and unreadable Issue fail closed without reserving", async (t) => {
  for (const extra of [{ executionIssue: 999 }, { pr: PR + 1 }]) {
    const r = await scoped(t, issueBody({ planned: ["x.test.mjs"], extra }));
    assert.equal(r.out.output.verdict, "PLANNED_SCOPE_STALE");
    assert.equal(r.after(), r.before);
  }
  const head = await scoped(t, issueBody({ planned: ["x.test.mjs"], extra: { head: "a".repeat(40) } }), { ...GATE1031, head: "b".repeat(40) });
  assert.equal(head.out.output.verdict, "PLANNED_SCOPE_STALE");
  const unread = await scoped(t, "", GATE1031, "tok1031d", {
    readIssueImpl: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(unread.out.exitCode, 2);
  assert.equal(unread.out.output.verdict, "PLANNED_SCOPE_UNVERIFIED");
  assert.equal(unread.after(), unread.before);
});

test("#1031 reserveAndPersistHandoff persists the terminal missing-grant verdict and reserves nothing; closing-reference and other verdicts do not read the Issue", async (t) => {
  const fx = makeFixture(t);
  const before = worktreeCount(fx.primary);
  let persisted = null;
  const out = await reserveAndPersistHandoff(
    GATE1031,
    { repo: "o/r", cwd: fx.primary, fromHandoff: true },
    {
      ghPrViewImpl: fx.ghPrViewImpl,
      readIssueImpl: async () => ({ body: issueBody({ planned: P1029, grants: [G_REVIEW] }) }),
      persist: (o) => {
        persisted = o;
        return true;
      },
    },
  );
  assert.equal(out.exitCode, 2);
  assert.equal(persisted.state, "KNOWN_SCOPE_AUTHORITY_MISSING");
  assert.equal(worktreeCount(fx.primary), before);
  const never = async () => {
    throw new Error("must not read");
  };
  const cr = await reserveFromGate({ ...GATE1031, correctionReason: "closing-reference" }, { repo: "o/r", cwd: fx.primary }, { readIssueImpl: never });
  assert.equal(cr.exitCode, 0);
  const other = await reserveFromGate({ state: "NO_ACTION_YET" }, { repo: "o/r", cwd: fx.primary }, { readIssueImpl: never });
  assert.equal(other.exitCode, 0);
});

// Issue #1031 Stage 1 correction (PR #1033 findings P2 x2): ambiguity and alias fail-closed cases.
test("#1031 duplicate sensitive keys inside one object fail closed; separate blocks and nested repeats stay distinct", async (t) => {
  const dupIntent = `${FENCE}json\n{"plannedMutationPaths": ["tools/orchestration/action-envelope.mjs"], "plannedMutationPaths": ["x.test.mjs"]}\n${FENCE}`;
  const dupGrants = `${issueBody({ planned: P1029 })}\n\n${FENCE}json\n{"executorSubstrate": [], "executorSubstrate": [${JSON.stringify(G_AUTH)}]}\n${FENCE}`;
  for (const body of [dupIntent, dupGrants]) {
    const r = await scoped(t, body);
    assert.equal(r.out.exitCode, 2);
    assert.equal(r.out.output.verdict, "PLANNED_SCOPE_MALFORMED");
    assert.match(r.out.output.reason, /duplicate JSON key/);
    assert.equal(r.after(), r.before, "no worktree reserved");
  }
  // Same key in nested/sibling objects is not a duplicate; legitimate separate grant blocks still work.
  assert.equal(findDuplicateJsonKey('{"a":{"x":1},"b":{"x":2},"c":[{"x":1},{"x":2}]}'), null);
  const ok = await scoped(t, issueBody({ planned: P1029, grants: [G_REVIEW] }) + `\n\n${issueBody({ grants: [G_AUTH] })}`, GATE1031, "tok1031g");
  assert.equal(ok.out.exitCode, 0);
});

test("#1031 noncanonical dot-segment aliases are rejected before classification", async (t) => {
  for (const alias of ["././tools/orchestration/action-envelope.mjs", "tools/./orchestration/action-envelope.mjs", "tools//orchestration/action-envelope.mjs", "tools/orchestration/../orchestration/action-envelope.mjs", "tools\\orchestration\\action-envelope.mjs"]) {
    const r = await scoped(t, issueBody({ planned: [alias] }));
    assert.equal(r.out.exitCode, 2, alias);
    assert.equal(r.out.output.verdict, "PLANNED_SCOPE_MALFORMED", alias);
    assert.equal(r.after(), r.before);
  }
  const single = await scoped(t, issueBody({ planned: ["./tools/orchestration/action-envelope.mjs"], grants: [G_AUTH] }), GATE1031, "tok1031h");
  assert.equal(single.out.exitCode, 0, "single leading ./ remains classified by the shared classifier");
});
