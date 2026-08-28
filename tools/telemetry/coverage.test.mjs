// Tests for tools/telemetry/coverage.mjs, built for issue #199's telemetry-battery
// aggregation. Run with: node --test tools/telemetry/coverage.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reduceEvents } from "./reduce.mjs";
import { CLAIM_REQUIREMENTS } from "./sufficiency.mjs";
import { buildCoverageReport, decisionCriticalFields, listRecentSessionIds, listSessionIdsSince, resolveSessionIds } from "./coverage.mjs";

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

test("derivedFields reflects the union of the sample's own derived sections rather than a hardcoded list", () => {
  const record = reduceEvents(loadFixture("transcript_usage.jsonl"));
  const report = buildCoverageReport([record]);
  assert.deepEqual(report.derivedFields.sort(), Object.keys(record.derived).sort());
});

test("regression (Stage 1 review, PR #203): a requiresPositive field with value 0 is not counted as captured", () => {
  // hook_event_count is requiresPositive for compaction_frequency/subagent_invocation_pattern
  // (sufficiency.mjs) precisely because an empty array looks identical whether the
  // mechanism ran and observed zero events, or never ran at all. A generic presence check
  // (isPresent(0) === true) would wrongly report this field captured; the coverage report
  // must apply the same predicate assessSufficiency does.
  const record = reduceEvents([
    { kind: "hook", event: "SessionStart", session_id: "s-1", ts: "2026-08-26T00:00:00.000Z" },
  ]);
  assert.equal(record.measured.hook_event_count, 1);
  // Force the zero case directly against reduceEvents([]) too, since a SessionStart-only
  // session already has hook_event_count 1 above.
  const emptyRecord = reduceEvents([]);
  assert.equal(emptyRecord.measured.hook_event_count, 0);
  const report = buildCoverageReport([emptyRecord]);
  assert.equal(report.fieldStatus["measured.hook_event_count"].status, "unavailable");
});

test("regression (Stage 1 review, PR #203): a requiresTrue field with value false is not counted as captured", () => {
  // token_usage_is_session_complete is requiresTrue for token_allocation: a PreCompact-only
  // checkpoint reports it as `false` (a real, present boolean), which a generic presence
  // check would wrongly treat as captured evidence of whole-session completeness.
  const record = reduceEvents(loadFixture("transcript_usage_precompact_only.jsonl"));
  assert.equal(record.measured.token_usage_is_session_complete, false);
  const report = buildCoverageReport([record]);
  assert.equal(report.fieldStatus["measured.token_usage_is_session_complete"].status, "unavailable");
  assert.ok(report.decisionCriticalGaps.includes("measured.token_usage_is_session_complete"));
});

test("regression (Stage 1 review, PR #203): a null derived value is not counted as reliably captured", () => {
  // reduceEvents([]) still emits every derived schema key, but most are null when nothing
  // was ever measured — the report must reflect actual availability, not schema-key count.
  const emptyRecord = reduceEvents([]);
  const report = buildCoverageReport([emptyRecord]);
  assert.equal(report.derivedFieldStatus.token_usage_grand_total.status, "unavailable");
  assert.ok(!report.derivedCaptured.includes("token_usage_grand_total"));
  assert.equal(report.derivedFieldStatus.compaction_count.status, "captured");
  assert.ok(report.derivedCaptured.includes("compaction_count"));
});

function withTempSessionsDir(fn) {
  const sessionsDir = mkdtempSync(join(tmpdir(), "ldl-coverage-test-"));
  try {
    fn(sessionsDir);
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
}

function writeSession(sessionsDir, id, mtime) {
  const path = join(sessionsDir, `${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ kind: "hook", event: "SessionStart", session_id: id, ts: new Date(mtime).toISOString() })}\n`);
  utimesSync(path, new Date(mtime), new Date(mtime));
}

test("regression (Stage 1 review, PR #203): listRecentSessionIds excludes the invoking session's own log", () => {
  withTempSessionsDir((sessionsDir) => {
    writeSession(sessionsDir, "old-session", Date.now() - 60000);
    writeSession(sessionsDir, "live-session", Date.now());
    const ids = listRecentSessionIds(10, "live-session", sessionsDir);
    assert.deepEqual(ids, ["old-session"]);
  });
});

test("regression (Stage 1 review, PR #203): listSessionIdsSince only returns sessions strictly newer than the cutoff", () => {
  withTempSessionsDir((sessionsDir) => {
    const cutoff = Date.now() - 30000;
    writeSession(sessionsDir, "before-cutoff", cutoff - 60000);
    writeSession(sessionsDir, "after-cutoff", cutoff + 60000);
    const ids = listSessionIdsSince(cutoff, null, sessionsDir);
    assert.deepEqual(ids, ["after-cutoff"]);
  });
});

test("regression (Stage 1 review, PR #203): resolveSessionIds rejects a --session id with no matching log instead of silently reducing an empty record", () => {
  withTempSessionsDir((sessionsDir) => {
    assert.throws(
      () => resolveSessionIds({ sessions: ["typo-id"], since: null, sample: null, excludeSession: null }, sessionsDir),
      /no session log found/,
    );
  });
});

test("regression (Stage 1 review, PR #203): resolveSessionIds rejects a non-numeric or non-positive --sample instead of silently coercing it", () => {
  assert.throws(() => resolveSessionIds({ sessions: [], since: null, sample: "not-a-number", excludeSession: null }), /must be a positive integer/);
  assert.throws(() => resolveSessionIds({ sessions: [], since: null, sample: "0", excludeSession: null }), /must be a positive integer/);
});

test("regression (Stage 1 review, PR #203): resolveSessionIds rejects a malformed --since timestamp instead of silently returning everything", () => {
  assert.throws(() => resolveSessionIds({ sessions: [], since: "not-a-date", sample: null, excludeSession: null }), /not a valid ISO timestamp/);
});
