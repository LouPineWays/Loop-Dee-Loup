// Tests for tools/telemetry/reduce.mjs's pure reduction logic against the fixtures in
// tools/telemetry/fixtures/. Run with:
//   node --test tools/telemetry/reduce.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reduceEvents } from "./reduce.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");

function loadFixture(name) {
  const raw = readFileSync(join(FIXTURES_DIR, name), "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("normal single-agent session: measured facts come straight from the last sample", () => {
  const record = reduceEvents(loadFixture("normal.jsonl"));
  assert.equal(record.measured.identity.session_id, "fixture-normal-0001");
  assert.deepEqual(record.measured.identity.repo, { owner: "LouPineWays", name: "example-repo" });
  assert.equal(record.measured.cost_usd_total, 1.85);
  assert.equal(record.measured.statusline_sample_count, 2);
  assert.equal(record.measured.session_start_ts, "2026-08-24T10:00:00.000Z");
  assert.equal(record.measured.session_end_ts, "2026-08-24T10:25:00.000Z");
  assert.equal(record.derived.session_wall_duration_ms, 25 * 60 * 1000);
  assert.equal(record.derived.compaction_count, 0);
  assert.equal(record.derived.subagent_invocation_count, 0);
  assert.equal(record.derived.cost_usd_peak, 1.85);
});

test("no scores or judgments leak into the reduced record's own keys", () => {
  const record = reduceEvents(loadFixture("normal.jsonl"));
  const banned = /score|grade|rank|efficiency|productiv|quality|good|bad/i;
  const flat = JSON.stringify(record);
  assert.equal(banned.test(flat), false, `record must not contain judgment-shaped content: ${flat}`);
});

test("session with subagents but no transcript_usage event: start/stop pairs are counted and typed, tokens stay unattributed", () => {
  const record = reduceEvents(loadFixture("subagents.jsonl"));
  assert.equal(record.derived.subagent_invocation_count, 3);
  assert.deepEqual(record.derived.subagent_type_counts, { Explore: 1, "general-purpose": 2 });
  assert.equal(record.measured.subagent_start_events.length, 3);
  assert.equal(record.measured.subagent_stop_events.length, 3);
  assert.equal(record.measured.token_usage_main_total, null);
  assert.equal(record.measured.token_usage_subagent_total, null);
  assert.ok(record.unknown.includes("per_skill_token_or_cost_attribution"));
  assert.ok(record.unknown.includes("token_usage_main_total"));
  assert.ok(record.unknown.includes("token_usage_subagent_total"));
});

test("session with a transcript_usage event: per-model and per-subagent-type token totals are measured, not unknown", () => {
  const record = reduceEvents(loadFixture("transcript_usage.jsonl"));
  assert.equal(record.measured.transcript_usage_sample_count, 2);
  // The last transcript_usage event (SessionEnd) wins over the earlier PreCompact one.
  assert.deepEqual(record.measured.token_usage_main_total, {
    input_tokens: 600,
    output_tokens: 9000,
    cache_creation_input_tokens: 55000,
    cache_read_input_tokens: 420000,
    message_count: 26,
  });
  assert.deepEqual(record.measured.token_usage_subagent_by_agent_type.Explore, {
    input_tokens: 50,
    output_tokens: 900,
    cache_creation_input_tokens: 2000,
    cache_read_input_tokens: 15000,
    message_count: 4,
  });
  assert.equal(record.measured.token_usage_subagent_count, 1);
  assert.equal(record.derived.token_usage_grand_total, 502550);
  assert.ok(Math.abs(record.derived.token_usage_main_share_of_total - 484600 / 502550) < 1e-9);
  assert.equal(record.unknown.includes("token_usage_main_total"), false);
  assert.equal(record.unknown.includes("token_usage_subagent_total"), false);
  // Still genuinely unavailable: no Claude Code interface this collector uses exposes a
  // skill-invocation boundary the way it does for subagents.
  assert.ok(record.unknown.includes("per_skill_token_or_cost_attribution"));
});

