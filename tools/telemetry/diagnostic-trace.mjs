#!/usr/bin/env node
// Deterministic diagnostic-trace extractor for explicitly marked LDL proving/debug
// sessions — issue #310.
//
// Pipeline (per #310's Option A):
//   existing local Claude transcript -> deterministic diagnostic extractor
//                                     -> privacy-minimal derived artifact
//
// This is NOT a live recorder and is NOT wired into .claude/settings.json or any other
// automatic entry point. It only ever runs when a session (or a founder reviewing a
// session afterward) explicitly invokes this script by hand with --diagnostic-mode and
// a transcript path — that invocation IS the opt-in. Normal LDL sessions never call
// this file, so normal telemetry (tools/telemetry/collect.mjs, hook.mjs) is completely
// unaffected: no new hook, no new persisted field, no change to coverage.mjs's
// decision-critical contract.
//
// What it extracts, deterministically, from the assistant `tool_use` blocks a real
// Claude Code transcript already contains — never from private/hidden reasoning:
//   - pre-dispatch structural events (issue reads, git status, PR queries) in order;
//   - whether a specific execution issue (--execution-issue) was read before the first
//     subagent (Task tool) dispatch;
//   - each subagent dispatch's time offset, subagent_type, prompt character count, a
//     `reference_only` flag (chars <= --reference-threshold-chars), and any small
//     issue-number references (#N) found in the prompt text;
//   - optionally, one short (<=240 char) truncated excerpt of the assistant text/
//     thinking block immediately preceding a detected forbidden pre-dispatch read of
//     the execution issue, when --annotate is passed. No excerpt is ever produced
//     unless that specific violation is detected.
//
// What it never persists: the full prompt/tool-input text of any tool call, full
// transcript content, tool outputs, repository file contents, credentials, secrets, or
// transcript_path itself. Only coarse identifiers, counts, timestamps, small extracted
// issue-number references, and (bounded, opt-in) short truncated excerpts.
//
// Usage:
//   node tools/telemetry/diagnostic-trace.mjs --transcript <path> --diagnostic-mode \
//     --control-issue <n> [--execution-issue <n>] [--session <id>] \
//     [--reference-threshold-chars <n>] [--annotate] [--out <path>] \
//     [--index <path>] [--no-index]
//
// Tests: node --test tools/telemetry/diagnostic-trace.test.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_REFERENCE_THRESHOLD_CHARS = 700;
const MAX_PRE_DISPATCH_EVENTS = 100;
const MAX_ANNOTATION_CHARS = 240;
const MAX_WORKER_REFERENCES = 10;

function parseLines(raw) {
  const out = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Torn/corrupt line — skip it. Diagnostic traces are best-effort structural
      // evidence, not a completeness-guaranteeing measurement like transcript.mjs's
      // token accounting; a skipped line degrades granularity, never correctness of
      // what IS reported.
    }
  }
  return out;
}

function isAssistantToolUseLine(line) {
  return line?.type === "assistant" && Array.isArray(line?.message?.content);
}

function toolUseBlocks(line) {
  return line.message.content.filter((c) => c?.type === "tool_use" && typeof c.name === "string");
}

function textLikeExcerpt(line) {
  if (!isAssistantToolUseLine(line)) return null;
  const block = line.message.content.find(
    (c) => (c?.type === "text" || c?.type === "thinking") && typeof (c.text ?? c.thinking) === "string",
  );
  if (!block) return null;
  const text = (block.text ?? block.thinking).trim();
  if (!text) return null;
  return text.length > MAX_ANNOTATION_CHARS ? `${text.slice(0, MAX_ANNOTATION_CHARS)}…` : text;
}

