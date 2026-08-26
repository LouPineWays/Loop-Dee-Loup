// Tests for tools/telemetry/transcript.mjs's transcript-derived token usage collector.
// Builds real temp files matching Claude Code's actual on-disk transcript shapes (main
// session JSONL + a <session>/subagents/ sibling directory) rather than mocking the
// filesystem, since the exact directory layout is the thing this module depends on.
// Run with:
//   node --test tools/telemetry/transcript.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTranscriptUsage } from "./transcript.mjs";

function assistantLine({ id, model, usage, extraTopLevel = {} }) {
  return JSON.stringify({
    type: "assistant",
    isSidechain: false,
    message: { id, model, usage, role: "assistant" },
    ...extraTopLevel,
  });
}

test("collectTranscriptUsage sums a single-model session and dedupes repeated streamed lines by message id", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-transcript-test-"));
  try {
    const transcriptPath = join(dir, "s-1.jsonl");
    const usage = { input_tokens: 2, output_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 4000 };
    // Claude Code repeats the same cumulative usage across every streamed line of one
    // message — three lines here, same message id, must count as one turn.
    writeFileSync(
      transcriptPath,
      [
        assistantLine({ id: "msg_1", model: "claude-sonnet-5", usage }),
        assistantLine({ id: "msg_1", model: "claude-sonnet-5", usage }),
        assistantLine({ id: "msg_1", model: "claude-sonnet-5", usage }),
        assistantLine({ id: "msg_2", model: "claude-sonnet-5", usage }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = collectTranscriptUsage(transcriptPath);
    assert.deepEqual(result.main.total, {
      input_tokens: 4,
      output_tokens: 200,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 8000,
      message_count: 2,
    });
    assert.deepEqual(result.main.by_model["claude-sonnet-5"], result.main.total);
    assert.deepEqual(result.subagents, { total: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, message_count: 0 }, by_agent_type: {}, agent_count: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTranscriptUsage attributes subagent transcripts by their meta.json agentType, not the main session's model mix", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-transcript-test-"));
  try {
    const sessionId = "s-2";
    const transcriptPath = join(dir, `${sessionId}.jsonl`);
    const mainUsage = { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 };
    writeFileSync(transcriptPath, assistantLine({ id: "msg_main_1", model: "claude-sonnet-5", usage: mainUsage }) + "\n", "utf8");

    const subagentsDir = join(dir, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });

    const exploreUsage = { input_tokens: 1, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 300 };
    writeFileSync(join(subagentsDir, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", description: "sensitive task text" }));
    writeFileSync(join(subagentsDir, "agent-a1.jsonl"), assistantLine({ id: "msg_a1_1", model: "claude-sonnet-5", usage: exploreUsage }) + "\n", "utf8");

    const generalUsage = { input_tokens: 2, output_tokens: 40, cache_creation_input_tokens: 10, cache_read_input_tokens: 600 };
    writeFileSync(join(subagentsDir, "agent-a2.meta.json"), JSON.stringify({ agentType: "general-purpose" }));
    writeFileSync(join(subagentsDir, "agent-a2.jsonl"), assistantLine({ id: "msg_a2_1", model: "claude-sonnet-5", usage: generalUsage }) + "\n", "utf8");

    const result = collectTranscriptUsage(transcriptPath);
    assert.deepEqual(result.main.total, { ...mainUsage, message_count: 1 });
    assert.equal(result.subagents.agent_count, 2);
    assert.deepEqual(result.subagents.by_agent_type.Explore, { ...exploreUsage, message_count: 1 });
    assert.deepEqual(result.subagents.by_agent_type["general-purpose"], { ...generalUsage, message_count: 1 });
    assert.deepEqual(result.subagents.total, {
      input_tokens: exploreUsage.input_tokens + generalUsage.input_tokens,
      output_tokens: exploreUsage.output_tokens + generalUsage.output_tokens,
      cache_creation_input_tokens: exploreUsage.cache_creation_input_tokens + generalUsage.cache_creation_input_tokens,
      cache_read_input_tokens: exploreUsage.cache_read_input_tokens + generalUsage.cache_read_input_tokens,
      message_count: 2,
    });

    // Privacy: the subagent meta file's free-text description must never survive into
    // the returned aggregate, only the coarse agentType label.
    const flat = JSON.stringify(result);
    assert.equal(flat.includes("sensitive"), false);
    assert.equal(flat.includes("description"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTranscriptUsage returns null when the transcript itself can't be read (unmeasured, not zero)", () => {
  const result = collectTranscriptUsage(join(tmpdir(), "ldl-transcript-test-never-created", "missing.jsonl"));
  assert.equal(result, null);
});

test("collectTranscriptUsage returns null/false-y for a non-string or empty transcript_path", () => {
  assert.equal(collectTranscriptUsage(null), null);
  assert.equal(collectTranscriptUsage(undefined), null);
  assert.equal(collectTranscriptUsage(""), null);
  assert.equal(collectTranscriptUsage(42), null);
});

test("collectTranscriptUsage tolerates a missing subagents directory (no subagents ran)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-transcript-test-"));
  try {
    const transcriptPath = join(dir, "s-3.jsonl");
    writeFileSync(transcriptPath, assistantLine({ id: "m1", model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) + "\n", "utf8");
    const result = collectTranscriptUsage(transcriptPath);
    assert.equal(result.subagents.agent_count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTranscriptUsage falls back to agentType 'unknown' for a subagent with a missing or malformed meta.json, without dropping its usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-transcript-test-"));
  try {
    const sessionId = "s-4";
    const transcriptPath = join(dir, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, "", "utf8");
    const subagentsDir = join(dir, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    // No .meta.json written at all for this one.
    const usage = { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    writeFileSync(join(subagentsDir, "agent-nometa.jsonl"), assistantLine({ id: "m1", model: "claude-sonnet-5", usage }) + "\n", "utf8");

    const result = collectTranscriptUsage(transcriptPath);
    assert.equal(result.subagents.agent_count, 1);
    assert.deepEqual(result.subagents.by_agent_type.unknown, { ...usage, message_count: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTranscriptUsage skips lines with isSidechain:true in the main transcript, malformed JSON, and non-assistant lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-transcript-test-"));
  try {
    const transcriptPath = join(dir, "s-5.jsonl");
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    writeFileSync(
      transcriptPath,
      [
        assistantLine({ id: "m1", model: "claude-sonnet-5", usage }),
        JSON.stringify({ type: "assistant", isSidechain: true, message: { id: "m-sidechain", model: "claude-sonnet-5", usage } }),
        JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
        "{ not valid json",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = collectTranscriptUsage(transcriptPath);
    assert.deepEqual(result.main.total, { ...usage, message_count: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTranscriptUsage never carries prompt/response text, model output content, or the transcript path itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-transcript-test-"));
  try {
    const transcriptPath = join(dir, "s-6.jsonl");
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: "assistant",
        isSidechain: false,
        message: { id: "m1", model: "claude-sonnet-5", usage, content: [{ type: "text", text: "this is sensitive assistant output" }] },
      }) + "\n",
      "utf8",
    );
    const result = collectTranscriptUsage(transcriptPath);
    const flat = JSON.stringify(result);
    assert.equal(flat.includes("sensitive"), false);
    assert.equal(flat.includes(transcriptPath.replace(/\\/g, "\\\\")), false);
    assert.equal(flat.includes("s-6.jsonl"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
