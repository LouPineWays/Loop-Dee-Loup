// Issue #901: runner-authority handoff regression coverage (real Git fixtures).
// Run: node --test tools/orchestration/control-plane-continuation.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bindContinuationCommand, bindVerdictContinuation, unwrapBoundSegment } from "./control-plane-continuation.mjs";
import { getActionEnvelope } from "./action-envelope.mjs";
import { parseNextCommand } from "./launcher-run.mjs";
import { invokedGateScriptBasenames } from "./action-envelope-hook.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (n) => readFileSync(join(HERE, n), "utf8");
const BOOTSTRAP_SRC = src("control-plane-bootstrap.mjs");
const FRESHNESS_SRC = src("control-plane-freshness.mjs");
const CONTINUATION_SRC = src("control-plane-continuation.mjs");

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

const CANON = [
  "node tools/orchestration/evidence-correction.mjs prepare --repo o/r --audit-issue 881",
  "node tools/review-watch/trigger.mjs --repo o/r --kind issue --number 5",
].join(" && ");

// The fake gate mimics the real gates' CLI emission seam: bind, then print.
const GATE =
  `import { bindVerdictContinuation } from "./control-plane-continuation.mjs";\n` +
  `const v = { state: "STAGE2_EVIDENCE_REAUDIT_PREPARATION_REQUIRED", nextCommand: ${JSON.stringify(CANON)} };\n` +
  `console.log(JSON.stringify(bindVerdictContinuation(v)));\n`;

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "ldl-cont-"));
  const seed = join(base, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  write(seed, "tools/orchestration/evidence-correction.mjs", `console.log("STALE-PARSER");\n`);
  write(seed, "tools/review-watch/trigger.mjs", `console.log("STALE-TRIGGER");\n`);
  write(seed, "README.md", "x\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "c0");
  const origin = join(base, "origin.git");
  git(base, "clone", "-q", "--bare", seed, origin);
  const stale = join(base, "stale");
  git(base, "clone", "-q", origin, stale);
  write(
    seed,
    "tools/orchestration/evidence-correction.mjs",
    `console.log("CURRENT-PARSER args=" + process.argv.slice(2).join(",") + " stateDir=" + process.env.LDL_ACTION_ENVELOPE_STATE_DIR);\n`,
  );
  write(seed, "tools/review-watch/trigger.mjs", `console.log("CURRENT-TRIGGER args=" + process.argv.slice(2).join(","));\n`);
  write(seed, "tools/orchestration/session-entry-gate.mjs", GATE);
  write(seed, "tools/orchestration/control-plane-freshness.mjs", FRESHNESS_SRC);
  write(seed, "tools/orchestration/control-plane-bootstrap.mjs", BOOTSTRAP_SRC);
  write(seed, "tools/orchestration/control-plane-continuation.mjs", CONTINUATION_SRC);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "c1");
  git(seed, "push", "-q", origin, "main");
  return { base, seed, origin, stale, cache: join(base, "cache") };
}

