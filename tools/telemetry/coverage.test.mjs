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
import { buildCoverageReport, decisionCriticalFields, listRecentSessionIds, listSessionIdsSince, listAllSessionIds, resolveSessionIds, readIdsFile, writeIdsFile } from "./coverage.mjs";

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
    const ids = listRecentSessionIds(10, ["live-session"], sessionsDir);
    assert.deepEqual(ids, ["old-session"]);
  });
});

test("regression (Stage 1 review, PR #203): listSessionIdsSince only returns sessions strictly newer than the cutoff", () => {
  withTempSessionsDir((sessionsDir) => {
    const cutoff = Date.now() - 30000;
    writeSession(sessionsDir, "before-cutoff", cutoff - 60000);
    writeSession(sessionsDir, "after-cutoff", cutoff + 60000);
    const ids = listSessionIdsSince(cutoff, [], sessionsDir);
    assert.deepEqual(ids, ["after-cutoff"]);
  });
});

test("regression (Stage 1 review, PR #203): resolveSessionIds rejects a --session id with no matching log instead of silently reducing an empty record", () => {
  withTempSessionsDir((sessionsDir) => {
    assert.throws(
      () => resolveSessionIds({ sessions: ["typo-id"], since: null, sample: null, excludeSessions: [], excludeIdsFile: null }, sessionsDir),
      /no session log found/,
    );
  });
});

test("regression (Stage 1 review, PR #203): resolveSessionIds rejects a non-numeric or non-positive --sample instead of silently coercing it", () => {
  const base = { sessions: [], since: null, excludeSessions: [], excludeIdsFile: null };
  assert.throws(() => resolveSessionIds({ ...base, sample: "not-a-number" }), /must be a positive integer/);
  assert.throws(() => resolveSessionIds({ ...base, sample: "0" }), /must be a positive integer/);
});

test("regression (Stage 1 review, PR #203): resolveSessionIds rejects a malformed --since timestamp instead of silently returning everything", () => {
  assert.throws(
    () => resolveSessionIds({ sessions: [], since: "not-a-date", sample: null, excludeSessions: [], excludeIdsFile: null }),
    /not a valid ISO timestamp/,
  );
});

test("regression (Stage 2 audit, PR #203): a resumed session's advancing mtime does not let --since re-select an already-recorded id", () => {
  // The bug: --since alone filters purely on current mtime, so a session file touched
  // again after being sampled (a resumed/still-running session — this repository's own
  // live battery session demonstrated exactly this) crosses a prior cutoff again even
  // though it was already counted. --exclude-ids-file is the durable, mtime-independent
  // guard against that.
  withTempSessionsDir((sessionsDir) => {
    const idsFile = join(sessionsDir, "recorded-ids.json");
    const firstCutoff = Date.now() - 100000;
    writeSession(sessionsDir, "resumed-session", firstCutoff + 1000);
    // First run "counts" resumed-session and records it.
    const firstRun = listSessionIdsSince(firstCutoff, readIdsFile(idsFile), sessionsDir);
    assert.deepEqual(firstRun, ["resumed-session"]);
    writeIdsFile(idsFile, firstRun);
    // The session is resumed and touched again, well after firstCutoff.
    writeSession(sessionsDir, "resumed-session", Date.now());
    writeSession(sessionsDir, "genuinely-new-session", Date.now());
    // A second run using firstCutoff as --since would (wrongly, without the exclude file)
    // re-select resumed-session purely because its mtime moved again.
    const secondRunWithoutGuard = listSessionIdsSince(firstCutoff, [], sessionsDir);
    assert.ok(secondRunWithoutGuard.includes("resumed-session"), "sanity check: mtime alone does re-select it");
    // With the durable exclude-ids-file guard, it must not be re-selected.
    const secondRun = listSessionIdsSince(firstCutoff, readIdsFile(idsFile), sessionsDir);
    assert.deepEqual(secondRun, ["genuinely-new-session"]);
  });
});

