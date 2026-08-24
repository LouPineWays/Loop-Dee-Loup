#!/usr/bin/env node
// Reduces one session's raw telemetry events (collected by hook.mjs / statusline.mjs)
// into a compact, deterministic session evidence record: the format .claude/skills/spend
// consumes instead of reconstructing session facts from /usage, /context, or the
// transcript. See tools/telemetry/README.md for the full contract this implements.
//
// The record has exactly three top-level sections, per issue #45's requirement to keep
// measurement separate from interpretation:
//   - measured  — values taken directly from collected events, with no arithmetic;
//   - derived   — deterministic arithmetic/aggregation over measured values;
//   - unknown   — evidence this collector structurally cannot establish, named
//                 explicitly rather than left silently absent or guessed at.
//
// This module performs no judgment: no score, grade, ranking, or "good/bad" threshold.
// That boundary is deliberate — see the Non-goals section of issue #45. Judgment is
// .claude/skills/spend's job, applied on top of this record.
//
// Usage:
//   node tools/telemetry/reduce.mjs <session_id> [--out <path>]
//     Reads .claude/telemetry/sessions/<session_id>.jsonl (or $LDL_TELEMETRY_DIR
//     equivalent), prints the record as JSON to stdout, and additionally writes it to
//     --out (or .claude/telemetry/records/<session_id>.json when --out is omitted).
//
// Tests: node --test tools/telemetry/reduce.test.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readSessionEvents, sanitizeSessionId, RECORDS_DIR } from "./collect.mjs";