const env = (cache) => ({ ...process.env, LDL_CONTROL_PLANE_RUNNER_CACHE: cache });
function runGateViaBootstrap(f, ...extra) {
  const r = spawnSync(process.execPath, ["-", ...extra, "session-entry-gate", "--control-issue", "780"], {
    cwd: f.stale,
    input: BOOTSTRAP_SRC,
    encoding: "utf8",
    env: env(f.cache),
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}
// Executes the verdict's continuation the way a controller/launcher would: each && segment, no shell.
function runContinuation(f, nextCommand) {
  return nextCommand.split(" && ").map((seg) => {
    const [, file, ...args] = seg.trim().split(/\s+/);
    return spawnSync(process.execPath, [file, ...args], { cwd: f.stale, encoding: "utf8", env: env(f.cache) });
  });
}
const snapshot = (cwd) =>
  [git(cwd, "rev-parse", "HEAD"), git(cwd, "status", "--porcelain", "--untracked-files=all"), git(cwd, "for-each-ref", "refs/heads", "refs/tags")].join("|");

test("exact #6001879290 shape: stale subject + bootstrapped gate; evidence-correction continuation runs CURRENT code, not the stale subject copy", () => {
  const f = fixture();
  writeFileSync(join(f.stale, "scratch.txt"), "user work\n");
  const before = snapshot(f.stale);
  const verdict = runGateViaBootstrap(f);
  assert.equal(verdict.continuationBound, true);
  // Control: the unbound relative command from the stale subject reproduces the stale parser.
  const relative = spawnSync(process.execPath, ["tools/orchestration/evidence-correction.mjs", "prepare"], { cwd: f.stale, encoding: "utf8" });
  assert.match(relative.stdout, /STALE-PARSER/);
  const [prep] = runContinuation(f, verdict.nextCommand);
  assert.equal(prep.status, 0, prep.stderr);
  assert.match(prep.stdout, /CURRENT-PARSER args=prepare,--repo,o\/r,--audit-issue,881/);
  assert.doesNotMatch(prep.stdout, /STALE/);
  assert.equal(snapshot(f.stale), before, "subject HEAD/index/refs/worktree untouched");
  assert.match(readFileSync(join(f.stale, "tools/orchestration/evidence-correction.mjs"), "utf8"), /STALE-PARSER/);
});

test("chained continuation: every control-plane command (orchestration and review-watch) executes from the runner", () => {
  const f = fixture();
  const verdict = runGateViaBootstrap(f);
  assert.equal(verdict.nextCommand.split(" && ").length, 2);
  const [a, b] = runContinuation(f, verdict.nextCommand);
  assert.match(a.stdout, /CURRENT-PARSER/);
  assert.match(b.stdout, /CURRENT-TRIGGER args=--repo,o\/r,--kind,issue,--number,5/);
});

test("subject-scoped action-envelope state dir: continuation points state at the subject checkout, not the runner cache", () => {
  const f = fixture();
  const verdict = runGateViaBootstrap(f);
  const [a] = runContinuation(f, verdict.nextCommand);
  const m = /stateDir=(\S+)/.exec(a.stdout);
  assert.ok(m);
  assert.equal(m[1].replace(/\\/g, "/"), join(f.stale, ".claude", "action-envelope-state").replace(/\\/g, "/"));
});

test("unavailable authority fails closed: bound continuation never falls back to stale checkout code", () => {
  const f = fixture();
  const verdict = runGateViaBootstrap(f);
  git(f.stale, "remote", "set-url", "origin", join(f.base, "missing.git"));
  const [a] = runContinuation(f, verdict.nextCommand);
  assert.notEqual(a.status, 0);
  assert.doesNotMatch(a.stdout, /STALE|CURRENT/);
  assert.match(a.stderr, /could not establish current control-plane authority/);
});

test("explicit checkout source leaves the continuation relative (the checkout is the authorized control plane)", () => {
  const f = fixture();
  git(f.stale, "pull", "-q", "origin", "main"); // checkout carries the gate under test
  const verdict = runGateViaBootstrap(f, "--control-plane-source", "checkout");
  assert.equal(verdict.nextCommand, CANON);
  assert.equal(verdict.continuationBound, undefined);
});

test("already-current checkout: no runner export and the continuation stays relative", () => {
  const f = fixture();
  git(f.stale, "pull", "-q", "origin", "main");
  const verdict = runGateViaBootstrap(f);
  assert.equal(verdict.nextCommand, CANON);
});

test("bindContinuationCommand: no runner env is a no-op; unauthenticated runner claim fails closed", () => {
  assert.deepEqual(bindContinuationCommand(CANON, { env: {} }), { ok: true, bound: false, command: CANON });
  const witness = JSON.stringify({ runnerCommit: "a".repeat(40) });
  const bad = bindContinuationCommand(CANON, { env: { LDL_CONTROL_PLANE_RUNNER: witness }, root: "/r/x", readMarker: () => "b".repeat(40) });
  assert.equal(bad.ok, false);
  const none = bindContinuationCommand(CANON, { env: { LDL_CONTROL_PLANE_RUNNER: witness }, root: "/r/x", readMarker: () => null });
  assert.equal(none.ok, false);
  assert.equal(bindContinuationCommand(CANON, { env: { LDL_CONTROL_PLANE_RUNNER: "{" }, root: "/r/x" }).ok, false);
  // verdict form withholds the executable command rather than emitting it unbound
  const v = bindVerdictContinuation(
    { state: "S", nextCommand: CANON, actionEnvelope: { mode: "bounded" } },
    { env: { LDL_CONTROL_PLANE_RUNNER: witness }, root: "/r/x", readMarker: () => null },
  );
  assert.equal(v.nextCommand, null);
  assert.ok(v.continuationBindingError);
  assert.deepEqual(v.actionEnvelope, { mode: "bounded" });
});

test("bindContinuationCommand: rewrites only control-plane script segments, is idempotent, refuses foreign segments and unsafe runner paths", () => {
  const sha = "c".repeat(40);
  const opts = { env: { LDL_CONTROL_PLANE_RUNNER: JSON.stringify({ runnerCommit: sha }) }, root: "C:\\cache\\" + sha, readMarker: () => sha };
  const r = bindContinuationCommand(CANON, opts);
  assert.equal(r.ok, true);
  assert.equal(r.command.split(" && ").length, 2);
  for (const seg of r.command.split(" && ")) assert.ok(unwrapBoundSegment(seg.split(/\s+/)));
  assert.match(r.command, /^node C:\/cache\/c+\/tools\/orchestration\/control-plane-bootstrap\.mjs tools\/orchestration\/evidence-correction\.mjs prepare/);
  assert.equal(bindContinuationCommand(r.command, opts).command, r.command);
  assert.equal(bindContinuationCommand("node tools/orchestration/a.mjs x && gh pr merge 5", opts).ok, false);
  assert.equal(bindContinuationCommand("node tools/../evil.mjs", opts).ok, false);
  assert.equal(bindContinuationCommand(CANON, { ...opts, root: "C:\\my cache\\" + sha }).ok, false);
});

test("action-envelope authority is identical for canonical and bound continuations (no broadening, no stopAfter bypass)", () => {
  const sha = "d".repeat(40);
  const opts = { env: { LDL_CONTROL_PLANE_RUNNER: JSON.stringify({ runnerCommit: sha }) }, root: "/cache/" + sha, readMarker: () => sha };
  const close = "node tools/review-watch/lifecycle-gate.mjs close-audit --repo o/r --audit-issue 9";
  const closeControl = `${close} && node tools/orchestration/close-control.mjs --repo o/r --control-issue 7`;
  for (const nc of [close, closeControl, "node tools/orchestration/finalize-pr-breakpoint.mjs --control-issue 7"]) {
    for (const state of ["STAGE2_CLOSE_READY", "STAGE2_REPORT_READY_TO_RECORD", "STAGE1_REVIEW_REQUESTED"]) {
      const canon = getActionEnvelope(state, { state, nextCommand: nc });
      const bound = getActionEnvelope(state, { state, nextCommand: bindContinuationCommand(nc, opts).command });
      assert.deepEqual(bound, canon, `${state} :: ${nc}`);
    }
  }
  // Negative control: binding a command never makes an extra, un-named segment authorized.
  const only = getActionEnvelope("STAGE2_CLOSE_READY", { state: "STAGE2_CLOSE_READY", nextCommand: bindContinuationCommand(close, opts).command });
  assert.ok(!only.authorizedActions.includes("run-close-control"));
});

test("launcher parseNextCommand and the live hook recognize bound segments as their canonical scripts", () => {
  const sha = "e".repeat(40);
  const opts = { env: { LDL_CONTROL_PLANE_RUNNER: JSON.stringify({ runnerCommit: sha }) }, root: "/cache/" + sha, readMarker: () => sha };
  const bound = bindContinuationCommand(CANON, opts).command;
  const segs = parseNextCommand(bound);
  assert.deepEqual(segs.map((s) => s.canonical), ["tools/orchestration/evidence-correction.mjs", "tools/review-watch/trigger.mjs"]);
  assert.deepEqual(segs[0].canonicalArgs, ["prepare", "--repo", "o/r", "--audit-issue", "881"]);
  assert.ok(segs[0].file.endsWith("control-plane-bootstrap.mjs"));
  assert.throws(() => parseNextCommand("node /x/control-plane-bootstrap.mjs tools/../evil.mjs"));
  const hookCmd = "node /cache/x/tools/orchestration/control-plane-bootstrap.mjs tools/orchestration/next-review-transition-gate.mjs --control-issue 1";
  assert.deepEqual(invokedGateScriptBasenames(hookCmd), ["next-review-transition-gate.mjs"]);
});

// PR #902 Stage 1 correction: runner-path grammar must be one end-to-end contract.
test("runner path containing '+' binds and is accepted by the launcher; genuinely unsafe paths fail closed", () => {
  const sha = "f".repeat(40);
  const mk = (root) => ({ env: { LDL_CONTROL_PLANE_RUNNER: JSON.stringify({ runnerCommit: sha }) }, root, readMarker: () => sha });
  const plus = bindContinuationCommand(CANON, mk("/c++/cache/" + sha));
  assert.equal(plus.bound, true);
  const segs = parseNextCommand(plus.command);
  assert.deepEqual(segs.map((s) => s.canonical), ["tools/orchestration/evidence-correction.mjs", "tools/review-watch/trigger.mjs"]);
  assert.deepEqual(segs[0].canonicalArgs, ["prepare", "--repo", "o/r", "--audit-issue", "881"]);
  assert.ok(segs[0].file.startsWith("/c++/cache/"));
  // '+' is NOT widened for ordinary command tokens.
  assert.throws(() => parseNextCommand("node tools/orchestration/x.mjs a+b"));
  assert.throws(() => parseNextCommand(`node /r/control-plane-bootstrap.mjs tools/orchestration/x.mjs a+b`));
  // Out-of-contract runner characters still fail closed at bind and at launcher.
  const bad = bindContinuationCommand(CANON, mk("/c ache;rm/" + sha));
  assert.equal(bad.ok, false);
  assert.throws(() => parseNextCommand("node /r;x/control-plane-bootstrap.mjs tools/orchestration/x.mjs"));
});

test("explicit checkout source: exact gate path forwards the same authority as the short name; other exact scripts do not", () => {
  const f = fixture();
  const echo = `console.log(JSON.stringify(process.argv.slice(2)));\n`;
  write(f.stale, "tools/orchestration/ready-dispatch-gate.mjs", echo);
  write(f.stale, "tools/orchestration/evidence-correction.mjs", echo);
  const run = (entry) => {
    const r = spawnSync(process.execPath, ["-", "--control-plane-source", "checkout", entry, "--control-issue", "780"], {
      cwd: f.stale,
      input: BOOTSTRAP_SRC,
      encoding: "utf8",
      env: env(f.cache),
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop());
  };
  const want = ["--control-issue", "780", "--control-plane-source", "checkout"];
  assert.deepEqual(run("ready-dispatch-gate"), want);
  assert.deepEqual(run("tools/orchestration/ready-dispatch-gate.mjs"), want);
  assert.deepEqual(run("tools/orchestration/evidence-correction.mjs"), ["--control-issue", "780"]);
});

test("malformed bound segments (prefixed/suffixed junk) are rejected by unwrap, binding, and launcher parsing (Stage 2 #903)", () => {
  const sha = "f".repeat(40);
  const env = { LDL_CONTROL_PLANE_RUNNER: JSON.stringify({ runnerCommit: sha }) };
  const good = `node /cache/${sha}/tools/orchestration/control-plane-bootstrap.mjs tools/orchestration/close-control.mjs --control-issue 7`;
  assert.ok(unwrapBoundSegment(good.split(/\s+/)));
  const prefixed = `junk ${good}`;
  assert.equal(unwrapBoundSegment(prefixed.split(/\s+/)), null);
  const r = bindContinuationCommand(prefixed, { env, root: `/cache/${sha}`, readMarker: () => sha });
  assert.equal(r.ok, false);
  assert.throws(() => parseNextCommand(prefixed));
  assert.throws(() => parseNextCommand(`${good} && ${prefixed}`));
  // Chained: one malformed segment poisons the whole continuation at bind time.
  assert.equal(bindContinuationCommand(`${good} && ${prefixed}`, { env, root: `/cache/${sha}`, readMarker: () => sha }).ok, false);
});
