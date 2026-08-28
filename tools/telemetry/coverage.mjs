#!/usr/bin/env node
// Aggregates telemetry sufficiency across a sample of recent sessions into the coverage
// report the `telemetry-battery` skill needs, built for issue #199.
//
// Issue #199's problem: /spend's evidence-sufficiency gate (sufficiency.mjs) answers "is
// this one session's evidence enough for this one claim" — exactly what a single-session
// /spend run needs. A weekly battery needs a different question: "across recent real LDL
// work, which decision-critical fields does this collector reliably produce at all, and
// which are gaps?" This module answers that without inventing a second, hand-maintained
// checklist of "important" fields — the decision-critical field list, and the exact
// predicate each field must satisfy (present / positive / exactly true), are read straight
// out of sufficiency.mjs's CLAIM_REQUIREMENTS, the actual /spend evidence contract. If a
// new claim type is added there, this module's coverage report picks it up automatically,
// including its predicate — a field only ever counts as captured here when
// assessSufficiency would also treat it as satisfying every claim that needs it (Stage 1
// review finding on PR #203: a uniform presence check let `hook_event_count: 0` and
// `token_usage_is_session_complete: false` read as captured even though their claims'
// `requiresPositive`/`requiresTrue` predicates reject exactly those values).
//
// A field counts as "captured" only if every sampled session satisfies its predicate — one
// failing session makes it "partial" (unreliable, not "acceptable reliability" per the
// issue), and zero sessions satisfying it makes it "unavailable". Both partial and
// unavailable count as decision-critical gaps: a field this collector only sometimes
// produces cannot support a confident CLEAN verdict any more than a field it never
// produces can.
//
// Fields reduce.mjs's `unknown` list names that no CLAIM_REQUIREMENTS claim currently
// requires (e.g. per-skill token attribution) are reported separately as "not applicable"
// — real, named gaps in what this collector can ever measure, but not decision-critical to
// /spend's current claim set, so they don't block a SUFFICIENT verdict.
//
// Tests: node --test tools/telemetry/coverage.test.mjs
// Usage:
//   node tools/telemetry/coverage.mjs [--sample <n> | --since <iso-timestamp>]
//                                      [--exclude-session <id>]... [--exclude-ids-file <path>]
//                                      [--record-ids <path>] [--session <id>]... [--json]
//     Default (no prior battery run): the <n> (default 10) most recently modified session
//     logs in .claude/telemetry/sessions/ ($LDL_TELEMETRY_DIR override honored via
//     collect.mjs). Pass --since <iso-timestamp> (the previous run's recorded "as of"
//     cutoff, see docs/telemetry-battery-log.md) once one exists, to narrow how much
//     session history gets scanned. --since is a coarse relevance filter only, not a
//     disjointness guarantee: a resumed or still-running session's file keeps getting
//     touched, so its mtime can cross a prior cutoff again even though it was already
//     counted (Stage 2 audit finding on PR #203). The actual guarantee that two runs never
//     double-count the same session comes from --exclude-ids-file <path>: a durable JSON
//     array of already-sampled ids (see --record-ids) excluded regardless of mtime. Pass
//     the same path to both flags on every weekly run — --exclude-ids-file to skip what
//     was already counted, --record-ids to append this run's sample onto that same
//     durable list — so the exclusion set only ever grows. Pass --exclude-session <id>
//     (repeatable) with the invoking session's own id (when known) so a still-running
//     battery session, which necessarily has no SessionEnd/whole-session measurement yet,
//     never injects a guaranteed partial/unavailable result into its own sample (Stage 1
//     review finding on PR #203). Pass one or more explicit --session <id> to name a
//     sample directly instead of auto-selecting one; each named id must have a real
//     session log, or the command fails loudly rather than silently treating a typo as a
//     session with no evidence at all (also a Stage 1 review finding on PR #203).

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SESSIONS_DIR } from "./collect.mjs";
import { reduceSession } from "./reduce.mjs";
import { CLAIM_REQUIREMENTS, getPath, isPresent, isPositiveNumber } from "./sufficiency.mjs";

