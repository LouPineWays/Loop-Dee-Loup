// Issue #877: bootstrap boundary regression coverage with real Git fixtures.
// Run: node --test tools/orchestration/control-plane-bootstrap.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBootstrapArgs, runBootstrap } from "./control-plane-bootstrap.mjs";
import { readBootstrapRunnerWitness, checkControlPlaneFreshness } from "./control-plane-freshness.mjs";

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
  write(seed, "tools/orchestration/control-plane-bootstrap.mjs", BOOTSTRAP_SRC);
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

test("witness: legitimate bootstrap-created runner is accepted; self-consistent forgery is rejected (#877 Stage 2)", () => {
  const f = fixture();
  const witnessEnv = (commit) => ({ LDL_CONTROL_PLANE_RUNNER: JSON.stringify({ runnerCommit: commit, defaultBranchCommit: commit }) });
  // Legitimate: materialized from the authoritative commit.
  const r = viaStdin(f.stale, f.cache, "session-entry-gate");
  assert.equal(r.status, 0, r.stderr);
  const runnerDir = join(f.cache, f.c1);
  assert.equal(readBootstrapRunnerWitness(runnerDir, witnessEnv(f.c1), { subjectCwd: f.stale }).source, "bootstrap-default-branch");
  assert.equal(checkControlPlaneFreshness({ root: runnerDir, env: witnessEnv(f.c1), subjectCwd: f.stale }).state, "CURRENT");

  // Forgery 1: arbitrary dir with a matching marker/env pair (the old literal "abc" shape).
  const dir = mkdtempSync(join(tmpdir(), "ldl-marker-"));
  writeFileSync(join(dir, ".ldl-control-plane-runner"), "abc\n");
  assert.equal(readBootstrapRunnerWitness(dir, witnessEnv("abc"), { subjectCwd: f.stale }), null);

  // Forgery 2: valid-looking authoritative commit, but checkout-local code in the runner root.
  const forged = mkdtempSync(join(tmpdir(), "ldl-forged-"));
  write(forged, "tools/orchestration/session-entry-gate.mjs", OLD_GATE);
  write(forged, "tools/orchestration/control-plane-freshness.mjs", FRESHNESS_SRC);
  writeFileSync(join(forged, ".ldl-control-plane-runner"), `${f.c1}\n`);
  assert.equal(readBootstrapRunnerWitness(forged, witnessEnv(f.c1), { subjectCwd: f.stale }), null);
  assert.notEqual(checkControlPlaneFreshness({ root: forged, env: witnessEnv(f.c1), subjectCwd: f.stale }).state, "CURRENT");

  // Forgery 3: authoritative bytes plus an injected extra file.
  write(runnerDir, "tools/orchestration/evil.mjs", "// extra\n");
  assert.equal(readBootstrapRunnerWitness(runnerDir, witnessEnv(f.c1), { subjectCwd: f.stale }), null);

  // Mismatched marker / no env / non-tip commit are rejected.
  writeFileSync(join(runnerDir, ".ldl-control-plane-runner"), "other\n");
  assert.equal(readBootstrapRunnerWitness(runnerDir, witnessEnv(f.c1), { subjectCwd: f.stale }), null);
  assert.equal(readBootstrapRunnerWitness(runnerDir, {}, { subjectCwd: f.stale }), null);
  const stalePointer = mkdtempSync(join(tmpdir(), "ldl-oldtip-"));
  git(f.seed, "commit", "-q", "--allow-empty", "-m", "c2");
  git(f.seed, "push", "-q", f.origin, "main");
  writeFileSync(join(stalePointer, ".ldl-control-plane-runner"), `${f.c1}\n`);
  assert.equal(readBootstrapRunnerWitness(stalePointer, witnessEnv(f.c1), { subjectCwd: f.stale }), null);
});

test("cache with correct marker but modified syntactically-valid gate is replaced before the gate executes (#877 Stage 1)", () => {
  const f = fixture();
  const first = viaStdin(f.stale, f.cache, "session-entry-gate");
  assert.equal(first.status, 0, first.stderr);
  const cachedGate = join(f.cache, f.c1, "tools/orchestration/session-entry-gate.mjs");
  const sentinel = join(f.base, "tampered-ran");
  writeFileSync(cachedGate, 'import { writeFileSync } from "node:fs";\nwriteFileSync(' + JSON.stringify(sentinel) + ', "x");\nconsole.log("FORGED-CURRENT");\n');
  const r = viaStdin(f.stale, f.cache, "session-entry-gate");
  assert.equal(existsSync(sentinel), false, "tampered cached gate must never execute");
  assert.doesNotMatch(r.stdout, /FORGED-CURRENT/);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CURRENT-REPO-SCOPED bootstrap-default-branch/);

  // Injected extra file in a cache entry is likewise discarded.
  writeFileSync(join(f.cache, f.c1, "tools/orchestration/evil.mjs"), "// extra\n");
  const r2 = viaStdin(f.stale, f.cache, "session-entry-gate");
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(existsSync(join(f.cache, f.c1, "tools/orchestration/evil.mjs")), false);

  // A legitimate authenticated cache is reused as-is (a planted benign file outside the control-plane paths survives).
  writeFileSync(join(f.cache, f.c1, "reuse-probe.txt"), "p\n");
  const r3 = viaStdin(f.stale, f.cache, "session-entry-gate");
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(existsSync(join(f.cache, f.c1, "reuse-probe.txt")), true, "authentic cache reused, not rematerialized");

  // Unauthenticatable cache (marker removed) with an unreachable remote fails closed, forged gate never runs.
  rmSync(join(f.cache, f.c1, ".ldl-control-plane-runner"));
  writeFileSync(cachedGate, 'console.log("FORGED-CURRENT");\n');
  git(f.stale, "remote", "set-url", "origin", join(f.base, "missing.git"));
  const r4 = viaStdin(f.stale, f.cache, "session-entry-gate");
  assert.equal(r4.status, 1);
  assert.doesNotMatch(r4.stdout, /FORGED-CURRENT/);
});

