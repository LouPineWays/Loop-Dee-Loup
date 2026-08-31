// Tests for tools/telemetry/execution-boundary-probe.mjs (issue #245). The spawn/parse
// logic is exercised end-to-end against fixtures/execution-boundary/fake-cli.mjs -- a
// stand-in for the real `claude` CLI binary -- so parsing, timeout/kill handling, and
// record shaping are all covered deterministically without spawning a real Claude Code
// process or touching any network/auth surface.
//
// Run with: node --test tools/telemetry/execution-boundary-probe.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  buildCliArgs,
  extractTopLevelUsage,
  extractWholeTreeModelUsage,
  buildHookComparison,
  spawnAndCapture,
  buildRecord,
  numOrNull,
} from "./execution-boundary-probe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(HERE, "fixtures", "execution-boundary", "fake-cli.mjs");

test("numOrNull passes through finite numbers, nulls everything else", () => {
  assert.equal(numOrNull(5), 5);
  assert.equal(numOrNull(0), 0);
  assert.equal(numOrNull("5"), null);
  assert.equal(numOrNull(NaN), null);
  assert.equal(numOrNull(undefined), null);
});

test("parseArgs requires task, prompt, and a claude binary", () => {
  assert.throws(() => parseArgs(["--prompt", "x", "--claude-bin", "claude"]), /--task/);
  assert.throws(() => parseArgs(["--task", "t1", "--claude-bin", "claude"]), /--prompt/);
  assert.throws(() => parseArgs(["--task", "t1", "--prompt", "x"]), /--claude-bin/);
});

test("parseArgs applies documented defaults and collects repeated --note", () => {
  const args = parseArgs(["--task", "t1", "--prompt", "hi", "--claude-bin", "claude", "--note", "a", "--note", "b"]);
  assert.equal(args.permissionMode, "bypassPermissions");
  assert.equal(args.timeoutMs, 120_000);
  assert.deepEqual(args.notes, ["a", "b"]);
});

test("parseArgs rejects a non-numeric or non-positive --timeout-ms instead of silently producing NaN/0", () => {
  assert.throws(
    () => parseArgs(["--task", "t1", "--prompt", "x", "--claude-bin", "claude", "--timeout-ms", "not-a-number"]),
    /--timeout-ms must be a finite positive number/,
  );
  assert.throws(
    () => parseArgs(["--task", "t1", "--prompt", "x", "--claude-bin", "claude", "--timeout-ms", "0"]),
    /--timeout-ms must be a finite positive number/,
  );
  assert.throws(
    () => parseArgs(["--task", "t1", "--prompt", "x", "--claude-bin", "claude", "--timeout-ms", "-5"]),
    /--timeout-ms must be a finite positive number/,
  );
});

test("parseArgs rejects a non-numeric or non-positive --kill-after-ms instead of silently disabling the kill timer", () => {
  assert.throws(
    () => parseArgs(["--task", "t1", "--prompt", "x", "--claude-bin", "claude", "--kill-after-ms", "soon"]),
    /--kill-after-ms must be a finite positive number/,
  );
  assert.throws(
    () => parseArgs(["--task", "t1", "--prompt", "x", "--claude-bin", "claude", "--kill-after-ms", "-1"]),
    /--kill-after-ms must be a finite positive number/,
  );
});

test("parseArgs accepts valid --timeout-ms and --kill-after-ms", () => {
  const args = parseArgs(["--task", "t1", "--prompt", "x", "--claude-bin", "claude", "--timeout-ms", "5000", "--kill-after-ms", "1000"]);
  assert.equal(args.timeoutMs, 5000);
  assert.equal(args.killAfterMs, 1000);
});

test("parseArgs rejects a --note that exceeds the length bound or carries a newline", () => {
  const tooLong = "x".repeat(201);
  assert.throws(
    () => parseArgs(["--task", "t1", "--prompt", "x", "--claude-bin", "claude", "--note", tooLong]),
    /--note must be a single line of at most 200 characters/,
  );
  assert.throws(
    () => parseArgs(["--task", "t1", "--prompt", "x", "--claude-bin", "claude", "--note", "line one\nline two"]),
    /--note must be a single line/,
  );
});

