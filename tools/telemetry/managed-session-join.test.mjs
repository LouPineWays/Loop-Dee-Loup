// Issue #389 unit 389-E: end-to-end join + by-reference summary over fixtures, exercising
// the Verification items 1-12. Only one execution surface is qualified, so item 5 proves the
// schema needs no Claude-only semantics via a generic-surface fixture (no second provider added).
// Run: node --test tools/telemetry/managed-session-join.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fromGenericRun, persistManagedSessionRecord, persistRecordWith } from "./managed-session-record.mjs";
import { readManagedRecords, joinManagedRecords, summarizeManagedRuns } from "./managed-session-join.mjs";
import { reduceManagedSessionRecord } from "./reduce.mjs";
import { assessSufficiency } from "./sufficiency.mjs";
import { buildWorkerRunRecord } from "../orchestration/launcher-run.mjs";
import { buildGateOutcomeRecord, validateGateOutcomeRecord, Outcome, EffectClass } from "../orchestration/launcher-step.mjs";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "managed-session");
const terminalLine = readFileSync(join(FX, "claude-terminal-result.json"), "utf8").trim();
const SECRET = "SECRET FINAL ASSISTANT TEXT";

const mk = () => mkdtempSync(join(tmpdir(), "ldl-389e-"));
const ident = (stage, extra = {}) => ({ controlIssue: 390, executionIssue: 389, lifecycleStage: stage, surface: "claude-stream-json", route: "route-a", ...extra });
const worker = (runId, stage, o = {}) =>
  buildWorkerRunRecord({
    identity: { runId, ...ident(stage, { unitId: o.unitId, routeProvenance: { qualification_ref: "qual-1", fallback_used: false, preferred_unavailable: false } }) },
    started: "2026-10-02T10:00:00.000Z",
    ended: "2026-10-02T10:05:00.000Z",
    exitCode: o.exitCode === undefined ? 0 : o.exitCode,
    signal: o.signal ?? null,
    stdout: o.stdout === undefined ? `log line\n${terminalLine}\n` : o.stdout,
  });
const gate = (runId, state, outcome, refs, extra = {}) =>
  buildGateOutcomeRecord({
    runId,
    controlIssue: 390,
    executionIssue: 389,
    stepResult: { outcome, evidence: extra.evidence ?? {}, gate: { state, inputLifecycle: "REVIEW", references: refs } },
    founderInterrupt: extra.founderInterrupt,
  });

function seed(dir) {
  const recs = {
    plan: worker("390-389-PLAN-b-0", "PLAN"),
    unit: worker("390-389-EXECUTE_UNIT-b-0", "EXECUTE_UNIT", { unitId: "389-E" }),
    pr: worker("390-389-INTEGRATE_PR-b-0", "INTEGRATE_PR"),
    corr: worker("390-389-STAGE1_CORRECTION-b-0", "STAGE1_CORRECTION"),
    interrupted: worker("390-389-EXECUTE_UNIT-b-1", "EXECUTE_UNIT", { unitId: "389-E", exitCode: null, signal: "SIGTERM", stdout: "" }),
    generic: fromGenericRun({ identity: { ...ident("PLAN"), runId: "390-389-PLAN-b-9", surface: "other-cli", provider: "other-provider", route: "route-b" }, run: JSON.parse(readFileSync(join(FX, "generic-surface-run.json"), "utf8")) }),
    gOk: gate("390-389-gate-b-0", "READY_TO_DISPATCH_INTEGRATION", Outcome.ADVANCED, { controlIssue: 390, executionIssue: 389, pr: 900 }),
    gWait: gate("390-389-gate-b-1", "NO_ACTION_YET", Outcome.WAITING, { controlIssue: 390, executionIssue: 389, pr: 900, auditIssue: 901 }, { evidence: { wait: { kind: "reviewer_wait" } } }),
    gAmb: gate("390-389-gate-b-2", "AMBIGUOUS", Outcome.FAIL_CLOSED, { controlIssue: 390, executionIssue: 389 }, { evidence: { effectClass: EffectClass.AMBIGUOUS }, founderInterrupt: true }),
  };
  for (const k of ["plan", "unit", "pr", "corr", "interrupted", "generic"]) assert.equal(persistManagedSessionRecord(recs[k], { dir }).ok, true, k);
  for (const k of ["gOk", "gWait", "gAmb"]) assert.equal(persistRecordWith(recs[k], validateGateOutcomeRecord, { dir }).ok, true, k);
  return recs;
}

