// Canonical, provider-neutral managed-session record (issue #389, unit 389-A).
// Pure builder + validator, a deterministic privacy-minimal persister, a Claude adapter that
// ingests a #245-style stream-json terminal result, and a generic adapter for surfaces that
// expose no terminal result. Authority split and field list: Shared Contract (v1) on #389.
//
// Rules enforced here: unavailable evidence is null with an explicit availability marker
// (never 0, never inferred); cost is only ever `estimated_list_cost_usd`; a run without
// trustworthy terminal evidence is `whole_run_complete: false`; no prompt/response/transcript
// content is ever read or persisted; persistence failure never throws to the caller.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TELEMETRY_DIR } from "./collect.mjs";

export const SCHEMA_VERSION = 1;
export const MANAGED_SESSIONS_DIR = join(TELEMETRY_DIR, "managed-sessions");

export const LIFECYCLE_STAGES = [
  "PLAN",
  "ROUTE_PREPARE",
  "EXECUTE_UNIT",
  "INTEGRATE_PR",
  "STAGE1_CORRECTION",
  "MERGE_AUDIT",
  "STAGE2_CORRECTION",
  "OTHER",
];
export const AUTHORITY_CLASSES = ["terminal_result", "process", "hook", "gate"];
export const COMPLETION_STATES = ["completed", "failed", "interrupted", "spawn_failed", "unknown"];

const USAGE_KEYS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
const FORBIDDEN_KEYS = new Set(["result", "prompt", "transcript", "response", "text", "content", "output", "messages"]);

export function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strOrNull(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function refOrNull(v) {
  return Number.isInteger(v) && v > 0 ? v : null;
}

function usageObject(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const k of USAGE_KEYS) out[k] = numOrNull(raw[k]);
  return out;
}

// Build the economics object. Each evidence field carries its own availability marker.
export function buildEconomics({ authority = null, usage = null, agentTreeUsage = null, estimatedListCostUsd = null } = {}) {
  const u = usageObject(usage);
  const tree = Array.isArray(agentTreeUsage) && agentTreeUsage.length > 0 ? agentTreeUsage : null;
  const cost = numOrNull(estimatedListCostUsd);
  const availability = {
    usage: u !== null,
    agent_tree_usage: tree !== null,
    estimated_list_cost_usd: cost !== null,
  };
  const any = availability.usage || availability.agent_tree_usage || availability.estimated_list_cost_usd;
  return {
    authority: any ? authority : null,
    usage: u,
    usage_scope: u ? "top_level_excluding_subagents" : null,
    agent_tree_usage: tree,
    estimated_list_cost_usd: cost,
    availability,
  };
}

export function buildProcess({ exitCode = null, signal = null, completionState = "unknown" } = {}) {
  return {
    exit_code: Number.isInteger(exitCode) ? exitCode : null,
    signal: strOrNull(signal),
    completion_state: completionState,
  };
}

// Pure canonical builder. Callers (adapters) supply already-extracted authoritative fields.
export function buildManagedSessionRecord(input = {}) {
  const terminalAvailable = input.terminalResult?.available === true;
  const economics = input.economics ?? buildEconomics();
  const rp = input.routeProvenance;
  return {
    schema_version: SCHEMA_VERSION,
    run_id: strOrNull(input.runId),
    control_issue: refOrNull(input.controlIssue),
    execution_issue: refOrNull(input.executionIssue),
    lifecycle_stage: input.lifecycleStage ?? "OTHER",
    unit_id: strOrNull(input.unitId),
    surface: strOrNull(input.surface),
    provider: strOrNull(input.provider),
    model: strOrNull(input.model),
    route: strOrNull(input.route),
    route_provenance: rp
      ? {
          qualification_ref: strOrNull(rp.qualification_ref),
          fallback_used: typeof rp.fallback_used === "boolean" ? rp.fallback_used : null,
          preferred_unavailable: typeof rp.preferred_unavailable === "boolean" ? rp.preferred_unavailable : null,
        }
      : null,
    provider_session_id: strOrNull(input.providerSessionId),
    started_at: strOrNull(input.startedAt),
    ended_at: strOrNull(input.endedAt),
    process: input.process ?? buildProcess(),
    terminal_result: {
      available: terminalAvailable,
      state: terminalAvailable ? strOrNull(input.terminalResult.state) ?? "unknown" : "unavailable",
    },
    duration_ms: numOrNull(input.durationMs),
    turns: numOrNull(input.turns),
    economics,
    whole_run_complete: terminalAvailable && input.process?.completion_state !== "spawn_failed",
    adapter_evidence: input.adapterEvidence ?? null,
  };
}

