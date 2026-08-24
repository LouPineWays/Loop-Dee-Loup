// Tests for tools/telemetry/hook.mjs: payload -> event shaping (buildEvent), and an
// end-to-end CLI run confirming it writes to disk but never touches stdout (stdout from
// this hook either gets injected into live session context or is discarded, so any output
// here would be a bug). Run with:
//   node --test tools/telemetry/hook.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEvent } from "./hook.mjs";

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
