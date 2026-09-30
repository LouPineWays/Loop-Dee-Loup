// Deterministic verdict handoff for the post-PR correction-dispatch pipeline -- issue #761
// (control #571), the live #398/#740/PR #760 recurrence.
//
// `session-entry-gate.mjs` returned STAGE1_CORRECTION_REQUIRED and
// `pr-head-checkout-preflight.mjs --reserve-from-gate` reserved a checkout, but the controller had
// not retained the gate's machine-readable JSON to pipe into `format-dispatch-prompt.mjs`. The
// action envelope (correctly) forbade re-running the lifecycle gate, and the controller then
// hand-rebuilt the JSON with an unescaped Windows `scriptPath`, which failed to parse.
//
// The fix is a transport, not a policy change: the gate scripts already persist their verdict the
// instant they emit it (`persistLastGateVerdict`), so this module ALSO keeps one durable,
// non-consumed copy in the same gitignored state directory. The reserve and format steps read it
// with `--from-handoff` instead of a stdin pipe; the reserve step writes its enriched output
// (verdict + `checkoutBinding`) back, so the formatter consumes exactly the reservation it
// depends on. JSON.parse/stringify round-trips backslashes and spaces losslessly; the controller
// never authors or repairs JSON.
//
// Fail closed: a missing, malformed, wrong-version, over-age, or (when supplied) wrong-control-
// issue handoff is an operational failure -- never permission to reconstruct authority from
// prose. The handoff carries data only; authority still comes from the verdict's own state and
// actionEnvelope, and the worker still runs `--verify-binding` against the live PR head.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Resolved at call time (not import time) so the env override is honored however the module is
// loaded; the hook passes its own STATE_DIR-derived path explicitly so both always agree.
export function verdictHandoffPath(stateDir = process.env.LDL_ACTION_ENVELOPE_STATE_DIR || join(ROOT, ".claude", "action-envelope-state")) {
  return join(stateDir, "verdict-handoff.json");
}
export const HANDOFF_VERSION = 1;
// Gate -> reserve -> format is a same-turn sequence; a handoff older than this is stale.
export const HANDOFF_MAX_AGE_MS = 2 * 60 * 60 * 1000;

// Never throws: the caller's primary duty (printing the verdict) must not depend on this.
export function persistVerdictHandoff(
  verdict,
  { mkdirImpl = mkdirSync, writeFileImpl = writeFileSync, now = Date.now(), path = verdictHandoffPath() } = {},
) {
  try {
    mkdirImpl(dirname(path), { recursive: true });
    writeFileImpl(path, JSON.stringify({ version: HANDOFF_VERSION, savedAt: now, verdict }), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function clearVerdictHandoff({ existsImpl = existsSync, unlinkImpl = unlinkSync, path = verdictHandoffPath() } = {}) {
  try {
    if (existsImpl(path)) unlinkImpl(path);
  } catch {
    // Deliberately swallowed: see persistVerdictHandoff.
  }
}

// Returns { ok: true, verdict, savedAt } or { ok: false, reason }. `controlIssue`, when given,
// must equal the verdict's own controlIssue.
export function readVerdictHandoff({
  controlIssue = null,
  now = Date.now(),
  maxAgeMs = HANDOFF_MAX_AGE_MS,
  readFileImpl = readFileSync,
  existsImpl = existsSync,
  path = verdictHandoffPath(),
} = {}) {
  if (!existsImpl(path)) {
    return { ok: false, reason: "no verdict handoff exists -- run the lifecycle gate once (never re-run it after a bounded verdict in the same session; start a fresh session instead)" };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileImpl(path, "utf8"));
  } catch (err) {
    return { ok: false, reason: `verdict handoff is unreadable or malformed: ${err.message}` };
  }
  if (!parsed || parsed.version !== HANDOFF_VERSION || !parsed.verdict || typeof parsed.verdict !== "object" || typeof parsed.verdict.state !== "string") {
    return { ok: false, reason: "verdict handoff has an unrecognized shape or version" };
  }
  if (!Number.isFinite(parsed.savedAt) || now - parsed.savedAt > maxAgeMs || parsed.savedAt - now > 60_000) {
    return { ok: false, reason: "verdict handoff is stale (or has an invalid timestamp)" };
  }
  if (controlIssue != null && Number(parsed.verdict.controlIssue) !== Number(controlIssue)) {
    return {
      ok: false,
      reason: `verdict handoff belongs to control issue ${parsed.verdict.controlIssue ?? "(none)"}, not ${controlIssue}`,
    };
  }
  return { ok: true, verdict: parsed.verdict, savedAt: parsed.savedAt };
}
