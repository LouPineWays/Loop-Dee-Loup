#!/usr/bin/env node
// Control-plane runner freshness gate — issue #779 (control #780).
//
// Live reproduction (#438 / #768 / PR #771): a fresh-looking Dispatch checkout still carried the
// pre-#776 Stage 1 classifier, so a lifecycle gate run from it returned a domain verdict
// (`FINDINGS_LACK_FORMAL_REVIEW -> AMBIGUOUS`) that looked current although the default branch
// already held the #776 correction. `worktree-preflight.mjs` reconciles worktrees but never
// establishes that the code about to interpret durable lifecycle state is current.
//
// Two separate things are involved and this module never conflates them:
//   - the SUBJECT checkout/head (a PR's reviewed head) — never touched here; no rebase, merge,
//     checkout, reset, or worktree removal is ever performed; and
//   - the CONTROLLER/GATE revision — the code under tools/orchestration and tools/review-watch
//     that THIS checkout will execute to decide a lifecycle transition.
//
// Authorized runner sources (`--control-plane-source`):
//   - `default-branch` (default): the running checkout's control-plane code must not lag the
//     repository's remote default branch. Bounded `git fetch origin <default>` (single ref,
//     timeout-limited) establishes the authoritative ref; the checkout is STALE when the
//     default branch changed a control-plane path since the merge-base with HEAD (i.e. a newer
//     authoritative correction exists that HEAD does not contain). Non-control-plane drift is
//     irrelevant and never blocks (bounded, low-cost, no broad synchronization).
//   - `checkout`: explicit authorization to run this checkout's own control-plane code — the
//     legitimate case where an active control-plane PR itself modifies the gate. It skips the
//     staleness comparison (and the network) but still emits a witness naming the source, so the
//     choice is explicit and diagnosable rather than silently preferring old or new code.
//
// Fail closed: if the authoritative ref cannot be fetched/read (offline, auth failure, missing
// ref, no merge-base) the result is an operational freshness error (`UNVERIFIABLE`), never a
// domain lifecycle verdict.
//
// Recovery for STALE never requires touching the subject PR: run the gate from a current
// control-plane checkout (a detached worktree at the default branch; gates read durable state
// from GitHub, not the local subject checkout), or fast-forward a clean primary checkout.
//
// Usage: node tools/orchestration/control-plane-freshness.mjs [--control-plane-source <src>]
// Exit: 0 CURRENT / explicit checkout, 1 STALE or UNVERIFIABLE.
// Tests: node --test tools/orchestration/control-plane-freshness.test.mjs

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTROL_PLANE_RUNNER_PATHS = ["tools/orchestration", "tools/review-watch"];
export const SOURCES = ["default-branch", "checkout"];
const FETCH_TIMEOUT_MS = 20000;
const MAX_LISTED_PATHS = 10;

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function defaultGit(args, { cwd, timeout } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function recoveryInstruction(ref, subjectNote = true) {
  return (
    `Recovery: run the gate from a current control-plane checkout, e.g. ` +
    `\`git worktree add --detach <new-path> ${ref}\` then run the same gate command from ` +
    `<new-path> (gates read durable lifecycle state from GitHub, so the subject PR head is ` +
    `untouched${subjectNote ? "; do not rebase/merge the subject PR to obtain controller code" : ""}); ` +
    `a clean primary checkout on the default branch may instead run ` +
    `\`git merge --ff-only ${ref}\`. Only when this checkout's own control-plane code is the ` +
    `intentionally authorized runner (an active control-plane PR), re-run with ` +
    `\`--control-plane-source checkout\`.`
  );
}

// `git` is injectable for tests: (args, {cwd, timeout}) => stdout string, throws on failure.
export function checkControlPlaneFreshness({
  root = DEFAULT_ROOT,
  source = "default-branch",
  git = defaultGit,
  remote = "origin",
} = {}) {
  if (!SOURCES.includes(source)) {
    return {
      ok: false,
      exitCode: 1,
      state: "UNVERIFIABLE",
      message: `Unknown --control-plane-source "${source}" (expected one of: ${SOURCES.join(", ")}).`,
    };
  }

  let headCommit;
  try {
    headCommit = git(["rev-parse", "HEAD"], { cwd: root });
  } catch (err) {
    return unverifiable(source, `could not read HEAD of the running checkout: ${errText(err)}`, null);
  }

  if (source === "checkout") {
    return {
      ok: true,
      exitCode: 0,
      state: "CURRENT",
      witness: { source: "checkout-explicit", headCommit, defaultBranchRef: null, defaultBranchCommit: null },
    };
  }

  let branch = "main";
  try {
    const head = git(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], { cwd: root });
    if (head.startsWith(`${remote}/`)) branch = head.slice(remote.length + 1);
  } catch {
    // No cached remote HEAD symref: fall back to "main" and let the fetch/ref read fail closed.
  }
  const ref = `${remote}/${branch}`;

  try {
    git(["fetch", "--quiet", remote, branch], { cwd: root, timeout: FETCH_TIMEOUT_MS });
  } catch (err) {
    return unverifiable(source, `could not fetch ${ref}: ${errText(err)}`, ref, headCommit);
  }

  let defaultCommit;
  let mergeBase;
  let changed;
  try {
    defaultCommit = git(["rev-parse", `refs/remotes/${ref}`], { cwd: root });
    mergeBase = git(["merge-base", "HEAD", `refs/remotes/${ref}`], { cwd: root });
    const out = git(
      ["diff", "--name-only", mergeBase, defaultCommit, "--", ...CONTROL_PLANE_RUNNER_PATHS],
      { cwd: root },
    );
    changed = out ? out.split(/\r?\n/).filter(Boolean) : [];
  } catch (err) {
    return unverifiable(source, `could not compare HEAD against ${ref}: ${errText(err)}`, ref, headCommit);
  }

  const witness = {
    source: "default-branch",
    headCommit,
    defaultBranchRef: ref,
    defaultBranchCommit: defaultCommit,
    mergeBase,
  };

  if (changed.length > 0) {
    const listed = changed.slice(0, MAX_LISTED_PATHS).join(", ");
    const more = changed.length > MAX_LISTED_PATHS ? ` (+${changed.length - MAX_LISTED_PATHS} more)` : "";
    return {
      ok: false,
      exitCode: 1,
      state: "STALE",
      witness,
      stalePaths: changed,
      message:
        `Stale control-plane runner: ${ref} (${defaultCommit.slice(0, 12)}) changed ` +
        `${changed.length} control-plane path(s) not contained in this checkout's HEAD ` +
        `(${headCommit.slice(0, 12)}): ${listed}${more}. A lifecycle verdict from this code ` +
        `must not be treated as current. ${recoveryInstruction(ref)}`,
    };
  }

  return { ok: true, exitCode: 0, state: "CURRENT", witness };
}

