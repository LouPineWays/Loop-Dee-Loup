// Tests for tools/telemetry/statusline.mjs: payload -> event shaping, status-line text
// formatting, and an end-to-end CLI run confirming it both writes to disk and prints a
// display line (unlike hook.mjs, stdout here is the actual rendered status line — never
// optional). Run with:
//   node --test tools/telemetry/statusline.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEvent, formatStatusLine } from "./statusline.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATUSLINE_PATH = join(HERE, "statusline.mjs");

const FULL_PAYLOAD = {
  session_id: "s-1",
  cwd: "/home/someone/example-repo",
  workspace: { repo: { owner: "LouPineWays", name: "example-repo" } },
  model: { id: "claude-sonnet-5", display_name: "Sonnet 5" },
  cost: { total_cost_usd: 1.5, total_duration_ms: 60000, total_api_duration_ms: 20000, total_lines_added: 5, total_lines_removed: 1 },
  context_window: {
    total_input_tokens: 1000,
    total_output_tokens: 200,
    context_window_size: 200000,
    used_percentage: 12.3,
    current_usage: { input_tokens: 900, output_tokens: 150, cache_creation_input_tokens: 50, cache_read_input_tokens: 0 },
  },
  exceeds_200k_tokens: false,
};

test("buildEvent captures cost and context_window without leaking full paths", () => {
  const event = buildEvent(FULL_PAYLOAD);
  assert.equal(event.kind, "statusline_sample");
  assert.equal(event.cwd_basename, "example-repo");
  assert.equal(event.cost.total_cost_usd, 1.5);
  assert.equal(event.context_window.used_percentage, 12.3);
  assert.equal(event.context_window.current_usage.cache_read_input_tokens, 0);
  assert.equal(JSON.stringify(event).includes("/home/someone"), false);
});

test("buildEvent tolerates missing cost/context_window (pre-first-API-call statusLine sample)", () => {
  const event = buildEvent({ session_id: "s-1" });
  assert.equal(event.cost, null);
  assert.equal(event.context_window, null);
});

test("buildEvent returns null for a non-object payload", () => {
  assert.equal(buildEvent(null), null);
  assert.equal(buildEvent("not an object"), null);
});

test("formatStatusLine renders model, cost, and context usage compactly", () => {
  assert.equal(formatStatusLine(FULL_PAYLOAD), "Sonnet 5 · $1.50 · ctx 12%");
});

test("formatStatusLine degrades gracefully when fields are absent", () => {
  assert.equal(formatStatusLine({ model: { id: "claude-sonnet-5" } }), "claude-sonnet-5");
  assert.equal(formatStatusLine(null), "");
});

test("end-to-end: piping a full payload writes one sample and prints the status line", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-telemetry-statusline-test-"));
  try {
    const result = spawnSync(process.execPath, [STATUSLINE_PATH], {
      input: JSON.stringify(FULL_PAYLOAD),
      encoding: "utf8",
      env: { ...process.env, LDL_TELEMETRY_DIR: dir },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "Sonnet 5 · $1.50 · ctx 12%");
    const raw = readFileSync(join(dir, "sessions", "s-1.jsonl"), "utf8");
    const event = JSON.parse(raw.trim());
    assert.equal(event.kind, "statusline_sample");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end-to-end: malformed stdin still exits 0 and prints the empty-payload fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-telemetry-statusline-test-"));
  try {
    const result = spawnSync(process.execPath, [STATUSLINE_PATH], {
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