test("regression (Stage 2 audit, PR #203): resolveSessionIds combines --exclude-session and --exclude-ids-file", () => {
  withTempSessionsDir((sessionsDir) => {
    const idsFile = join(sessionsDir, "recorded-ids.json");
    writeIdsFile(idsFile, ["already-recorded"]);
    writeSession(sessionsDir, "already-recorded", Date.now() - 1000);
    writeSession(sessionsDir, "live-session", Date.now());
    writeSession(sessionsDir, "fresh-session", Date.now());
    const ids = resolveSessionIds(
      { sessions: [], since: null, sample: "10", excludeSessions: ["live-session"], excludeIdsFile: idsFile },
      sessionsDir,
    );
    assert.deepEqual(ids.sort(), ["fresh-session"]);
  });
});

test("regression (Stage 2 audit, PR #203): writeIdsFile merges with, rather than overwrites, what's already recorded", () => {
  withTempSessionsDir((sessionsDir) => {
    const idsFile = join(sessionsDir, "recorded-ids.json");
    writeIdsFile(idsFile, ["previously-recorded"]);
    writeIdsFile(idsFile, ["new-session"]);
    assert.deepEqual(readIdsFile(idsFile).sort(), ["new-session", "previously-recorded"]);
  });
});

test("regression (Stage 1 review, PR #205): readIdsFile throws on malformed existing content instead of silently treating it as empty history", () => {
  withTempSessionsDir((sessionsDir) => {
    const idsFile = join(sessionsDir, "recorded-ids.json");
    writeFileSync(idsFile, "{not valid json", "utf8");
    assert.throws(() => readIdsFile(idsFile), /not valid JSON/);
    writeFileSync(idsFile, JSON.stringify({ not: "an array" }), "utf8");
    assert.throws(() => readIdsFile(idsFile), /does not contain a JSON array/);
  });
});

test("regression (Stage 1 review, PR #205): a malformed exclude-ids-file fails resolveSessionIds loudly rather than silently discarding its history", () => {
  withTempSessionsDir((sessionsDir) => {
    const idsFile = join(sessionsDir, "recorded-ids.json");
    writeFileSync(idsFile, "not json at all", "utf8");
    assert.throws(
      () => resolveSessionIds({ sessions: [], since: null, sample: "10", all: false, excludeSessions: [], excludeIdsFile: idsFile }, sessionsDir),
      /not valid JSON/,
    );
  });
});

test("readIdsFile returns [] only for a genuinely missing file, not a present-but-empty one", () => {
  withTempSessionsDir((sessionsDir) => {
    const missing = join(sessionsDir, "does-not-exist.json");
    assert.deepEqual(readIdsFile(missing), []);
    const present = join(sessionsDir, "present.json");
    writeFileSync(present, "[]", "utf8");
    assert.deepEqual(readIdsFile(present), []);
  });
});

test("regression (Stage 1 review, PR #205): --all selects every non-excluded session regardless of mtime, so a temporarily-excluded session stays eligible later", () => {
  withTempSessionsDir((sessionsDir) => {
    // The exact scenario the finding describes: an excluded live session's mtime is older
    // than another sampled session's, so a --since-based cutoff would advance past it and
    // could permanently drop it later if it never gets touched again. --all never looks at
    // mtime at all, so this can't happen.
    writeSession(sessionsDir, "excluded-live-session", Date.now() - 50000);
    writeSession(sessionsDir, "later-sampled-session", Date.now());
    const firstRun = listAllSessionIds(["excluded-live-session"], sessionsDir);
    assert.deepEqual(firstRun, ["later-sampled-session"]);
    // The excluded session is never touched again (e.g. it ended without a SessionEnd
    // write) and is not recorded anywhere — a later run must still see it as eligible.
    const secondRun = listAllSessionIds([], sessionsDir);
    assert.ok(secondRun.includes("excluded-live-session"));
  });
});

test("resolveSessionIds honors --all over --sample/--since when set", () => {
  withTempSessionsDir((sessionsDir) => {
    writeSession(sessionsDir, "only-session", Date.now() - 1000000);
    const ids = resolveSessionIds(
      { sessions: [], since: null, sample: "1", all: true, excludeSessions: [], excludeIdsFile: null },
      sessionsDir,
    );
    assert.deepEqual(ids, ["only-session"]);
  });
});
