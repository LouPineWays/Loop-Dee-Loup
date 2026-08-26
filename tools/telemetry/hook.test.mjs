// Tests for tools/telemetry/hook.mjs: payload -> event shaping (buildEvent), and an
// end-to-end CLI run confirming it writes to disk but never touches stdout (stdout from
// this hook either gets injected into live session context or is discarded, so any output
// here would be a bug). Run with:
//   node --test tools/telemetry/hook.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEvent, buildTranscriptUsageEvent } from "./hook.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(HERE, "hook.mjs");

test("buildEvent shapes SessionStart into a compact hook event", () => {
  const event = buildEvent({
    hook_event_name: "SessionStart",
    session_id: "s-1",
    cwd: "/home/someone/example-repo",
    source: "startup",
    workspace: { repo: { owner: "LouPineWays", name: "example-repo" } },
  });
  assert.equal(event.kind, "hook");
  assert.equal(event.event, "SessionStart");
  assert.equal(event.session_id, "s-1");
  assert.equal(event.reason, "startup");
  assert.equal(event.cwd_basename, "example-repo");
  assert.ok(event.ts);
});

test("buildEvent carries trigger for PreCompact/PostCompact and agent identity for Subagent events", () => {
  const compact = buildEvent({ hook_event_name: "PreCompact", session_id: "s-1", trigger: "auto" });
  assert.equal(compact.trigger, "auto");

  const subagent = buildEvent({
    hook_event_name: "SubagentStart",
    session_id: "s-1",
    agent_id: "a-1",
    agent_type: "Explore",
  });
  assert.equal(subagent.agent_id, "a-1");
  assert.equal(subagent.agent_type, "Explore");
});

test("buildEvent returns null for a payload with no hook_event_name (nothing to attribute)", () => {
  assert.equal(buildEvent({ session_id: "s-1" }), null);
  assert.equal(buildEvent(null), null);
});

test("buildEvent never carries prompt/response content even if the payload includes it", () => {
  const event = buildEvent({
    hook_event_name: "SessionStart",
    session_id: "s-1",
    transcript_path: "/home/someone/.claude/projects/x/s-1.jsonl",
    prompt: "sensitive user text",
  });
  const flat = JSON.stringify(event);
  assert.equal(flat.includes("sensitive"), false);
  assert.equal(flat.includes("transcript_path"), false);
});

test("buildTranscriptUsageEvent returns null for event types other than SessionEnd/PreCompact", () => {
  const base = buildEvent({ hook_event_name: "SessionStart", session_id: "s-1" });
  assert.equal(buildTranscriptUsageEvent({ transcript_path: "/does/not/matter.jsonl" }, base), null);
});

test("buildTranscriptUsageEvent returns null when the payload has no transcript_path", () => {
  const base = buildEvent({ hook_event_name: "SessionEnd", session_id: "s-1" });
  assert.equal(buildTranscriptUsageEvent({}, base), null);
  assert.equal(buildTranscriptUsageEvent({ transcript_path: 42 }, base), null);
});

test("buildTranscriptUsageEvent returns null when the transcript can't be read, without throwing", () => {
  const base = buildEvent({ hook_event_name: "SessionEnd", session_id: "s-1" });
  const result = buildTranscriptUsageEvent({ transcript_path: join(tmpdir(), "ldl-hook-test-never-exists", "x.jsonl") }, base);
  assert.equal(result, null);
});

test("buildTranscriptUsageEvent reads real usage from a transcript file and never carries transcript_path", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-hook-test-"));
  try {
    const sessionId = "s-transcript-1";
    const transcriptPath = join(dir, `${sessionId}.jsonl`);
    const usage = { input_tokens: 3, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 };
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "assistant", isSidechain: false, message: { id: "m1", model: "claude-sonnet-5", usage } }) + "\n",
      "utf8",
    );

    const base = buildEvent({
      hook_event_name: "SessionEnd",
      session_id: sessionId,
      reason: "other",
      workspace: { repo: { owner: "LouPineWays", name: "example-repo" } },
    });
    const usageEvent = buildTranscriptUsageEvent({ hook_event_name: "SessionEnd", session_id: sessionId, transcript_path: transcriptPath }, base);

    assert.ok(usageEvent);
    assert.equal(usageEvent.kind, "transcript_usage");
    assert.equal(usageEvent.event, "SessionEnd");
    assert.equal(usageEvent.session_id, sessionId);
    assert.deepEqual(usageEvent.main.total, { ...usage, message_count: 1 });
    assert.equal("transcript_path" in usageEvent, false);
    assert.equal(JSON.stringify(usageEvent).includes(transcriptPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end-to-end: a SessionEnd payload with transcript_path writes both a hook event and a transcript_usage event", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-telemetry-hook-test-"));
  const transcriptDir = mkdtempSync(join(tmpdir(), "ldl-telemetry-hook-transcript-"));
  try {
    const sessionId = "cli-session-transcript-1";
    const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);
    const usage = { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "assistant", isSidechain: false, message: { id: "m1", model: "claude-sonnet-5", usage } }) + "\n",
      "utf8",
    );

    const payload = JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId, reason: "other", transcript_path: transcriptPath });
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: payload,
      encoding: "utf8",
      env: { ...process.env, LDL_TELEMETRY_DIR: dir },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");

    const events = readFileSync(join(dir, "sessions", `${sessionId}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 2);
    assert.equal(events[0].event, "SessionEnd");
    assert.equal(events[0].kind, "hook");
    assert.equal(events[1].kind, "transcript_usage");
    assert.deepEqual(events[1].main.total, { ...usage, message_count: 1 });
    const flat = JSON.stringify(events);
    assert.equal(flat.includes(transcriptPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(transcriptDir, { recursive: true, force: true });
  }
});

test("end-to-end: piping a SessionStart payload writes one event and prints nothing to stdout", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-telemetry-hook-test-"));
  try {
    const payload = JSON.stringify({ hook_event_name: "SessionStart", session_id: "cli-session-1", source: "startup" });
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: payload,
      encoding: "utf8",
      env: { ...process.env, LDL_TELEMETRY_DIR: dir },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    const raw = readFileSync(join(dir, "sessions", "cli-session-1.jsonl"), "utf8");
    const event = JSON.parse(raw.trim());
    assert.equal(event.event, "SessionStart");
    assert.equal(event.session_id, "cli-session-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end-to-end: malformed stdin still exits 0 and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-telemetry-hook-test-"));
  try {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: "{ not valid json",
      encoding: "utf8",
      env: { ...process.env, LDL_TELEMETRY_DIR: dir },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
