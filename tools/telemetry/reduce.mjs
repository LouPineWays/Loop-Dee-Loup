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

const ZERO_TOKEN_TOTALS = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, message_count: 0 };

// Merges two `{ [model]: {input_tokens, output_tokens, cache_creation_input_tokens,
// cache_read_input_tokens, message_count} }` breakdowns into a session-wide view (main
// transcript + subagent transcripts can each spend tokens on a different model). Same
// null-prototype guard as countBy below, and for the same reason.
function mergeByModel(a, b) {
  const merged = Object.create(null);
  for (const breakdown of [a, b]) {
    for (const [model, totals] of Object.entries(breakdown)) {
      if (!merged[model]) merged[model] = { ...ZERO_TOKEN_TOTALS };
      merged[model].input_tokens += totals.input_tokens;
      merged[model].output_tokens += totals.output_tokens;
      merged[model].cache_creation_input_tokens += totals.cache_creation_input_tokens;
      merged[model].cache_read_input_tokens += totals.cache_read_input_tokens;
      merged[model].message_count += totals.message_count;
    }
  }
  return { ...merged };
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
  const transcriptUsageSamples = events.filter((e) => e && e.kind === "transcript_usage");

  const sessionStart = hookEvents.find((e) => e.event === "SessionStart") ?? null;
  const sessionEndCandidates = hookEvents.filter((e) => e.event === "SessionEnd");
  const sessionEnd = sessionEndCandidates.length > 0 ? sessionEndCandidates[sessionEndCandidates.length - 1] : null;
  const preCompactions = hookEvents.filter((e) => e.event === "PreCompact");
  const postCompactions = hookEvents.filter((e) => e.event === "PostCompact");
  const subagentStarts = hookEvents.filter((e) => e.event === "SubagentStart");
  const subagentStops = hookEvents.filter((e) => e.event === "SubagentStop");

  const lastSample = samples.length > 0 ? samples[samples.length - 1] : null;
  const lastTranscriptUsage = transcriptUsageSamples.length > 0 ? transcriptUsageSamples[transcriptUsageSamples.length - 1] : null;
  const sessionId = firstNonNull([
    sessionStart?.session_id,
    sessionEnd?.session_id,
    lastSample?.session_id,
    lastTranscriptUsage?.session_id,
    events[0]?.session_id,
  ]);

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
    // Recovered from the session's own transcript (see transcript.mjs) — the mechanism
    // that works in this repository's normal non-interactive execution mode, unlike the
    // statusLine-derived fields above. null (not zero) when no transcript_usage event
    // ever landed, e.g. the session crashed before SessionEnd/PreCompact fired, or ran on
    // a Claude Code build too old to expose transcript_path in its hook payloads.
    token_usage_main_total: lastTranscriptUsage?.main?.total ?? null,
    token_usage_main_by_model: lastTranscriptUsage?.main?.by_model ?? null,
    token_usage_subagent_total: lastTranscriptUsage?.subagents?.total ?? null,
    token_usage_subagent_by_agent_type: lastTranscriptUsage?.subagents?.by_agent_type ?? null,
    token_usage_subagent_by_model: lastTranscriptUsage?.subagents?.by_model ?? null,
    token_usage_subagent_count: lastTranscriptUsage?.subagents?.agent_count ?? null,
    // Session-wide per-model view (main + subagent tokens merged): only computed when
    // both portions are actually measured, since merging one real breakdown with one
    // missing/incomplete portion would silently understate a model that only a subagent
    // used — the same false-completeness shape as an unmeasured field standing in for a
    // real zero (found in review of #139/PR #144).
    token_usage_session_by_model:
      lastTranscriptUsage?.main?.by_model && lastTranscriptUsage?.subagents?.by_model
        ? mergeByModel(lastTranscriptUsage.main.by_model, lastTranscriptUsage.subagents.by_model)
        : null,
    // True only when the most recent transcript_usage event was captured at SessionEnd —
    // a PreCompact-triggered one (or none at all) reflects only usage accumulated up to
    // that point, not the whole session, so a "was expenditure appropriately allocated"
    // claim must not treat that partial snapshot as covering the full session (found in
    // review of #139/PR #144).
    token_usage_is_session_complete: lastTranscriptUsage?.event === "SessionEnd",
    transcript_usage_sample_count: transcriptUsageSamples.length,
    // How many raw hook-kind events this session produced at all, regardless of type.
    // Exists so a claim resting on an empty array (e.g. "zero compactions") can require
    // evidence the collection mechanism actually observed the session, not just that the
    // array defaults to [] the same way it would if no hook ever fired — see
    // sufficiency.mjs's requiresPositive.
    hook_event_count: hookEvents.length,
    // Always null: this collector has no local pricing table, so per-model monetary cost
    // can never be computed from token counts alone (see README's "What it deliberately
    // still cannot measure"). Kept as a real field, not merely a name in `unknown` below,
    // so sufficiency.mjs can gate a per-model-cost claim on it honestly (found in review
    // of #139/PR #144 — the prior single `monetary_cost` claim type let a per-model cost
    // question pass on session-total cost alone).
    cost_usd_by_model: null,
  };

  const tokenFieldSum = (totals) =>
    totals ? totals.input_tokens + totals.output_tokens + totals.cache_creation_input_tokens + totals.cache_read_input_tokens : null;
  const mainTokenSum = tokenFieldSum(measured.token_usage_main_total);
  const subagentTokenSum = tokenFieldSum(measured.token_usage_subagent_total);
  const tokenGrandTotal = mainTokenSum !== null && subagentTokenSum !== null ? mainTokenSum + subagentTokenSum : null;

  const derived = {
    session_wall_duration_ms:
      sessionStart?.ts && sessionEnd?.ts ? Date.parse(sessionEnd.ts) - Date.parse(sessionStart.ts) : null,
    compaction_count: preCompactions.length,
    subagent_invocation_count: subagentStarts.length,
    subagent_type_counts: countBy(subagentStarts, (s) => (s.agent_type && s.agent_type.trim()) || "unknown"),
    peak_context_used_percentage: usedPctSamples.length > 0 ? Math.max(...usedPctSamples) : null,
    cost_usd_peak: costUsdSamples.length > 0 ? Math.max(...costUsdSamples) : null,
    // Plain arithmetic over the transcript-derived totals above — never a judgment about
    // whether the split was appropriate. That's .claude/skills/spend's job.
    token_usage_grand_total: tokenGrandTotal,
    token_usage_main_share_of_total: tokenGrandTotal !== null && tokenGrandTotal > 0 ? mainTokenSum / tokenGrandTotal : null,
  };

  // Named structurally, not inferred from what happens to be null this run: these are
  // facts this collection mechanism cannot establish regardless of how complete the raw
  // log is, per issue #45's "a field that cannot be measured reliably must remain unknown
  // rather than being estimated with false precision."
  const unknown = [
    // No Claude Code interface this collector uses exposes a skill-invocation boundary
    // (unlike the Task/Agent tool, which the transcript's subagent files structurally
    // separate) — so per-skill token/cost attribution is unavailable regardless of
    // whether transcript_usage landed this session.
    "per_skill_token_or_cost_attribution",
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
  // Transcript-derived evidence is a separate mechanism from statusLine's samples and can
  // be absent even when statusLine data exists (or vice versa). Check the actual field,
  // not just "did any transcript_usage event land": collectTranscriptUsage can produce an
  // event whose `main` or `subagents` portion is independently null when that specific
  // read was incomplete (a torn line, or an unreadable discovered subagent transcript —
  // see transcript.mjs), so a landed event does not guarantee either field was measured.
  // When a transcript_usage event did land and no subagents ran, subagent totals are
  // legitimately zero, not unmeasured — this only fires when the field is truly null.
  if (measured.token_usage_main_total === null) unknown.push("token_usage_main_total");
  if (measured.token_usage_subagent_total === null) unknown.push("token_usage_subagent_total");
  if (measured.token_usage_main_total === null || measured.token_usage_subagent_total === null) {
    unknown.push("token_usage_grand_total");
  }

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