function isNonNegNum(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function scanForbidden(obj, path, errors) {
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) errors.push(`forbidden content key at ${path}${k}`);
    scanForbidden(v, `${path}${k}.`, errors);
  }
}

// Validator: no vendor-named field is required. Returns { valid, errors }.
export function validateManagedSessionRecord(r) {
  const errors = [];
  if (!r || typeof r !== "object") return { valid: false, errors: ["record must be an object"] };
  if (r.schema_version !== SCHEMA_VERSION) errors.push("schema_version must be 1");
  if (typeof r.run_id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(r.run_id) || r.run_id.includes("..")) {
    errors.push("run_id must be a stable filename-safe string");
  }
  if (!LIFECYCLE_STAGES.includes(r.lifecycle_stage)) errors.push("lifecycle_stage invalid");
  for (const k of ["control_issue", "execution_issue"]) {
    if (r[k] !== null && !Number.isInteger(r[k])) errors.push(`${k} must be an integer or null`);
  }
  for (const k of ["unit_id", "surface", "provider", "model", "route", "provider_session_id", "started_at", "ended_at"]) {
    if (r[k] !== null && typeof r[k] !== "string") errors.push(`${k} must be a string or null`);
  }
  for (const k of ["duration_ms", "turns"]) {
    if (r[k] !== null && !isNonNegNum(r[k])) errors.push(`${k} must be a non-negative number or null`);
  }
  const p = r.process;
  if (!p || typeof p !== "object") errors.push("process required");
  else if (!COMPLETION_STATES.includes(p.completion_state)) errors.push("process.completion_state invalid");
  const t = r.terminal_result;
  if (!t || typeof t.available !== "boolean" || typeof t.state !== "string") errors.push("terminal_result {available,state} required");
  const e = r.economics;
  if (!e || typeof e !== "object" || !e.availability) errors.push("economics with availability required");
  else {
    if (e.authority !== null && !AUTHORITY_CLASSES.includes(e.authority)) errors.push("economics.authority invalid");
    for (const f of ["usage", "agent_tree_usage", "estimated_list_cost_usd"]) {
      const avail = e.availability[f];
      if (typeof avail !== "boolean") errors.push(`economics.availability.${f} must be boolean`);
      else if (!avail && e[f] !== null) errors.push(`economics.${f} must be null when unavailable`);
      else if (avail && e[f] === null) errors.push(`economics.${f} marked available but null`);
    }
    if (e.usage) for (const k of USAGE_KEYS) if (e.usage[k] !== null && !isNonNegNum(e.usage[k])) errors.push(`economics.usage.${k} invalid`);
    const anyAvail = Object.values(e.availability).some(Boolean);
    if (anyAvail && e.authority === null) errors.push("available economics require an authority marker");
  }
  if (typeof r.whole_run_complete !== "boolean") errors.push("whole_run_complete must be boolean");
  else if (r.whole_run_complete && !(t && t.available === true)) errors.push("whole_run_complete requires trustworthy terminal evidence");
  scanForbidden(r, "", errors);
  return { valid: errors.length === 0, errors };
}

