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
//   - occupied target, dirty target, stale head, already-correct binding, primary checkout.
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
  parseBindingLockReason,
  formatBindingLockReason,
} from "./pr-head-checkout-preflight.mjs";

const PR = 700;
const BRANCH = "worktree-agent-pr700";

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

test("occupied target: a worktree another session already holds (git worktree lock) is never reserved in place", async (t) => {
  const fx = makeFixture(t);
  const other = join(fx.primary, ".claude", "worktrees", "other-session");
  git(fx.primary, "worktree", "add", "-q", "-b", "other-local", other, fx.prHead.sha);
  git(fx.primary, "worktree", "lock", "--reason", "held by another live session", other);
  const result = await reserve({ repo: "o/r", pr: PR, cwd: other }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tok00004" });
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "OCCUPIED_CANDIDATE");
  assert.equal(lockReasonOf(fx.primary, other), "held by another live session");
});

test("occupied target: a second reservation of an already-reserved in-place worktree fails closed; the first reservation still verifies", async (t) => {
  const fx = makeFixture(t);
  const wt = join(fx.primary, ".claude", "worktrees", "controller-at-head");
  git(fx.primary, "worktree", "add", "-q", "-b", "controller-local", wt, fx.prHead.sha);
  const first = await reserve({ repo: "o/r", pr: PR, cwd: wt }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokfirst" });
  assert.equal(first.verdict, "RESERVED_IN_PLACE");
  const second = await reserve({ repo: "o/r", pr: PR, cwd: wt }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "toksecnd" });
  assert.equal(second.exitCode, 2);
  assert.equal(second.verdict, "OCCUPIED_CANDIDATE");
  const stillFirst = await verifyBinding({ repo: "o/r", pr: PR, token: "tokfirst", cwd: wt }, { ghPrViewImpl: fx.ghPrViewImpl });
  assert.equal(stillFirst.verdict, "BINDING_VERIFIED");
  const notSecond = await verifyBinding({ repo: "o/r", pr: PR, token: "toksecnd", cwd: wt }, { ghPrViewImpl: fx.ghPrViewImpl });
  assert.equal(notSecond.verdict, "BINDING_NOT_FOUND");
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

test("dirty target: an in-place candidate with local modifications is never reserved", async (t) => {
  const fx = makeFixture(t);
  const wt = join(fx.primary, ".claude", "worktrees", "dirty-at-head");
  git(fx.primary, "worktree", "add", "-q", "-b", "dirty-local", wt, fx.prHead.sha);
  writeFileSync(join(wt, "feature.txt"), "uncommitted\n");
  const result = await reserve({ repo: "o/r", pr: PR, cwd: wt }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokdirty" });
  assert.equal(result.exitCode, 2);
  assert.equal(result.verdict, "DIRTY_CANDIDATE");
  assert.equal(lockReasonOf(fx.primary, wt), null);
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

// -------------------------------------------------------------------------------------------
// Required check 7: already-correct binding -- no churn
// -------------------------------------------------------------------------------------------

test("already-correct binding: a clean non-primary worktree already at the exact head is reserved in place, with no new worktree", async (t) => {
  const fx = makeFixture(t);
  const wt = join(fx.primary, ".claude", "worktrees", "already-at-head");
  git(fx.primary, "worktree", "add", "-q", "-b", "already-local", wt, fx.prHead.sha);
  const before = worktreeCount(fx.primary);
  const result = await reserve({ repo: "o/r", pr: PR, cwd: wt }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokinplc" });
  assert.equal(result.exitCode, 0);
  assert.equal(result.verdict, "RESERVED_IN_PLACE");
  assert.equal(worktreeCount(fx.primary), before);
  const verified = await verifyBinding({ repo: "o/r", pr: PR, token: "tokinplc", cwd: wt }, { ghPrViewImpl: fx.ghPrViewImpl });
  assert.equal(verified.verdict, "BINDING_VERIFIED");
  // Release only unlocks an in-place reservation; it never removes a checkout it did not create.
  const released = await releaseBinding({ token: "tokinplc", cwd: fx.primary });
  assert.equal(released.verdict, "RELEASED");
  assert.equal(released.removed, false);
  assert.ok(existsSync(wt));
  assert.equal(lockReasonOf(fx.primary, wt), null);
});

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

// -------------------------------------------------------------------------------------------
// reserveFromGate: the controller's pipeline stage
// -------------------------------------------------------------------------------------------

test("reserveFromGate: a findings STAGE1_CORRECTION_REQUIRED verdict gains checkoutBinding; other verdicts pass through untouched", async (t) => {
  const fx = makeFixture(t);
  const gate = { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, pr: PR, issue: 689, controlIssue: 514, correctionReason: "findings" };
  const out = await reserveFromGate(gate, { repo: "o/r", cwd: fx.primary }, { ghPrViewImpl: fx.ghPrViewImpl, tokenImpl: () => "tokgate1" });
  assert.equal(out.exitCode, 0);
  assert.equal(out.output.state, "STAGE1_CORRECTION_REQUIRED");
  assert.equal(out.output.checkoutBinding.token, "tokgate1");
  assert.equal(out.output.checkoutBinding.verdict, "RESERVED_CREATED");
  assert.ok(existsSync(out.output.checkoutBinding.path));

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
    { ghPrViewImpl: async () => ({ headRefName: BRANCH, headRefOid: "e".repeat(40) }), tokenImpl: () => "tokgate2" },
  );
  assert.equal(out.exitCode, 2);
  assert.equal(out.output.state, "CHECKOUT_BINDING_UNVERIFIED");
  assert.equal(out.output.verdict, "STALE_HEAD_MISMATCH");
  assert.equal(out.output.stopAfter, true);
});
