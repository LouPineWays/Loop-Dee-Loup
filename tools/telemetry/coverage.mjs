#!/usr/bin/env node
// Aggregates telemetry sufficiency across a sample of recent sessions into the coverage
// report the `telemetry-battery` skill needs, built for issue #199.
//
// Issue #199's problem: /spend's evidence-sufficiency gate (sufficiency.mjs) answers "is
// this one session's evidence enough for this one claim" — exactly what a single-session
// /spend run needs. A weekly battery needs a different question: "across recent real LDL
// work, which decision-critical fields does this collector reliably produce at all, and
// which are gaps?" This module answers that without inventing a second, hand-maintained
// checklist of "important" fields — the decision-critical field list is read straight out
// of sufficiency.mjs's CLAIM_REQUIREMENTS, the actual /spend evidence contract. If a new
// claim type is added there, this module's coverage report picks it up automatically.
//
// A field counts as "captured" only if every sampled session produced it — one missing
// session makes it "partial" (unreliable, not "acceptable reliability" per the issue), and
// zero sessions producing it makes it "unavailable". Both partial and unavailable count as
// decision-critical gaps: a field this collector only sometimes produces cannot support a
// confident CLEAN verdict any more than a field it never produces can.
//
// Fields reduce.mjs's `unknown` list names that no CLAIM_REQUIREMENTS claim currently
// requires (e.g. per-skill token attribution) are reported separately as "not applicable"
// — real, named gaps in what this collector can ever measure, but not decision-critical to
// /spend's current claim set, so they don't block a SUFFICIENT verdict.
//
// Tests: node --test tools/telemetry/coverage.test.mjs
// Usage:
//   node tools/telemetry/coverage.mjs [--sample <n>] [--session <id>]... [--json]
//     Defaults to the <n> (default 10) most recently modified session logs in
//     .claude/telemetry/sessions/ ($LDL_TELEMETRY_DIR override honored via collect.mjs).
//     Pass one or more --session <id> to name an explicit sample instead.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SESSIONS_DIR } from "./collect.mjs";
import { reduceSession } from "./reduce.mjs";
import { CLAIM_REQUIREMENTS, getPath, isPresent } from "./sufficiency.mjs";

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
  const fields = new Set();
  for (const spec of Object.values(CLAIM_REQUIREMENTS)) {
    for (const field of [...(spec.requires ?? []), ...(spec.requiresPositive ?? []), ...(spec.requiresTrue ?? [])]) {
      fields.add(field);
    }
  }
  return [...fields].sort();
}

// records: array of reduceSession()/reduceEvents() outputs, any order — presence is
// counted across the whole sample, not order-sensitive, since "reliable" means "every
// session had it", not "the newest session had it".
export function buildCoverageReport(records) {
  const fields = decisionCriticalFields();
  const fieldStatus = {};
  const gaps = [];
  const sampleSize = records.length;

  for (const field of fields) {
    const presentCount = records.filter((r) => isPresent(getPath(r, field))).length;
    const status = sampleSize === 0 ? "unavailable" : presentCount === sampleSize ? "captured" : presentCount === 0 ? "unavailable" : "partial";
    fieldStatus[field] = { status, presentInSample: presentCount, sampleSize };
    if (status !== "captured") gaps.push(field);
  }

  const derivedFields = sampleSize > 0 ? Object.keys(records[0].derived ?? {}) : [];
  const notApplicable = STRUCTURAL_NOT_APPLICABLE.filter((name) => records.some((r) => (r.unknown ?? []).includes(name)));
  const captured = fields.filter((f) => fieldStatus[f].status === "captured");

  return {
    sampleSize,
    requiredFields: fields,
    captured,
    derivedFields,
    unavailable: gaps.filter((f) => fieldStatus[f].status === "unavailable"),
    partial: gaps.filter((f) => fieldStatus[f].status === "partial"),
    notApplicable,
    fieldStatus,
    decisionCriticalGaps: gaps,
    telemetryVerdict: sampleSize > 0 && gaps.length === 0 ? "SUFFICIENT" : "INSUFFICIENT",
  };
}

export function listRecentSessionIds(limit) {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => ({ id: name.replace(/\.jsonl$/, ""), mtimeMs: statSync(join(SESSIONS_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.id);
}

function renderReport(report) {
  const lines = [];
  lines.push("Telemetry coverage");
  lines.push("");
  lines.push(`Sample size:                        ${report.sampleSize} session(s)`);
  lines.push(`Required decision-critical fields:  ${report.requiredFields.length}`);
  lines.push(`Captured (every sampled session):   ${report.captured.length}`);
  lines.push(`Partial (some sampled sessions):    ${report.partial.length}`);
  lines.push(`Unavailable (no sampled session):   ${report.unavailable.length}`);
  lines.push(`Derived fields available:           ${report.derivedFields.length}`);
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
  const args = { sample: 10, sessions: [], json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--sample") {
      args.sample = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--session") {
      args.sessions.push(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--json") {
      args.json = true;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessionIds = args.sessions.length > 0 ? args.sessions : listRecentSessionIds(args.sample);
  const records = sessionIds.map((id) => reduceSession(id));
  const report = buildCoverageReport(records);
  if (args.json) {
    console.log(JSON.stringify({ sessionIds, ...report }, null, 2));
  } else {
    console.log(renderReport(report));
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
