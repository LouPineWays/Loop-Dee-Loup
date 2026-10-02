// Issue #389 unit 389-D: managed-session records satisfy only the claims their authoritative
// fields support. Tests: node --test tools/telemetry/managed-session-sufficiency.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fromClaudeRun, fromGenericRun } from "./managed-session-record.mjs";
import { reduceEvents, reduceManagedSessionRecord, attachManagedSession } from "./reduce.mjs";
import { assessSufficiency, CLAIM_REQUIREMENTS } from "./sufficiency.mjs";
import { buildCoverageReport } from "./coverage.mjs";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "managed-session");
const terminal = JSON.parse(readFileSync(join(FX, "claude-terminal-result.json"), "utf8"));
const identity = { runId: "run-1", controlIssue: 390, executionIssue: 389, lifecycleStage: "EXECUTE_UNIT", unitId: "389-D" };
const claudeRecord = (terminalResult) =>
  fromClaudeRun({ identity, spawnResult: { startedAt: "a", endedAt: "b", exitCode: terminalResult ? 0 : null, signal: terminalResult ? null : "SIGTERM", terminalResult } });

test("complete Claude record supports token_allocation and monetary_cost_total, with the cost caveat", () => {
  const reduced = reduceManagedSessionRecord(claudeRecord(terminal));
  const tokens = assessSufficiency(reduced, "token_allocation");
  assert.equal(tokens.verdict, "SUFFICIENT");
  assert.equal(tokens.evidenceSource, "managed_session");
  assert.equal(reduced.measured.managed_session.token_main_total, 3700);
  assert.equal(reduced.measured.managed_session.token_subagent_total, 11400 - 3700);
  const cost = assessSufficiency(reduced, "monetary_cost_total");
  assert.equal(cost.verdict, "SUFFICIENT");
  assert.match(cost.caveats[0], /not actual billing/);
});

test("claims the record cannot support stay INSUFFICIENT", () => {
  const reduced = reduceManagedSessionRecord(claudeRecord(terminal));
  for (const claim of ["monetary_cost_by_model", "compaction_frequency", "subagent_invocation_pattern"]) {
    assert.equal(assessSufficiency(reduced, claim).verdict, "INSUFFICIENT", claim);
  }
});

test("interrupted Claude record without terminal evidence supports nothing", () => {
  const reduced = reduceManagedSessionRecord(claudeRecord(null));
  assert.equal(reduced.measured.managed_session.whole_run_complete, false);
  for (const claim of Object.keys(CLAIM_REQUIREMENTS)) assert.equal(assessSufficiency(reduced, claim).verdict, "INSUFFICIENT", claim);
});

test("non-Claude/generic record without terminal result leaves economics claims INSUFFICIENT", () => {
  const rec = fromGenericRun({ identity, run: { exit_code: 0, surface: "other-surface" } });
  const reduced = reduceManagedSessionRecord(rec);
  assert.equal(assessSufficiency(reduced, "token_allocation").verdict, "INSUFFICIENT");
  assert.equal(assessSufficiency(reduced, "monetary_cost_total").verdict, "INSUFFICIENT");
});

test("missing usage field is never treated as zero", () => {
  const partial = { ...terminal, usage: { input_tokens: 5, output_tokens: 5 } };
  const reduced = reduceManagedSessionRecord(claudeRecord(partial));
  assert.equal(reduced.measured.managed_session.token_main_total, null);
  assert.equal(assessSufficiency(reduced, "token_allocation").verdict, "INSUFFICIENT");
});

test("attaching never alters hook fields and a mismatched session id is not attached", () => {
  const hookEvents = [{ kind: "hook", event: "SessionStart", session_id: "other-session", ts: "2026-01-01T00:00:00Z" }];
  const hook = { generated_at: "x", ...reduceEvents(hookEvents) };
  const rec = claudeRecord(terminal);
  const mismatched = attachManagedSession(hook, rec);
  assert.equal(mismatched.measured.managed_session, undefined);
  assert.ok(mismatched.unknown.includes("managed_session_identity_mismatch"));
  const matching = attachManagedSession({ ...hook, measured: { ...hook.measured, identity: { ...hook.measured.identity, session_id: "sess-claude-1" } } }, rec);
  assert.deepEqual(matching.measured.token_usage_main_total, hook.measured.token_usage_main_total);
  assert.equal(matching.measured.cost_usd_total, hook.measured.cost_usd_total);
  assert.ok(matching.measured.managed_session);
});

test("hook evidence stays the primary source and is never combined with managed evidence", () => {
  const hook = { generated_at: "x", ...reduceEvents([]) };
  const complete = { ...hook, measured: { ...hook.measured, token_usage_main_total: {}, token_usage_subagent_total: {}, token_usage_is_session_complete: true } };
  const both = attachManagedSession({ ...complete, measured: { ...complete.measured, token_usage_main_total: { input_tokens: 1 }, token_usage_subagent_total: { input_tokens: 1 } } }, claudeRecord(terminal));
  assert.equal(assessSufficiency(both, "token_allocation").evidenceSource, "hook");
});

test("coverage reports which source supported each claim without changing field verdicts", () => {
  const withManaged = reduceManagedSessionRecord(claudeRecord(terminal));
  const hookOnly = { generated_at: "x", ...reduceEvents([]) };
  const report = buildCoverageReport([withManaged, hookOnly]);
  assert.deepEqual(report.claimSufficiency.token_allocation, { hook: 0, managed_session: 1, insufficient: 1 });
  assert.equal(report.telemetryVerdict, "INSUFFICIENT");
});
