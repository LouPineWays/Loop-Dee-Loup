// Tests for tools/review-watch/control-plane-paths.mjs. Run with:
// node --test tools/review-watch/control-plane-paths.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { isControlPlanePath, matchingControlPlanePatterns } from "./control-plane-paths.mjs";

// -- the exact #615 recurrence shape -------------------------------------------------------

test("isControlPlanePath: docs/diagnostic-traces/*.md (PR #615's exact recurrence) is control-plane", () => {
  assert.equal(isControlPlanePath("docs/diagnostic-traces/441-a.md"), true);
});

test("matchingControlPlanePatterns: names docs/*.md for a nested diagnostic trace", () => {
  assert.deepEqual(matchingControlPlanePatterns("docs/diagnostic-traces/441-a.md"), ["docs/*.md"]);
});

// -- root-level *.md (open-ended, not a closed AGENTS/CLAUDE/README list) -----------------

test("isControlPlanePath: root-level AGENTS.md is control-plane", () => {
  assert.equal(isControlPlanePath("AGENTS.md"), true);
});

test("isControlPlanePath: a root-level *.md file not in the literal AGENTS/CLAUDE/README list is not matched (known limitation, not a true root wildcard)", () => {
  assert.equal(isControlPlanePath("CONTRIBUTING.md"), false);
});

test("isControlPlanePath: root-level *.md does not reach into a subdirectory", () => {
  assert.equal(isControlPlanePath("docs/CONTRIBUTING.md"), true, "still control-plane, but via docs/*.md, not root *.md");
  assert.deepEqual(matchingControlPlanePatterns("docs/CONTRIBUTING.md"), ["docs/*.md"]);
});

test("isControlPlanePath: a non-.md root file is not control-plane via the *.md pattern", () => {
  assert.equal(isControlPlanePath("package.json"), false);
});

// -- directory wildcard patterns -----------------------------------------------------------

test("isControlPlanePath: .github/workflows/*.yml matches a nested workflow file", () => {
  assert.equal(isControlPlanePath(".github/workflows/control-plane-paths.yml"), true);
});

test("isControlPlanePath: .github/ISSUE_TEMPLATE/* matches a template file", () => {
  assert.equal(isControlPlanePath(".github/ISSUE_TEMPLATE/founder-decision-form.md"), true);
});

// -- "/**" recursive directory patterns -----------------------------------------------------

test("isControlPlanePath: anything under .claude/** is control-plane, at any depth", () => {
  assert.equal(isControlPlanePath(".claude/skills/sift/SKILL.md"), true);
  assert.equal(isControlPlanePath(".claude/settings.json"), true);
});

test("isControlPlanePath: tools/review-watch/** matches its own source", () => {
  assert.equal(isControlPlanePath("tools/review-watch/stage1-gate.mjs"), true);
});

test("isControlPlanePath: tools/orchestration/** matches a nested file", () => {
  assert.equal(isControlPlanePath("tools/orchestration/ready-dispatch-gate.mjs"), true);
});

// -- literal file patterns -------------------------------------------------------------------

test("isControlPlanePath: tools/check-priority-labels.mjs matches exactly", () => {
  assert.equal(isControlPlanePath("tools/check-priority-labels.mjs"), true);
});

test("isControlPlanePath: a different file with the same basename elsewhere is not the literal match", () => {
  assert.equal(isControlPlanePath("tools/other/check-priority-labels.mjs"), false);
});

// -- representative non-control-plane paths (legitimate-exemption-eligible) ------------------

test("isControlPlanePath: an ordinary application source file is not control-plane", () => {
  assert.equal(isControlPlanePath("src/foo.js"), false);
});

test("isControlPlanePath: a test fixture outside every listed category is not control-plane", () => {
  assert.equal(isControlPlanePath("fixtures/sample-data.json"), false);
});

// -- input hygiene ----------------------------------------------------------------------------

test("matchingControlPlanePatterns: returns an empty array for a non-string/empty path", () => {
  assert.deepEqual(matchingControlPlanePatterns(""), []);
  assert.deepEqual(matchingControlPlanePatterns(undefined), []);
  assert.deepEqual(matchingControlPlanePatterns(null), []);
});