test("verification 1-12: join, by-reference summary, sufficiency, privacy", () => {
  const dir = mk();
  try {
    const recs = seed(dir);
    const summary = summarizeManagedRuns({ dir });
    assert.equal(summary.counts.session_records, 6);
    assert.equal(summary.counts.gate_outcome_records, 3);
    assert.equal(summary.skipped.length, 0);
    const exec = summary.executions.find((e) => e.execution_issue === 389);
    assert.equal(exec.control_issue, 390);
    const row = (id) => exec.sessions.find((s) => s.run_id === id);

    // 1-3, 7: planning, implementation (unit), later lifecycle (integration, correction) rows joined by identity
    assert.equal(row("390-389-PLAN-b-0").lifecycle_stage, "PLAN");
    assert.equal(row("390-389-EXECUTE_UNIT-b-0").unit_id, "389-E");
    assert.equal(row("390-389-INTEGRATE_PR-b-0").lifecycle_stage, "INTEGRATE_PR");
    assert.equal(row("390-389-STAGE1_CORRECTION-b-0").lifecycle_stage, "STAGE1_CORRECTION");
    assert.equal(row("390-389-PLAN-b-0").route, "route-a");
    assert.equal(row("390-389-PLAN-b-0").route_provenance.qualification_ref, "qual-1");
    assert.equal(row("390-389-PLAN-b-0").record, "390-389-PLAN-b-0.json");

    // 4: Claude run keeps terminal-result authority and the whole-tree vs top-level distinction
    assert.equal(row("390-389-PLAN-b-0").whole_run_complete, true);
    assert.equal(row("390-389-PLAN-b-0").economics_authority, "terminal_result");
    assert.equal(recs.plan.economics.usage_scope, "top_level_excluding_subagents");
    assert.ok(recs.plan.economics.agent_tree_usage.length > 0);

    // 5: another surface with no terminal result: unknown stays unknown, no Claude-only fields required
    const g = row("390-389-PLAN-b-9");
    assert.equal(g.surface, "other-cli");
    assert.equal(g.whole_run_complete, false);
    assert.equal(g.economics_authority, null);
    assert.deepEqual(g.economics_available, { usage: false, agent_tree_usage: false, estimated_list_cost_usd: false });

    // 6: interrupted run stays explicitly incomplete
    const i = row("390-389-EXECUTE_UNIT-b-1");
    assert.equal(i.whole_run_complete, false);
    assert.equal(i.completion_state, "interrupted");
    assert.equal(i.economics_authority, null);

    // 8-9: successful transition vs waiting / ambiguous fail-closed gate results
    const byId = (id) => exec.gate_outcomes.find((x) => x.run_id === id);
    assert.equal(byId("390-389-gate-b-0").result_class, "transition");
    assert.equal(byId("390-389-gate-b-1").result_class, "waiting");
    assert.equal(byId("390-389-gate-b-1").route_wait_stop_state, "reviewer_wait");
    assert.equal(byId("390-389-gate-b-2").result_class, "ambiguous");
    assert.equal(byId("390-389-gate-b-2").founder_interrupt, true);

    // 10: sufficiency consumption supports only what is supported
    assert.equal(assessSufficiency(reduceManagedSessionRecord(recs.plan), "token_allocation").verdict, "SUFFICIENT");
    for (const r of [recs.interrupted, recs.generic]) assert.equal(assessSufficiency(reduceManagedSessionRecord(r), "token_allocation").verdict, "INSUFFICIENT");

    // 12: stage + route/surface + verified-outcome linkage by GitHub reference only
    assert.deepEqual(exec.outcome_refs, { authority: "github", pr: [900], audit: [901] });
    const cell = summary.stage_route_surface.find((c) => c.lifecycle_stage === "EXECUTE_UNIT" && c.route === "route-a" && c.surface === "claude-stream-json");
    assert.deepEqual(cell.run_ids, ["390-389-EXECUTE_UNIT-b-0", "390-389-EXECUTE_UNIT-b-1"]);
    assert.deepEqual(cell.outcome_refs, { authority: "github", pr: [900], audit: [901] });
    assert.ok(summary.stage_route_surface.some((c) => c.surface === "other-cli" && c.route === "route-b"));

    // 11: bounded packet input: no transcript/result content, no copied outcome, small and deterministic
    const text = JSON.stringify(summary);
    assert.equal(text.includes(SECRET), false);
    assert.ok(!/"(result|prompt|transcript|response|text|content|output|messages)"\s*:/i.test(text));
    assert.ok(text.length < 12000, `summary is compact (${text.length})`);
    assert.equal(JSON.stringify(summarizeManagedRuns({ dir })), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid and unreadable files are skipped by name only; missing dir is empty", () => {
  const dir = mk();
  try {
    writeFileSync(join(dir, "bad.json"), "{not json");
    writeFileSync(join(dir, "wrong.json"), JSON.stringify({ schema_version: 1, run_id: "x", result: SECRET }));
    writeFileSync(join(dir, "ignored.txt"), "x");
    const s = summarizeManagedRuns({ dir });
    assert.deepEqual(s.skipped, [{ file: "bad.json", reason: "unreadable" }, { file: "wrong.json", reason: "invalid_session_record" }]);
    assert.equal(JSON.stringify(s).includes(SECRET), false);
    assert.deepEqual(readManagedRecords({ dir: join(dir, "nope") }), { sessions: [], gates: [], skipped: [] });
    assert.equal(joinManagedRecords().counts.session_records, 0);
    assert.deepEqual(readdirSync(dir).sort(), ["bad.json", "ignored.txt", "wrong.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
