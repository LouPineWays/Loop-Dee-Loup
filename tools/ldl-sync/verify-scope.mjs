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
import { pathToFileURL } from "node:url";

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
// filesystem. Every changed path under `.ldl/` is always allowed, not just `.ldl/manifest.json`:
// that whole directory is LDL's own reserved namespace (see docs/consumer-contract.md), and
// tools/ldl-update legitimately deletes a superseded bridge template (.ldl/AGENTS.template.md or
// .ldl/CLAUDE.template.md) — dropping it from the *new* manifest's own files[] list entirely —
// whenever a consumer-owned AGENTS.md/CLAUDE.md that used to force parking is removed or starts
// matching content again. Checking that deletion against `managedPaths` (which, by construction,
// never lists a path this update just stopped managing) would wrongly flag a fully valid update
// as an unexpected change and refuse to proceed. Every other changed path must still appear in
// `managedPaths` (the *new* manifest's own `files[].dest` list, i.e. what the update itself
// claims it manages) to be accepted.
export function findUnexpectedPaths(changedPaths, managedPaths, { settingsChangeIsCanonicalHookOnly = false } = {}) {
  const allowed = new Set(managedPaths);
  return changedPaths.filter(
    (p) =>
      !allowed.has(p) &&
      p !== ".ldl/manifest.json" &&
      !p.startsWith(".ldl/") &&
      !(p === SETTINGS_PATH && settingsChangeIsCanonicalHookOnly),
  );
}

// Issue #799 Stage 1 correction: .claude/settings.json is consumer-owned, never LDL-managed, yet
// tools/ldl-update legitimately merges exactly one entry into it -- the canonical PreToolUse Bash
// hook for the raw thin-control body-write guard. That single controlled mutation is accepted
// here, and ONLY here: the file's after-state must equal its before-state plus that one canonical
// entry (any other key/hook change, or a differently shaped entry, is still unexpected). The
// command string intentionally duplicates tools/ldl-init's ENFORCEMENT_HOOK_COMMAND (this file is
// installed into consumers that may lack tools/ldl-init); a test pins the two together.
export const SETTINGS_PATH = ".claude/settings.json";
export const CANONICAL_HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/tools/orchestration/control-body-write-guard.mjs"';

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isCanonicalEntry = (e) =>
  isPlainObject(e) &&
  e.matcher === "Bash" &&
  Array.isArray(e.hooks) &&
  e.hooks.length === 1 &&
  isPlainObject(e.hooks[0]) &&
  e.hooks[0].type === "command" &&
  e.hooks[0].command === CANONICAL_HOOK_COMMAND &&
  Object.keys(e).length === 2 &&
  Object.keys(e.hooks[0]).length === 2;

// before/after are parsed JSON values (before === null when the file did not exist at HEAD).
export function isCanonicalHookOnlyChange(before, after) {
  if (before !== null && !isPlainObject(before)) return false;
  if (!isPlainObject(after)) return false;
  const base = before === null ? {} : before;
  const pre = after.hooks?.PreToolUse;
  if (!isPlainObject(after.hooks) || !Array.isArray(pre)) return false;
  const idx = pre.findIndex(isCanonicalEntry);
  if (idx === -1) return false;
  const rest = pre.filter((_, i) => i !== idx);
  const stripped = { ...after, hooks: { ...after.hooks } };
  if (rest.length > 0 || base.hooks?.PreToolUse !== undefined) stripped.hooks.PreToolUse = rest;
  else delete stripped.hooks.PreToolUse;
  if (Object.keys(stripped.hooks).length === 0 && base.hooks === undefined) delete stripped.hooks;
  return JSON.stringify(sortKeys(stripped)) === JSON.stringify(sortKeys(base));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isPlainObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

function defaultReadSettingsPair(dest) {
  let before = null;
  try {
    before = JSON.parse(execFileSync("git", ["-C", dest, "show", `HEAD:${SETTINGS_PATH}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    before = null; // absent at HEAD (or unparseable): treated as an empty object only if absent
  }
  const after = JSON.parse(readFileSync(join(dest, ".claude", "settings.json"), "utf8"));
  return { before, after };
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
  const { gitChangedPathsImpl = defaultGitChangedPaths, readFileImpl = readFileSync, readSettingsPairImpl = defaultReadSettingsPair } = deps;
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

  let settingsChangeIsCanonicalHookOnly = false;
  if (changedPaths.includes(SETTINGS_PATH)) {
    try {
      const { before, after } = readSettingsPairImpl(dest);
      settingsChangeIsCanonicalHookOnly = isCanonicalHookOnlyChange(before, after);
    } catch {
      settingsChangeIsCanonicalHookOnly = false; // fail closed
    }
  }
  const unexpected = findUnexpectedPaths(changedPaths, managedPaths, { settingsChangeIsCanonicalHookOnly });
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

// Only run as a CLI when this exact file is the process entrypoint, not merely when some
// other script's argv[1] happens to end in "verify-scope.mjs" (Stage 1 review finding on PR
// #219) — matching the same exact-identity guard tools/ldl-init/index.mjs and
// tools/ldl-update/index.mjs already use.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
