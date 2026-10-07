// Tests for tools/orchestration/successor-integration-preflight.mjs -- issue #950.
//
// Run with:
//   node --test tools/orchestration/successor-integration-preflight.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { run, referencesSupersede } from "./successor-integration-preflight.mjs";

const SHA = "a".repeat(40);
const PRED = { number: 869, state: "OPEN", headRefName: "issue-868-replace", baseRefName: "main", body: "Addresses #868" };

function harness({ pred = PRED, linked = [], bases = {}, sha = SHA } = {}) {
  return {
    readPr: (n, fields) => {
      if (n === pred.number) return pred;
      return { baseRefName: bases[n] ?? "main" };
    },
    listLinked: () => linked,
    readTarget: () => sha,
  };
}
const base = { repo: "o/r", executionIssue: 868, predecessorPr: 869 };
const succ = (number, extra = {}) => ({ number, state: "OPEN", headRefName: `issue-868-successor-of-869`, body: "Addresses #868\nSupersedes #869", ...extra });

test("predecessor-only -> NO_SUCCESSOR with target and first-attempt linked branch name", () => {
  const r = run(base, harness({ linked: [PRED] }));
  assert.equal(r.state, "NO_SUCCESSOR");
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.target, { ref: "main", sha: SHA });
  assert.equal(r.branch, "issue-868-successor-of-869-attempt-1");
});

test("exactly one valid linked successor -> reuse (no duplicate)", () => {
  const r = run(base, harness({ linked: [PRED, succ(900)] }));
  assert.equal(r.state, "SUCCESSOR_EXISTS");
  assert.equal(r.successor, 900);
});

test("multiple valid successors -> fail closed", () => {
  const r = run(base, harness({ linked: [PRED, succ(900), succ(901)] }));
  assert.equal(r.state, "FAIL_CLOSED");
  assert.equal(r.exitCode, 2);
});

test("open linked PR without Supersedes marker -> ambiguous, fail closed", () => {
  const r = run(base, harness({ linked: [PRED, succ(900, { body: "Addresses #868" })] }));
  assert.equal(r.state, "FAIL_CLOSED");
  assert.match(r.reason, /ambiguous/);
});

test("successor marking a different predecessor -> not reused", () => {
  const r = run(base, harness({ linked: [PRED, succ(900, { body: "Addresses #868\nSupersedes #123" })] }));
  assert.equal(r.state, "FAIL_CLOSED");
});

test("successor targeting a different base -> fail closed", () => {
  const r = run(base, harness({ linked: [PRED, succ(900)], bases: { 900: "release" } }));
  assert.equal(r.state, "FAIL_CLOSED");
});

test("closed historical successor advances the branch attempt; merged successor fails closed", () => {
  const afterClosed = run(base, harness({ linked: [PRED, succ(900, { state: "CLOSED" })] }));
  assert.equal(afterClosed.state, "NO_SUCCESSOR");
  assert.equal(afterClosed.branch, "issue-868-successor-of-869-attempt-2");
  assert.equal(run(base, harness({ linked: [PRED, succ(900, { state: "MERGED" })] })).state, "FAIL_CLOSED");
});

test("predecessor wrong execution link, merged, or closed-without-successor -> fail closed", () => {
  assert.equal(run(base, harness({ pred: { ...PRED, headRefName: "other", body: "" } })).state, "FAIL_CLOSED");
  assert.equal(run(base, harness({ pred: { ...PRED, state: "MERGED" } })).state, "FAIL_CLOSED");
  assert.equal(run(base, harness({ pred: { ...PRED, state: "CLOSED" } })).state, "FAIL_CLOSED");
});

test("closed predecessor with its open successor still resolves the successor (re-entry after supersede)", () => {
  assert.equal(run(base, harness({ pred: { ...PRED, state: "CLOSED" }, linked: [PRED, succ(900)] })).state, "SUCCESSOR_EXISTS");
});

test("target moved during preparation -> fail closed", () => {
  const r = run({ ...base, expectTarget: "b".repeat(40) }, harness({ linked: [PRED] }));
  assert.equal(r.state, "FAIL_CLOSED");
  assert.match(r.reason, /TARGET_MOVED/);
  assert.equal(run({ ...base, expectTarget: SHA }, harness({ linked: [PRED] })).state, "NO_SUCCESSOR");
});

test("invalid identifiers fail closed; marker parser is exact", () => {
  assert.equal(run({ ...base, predecessorPr: 0 }, harness()).state, "FAIL_CLOSED");
  assert.equal(referencesSupersede("Supersedes #8690", 869), false);
  assert.equal(referencesSupersede("supersedes: #869", 869), true);
});