// Deterministic persister: one compact JSON file per run, atomic rename, never throws.
// Shared by every record kind (session record, 389-C gate-outcome record): the caller supplies
// the validator for its own kind; identity/atomicity/never-throw behavior is identical.
export function persistRecordWith(record, validate, { dir = MANAGED_SESSIONS_DIR } = {}) {
  try {
    const v = validate(record);
    if (!v.valid) return { ok: false, error: `invalid record: ${v.errors.join("; ")}` };
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${record.run_id}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record)}
`, "utf8");
    renameSync(tmp, path);
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function persistManagedSessionRecord(record, opts = {}) {
  return persistRecordWith(record, validateManagedSessionRecord, opts);
}

function completionFromProcess({ exitCode, signal, spawnError }) {
  if (spawnError) return "spawn_failed";
  if (signal) return "interrupted";
  if (exitCode === 0) return "completed";
  if (Number.isInteger(exitCode)) return "failed";
  return "unknown";
}

// Claude adapter: extracts only authoritative fields from a #245-style terminal result.
// The result's `result` text is never read.
export function fromClaudeRun({ identity = {}, spawnResult = {} }) {
  const tr = spawnResult.terminalResult ?? null;
  const received = tr !== null && typeof tr === "object";
  const modelUsage = received ? tr.modelUsage ?? tr.model_usage : null;
  const tree =
    modelUsage && typeof modelUsage === "object"
      ? Object.entries(modelUsage).map(([model, u]) => ({
          model,
          input_tokens: numOrNull(u?.inputTokens ?? u?.input_tokens),
          output_tokens: numOrNull(u?.outputTokens ?? u?.output_tokens),
          cache_read_input_tokens: numOrNull(u?.cacheReadInputTokens ?? u?.cache_read_input_tokens),
          cache_creation_input_tokens: numOrNull(u?.cacheCreationInputTokens ?? u?.cache_creation_input_tokens),
          estimated_list_cost_usd: numOrNull(u?.costUSD ?? u?.costUsd ?? u?.cost_usd),
        }))
      : null;
  const economics = received
    ? buildEconomics({
        authority: "terminal_result",
        usage: tr.usage,
        agentTreeUsage: tree,
        estimatedListCostUsd: tr.total_cost_usd,
      })
    : buildEconomics();
  const state = received ? (tr.is_error === true ? "error" : strOrNull(tr.subtype) ?? "unknown") : "unavailable";
  return buildManagedSessionRecord({
    ...identity,
    surface: identity.surface ?? "claude-stream-json",
    provider: identity.provider ?? "anthropic",
    startedAt: spawnResult.startedAt,
    endedAt: spawnResult.endedAt,
    providerSessionId: (received ? tr.session_id : null) ?? spawnResult.initSessionId,
    process: buildProcess({
      exitCode: spawnResult.exitCode,
      signal: spawnResult.signal,
      completionState: completionFromProcess(spawnResult),
    }),
    terminalResult: { available: received, state },
    durationMs: received ? tr.duration_ms : null,
    turns: received ? tr.num_turns : null,
    economics,
    adapterEvidence: {
      kind: "claude_terminal_result",
      subtype: received ? strOrNull(tr.subtype) : null,
      is_error: received && typeof tr.is_error === "boolean" ? tr.is_error : null,
      duration_api_ms: received ? numOrNull(tr.duration_api_ms) : null,
    },
  });
}

// Generic adapter: a surface/process exposing no terminal result. Economics stay unavailable.
export function fromGenericRun({ identity = {}, run = {} }) {
  return buildManagedSessionRecord({
    ...identity,
    runId: identity.runId ?? run.run_id,
    surface: identity.surface ?? run.surface,
    provider: identity.provider ?? run.provider,
    model: identity.model ?? run.model,
    providerSessionId: run.provider_session_id,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    process: buildProcess({
      exitCode: run.exit_code,
      signal: run.signal,
      completionState: completionFromProcess({ exitCode: run.exit_code, signal: run.signal, spawnError: run.spawn_error }),
    }),
    terminalResult: { available: false },
    economics: buildEconomics(),
    adapterEvidence: null,
  });
}