// Classifies one tool_use block into a small structural kind, or null when the tool
// call is not one of the pre-dispatch events #310 asks for. Only numeric/short refs
// are ever extracted from the underlying command/input text — never the text itself.
function classifyToolUse(block) {
  const name = block.name;
  const input = block.input && typeof block.input === "object" ? block.input : {};

  if (name === "Bash" && typeof input.command === "string") {
    const cmd = input.command;
    let m = cmd.match(/\bgh\s+issue\s+view\s+(\d+)/);
    if (m) return { kind: "issue_read", ref: `#${m[1]}` };
    m = cmd.match(/\bissues\/(\d+)\b/);
    if (m) return { kind: "issue_read", ref: `#${m[1]}` };
    if (/\bgit\s+status\b/.test(cmd)) return { kind: "git_status" };
    if (/\bgh\s+pr\s+(view|list|status|checks)\b/.test(cmd)) return { kind: "pr_query" };
    if (/\bgit\s+log\b/.test(cmd)) return { kind: "git_log" };
    return null;
  }

  if (name === "WebFetch" && typeof input.url === "string") {
    const m = input.url.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
    if (m) return { kind: "issue_read", ref: `#${m[1]}` };
    return null;
  }

  if (name === "Grep" || name === "Glob") return { kind: "repo_search" };

  return null;
}

// Extracts up to MAX_WORKER_REFERENCES distinct "#N" issue-number references from a
// dispatch prompt string — a bounded, numeric-only derived field, never the prompt text
// itself.
function extractIssueRefs(promptText) {
  if (typeof promptText !== "string" || !promptText) return [];
  const seen = new Set();
  const out = [];
  const re = /#(\d+)/g;
  let m;
  while ((m = re.exec(promptText)) && out.length < MAX_WORKER_REFERENCES) {
    const ref = `#${m[1]}`;
    if (!seen.has(ref)) {
      seen.add(ref);
      out.push(ref);
    }
  }
  return out;
}

