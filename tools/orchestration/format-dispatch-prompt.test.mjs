// Tests for tools/orchestration/format-dispatch-prompt.mjs — issue #321's deterministic
// reference-only dispatch-prompt formatter.
//
// Run with:
//   node --test tools/orchestration/format-dispatch-prompt.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { formatDispatchPrompt, assertReferenceOnly } from "./format-dispatch-prompt.mjs";

test("formatDispatchPrompt includes the exact control Issue, execution Issue, and route", () => {
  const prompt = formatDispatchPrompt({ controlIssue: 322, executionIssue: 321, route: "implementation worker" });
  assert.match(prompt, /#321/);
  assert.match(prompt, /#322/);
  assert.match(prompt, /implementation worker/);
});

test("formatDispatchPrompt stays well under the reference-only threshold for a realistic route", () => {
  const prompt = formatDispatchPrompt({ controlIssue: 322, executionIssue: 321, route: "implementation worker" });
  assert.ok(prompt.length < 700, `expected < 700 chars, got ${prompt.length}`);
});

// Issue #286: an implementation worker dispatched by this formatter must stop at the
// PR-open/Stage-1-triggered breakpoint rather than riding AGENTS.md's general "continue
// mechanically ... until CLEAN completion" instruction through Stage 1 wait, merge, and
// Stage 2 (the #311/#310/#317/#318 reproduction recorded on #286). The stop clause must be
// part of the fixed template itself, not left to the orchestrating session to add by hand.
test("formatDispatchPrompt includes the PR-open stop clause", () => {
  const prompt = formatDispatchPrompt({ controlIssue: 322, executionIssue: 321, route: "implementation worker" });
  assert.match(prompt, /stop/i);
  assert.match(prompt, /do not wait, poll, merge, or begin Stage 2/);
  assert.match(prompt, /Watched lifecycle breakpoints/);
});

test("formatDispatchPrompt never contains restated AGENTS.md contract prose", () => {
  const prompt = formatDispatchPrompt({ controlIssue: 322, executionIssue: 321, route: "implementation worker" });
  // The regression this script exists to prevent: a dispatch prompt that restates whole
  // AGENTS.md sections (Session execution, Founder interrupt conditions, the Slice
  // handoff field list, bounded-review-cycle mechanics) instead of pointing at them.
  for (const forbidden of ["STATUS", "OUTCOME", "CHANGED", "VERIFIED", "DECISIONS", "NEW RISKS", "Founder interrupt conditions"]) {
    assert.ok(!prompt.includes(forbidden), `prompt unexpectedly contains restated field "${forbidden}"`);
  }
});

test("formatDispatchPrompt throws when a required field is missing", () => {
  assert.throws(() => formatDispatchPrompt({ controlIssue: 322, executionIssue: 321, route: "" }));
  assert.throws(() => formatDispatchPrompt({ controlIssue: null, executionIssue: 321, route: "implementation worker" }));
  assert.throws(() => formatDispatchPrompt({ controlIssue: 322, executionIssue: null, route: "implementation worker" }));
});

// Stage 1 review finding on this PR: `Number("abc")` -> NaN, `Number("-7")` -> -7,
// `Number("12.5")` -> 12.5 all pass a bare `== null` check and previously reached the
// template, producing references like "#NaN" that callers would use verbatim.
test("formatDispatchPrompt rejects non-integer, negative, or NaN issue numbers", () => {
  assert.throws(() => formatDispatchPrompt({ controlIssue: NaN, executionIssue: 321, route: "implementation worker" }));
  assert.throws(() => formatDispatchPrompt({ controlIssue: 322, executionIssue: NaN, route: "implementation worker" }));
  assert.throws(() => formatDispatchPrompt({ controlIssue: -7, executionIssue: 321, route: "implementation worker" }));
  assert.throws(() => formatDispatchPrompt({ controlIssue: 322, executionIssue: 12.5, route: "implementation worker" }));
  assert.throws(() => formatDispatchPrompt({ controlIssue: 0, executionIssue: 321, route: "implementation worker" }));
});

test("formatDispatchPrompt is deterministic for the same input", () => {
  const a = formatDispatchPrompt({ controlIssue: 322, executionIssue: 321, route: "implementation worker" });
  const b = formatDispatchPrompt({ controlIssue: 322, executionIssue: 321, route: "implementation worker" });
  assert.equal(a, b);
});

test("assertReferenceOnly passes through text at or under the threshold", () => {
  const text = "short";
  assert.equal(assertReferenceOnly(text, 700), text);
});

test("assertReferenceOnly throws for text over the threshold", () => {
  const long = "x".repeat(701);
  assert.throws(() => assertReferenceOnly(long, 700), /over the 700-char reference-only threshold/);
});

test("assertReferenceOnly catches an oversized route value even though the template itself is fixed", () => {
  const prompt = formatDispatchPrompt({
    controlIssue: 322,
    executionIssue: 321,
    route: "x".repeat(700),
  });
  assert.throws(() => assertReferenceOnly(prompt, 700));
});

// Stage 1 review finding on this PR: piped JSON that omits `state` entirely (a malformed
// or schema-drifted gate payload) but still carries controlIssue/executionIssue/route
// must never be treated as an implicit READY_TO_DISPATCH verdict — only that exact string
// authorizes a dispatch prompt. Exercised via the CLI's spawned subprocess since the
// state check lives in main(), not in an exported pure function.
test("CLI: piped JSON missing 'state' is refused, not silently treated as ready", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const scriptPath = fileURLToPath(new URL("./format-dispatch-prompt.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify({ controlIssue: 322, executionIssue: 321, route: "implementation worker" }),
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not "READY_TO_DISPATCH"/);
  assert.equal(result.stdout, "");
});

test("CLI: piped JSON with a non-ready state is still refused", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const scriptPath = fileURLToPath(new URL("./format-dispatch-prompt.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify({ state: "NOT_READY", controlIssue: 322, executionIssue: 321, route: "implementation worker" }),
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not "READY_TO_DISPATCH"/);
});

// Stage 1 review finding on this PR: a mistyped explicit CLI issue number must fail
// closed (non-zero exit, no stdout) rather than silently emitting "#NaN".
test("CLI: a malformed explicit --control-issue value fails closed", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const scriptPath = fileURLToPath(new URL("./format-dispatch-prompt.mjs", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--control-issue", "not-a-number", "--execution-issue", "321", "--route", "implementation worker"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});
