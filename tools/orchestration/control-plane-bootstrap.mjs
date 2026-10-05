#!/usr/bin/env node
// Control-plane bootstrap — issue #877 (control #780; follow-up to #779 / PR #782).
//
// Live recurrence (2026-10-03, `work on #571`): a remote session selected branch `main`, yet the
// checkout's control-plane code still held the superseded PR #865 global `search/issues` path
// although origin/main already carried PR #871's repository-scoped replacement. #779's freshness
// check lives INSIDE the checkout-local gates, so a checkout old enough not to contain (or not to
// execute) it can never establish its own staleness. A branch named `main` is not freshness
// evidence.
//
// This script is the bootstrap boundary. It is deliberately dependency-free (node builtins only,
// no import of any other checkout file) so it can be executed from the authoritative default
// branch WITHOUT trusting the checkout it is about to supersede:
//
//   git fetch origin <default> && git show origin/<default>:tools/orchestration/control-plane-bootstrap.mjs \
//     | node - session-entry-gate --control-issue <N>
//
// or, in any checkout that already carries it (every checkout from this change onward):
//
//   node tools/orchestration/control-plane-bootstrap.mjs session-entry-gate --control-issue <N>
//
// Behavior (default `--control-plane-source default-branch`):
//   1. One bounded `git ls-remote --symref origin HEAD` establishes the remote default branch and
//      its authoritative commit; one bounded `git fetch origin <default>` makes the objects local.
//      Any failure is an operational error (exit 1) BEFORE any gate runs — never a lifecycle
//      verdict. One recovery instruction is emitted.
//   2. If the subject checkout's HEAD already contains that commit and its control-plane paths
//      are clean, the checkout-local gate runs unchanged (it re-verifies through #779's
//      control-plane-freshness.mjs, which stays the authoritative ordinary stale/current check).
//   3. Otherwise (stale / diverged / dirty / lacking the gate) the control-plane tree of the
//      authoritative commit is exported into a cache directory OUTSIDE the subject checkout using
//      a throwaway index (`GIT_INDEX_FILE` + `checkout-index`); the subject's HEAD, index, refs
//      and working tree are never read-modified. The gate is then executed from that runner with
//      cwd = the subject checkout (gates derive repository identity and read durable state from
//      there/GitHub). The runner's freshness check accepts the bootstrap witness (see
//      control-plane-freshness.mjs `LDL_CONTROL_PLANE_RUNNER`).
//
// `--control-plane-source checkout` is the explicit authorization to run this checkout's own
// control-plane code (an active control-plane PR). It skips the network, runs the checkout-local
// gate, and forwards the flag so the gate's own witness records the choice.
//
// Never rebases, merges, resets, cleans, checks out, or removes anything in the subject checkout.
//
// Usage: node control-plane-bootstrap.mjs [--control-plane-source default-branch|checkout] <gate> [gate args...]
// Tests: node --test tools/orchestration/control-plane-bootstrap.test.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNNER_MARKER = ".ldl-control-plane-runner";
export const RUNNER_ENV = "LDL_CONTROL_PLANE_RUNNER";
// Set (to the authoritative commit) on the re-executed default-branch bootstrap so it never
// converges again: exactly one hop, no loop.
export const CONVERGED_ENV = "LDL_CONTROL_PLANE_BOOTSTRAP_CONVERGED";
export const STATE_DIR_ENV = "LDL_ACTION_ENVELOPE_STATE_DIR";
const BOOTSTRAP_PATH = "tools/orchestration/control-plane-bootstrap.mjs";
const CONTROL_PLANE_PATHS = ["tools/orchestration", "tools/review-watch"];
const NETWORK_TIMEOUT_MS = 20000;
const GATE_NAME = /^[a-z0-9][a-z0-9-]*$/;
// Issue #901: a machine-authored continuation re-enters through this bootstrap naming the exact
// control-plane script (`tools/orchestration/x.mjs` | `tools/review-watch/x.mjs`) instead of a gate.
const SCRIPT_PATH = /^tools\/(?:orchestration|review-watch)\/[A-Za-z0-9_.-]+\.mjs$/;
export function resolveScriptRel(gate) {
  if (GATE_NAME.test(gate)) return `tools/orchestration/${gate}.mjs`;
  if (SCRIPT_PATH.test(gate) && !gate.includes("..")) return gate;
  return null;
}

