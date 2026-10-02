import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildManagedSessionRecord,
  fromClaudeRun,
  fromGenericRun,
  persistManagedSessionRecord,
  validateManagedSessionRecord,
} from "./managed-session-record.mjs";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "managed-session");
const fx = (n) => JSON.parse(readFileSync(join(FX, n), "utf8"));
const identity = { runId: "run-1", controlIssue: 390, executionIssue: 389, lifecycleStage: "EXECUTE_UNIT", unitId: "389-A" };

test("complete Claude run preserves top-level vs whole-tree usage and list cost", () => {
  const rec = fromClaudeRun({
    identity,
    spawnResult: { startedAt: "a", endedAt: "b", exitCode: 0, signal: null, terminalResult: fx("claude-terminal-result.json") },
  });
  assert.deepEqual(validateManagedSessionRecord(rec), { valid: true, errors: [] });
  assert.equal(rec.whole_run_complete, true);
  assert.equal(rec.provider_session_id, "sess-claude-1");
  assert.equal(rec.economics.authority, "terminal_result");
  assert.equal(rec.economics.usage.input_tokens, 100);
  assert.equal(rec.economics.agent_tree_usage[0].input_tokens, 900);
  assert.equal(rec.economics.estimated_list_cost_usd, 0.42);
  assert.equal(rec.turns, 7);
  assert.equal(rec.process.completion_state, "completed");
  assert.ok(!JSON.stringify(rec).includes("SECRET FINAL ASSISTANT TEXT"));
});

test("interrupted run without terminal result is incomplete with null economics", () => {
  const rec = fromClaudeRun({
    identity,
    spawnResult: { startedAt: "a", endedAt: "b", exitCode: null, signal: "SIGTERM", terminalResult: null, initSessionId: "s9" },
  });
  assert.deepEqual(validateManagedSessionRecord(rec), { valid: true, errors: [] });
  assert.equal(rec.whole_run_complete, false);
  assert.equal(rec.terminal_result.available, false);
  assert.equal(rec.process.completion_state, "interrupted");
  assert.equal(rec.economics.usage, null);
  assert.equal(rec.economics.estimated_list_cost_usd, null);
  assert.equal(rec.economics.authority, null);
  assert.equal(rec.duration_ms, null);
});

test("generic non-Claude fixture leaves economic fields unknown, not zero", () => {
  const rec = fromGenericRun({ identity, run: fx("generic-surface-run.json") });
  assert.deepEqual(validateManagedSessionRecord(rec), { valid: true, errors: [] });
  assert.equal(rec.whole_run_complete, false);
  assert.equal(rec.model, null);
  assert.equal(rec.provider, "other-provider");
  assert.equal(rec.economics.availability.usage, false);
  assert.equal(rec.economics.usage, null);
  assert.equal(rec.process.completion_state, "completed");
});

test("two provider/surface identities yield identical lifecycle and evidence semantics", () => {
  const claude = fromClaudeRun({ identity, spawnResult: { exitCode: 0, terminalResult: fx("claude-terminal-result.json") } });
  const other = buildManagedSessionRecord({
    ...identity,
    surface: "other-cli",
    provider: "other-provider",
    providerSessionId: "native-1",
    terminalResult: { available: true, state: "success" },
    process: { exit_code: 0, signal: null, completion_state: "completed" },
    economics: claude.economics,
  });
  const strip = (r) => ({
    keys: Object.keys(r).sort(),
    stage: r.lifecycle_stage,
    complete: r.whole_run_complete,
    econKeys: Object.keys(r.economics).sort(),
    valid: validateManagedSessionRecord(r).valid,
    roundTrip: JSON.stringify(JSON.parse(JSON.stringify(r))) === JSON.stringify(r),
  });
  assert.deepEqual(strip(other), strip(claude));
  assert.notEqual(claude.provider, other.provider);
});

test("validator rejects inconsistent availability, fake completeness, and content keys", () => {
  const good = fromGenericRun({ identity, run: fx("generic-surface-run.json") });
  const zero = structuredClone(good);
  zero.economics.usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  assert.equal(validateManagedSessionRecord(zero).valid, false);
  const fake = structuredClone(good);
  fake.whole_run_complete = true;
  assert.equal(validateManagedSessionRecord(fake).valid, false);
  const leak = structuredClone(good);
  leak.adapter_evidence = { result: "text" };
  assert.equal(validateManagedSessionRecord(leak).valid, false);
});

test("persister writes one compact deterministic file and never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "msr-"));
  const rec = fromGenericRun({ identity, run: fx("generic-surface-run.json") });
  const a = persistManagedSessionRecord(rec, { dir });
  assert.equal(a.ok, true);
  const first = readFileSync(a.path, "utf8");
  persistManagedSessionRecord(rec, { dir });
  assert.equal(readFileSync(a.path, "utf8"), first);
  assert.deepEqual(readdirSync(dir), ["run-1.json"]);
  assert.equal(first.trim().split("\n").length, 1);
  assert.equal(persistManagedSessionRecord({ run_id: "../x" }, { dir }).ok, false);
  assert.equal(persistManagedSessionRecord(rec, { dir: join(dir, "run-1.json", "sub") }).ok, false);
});
