// Tests for tools/review-watch/stage1-correction-gate.mjs. All stage1-gate/compare access is
// faked via the injected `stage1RunImpl`/`compareImpl` options — never touch the real network
// or `gh` CLI here. Run with: node --test tools/review-watch/stage1-correction-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkCorrectionDelta,
  parseArgs,
  parseCorrectionSatisfiedDisposition,
  run,
} from "./stage1-correction-gate.mjs";

const REVIEWED = "30b36035c9d6e1a9b0f2c3d4e5f60718293a4b5c";
const CORRECTED = "0009c54b180aedadfa48e3db6266b8473a1d8d35";

const FINDINGS_BODY = "### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.";
const CLEAN_BODY = "No issues found. Looks good.";

function findingsReceived({ head = REVIEWED, matches, unboundGenuineMatches = [] } = {}) {
  return {
    exitCode: 0,
    state: "RESPONSE_RECEIVED",
    matches: matches ?? [{ body_excerpt: FINDINGS_BODY }],
    unboundGenuineMatches,
  };
}

function cleanReceived() {
  return { exitCode: 0, state: "RESPONSE_RECEIVED", matches: [{ body_excerpt: CLEAN_BODY }], unboundGenuineMatches: [] };
}

function notRequested() {
  return { exitCode: 2, state: "NOT_REQUESTED" };
}

function pending() {
  return { exitCode: 2, state: "PENDING", nonGenuineMatches: [], unboundGenuineMatches: [] };
}

function throwingSpy(label) {
  return async () => {
    throw new Error(`${label} must not be called — short-circuit ordering violated`);
  };
}

// ---------------------------------------------------------------------------
// parseCorrectionSatisfiedDisposition
// ---------------------------------------------------------------------------

test("parseCorrectionSatisfiedDisposition: parses the well-formed shape, lower-casing both shas", () => {
  const result = parseCorrectionSatisfiedDisposition(
    `correction-satisfied at ${CORRECTED.toUpperCase()} (reviewed ${REVIEWED.toUpperCase()})`,
  );
  assert.deepEqual(result, { correctedHead: CORRECTED.toLowerCase(), reviewedHead: REVIEWED.toLowerCase() });
});

test("parseCorrectionSatisfiedDisposition: accepts a short (7-char) hex prefix on either sha", () => {
  const result = parseCorrectionSatisfiedDisposition("correction-satisfied at 0009c54 (reviewed 30b3603)");
  assert.deepEqual(result, { correctedHead: "0009c54", reviewedHead: "30b3603" });
});

test("parseCorrectionSatisfiedDisposition: returns null for the pre-existing 'satisfied at <sha>' shape", () => {
  assert.equal(parseCorrectionSatisfiedDisposition(`satisfied at ${CORRECTED}`), null);
});

test("parseCorrectionSatisfiedDisposition: returns null for the pre-existing 'exempt at <sha>' shape", () => {
  assert.equal(parseCorrectionSatisfiedDisposition(`exempt at ${CORRECTED}`), null);
});

test("parseCorrectionSatisfiedDisposition: returns null when the trailing parenthesis is missing", () => {
  assert.equal(
    parseCorrectionSatisfiedDisposition(`correction-satisfied at ${CORRECTED} reviewed ${REVIEWED}`),
    null,
  );
});

test("parseCorrectionSatisfiedDisposition: returns null for a non-hex sha", () => {
  assert.equal(
    parseCorrectionSatisfiedDisposition(`correction-satisfied at not-a-sha (reviewed ${REVIEWED})`),
    null,
  );
});

test("parseCorrectionSatisfiedDisposition: returns null for the wrong keyword", () => {
  assert.equal(
    parseCorrectionSatisfiedDisposition(`correction-pending at ${CORRECTED} (reviewed ${REVIEWED})`),
    null,
  );
});

test("parseCorrectionSatisfiedDisposition: returns null for absent/empty/none input", () => {
  assert.equal(parseCorrectionSatisfiedDisposition(undefined), null);
  assert.equal(parseCorrectionSatisfiedDisposition(null), null);
  assert.equal(parseCorrectionSatisfiedDisposition(""), null);
  assert.equal(parseCorrectionSatisfiedDisposition("none"), null);
});

