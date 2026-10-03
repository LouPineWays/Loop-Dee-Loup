// Issue #877: bootstrap boundary regression coverage with real Git fixtures.
// Run: node --test tools/orchestration/control-plane-bootstrap.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBootstrapArgs, runBootstrap } from "./control-plane-bootstrap.mjs";
import { readBootstrapRunnerWitness } from "./control-plane-freshness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_SRC = readFileSync(join(HERE, "control-plane-bootstrap.mjs"), "utf8");
const FRESHNESS_SRC = readFileSync(join(HERE, "control-plane-freshness.mjs"), "utf8");

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

// Old gate = the superseded PR #865-era global Search path (the #571 fingerprint).
const OLD_GATE = `console.log("OLD-GLOBAL-SEARCH gh api search/issues");\n`;
const NEW_GATE =
  `import { enforceControlPlaneFreshness } from "./control-plane-freshness.mjs";\n` +
  `const w = enforceControlPlaneFreshness();\n` +
  `console.log("CURRENT-REPO-SCOPED " + w.source + " args=" + process.argv.slice(2).join(","));\n`;

function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

// origin: C0 (pre-#779: old gate, no freshness module) -> C1 (current gate + freshness).
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "ldl-boot-"));
  const seed = join(base, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  write(seed, "tools/orchestration/session-entry-gate.mjs", OLD_GATE);
  write(seed, "README.md", "x\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "c0");
  const c0 = git(seed, "rev-parse", "HEAD");
  const origin = join(base, "origin.git");
  git(base, "clone", "-q", "--bare", seed, origin);
  const stale = join(base, "stale");
  git(base, "clone", "-q", origin, stale);
  write(seed, "tools/orchestration/session-entry-gate.mjs", NEW_GATE);
  write(seed, "tools/orchestration/control-plane-freshness.mjs", FRESHNESS_SRC);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "c1");
  git(seed, "push", "-q", origin, "main");
  const c1 = git(seed, "rev-parse", "HEAD");
  return { base, seed, origin, stale, c0, c1, cache: join(base, "cache") };
}

function viaStdin(cwd, cache, ...args) {
  return spawnSync(process.execPath, ["-", ...args], {
    cwd,
    input: BOOTSTRAP_SRC,
    encoding: "utf8",
    env: { ...process.env, LDL_CONTROL_PLANE_RUNNER_CACHE: cache },
  });
}

const snapshot = (cwd) =>
  [
    git(cwd, "rev-parse", "HEAD"),
    git(cwd, "status", "--porcelain", "--untracked-files=all"),
    readFileSync(join(cwd, "tools/orchestration/session-entry-gate.mjs"), "utf8"),
  ].join("|");

test("pre-#779 stale checkout: bootstrap from origin source selects current runner; old Search path never runs", () => {
  const f = fixture();
  assert.equal(existsSync(join(f.stale, "tools/orchestration/control-plane-freshness.mjs")), false);
  writeFileSync(join(f.stale, "scratch.txt"), "user work\n"); // dirty subject outside control-plane paths
  const before = snapshot(f.stale);
  const r = viaStdin(f.stale, f.cache, "session-entry-gate", "--control-issue", "571");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CURRENT-REPO-SCOPED bootstrap-default-branch args=--control-issue,571/);
  assert.doesNotMatch(r.stdout, /OLD-GLOBAL-SEARCH/);
  assert.match(r.stderr, new RegExp(f.c1.slice(0, 12)));
  assert.equal(snapshot(f.stale), before, "subject HEAD/index/worktree untouched");
  assert.equal(readFileSync(join(f.stale, "scratch.txt"), "utf8"), "user work\n");
});

test("ordinary stale checkout (contains freshness, lags a later correction) still routes to current runner", () => {
  const f = fixture();
  const cur = join(f.base, "cur");
  git(f.base, "clone", "-q", f.origin, cur);
  write(f.seed, "tools/orchestration/session-entry-gate.mjs", NEW_GATE + `console.log("LATER-CORRECTION");\n`);
  git(f.seed, "commit", "-qam", "c2");
  git(f.seed, "push", "-q", f.origin, "main");
  const r = viaStdin(cur, f.cache, "session-entry-gate");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LATER-CORRECTION/);
  assert.match(r.stdout, /bootstrap-default-branch/);
});

test("current checkout runs locally through #779's own checker with no runner export", () => {
  const f = fixture();
  const cur = join(f.base, "cur");
  git(f.base, "clone", "-q", f.origin, cur);
  const r = viaStdin(cur, f.cache, "session-entry-gate", "--control-issue", "9");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CURRENT-REPO-SCOPED default-branch args=--control-issue,9/);
  assert.equal(existsSync(f.cache), false, "no runner exported for an already-current checkout");
});

test("dirty control-plane paths in a current checkout route to the authoritative runner, files preserved", () => {
  const f = fixture();
  const cur = join(f.base, "cur");
  git(f.base, "clone", "-q", f.origin, cur);
  write(cur, "tools/orchestration/local-edit.mjs", "// wip\n");
  const r = viaStdin(cur, f.cache, "session-entry-gate");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bootstrap-default-branch/);
  assert.equal(readFileSync(join(cur, "tools/orchestration/local-edit.mjs"), "utf8"), "// wip\n");
});

test("unreachable default branch fails closed before any gate output", () => {
  const f = fixture();
  git(f.stale, "remote", "set-url", "origin", join(f.base, "missing.git"));
  const r = viaStdin(f.stale, f.cache, "session-entry-gate");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /not a lifecycle verdict; no gate was run/);
  assert.match(r.stderr, /--control-plane-source checkout/);
});

test("explicit checkout source runs the checkout's own gate and forwards the authorization", () => {
  const f = fixture();
  const r = viaStdin(f.stale, f.cache, "--control-plane-source", "checkout", "session-entry-gate");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OLD-GLOBAL-SEARCH/);
  assert.equal(existsSync(f.cache), false);
});

test("runner export preserves exact-head: subject HEAD unchanged and not a registered worktree", () => {
  const f = fixture();
  const wtBefore = git(f.stale, "worktree", "list", "--porcelain");
  const r = viaStdin(f.stale, f.cache, "session-entry-gate");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(f.stale, "worktree", "list", "--porcelain"), wtBefore);
  assert.equal(git(f.stale, "rev-parse", "HEAD"), f.c0);
  assert.deepEqual(readdirSync(f.cache), [f.c1]);
});

test("runner witness requires the marker file and matching commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-marker-"));
  const env = { LDL_CONTROL_PLANE_RUNNER: JSON.stringify({ runnerCommit: "abc", defaultBranchCommit: "abc" }) };
  assert.equal(readBootstrapRunnerWitness(dir, env), null);
  writeFileSync(join(dir, ".ldl-control-plane-runner"), "abc\n");
  assert.equal(readBootstrapRunnerWitness(dir, env).source, "bootstrap-default-branch");
  writeFileSync(join(dir, ".ldl-control-plane-runner"), "other\n");
  assert.equal(readBootstrapRunnerWitness(dir, env), null);
  assert.equal(readBootstrapRunnerWitness(dir, {}), null);
});

test("argument parsing and gate-name validation", () => {
  assert.deepEqual(parseBootstrapArgs(["--control-plane-source", "checkout", "g", "--a", "1"]), {
    source: "checkout",
    gate: "g",
    gateArgs: ["--a", "1"],
  });
  const logs = [];
  assert.equal(runBootstrap(["../evil"], { log: (m) => logs.push(m) }), 2);
  assert.equal(runBootstrap([], { log: (m) => logs.push(m) }), 2);
});
