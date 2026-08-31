#!/usr/bin/env node
// Proving wrapper for issue #245: "Prove execution-boundary result capture for real LDL
// sessions". Launches a non-bare `claude -p --output-format stream-json --verbose` child
// process, intercepts its terminal `result` message, and persists one compact JSON record
// per run. This is deliberately the entire scope: process launch, stdout/stderr handling,
// terminal-result recognition, exit status, and record persistence. It is an experiment
// probe, not a production telemetry pipeline — see docs/execution-boundary-experiment.md
// for the durable proving-run record and verdict, and the issue's "Minimum change
// authorized" section for what this script must NOT grow into (a daemon, database,
// dashboard, polling, transcript-completion heuristic, or a second competing authority).
//
// Two Claude Code result-message semantics matter and must stay distinct in the record:
//   - `usage` on the terminal result is the TOP-LEVEL agent loop only and excludes
//     subagent activity;
//   - `modelUsage`/`model_usage` is per-model usage across the WHOLE query tree, including
//     subagent requests — this is the field that has to be non-empty for the subagent
//     proving run (see "Required tests" #3 in issue #245).
// `total_cost_usd` is captured only as `estimated_list_cost_usd` — list-price accounting,
// never labeled as actual subscription spend or billing (issue #245 "Fields to capture").
//
// Privacy: only coarse identifiers, counts, and numeric usage/cost fields are ever
// persisted. The terminal result's own `result` field (the assistant's final response
// text) is never read into the record — only its key NAME may appear in
// `result_raw_keys`, never its value. No prompt, response, reasoning, or tool-output
// content is written to disk by this script. This mirrors the privacy rule in
// tools/telemetry/README.md, applied to a new evidence shape rather than reusing it.
//
// Usage:
//   node tools/telemetry/execution-boundary-probe.mjs \
//     --task <task-id> --prompt <text> --claude-bin <path to claude CLI binary> \
//     [--cwd <dir>] [--permission-mode <mode>] [--timeout-ms <n>] \
//     [--kill-after-ms <n>] [--kill-signal <SIGTERM|SIGKILL>] [--out <path>] \
//     [--no-session-persistence] [--note <text>]...
//
// Tests: node --test tools/telemetry/execution-boundary-probe.test.mjs

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readSessionEvents } from "./collect.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_OUT_DIR = join(ROOT, "docs", "execution-boundary-probe-runs");

export function numOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// --note is documented metadata about the run itself (e.g. "required test 3, forced
// delegation"), not a place for prompt/response/tool-output content -- the same
// coarse-identifiers-only privacy rule the rest of this record follows (see the header
// comment and tools/telemetry/README.md's "Privacy and data minimization"). Bounding
// length and shape here is a mechanical backstop for that rule, not a byte-for-byte
// content filter: it catches an accidentally-pasted transcript excerpt or path dump, the
// realistic misuse this flag invites, without trying to detect every possible secret.
const MAX_NOTE_LENGTH = 200;