function defaultGit(args, { cwd, timeout, env, raw } = {}) {
  const out = execFileSync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return raw ? out : out.trim();
}

function errText(err) {
  const s = (err?.stderr ? String(err.stderr) : err?.message ?? String(err)).trim();
  return s.split(/\r?\n/)[0].slice(0, 200);
}

function fail(reason, extra = {}) {
  return {
    ok: false,
    exitCode: 1,
    state: "UNVERIFIABLE",
    message:
      `Control-plane bootstrap could not establish current control-plane authority (operational ` +
      `error, not a lifecycle verdict; no gate was run): ${reason}. Restore access to the remote ` +
      `default branch (network/auth/ref) and retry; or, only if this checkout's own control-plane ` +
      `code is the intentionally authorized runner (an active control-plane PR), re-run with ` +
      `\`--control-plane-source checkout\`.`,
    ...extra,
  };
}

export function parseBootstrapArgs(argv) {
  let source = "default-branch";
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--control-plane-source") {
      source = argv[++i];
    } else {
      rest.push(argv[i]);
    }
  }
  const [gate, ...gateArgs] = rest;
  return { source, gate, gateArgs };
}

// Resolves the plan without running anything. `git` is injectable: (args, {cwd, timeout, env}).
// Returns {ok:true, mode:"local"|"runner", ...} or {ok:false, ...}.
export function planBootstrap({ cwd = process.cwd(), source = "default-branch", git = defaultGit, remote = "origin" } = {}) {
  if (source !== "default-branch" && source !== "checkout") {
    return fail(`unknown --control-plane-source "${source}" (expected default-branch or checkout)`);
  }
  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"], { cwd });
  } catch (err) {
    return fail(`not inside a git checkout: ${errText(err)}`);
  }
  if (source === "checkout") return { ok: true, mode: "local", source: "checkout-explicit", root };

  let headCommit;
  let dirty;
  try {
    headCommit = git(["rev-parse", "HEAD"], { cwd: root });
    dirty = git(
      ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--", ...CONTROL_PLANE_PATHS],
      { cwd: root },
    )
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (err) {
    return fail(`could not read the running checkout: ${errText(err)}`);
  }

  let branch;
  let defaultCommit;
  try {
    const out = git(["ls-remote", "--symref", remote, "HEAD"], { cwd: root, timeout: NETWORK_TIMEOUT_MS });
    const sym = /^ref:\s+refs\/heads\/(\S+)\s+HEAD\s*$/m.exec(out);
    const sha = /^([0-9a-f]{40,64})\s+HEAD\s*$/m.exec(out);
    if (!sym || !sha) throw new Error("remote did not report a default branch symref and commit");
    branch = sym[1];
    defaultCommit = sha[1];
  } catch (err) {
    return fail(`could not determine the default branch of ${remote}: ${errText(err)}`);
  }
  const ref = `${remote}/${branch}`;
  try {
    git(["fetch", "--quiet", remote, branch], { cwd: root, timeout: NETWORK_TIMEOUT_MS });
    git(["cat-file", "-e", `${defaultCommit}^{commit}`], { cwd: root });
  } catch (err) {
    return fail(`could not fetch ${ref}: ${errText(err)}`);
  }

  let containsDefault = false;
  try {
    git(["merge-base", "--is-ancestor", defaultCommit, headCommit], { cwd: root });
    containsDefault = true;
  } catch {
    containsDefault = false; // exit 1 = not an ancestor; any other failure (shallow) also fails safe
  }

  const witness = { source: "bootstrap-default-branch", subjectHead: headCommit, defaultBranchRef: ref, defaultBranchCommit: defaultCommit };
  if (containsDefault && dirty.length === 0) {
    return { ok: true, mode: "local", source: "default-branch", root, witness };
  }
  return {
    ok: true,
    mode: "runner",
    source: "default-branch",
    root,
    runnerCommit: defaultCommit,
    witness,
    reason: dirty.length > 0 && containsDefault ? "dirty-control-plane" : "stale-or-diverged",
  };
}

