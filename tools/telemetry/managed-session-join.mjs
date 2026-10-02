// Deterministic reader/joiner for managed-session records (issue #389, unit 389-E).
// Reads the compact one-file-per-run records written by managed-session-record.mjs (389-A/B) and
// the gate-outcome records written by the launcher supervisor (389-C), joins them by
// control/execution identity, and emits a by-reference summary for the #377/#391 diagnostic
// packet: record file names and identifiers only. It never reads transcripts, copies verified
// outcomes (those stay durable GitHub PR/Audit state, linked by number), or adds a datastore.
// Authority split: Shared Contract (v1) on #389.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_SESSIONS_DIR, validateManagedSessionRecord } from "./managed-session-record.mjs";

export const SUMMARY_SCHEMA_VERSION = 1;

const GATE_RESULT_CLASSES = ["transition", "waiting", "open_path", "fail_closed", "ambiguous"];
const isRef = (v) => Number.isInteger(v) && v > 0;
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (xs) => [...new Set(xs.filter(isRef))].sort((a, b) => a - b);

// Structural check mirroring 389-C's gate-outcome record (kept local so telemetry does not
// depend on orchestration code).
function validGateRecord(r) {
  if (!r || typeof r !== "object" || r.record_kind !== "gate_outcome" || r.schema_version !== 1) return false;
  if (typeof r.run_id !== "string" || !GATE_RESULT_CLASSES.includes(r.result_class)) return false;
  return r.references !== null && typeof r.references === "object";
}

// Reads every `*.json` record in `dir`. Unreadable/invalid files are reported by file name only.
export function readManagedRecords({ dir = MANAGED_SESSIONS_DIR } = {}) {
  const sessions = [];
  const gates = [];
  const skipped = [];
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(byString);
  } catch {
    return { sessions, gates, skipped };
  }
  for (const file of files) {
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      skipped.push({ file, reason: "unreadable" });
      continue;
    }
    if (rec?.record_kind === "gate_outcome") {
      if (validGateRecord(rec)) gates.push({ file, record: rec });
      else skipped.push({ file, reason: "invalid_gate_outcome_record" });
    } else if (validateManagedSessionRecord(rec).valid) {
      sessions.push({ file, record: rec });
    } else {
      skipped.push({ file, reason: "invalid_session_record" });
    }
  }
  return { sessions, gates, skipped };
}

const keyOf = (control, execution) => `${control ?? "none"}/${execution ?? "none"}`;

function sessionRow({ file, record: r }) {
  const e = r.economics ?? {};
  return {
    run_id: r.run_id,
    record: file,
    lifecycle_stage: r.lifecycle_stage,
    unit_id: r.unit_id,
    surface: r.surface,
    provider: r.provider,
    model: r.model,
    route: r.route,
    route_provenance: r.route_provenance,
    whole_run_complete: r.whole_run_complete === true,
    completion_state: r.process?.completion_state ?? "unknown",
    terminal_result_available: r.terminal_result?.available === true,
    economics_authority: e.authority ?? null,
    economics_available: { ...(e.availability ?? {}) },
  };
}

function gateRow({ file, record: g }) {
  return {
    run_id: g.run_id,
    record: file,
    gate_or_transition: g.gate_or_transition ?? null,
    input_lifecycle_state: g.input_lifecycle_state ?? null,
    result_class: g.result_class,
    route_wait_stop_state: g.route_wait_stop_state ?? null,
    founder_interrupt: g.founder_interrupt === true,
  };
}

// Joins records into a compact by-reference summary. Deterministic: identical inputs yield an
// identical object (sorted keys/rows; no clock reads). Outcome linkage is by GitHub PR/Audit
// number only (from gate-outcome references); the verified outcome itself is never copied.
export function joinManagedRecords({ sessions = [], gates = [], skipped = [] } = {}) {
  const groups = new Map();
  const group = (control, execution) => {
    const k = keyOf(control, execution);
    if (!groups.has(k)) groups.set(k, { control_issue: control ?? null, execution_issue: execution ?? null, sessions: [], gates: [], prs: [], audits: [] });
    return groups.get(k);
  };
  for (const s of sessions) group(s.record.control_issue, s.record.execution_issue).sessions.push(s);
  for (const g of gates) {
    const refs = g.record.references ?? {};
    const grp = group(g.record.control_issue ?? refs.control, g.record.execution_issue ?? refs.execution);
    grp.gates.push(g);
    if (isRef(refs.pr)) grp.prs.push(refs.pr);
    if (isRef(refs.audit)) grp.audits.push(refs.audit);
  }
  const out = [...groups.values()]
    .map((grp) => ({
      control_issue: grp.control_issue,
      execution_issue: grp.execution_issue,
      sessions: grp.sessions.map(sessionRow).sort((a, b) => byString(a.run_id, b.run_id)),
      gate_outcomes: grp.gates.map(gateRow).sort((a, b) => byString(a.run_id, b.run_id)),
      // Verified-outcome linkage is by reference to durable GitHub state, never a copied outcome.
      outcome_refs: { authority: "github", pr: sortedUnique(grp.prs), audit: sortedUnique(grp.audits) },
    }))
    .sort((a, b) => byString(keyOf(a.control_issue, a.execution_issue), keyOf(b.control_issue, b.execution_issue)));

  // Comparable-attribution rows: stage + route + surface, each pointing at run ids and the
  // execution group's outcome refs (so a later bounded comparison can resolve outcomes on GitHub).
  const comparisons = new Map();
  for (const grp of out) {
    for (const s of grp.sessions) {
      const k = JSON.stringify([s.lifecycle_stage, s.route, s.surface]);
      if (!comparisons.has(k)) comparisons.set(k, { lifecycle_stage: s.lifecycle_stage, route: s.route, surface: s.surface, run_ids: [], outcome_refs: { authority: "github", pr: [], audit: [] } });
      const c = comparisons.get(k);
      c.run_ids.push(s.run_id);
      c.outcome_refs.pr.push(...grp.outcome_refs.pr);
      c.outcome_refs.audit.push(...grp.outcome_refs.audit);
    }
  }
  const stageRouteSurface = [...comparisons.values()]
    .map((c) => ({ ...c, run_ids: c.run_ids.sort(byString), outcome_refs: { authority: "github", pr: sortedUnique(c.outcome_refs.pr), audit: sortedUnique(c.outcome_refs.audit) } }))
    .sort((a, b) => byString(JSON.stringify([a.lifecycle_stage, a.route, a.surface]), JSON.stringify([b.lifecycle_stage, b.route, b.surface])));

  return {
    schema_version: SUMMARY_SCHEMA_VERSION,
    counts: {
      session_records: sessions.length,
      gate_outcome_records: gates.length,
      skipped_records: skipped.length,
      whole_run_complete: sessions.filter((s) => s.record.whole_run_complete === true).length,
    },
    executions: out,
    stage_route_surface: stageRouteSurface,
    skipped: [...skipped].sort((a, b) => byString(a.file, b.file)),
  };
}

// Convenience: read a records directory and return the by-reference summary.
export function summarizeManagedRuns({ dir = MANAGED_SESSIONS_DIR } = {}) {
  return joinManagedRecords(readManagedRecords({ dir }));
}
