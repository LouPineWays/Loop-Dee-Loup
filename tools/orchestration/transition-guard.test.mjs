// Tests for tools/orchestration/transition-guard.mjs — issue #601's generalized start/commit/
// postcondition invariant for mutable-state-authorized durable transitions.
//
// The fixtures below deliberately mirror the shape of each named case-study incident
// (#492, #537, #576/#586, #581) to satisfy #601's Required check items 1-9: proving the
// generalized `commitControlBodyTransition` seam would prevent or explicitly detect each
// failure class, without touching or re-litigating the already-correct, already-tested
// finalize-*-breakpoint.mjs scripts those incidents were actually fixed in.
//
// Run with:
//   node --test tools/orchestration/transition-guard.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { commitControlBodyTransition, TransitionFailureClass } from "./transition-guard.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";
import { parseControlBullet, upsertControlBullet } from "./ready-dispatch-gate.mjs";

const READY_BODY = [
  "## Current state",
  "",
  "- **Lifecycle:** READY",
  "- **Marker:** none",
  "- **Blocker:** none",
  "",
].join("\n");

const COMMITTED_BODY = upsertControlBullet(READY_BODY, "Marker", "done");

// A minimal, realistic compose(): only authorized to transition Lifecycle READY -> a `Marker`
// bullet of "done", mirroring every real finalize-*-breakpoint.mjs's own
// "current Lifecycle must be one of the recognized pre-finalize values" gate. Idempotent by
// construction: re-running against an already-"done" body composes the identical body again
// (required check 4), exactly like the real scripts' own `ALLOWED_PRE_FINALIZE_LIFECYCLE`
// including their own post-transition value.
function composeMarkerDone(body) {
  const lifecycle = parseControlBullet(body, "Lifecycle");
  const marker = parseControlBullet(body, "Marker");
  if (lifecycle === null || lifecycle.trim() !== "READY") {
    return { ok: false, reason: `Lifecycle is ${JSON.stringify(lifecycle)}, expected "READY" -- not authorized to mark done` };
  }
  if (marker !== null && marker.trim() === "done") {
    // Idempotent no-op: already at the target postcondition.
    return { ok: true, body };
  }
  return { ok: true, body: upsertControlBullet(body, "Marker", "done") };
}

function verifyMarkerDone(freshBody) {
  const marker = parseControlBullet(freshBody, "Marker");
  if (marker === null || marker.trim() !== "done") {
    return { ok: false, reason: `fresh read-back's Marker bullet is ${JSON.stringify(marker)}, expected "done"` };
  }
  return { ok: true };
}

function stubReads(bodies) {
  let call = 0;
  return async () => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return body;
  };
}

function stubWrite({ state = "WRITTEN", exitCode = 0 } = {}) {
  const calls = [];
  const impl = async (args) => {
    calls.push(args);
    return { exitCode, state };
  };
  impl.calls = calls;
  return impl;
}

// -- Required check 2: stable witness -------------------------------------------------------