function requirePositiveMs(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number of milliseconds`);
  }
  return value;
}

export function parseArgs(argv) {
  const args = {
    permissionMode: "bypassPermissions",
    timeoutMs: 120_000,
    cwd: ROOT,
    notes: [],
    claudeBin: process.env.LDL_CLAUDE_BIN || null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--task":
        args.task = argv[++i];
        break;
      case "--prompt":
        args.prompt = argv[++i];
        break;
      case "--claude-bin":
        args.claudeBin = argv[++i];
        break;
      case "--cwd":
        args.cwd = argv[++i];
        break;
      case "--permission-mode":
        args.permissionMode = argv[++i];
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(argv[++i]);
        break;
      case "--kill-after-ms":
        args.killAfterMs = Number(argv[++i]);
        break;
      case "--kill-signal":
        args.killSignal = argv[++i];
        break;
      case "--out":
        args.out = argv[++i];
        break;
      case "--no-session-persistence":
        args.noSessionPersistence = true;
        break;
      case "--note": {
        const note = argv[++i];
        if (typeof note !== "string" || /[\r\n]/.test(note) || note.length > MAX_NOTE_LENGTH) {
          throw new Error(
            `--note must be a single line of at most ${MAX_NOTE_LENGTH} characters (short structured metadata only -- never prompt, response, or tool-output content)`,
          );
        }
        args.notes.push(note);
        break;
      }
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.task) throw new Error("--task is required");
  if (!args.prompt) throw new Error("--prompt is required");
  if (!args.claudeBin) throw new Error("--claude-bin (or LDL_CLAUDE_BIN) is required");
  requirePositiveMs("--timeout-ms", args.timeoutMs);
  if (args.killAfterMs !== undefined) requirePositiveMs("--kill-after-ms", args.killAfterMs);
  return args;
}

// The exact execution surface issue #245 specifies: `claude -p --output-format stream-json
// --verbose "<bounded task>"`, plus a permission mode (required for unattended execution --
// there is no TTY to answer an interactive tool-approval prompt) and any explicitly
// requested flags. Kept as its own pure function so the CLI-arg shape is assertable in a
// test without spawning anything.
export function buildCliArgs(args) {
  const cliArgs = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", args.permissionMode];
  if (args.noSessionPersistence) cliArgs.push("--no-session-persistence");
  cliArgs.push(args.prompt);
  return cliArgs;
}

// Top-level `usage` on the terminal result: the main agent loop only, excludes subagents.
export function extractTopLevelUsage(result) {
  const usage = result?.usage;
  if (!usage || typeof usage !== "object") return null;
  return {
    input_tokens: numOrNull(usage.input_tokens),
    output_tokens: numOrNull(usage.output_tokens),
    cache_read_input_tokens: numOrNull(usage.cache_read_input_tokens),
    cache_creation_input_tokens: numOrNull(usage.cache_creation_input_tokens),
  };
}

// Whole-query-tree per-model usage, including subagent requests. Checks both camelCase
// (`modelUsage`, matching the Agent SDK's documented TypeScript shape) and snake_case
// (`model_usage`) since issue #245 explicitly names both without settling on one -- a real
// proving run is what determines which one the CLI actually emits (recorded in
// docs/execution-boundary-experiment.md, not guessed here).
export function extractWholeTreeModelUsage(result) {
  const modelUsage = result?.modelUsage ?? result?.model_usage;
  if (!modelUsage || typeof modelUsage !== "object") return null;
  return Object.entries(modelUsage).map(([model, u]) => ({
    model,
    input_tokens: numOrNull(u?.inputTokens ?? u?.input_tokens),
    output_tokens: numOrNull(u?.outputTokens ?? u?.output_tokens),
    cache_read_input_tokens: numOrNull(u?.cacheReadInputTokens ?? u?.cache_read_input_tokens),
    cache_creation_input_tokens: numOrNull(u?.cacheCreationInputTokens ?? u?.cache_creation_input_tokens),
    estimated_list_cost_usd: numOrNull(u?.costUSD ?? u?.costUsd ?? u?.cost_usd),
  }));
}

// Independent structural comparison against this repository's existing hook-based
// telemetry (tools/telemetry/hook.mjs), which fires for the same nested session because it
// runs non-bare, inheriting .claude/settings.json. This is read-only cross-checking of
// identity/semantics (issue #245's "Comparison with existing telemetry"), never a fallback
// source for economics -- a missing terminal result stays `usage_status: "unknown"`
// regardless of what the hook log shows.
export function buildHookComparison(events) {
  const list = Array.isArray(events) ? events : [];
  // hook.mjs (SubagentStop, SessionEnd, PreCompact) appends a companion `kind:
  // "transcript_usage"` record carrying the SAME `event` name alongside the structural
  // `kind: "hook"` record whenever the transcript is readable -- one real SubagentStop
  // firing therefore yields two entries with `event: "SubagentStop"`. Counting by `event`
  // alone double-counts that completion (already observable in the committed
  // 245-run-3-subagent.json: one subagent start, two "stops"). Structural counts must
  // exclude the transcript-usage companion; it has its own dedicated count below.
  const structural = list.filter((e) => e?.kind !== "transcript_usage");
  return {
    hook_event_count: list.length,
    hook_event_types: [...new Set(list.map((e) => e?.event).filter(Boolean))],
    subagent_start_count: structural.filter((e) => e?.event === "SubagentStart").length,
    subagent_stop_count: structural.filter((e) => e?.event === "SubagentStop").length,
    session_end_seen: list.some((e) => e?.event === "SessionEnd"),
    transcript_usage_sample_count: list.filter((e) => e?.kind === "transcript_usage").length,
  };
}

// Spawns `bin` with `cliArgs`, capturing newline-delimited stream-json on stdout. Resolves
// once the child closes (or is force-killed on timeout). Bin/cliArgs are opaque here so
// tests can point this at fixtures/execution-boundary/fake-cli.mjs instead of a real CLI.
export function spawnAndCapture(bin, cliArgs, { cwd, timeoutMs = 120_000, killAfterMs, killSignal = "SIGTERM" } = {}) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn(bin, cliArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    let stdoutBuf = "";
    let stderrByteLength = 0;
    const messageTypesSeen = [];
    let initSessionId = null;
    let terminalResult = null;

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (msg && typeof msg.type === "string") messageTypesSeen.push(msg.type);
        if (msg?.type === "system" && msg.subtype === "init" && typeof msg.session_id === "string") {
          initSessionId = msg.session_id;
        }
        if (msg?.type === "result") terminalResult = msg;
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrByteLength += chunk.length;
    });

    let killTimer = null;
    if (Number.isFinite(killAfterMs)) {
      killTimer = setTimeout(() => child.kill(killSignal), killAfterMs);
    }

    const timeoutTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    // Node's `ChildProcess` emits `error` (never `close`, in the common case of a spawn
    // that fails outright -- a stale/missing/non-executable --claude-bin, or an invalid
    // --cwd) as an ordinary EventEmitter event. With no listener, that throws and crashes
    // the whole probe process before it ever writes a record -- silently destroying the
    // abnormal-run evidence this script otherwise promises to always persist. Treat it the
    // same as any other abnormal termination: resolve with `resultReceived: false` and
    // record the failure reason instead of the process's identifiers, which never existed.
    let settled = false;
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode: null,
        signal: null,
        resultReceived: false,
        terminalResult: null,
        initSessionId: null,
        messageTypesSeen: [],
        stderrByteLength: 0,
        spawnError: err?.message ?? String(err),
      });
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode,
        signal,
        resultReceived: terminalResult !== null,
        terminalResult,
        initSessionId,
        messageTypesSeen: [...new Set(messageTypesSeen)],
        stderrByteLength,
      });
    });
  });
}

