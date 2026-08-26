// Reads Claude Code's own session transcript to recover the token-economic evidence
// statusLine cannot supply in Loop-Dee-Loup's normal (non-interactive) execution mode —
// see "statusLine's confirmed non-interactive gap" in tools/telemetry/README.md.
//
// Claude Code writes one structured JSONL file per session (the path a hook payload's
// `transcript_path` field points to) plus, when subagents ran, one sibling JSONL + a
// `.meta.json` per subagent under `<transcript_dir>/<session_id>/subagents/`. Each
// assistant-turn line in either file carries a `message.usage` object (input/output/
// cache-read/cache-creation token counts) and `message.model` — the same numbers Claude
// Code itself uses to compute cost, written as normal session operation rather than
// anything this collector has to instrument. That makes it the "existing supported
// structured telemetry" this issue's constraints prefer over standing up OpenTelemetry.
//
// This module never persists transcript_path, prompts, responses, reasoning, tool output,
// or the subagent .meta.json's free-text `description` field — only numeric token counts,
// coarse `model`/`agentType` identifiers, and counts. It never throws: a transcript read
// failure (missing file, torn write, unexpected shape) must degrade to "unmeasured", never
// interrupt the hook that calls it. See hook.mjs and tools/telemetry/README.md.
//
// Tests: node --test tools/telemetry/transcript.test.mjs

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

function zeroTotals() {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, message_count: 0 };
}

function numOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addInto(totals, delta) {
  totals.input_tokens += delta.input_tokens;
  totals.output_tokens += delta.output_tokens;
  totals.cache_creation_input_tokens += delta.cache_creation_input_tokens;
  totals.cache_read_input_tokens += delta.cache_read_input_tokens;
  totals.message_count += delta.message_count;
}

// Reads a transcript JSONL file's raw lines. Returns null (not []) on any read failure so
// callers can distinguish "file unreadable, evidence unmeasured" from "file readable but
// genuinely has nothing to aggregate" — a session with zero assistant turns is a real,
// measured fact, not a gap.
function readRawLines(filePath) {
  try {
    return readFileSync(filePath, "utf8").split("\n");
  } catch {
    return null;
  }
}

// Parses one transcript file's lines into deduplicated per-message usage entries.
// Claude Code repeats the same cumulative `message.usage` snapshot across every streamed
// line belonging to one message (same `message.id`); summing raw lines would double- or
// triple-count every turn, so dedup by message id first.
function extractUsageEntries(lines, { skipSidechain } = {}) {
  const seen = new Map();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // torn/corrupt line — skip, don't fail the whole read
    }
    if (skipSidechain && obj?.isSidechain === true) continue;
    const msg = obj?.message;
    const usage = msg?.usage;
    if (!usage || typeof usage !== "object" || typeof msg.id !== "string") continue;
    seen.set(msg.id, {
      model: typeof msg.model === "string" && msg.model ? msg.model : "unknown",
      usage: {
        input_tokens: numOrZero(usage.input_tokens),
        output_tokens: numOrZero(usage.output_tokens),
        cache_creation_input_tokens: numOrZero(usage.cache_creation_input_tokens),
        cache_read_input_tokens: numOrZero(usage.cache_read_input_tokens),
      },
    });
  }
  return [...seen.values()];
}

function sumUsage(entries) {
  const total = zeroTotals();
  const byModel = {};
  for (const { model, usage } of entries) {
    const delta = { ...usage, message_count: 1 };
    addInto(total, delta);
    if (!byModel[model]) byModel[model] = zeroTotals();
    addInto(byModel[model], delta);
  }
  return { total, by_model: byModel };
}

// Enumerates `<transcript_dir>/<session_id>/subagents/*.jsonl`, pairing each with its
// sibling `.meta.json` (present per subagent, see hook.mjs's SubagentStart handling) for
// the coarse `agentType` label only — never the meta file's free-text `description`.
// Tolerant of a missing directory (no subagents ran) or missing/malformed meta files
// (agentType falls back to "unknown" rather than dropping the subagent's usage).
function readSubagentUsage(transcriptPath) {
  const dir = dirname(transcriptPath);
  const base = crossPlatformStemOf(transcriptPath);
  const subagentsDir = join(dir, base, "subagents");

  let files;
  try {
    files = readdirSync(subagentsDir);
  } catch {
    return { total: zeroTotals(), by_agent_type: {}, agent_count: 0 };
  }

  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
  const total = zeroTotals();
  const byAgentType = {};

  for (const file of jsonlFiles) {
    const stem = file.slice(0, -".jsonl".length);
    let agentType = "unknown";
    try {
      const meta = JSON.parse(readFileSync(join(subagentsDir, `${stem}.meta.json`), "utf8"));
      if (typeof meta.agentType === "string" && meta.agentType.trim()) agentType = meta.agentType.trim();
    } catch {
      // no/unreadable meta file — keep "unknown" rather than dropping this subagent's usage
    }
    const lines = readRawLines(join(subagentsDir, file));
    if (lines === null) continue;
    const { total: fileTotal } = sumUsage(extractUsageEntries(lines));
    addInto(total, fileTotal);
    if (!byAgentType[agentType]) byAgentType[agentType] = zeroTotals();
    addInto(byAgentType[agentType], fileTotal);
  }

  return { total, by_agent_type: byAgentType, agent_count: jsonlFiles.length };
}

// path.basename(p, ".jsonl") assumes the running platform's separator; a transcript_path
// is always a native path for the machine that wrote it (the same machine running this
// hook), so a plain split on both separators is enough and avoids relying on node:path's
// platform-specific basename picking the wrong splitter under a mismatched test fixture.
function crossPlatformStemOf(pathValue) {
  const parts = String(pathValue).split(/[/\\]+/).filter(Boolean);
  const filename = parts[parts.length - 1] || "";
  return filename.endsWith(".jsonl") ? filename.slice(0, -".jsonl".length) : filename;
}

// Top-level entry point: given a hook payload's transcript_path, returns
// { main: { total, by_model }, subagents: { total, by_agent_type, agent_count } }, or null
// if the transcript itself could not be read at all (nothing measured). Never throws.
export function collectTranscriptUsage(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  try {
    const lines = readRawLines(transcriptPath);
    if (lines === null) return null;
    const main = sumUsage(extractUsageEntries(lines, { skipSidechain: true }));
    const subagents = readSubagentUsage(transcriptPath);
    return { main, subagents };
  } catch {
    return null;
  }
}