// ---------------------------------------------------------------------------
// checkCorrectionDelta
// ---------------------------------------------------------------------------

test("checkCorrectionDelta: CORRECTION_SATISFIED — head matches, findings-bearing reviewed response, clean ahead compare", async () => {
  const result = await checkCorrectionDelta(
    { repo: "o/r", pr: 435, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED },
    {
      stage1RunImpl: async ({ head }) => {
        assert.equal(head, REVIEWED);
        return findingsReceived();
      },
      compareImpl: async ({ base, head }) => {
        assert.equal(base, REVIEWED);
        assert.equal(head, CORRECTED);
        return { status: "ahead" };
      },
    },
  );
  assert.deepEqual(result, {
    exitCode: 0,
    state: "CORRECTION_SATISFIED",
    reviewedHead: REVIEWED,
    correctedHead: CORRECTED,
  });
});

test("checkCorrectionDelta: CORRECTION_SATISFIED — gatedHead only needs to start with correctedHead (prefix match)", async () => {
  const shortCorrected = CORRECTED.slice(0, 10);
  const fullGated = CORRECTED;
  const result = await checkCorrectionDelta(
    { repo: "o/r", pr: 435, reviewedHead: REVIEWED, correctedHead: shortCorrected, gatedHead: fullGated },
    {
      stage1RunImpl: async () => findingsReceived(),
      compareImpl: async () => ({ status: "ahead" }),
    },
  );
  assert.equal(result.state, "CORRECTION_SATISFIED");
});

test("checkCorrectionDelta: HEAD_MISMATCH — correctedHead does not match gatedHead, and never calls stage1RunImpl or compareImpl", async () => {
  const result = await checkCorrectionDelta(
    { repo: "o/r", pr: 435, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: "ffffffffffffffffffffffffffffffffffffff" },
    { stage1RunImpl: throwingSpy("stage1RunImpl"), compareImpl: throwingSpy("compareImpl") },
  );
  assert.deepEqual(result, {
    exitCode: 2,
    state: "HEAD_MISMATCH",
    reviewedHead: REVIEWED,
    correctedHead: CORRECTED,
    gatedHead: "ffffffffffffffffffffffffffffffffffffff",
  });
});

test("checkCorrectionDelta: NOT_SATISFIED (findings-provenance) — reviewed head's Stage 1 result is a clean pass only, and never calls compareImpl", async () => {
  const result = await checkCorrectionDelta(
    { repo: "o/r", pr: 435, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED },
    { stage1RunImpl: async () => cleanReceived(), compareImpl: throwingSpy("compareImpl") },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "NOT_SATISFIED");
  assert.match(result.reason, /no findings-bearing/);
});

test("checkCorrectionDelta: NOT_SATISFIED (findings-provenance) — reviewed head has no genuine response at all (NOT_REQUESTED)", async () => {
  const result = await checkCorrectionDelta(
    { repo: "o/r", pr: 435, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED },
    { stage1RunImpl: async () => notRequested(), compareImpl: throwingSpy("compareImpl") },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "NOT_SATISFIED");
  assert.match(result.reason, /NOT_REQUESTED/);
});

test("checkCorrectionDelta: NOT_SATISFIED (findings-provenance) — reviewed head is still PENDING", async () => {
  const result = await checkCorrectionDelta(
    { repo: "o/r", pr: 435, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED },
    { stage1RunImpl: async () => pending(), compareImpl: throwingSpy("compareImpl") },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "NOT_SATISFIED");
  assert.match(result.reason, /PENDING/);
});

test("checkCorrectionDelta: NOT_SATISFIED (findings-provenance) — a genuine response exists only via unboundGenuineMatches", async () => {
  const result = await checkCorrectionDelta(
    { repo: "o/r", pr: 435, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED },
    {
      stage1RunImpl: async () => findingsReceived({ matches: [], unboundGenuineMatches: [{ body_excerpt: FINDINGS_BODY }] }),
      compareImpl: async () => ({ status: "ahead" }),
    },
  );
  assert.equal(result.state, "CORRECTION_SATISFIED", "an unbound genuine findings-bearing match must still count as findings-provenance");
});