test("parseArgs accepts a short single-line --note", () => {
  const args = parseArgs(["--task", "t1", "--prompt", "x", "--claude-bin", "claude", "--note", "required test 1"]);
  assert.deepEqual(args.notes, ["required test 1"]);
});

test("buildCliArgs matches issue #245's exact execution surface, plus the required permission mode", () => {
  const cliArgs = buildCliArgs({ permissionMode: "bypassPermissions", prompt: "do the thing" });
  assert.deepEqual(cliArgs, ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "do the thing"]);
});

test("buildCliArgs appends --no-session-persistence only when requested", () => {
  const cliArgs = buildCliArgs({ permissionMode: "bypassPermissions", prompt: "hi", noSessionPersistence: true });
  assert.ok(cliArgs.includes("--no-session-persistence"));
});

test("extractTopLevelUsage reads the four documented usage fields, null when absent", () => {
  assert.equal(extractTopLevelUsage({}), null);
  assert.equal(extractTopLevelUsage(null), null);
  const usage = extractTopLevelUsage({
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
  });
  assert.deepEqual(usage, { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 });
});

test("extractWholeTreeModelUsage reads camelCase (modelUsage) shape per model", () => {
  const models = extractWholeTreeModelUsage({
    modelUsage: {
      "claude-sonnet-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 0, costUSD: 0.01 },
    },
  });
  assert.deepEqual(models, [
    {
      model: "claude-sonnet-5",
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 0,
      estimated_list_cost_usd: 0.01,
    },
  ]);
});

test("extractWholeTreeModelUsage reads snake_case (model_usage) shape too", () => {
  const models = extractWholeTreeModelUsage({
    model_usage: {
      "claude-haiku-4-5": { input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0.002 },
    },
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].model, "claude-haiku-4-5");
  assert.equal(models[0].input_tokens, 200);
  assert.equal(models[0].estimated_list_cost_usd, 0.002);
});

test("extractWholeTreeModelUsage returns null when neither key is present -- never guesses", () => {
  assert.equal(extractWholeTreeModelUsage({}), null);
});

test("buildHookComparison counts structural events without touching content", () => {
  const events = [
    { event: "SessionStart" },
    { event: "SubagentStart" },
    { event: "SubagentStart" },
    { event: "SubagentStop" },
    { kind: "transcript_usage", event: "SubagentStop" },
    { event: "SessionEnd" },
  ];
  const comparison = buildHookComparison(events);
  assert.equal(comparison.hook_event_count, 6);
  assert.equal(comparison.subagent_start_count, 2);
  // Only 1, not 2: the transcript_usage companion record carries the same `event:
  // "SubagentStop"` as its structural sibling but must not count as a second completion.
  assert.equal(comparison.subagent_stop_count, 1);
  assert.equal(comparison.session_end_seen, true);
  assert.equal(comparison.transcript_usage_sample_count, 1);
  assert.deepEqual(comparison.hook_event_types.sort(), ["SessionEnd", "SessionStart", "SubagentStart", "SubagentStop"]);
});

test("buildHookComparison does not double-count a SubagentStop that has a transcript_usage companion", () => {
  // Reproduces the real shape hook.mjs emits for one genuine subagent completion with a
  // readable transcript: two records sharing `event: "SubagentStop"`, distinguished only
  // by `kind`. This is exactly the committed 245-run-3-subagent.json scenario (one
  // subagent start, and -- before this fix -- a reported stop count of two).
  const events = [
    { kind: "hook", event: "SubagentStart" },
    { kind: "hook", event: "SubagentStop" },
    { kind: "transcript_usage", event: "SubagentStop" },
  ];
  const comparison = buildHookComparison(events);
  assert.equal(comparison.subagent_start_count, 1);
  assert.equal(comparison.subagent_stop_count, 1);
  assert.equal(comparison.transcript_usage_sample_count, 1);
});

