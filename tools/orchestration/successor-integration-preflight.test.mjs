// Tests for tools/orchestration/successor-integration-preflight.mjs -- issue #950.
//
// Run with:
//   node --test tools/orchestration/successor-integration-preflight.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { run, referencesSupersede } from "./successor-integration-preflight.mjs";

const SHA = "a".repeat(40);
const PRED_HEAD = "c".repeat(40);
const PRED = {
  number: 869,
  state: "OPEN",
  headRefName: "issue-868-replace",
  headRefOid: PRED_HEAD,
  baseRefName: "main",
  body: "Addresses #868",
};

function harness({ pred = PRED, linked = [], bases = {}, sha = SHA, ...overrides } = {}) {
  return {
    readPr: (n, fields) => {
      if (n === pred.number) return pred;
      return { baseRefName: bases[n] ?? "main" };
    },
    listLinked: () => linked,
    readTarget: () => sha,
    inspectLocal: () => null,
    ...overrides,
  };
}
const base = { repo: "o/r", executionIssue: 868, predecessorPr: 869, expectedPredecessorHead: PRED_HEAD };
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

test("predecessor head mismatch fails closed before successor creation or reuse", () => {
  const moved = { ...PRED, headRefOid: "d".repeat(40) };
  for (const linked of [[moved], [moved, succ(900)]]) {
    const r = run(base, harness({ pred: moved, linked }));
    assert.equal(r.state, "FAIL_CLOSED");
    assert.equal(r.exitCode, 2);
    assert.match(r.reason, /PREDECESSOR_HEAD_MISMATCH/);
  }
});

test("missing or malformed expected predecessor head fails closed", () => {
  for (const expectedPredecessorHead of [null, "", "abc", "g".repeat(40)]) {
    const r = run({ ...base, expectedPredecessorHead }, harness({ linked: [PRED] }));
    assert.equal(r.state, "FAIL_CLOSED");
    assert.equal(r.exitCode, 2);
    assert.match(r.reason, /expect-predecessor-head/);
  }
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

// Issue #968: local-only successor state.
test("remote NO_SUCCESSOR with a local-only successor never offers creation", () => {
  const local = { state: "LOCAL_SUCCESSOR_RESUMABLE", exitCode: 0, branch: "issue-868-successor-of-869-attempt-1", path: "/w" };
  const r = run(base, harness({ linked: [PRED], inspectLocal: () => local }));
  assert.equal(r.state, "LOCAL_SUCCESSOR_RESUMABLE");
  assert.deepEqual(r.target, { ref: "main", sha: SHA });
});

test("live-owned local successor suppresses creation; ambiguous fails closed with exit 2", () => {
  assert.equal(run(base, harness({ linked: [PRED], inspectLocal: () => ({ state: "LOCAL_SUCCESSOR_LIVE_OWNED", exitCode: 0 }) })).state, "LOCAL_SUCCESSOR_LIVE_OWNED");
  const amb = run(base, harness({ linked: [PRED], inspectLocal: () => ({ state: "FAIL_CLOSED", exitCode: 2, reason: "AMBIGUOUS_LOCAL_SUCCESSOR: x" }) }));
  assert.equal(amb.exitCode, 2);
});

test("caller-owned local successor passes the pre-push re-check with the same branch", () => {
  const r = run({ ...base, worktree: "/w" }, harness({ linked: [PRED], inspectLocal: () => ({ state: "CALLER_OWNED", branch: "issue-868-successor-of-869-attempt-1" }) }));
  assert.equal(r.state, "NO_SUCCESSOR");
  assert.equal(r.branch, "issue-868-successor-of-869-attempt-1");
});

test("reclaim flag retires a STALE_RECLAIMABLE attempt then returns NO_SUCCESSOR; without it only reports", () => {
  const stale = { state: "LOCAL_SUCCESSOR_STALE_RECLAIMABLE", exitCode: 0 };
  let calls = 0;
  const deps = { linked: [PRED], inspectLocal: () => stale, reclaimLocal: (l, o) => (o.revalidate().state === stale.state && calls++, ["branch-removed"]) };
  assert.equal(run(base, harness(deps)).state, "LOCAL_SUCCESSOR_STALE_RECLAIMABLE");
  assert.equal(calls, 0);
  const r = run({ ...base, reclaim: true }, harness(deps));
  assert.equal(r.state, "NO_SUCCESSOR");
  assert.deepEqual(r.reclaimed, ["branch-removed"]);
});

test("the expected attempt (after closed successors) is passed to local inspection", () => {
  let seen;
  run(base, harness({ linked: [PRED, { number: 700, state: "CLOSED", body: "Supersedes #869" }], inspectLocal: (a) => ((seen = a.attempt), null) }));
  assert.equal(seen, 2);
});

test("remote successor PR takes precedence; local state is not consulted (#950 unchanged)", () => {
  const r = run(base, harness({ linked: [PRED, succ(900)], inspectLocal: () => { throw new Error("must not be called"); } }));
  assert.equal(r.state, "SUCCESSOR_EXISTS");
});