test("incomplete telemetry (crash before SessionEnd, no samples): missing facts are named unknown, not guessed", () => {
  const record = reduceEvents(loadFixture("incomplete.jsonl"));
  assert.equal(record.measured.cost_usd_total, null);
  assert.equal(record.measured.session_end_ts, null);
  assert.equal(record.derived.session_wall_duration_ms, null);
  assert.ok(record.unknown.includes("cost_usd_total"));
  assert.ok(record.unknown.includes("context_window_size"));
  assert.ok(record.unknown.includes("session_end_ts"));
  assert.ok(record.unknown.includes("session_wall_duration_ms"));
});

test("compaction events: PreCompact/PostCompact are recorded and the pre-compaction peak survives", () => {
  const record = reduceEvents(loadFixture("compaction.jsonl"));
  assert.equal(record.derived.compaction_count, 1);
  assert.equal(record.measured.compaction_events.length, 2);
  assert.equal(record.measured.compaction_events[0].event, "PreCompact");
  assert.equal(record.measured.compaction_events[0].trigger, "auto");
  // The last sample reports 10.1% post-compaction, but the session did peak at 88.3%
  // beforehand — a reducer that only looked at the last sample would hide that peak.
  assert.equal(record.measured.last_context_used_percentage, 10.1);
  assert.equal(record.derived.peak_context_used_percentage, 88.3);
});

test("statusline sample taken before the first API call: a sample exists but its cost/context fields are still unknown", () => {
  // Regression test: the reducer must not treat "at least one sample was collected" as
  // proof cost/context data was measured — a pre-first-API-call statusLine render reports
  // cost:null/context_window:null even though a sample genuinely fired.
  const record = reduceEvents(loadFixture("pre_api_sample.jsonl"));
  assert.equal(record.measured.statusline_sample_count, 1);
  assert.equal(record.measured.cost_usd_total, null);
  assert.ok(record.unknown.includes("cost_usd_total"));
  assert.ok(record.unknown.includes("context_window_size"));
  assert.ok(record.unknown.includes("token_usage"));
});

test("subagent_type_counts survives an agent type named like a built-in object property", () => {
  const record = reduceEvents([
    { kind: "hook", event: "SubagentStart", session_id: "s-1", agent_type: "constructor", ts: "2026-08-24T00:00:00.000Z" },
    { kind: "hook", event: "SubagentStart", session_id: "s-1", agent_type: "constructor", ts: "2026-08-24T00:01:00.000Z" },
    { kind: "hook", event: "SubagentStart", session_id: "s-1", agent_type: "__proto__", ts: "2026-08-24T00:02:00.000Z" },
  ]);
  assert.equal(record.derived.subagent_type_counts.constructor, 2);
  assert.equal(record.derived.subagent_type_counts.__proto__, 1);
  assert.equal(Object.keys(record.derived.subagent_type_counts).sort().join(","), "__proto__,constructor");
});

test("subagent_type_counts treats an empty-string agent_type as unknown, not a silent separate bucket", () => {
  // Regression test for issue #103: a genuine SubagentStop hook payload was observed with
  // agent_type: "" (empty string, not null/undefined). `??` only replaces null/undefined,
  // so an unguarded `s.agent_type ?? "unknown"` would fragment counts into a silent "" key.
  const record = reduceEvents([
    { kind: "hook", event: "SubagentStart", session_id: "s-1", agent_type: "", ts: "2026-08-24T00:00:00.000Z" },
    { kind: "hook", event: "SubagentStart", session_id: "s-1", agent_type: "  ", ts: "2026-08-24T00:01:00.000Z" },
    { kind: "hook", event: "SubagentStart", session_id: "s-1", agent_type: "Explore", ts: "2026-08-24T00:02:00.000Z" },
  ]);
  assert.deepEqual(record.derived.subagent_type_counts, { unknown: 2, Explore: 1 });
  assert.equal(Object.prototype.hasOwnProperty.call(record.derived.subagent_type_counts, ""), false);
});

test("empty event log: every measured fact is null and nothing is fabricated", () => {
  const record = reduceEvents([]);
  assert.equal(record.measured.identity.session_id, null);
  assert.equal(record.measured.cost_usd_total, null);
  assert.equal(record.derived.subagent_invocation_count, 0);
  assert.equal(record.derived.session_wall_duration_ms, null);
});
