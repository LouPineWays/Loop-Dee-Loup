#!/usr/bin/env node
// Deterministic classification for a reported stale/unusable exact-primary-path Dispatch lock --
// issue #685 (execution slice for control #442).
//
// Problem this closes: #441/#442 established that exactly one live Claude Code session or
// process owns an exact directory path at a time, and that a second launch at that same path
// fails closed as a deterministic path lock -- never global/repo-wide Dispatch-capacity
// exhaustion (docs/operating-model.md § Concurrent subagent directory isolation). The
// 2026-09-21 reproduction on #442 went further: Dispatch reported the repository's primary
// checkout path (`C:\Loop-Dee-Loup`) as still locked while `git status`/`git worktree` proved
// the repository itself was perfectly healthy, and no founder-visible session appeared to
// explain the lock -- only terminating Claude in Task Manager and reopening Dispatch released
// it. A founder working remotely has no Task Manager to reach. See
// docs/operating-model.md § Stale Dispatch path-lock recovery for the full recovery procedure
// this script's verdict feeds into.
//
// Scope: this script does NOT call any CCD session-management MCP tool itself -- there is no
// programmatic/CLI surface for `list_sessions`/`get_session`/`archive_session`; those exist only
// as MCP tools a live Claude Code session can invoke directly. Recovery therefore cannot be a
// fully self-contained script the way `worktree-preflight.mjs` is for git-only state -- the
// actual mutation (archiving a stale session) has to be performed by the live session itself.
// What CAN be made deterministic, testable, and reviewable is the judgment of *which* session
// (if any) is safe to archive, given session snapshots the live session has already fetched.
// That judgment is this script: a pure decision function plus a thin CLI wrapper, mirroring the
// pure-decision-plus-CLI shape every other script in this directory already uses
// (`worktree-preflight.mjs`, `reconcile-control-blocker.mjs`, etc.), so the recovery procedure
// is not re-derived by eye each time it is needed.
//
// Usage:
//   node tools/orchestration/classify-primary-path-lock.mjs --primary-path <path> --sessions-json <file|->
//
// `--sessions-json` is a JSON array of session snapshots the caller has already assembled from
// `list_sessions` (for the candidate session IDs) plus `get_session` (for each candidate's own
// reported worktree/cwd path -- `list_sessions` itself does not expose it), each shaped:
//
//   { "sessionId": "<id>", "path": "<its reported worktree/cwd path>" | null,
//     "pinned": true|false, "remoteControlActive": true|false, "archived": true|false }
//
// `path` is `null` (or the field omitted) when the caller could not determine it -- an unknown
// path NEVER matches the primary path, so an unidentifiable session is never treated as a
// candidate to archive, matching this repository's existing fail-closed-on-unknown-evidence
// convention (`worktree-preflight.mjs`'s own `isDurablyObsolete`). `archived` defaults to `false`
// when omitted. `pinned`/`remoteControlActive` do NOT default to `false` when omitted: archival
// eligibility requires each to be explicitly and positively known to be `false`. An omitted,
// `null`, or otherwise non-boolean value is unknown protection state, not "unprotected" --
// unknown evidence must never authorize a destructive/releasing action (Stage 1 review on PR
// #690: the prior omitted-defaults-to-false contract let incomplete evidence produce
// ARCHIVE_CANDIDATE).
//
// Verdicts:
//
//   ARCHIVE_CANDIDATE  -- exactly one non-archived session reports a path exactly equal to
//                         --primary-path under this path's own comparison semantics (see
//                         `normalizePathForComparison` below), and that session's `pinned` and
//                         `remoteControlActive` fields are BOTH explicitly `false` -- not merely
//                         omitted or falsy. Safe to call `archive_session` against. This is not
//                         the *only* safety check: `archive_session` itself additionally and
//                         independently refuses a session that is still mid-turn or has live
//                         background work ("A session that is still working ... is not archived
//                         and the call says so"), so this classification composes with, rather
//                         than replaces, that built-in liveness guard.
//   PROTECTED_OWNER    -- a matching session exists but is pinned or remote-control-active, OR
//                         either field's protection state is not explicitly known (omitted,
//                         `null`, or any non-boolean value). Never archive it regardless of how
//                         "stale" it otherwise looks -- a remote-control-active session in
//                         particular may be a founder actively driving it through a
//                         phone/claude.ai bridge right now, and unknown protection state is
//                         indistinguishable from that case until proven otherwise.
//   AMBIGUOUS          -- more than one non-archived session reports the primary path. Ordering
//                         or recency alone never resolves this; it fails closed to no action,
//                         matching this repository's existing ambiguous-state convention (never
//                         guess which of several candidates is the real, or the stale, owner).
//   NO_VISIBLE_OWNER   -- no non-archived session in the supplied snapshot reports the primary
//                         path. This is exactly the reproduced #442/#685 condition:
//                         `list_sessions` is not a complete occupancy inventory (a
//                         directly-opened session invisible to that list can still hold a path
//                         lock), so this verdict never claims the path is free or the lock is
//                         gone -- it only says there is nothing visible here to safely archive.
//                         The correct recovery is bypass (continue in a distinct worktree path),
//                         never a destructive guess against an unidentified owner.
//   OPERATIONAL_ERROR  -- `primaryPath` was missing/empty. Not a judgment about session state.
//
// Path comparison is host-semantics-aware, not a blanket normalization: a path is treated as
// Windows-style -- separators unified (backslash/forward-slash both mean "separator"), case
// folded, and a trailing separator dropped, because Windows paths are genuinely case-insensitive
// -- only when it actually looks like a Windows path (a drive letter like `C:\` or `C:/`, or a
// UNC `\\host\share` prefix). Any other path is treated as POSIX: case is significant, and a
// literal backslash is a normal filename character, never a separator, so it is left untouched
// rather than folded into `/`. Stage 1 review on PR #690: the prior blanket
// lowercase-and-replace-backslash normalization could collapse two distinct, case-sensitive
// POSIX paths into one apparent owner (or treat a POSIX path's literal backslash as if it were a
// path separator), which is unsafe when the verdict feeds an archival decision. Only a trailing
// `/` is trimmed unconditionally -- a trailing separator is redundant on both path styles, and
// POSIX paths never use trailing backslash as a separator, so nothing POSIX-meaningful is
// altered by that trim.
//
// Tests: node --test tools/orchestration/classify-primary-path-lock.test.mjs

