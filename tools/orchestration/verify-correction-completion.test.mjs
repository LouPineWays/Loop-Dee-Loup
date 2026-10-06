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
  readCorrectionCommitsImpl: async () => [{ sha: "c1", parents: 1, message: "Fix finding (#725)" }],
  readTargetCommitsImpl: async () => [],
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

// Stage 1 correction (PR #765): a control mutation between the initial verification and the
// final freshness check must fail closed (both mutable authorities re-read).
const GOOD = body(`correction-satisfied at ${CORRECTED} (reviewed ${REVIEWED})`);

test("concurrent control mutation between initial verification and final re-read is UNVERIFIED", async () => {
  let n = 0;
  const r = await verifyCorrectionCompletion(args, deps({ ghIssueViewImpl: async () => (++n >= 2 ? body("requested") : GOOD) }));
  assert.equal(r.exitCode, 2);
  assert.match(r.reason, /final freshness check/);
});

test("control relinked to another Execution between reads is UNVERIFIED", async () => {
  let n = 0;
  const relinked = GOOD.replace("#725", "#999");
  const r = await verifyCorrectionCompletion(args, deps({ ghIssueViewImpl: async () => (++n >= 2 ? relinked : GOOD) }));
  assert.equal(r.exitCode, 2);
});

test("final control re-read failure is UNVERIFIED", async () => {
  let n = 0;
  const r = await verifyCorrectionCompletion(
    args,
    deps({
      ghIssueViewImpl: async () => {
        if (++n >= 2) throw new Error("gh down");
        return GOOD;
      },
    }),
  );
  assert.equal(r.exitCode, 2);
});

test("missing identity is an operational error (exit 1), not a verdict", async () => {
  assert.equal((await verifyCorrectionCompletion({ ...args, controlIssue: null }, deps())).exitCode, 1);
  assert.equal((await verifyCorrectionCompletion({ ...args, reviewedHead: "" }, deps())).exitCode, 1);
});

test("#924/#923 escape: correction range omitting the execution Issue provenance is UNVERIFIED even with the canonical disposition", async () => {
  const r = await verifyCorrectionCompletion(
    args,
    deps({ readCorrectionCommitsImpl: async () => [{ sha: "5c29bcf", parents: 1, message: "Prove whole-file target preservation (PR #763 Stage 1 finding)" }] }),
  );
  assert.equal(r.exitCode, 2);
  assert.match(r.reason, /correction provenance not established.*does not reference execution Issue #725/);
});

test("#924: unreadable commit range fails closed UNVERIFIED", async () => {
  const r = await verifyCorrectionCompletion(
    args,
    deps({
      readCorrectionCommitsImpl: async () => {
        throw new Error("compare down");
      },
    }),
  );
  assert.equal(r.exitCode, 2);
  assert.match(r.reason, /could not verify correction provenance/);
});
