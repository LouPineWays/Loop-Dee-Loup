// Tests for tools/telemetry/coverage.mjs, built for issue #199's telemetry-battery
// aggregation. Run with: node --test tools/telemetry/coverage.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reduceEvents } from "./reduce.mjs";
import { CLAIM_REQUIREMENTS } from "./sufficiency.mjs";
import { buildCoverageReport, decisionCriticalFields } from "./coverage.mjs";

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

test("decisionCriticalFields is derived from CLAIM_REQUIREMENTS, not a separate hardcoded list", () => {
  const expected = new Set();
  for (const spec of Object.values(CLAIM_REQUIREMENTS)) {
    for (const f of [...(spec.requires ?? []), ...(spec.requiresPositive ?? []), ...(spec.requiresTrue ?? [])]) {
      expected.add(f);
    }
  }
  assert.deepEqual(decisionCriticalFields(), [...expected].sort());
  // Regression guard: if a future claim type is added to CLAIM_REQUIREMENTS, this list
  // must grow with it automatically rather than needing a matching manual edit here.
  assert.ok(decisionCriticalFields().includes("measured.token_usage_main_total"));
});

test("an empty sample is INSUFFICIENT and every decision-critical field reports unavailable", () => {
  const report = buildCoverageReport([]);
  assert.equal(report.sampleSize, 0);
  assert.equal(report.telemetryVerdict, "INSUFFICIENT");
  assert.equal(report.captured.length, 0);
  assert.equal(report.unavailable.length, report.requiredFields.length);
  assert.deepEqual(report.decisionCriticalGaps.sort(), report.requiredFields.slice().sort());
});

test("a field present in every sampled session is captured, not merely partial", () => {
  const record = reduceEvents(loadFixture("transcript_usage.jsonl"));
  const report = buildCoverageReport([record, record, record]);
  assert.equal(report.fieldStatus["measured.token_usage_main_total"].status, "captured");
  assert.ok(report.captured.includes("measured.token_usage_main_total"));
  assert.ok(!report.decisionCriticalGaps.includes("measured.token_usage_main_total"));
});

test("a field present in only some sampled sessions is partial, and counts as a decision-critical gap", () => {
  const complete = reduceEvents(loadFixture("transcript_usage.jsonl"));
  const incomplete = reduceEvents(loadFixture("subagents.jsonl"));
  const report = buildCoverageReport([complete, incomplete]);
  const status = report.fieldStatus["measured.token_usage_main_total"];
  assert.equal(status.status, "partial");
  assert.equal(status.presentInSample, 1);
  assert.equal(status.sampleSize, 2);
  assert.ok(report.decisionCriticalGaps.includes("measured.token_usage_main_total"));
  assert.ok(!report.captured.includes("measured.token_usage_main_total"));
});

test("a field present in zero sampled sessions is unavailable", () => {
  // subagents.jsonl has hook + statusline_sample events but no transcript_usage event
  // (issue #120's evidence shape), so the transcript-derived token totals are null.
  const record = reduceEvents(loadFixture("subagents.jsonl"));
  const report = buildCoverageReport([record]);
  assert.equal(report.fieldStatus["measured.token_usage_main_total"].status, "unavailable");
  assert.ok(report.unavailable.includes("measured.token_usage_main_total"));
});

test("monetary_cost_by_model is always unavailable, even with real transcript usage: no local pricing table computes it", () => {
  const record = reduceEvents(loadFixture("transcript_usage.jsonl"));
  const report = buildCoverageReport([record, record]);
  assert.equal(report.fieldStatus["measured.cost_usd_by_model"].status, "unavailable");
  assert.equal(report.telemetryVerdict, "INSUFFICIENT");
});

test("structural not-applicable fields are reported separately from decision-critical gaps", () => {
  const record = reduceEvents(loadFixture("subagents.jsonl"));
  const report = buildCoverageReport([record]);
  assert.ok(report.notApplicable.includes("per_skill_token_or_cost_attribution"));
  assert.ok(!report.decisionCriticalGaps.includes("per_skill_token_or_cost_attribution"));
});

test("telemetryVerdict is SUFFICIENT only when every decision-critical field is captured across the whole sample", () => {
  // monetary_cost_by_model can never be captured (no local pricing table — see the
  // README's "What it deliberately still cannot measure"), so a fully SUFFICIENT verdict
  // is not reachable today. This fixture also carries no statusline_sample event (this
  // repository's confirmed non-interactive statusLine gap), so cost_usd_total is missing
  // too — the report must name both rather than silently excluding either.
  const record = reduceEvents(loadFixture("transcript_usage.jsonl"));
  const report = buildCoverageReport([record]);
  assert.equal(report.telemetryVerdict, "INSUFFICIENT");
  assert.deepEqual(report.decisionCriticalGaps.sort(), ["measured.cost_usd_by_model", "measured.cost_usd_total"]);
});

test("derivedFields reflects the sample's own derived section rather than a hardcoded list", () => {
  const record = reduceEvents(loadFixture("transcript_usage.jsonl"));
  const report = buildCoverageReport([record]);
  assert.deepEqual(report.derivedFields.sort(), Object.keys(record.derived).sort());
});
