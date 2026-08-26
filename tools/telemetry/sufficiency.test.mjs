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

test("an empty event log is INSUFFICIENT for every claim type that needs measured evidence, but compaction/subagent claims still resolve on their (empty) structural fields", () => {
  const record = reduceEvents([]);
  assert.equal(assessSufficiency(record, "token_allocation").verdict, "INSUFFICIENT");
  assert.equal(assessSufficiency(record, "monetary_cost").verdict, "INSUFFICIENT");
  // Zero compactions / zero subagent starts is still a measured "nothing happened" fact —
  // an empty array, not a missing one.
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
    assert.ok(Array.isArray(spec.requires) && spec.requires.length > 0, `${claimType} needs at least one required field`);
  }
});