// Named structurally in reduce.mjs's `unknown` list (tools/telemetry/reduce.mjs) but not
// required by any CLAIM_REQUIREMENTS claim today — real gaps, just not decision-critical
// ones. Kept as a short fixed list because these are the exact structural-limitation names
// reduce.mjs itself always emits, not a duplicate of the decision-critical checklist the
// issue warned against re-hardcoding.
const STRUCTURAL_NOT_APPLICABLE = [
  "per_skill_token_or_cost_attribution",
  "input_output_cache_token_breakdown_by_individual_turn",
  "rate_limit_consumption",
];

export function decisionCriticalFields() {
  return [...decisionCriticalPredicates().keys()].sort();
}

// Maps each decision-critical field to the exact predicate assessSufficiency applies to it.
// Precedence true > positive > present matches assessSufficiency's own behavior when a
// field could in principle appear under more than one requirement kind across claims: the
// strictest applicable check wins, so this module never reports a field captured that
// assessSufficiency would still reject for some claim that needs it.
function decisionCriticalPredicates() {
  const predicates = new Map();
  for (const spec of Object.values(CLAIM_REQUIREMENTS)) {
    for (const field of spec.requiresTrue ?? []) predicates.set(field, "true");
    for (const field of spec.requiresPositive ?? []) if (predicates.get(field) !== "true") predicates.set(field, "positive");
    for (const field of spec.requires ?? []) if (!predicates.has(field)) predicates.set(field, "present");
  }
  return predicates;
}

function satisfies(kind, value) {
  if (kind === "true") return value === true;
  if (kind === "positive") return isPositiveNumber(value);
  return isPresent(value);
}

// records: array of reduceSession()/reduceEvents() outputs, any order — presence is
// counted across the whole sample, not order-sensitive, since "reliable" means "every
// session had it", not "the newest session had it".
function classify(records, field, kind) {
  const sampleSize = records.length;
  const satisfiedCount = records.filter((r) => satisfies(kind, getPath(r, field))).length;
  const status = sampleSize === 0 ? "unavailable" : satisfiedCount === sampleSize ? "captured" : satisfiedCount === 0 ? "unavailable" : "partial";
  return { status, presentInSample: satisfiedCount, sampleSize };
}

export function buildCoverageReport(records) {
  const predicates = decisionCriticalPredicates();
  const fields = [...predicates.keys()].sort();
  const fieldStatus = {};
  const gaps = [];

  for (const field of fields) {
    const status = classify(records, field, predicates.get(field));
    fieldStatus[field] = status;
    if (status.status !== "captured") gaps.push(field);
  }

  const derivedFieldNames = [...new Set(records.flatMap((r) => Object.keys(r.derived ?? {})))].sort();
  const derivedStatus = {};
  for (const name of derivedFieldNames) {
    derivedStatus[name] = classify(records, `derived.${name}`, "present");
  }
  const derivedCaptured = derivedFieldNames.filter((n) => derivedStatus[n].status === "captured");

  const notApplicable = STRUCTURAL_NOT_APPLICABLE.filter((name) => records.some((r) => (r.unknown ?? []).includes(name)));
  const captured = fields.filter((f) => fieldStatus[f].status === "captured");

  return {
    sampleSize: records.length,
    requiredFields: fields,
    captured,
    derivedFields: derivedFieldNames,
    derivedCaptured,
    derivedFieldStatus: derivedStatus,
    unavailable: gaps.filter((f) => fieldStatus[f].status === "unavailable"),
    partial: gaps.filter((f) => fieldStatus[f].status === "partial"),
    notApplicable,
    fieldStatus,
    decisionCriticalGaps: gaps,
    telemetryVerdict: records.length > 0 && gaps.length === 0 ? "SUFFICIENT" : "INSUFFICIENT",
  };
}

