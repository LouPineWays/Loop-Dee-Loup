// Tests for tools/orchestration/control-plane-freshness.mjs — issue #779. Uses real throwaway git
// repositories (a bare "origin" plus clones) so fetch/merge-base/diff behavior is exercised for
// real, never the network or this repository.
//
// Run with: node --test tools/orchestration/control-plane-freshness.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkControlPlaneFreshness } from "./control-plane-freshness.mjs";
import { runSessionEntryGate } from "./session-entry-gate.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitFile(cwd, rel, content, msg) {
  const full = join(cwd, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", msg);
  return git(cwd, "rev-parse", "HEAD");
}

// origin (bare) + `upstream` working clone used to advance origin/main + `runner` clone under test.
function setup() {
  const base = mkdtempSync(join(tmpdir(), "ldl-freshness-"));
  const origin = join(base, "origin.git");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  const upstream = join(base, "upstream");
  git(base, "clone", "-q", origin, upstream);
  git(upstream, "checkout", "-q", "-B", "main");
  commitFile(upstream, "tools/review-watch/stage1-gate.mjs", "old\n", "init");
  commitFile(upstream, "docs/x.md", "d\n", "docs");
  git(upstream, "push", "-q", "origin", "main");
  const runner = join(base, "runner");
  git(base, "clone", "-q", origin, runner);
  return { base, origin, upstream, runner };
}

function advanceOrigin({ upstream }, rel, content) {
  const c = commitFile(upstream, rel, content, "advance");
  git(upstream, "push", "-q", "origin", "main");
  return c;
}

function cleanup(env) {
  rmSync(env.base, { recursive: true, force: true });
}

test("stale runner (default branch gained a control-plane correction) is STALE with recovery, not a verdict", () => {
  const env = setup();
  try {
    const newMain = advanceOrigin(env, "tools/review-watch/stage1-clean-reaction.mjs", "new\n");
    const headBefore = git(env.runner, "rev-parse", "HEAD");
    const r = checkControlPlaneFreshness({ root: env.runner });
    assert.equal(r.ok, false);
    assert.equal(r.state, "STALE");
    assert.deepEqual(r.stalePaths, ["tools/review-watch/stage1-clean-reaction.mjs"]);
    assert.equal(r.witness.defaultBranchCommit, newMain);
    assert.equal(r.witness.headCommit, headBefore);
    assert.match(r.message, /git worktree add --detach/);
    assert.match(r.message, /do not rebase\/merge the subject PR/);
    // Exact-head preservation: the check never moves HEAD or the working tree.
    assert.equal(git(env.runner, "rev-parse", "HEAD"), headBefore);
    assert.equal(existsSync(join(env.runner, "tools/review-watch/stage1-clean-reaction.mjs")), false);
  } finally {
    cleanup(env);
  }
});

test("current runner: only control-plane-irrelevant drift is CURRENT and carries a witness", () => {
  const env = setup();
  try {
    advanceOrigin(env, "docs/y.md", "unrelated\n");
    const r = checkControlPlaneFreshness({ root: env.runner });
    assert.equal(r.ok, true);
    assert.equal(r.state, "CURRENT");
    assert.equal(r.witness.source, "default-branch");
    assert.equal(r.witness.defaultBranchRef, "origin/main");
    assert.ok(r.witness.mergeBase);
  } finally {
    cleanup(env);
  }
});

test("after recovery (fast-forward to the default branch) the runner is CURRENT", () => {
  const env = setup();
  try {
    advanceOrigin(env, "tools/orchestration/x.mjs", "new\n");
    assert.equal(checkControlPlaneFreshness({ root: env.runner }).state, "STALE");
    git(env.runner, "merge", "--ff-only", "origin/main");
    assert.equal(checkControlPlaneFreshness({ root: env.runner }).state, "CURRENT");
  } finally {
    cleanup(env);
  }
});

test("control-plane PR case: up-to-date branch with its own gate change is CURRENT; lagging is STALE unless the source is explicitly checkout", () => {
  const env = setup();
  try {
    git(env.runner, "checkout", "-q", "-b", "pr");
    commitFile(env.runner, "tools/orchestration/gate.mjs", "pr-change\n", "pr gate change");
    // Its own control-plane change is not staleness.
    assert.equal(checkControlPlaneFreshness({ root: env.runner }).state, "CURRENT");
    advanceOrigin(env, "tools/review-watch/stage1-clean-reaction.mjs", "new\n");
    assert.equal(checkControlPlaneFreshness({ root: env.runner }).state, "STALE");
    // Explicit authorized runner source: no network, no comparison, witness names the choice.
    const explicit = checkControlPlaneFreshness({
      root: env.runner,
      source: "checkout",
      git: (args, o) => {
        assert.notEqual(args[0], "fetch");
        return git(o.cwd, ...args);
      },
    });
    assert.equal(explicit.ok, true);
    assert.equal(explicit.witness.source, "checkout-explicit");
  } finally {
    cleanup(env);
  }
});

test("unreachable authoritative ref fails closed as UNVERIFIABLE (operational), never CURRENT", () => {
  const env = setup();
  try {
    git(env.runner, "remote", "set-url", "origin", join(env.base, "does-not-exist.git"));
    const r = checkControlPlaneFreshness({ root: env.runner });
    assert.equal(r.ok, false);
    assert.equal(r.state, "UNVERIFIABLE");
    assert.match(r.message, /operational error, not a lifecycle verdict/);
    assert.match(r.message, /--control-plane-source checkout/);
  } finally {
    cleanup(env);
  }
});

test("unknown control-plane source is rejected", () => {
  assert.equal(checkControlPlaneFreshness({ source: "bogus" }).ok, false);
});