test("buildHookComparison reproduces the corrected subagent_stop_count on the real run-3 event shape (issue #250)", () => {
  // Stage 2 audit finding (issue #250): the previous test above validates the ALGORITHM
  // against a hand-authored input -- it would still pass even if the real run-3 session's
  // actual raw event log had a different shape. This test instead loads a committed,
  // privacy-minimal snapshot of the REAL structural kind/event sequence recorded during
  // 245-run-3-subagent's live proving run (docs/execution-boundary-probe-runs/245-run-3-
  // subagent.hook-events.json -- kind+event only, no tokens/ids/timestamps), so the
  // empirical correction from subagent_stop_count: 2 to 1 in that run's committed record
  // is independently reproducible from repository state alone, not merely asserted.
  const fixturePath = join(HERE, "..", "..", "docs", "execution-boundary-probe-runs", "245-run-3-subagent.hook-events.json");
  const events = JSON.parse(readFileSync(fixturePath, "utf8"));
  const comparison = buildHookComparison(events);
  assert.equal(comparison.hook_event_count, 6);
  assert.equal(comparison.subagent_start_count, 1);
  assert.equal(comparison.subagent_stop_count, 1);
  assert.equal(comparison.transcript_usage_sample_count, 2);
  assert.equal(comparison.session_end_seen, true);
});

test("buildHookComparison handles no events (e.g. no session_id resolved) without throwing", () => {
  assert.equal(buildHookComparison([]).hook_event_count, 0);
  assert.equal(buildHookComparison(undefined).hook_event_count, 0);
});

test("spawnAndCapture: normal fixture run yields a parsed terminal result and init session id", async () => {
  const result = await spawnAndCapture(process.execPath, [FAKE_CLI, "normal"], { cwd: HERE, timeoutMs: 10_000 });
  assert.equal(result.resultReceived, true);
  assert.equal(result.initSessionId, "fixture-session-normal");
  assert.equal(result.terminalResult.session_id, "fixture-session-normal");
  assert.equal(result.terminalResult.is_error, false);
  assert.equal(result.exitCode, 0);
  assert.ok(result.messageTypesSeen.includes("system"));
  assert.ok(result.messageTypesSeen.includes("result"));
});

test("spawnAndCapture: subagent fixture exposes whole-tree modelUsage across two models", async () => {
  const result = await spawnAndCapture(process.execPath, [FAKE_CLI, "subagent"], { cwd: HERE, timeoutMs: 10_000 });
  assert.equal(result.resultReceived, true);
  const models = extractWholeTreeModelUsage(result.terminalResult);
  assert.equal(models.length, 2);
  const names = models.map((m) => m.model).sort();
  assert.deepEqual(names, ["claude-haiku-4-5", "claude-sonnet-5"]);
  // Top-level usage (main loop only) must stay distinct from the whole-tree total -- the
  // fixture's top-level `usage` reports only the main thread's 10/20 tokens, not the
  // combined 210/70 across both models.
  const topLevel = extractTopLevelUsage(result.terminalResult);
  assert.equal(topLevel.input_tokens, 10);
});

test("spawnAndCapture: error fixture reports is_error true with a non-zero exit code", async () => {
  const result = await spawnAndCapture(process.execPath, [FAKE_CLI, "error"], { cwd: HERE, timeoutMs: 10_000 });
  assert.equal(result.resultReceived, true);
  assert.equal(result.terminalResult.is_error, true);
  assert.equal(result.exitCode, 1);
});

test("spawnAndCapture: no-result fixture exits cleanly but never yields a terminal result", async () => {
  const result = await spawnAndCapture(process.execPath, [FAKE_CLI, "no-result"], { cwd: HERE, timeoutMs: 10_000 });
  assert.equal(result.resultReceived, false);
  assert.equal(result.terminalResult, null);
  assert.equal(result.initSessionId, "fixture-session-no-result");
  assert.equal(result.exitCode, 0);
});

test("spawnAndCapture: killAfterMs force-terminates a hanging process and still reports no result", async () => {
  const result = await spawnAndCapture(process.execPath, [FAKE_CLI, "hang"], {
    cwd: HERE,
    timeoutMs: 10_000,
    killAfterMs: 300,
  });
  assert.equal(result.resultReceived, false);
  assert.equal(result.initSessionId, "fixture-session-hang");
  // Exit is abnormal (killed), never a clean 0 -- confirms the process didn't just finish
  // on its own before the kill fired.
  assert.notEqual(result.exitCode, 0);
});