for (const status of ["identical", "diverged", "behind"]) {
  test(`checkCorrectionDelta: NOT_SATISFIED (ancestry) — compare reports status "${status}"`, async () => {
    const result = await checkCorrectionDelta(
      { repo: "o/r", pr: 435, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED },
      { stage1RunImpl: async () => findingsReceived(), compareImpl: async () => ({ status }) },
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.state, "NOT_SATISFIED");
    assert.match(result.reason, new RegExp(status));
  });
}

test("checkCorrectionDelta: exitCode 1 when stage1RunImpl throws", async () => {
  const result = await checkCorrectionDelta(
    { repo: "o/r", pr: 435, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED },
    {
      stage1RunImpl: async () => {
        throw new Error("network down");
      },
      compareImpl: throwingSpy("compareImpl"),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /network down/);
});

test("checkCorrectionDelta: exitCode 1 when compareImpl throws", async () => {
  const result = await checkCorrectionDelta(
    { repo: "o/r", pr: 435, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED },
    {
      stage1RunImpl: async () => findingsReceived(),
      compareImpl: async () => {
        throw new Error("gh api failed");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh api failed/);
});

test("checkCorrectionDelta: exitCode 1 when stage1RunImpl reports its own operational error", async () => {
  const result = await checkCorrectionDelta(
    { repo: "o/r", pr: 435, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED },
    {
      stage1RunImpl: async () => ({ exitCode: 1, message: "gh pr view failed" }),
      compareImpl: throwingSpy("compareImpl"),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh pr view failed/);
});

test("checkCorrectionDelta: exitCode 1 when stage1RunImpl returns output without a trustworthy exitCode", async () => {
  const result = await checkCorrectionDelta(
    { repo: "o/r", pr: 435, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED },
    { stage1RunImpl: async () => undefined, compareImpl: throwingSpy("compareImpl") },
  );
  assert.equal(result.exitCode, 1);
});

test("checkCorrectionDelta: exitCode 1 when compareImpl returns output without a trustworthy status field", async () => {
  const result = await checkCorrectionDelta(
    { repo: "o/r", pr: 435, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED },
    { stage1RunImpl: async () => findingsReceived(), compareImpl: async () => ({}) },
  );
  assert.equal(result.exitCode, 1);
});

test("checkCorrectionDelta: exitCode 1 when required args are missing", async () => {
  const result = await checkCorrectionDelta(
    { repo: "o/r", pr: 435, reviewedHead: REVIEWED, correctedHead: "", gatedHead: CORRECTED },
    { stage1RunImpl: throwingSpy("stage1RunImpl"), compareImpl: throwingSpy("compareImpl") },
  );
  assert.equal(result.exitCode, 1);
});

// ---------------------------------------------------------------------------
// parseArgs / run (CLI wrapper)
// ---------------------------------------------------------------------------

test("parseArgs: maps dashed flags to the expected keys", () => {
  const args = parseArgs([
    "--repo",
    "o/r",
    "--pr",
    "435",
    "--reviewed-head",
    REVIEWED,
    "--corrected-head",
    CORRECTED,
    "--gated-head",
    CORRECTED,
  ]);
  assert.deepEqual(args, { repo: "o/r", pr: "435", reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED });
});

test("run: exits 1 when required args are missing", async () => {
  const result = await run({ repo: "o/r" });
  assert.equal(result.exitCode, 1);
});

test("run: defaults gatedHead to correctedHead when --gated-head is omitted", async () => {
  let seenGatedHead;
  const result = await run(
    { repo: "o/r", pr: "435", reviewedHead: REVIEWED, correctedHead: CORRECTED },
    {
      checkCorrectionDeltaImpl: async (args) => {
        seenGatedHead = args.gatedHead;
        return { exitCode: 0, state: "CORRECTION_SATISFIED" };
      },
    },
  );
  assert.equal(seenGatedHead, CORRECTED);
  assert.equal(result.state, "CORRECTION_SATISFIED");
});

test("run: passes an explicit --gated-head through unchanged", async () => {
  let seenGatedHead;
  await run(
    { repo: "o/r", pr: "435", reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: "deadbeef" },
    {
      checkCorrectionDeltaImpl: async (args) => {
        seenGatedHead = args.gatedHead;
        return { exitCode: 2, state: "HEAD_MISMATCH" };
      },
    },
  );
  assert.equal(seenGatedHead, "deadbeef");
});
