// Shared helpers for Loop-Dee-Loup's deterministic session telemetry collector.
//
// hook.mjs and statusline.mjs are the two Claude Code entry points wired in
// .claude/settings.json; both funnel through here so the on-disk event shape, the
// telemetry directory layout, and the privacy-minimization rule live in exactly one
// place. See tools/telemetry/README.md for the mechanism this feeds and
// .claude/skills/spend/SKILL.md for how the reduced record gets consumed.
//
// Privacy: only coarse identifiers and numeric measurements are ever written to a raw
// event. Never: prompt/response content, reasoning, tool output, source file contents,
// or full filesystem paths (which can embed a local username). `LDL_TELEMETRY_DIR` can
// redirect the whole telemetry tree, primarily so tests never touch a real session's
// on-disk data.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const TELEMETRY_DIR = process.env.LDL_TELEMETRY_DIR || join(ROOT, ".claude", "telemetry");
export const SESSIONS_DIR = join(TELEMETRY_DIR, "sessions");
export const RECORDS_DIR = join(TELEMETRY_DIR, "records");

// path.basename() picks posix vs win32 splitting based on the *running* platform, which
// would silently leave a full Windows path intact when a fixture or a cross-platform CI
// run supplies backslashes on a posix host (or vice versa). Splitting on either separator
// keeps the result deterministic regardless of where the script executes.
export function crossPlatformBasename(pathValue) {
  if (typeof pathValue !== "string" || pathValue.length === 0) return null;
  const parts = pathValue.split(/[/\\]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

// A session_id is expected to be an opaque UUID-like token. Strip anything unsafe in a
// filename so a malformed or hostile payload can't path-traverse out of the telemetry
// directory via the id it supplies.
export function sanitizeSessionId(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

// Extracts only the coarse identity fields this collector is willing to persist from a
// raw hook/statusLine payload. Everything else on the payload is ignored.
export function extractIdentity(payload) {
  const repo = payload && typeof payload === "object" ? payload.workspace?.repo : null;
  const hasRepo = repo && typeof repo.owner === "string" && typeof repo.name === "string";
  return {
    session_id: typeof payload?.session_id === "string" ? payload.session_id : null,
    repo: hasRepo ? { owner: repo.owner, name: repo.name } : null,
    cwd_basename: crossPlatformBasename(payload?.cwd),
  };
}

export function numOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Reads and parses the whole of stdin as JSON. Returns null on any failure (empty stdin,
// invalid JSON, no stdin attached) rather than throwing, so callers can treat "no usable
// payload" as one uniform case.
export function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw || raw.trim().length === 0) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Appends one compact JSON event line to the given session's raw telemetry log. Silently
// does nothing if there is no session id to key the file by — an event with no session
// identity is not attributable to anything and is not worth guessing a location for.
export function appendEvent(sessionId, event) {
  if (!sessionId) return false;
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const file = join(SESSIONS_DIR, `${sanitizeSessionId(sessionId)}.jsonl`);
  appendFileSync(file, `${JSON.stringify(event)}\n`, "utf8");
  return true;
}

// Reads back a session's raw event log as an array of parsed objects. Skips any line that
// fails to parse (e.g. a torn write from a crashed process) rather than failing the whole
// read — telemetry evidence should degrade gracefully, never block real work.
export function readSessionEvents(sessionId) {
  const file = join(SESSIONS_DIR, `${sanitizeSessionId(sessionId)}.jsonl`);
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip torn/corrupt line
    }
  }
  return events;
}