function errText(err) {
  const s = (err?.stderr ? String(err.stderr) : err?.message ?? String(err)).trim();
  return s.split(/\r?\n/)[0].slice(0, 200);
}

function unverifiable(source, reason, ref, headCommit = null) {
  return {
    ok: false,
    exitCode: 1,
    state: "UNVERIFIABLE",
    witness: { source, headCommit, defaultBranchRef: ref, defaultBranchCommit: null },
    message:
      `Control-plane freshness could not be verified (operational error, not a lifecycle ` +
      `verdict): ${reason}. Restore access to the remote default branch (network/auth/ref) and ` +
      `retry; or, only if this checkout's own control-plane code is the intentionally ` +
      `authorized runner, re-run with \`--control-plane-source checkout\`.`,
  };
}

// CLI helper for gate entrypoints: prints the error and exits 1 unless the runner is current or
// explicitly authorized. Returns the witness on success.
export function enforceControlPlaneFreshness(argv = process.argv.slice(2), opts = {}) {
  const idx = argv.indexOf("--control-plane-source");
  const source = idx >= 0 ? argv[idx + 1] : "default-branch";
  const result = checkControlPlaneFreshness({ ...opts, source });
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  return result.witness;
}

if (process.argv[1] && process.argv[1].endsWith("control-plane-freshness.mjs")) {
  const idx = process.argv.indexOf("--control-plane-source");
  const result = checkControlPlaneFreshness({
    source: idx >= 0 ? process.argv[idx + 1] : "default-branch",
  });
  if (result.ok) console.log(JSON.stringify(result));
  else console.error(result.message);
  process.exit(result.exitCode);
}