test("missing authoritative bootstrap fails closed before any gate runs", () => {
  const f = fixture();
  git(f.seed, "rm", "-q", "tools/orchestration/control-plane-bootstrap.mjs");
  git(f.seed, "commit", "-q", "-m", "drop bootstrap");
  git(f.seed, "push", "-q", f.origin, "main");
  const r = viaStdin(f.stale, f.cache, "session-entry-gate");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /not a lifecycle verdict; no gate was run/);
});

test("malformed authoritative bootstrap fails closed with the bounded recovery, before any gate runs", () => {
  const f = fixture();
  write(f.seed, "tools/orchestration/control-plane-bootstrap.mjs", "const = ;\n");
  git(f.seed, "commit", "-qam", "malformed bootstrap");
  git(f.seed, "push", "-q", f.origin, "main");
  const r = viaStdin(f.stale, f.cache, "session-entry-gate");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /not a lifecycle verdict; no gate was run/);
  assert.match(r.stderr, /--control-plane-source checkout/);
});

test("missing or malformed requested gate fails closed through the same bounded path", () => {
  const f = fixture();
  const missing = viaStdin(f.stale, f.cache, "no-such-gate");
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /not a lifecycle verdict; no gate was run/);
  assert.match(missing.stderr, /no-such-gate\.mjs does not exist/);

  write(f.seed, "tools/orchestration/session-entry-gate.mjs", "const = ;\n");
  git(f.seed, "commit", "-qam", "malformed gate");
  git(f.seed, "push", "-q", f.origin, "main");
  const bad = viaStdin(f.stale, f.cache, "session-entry-gate");
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /not executable JavaScript/);
  assert.match(bad.stderr, /not a lifecycle verdict; no gate was run/);
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

test("stale bootstrap converges: the default branch's corrected bootstrap governs before the gate runs (#877 Stage 1)", () => {
  const f = fixture();
  // Stale checkout carries an OLD bootstrap that would launch the gate directly.
  const OLD_BOOT = BOOTSTRAP_SRC + "\n// OLD-BOOTSTRAP-MARKER\n";
  write(f.stale, "tools/orchestration/control-plane-bootstrap.mjs", OLD_BOOT);
  git(f.stale, "add", "-A");
  git(f.stale, "commit", "-q", "-m", "old bootstrap");
  // Default branch carries the corrected bootstrap, which tags the gate environment.
  const NEW_BOOT = BOOTSTRAP_SRC + "\n// CORRECTED-BOOTSTRAP-MARKER\n";
  write(f.seed, "tools/orchestration/control-plane-bootstrap.mjs", NEW_BOOT);
  write(f.seed, "tools/orchestration/session-entry-gate.mjs", NEW_GATE + `console.log("CONVERGED=" + process.env.LDL_CONTROL_PLANE_BOOTSTRAP_CONVERGED);\n`);
  git(f.seed, "add", "-A");
  git(f.seed, "commit", "-q", "-m", "c2");
  git(f.seed, "push", "-q", f.origin, "main");
  const c2 = git(f.seed, "rev-parse", "HEAD");
  const r = spawnSync(process.execPath, [join(f.stale, "tools/orchestration/control-plane-bootstrap.mjs"), "session-entry-gate", "--control-issue", "5"], {
    cwd: f.stale,
    encoding: "utf8",
    env: { ...process.env, LDL_CONTROL_PLANE_RUNNER_CACHE: f.cache },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /deferring to origin\/main/);
  assert.match(r.stdout, new RegExp(`CONVERGED=${c2}`), "the authoritative bootstrap (with the guard set) ran the gate");
  assert.match(r.stdout, /CURRENT-REPO-SCOPED bootstrap-default-branch/);
});

test("runner execution points verdict-handoff state at the subject checkout; two subjects never collide", () => {
  const f = fixture();
  write(f.seed, "tools/orchestration/session-entry-gate.mjs", NEW_GATE + `console.log("STATE=" + process.env.LDL_ACTION_ENVELOPE_STATE_DIR);\n`);
  git(f.seed, "commit", "-qam", "c2");
  git(f.seed, "push", "-q", f.origin, "main");
  const other = join(f.base, "other");
  git(f.base, "clone", "-q", f.origin, other);
  git(other, "reset", "-q", "--hard", f.c0); // second stale subject, same runner commit
  const a = viaStdin(f.stale, f.cache, "session-entry-gate");
  const b = viaStdin(other, f.cache, "session-entry-gate");
  const stateOf = (r) => /STATE=(.*)/.exec(r.stdout)[1].trim();
  const norm = (p) => p.split(String.fromCharCode(92)).join("/").toLowerCase();
  assert.equal(norm(stateOf(a)), norm(join(git(f.stale, "rev-parse", "--show-toplevel"), ".claude", "action-envelope-state")));
  assert.equal(norm(stateOf(b)), norm(join(git(other, "rev-parse", "--show-toplevel"), ".claude", "action-envelope-state")));
  assert.notEqual(norm(stateOf(a)), norm(stateOf(b)));
  assert.ok(!norm(stateOf(a)).startsWith(norm(f.cache)), "state is not inside the shared runner cache");
});