// The marker file only names a commit; it is cache metadata, not proof of cache contents. Before a
// cached (or freshly exported) runner may execute anything, the TRUSTED bootstrap itself proves its
// control-plane files are byte-for-byte the authoritative commit's tree (blob hashes from git
// objects, no extra files). Never delegates this to code inside the runner being authenticated.
export function runnerTreeAuthentic(dir, commit, { root, git = defaultGit } = {}) {
  try {
    const marker = join(dir, RUNNER_MARKER);
    if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== commit) return false;
    const algo = commit.length === 64 ? "sha256" : "sha1";
    const expected = new Map();
    const listing = git(["ls-tree", "-r", commit, "--", ...CONTROL_PLANE_PATHS], { cwd: root });
    for (const line of listing.split(/\r?\n/).filter(Boolean)) {
      const m = /^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(line);
      if (m) expected.set(m[3], m[2]);
    }
    if (expected.size === 0) return false;
    const actual = new Set();
    const walk = (rel) => {
      for (const ent of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const r = rel + "/" + ent.name;
        if (ent.isDirectory()) walk(r);
        else actual.add(r);
      }
    };
    for (const p of CONTROL_PLANE_PATHS) if (existsSync(join(dir, p))) walk(p);
    if (actual.size !== expected.size) return false;
    for (const [path, oid] of expected) {
      if (!actual.has(path)) return false;
      const body = readFileSync(join(dir, path));
      if (createHash(algo).update("blob " + body.length + "\0").update(body).digest("hex") !== oid) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Exports the authoritative commit's tree into <cacheDir>/<sha> without touching the subject
// checkout's HEAD/index/working tree. A cache entry is reused only after authentication; an entry
// that cannot be authenticated is discarded and rematerialized. Atomic via rename.
export function materializeRunner({ root, commit, cacheDir = process.env.LDL_CONTROL_PLANE_RUNNER_CACHE || join(tmpdir(), "ldl-control-plane-runners"), git = defaultGit }) {
  const finalDir = join(cacheDir, commit);
  if (existsSync(finalDir)) {
    if (runnerTreeAuthentic(finalDir, commit, { root, git })) return finalDir;
    rmSync(finalDir, { recursive: true, force: true });
  }

  mkdirSync(cacheDir, { recursive: true });
  const stage = join(cacheDir, `${commit}.tmp-${process.pid}-${Date.now()}`);
  const indexFile = `${stage}.index`;
  try {
    mkdirSync(stage, { recursive: true });
    git(["read-tree", commit], { cwd: root, env: { GIT_INDEX_FILE: indexFile } });
    // Byte-exact export (no autocrlf/eol conversion): authentication verifies blob hashes.
    git(["-c", "core.autocrlf=false", "-c", "core.eol=lf", "checkout-index", "-a", "-f", `--prefix=${stage.replace(/\\/g, "/")}/`], {
      cwd: root,
      env: { GIT_INDEX_FILE: indexFile },
    });
    writeFileSync(join(stage, RUNNER_MARKER), `${commit}\n`);
    if (!runnerTreeAuthentic(stage, commit, { root, git })) throw new Error("exported runner tree does not match the authoritative commit");
    try {
      renameSync(stage, finalDir);
    } catch (err) {
      // A concurrent bootstrap won the race; accept its copy only if authentic.
      if (!runnerTreeAuthentic(finalDir, commit, { root, git })) throw err;
    }
  } finally {
    rmSync(indexFile, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
  return finalDir;
}

function ownSource() {
  try {
    return readFileSync(fileURLToPath(import.meta.url), "utf8");
  } catch {
    return null; // e.g. piped via `node -`: provenance unknown, so converge
  }
}

// The running bootstrap is itself checkout-local code (or whatever copy was piped in). Before it
// runs any gate it must defer to the selected default-branch revision's bootstrap: if that differs
// from (or cannot be compared with) the running one, re-execute the authoritative copy once.
// Returns the child's exit status, or null when no re-execution is needed.
export function convergeBootstrap(plan, argv, { git = defaultGit, spawn = spawnSync, env = process.env, own = ownSource, log = () => {} } = {}) {
  if (plan.source !== "default-branch" || env[CONVERGED_ENV]) return null;
  const commit = plan.witness.defaultBranchCommit;
  let authoritative;
  try {
    authoritative = git(["show", `${commit}:${BOOTSTRAP_PATH}`], { cwd: plan.root, raw: true });
  } catch (err) {
    // Missing/unreadable authoritative bootstrap is unverifiable authority: fail closed, never
    // continue with the older running bootstrap.
    log(fail(`${plan.witness.defaultBranchRef} has no readable ${BOOTSTRAP_PATH}: ${errText(err)}`).message);
    return 1;
  }
  if (own() === authoritative) return null;
  if (!sourceParses(authoritative, spawn)) {
    log(fail(`${plan.witness.defaultBranchRef} ${BOOTSTRAP_PATH} is not executable JavaScript`).message);
    return 1;
  }
  log(`control-plane bootstrap: deferring to ${plan.witness.defaultBranchRef}@${commit.slice(0, 12)} bootstrap.`);
  const res = spawn(process.execPath, ["-", ...argv], {
    cwd: plan.root,
    input: authoritative,
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...env, [CONVERGED_ENV]: commit },
  });
  return res.status ?? 1;
}

// `node --check` needs a real .mjs file (stdin is treated as CommonJS), so stage the text in a
// private temp directory first.
function sourceParses(text, spawn) {
  const dir = mkdtempSync(join(tmpdir(), "ldl-bootstrap-check-"));
  try {
    const file = join(dir, "candidate.mjs");
    writeFileSync(file, text);
    return gateParses(file, spawn);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function gateParses(script, spawn) {
  return spawn(process.execPath, ["--check", script], { encoding: "utf8" }).status === 0;
}

export function runBootstrap(argv, { cwd = process.cwd(), git = defaultGit, spawn = spawnSync, cacheDir, log = (m) => console.error(m), own } = {}) {
  const { source, gate, gateArgs } = parseBootstrapArgs(argv);
  const scriptRel = gate ? resolveScriptRel(gate) : null;
  if (!scriptRel) {
    log("Usage: control-plane-bootstrap.mjs [--control-plane-source default-branch|checkout] <gate-name|tools/<orchestration|review-watch>/script.mjs> [args...]");
    return 2;
  }
  const plan = planBootstrap({ cwd, source, git });
  if (!plan.ok) {
    log(plan.message);
    return plan.exitCode;
  }

  const converged = convergeBootstrap(plan, argv, { git, spawn, own, log });
  if (converged !== null) return converged;

  let script;
  let args = gateArgs;
  let env = process.env;
  if (plan.mode === "local") {
    script = join(plan.root, ...scriptRel.split("/"));
    if (plan.source === "checkout-explicit" && GATE_NAME.test(gate)) args = [...gateArgs, "--control-plane-source", "checkout"];
    if (!existsSync(script)) {
      log(fail(`${scriptRel} does not exist in this checkout`).message);
      return 1;
    }
    if (!gateParses(script, spawn)) {
      log(fail(`${scriptRel} in this checkout is not executable JavaScript`).message);
      return 1;
    }
  } else {
    let runnerDir;
    try {
      runnerDir = materializeRunner({ root: plan.root, commit: plan.runnerCommit, cacheDir, git });
    } catch (err) {
      log(fail(`could not export the control-plane runner for ${plan.witness.defaultBranchRef}: ${errText(err)}`).message);
      return 1;
    }
    script = join(runnerDir, ...scriptRel.split("/"));
    if (!existsSync(script)) {
      log(fail(`${scriptRel} does not exist in ${plan.witness.defaultBranchRef}`).message);
      return 1;
    }
    if (!gateParses(script, spawn)) {
      log(fail(`${scriptRel} in ${plan.witness.defaultBranchRef} is not executable JavaScript`).message);
      return 1;
    }
    // Verdict-handoff/action-envelope state belongs to the SUBJECT checkout (the one whose hooks
    // consume it), never to the shared runner cache a runner's module-relative root implies.
    env = {
      ...process.env,
      [RUNNER_ENV]: JSON.stringify({ ...plan.witness, runnerCommit: plan.runnerCommit }),
      [STATE_DIR_ENV]: process.env[STATE_DIR_ENV] || join(plan.root, ".claude", "action-envelope-state"),
    };
    log(
      `control-plane bootstrap: running ${scriptRel} from ${plan.witness.defaultBranchRef}@${plan.runnerCommit.slice(0, 12)} ` +
        `(checkout HEAD ${plan.witness.subjectHead.slice(0, 12)}: ${plan.reason}); subject checkout untouched.`,
    );
  }
  const res = spawn(process.execPath, [script, ...args], { cwd: plan.root, stdio: "inherit", env });
  return res.status ?? 1;
}

if (!process.argv[1] || process.argv[1] === "-" || basename(process.argv[1]) === "control-plane-bootstrap.mjs") {
  process.exit(runBootstrap(process.argv.slice(2)));
}