function tsToMs(ts) {
  const parsed = typeof ts === "string" ? Date.parse(ts) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

// Pure core: builds a diagnostic trace object from already-parsed transcript lines.
// Exported separately from file I/O so tests can build fixtures in memory instead of
// touching disk, matching this directory's existing transcript.test.mjs convention.
export function buildDiagnosticTrace(lines, options = {}) {
  const {
    session = null,
    controlIssue = null,
    executionIssue = null,
    referenceThresholdChars = DEFAULT_REFERENCE_THRESHOLD_CHARS,
    annotate = false,
  } = options;

  const executionRef = executionIssue != null ? `#${String(executionIssue).replace(/^#/, "")}` : null;

  let sessionStartMs = null;
  let derivedSession = session;
  for (const line of lines) {
    const ms = tsToMs(line?.timestamp);
    if (ms !== null && sessionStartMs === null) sessionStartMs = ms;
    if (derivedSession === null && typeof line?.sessionId === "string" && line.sessionId) {
      derivedSession = line.sessionId;
    }
    if (sessionStartMs !== null && derivedSession !== null) break;
  }

  const preDispatchEvents = [];
  const dispatchEvents = [];
  let executionIssueReadBeforeDispatch = executionRef ? false : null;
  let firstDispatchSeen = false;
  const annotations = [];
  let precedingExcerpt = null;
  let truncated = false;

  for (const line of lines) {
    if (!isAssistantToolUseLine(line)) continue;

    const excerpt = textLikeExcerpt(line);
    if (excerpt) precedingExcerpt = { ts: line.timestamp ?? null, text: excerpt };

    for (const block of toolUseBlocks(line)) {
      if (block.name === "Task") {
        const ms = tsToMs(line.timestamp);
        const promptText = typeof block.input?.prompt === "string" ? block.input.prompt : "";
        const chars = promptText.length;
        const referenceOnly = chars > 0 ? chars <= referenceThresholdChars : null;
        const workerReferences = extractIssueRefs(promptText);
        dispatchEvents.push({
          offset_ms: sessionStartMs !== null && ms !== null ? ms - sessionStartMs : null,
          subagent_type: typeof block.input?.subagent_type === "string" ? block.input.subagent_type : null,
          prompt: { chars, reference_only: referenceOnly, worker_references: workerReferences },
        });
        firstDispatchSeen = true;
        continue;
      }

      if (firstDispatchSeen) continue; // only pre-dispatch events are classified below

      const classified = classifyToolUse(block);
      if (!classified) continue;

      if (classified.kind === "issue_read" && executionRef && classified.ref === executionRef) {
        executionIssueReadBeforeDispatch = true;
        if (annotate && precedingExcerpt && annotations.length === 0) {
          annotations.push({
            reason: "execution_issue_read_before_dispatch",
            ref: executionRef,
            ...precedingExcerpt,
          });
        }
      }

      if (preDispatchEvents.length < MAX_PRE_DISPATCH_EVENTS) {
        preDispatchEvents.push(classified);
      } else {
        truncated = true;
      }
    }
  }

  const firstDispatch = dispatchEvents[0] ?? null;

  return {
    session: derivedSession,
    control_issue: controlIssue,
    execution_issue: executionIssue,
    diagnostic_mode: true,
    first_dispatch_ms: firstDispatch?.offset_ms ?? null,
    execution_issue_read_by_controller_before_dispatch: executionIssueReadBeforeDispatch,
    pre_dispatch_events: preDispatchEvents,
    pre_dispatch_events_truncated: truncated,
    dispatch_prompt: firstDispatch?.prompt ?? null,
    dispatch_events: dispatchEvents,
    annotations,
  };
}

// A trace has dispatch evidence when it recorded at least one completed subagent
// dispatch — either the full `dispatch_events` array `buildDiagnosticTrace` always
// populates, or (for a hand-built/reloaded partial trace, as a fresh reviewer might
// construct from a saved artifact) a non-null `dispatch_prompt`. Tolerant of either
// shape so classifyPreDispatch works the same whether it's called on a freshly built
// trace or one round-tripped through plain JSON.
function hasDispatchEvidence(trace) {
  if (Array.isArray(trace?.dispatch_events) && trace.dispatch_events.length > 0) return true;
  if (trace?.dispatch_prompt && typeof trace.dispatch_prompt === "object") return true;
  return false;
}

// #283-class classification: distinguishes a clean immediate reference-only dispatch
// from a regression sequence, using only the trace's own structural fields — no model
// judgment, so any fresh reviewer (human or agent) can reproduce this verdict from the
// artifact alone.
//
// Known violation evidence is checked FIRST, independent of whether a dispatch ever
// happened: a pre-dispatch execution-issue read is itself a proven boundary violation
// the moment it occurs, whether or not the session went on to dispatch anything
// afterward. Gating that check behind "did a dispatch happen" would silently discard an
// already-proven violation for exactly the sessions most worth surfacing — an
// interrupted or truncated run that read the thick execution issue and then never
// completed a dispatch (Stage 1 review finding on PR #319, against the real trace this
// mechanism's own #310/#311 proving session produced: it has
// execution_issue_read_by_controller_before_dispatch: true and no dispatch, and an
// earlier version of this function reported that "indeterminate", hiding the violation
// its own index was supposed to surface).
//
// Only once no known violation exists does the absence of a completed dispatch matter:
// a trace with no recorded dispatch at all (an interrupted, truncated, or
// pre-dispatch-only transcript, and no already-proven violation either) must never read
// as "clean" — "clean" is a positive claim that the required control-read ->
// immediate-reference-only-dispatch sequence actually completed without incident, and a
// transcript that never reached dispatch has not demonstrated that sequence one way or
// the other (Stage 2 audit finding on PR #317). Such a trace is reported
// "indeterminate" instead, distinct from both "clean" and a proven "violation".
export function classifyPreDispatch(trace) {
  const reasons = [];
  if (trace?.execution_issue_read_by_controller_before_dispatch === true) {
    reasons.push("execution issue was read by the controller before the first subagent dispatch");
  }
  if (trace?.dispatch_prompt && trace.dispatch_prompt.reference_only === false) {
    reasons.push("dispatch prompt exceeded the reference-only size threshold (possible requirement retransmission)");
  }
  if (reasons.length > 0) {
    return { status: "violation", reasons };
  }

  if (!hasDispatchEvidence(trace)) {
    return {
      status: "indeterminate",
      reasons: [
        "no subagent dispatch was observed in this trace, and no violation was found in what was observed — the required control-read -> immediate-dispatch sequence never completed, so this trace proves a clean sequence did not happen either",
      ],
    };
  }

  return { status: "clean", reasons: [] };
}

export function extractDiagnosticTrace(transcriptPath, options = {}) {
  const raw = readFileSync(transcriptPath, "utf8");
  const lines = parseLines(raw);
  return buildDiagnosticTrace(lines, options);
}

function parseArgs(argv) {
  const opts = {
    diagnosticMode: false,
    annotate: false,
    writeIndex: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--transcript":
        opts.transcript = argv[++i];
        break;
      case "--session":
        opts.session = argv[++i];
        break;
      case "--control-issue":
        opts.controlIssue = Number(argv[++i]);
        break;
      case "--execution-issue":
        opts.executionIssue = Number(argv[++i]);
        break;
      case "--reference-threshold-chars":
        opts.referenceThresholdChars = Number(argv[++i]);
        break;
      case "--out":
        opts.out = argv[++i];
        break;
      case "--index":
        opts.index = argv[++i];
        break;
      case "--no-index":
        opts.writeIndex = false;
        break;
      case "--diagnostic-mode":
        opts.diagnosticMode = true;
        break;
      case "--annotate":
        opts.annotate = true;
        break;
      default:
        break;
    }
  }
  return opts;
}

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "diagnostic-traces");