test("dirty/untracked worktree content is left untouched by the freshness check", () => {
  const env = setup();
  try {
    advanceOrigin(env, "tools/orchestration/x.mjs", "new\n");
    writeFileSync(join(env.runner, "scratch.txt"), "mine\n");
    checkControlPlaneFreshness({ root: env.runner });
    assert.equal(existsSync(join(env.runner, "scratch.txt")), true);
  } finally {
    cleanup(env);
  }
});

test("session-entry-gate: stale runner fails closed BEFORE any lifecycle gate runs", async () => {
  const stale = { ok: false, exitCode: 1, state: "STALE", message: "Stale control-plane runner: ..." };
  const result = await runSessionEntryGate(
    { repo: "o/r", controlIssue: 438 },
    {
      checkControlPlaneFreshnessImpl: () => stale,
      checkReadyDispatchImpl: async () => {
        throw new Error("lifecycle gate must not run on a stale runner");
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /Stale control-plane runner/);
});

test("session-entry-gate: current runner proceeds and the witness rides on the verdict", async () => {
  const witness = { source: "default-branch", headCommit: "a", defaultBranchCommit: "b" };
  let seenSource;
  const result = await runSessionEntryGate(
    { repo: "o/r", controlIssue: 438, controlPlaneSource: "checkout" },
    {
      checkControlPlaneFreshnessImpl: ({ source }) => {
        seenSource = source;
        return { ok: true, witness };
      },
      checkReadyDispatchImpl: async () => ({
        exitCode: 0,
        state: "READY_TO_DISPATCH",
        actionEnvelope: { mode: "none", authorizedActions: [] },
      }),
    },
  );
  assert.equal(seenSource, "checkout");
  assert.equal(result.ok, true);
  assert.equal(result.state, "READY_TO_DISPATCH");
  assert.deepEqual(result.controlPlaneWitness, witness);
});

test("dirty tracked/untracked control-plane content is DIRTY (not CURRENT) and left untouched; outside paths irrelevant", () => {
  const env = setup();
  try {
    writeFileSync(join(env.runner, "tools/review-watch/stage1-gate.mjs"), "locally modified\n");
    writeFileSync(join(env.runner, "tools/review-watch/untracked.mjs"), "u\n");
    const r = checkControlPlaneFreshness({ root: env.runner });
    assert.equal(r.ok, false);
    assert.equal(r.state, "DIRTY");
    assert.deepEqual([...r.witness.uncommittedControlPlanePaths].sort(), ["tools/review-watch/stage1-gate.mjs", "tools/review-watch/untracked.mjs"]);
    assert.equal(existsSync(join(env.runner, "tools/review-watch/untracked.mjs")), true);
    assert.match(git(env.runner, "status", "--porcelain"), /stage1-gate/);
    // explicit checkout source authorizes it with a truthful witness
    const ex = checkControlPlaneFreshness({ root: env.runner, source: "checkout" });
    assert.equal(ex.ok, true);
    assert.equal(ex.witness.executedRevision, "HEAD+working-tree");
    // dirty content outside protected paths is irrelevant
    git(env.runner, "checkout", "--", "tools/review-watch/stage1-gate.mjs");
    rmSync(join(env.runner, "tools/review-watch/untracked.mjs"));
    writeFileSync(join(env.runner, "scratch.txt"), "mine\n");
    assert.equal(checkControlPlaneFreshness({ root: env.runner }).state, "CURRENT");
    assert.equal(existsSync(join(env.runner, "scratch.txt")), true);
  } finally {
    cleanup(env);
  }
});

test("non-main default branch without cached origin/HEAD symref is resolved from the remote", () => {
  const base = mkdtempSync(join(tmpdir(), "ldl-freshness-trunk-"));
  try {
    const origin = join(base, "origin.git");
    git(base, "init", "-q", "--bare", "-b", "trunk", origin);
    const up = join(base, "up");
    git(base, "clone", "-q", origin, up);
    git(up, "checkout", "-q", "-B", "trunk");
    commitFile(up, "tools/orchestration/a.mjs", "1\n", "init");
    git(up, "push", "-q", "origin", "trunk");
    const runner = join(base, "runner");
    git(base, "clone", "-q", origin, runner);
    try { git(runner, "remote", "set-head", "origin", "-d"); } catch {}
    assert.equal(checkControlPlaneFreshness({ root: runner }).witness.defaultBranchRef, "origin/trunk");
    assert.equal(checkControlPlaneFreshness({ root: runner }).state, "CURRENT");
    commitFile(up, "tools/orchestration/b.mjs", "2\n", "adv");
    git(up, "push", "-q", "origin", "trunk");
    assert.equal(checkControlPlaneFreshness({ root: runner }).state, "STALE");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("unresolvable remote default branch fails closed as UNVERIFIABLE", () => {
  const env = setup();
  try {
    const r = checkControlPlaneFreshness({
      root: env.runner,
      git: (args, o) => {
        if (args[0] === "ls-remote") return "";
        return git(o.cwd, ...args);
      },
    });
    assert.equal(r.state, "UNVERIFIABLE");
  } finally {
    cleanup(env);
  }
});

test("leaf gate CLIs attach controlPlaneWitness to emitted verdicts", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["ready-dispatch-gate.mjs", "next-review-transition-gate.mjs"]) {
    const src = readFileSync(new URL("./" + f, import.meta.url), "utf8");
    assert.match(src, /const controlPlaneWitness = enforceControlPlaneFreshness\(\)/, f);
    assert.match(src, /result\.controlPlaneWitness = controlPlaneWitness/, f);
    assert.ok(src.indexOf("result.controlPlaneWitness = controlPlaneWitness") < src.indexOf("persistLastGateVerdict(emitted)", src.indexOf("async function main")), f);
  }
});
