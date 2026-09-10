// Tests for tools/orchestration/format-dispatch-prompt.mjs — issue #321's deterministic
// reference-only dispatch-prompt formatter.
//
// Run with:
//   node --test tools/orchestration/format-dispatch-prompt.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDispatchPrompt,
  formatPlanningWorkerDispatchPrompt,
  formatPlanningCorrectionWorkerDispatchPrompt,
  formatIntegrationWorkerDispatchPrompt,
  assertReferenceOnly,
} from "./format-dispatch-prompt.mjs";

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

// Stage 2 audit #363 finding on merged PR #362: the three assertions above also match the
// *pre-fix* template text from before commit dd643668b363aa6e2127efdea351943ac39dee8a (which
// added the Stage 1 exemption branch below) — a revert of that commit would still pass them
// unchanged, because none of them pin the exemption-specific wording. This test asserts the
// exemption branch itself, so reverting dd643668b363aa6e2127efdea351943ac39dee8a back to only
// "Stage 1 review has been requested, stop" fails this test.
test("formatDispatchPrompt's stop clause covers the recorded Stage 1 exemption branch, not just a review-requested PR", () => {
  const prompt = formatDispatchPrompt({ controlIssue: 322, executionIssue: 321, route: "implementation worker" });
  assert.match(prompt, /Stage 1 review requested, or/);
  assert.match(prompt, /a recorded Stage 1 exemption for non-review-worthy work/);
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

// -- #397's two new templates: "Planning worker dispatch" / "Integration/PR worker dispatch" ---

test("formatPlanningWorkerDispatchPrompt includes the exact control Issue and execution Issue references and no route", () => {
  const prompt = formatPlanningWorkerDispatchPrompt({ controlIssue: 408, executionIssue: 407 });
  assert.match(prompt, /^Planning worker dispatch\./);
  assert.match(prompt, /#407/);
  assert.match(prompt, /#408/);
  assert.ok(!prompt.includes("Route:"));
});

test("formatPlanningWorkerDispatchPrompt stays well under the reference-only threshold", () => {
  const prompt = formatPlanningWorkerDispatchPrompt({ controlIssue: 408, executionIssue: 407 });
  assert.ok(prompt.length < 700, `expected < 700 chars, got ${prompt.length}`);
});

test("formatPlanningWorkerDispatchPrompt throws for missing/invalid required fields", () => {
  assert.throws(() => formatPlanningWorkerDispatchPrompt({ controlIssue: null, executionIssue: 407 }));
  assert.throws(() => formatPlanningWorkerDispatchPrompt({ controlIssue: 408, executionIssue: NaN }));
  assert.throws(() => formatPlanningWorkerDispatchPrompt({ controlIssue: 408, executionIssue: -7 }));
});

test("formatPlanningWorkerDispatchPrompt never contains restated AGENTS.md contract prose", () => {
  const prompt = formatPlanningWorkerDispatchPrompt({ controlIssue: 408, executionIssue: 407 });
  for (const forbidden of ["STATUS", "OUTCOME", "CHANGED", "VERIFIED", "DECISIONS", "NEW RISKS", "Founder interrupt conditions"]) {
    assert.ok(!prompt.includes(forbidden), `prompt unexpectedly contains restated field "${forbidden}"`);
  }
});

// -- issue #498 unit 498-B: "Planning-correction worker dispatch" -----------------------------

test("formatPlanningCorrectionWorkerDispatchPrompt includes control/execution issue references and plan index URL, and points the worker at re-running the gate rather than restating failing unit ids", () => {
  const prompt = formatPlanningCorrectionWorkerDispatchPrompt({
    controlIssue: 500,
    executionIssue: 498,
    planIndexUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-5624721353",
    replanRequiredUnitIds: ["498-A", "498-B"],
  });
  assert.match(prompt, /^Planning-correction worker dispatch\./);
  assert.match(prompt, /#498/);
  assert.match(prompt, /#500/);
  assert.match(prompt, /https:\/\/github\.com\/LouPineWays\/Loop-Dee-Loup\/issues\/498#issuecomment-5624721353/);
  assert.match(prompt, /ready-dispatch-gate\.mjs --control-issue 500/);
  // Stage 1 finding P1: the failing unit set must never be interpolated as prose — the
  // worker recovers it deterministically by re-running the gate instead.
  assert.ok(!prompt.includes("498-A, 498-B"));
});

test("formatPlanningCorrectionWorkerDispatchPrompt stays well under the reference-only threshold regardless of how many units are failing or how long the plan index permalink is", () => {
  const manyUnits = Array.from({ length: 40 }, (_, i) => `498-${String.fromCharCode(65 + (i % 26))}${i}`);
  // A permalink at GitHub's own structural limits — 39-char max username, 100-char max repo
  // name — rather than an arbitrary made-up long string: this proves the bound holds for the
  // longest URL GitHub itself can ever produce, not just for a plausible-looking one.
  const longOwner = "a".repeat(39);
  const longRepo = "b".repeat(100);
  const longPlanIndexUrl = `https://github.com/${longOwner}/${longRepo}/issues/498#issuecomment-5624721626`;
  const prompt = formatPlanningCorrectionWorkerDispatchPrompt({
    controlIssue: 500,
    executionIssue: 498,
    planIndexUrl: longPlanIndexUrl,
    replanRequiredUnitIds: manyUnits,
  });
  assert.ok(prompt.length < 700, `expected < 700 chars, got ${prompt.length}`);
});

test("formatPlanningCorrectionWorkerDispatchPrompt never restates the verdict's own reason text or AGENTS.md contract prose", () => {
  const prompt = formatPlanningCorrectionWorkerDispatchPrompt({
    controlIssue: 500,
    executionIssue: 498,
    planIndexUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-5624721353",
    replanRequiredUnitIds: ["498-A"],
  });
  for (const forbidden of ["STATUS", "OUTCOME", "CHANGED", "VERIFIED", "DECISIONS", "NEW RISKS", "Founder interrupt conditions"]) {
    assert.ok(!prompt.includes(forbidden), `prompt unexpectedly contains restated field "${forbidden}"`);
  }
});

test("formatPlanningCorrectionWorkerDispatchPrompt throws for missing/invalid required fields", () => {
  assert.throws(() =>
    formatPlanningCorrectionWorkerDispatchPrompt({ controlIssue: null, executionIssue: 498, planIndexUrl: "https://x", replanRequiredUnitIds: ["498-A"] }),
  );
  assert.throws(() =>
    formatPlanningCorrectionWorkerDispatchPrompt({ controlIssue: 500, executionIssue: 498, planIndexUrl: "", replanRequiredUnitIds: ["498-A"] }),
  );
  assert.throws(() =>
    formatPlanningCorrectionWorkerDispatchPrompt({ controlIssue: 500, executionIssue: 498, planIndexUrl: "https://x", replanRequiredUnitIds: [] }),
  );
  assert.throws(() =>
    formatPlanningCorrectionWorkerDispatchPrompt({ controlIssue: 500, executionIssue: 498, planIndexUrl: "https://x", replanRequiredUnitIds: null }),
  );
});

test("formatIntegrationWorkerDispatchPrompt includes the exact control Issue and execution Issue references and no route", () => {
  const prompt = formatIntegrationWorkerDispatchPrompt({ controlIssue: 408, executionIssue: 407 });
  assert.match(prompt, /^Integration\/PR worker dispatch\./);
  assert.match(prompt, /#407/);
  assert.match(prompt, /#408/);
  assert.ok(!prompt.includes("Route:"));
});

test("formatIntegrationWorkerDispatchPrompt stays well under the reference-only threshold", () => {
  const prompt = formatIntegrationWorkerDispatchPrompt({ controlIssue: 408, executionIssue: 407 });
  assert.ok(prompt.length < 700, `expected < 700 chars, got ${prompt.length}`);
});

test("formatIntegrationWorkerDispatchPrompt includes the PR-open stop clause", () => {
  const prompt = formatIntegrationWorkerDispatchPrompt({ controlIssue: 408, executionIssue: 407 });
  assert.match(prompt, /stop/i);
  assert.match(prompt, /Watched lifecycle breakpoints/);
});

test("formatIntegrationWorkerDispatchPrompt throws for missing/invalid required fields", () => {
  assert.throws(() => formatIntegrationWorkerDispatchPrompt({ controlIssue: 408, executionIssue: null }));
  assert.throws(() => formatIntegrationWorkerDispatchPrompt({ controlIssue: 12.5, executionIssue: 407 }));
});

// -- CLI: state-based template selection (piped mode) ----------------------------------------

function runCli(input) {
  return (async () => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const scriptPath = fileURLToPath(new URL("./format-dispatch-prompt.mjs", import.meta.url));
    return spawnSync(process.execPath, [scriptPath], { input: JSON.stringify(input), encoding: "utf8" });
  })();
}

test("CLI: piped READY_TO_DISPATCH_PLANNING selects the planning template", async () => {
  const result = await runCli({ state: "READY_TO_DISPATCH_PLANNING", controlIssue: 408, executionIssue: 407, route: "planning worker" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Planning worker dispatch\./);
  assert.match(result.stdout, /#407/);
  assert.match(result.stdout, /#408/);
});

test("CLI: piped READY_TO_DISPATCH_INTEGRATION selects the integration template", async () => {
  const result = await runCli({ state: "READY_TO_DISPATCH_INTEGRATION", controlIssue: 408, executionIssue: 407, route: "integration worker" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Integration\/PR worker dispatch\./);
  assert.match(result.stdout, /#407/);
  assert.match(result.stdout, /#408/);
});

test("CLI: piped READY_TO_DISPATCH still selects the original implementation template", async () => {
  const result = await runCli({ state: "READY_TO_DISPATCH", controlIssue: 322, executionIssue: 321, route: "implementation worker" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Implementation worker dispatch\./);
});

test("CLI: an unrecognized state is still refused, error message names every recognized state", async () => {
  const result = await runCli({ state: "SOMETHING_ELSE", controlIssue: 408, executionIssue: 407 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not "READY_TO_DISPATCH"/);
  assert.match(result.stderr, /READY_TO_DISPATCH_PLANNING/);
  assert.match(result.stderr, /READY_TO_DISPATCH_INTEGRATION/);
  assert.match(result.stderr, /REPLAN_REQUIRED/);
});

test("CLI: piped REPLAN_REQUIRED selects the planning-correction template", async () => {
  const result = await runCli({
    state: "REPLAN_REQUIRED",
    controlIssue: 500,
    executionIssue: 498,
    planIndexUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-5624721353",
    replanRequiredUnitIds: ["498-A"],
    reason: "498-A: capability class ... does not resolve",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Planning-correction worker dispatch\./);
  assert.match(result.stdout, /#498/);
  assert.match(result.stdout, /#500/);
  assert.match(result.stdout, /ready-dispatch-gate\.mjs --control-issue 500/);
  // The verdict's own `reason` text must never be retransmitted into the dispatch prompt --
  // it is for the controller's compact chat/handoff record, not the worker prompt.
  assert.ok(!result.stdout.includes("does not resolve"));
});

// -- CLI: explicit --kind selection (explicit-fields mode) ------------------------------------

test("CLI: explicit --kind planning selects the planning template without --route", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const scriptPath = fileURLToPath(new URL("./format-dispatch-prompt.mjs", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--control-issue", "408", "--execution-issue", "407", "--kind", "planning"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Planning worker dispatch\./);
});

test("CLI: explicit --kind integration selects the integration template without --route", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const scriptPath = fileURLToPath(new URL("./format-dispatch-prompt.mjs", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--control-issue", "408", "--execution-issue", "407", "--kind", "integration"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Integration\/PR worker dispatch\./);
});

test("CLI: explicit --kind planning-correction selects the planning-correction template with --plan-index-url and --replan-unit-ids", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const scriptPath = fileURLToPath(new URL("./format-dispatch-prompt.mjs", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--control-issue",
      "500",
      "--execution-issue",
      "498",
      "--kind",
      "planning-correction",
      "--plan-index-url",
      "https://github.com/LouPineWays/Loop-Dee-Loup/issues/498#issuecomment-5624721353",
      "--replan-unit-ids",
      "498-A,498-B",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Planning-correction worker dispatch\./);
  assert.match(result.stdout, /ready-dispatch-gate\.mjs --control-issue 500/);
});

test("CLI: an unknown --kind fails closed with exit 2", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const scriptPath = fileURLToPath(new URL("./format-dispatch-prompt.mjs", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--control-issue", "408", "--execution-issue", "407", "--kind", "bogus"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown --kind/);
});
