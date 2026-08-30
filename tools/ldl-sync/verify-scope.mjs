#!/usr/bin/env node
// Defense-in-depth scope check for an unattended LDL Sync workflow (issue #217; the pattern
// this script supports is documented in docs/consumer-contract.md, "Automated consumer sync").
// tools/ldl-update (in a Loop-Dee-Loup checkout) already guarantees it only ever writes
// LDL-managed paths or refuses the whole run — see docs/consumer-contract.md, "Conflict-safe
// updates". This script re-checks that guarantee from the consumer side, after the fact,
// against the actual git diff it produced: with no human watching the automation, a workflow
// bug (wrong --dest, a stray untracked file, a future ldl-update regression) should stop the
// run before it opens a PR, rather than being trusted silently.
//
// Usage: node tools/ldl-sync/verify-scope.mjs [--dest <path>]
// --dest defaults to the current working directory and must be a git worktree that has
// already had `tools/ldl-update` run against it (uncommitted changes still on disk).
//
// Exit codes: 0 = every changed path is accounted for, 1 = an unexpected path was found, or
// the manifest/git state couldn't be read.
//
// Tests: node --test tools/ldl-sync/verify-scope.test.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function parseArgs(argv) {
  const args = { dest: "." };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    args[a.slice(2)] = argv[++i];
  }
  return args;
}

// Pure — no I/O — so tests can exercise the actual scope rule without touching git or the
// filesystem. `.ldl/manifest.json` is always allowed since a real tools/ldl-update change
// always rewrites it; every other changed path must appear in `managedPaths` (the *new*
// manifest's own `files[].dest` list, i.e. what the update itself claims it manages) to be
// accepted.
export function findUnexpectedPaths(changedPaths, managedPaths) {
  const allowed = new Set(managedPaths);
  allowed.add(".ldl/manifest.json");
  return changedPaths.filter((p) => !allowed.has(p));
}

// `git status --porcelain=v1` lines are two status columns, one space, then the path (column
// 4 onward) — a rename is reported as "old -> new". Slicing at a fixed offset instead of
// splitting on whitespace is what keeps this correct for paths that themselves contain
// spaces. `--untracked-files=all` is required, not just the default: an LDL revision that adds
// a managed file under a directory this repo has never had collapses to a single "?? dir/"
// entry otherwise, which would never match any individual path in `managedPaths` and would
// wrongly flag a legitimate new managed file as an unexpected change.
function defaultGitChangedPaths(dest) {
  const raw = execFileSync("git", ["-C", dest, "status", "--porcelain=v1", "--untracked-files=all"], {
    encoding: "utf8",
  });
  return raw
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3);
      const arrowIdx = path.indexOf(" -> ");
      return arrowIdx === -1 ? path : path.slice(arrowIdx + 4);
    });
}

export function run(args, deps = {}) {
  const { gitChangedPathsImpl = defaultGitChangedPaths, readFileImpl = readFileSync } = deps;
  const dest = args.dest || ".";
  const manifestPath = join(dest, ".ldl", "manifest.json");

  let manifest;
  try {
    manifest = JSON.parse(readFileImpl(manifestPath, "utf8"));
  } catch (err) {
    return { exitCode: 1, message: `failed reading ${manifestPath}: ${err.message}` };
  }
  const managedPaths = (manifest.files || []).map((f) => f.dest);

  let changedPaths;
  try {
    changedPaths = gitChangedPathsImpl(dest);
  } catch (err) {
    return { exitCode: 1, message: `failed reading git status for ${dest}: ${err.message}` };
  }

  const unexpected = findUnexpectedPaths(changedPaths, managedPaths);
  if (unexpected.length > 0) {
    return {
      exitCode: 1,
      message: `Refusing to proceed: ${unexpected.length} changed path(s) outside the LDL-managed set: ${unexpected.join(", ")}`,
    };
  }
  return { exitCode: 0, message: JSON.stringify({ ok: true, changed: changedPaths.length }) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = run(args);
  if (result.exitCode === 0) {
    console.log(result.message);
  } else {
    console.error(result.message);
  }
  process.exit(result.exitCode);
}

// Only run as a CLI when invoked directly (`node tools/ldl-sync/verify-scope.mjs ...`), not
// when the test file imports these functions.
if (process.argv[1] && process.argv[1].endsWith("verify-scope.mjs")) {
  main();
}