// `dir` defaults to the real SESSIONS_DIR everywhere below but is an explicit parameter
// throughout this section (rather than only read from the module-level constant, or from
// $LDL_TELEMETRY_DIR re-read per call) so tests can point these pure-ish functions at a
// disposable temp directory directly, without relying on ES module cache/env-var timing.
function listSessionFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => ({ id: name.replace(/\.jsonl$/, ""), mtimeMs: statSync(join(dir, name)).mtimeMs }));
}

// excludeIds: an array/Set of session ids to omit regardless of mtime. `--since`/mtime
// alone cannot guarantee a session is genuinely new: a resumed or still-running session's
// file keeps getting touched (its own SessionStart/hook writes advance its mtime), so it
// can cross a previous run's `--since` cutoff again even though it was already sampled, or
// was excluded that run precisely because it was still live (Stage 2 audit finding on PR
// #203 — the exact case demonstrated by this very repository's own live battery session,
// whose mtime kept advancing well past the cutoff its own excluded run recorded). Passing
// the durable id list from `--exclude-ids-file` (see resolveSessionIds/writeIdsFile below)
// is what actually guarantees two runs' samples are disjoint; `--since` only narrows how
// much history gets scanned, it does not by itself prove nothing was already counted.
export function listRecentSessionIds(limit, excludeIds = [], dir = SESSIONS_DIR) {
  const excluded = new Set(excludeIds);
  return listSessionFiles(dir)
    .filter((entry) => !excluded.has(entry.id))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.id);
}

export function listSessionIdsSince(sinceMs, excludeIds = [], dir = SESSIONS_DIR) {
  const excluded = new Set(excludeIds);
  return listSessionFiles(dir)
    .filter((entry) => !excluded.has(entry.id) && entry.mtimeMs > sinceMs)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map((entry) => entry.id);
}

function sessionFileExists(sessionId, dir) {
  return existsSync(join(dir, `${sessionId}.jsonl`));
}