test("spawnAndCapture: a spawn failure (stale/missing binary) resolves instead of crashing the probe", async () => {
  const result = await spawnAndCapture("this-binary-definitely-does-not-exist-anywhere-xyz", ["--version"], {
    cwd: HERE,
    timeoutMs: 10_000,
  });
  assert.equal(result.resultReceived, false);
  assert.equal(result.terminalResult, null);
  assert.equal(result.exitCode, null);
  assert.equal(typeof result.spawnError, "string");
  assert.ok(result.spawnError.length > 0);
});

test("buildRecord: a spawn failure is recorded as spawn_error with an honest unknown-usage status", async () => {
  const spawnResult = await spawnAndCapture("this-binary-definitely-does-not-exist-anywhere-xyz", [], {
    cwd: HERE,
    timeoutMs: 10_000,
  });
  const record = buildRecord({
    taskId: "test-task-spawn-error",
    permissionMode: "bypassPermissions",
    cwd: HERE,
    spawnResult,
    hookEvents: [],
    notes: [],
  });
  assert.equal(record.result_received, false);
  assert.equal(record.usage_status, "unknown");
  assert.equal(typeof record.spawn_error, "string");
});

test("buildRecord: a normal completed run reports spawn_error as null", async () => {
  const spawnResult = await spawnAndCapture(process.execPath, [FAKE_CLI, "normal"], { cwd: HERE, timeoutMs: 10_000 });
  const record = buildRecord({
    taskId: "test-task-normal-spawn-error-null",
    permissionMode: "bypassPermissions",
    cwd: HERE,
    spawnResult,
    hookEvents: [],
    notes: [],
  });
  assert.equal(record.spawn_error, null);
});

test("buildRecord: a completed run separates top-level usage from whole-tree model usage and labels cost as estimated", async () => {
  const spawnResult = await spawnAndCapture(process.execPath, [FAKE_CLI, "subagent"], { cwd: HERE, timeoutMs: 10_000 });
  const record = buildRecord({
    taskId: "test-task-subagent",
    permissionMode: "bypassPermissions",
    cwd: HERE,
    spawnResult,
    hookEvents: [{ event: "SubagentStart" }, { event: "SubagentStop" }],
    notes: ["unit test run"],
  });
  assert.equal(record.result_received, true);
  assert.equal(record.usage_status, "measured");
  assert.equal(record.session_id, "fixture-session-subagent");
  assert.equal(record.top_level_usage.input_tokens, 10);
  assert.equal(record.whole_tree_model_usage.length, 2);
  assert.match(record.estimated_list_cost_usd_note, /not actual subscription spend/);
  assert.match(record.top_level_usage_note, /excludes subagent activity/);
  assert.equal(record.hook_comparison.subagent_start_count, 1);
  // Privacy: the fixture's `result` text must never appear anywhere in the record.
  const flat = JSON.stringify(record);
  assert.equal(flat.includes("fixture response text"), false);
});

test("buildRecord: a missing result is reported honestly, never backfilled from hook evidence", async () => {
  const spawnResult = await spawnAndCapture(process.execPath, [FAKE_CLI, "no-result"], { cwd: HERE, timeoutMs: 10_000 });
  const record = buildRecord({
    taskId: "test-task-interrupted",
    permissionMode: "bypassPermissions",
    cwd: HERE,
    spawnResult,
    // Even if the hook log independently shows real subagent activity, a missing
    // terminal result must not be converted into measured usage from it.
    hookEvents: [{ event: "SubagentStart" }, { event: "SubagentStop" }, { event: "SessionEnd" }],
    notes: [],
  });
  assert.equal(record.result_received, false);
  assert.equal(record.usage_status, "unknown");
  assert.equal(record.top_level_usage, null);
  assert.equal(record.whole_tree_model_usage, null);
  assert.equal(record.estimated_list_cost_usd, null);
  // The independent hook comparison is still recorded -- it's diagnostic, not economic.
  assert.equal(record.hook_comparison.session_end_seen, true);
});
