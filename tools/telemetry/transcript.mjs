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
//
// Returns { entries, hadParseError }. A line that parses as JSON but simply isn't an
// assistant-usage line (the large majority — user/system/tool-result lines) is normal and
// does not set hadParseError. A line that fails JSON.parse is a torn/corrupt write — real
// evidence this read is incomplete, not something to silently drop while reporting the
// rest of the totals as if they were the whole picture. See collectTranscriptUsage: a
// completeness signal here is what stops a partially-unreadable transcript from producing
// plausible-looking-but-wrong totals that would make an economic claim look SUFFICIENT
// when it isn't (found in review of #139/PR #144).
function extractUsageEntries(lines, { skipSidechain } = {}) {
  const seen = new Map();
  let hadParseError = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      hadParseError = true;
      continue;
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
  return { entries: [...seen.values()], hadParseError };
}

// Accumulates on a null-prototype object, not a plain {}: a model or agentType literally
// named "constructor" would otherwise resolve an inherited Object.prototype property
// instead of undefined, so `!byModel[model]` reads as false and `addInto` mutates that
// inherited function/object rather than creating a real accumulator — silently corrupting
// attribution for that key while the overall total still looks valid (found in review of
// #139/PR #144; the reducer already guards this the same way for subagent_type_counts).
// Spread into a plain object before returning so the record's JSON shape stays ordinary.
function newAccumulator() {
  return Object.create(null);
}

function sumUsage(entries) {
  const total = zeroTotals();
  const byModel = newAccumulator();
  for (const { model, usage } of entries) {
    const delta = { ...usage, message_count: 1 };
    addInto(total, delta);
    if (!byModel[model]) byModel[model] = zeroTotals();
    addInto(byModel[model], delta);
  }
  return { total, by_model: { ...byModel } };
}

// Merges N by-model breakdowns (each `{ [model]: totals }`) into one combined view,
// prototype-safe for the same reason as sumUsage's byModel above.
function mergeByModel(breakdowns) {
  const merged = newAccumulator();
  for (const breakdown of breakdowns) {
    for (const [model, totals] of Object.entries(breakdown)) {
      if (!merged[model]) merged[model] = zeroTotals();
      addInto(merged[model], totals);
    }
  }
  return { ...merged };
}

// Enumerates `<transcript_dir>/<session_id>/subagents/*.jsonl`, pairing each with its
// sibling `.meta.json` (present per subagent, see hook.mjs's SubagentStart handling) for
// the coarse `agentType` label only — never the meta file's free-text `description`.
// Tolerant of a missing directory (no subagents ran — a real, measured "zero" fact, not a
// read failure) or missing/malformed meta files (agentType falls back to "unknown" rather
// than dropping the subagent's usage). NOT tolerant of a subagent .jsonl that exists but
// can't be read or contains a torn line: that subagent was discovered but its usage is
// unmeasured, so returns null for the whole aggregate rather than a total/agent_count that
// silently excludes it while looking complete (found in review of #139/PR #144 — a missing
// subagent's tokens would otherwise vanish from the total without any signal that anything
// was lost).
function readSubagentUsage(transcriptPath) {
  const dir = dirname(transcriptPath);
  const base = crossPlatformStemOf(transcriptPath);
  const subagentsDir = join(dir, base, "subagents");

  let files;
  try {
    files = readdirSync(subagentsDir);
  } catch {
    return { total: zeroTotals(), by_agent_type: {}, by_model: {}, agent_count: 0 };
  }

  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
  const total = zeroTotals();
  const byAgentType = newAccumulator();
  const byModelBreakdowns = [];

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
    if (lines === null) return null; // this subagent transcript was discovered but unreadable
    const { entries, hadParseError } = extractUsageEntries(lines);
    if (hadParseError) return null; // torn line inside a discovered subagent transcript
    const { total: fileTotal, by_model: fileByModel } = sumUsage(entries);
    addInto(total, fileTotal);
    if (!byAgentType[agentType]) byAgentType[agentType] = zeroTotals();
    addInto(byAgentType[agentType], fileTotal);
    byModelBreakdowns.push(fileByModel);
  }

  return { total, by_agent_type: { ...byAgentType }, by_model: mergeByModel(byModelBreakdowns), agent_count: jsonlFiles.length };
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
// { main, subagents }, or null if the transcript_path itself is unusable (nothing to read
// at all). `main` and `subagents` are each independently either { total, by_model } /
// { total, by_agent_type, by_model, agent_count }, or null when *that specific* read was
// incomplete (unreadable file, or a torn line found while parsing it) — a null here means
// "this portion is unmeasured", not "zero". subagents.by_model exists (in addition to
// by_agent_type) so a session-wide per-model view — reduce.mjs's
// token_usage_session_by_model — doesn't silently drop tokens a subagent spent on a
// different model than the main thread (found in review of #139/PR #144). Never throws.
export function collectTranscriptUsage(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  try {
    const lines = readRawLines(transcriptPath);
    if (lines === null) return null; // the transcript itself is unreadable: nothing at all
    const { entries, hadParseError } = extractUsageEntries(lines, { skipSidechain: true });
    const main = hadParseError ? null : sumUsage(entries);
    const subagents = readSubagentUsage(transcriptPath);
    return { main, subagents };
  } catch {
    return null;
  }
}
