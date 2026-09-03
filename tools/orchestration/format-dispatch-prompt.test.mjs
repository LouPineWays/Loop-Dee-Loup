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