// Reads the durable JSON array of session ids a prior run already counted (see
// --exclude-ids-file/--record-ids). Missing or unreadable/malformed file means "no history
// yet" — the very first battery run has nothing to exclude — not an error. Exported so
// tests exercise this exact implementation rather than a parallel copy of it.
export function readIdsFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Merges newIds into whatever is already recorded at path (deduped, sorted for a stable
// diff), so this file only ever grows and never loses a previously-recorded id.
export function writeIdsFile(path, newIds) {
  const merged = [...new Set([...readIdsFile(path), ...newIds])].sort();
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

// The "as of" cutoff a subsequent run should pass as --since, so next week's sample never
// re-counts a session this run already saw. Derived from the same file mtimes selection
// itself used (not from an embedded event timestamp, which reduceSession would otherwise
// fall back to "now" for a session with no session_end_ts, quietly advancing the cutoff to
// the time the battery happened to run rather than to when the sampled evidence occurred).
function latestMtimeIso(sessionIds, dir) {
  const mtimes = sessionIds
    .map((id) => join(dir, `${id}.jsonl`))
    .filter((path) => existsSync(path))
    .map((path) => statSync(path).mtimeMs);
  return mtimes.length > 0 ? new Date(Math.max(...mtimes)).toISOString() : null;
}

function renderReport(report, asOf) {
  const lines = [];
  lines.push("Telemetry coverage");
  lines.push("");
  lines.push(`Sample size:                        ${report.sampleSize} session(s)`);
  lines.push(`As of (pass to the next run's --since): ${asOf ?? "n/a"}`);
  lines.push(`Required decision-critical fields:  ${report.requiredFields.length}`);
  lines.push(`Captured (every sampled session):   ${report.captured.length}`);
  lines.push(`Partial (some sampled sessions):    ${report.partial.length}`);
  lines.push(`Unavailable (no sampled session):   ${report.unavailable.length}`);
  lines.push(`Derived fields captured reliably:   ${report.derivedCaptured.length}/${report.derivedFields.length}`);
  lines.push(`Not applicable (no current claim):  ${report.notApplicable.length}`);
  lines.push("");
  if (report.decisionCriticalGaps.length > 0) {
    lines.push("Decision-critical gaps:");
    for (const field of report.decisionCriticalGaps) {
      const s = report.fieldStatus[field];
      lines.push(`  - ${field} (${s.status}: present in ${s.presentInSample}/${s.sampleSize} sampled sessions)`);
    }
    lines.push("");
  }
  if (report.notApplicable.length > 0) {
    lines.push(`Not applicable to any current claim: ${report.notApplicable.join(", ")}`);
    lines.push("");
  }
  lines.push(`Telemetry verdict: ${report.telemetryVerdict}`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = { sample: null, since: null, sessions: [], excludeSessions: [], excludeIdsFile: null, recordIds: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--sample") {
      args.sample = argv[i + 1];
      i += 1;
    } else if (flag === "--since") {
      args.since = argv[i + 1];
      i += 1;
    } else if (flag === "--session") {
      args.sessions.push(argv[i + 1]);
      i += 1;
    } else if (flag === "--exclude-session") {
      args.excludeSessions.push(argv[i + 1]);
      i += 1;
    } else if (flag === "--exclude-ids-file") {
      args.excludeIdsFile = argv[i + 1];
      i += 1;
    } else if (flag === "--record-ids") {
      args.recordIds = argv[i + 1];
      i += 1;
    } else if (flag === "--json") {
      args.json = true;
    } else {
      throw new Error(`Unrecognized argument: ${flag}`);
    }
  }
  return args;
}

// Resolves the sample of session ids from CLI args, failing loudly on invalid input rather
// than silently degrading (an unresolvable --session becomes a fabricated all-empty
// record; a missing/garbled --sample or --since value must not be quietly coerced).
// Exported so tests exercise the same validation the CLI relies on.
export function resolveSessionIds(args, dir = SESSIONS_DIR) {
  if (args.sessions.length > 0) {
    for (const id of args.sessions) {
      if (!id) throw new Error("--session requires a value");
      if (!sessionFileExists(id, dir)) throw new Error(`--session ${id}: no session log found at ${join(dir, `${id}.jsonl`)}`);
    }
    return args.sessions;
  }
  const excludeIds = [...args.excludeSessions, ...(args.excludeIdsFile ? readIdsFile(args.excludeIdsFile) : [])];
  if (args.since !== null) {
    const sinceMs = Date.parse(args.since);
    if (Number.isNaN(sinceMs)) throw new Error(`--since ${args.since}: not a valid ISO timestamp`);
    return listSessionIdsSince(sinceMs, excludeIds, dir);
  }
  const sample = args.sample === null ? 10 : Number(args.sample);
  if (!Number.isInteger(sample) || sample <= 0) throw new Error(`--sample ${args.sample}: must be a positive integer`);
  return listRecentSessionIds(sample, excludeIds, dir);
}

function main() {
  let args;
  let sessionIds;
  try {
    args = parseArgs(process.argv.slice(2));
    sessionIds = resolveSessionIds(args);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  const records = sessionIds.map((id) => reduceSession(id));
  const report = buildCoverageReport(records);
  const asOf = latestMtimeIso(sessionIds, SESSIONS_DIR);
  // Recorded after resolving the sample (never before), and merged with whatever was
  // already there: this is what makes a *future* run's --exclude-ids-file exclusion
  // durable and cumulative, independent of any session's mtime moving again afterward.
  if (args.recordIds) writeIdsFile(args.recordIds, sessionIds);
  if (args.json) {
    console.log(JSON.stringify({ sessionIds, asOf, ...report }, null, 2));
  } else {
    console.log(renderReport(report, asOf));
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