import { readFileSync } from "node:fs";

const WINDOWS_STYLE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

// Pure. Returns a normalized comparison key for a filesystem path, or null for anything that is
// not a non-empty string (an unknown/undeterminable path must never coerce into a false match).
export function normalizePathForComparison(p) {
  if (typeof p !== "string" || p.length === 0) return null;
  let s = p;
  if (WINDOWS_STYLE_PATH.test(s)) {
    s = s.replace(/\\/g, "/").toLowerCase();
  }
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

// Pure decision function. See the module comment above for the full verdict contract.
export function classifyPrimaryPathLock({ primaryPath, sessions }) {
  const normalizedPrimary = normalizePathForComparison(primaryPath);
  if (!normalizedPrimary) {
    return { verdict: "OPERATIONAL_ERROR", reason: "primaryPath is required and must be a non-empty string" };
  }

  const list = Array.isArray(sessions) ? sessions : [];
  const candidates = list.filter((s) => {
    if (!s || s.archived) return false;
    const p = normalizePathForComparison(s.path);
    return p != null && p === normalizedPrimary;
  });

  if (candidates.length === 0) {
    return { verdict: "NO_VISIBLE_OWNER" };
  }

  if (candidates.length > 1) {
    return { verdict: "AMBIGUOUS", sessionIds: candidates.map((c) => c.sessionId) };
  }

  const [only] = candidates;
  // Archival eligibility requires both protection fields to be POSITIVELY known to be false.
  // `=== false` (rather than a falsy check) is deliberate: omitted, null, or any other
  // non-boolean value is unknown protection state, and unknown evidence must fail closed to
  // PROTECTED_OWNER rather than being treated as "unprotected" (Stage 1 review on PR #690).
  const pinnedProvenSafe = only.pinned === false;
  const remoteControlProvenSafe = only.remoteControlActive === false;
  if (!pinnedProvenSafe || !remoteControlProvenSafe) {
    return { verdict: "PROTECTED_OWNER", sessionId: only.sessionId };
  }

  return { verdict: "ARCHIVE_CANDIDATE", sessionId: only.sessionId };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
  }
  return args;
}

function readSessionsJson(spec, { readFileImpl = readFileSync } = {}) {
  const raw = spec === "-" ? readFileImpl(0, "utf8") : readFileImpl(spec, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("--sessions-json must contain a JSON array");
  }
  return parsed;
}

export function runCli({ argv, readFileImpl = readFileSync } = {}) {
  const args = parseArgs(argv);
  if (!args["primary-path"]) {
    return { exitCode: 1, message: "classify-primary-path-lock: --primary-path is required" };
  }
  if (!args["sessions-json"]) {
    return { exitCode: 1, message: "classify-primary-path-lock: --sessions-json is required" };
  }
  let sessions;
  try {
    sessions = readSessionsJson(args["sessions-json"], { readFileImpl });
  } catch (err) {
    return { exitCode: 1, message: `classify-primary-path-lock: could not read --sessions-json: ${err.message}` };
  }
  const result = classifyPrimaryPathLock({ primaryPath: args["primary-path"], sessions });
  return { exitCode: result.verdict === "OPERATIONAL_ERROR" ? 1 : 0, result };
}

function main() {
  const outcome = runCli({ argv: process.argv.slice(2) });
  if (outcome.result !== undefined) {
    console.log(JSON.stringify(outcome.result));
  } else if (outcome.message) {
    console.error(outcome.message);
  }
  process.exit(outcome.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("classify-primary-path-lock.mjs")) {
  main();
}