// Assembles the final compact, durable record from a spawnAndCapture() result plus the
// independent hook-log comparison. Pure/exported so the record shape is directly testable
// without spawning anything.
export function buildRecord({ taskId, permissionMode, cwd, spawnResult, hookEvents, notes = [] }) {
  const sessionId = spawnResult.terminalResult?.session_id ?? spawnResult.initSessionId ?? null;
  const resultReceived = spawnResult.resultReceived;
  const result = spawnResult.terminalResult;
  return {
    task_id: taskId,
    execution_surface: "claude -p --output-format stream-json --verbose",
    permission_mode: permissionMode,
    cwd_basename: basename(cwd),
    started_at: spawnResult.startedAt,
    ended_at: spawnResult.endedAt,
    wall_duration_ms: Date.parse(spawnResult.endedAt) - Date.parse(spawnResult.startedAt),
    process_exit_code: spawnResult.exitCode,
    process_signal: spawnResult.signal ?? null,
    result_received: resultReceived,
    session_id: sessionId,
    init_session_id: spawnResult.initSessionId,
    message_types_seen: spawnResult.messageTypesSeen,
    result_subtype: result?.subtype ?? null,
    is_error: typeof result?.is_error === "boolean" ? result.is_error : null,
    num_turns: numOrNull(result?.num_turns),
    duration_ms: numOrNull(result?.duration_ms),
    duration_api_ms: numOrNull(result?.duration_api_ms),
    top_level_usage: resultReceived ? extractTopLevelUsage(result) : null,
    top_level_usage_note: "top-level usage: main agent loop only, excludes subagent activity",
    whole_tree_model_usage: resultReceived ? extractWholeTreeModelUsage(result) : null,
    whole_tree_model_usage_note: "per-model usage across the whole query tree, includes subagent requests",
    estimated_list_cost_usd: resultReceived ? numOrNull(result?.total_cost_usd) : null,
    estimated_list_cost_usd_note: "estimated/list-price accounting -- not actual subscription spend, quota, or billing",
    usage_status: resultReceived ? "measured" : "unknown",
    result_raw_keys: result ? Object.keys(result) : null,
    stderr_byte_length: spawnResult.stderrByteLength,
    // Present only when spawn() itself failed (bad --claude-bin/--cwd) before any process
    // ever ran -- distinct from a real child that ran and produced no result.
    spawn_error: spawnResult.spawnError ?? null,
    hook_comparison: buildHookComparison(hookEvents),
    notes,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cliArgs = buildCliArgs(args);
  const spawnResult = await spawnAndCapture(args.claudeBin, cliArgs, {
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    killAfterMs: args.killAfterMs,
    killSignal: args.killSignal,
  });

  // Give the nested session's own SessionEnd/SubagentStop hooks a brief moment to land on
  // disk before comparing -- they're written by a process this script does not control the
  // exact teardown timing of.
  await new Promise((r) => setTimeout(r, 250));
  const sessionId = spawnResult.terminalResult?.session_id ?? spawnResult.initSessionId ?? null;
  const hookEvents = sessionId ? readSessionEvents(sessionId) : [];

  const record = buildRecord({
    taskId: args.task,
    permissionMode: args.permissionMode,
    cwd: args.cwd,
    spawnResult,
    hookEvents,
    notes: args.notes,
  });

  const outPath = args.out || join(DEFAULT_OUT_DIR, `${args.task}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        out: outPath,
        result_received: record.result_received,
        session_id: record.session_id,
        is_error: record.is_error,
      },
      null,
      2,
    ),
  );
  process.exit(record.result_received && !record.is_error ? 0 : record.result_received ? 1 : 2);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