function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function firstNonNull(values) {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function countBy(items, keyFn) {
  // Accumulate on a null-prototype object: a plain {} would read an inherited
  // Object.prototype property (e.g. a custom agent type literally named "constructor")
  // instead of undefined when incrementing, and a key named "__proto__" would vanish into
  // the prototype chain rather than being counted. Spread the result into a normal object
  // before returning so the record's JSON shape stays a plain object either way — the
  // spread only copies the counts' own enumerable keys, so it can't reintroduce either bug.
  const counts = Object.create(null);
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return { ...counts };
}

// Pure function: takes the raw parsed event array for one session and returns the
// normalized record. Kept independent of the filesystem so fixtures can exercise it
// directly without touching disk.
export function reduceEvents(events) {
  const hookEvents = events.filter((e) => e && e.kind === "hook");
  const samples = events.filter((e) => e && e.kind === "statusline_sample");

  const sessionStart = hookEvents.find((e) => e.event === "SessionStart") ?? null;
  const sessionEndCandidates = hookEvents.filter((e) => e.event === "SessionEnd");
  const sessionEnd = sessionEndCandidates.length > 0 ? sessionEndCandidates[sessionEndCandidates.length - 1] : null;
  const preCompactions = hookEvents.filter((e) => e.event === "PreCompact");
  const postCompactions = hookEvents.filter((e) => e.event === "PostCompact");
  const subagentStarts = hookEvents.filter((e) => e.event === "SubagentStart");
  const subagentStops = hookEvents.filter((e) => e.event === "SubagentStop");

  const lastSample = samples.length > 0 ? samples[samples.length - 1] : null;
  const sessionId = firstNonNull([sessionStart?.session_id, sessionEnd?.session_id, lastSample?.session_id, events[0]?.session_id]);

  const identity = {
    session_id: sessionId,
    repo: firstNonNull(events.map((e) => e?.repo ?? null)),
    cwd_basename: firstNonNull(events.map((e) => e?.cwd_basename ?? null)),
  };

  const costUsdSamples = samples.map((s) => s.cost?.total_cost_usd).filter(isNum);
  const usedPctSamples = samples.map((s) => s.context_window?.used_percentage).filter(isNum);

  const measured = {
    identity,
    model: {
      id: lastSample?.model_id ?? null,
      display_name: lastSample?.model_display_name ?? null,
    },
    cost_usd_total: lastSample?.cost?.total_cost_usd ?? null,
    duration_ms_total: lastSample?.cost?.total_duration_ms ?? null,
    api_duration_ms_total: lastSample?.cost?.total_api_duration_ms ?? null,
    lines_added_total: lastSample?.cost?.total_lines_added ?? null,
    lines_removed_total: lastSample?.cost?.total_lines_removed ?? null,
    context_window_size: lastSample?.context_window?.context_window_size ?? null,
    last_context_used_percentage: lastSample?.context_window?.used_percentage ?? null,
    last_token_usage: lastSample?.context_window?.current_usage ?? null,
    statusline_sample_count: samples.length,
    session_start_ts: sessionStart?.ts ?? null,
    session_end_ts: sessionEnd?.ts ?? null,
    session_end_reason: sessionEnd?.reason ?? null,
    compaction_events: [...preCompactions, ...postCompactions]
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
      .map((c) => ({ event: c.event, trigger: c.trigger ?? null, ts: c.ts })),
    subagent_start_events: subagentStarts.map((s) => ({ agent_id: s.agent_id ?? null, agent_type: s.agent_type ?? null, ts: s.ts })),
    subagent_stop_events: subagentStops.map((s) => ({ agent_id: s.agent_id ?? null, agent_type: s.agent_type ?? null, ts: s.ts })),
  };

  const derived = {
    session_wall_duration_ms:
      sessionStart?.ts && sessionEnd?.ts ? Date.parse(sessionEnd.ts) - Date.parse(sessionStart.ts) : null,
    compaction_count: preCompactions.length,
    subagent_invocation_count: subagentStarts.length,
    subagent_type_counts: countBy(subagentStarts, (s) => s.agent_type ?? "unknown"),
    peak_context_used_percentage: usedPctSamples.length > 0 ? Math.max(...usedPctSamples) : null,
    cost_usd_peak: costUsdSamples.length > 0 ? Math.max(...costUsdSamples) : null,
  };

  // Named structurally, not inferred from what happens to be null this run: these are
  // facts this collection mechanism cannot establish regardless of how complete the raw
  // log is, per issue #45's "a field that cannot be measured reliably must remain unknown
  // rather than being estimated with false precision."
  const unknown = [
    "per_subagent_or_per_skill_token_or_cost_attribution",
    "input_output_cache_token_breakdown_by_individual_turn",
    "monetary_cost_breakdown_by_model_when_multiple_models_used_in_one_session",
    "rate_limit_consumption",
  ];
  // Check the actual measured fields, not just whether any sample exists: a sample taken
  // before the session's first API call (or from a client that omits cost/context_window
  // entirely) still counts as "a sample", but its cost/context_window sub-fields are null,
  // and those specific facts were genuinely never measured either way.
  if (measured.cost_usd_total === null) unknown.push("cost_usd_total");
  if (measured.context_window_size === null) unknown.push("context_window_size");
  if (measured.last_token_usage === null) unknown.push("token_usage");
  if (!sessionStart) unknown.push("session_start_ts");
  if (!sessionEnd) unknown.push("session_end_ts", "session_wall_duration_ms");

  return { measured, derived, unknown };
}

export function reduceSession(sessionId) {
  const events = readSessionEvents(sessionId);
  return { generated_at: new Date().toISOString(), ...reduceEvents(events) };
}

function parseArgs(argv) {
  const args = { sessionId: null, out: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") {
      args.out = argv[i + 1] ?? null;
      i += 1;
    } else {
      rest.push(argv[i]);
    }
  }
  args.sessionId = rest[0] ?? null;
  return args;
}

function main() {
  const { sessionId, out } = parseArgs(process.argv.slice(2));
  if (!sessionId) {
    console.error("Usage: node tools/telemetry/reduce.mjs <session_id> [--out <path>]");
    process.exitCode = 1;
    return;
  }
  const record = reduceSession(sessionId);
  const json = JSON.stringify(record, null, 2);
  console.log(json);
  const outPath = out || join(RECORDS_DIR, `${sanitizeSessionId(sessionId)}.json`);
  mkdirSync(join(outPath, ".."), { recursive: true });
  writeFileSync(outPath, `${json}\n`, "utf8");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