function defaultOutPath(session) {
  const safe = typeof session === "string" && session ? session.replace(/[^A-Za-z0-9._-]/g, "-") : `trace-${Date.now()}`;
  return join(DOCS_DIR, `${safe}.json`);
}

function appendToIndex(indexPath, entry) {
  mkdirSync(dirname(indexPath), { recursive: true });
  let index = [];
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, "utf8"));
      if (!Array.isArray(index)) index = [];
    } catch {
      index = [];
    }
  }
  index.push(entry);
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // The opt-in gate: this CLI refuses to run at all without --diagnostic-mode. The
  // script's mere existence never captures anything — an explicit flag on an explicit
  // invocation is required every time, so normal sessions cannot accidentally trigger
  // diagnostic capture merely by having this file present in the repository.
  if (!opts.diagnosticMode) {
    process.stderr.write(
      "diagnostic-trace.mjs: refusing to run without --diagnostic-mode (explicit opt-in required; see tools/telemetry/README.md)\n",
    );
    process.exit(2);
  }
  if (!opts.transcript) {
    process.stderr.write("diagnostic-trace.mjs: --transcript <path> is required\n");
    process.exit(2);
  }
  if (!opts.controlIssue || !Number.isFinite(opts.controlIssue)) {
    process.stderr.write("diagnostic-trace.mjs: --control-issue <n> is required\n");
    process.exit(2);
  }

  const trace = extractDiagnosticTrace(opts.transcript, {
    session: opts.session ?? null,
    controlIssue: opts.controlIssue,
    executionIssue: Number.isFinite(opts.executionIssue) ? opts.executionIssue : null,
    referenceThresholdChars: Number.isFinite(opts.referenceThresholdChars)
      ? opts.referenceThresholdChars
      : DEFAULT_REFERENCE_THRESHOLD_CHARS,
    annotate: opts.annotate,
  });

  const outPath = opts.out ?? defaultOutPath(opts.session);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");

  if (opts.writeIndex) {
    const indexPath = opts.index ?? join(DOCS_DIR, "index.json");
    const classification = classifyPreDispatch(trace);
    appendToIndex(indexPath, {
      session: trace.session,
      control_issue: trace.control_issue,
      execution_issue: trace.execution_issue,
      path: outPath.split(/[\\/]/).slice(-2).join("/"),
      created_at: new Date().toISOString(),
      pre_dispatch_status: classification.status,
    });
  }

  process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
