// Tests for tools/orchestration/verify-correction-completion.mjs (issue #764, control #577):
// the #726/#725/PR #763 recurrence -- reviewed fb32d7fa..., corrected 3550948a..., control still
// `Stage 1: requested` -- must be UNVERIFIED; the canonical disposition must verify.
//
// Run with: node --test tools/orchestration/verify-correction-completion.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { verifyCorrectionCompletion } from "./verify-correction-completion.mjs";

const REVIEWED = "fb32d7faad47284e45689ce3a0710e8433b6555c";
const CORRECTED = "3550948ab6879c7b3c404dbc5ff6cca50308532e";

const body = (stage1) => `## Current state

- **Lifecycle:** REVIEW
- **Execution:** #725
- **Route:** implementation worker
- **PR:** #763
- **Stage 1:** ${stage1}
- **Blocker:** none
- **Founder decision:** none
`;

const prView = (head = CORRECTED) => ({ headRefName: "issue-725-fix", headRefOid: head, body: "Addresses #725.", state: "OPEN" });
const args = { repo: "o/r", controlIssue: 726, executionIssue: 725, pr: 763, reviewedHead: REVIEWED };
const satisfied = async () => ({ exitCode: 0, state: "CORRECTION_SATISFIED", reviewedHead: REVIEWED, correctedHead: CORRECTED });
const deps = (over = {}) => ({
  ghIssueViewImpl: async () => body(`correction-satisfied at ${CORRECTED} (reviewed ${REVIEWED})`),
  ghPrViewImpl: async () => prView(),
  checkCorrectionDeltaImpl: satisfied,
  ...over,
});

test("positive control: canonical disposition at the live head verifies", async () => {
  const r = await verifyCorrectionCompletion(args, deps());
  assert.equal(r.exitCode, 0);
  assert.equal(r.state, "CORRECTION_COMPLETE_VERIFIED");
});

test("#726/#763 escape: control still `Stage 1: requested` after the corrected push is UNVERIFIED", async () => {
  const r = await verifyCorrectionCompletion(args, deps({ ghIssueViewImpl: async () => body("requested") }));
  assert.equal(r.exitCode, 2);
  assert.equal(r.message, "CORRECTION_BREAKPOINT_UNVERIFIED 763");
});

test("no correction pushed (head still the reviewed head) is UNVERIFIED", async () => {
  const r = await verifyCorrectionCompletion(args, deps({ ghPrViewImpl: async () => prView(REVIEWED) }));
  assert.equal(r.exitCode, 2);
});

test("disposition recorded for a stale corrected head (PR moved on) is UNVERIFIED", async () => {
  const r = await verifyCorrectionCompletion(
    args,
    deps({ ghPrViewImpl: async () => prView("a".repeat(40)) }),
  );
  assert.equal(r.exitCode, 2);
});

test("disposition for a different reviewed head is UNVERIFIED", async () => {
  const r = await verifyCorrectionCompletion(
    args,
    deps({ ghIssueViewImpl: async () => body(`correction-satisfied at ${CORRECTED} (reviewed ${"b".repeat(40)})`) }),
  );
  assert.equal(r.exitCode, 2);
});

test("checkCorrectionDelta not satisfied / throwing / operational error is UNVERIFIED", async () => {
  for (const impl of [
    async () => ({ exitCode: 2, state: "NOT_SATISFIED", reason: "x" }),
    async () => ({ exitCode: 1, message: "boom" }),
    async () => {
      throw new Error("net");
    },
  ]) {
    const r = await verifyCorrectionCompletion(args, deps({ checkCorrectionDeltaImpl: impl }));
    assert.equal(r.exitCode, 2);
  }
});

test("failed durable read is UNVERIFIED; execution or PR mismatch is UNVERIFIED", async () => {
  const boom = async () => {
    throw new Error("gh down");
  };
  assert.equal((await verifyCorrectionCompletion(args, deps({ ghIssueViewImpl: boom }))).exitCode, 2);
  assert.equal((await verifyCorrectionCompletion({ ...args, executionIssue: 999 }, deps())).exitCode, 2);
  const otherPr = body(`correction-satisfied at ${CORRECTED} (reviewed ${REVIEWED})`).replace("#763", "#764");
  assert.equal((await verifyCorrectionCompletion(args, deps({ ghIssueViewImpl: async () => otherPr }))).exitCode, 2);
});

test("head moving during verification is UNVERIFIED", async () => {
  let n = 0;
  const r = await verifyCorrectionCompletion(
    args,
    deps({ ghPrViewImpl: async () => prView(++n >= 2 ? "c".repeat(40) : CORRECTED) }),
  );
  assert.equal(r.exitCode, 2);
});

test("missing identity is an operational error (exit 1), not a verdict", async () => {
  assert.equal((await verifyCorrectionCompletion({ ...args, controlIssue: null }, deps())).exitCode, 1);
  assert.equal((await verifyCorrectionCompletion({ ...args, reviewedHead: "" }, deps())).exitCode, 1);
});
