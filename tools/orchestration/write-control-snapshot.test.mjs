// Tests for tools/orchestration/write-control-snapshot.mjs — issue #510 (unit 510-A)'s
// write-before-validate helper for the normal LDL-authored thin-control-body edit path.
//
// Run with:
//   node --test tools/orchestration/write-control-snapshot.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";
import { upsertControlBullet, parseControlBullet, isNoneSentinel } from "./ready-dispatch-gate.mjs";

const CORRUPT_BODY = `- **PR:** #509
- **Stage 2:** #508 — NOT CLEAN (correction dispatched as PR #509; a fresh Stage 2 audit is required once #509 merges)
`;

const VALID_BODY = `- **PR:** #509
- **Stage 2:** #508 — NOT CLEAN (correction dispatched; fresh Stage 2 required after the current correction PR merges)
`;

test("checkWriteControlSnapshot: exits 1 when --control-issue is missing", () => {
  const result = checkWriteControlSnapshot({ repo: "owner/repo", proposedBody: VALID_BODY });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /control-issue is required/);
});

test("checkWriteControlSnapshot: exits 1 when no proposed body was supplied", () => {
  const result = checkWriteControlSnapshot({ repo: "owner/repo", controlIssue: 499 });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /proposed body/);
});

test("checkWriteControlSnapshot: REJECTED — refuses the exact #499 corrupted shape before ever calling the write implementation (write-before-validate ordering, Verification case 7)", () => {
  let editCalled = false;
  const result = checkWriteControlSnapshot(
    { repo: "owner/repo", controlIssue: 499, proposedBody: CORRUPT_BODY },
    { ghEditImpl: () => { editCalled = true; } },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "REJECTED");
  assert.equal(editCalled, false, "an invalid proposed body must never reach the write implementation — the prior durable body is left unchanged");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /"Stage 2"/);
});

test("checkWriteControlSnapshot: WRITTEN — a valid proposed body is persisted verbatim via the injected write implementation", () => {
  const editCalls = [];
  const result = checkWriteControlSnapshot(
    { repo: "owner/repo", controlIssue: 499, proposedBody: VALID_BODY },
    { ghEditImpl: (args) => editCalls.push(args) },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "WRITTEN");
  assert.equal(editCalls.length, 1);
  assert.equal(editCalls[0].repo, "owner/repo");
  assert.equal(editCalls[0].controlIssue, 499);
  assert.equal(editCalls[0].body, VALID_BODY);
});

test("checkWriteControlSnapshot: an operational failure from the write implementation itself is reported as exit 1, distinct from a REJECTED validation failure", () => {
  const result = checkWriteControlSnapshot(
    { repo: "owner/repo", controlIssue: 499, proposedBody: VALID_BODY },
    {
      ghEditImpl: () => {
        throw new Error("gh: network error");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh issue edit failed/);
});

test("checkWriteControlSnapshot: cross-field coexistence (PR + Stage 2 pointing at distinct issues) is accepted and written (Verification case 3)", () => {
  const editCalls = [];
  const result = checkWriteControlSnapshot(
    { repo: "owner/repo", controlIssue: 499, proposedBody: "- **PR:** #509\n- **Stage 2:** #508\n" },
    { ghEditImpl: (args) => editCalls.push(args) },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(editCalls.length, 1);
});

// -- #437 unit 437-C, Required Behavior #3 (the #408 reproduction) ---------------------------
//
// FOUNDER_DECISION_408_BEFORE_BODY is the verbatim shape of GitHub issue #408's own real body,
// confirmed via its `userContentEdits` revision history: the edit at 2026-09-07T14:02:24Z,
// where the founder's approval had just been recorded ("Founder decision: approved skipping a
// second Stage 1 Codex round on the correction commit (2026-09-07); see Operating rule below")
// but not yet marked consumed, alongside durable evidence elsewhere in the same body that the
// decision was already exercised (Route: "PR #435 merged; Stage 2 audit #436 triggered against
// the exact merge commit"; Stage 2: "#436 (triggered ...)"). In the real history, #408 cleared
// this Founder decision in a *separate* later edit (2026-09-07T14:21:33Z) that touched no other
// field -- exactly the "requires a later housekeeping invocation" gap #437's Shared Contract
// point 1 says 437-A's prose closes procedurally. This test proves the corrected discipline is
// mechanically achievable with the existing `upsertControlBullet`/`checkWriteControlSnapshot`
// primitives: composing the Founder-decision clear *and* a substantive Lifecycle advance into
// one proposed body and persisting both through exactly one `write-control-snapshot.mjs` call.
const FOUNDER_DECISION_408_BEFORE_BODY = `- **Execution issue:** #407
- **Lifecycle:** AUDIT
- **Route:** PR #435 merged; Stage 2 audit #436 triggered against the exact merge commit
- **Stage 2:** #436 (triggered https://github.com/LouPineWays/Loop-Dee-Loup/issues/436#issuecomment-5571754033)
- **Blocker:** none
- **Founder decision:** approved skipping a second Stage 1 Codex round on the correction commit (2026-09-07); see Operating rule below
- **Terminal result:** none
`;

test("checkWriteControlSnapshot: #408 reproduction — clearing a consumed Founder decision composes into the same call as a substantive Lifecycle advance (Required Behavior #3)", () => {
  // Compose the proposed body the way a decision-consuming transition is required to: two
  // upsertControlBullet calls building one body, persisted through exactly one
  // checkWriteControlSnapshot invocation -- never a Founder-decision-only write followed by a
  // separate later housekeeping edit.
  let proposedBody = FOUNDER_DECISION_408_BEFORE_BODY;
  proposedBody = upsertControlBullet(
    proposedBody,
    "Founder decision",
    "none — prior approval to skip a second Stage 1 Codex round on the correction commit was exercised before PR #435 merged on 2026-09-07; the settled decision remains recorded in Stage 1 / Operating rule below",
  );
  proposedBody = upsertControlBullet(proposedBody, "Lifecycle", "DONE");

  const editCalls = [];
  const result = checkWriteControlSnapshot(
    { repo: "owner/repo", controlIssue: 408, proposedBody },
    { ghEditImpl: (args) => editCalls.push(args) },
  );

  assert.equal(result.exitCode, 0, `expected the composed #408-shape body to pass validation and write; got: ${JSON.stringify(result)}`);
  assert.equal(result.state, "WRITTEN");
  assert.equal(editCalls.length, 1, "the Founder-decision clear and the Lifecycle advance must persist through exactly one write, not a follow-up housekeeping edit");

  const writtenBody = editCalls[0].body;
  const writtenFounderDecision = parseControlBullet(writtenBody, "Founder decision");
  assert.ok(isNoneSentinel(writtenFounderDecision), `Founder decision must read a "none" sentinel after the consuming transition; got: ${JSON.stringify(writtenFounderDecision)}`);
  assert.match(writtenFounderDecision, /prior approval .* was exercised/, "the compact resolution note must preserve why the decision was already exercised (provenance, per #437 Required Behavior #6)");
  assert.equal(parseControlBullet(writtenBody, "Lifecycle"), "DONE");
  // Provenance: the evidence that the decision was exercised (the merged PR / triggered Stage 2
  // audit) survives untouched in the same written body -- clearing the live field must not erase
  // why it was blocked or what satisfied it.
  assert.match(writtenBody, /PR #435 merged; Stage 2 audit #436 triggered/);
});
