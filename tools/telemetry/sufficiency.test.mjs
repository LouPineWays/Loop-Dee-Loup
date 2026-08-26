// Tests for tools/telemetry/sufficiency.mjs, including the regression test for issue
// #139/#120: an economic claim must come back INSUFFICIENT when the record lacks the
// evidence that claim needs, even when no separate structural defect was found. Run with:
//   node --test tools/telemetry/sufficiency.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reduceEvents } from "./reduce.mjs";
import { assessSufficiency, CLAIM_REQUIREMENTS } from "./sufficiency.mjs";

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

test("regression (#120/#139): a session with only structural hook events and no token-economic telemetry cannot answer the token_allocation claim", () => {
  // This is issue #120's evidence shape: hook-based structural events fired, but no
  // statusline_sample and (pre-fix) no transcript_usage ever landed — exactly the
  // condition under which #120 closed CLEAN despite never measuring what it was asked
  // to evaluate. subagents.jsonl reproduces that: subagent start/stop pairs exist, but
  // no transcript_usage event carries their token totals.
  const record = reduceEvents(loadFixture("subagents.jsonl"));
  const result = assessSufficiency(record, "token_allocation");
  assert.equal(result.verdict, "INSUFFICIENT");
  assert.ok(result.missingFields.includes("measured.token_usage_main_total"));
  assert.ok(result.missingFields.includes("measured.token_usage_subagent_total"));
  // The bug this issue fixes: /spend must not be able to treat this as CLEAN for an
  // economic claim just because no other defect was independently proven. An INSUFFICIENT
  // verdict here is the mechanism that forces /spend's report to say INCONCLUSIVE instead.
  assert.notEqual(result.verdict, "SUFFICIENT");
});

test("a session with a real transcript_usage event answers the token_allocation claim as SUFFICIENT", () => {
  const record = reduceEvents(loadFixture("transcript_usage.jsonl"));
  const result = assessSufficiency(record, "token_allocation");
  assert.equal(result.verdict, "SUFFICIENT");
  assert.deepEqual(result.missingFields, []);
});

test("a narrower structural claim (compaction_frequency) stays SUFFICIENT even when token-economic evidence is entirely absent", () => {
  // Requirement #139-7's example: missing token/model attribution must not block a
  // narrower claim compaction_events already answers on its own.
  const record = reduceEvents(loadFixture("subagents.jsonl"));
  const tokenResult = assessSufficiency(record, "token_allocation");
  const compactionResult = assessSufficiency(record, "compaction_frequency");
  assert.equal(tokenResult.verdict, "INSUFFICIENT");
  assert.equal(compactionResult.verdict, "SUFFICIENT");
});

test("subagent_invocation_pattern is answerable from hook events alone, without any transcript_usage evidence", () => {
  const record = reduceEvents(loadFixture("subagents.jsonl"));
  const result = assessSufficiency(record, "subagent_invocation_pattern");
  assert.equal(result.verdict, "SUFFICIENT");
});

test("an empty event log is INSUFFICIENT for every claim type, including compaction/subagent claims: an empty array alone doesn't prove the mechanism ran", () => {
  // Regression test (review of #139/PR #144): compaction_events and subagent_start_events
  // default to [] whether or not any hook ever actually fired — a session where telemetry
  // never ran at all looks identical to one confirmed to have zero compactions unless
  // sufficiency also requires positive evidence (hook_event_count > 0) the mechanism
  // observed the session.
  const record = reduceEvents([]);
  assert.equal(assessSufficiency(record, "token_allocation").verdict, "INSUFFICIENT");
  assert.equal(assessSufficiency(record, "monetary_cost_total").verdict, "INSUFFICIENT");
  assert.equal(assessSufficiency(record, "monetary_cost_by_model").verdict, "INSUFFICIENT");
  assert.equal(assessSufficiency(record, "compaction_frequency").verdict, "INSUFFICIENT");
  assert.equal(assessSufficiency(record, "subagent_invocation_pattern").verdict, "INSUFFICIENT");
});

test("monetary_cost_by_model is always INSUFFICIENT, even with a real transcript_usage event: no local pricing table computes per-model cost", () => {
  const record = reduceEvents(loadFixture("transcript_usage.jsonl"));
  const result = assessSufficiency(record, "monetary_cost_by_model");
  assert.equal(result.verdict, "INSUFFICIENT");
  assert.deepEqual(result.missingFields, ["measured.cost_usd_by_model"]);
});

test("token_allocation is INSUFFICIENT for a PreCompact-only snapshot, even though main/subagent totals are both present", () => {
  // Regression test (review of #139/PR #144): a session that crashed after a compaction
  // but before SessionEnd only has a partial, pre-compaction transcript_usage snapshot.
  // Both totals being non-null must not be mistaken for whole-session coverage.
  const record = reduceEvents(loadFixture("transcript_usage_precompact_only.jsonl"));
  assert.equal(record.measured.token_usage_main_total !== null, true);
  assert.equal(record.measured.token_usage_is_session_complete, false);
  const result = assessSufficiency(record, "token_allocation");
  assert.equal(result.verdict, "INSUFFICIENT");
  assert.ok(result.missingFields.includes("measured.token_usage_is_session_complete"));
});

test("zero compactions/subagents backed by real hook events (hook_event_count > 0) is SUFFICIENT, not just an empty array", () => {
  const record = reduceEvents([
    { kind: "hook", event: "SessionStart", session_id: "s-1", ts: "2026-08-26T00:00:00.000Z" },
    { kind: "hook", event: "SessionEnd", session_id: "s-1", ts: "2026-08-26T00:05:00.000Z" },
  ]);
  assert.equal(record.measured.hook_event_count, 2);
  assert.deepEqual(record.measured.compaction_events, []);
  assert.deepEqual(record.measured.subagent_start_events, []);
  assert.equal(assessSufficiency(record, "compaction_frequency").verdict, "SUFFICIENT");
  assert.equal(assessSufficiency(record, "subagent_invocation_pattern").verdict, "SUFFICIENT");
});

test("assessSufficiency throws on an unrecognized claim type rather than silently passing it", () => {
  const record = reduceEvents([]);
  assert.throws(() => assessSufficiency(record, "not_a_real_claim"), /Unknown claim type/);
});

test("every declared claim type has a non-empty label and at least one required field", () => {
  for (const [claimType, spec] of Object.entries(CLAIM_REQUIREMENTS)) {
    assert.ok(spec.label && spec.label.length > 0, `${claimType} needs a label`);
    const requiredCount = (spec.requires?.length ?? 0) + (spec.requiresPositive?.length ?? 0);
    assert.ok(requiredCount > 0, `${claimType} needs at least one required field`);
  }
});