test("stable witness: effect proceeds once and postcondition is read back successfully", async () => {
  // Same body on both the initial read and the pre-effect re-read; the write actually changes
  // it to COMMITTED_BODY; the post-write read-back reflects that.
  const reads = stubReads([READY_BODY, READY_BODY, COMMITTED_BODY]);
  const write = stubWrite();

  const result = await commitControlBodyTransition({
    controlIssue: 1,
    compose: composeMarkerDone,
    verify: verifyMarkerDone,
    ghIssueViewImpl: reads,
    writeControlSnapshotImpl: write,
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, "COMMITTED");
  assert.equal(result.failureClass, null);
  assert.equal(write.calls.length, 1);
});

// -- Required check 1 / #492 regression class -------------------------------------------------
// Classic TOCTOU: the witness (the whole control body, here specifically Lifecycle) that
// authorized the transition at the initial read has changed by the time it is revalidated
// immediately before the effect. #492's own shape: an audit's evidence-bearing context changed
// between evidence validation and verdict mutation. Modeled here as the same authorizing field
// (Lifecycle) itself changing between the two reads -- the final guard must detect W2 != W1 and
// perform no stale-authorized effect.

test("classic TOCTOU (#492 regression class): witness changes before the effect; fails closed with WITNESS_CHANGED_TOCTOU and no effect performed", async () => {
  const changedBody = upsertControlBullet(READY_BODY, "Lifecycle", "BLOCKED");
  const reads = stubReads([READY_BODY, changedBody]);
  const write = stubWrite();

  const result = await commitControlBodyTransition({
    controlIssue: 2,
    compose: composeMarkerDone,
    verify: verifyMarkerDone,
    ghIssueViewImpl: reads,
    writeControlSnapshotImpl: write,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureClass, TransitionFailureClass.WITNESS_CHANGED_TOCTOU);
  assert.equal(write.calls.length, 0, "no effect must be performed once the witness fails to revalidate");
});

test("stale-start precondition: authorization already does not hold at the initial fresh read", async () => {
  const blockedBody = upsertControlBullet(READY_BODY, "Lifecycle", "BLOCKED");
  const reads = stubReads([blockedBody]);
  const write = stubWrite();

  const result = await commitControlBodyTransition({
    controlIssue: 3,
    compose: composeMarkerDone,
    verify: verifyMarkerDone,
    ghIssueViewImpl: reads,
    writeControlSnapshotImpl: write,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureClass, TransitionFailureClass.STALE_START_PRECONDITION);
  assert.equal(write.calls.length, 0);
});

// -- Required check 3: postcondition failure --------------------------------------------------

test("postcondition failure (write not WRITTEN): transition does not report success and is classified POSTCONDITION_PROJECTION_FAILED", async () => {
  const reads = stubReads([READY_BODY, READY_BODY]);
  const write = stubWrite({ state: "REJECTED", exitCode: 2 });

  const result = await commitControlBodyTransition({
    controlIssue: 4,
    compose: composeMarkerDone,
    verify: verifyMarkerDone,
    ghIssueViewImpl: reads,
    writeControlSnapshotImpl: write,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureClass, TransitionFailureClass.POSTCONDITION_PROJECTION_FAILED);
});

test("postcondition failure (read-back mismatch): write reports WRITTEN but fresh read-back disagrees; classified POSTCONDITION_READBACK_MISMATCH, not reported as success", async () => {
  // The write call "succeeds" per its own return value, but the fresh read-back still shows
  // the pre-transition body -- a silent no-op write, or a concurrent edit reverting it.
  const reads = stubReads([READY_BODY, READY_BODY, READY_BODY]);
  const write = stubWrite();

  const result = await commitControlBodyTransition({
    controlIssue: 5,
    compose: composeMarkerDone,
    verify: verifyMarkerDone,
    ghIssueViewImpl: reads,
    writeControlSnapshotImpl: write,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureClass, TransitionFailureClass.POSTCONDITION_READBACK_MISMATCH);
});

// -- Required check 4: idempotent recovery ----------------------------------------------------

test("idempotent recovery: rerunning after the effect already landed produces no duplicate distinguishable effect and succeeds", async () => {
  // Both reads already show the post-transition body (Marker: done). compose() is authorized
  // to run again (its own idempotent branch), producing an identical body; the write is
  // effectively a no-op; read-back still verifies.
  const reads = stubReads([COMMITTED_BODY, COMMITTED_BODY, COMMITTED_BODY]);
  const write = stubWrite();

  const result = await commitControlBodyTransition({
    controlIssue: 6,
    compose: composeMarkerDone,
    verify: verifyMarkerDone,
    ghIssueViewImpl: reads,
    writeControlSnapshotImpl: write,
  });

  assert.equal(result.ok, true);
  assert.equal(write.calls[0].proposedBody, COMMITTED_BODY, "the composed write body is unchanged -- no duplicate effect");
});

// -- Required check 6 / #537 regression class -------------------------------------------------
// #537's own shape: a stale historical pointer could override the live current phase. This
// primitive structurally cannot reproduce that class: `compose` only ever receives a body this
// module itself just freshly fetched via `ghIssueViewImpl` -- never a value a caller captured
// earlier and passed in. Proven here by a spy that records every body `compose` actually saw
// and asserting both are the freshly-stubbed reads, never a fixed/cached value.

test("#537 regression class: compose() is only ever invoked against freshly fetched bodies, never a cached/stale value a caller could pass in", async () => {
  const seenBodies = [];
  const spyCompose = (body) => {
    seenBodies.push(body);
    return composeMarkerDone(body);
  };
  const reads = stubReads([READY_BODY, READY_BODY, COMMITTED_BODY]);
  const write = stubWrite();

  const result = await commitControlBodyTransition({
    controlIssue: 7,
    compose: spyCompose,
    verify: verifyMarkerDone,
    ghIssueViewImpl: reads,
    writeControlSnapshotImpl: write,
  });

  assert.equal(result.ok, true);
  assert.equal(seenBodies.length, 2, "compose() runs exactly twice: initial authorization, then commit-boundary revalidation");
  assert.equal(seenBodies[0], READY_BODY);
  assert.equal(seenBodies[1], READY_BODY);
});

// -- Required check 7 / #576 / #586 regression class ------------------------------------------
// #576/#586's own shape: a transition completed while a durable postcondition a *later* step
// depends on remained stale. Modeled with a two-field postcondition (Marker AND Companion):
// the write only updates Marker, leaving Companion stale -- verify() must catch the still-stale
// half and refuse to report success, exactly as the downstream stage1-control-plane check
// #586 fixed could not resolve a disposition that was never durably promoted.

function composeMarkerOnly(body) {
  const check = composeMarkerDone(body);
  if (!check.ok) return check;
  return check;
}

function verifyMarkerAndCompanion(freshBody) {
  const markerCheck = verifyMarkerDone(freshBody);
  if (!markerCheck.ok) return markerCheck;
  const companion = parseControlBullet(freshBody, "Companion");
  if (companion === null || companion.trim() !== "done") {
    return { ok: false, reason: `fresh read-back's Companion bullet is ${JSON.stringify(companion)}, expected "done" -- downstream transition cannot advance while this remains stale` };
  }
  return { ok: true };
}

test("#576/#586 regression class: transition cannot report success while a durable postcondition the next step depends on remains stale", async () => {
  const reads = stubReads([READY_BODY, READY_BODY, COMMITTED_BODY]); // Companion never gets set
  const write = stubWrite();

  const result = await commitControlBodyTransition({
    controlIssue: 8,
    compose: composeMarkerOnly,
    verify: verifyMarkerAndCompanion,
    ghIssueViewImpl: reads,
    writeControlSnapshotImpl: write,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureClass, TransitionFailureClass.POSTCONDITION_READBACK_MISMATCH);
  assert.match(result.reason, /Companion/);
});

// -- Required check 8 / #581 regression class -------------------------------------------------
// #581's own shape: a lifecycle write could leave two contradictory representations (the ad hoc
// "Lifecycle" bullet vs. the canonical "### State" heading). That guard already lives in
// control-field-validator.mjs's `validateLifecycleStateCoherence`, reached through the REAL
// `checkWriteControlSnapshot` (not a stub) -- this proves the shared seam refuses such a write
// via the existing guard, rather than reimplementing that check a second way.

function composeContradictoryLifecycle(body) {
  const check = composeMarkerDone(body);
  if (!check.ok) return check;
  // Compose a body naming both representations, disagreeing with each other -- the exact #577
  // live reproduction shape validateLifecycleStateCoherence exists to reject. Built by direct
  // string substitution (never a second `upsertControlBullet` call on the combined string) so
  // the #583 auto-converge fix upsertControlBullet itself now applies whenever both
  // representations are present does not silently repair this deliberately contradictory
  // fixture before it ever reaches the validator.
  const withHeading = `### State\n\nREADY\n\n${check.body.replace("- **Lifecycle:** READY", "- **Lifecycle:** REVIEW")}`;
  return { ok: true, body: withHeading };
}

test("#581 regression class: a compose() result carrying contradictory Lifecycle/State representations is refused by the real write-control-snapshot.mjs path", async () => {
  const reads = stubReads([READY_BODY, READY_BODY]);

  const result = await commitControlBodyTransition({
    controlIssue: 9,
    compose: composeContradictoryLifecycle,
    verify: verifyMarkerDone,
    ghIssueViewImpl: reads,
    // The real validated writer -- its own ghEditImpl is never reached because the coherence
    // check rejects the proposed body before any `gh` call.
    writeControlSnapshotImpl: checkWriteControlSnapshot,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureClass, TransitionFailureClass.POSTCONDITION_PROJECTION_FAILED);
  assert.match(result.reason, /contradictory/);
});

// -- Required check 9: irrelevant-state negative control --------------------------------------

test("irrelevant-state negative control: an unrelated field changing between reads does not invalidate a transition whose material witness is unchanged", async () => {
  const withUnrelatedNote = upsertControlBullet(READY_BODY, "Blocker", "unrelated note added between reads");
  const reads = stubReads([READY_BODY, withUnrelatedNote, upsertControlBullet(withUnrelatedNote, "Marker", "done")]);
  const write = stubWrite();

  const result = await commitControlBodyTransition({
    controlIssue: 10,
    compose: composeMarkerDone,
    verify: verifyMarkerDone,
    ghIssueViewImpl: reads,
    writeControlSnapshotImpl: write,
  });

  assert.equal(result.ok, true);
  // The write is composed from the fresher (unrelated-note-carrying) body, not clobbered back
  // to the stale initial read.
  assert.match(write.calls[0].proposedBody, /unrelated note added between reads/);
});

// -- Operational-error argument validation ----------------------------------------------------

test("operational error: missing controlIssue is rejected before any read/write is attempted", async () => {
  const reads = stubReads([READY_BODY]);
  const write = stubWrite();
  const result = await commitControlBodyTransition({
    compose: composeMarkerDone,
    verify: verifyMarkerDone,
    ghIssueViewImpl: reads,
    writeControlSnapshotImpl: write,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.ok, false);
});

test("operational error: an initial gh issue view failure is reported as exitCode 1, not a classified transition failure", async () => {
  const failingRead = async () => {
    throw new Error("network blip");
  };
  const result = await commitControlBodyTransition({
    controlIssue: 11,
    compose: composeMarkerDone,
    verify: verifyMarkerDone,
    ghIssueViewImpl: failingRead,
    writeControlSnapshotImpl: stubWrite(),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.failureClass, null);
});
