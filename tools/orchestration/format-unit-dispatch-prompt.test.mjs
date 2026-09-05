// Tests for tools/orchestration/format-unit-dispatch-prompt.mjs -- worker unit 294-C's
// minimal reference-only dispatch-prompt formatter for one Worker Unit Contract comment.
//
// Run with:
//   node --test tools/orchestration/format-unit-dispatch-prompt.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { formatUnitDispatchPrompt } from "./format-unit-dispatch-prompt.mjs";
import { assertReferenceOnly } from "./format-dispatch-prompt.mjs";

const UNIT_URL = "https://github.com/LouPineWays/Loop-Dee-Loup/issues/294#issuecomment-5550653170";
const SHARED_URL = "https://github.com/LouPineWays/Loop-Dee-Loup/issues/294#issuecomment-5550652308";

test("formatUnitDispatchPrompt includes the exact unit comment URL, execution Issue, and shared contract URL", () => {
  const prompt = formatUnitDispatchPrompt({
    unitCommentUrl: UNIT_URL,
    parentExecutionIssue: 294,
    sharedContractUrl: SHARED_URL,
  });
  assert.match(prompt, /#294/);
  assert.ok(prompt.includes(UNIT_URL));
  assert.ok(prompt.includes(SHARED_URL));
});

test("formatUnitDispatchPrompt stays well under the reference-only threshold", () => {
  const prompt = formatUnitDispatchPrompt({
    unitCommentUrl: UNIT_URL,
    parentExecutionIssue: 294,
    sharedContractUrl: SHARED_URL,
  });
  assert.equal(assertReferenceOnly(prompt), prompt);
  assert.ok(prompt.length < 700, `expected < 700 chars, got ${prompt.length}`);
});

test("formatUnitDispatchPrompt never restates the unit's own fields", () => {
  const prompt = formatUnitDispatchPrompt({
    unitCommentUrl: UNIT_URL,
    parentExecutionIssue: 294,
    sharedContractUrl: SHARED_URL,
  });
  for (const forbidden of [
    "Required bounded outcome",
    "Applicable role/capability",
    "Observable completion condition",
    "Verification required",
    "STATUS",
    "OUTCOME",
    "CHANGED",
  ]) {
    assert.ok(!prompt.includes(forbidden), `prompt unexpectedly contains restated field "${forbidden}"`);
  }
});

test("formatUnitDispatchPrompt is deterministic for the same input", () => {
  const fields = { unitCommentUrl: UNIT_URL, parentExecutionIssue: 294, sharedContractUrl: SHARED_URL };
  assert.equal(formatUnitDispatchPrompt(fields), formatUnitDispatchPrompt(fields));
});

test("formatUnitDispatchPrompt throws when a field is missing or malformed", () => {
  assert.throws(() => formatUnitDispatchPrompt({ unitCommentUrl: "", parentExecutionIssue: 294, sharedContractUrl: SHARED_URL }));
  assert.throws(() => formatUnitDispatchPrompt({ unitCommentUrl: UNIT_URL, parentExecutionIssue: null, sharedContractUrl: SHARED_URL }));
  assert.throws(() => formatUnitDispatchPrompt({ unitCommentUrl: UNIT_URL, parentExecutionIssue: 294, sharedContractUrl: "" }));
});

test("formatUnitDispatchPrompt rejects non-integer, negative, zero, or NaN issue numbers", () => {
  const base = { unitCommentUrl: UNIT_URL, sharedContractUrl: SHARED_URL };
  assert.throws(() => formatUnitDispatchPrompt({ ...base, parentExecutionIssue: NaN }));
  assert.throws(() => formatUnitDispatchPrompt({ ...base, parentExecutionIssue: -7 }));
  assert.throws(() => formatUnitDispatchPrompt({ ...base, parentExecutionIssue: 0 }));
  assert.throws(() => formatUnitDispatchPrompt({ ...base, parentExecutionIssue: 12.5 }));
});

test("formatUnitDispatchPrompt rejects a URL that isn't a GitHub issue-comment permalink", () => {
  assert.throws(() =>
    formatUnitDispatchPrompt({
      unitCommentUrl: "https://github.com/LouPineWays/Loop-Dee-Loup/issues/294",
      parentExecutionIssue: 294,
      sharedContractUrl: SHARED_URL,
    }),
  );
  assert.throws(() =>
    formatUnitDispatchPrompt({
      unitCommentUrl: UNIT_URL,
      parentExecutionIssue: 294,
      sharedContractUrl: "not-a-url",
    }),
  );
});

// --- CLI ---------------------------------------------------------------------------

test("CLI: explicit fields render a reference-only prompt on stdout", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const scriptPath = fileURLToPath(new URL("./format-unit-dispatch-prompt.mjs", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--unit-comment-url",
      UNIT_URL,
      "--parent-execution-issue",
      "294",
      "--shared-contract-url",
      SHARED_URL,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(UNIT_URL));
  assert.ok(result.stdout.includes(SHARED_URL));
});

test("CLI: no arguments at all fails closed with guidance", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const scriptPath = fileURLToPath(new URL("./format-unit-dispatch-prompt.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--unit-comment-url/);
});

test("CLI: a malformed explicit --parent-execution-issue value fails closed", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const scriptPath = fileURLToPath(new URL("./format-unit-dispatch-prompt.mjs", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--unit-comment-url",
      UNIT_URL,
      "--parent-execution-issue",
      "not-a-number",
      "--shared-contract-url",
      SHARED_URL,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});
