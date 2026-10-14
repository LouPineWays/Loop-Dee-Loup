// Tests for tools/orchestration/session-entry-gate.mjs — issue #675's deterministic
// session-entry router, closing the exact #639 live reproduction where a chained lifecycle
// verdict from `ready-dispatch-gate.mjs` surfaced to the calling session as a nonzero-exit Bash
// command instead of a successfully-derived domain verdict.
//
// Every composed gate call is injected — these tests never touch the real network, `gh` CLI, or
// spawn a real child process for `ready-dispatch-gate.mjs`/`next-review-transition-gate.mjs`/
// `reconcile-control-blocker.mjs`.
//
// Run with:
//   node --test tools/orchestration/session-entry-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { runSessionEntryGate } from "./session-entry-gate.mjs";
import { getActionEnvelope } from "./action-envelope.mjs";

const REPO = "LouPineWays/Loop-Dee-Loup";

// Issue #1165: every pre-existing test is a control with nothing to consume; the real activation
// path is covered by the dedicated #1165 tests below.
function noActivation() {
  return { exitCode: 0, state: "NO_CANDIDATE" };
}

function stubResolveRepoIdentity() {
  return { ok: true, repo: REPO };
}

// -- The exact #639 reproduction -----------------------------------------------------------

test("#639 reproduction: NOT_READY/REVIEW chain is resolved to the post-PR gate's own verdict, ok:true", async () => {
  const readyVerdict = {
    exitCode: 3,
    state: "NOT_READY",
    controlIssue: 639,
    repo: REPO,
    reasons: ["control Issue is mid-cycle"],
    postPrLifecycle: "REVIEW",
    actionEnvelope: getActionEnvelope("NOT_READY", { postPrLifecycle: "REVIEW" }),
  };
  const transitionVerdict = {
    exitCode: 5,
    state: "STAGE1_CORRECTION_REQUIRED",
    controlIssue: 639,
    repo: REPO,
    correctionReason: "findings",
    actionEnvelope: getActionEnvelope("STAGE1_CORRECTION_REQUIRED", { correctionReason: "findings" }),
  };

  let readyCalls = 0;
  let transitionCalls = [];
  const result = await runSessionEntryGate(
    { repo: REPO, controlIssue: 639 },
    {
      checkReadyDispatchImpl: async (args) => {
        readyCalls += 1;
        assert.deepEqual(args, { repo: REPO, controlIssue: 639 });
        return readyVerdict;
      },
      runNextReviewTransitionGateImpl: async (args) => {
        transitionCalls.push(args);
        return transitionVerdict;
      },
      checkReconcileControlBlockerImpl: async () => {
        throw new Error("must not be called for this shape");
      },
      resolveRepoIdentityImpl: stubResolveRepoIdentity,
      resolveEntryActivationImpl: noActivation,
    },
  );

  assert.equal(readyCalls, 1);
  assert.deepEqual(transitionCalls, [{ repo: REPO, controlIssue: 639 }]);
  assert.equal(result.ok, true);
  // The externally returned result is the chained gate's authoritative verdict, not a
  // "Failed to run READY immediate-dispatch gate" shape.
  assert.equal(result.state, "STAGE1_CORRECTION_REQUIRED");
  assert.equal(result.actionEnvelope.mode, "bounded");
  assert.deepEqual(result.provenance, [
    { gate: "ready-dispatch-gate", state: "NOT_READY", leafExitCode: 3, actionEnvelopeMode: "chain" },
    { gate: "next-review-transition-gate", state: "STAGE1_CORRECTION_REQUIRED", leafExitCode: 5, actionEnvelopeMode: "bounded" },
  ]);
});

// -- AUDIT_ISSUE_DETECTED chain -------------------------------------------------------------

test("AUDIT_ISSUE_DETECTED chains to next-review-transition-gate by --audit-issue, never --control-issue", async () => {
  const readyVerdict = {
    exitCode: 9,
    state: "AUDIT_ISSUE_DETECTED",
    controlIssue: 700,
    repo: REPO,
    auditIssue: 700,
    actionEnvelope: getActionEnvelope("AUDIT_ISSUE_DETECTED"),
  };
  const transitionVerdict = {
    exitCode: 0,
    state: "STAGE2_CLOSE_READY",
    repo: REPO,
    auditIssue: 700,
    nextCommand: "node tools/review-watch/lifecycle-gate.mjs close-audit --audit-issue 700",
    actionEnvelope: getActionEnvelope("STAGE2_CLOSE_READY", {
      nextCommand: "node tools/review-watch/lifecycle-gate.mjs close-audit --audit-issue 700",
    }),
  };

  let transitionArgs = null;
  const result = await runSessionEntryGate(
    { repo: REPO, controlIssue: 700 },
    {
      checkReadyDispatchImpl: async () => readyVerdict,
      runNextReviewTransitionGateImpl: async (args) => {
        transitionArgs = args;
        return transitionVerdict;
      },
      checkReconcileControlBlockerImpl: async () => {
        throw new Error("must not be called for this shape");
      },
      resolveRepoIdentityImpl: stubResolveRepoIdentity,
      resolveEntryActivationImpl: noActivation,
    },
  );

  assert.deepEqual(transitionArgs, { repo: REPO, auditIssue: 700 });
  assert.equal(result.ok, true);
  assert.equal(result.state, "STAGE2_CLOSE_READY");
});

// -- BLOCKED reconciliation: UNBLOCKED path --------------------------------------------------

test("BLOCKED + blockerReconciliationEligible -> UNBLOCKED authorizes exactly one fresh ready-dispatch-gate re-invocation", async () => {
  const blockedVerdict = {
    exitCode: 4,
    state: "BLOCKED",
    controlIssue: 301,
    repo: REPO,
    reasons: ["Blocker: #299"],
    blockerReconciliationEligible: true,
    actionEnvelope: getActionEnvelope("BLOCKED", { blockerReconciliationEligible: true }),
  };
  const unblockedResult = { exitCode: 0, state: "UNBLOCKED", controlIssue: 301, prerequisitesSatisfied: [299] };
  const freshVerdict = {
    exitCode: 0,
    state: "READY_TO_DISPATCH",
    controlIssue: 301,
    repo: REPO,
    executionIssue: 297,
    route: "implementation worker",
    actionEnvelope: getActionEnvelope("READY_TO_DISPATCH"),
  };

  let readyCallCount = 0;
  let reconcileArgs = null;
  const result = await runSessionEntryGate(
    { repo: REPO, controlIssue: 301 },
    {
      checkReadyDispatchImpl: async () => {
        readyCallCount += 1;
        return readyCallCount === 1 ? blockedVerdict : freshVerdict;
      },
      runNextReviewTransitionGateImpl: async () => {
        throw new Error("must not be called for this shape");
      },
      checkReconcileControlBlockerImpl: async (args) => {
        reconcileArgs = args;
        return unblockedResult;
      },
      resolveRepoIdentityImpl: stubResolveRepoIdentity,
      resolveEntryActivationImpl: noActivation,
    },
  );

  assert.deepEqual(reconcileArgs, { repo: REPO, "control-issue": 301 });
  assert.equal(readyCallCount, 2);
  assert.equal(result.ok, true);
  assert.equal(result.state, "READY_TO_DISPATCH");
  assert.equal(result.provenance.length, 3);
  assert.equal(result.provenance[1].gate, "reconcile-control-blocker");
  assert.equal(result.provenance[1].state, "UNBLOCKED");
});

// -- BLOCKED reconciliation: non-UNBLOCKED terminal path -------------------------------------

for (const nonUnblockedState of ["INCOMPLETE_PREREQUISITE", "AMBIGUOUS_BLOCKER", "ALREADY_UNBLOCKED", "ALREADY_TERMINAL"]) {
  test(`BLOCKED + blockerReconciliationEligible -> ${nonUnblockedState} is terminal, never a further chain hop`, async () => {
    const blockedVerdict = {
      exitCode: 4,
      state: "BLOCKED",
      controlIssue: 301,
      repo: REPO,
      reasons: ["Blocker: #299"],
      blockerReconciliationEligible: true,
      actionEnvelope: getActionEnvelope("BLOCKED", { blockerReconciliationEligible: true }),
    };
    const reconciliationResult = { exitCode: nonUnblockedState === "ALREADY_TERMINAL" ? 0 : 4, state: nonUnblockedState, controlIssue: 301 };

    let readyCallCount = 0;
    const result = await runSessionEntryGate(
      { repo: REPO, controlIssue: 301 },
      {
        checkReadyDispatchImpl: async () => {
          readyCallCount += 1;
          return blockedVerdict;
        },
        runNextReviewTransitionGateImpl: async () => {
          throw new Error("must not be called for this shape");
        },
        checkReconcileControlBlockerImpl: async () => reconciliationResult,
        resolveRepoIdentityImpl: stubResolveRepoIdentity,
        resolveEntryActivationImpl: noActivation,
      },
    );

    assert.equal(readyCallCount, 1, "must never re-invoke ready-dispatch-gate for a non-UNBLOCKED reconciliation result");
    assert.equal(result.ok, true);
    // The BLOCKED verdict itself is returned (its own envelope is "none" — the correct stop
    // instruction), annotated with the reconciliation outcome for diagnostics.
    assert.equal(result.state, "BLOCKED");
    assert.equal(result.actionEnvelope.mode, "none");
    assert.equal(result.reconciliation.state, nonUnblockedState);
  });
}

// -- BLOCKED reconciliation: REJECTED is an operational failure, not a terminal domain outcome --

test("BLOCKED + blockerReconciliationEligible -> REJECTED fails operationally (ok:false), never a successful terminal BLOCKED verdict", async () => {
  // Stage 1 review finding on PR #716: `reconcile-control-blocker.mjs`'s `REJECTED` / exit-2
  // state means the composed proposed control snapshot failed write-control-snapshot.mjs's own
  // validation -- a failed child invocation, not one of the four documented terminal domain
  // outcomes (INCOMPLETE_PREREQUISITE, AMBIGUOUS_BLOCKER, ALREADY_UNBLOCKED, ALREADY_TERMINAL).
  // It must propagate as an operational failure, preserving enough detail to diagnose the
  // rejected write, rather than being folded into "anything but UNBLOCKED is terminal BLOCKED".
  const blockedVerdict = {
    exitCode: 4,
    state: "BLOCKED",
    controlIssue: 301,
    repo: REPO,
    reasons: ["Blocker: #299"],
    blockerReconciliationEligible: true,
    actionEnvelope: getActionEnvelope("BLOCKED", { blockerReconciliationEligible: true }),
  };
  const rejectedResult = {
    exitCode: 2,
    state: "REJECTED",
    controlIssue: 301,
    errors: ["Lifecycle field is ambiguous."],
    message: "reconcile-control-blocker.mjs: proposed control snapshot failed validation.",
  };

  let readyCallCount = 0;
  const result = await runSessionEntryGate(
    { repo: REPO, controlIssue: 301 },
    {
      checkReadyDispatchImpl: async () => {
        readyCallCount += 1;
        return blockedVerdict;
      },
      runNextReviewTransitionGateImpl: async () => {
        throw new Error("must not be called for this shape");
      },
      checkReconcileControlBlockerImpl: async () => rejectedResult,
      resolveRepoIdentityImpl: stubResolveRepoIdentity,
      resolveEntryActivationImpl: noActivation,
    },
  );

  assert.equal(readyCallCount, 1, "must never re-invoke ready-dispatch-gate after a REJECTED reconciliation result");
  assert.equal(result.ok, false, "REJECTED must fail operationally, not be normalized into a successful domain verdict");
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /failed validation/);
  assert.equal(result.reconciliation.state, "REJECTED");
  assert.equal(result.provenance.at(-1).gate, "reconcile-control-blocker");
  assert.equal(result.provenance.at(-1).state, "REJECTED");
});

// -- Negative control: ordinary ("fallthrough") NOT_READY never chains ----------------------

test("ordinary NOT_READY (no postPrLifecycle, mode fallthrough) never invokes a chained gate", async () => {
  const readyVerdict = {
    exitCode: 3,
    state: "NOT_READY",
    controlIssue: 555,
    repo: REPO,
    reasons: ["control Issue is a legacy unsplit shape"],
    actionEnvelope: getActionEnvelope("NOT_READY"),
  };

  const result = await runSessionEntryGate(
    { repo: REPO, controlIssue: 555 },
    {
      checkReadyDispatchImpl: async () => readyVerdict,
      runNextReviewTransitionGateImpl: async () => {
        throw new Error("must not be called for ordinary fallthrough NOT_READY");
      },
      checkReconcileControlBlockerImpl: async () => {
        throw new Error("must not be called for ordinary fallthrough NOT_READY");
      },
      resolveRepoIdentityImpl: stubResolveRepoIdentity,
      resolveEntryActivationImpl: noActivation,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.state, "NOT_READY");
  assert.equal(result.actionEnvelope.mode, "fallthrough");
  assert.equal(result.provenance.length, 1);
});

// -- Negative control: BLOCKED with mode "none" (not reconciliation-eligible) never chains ---

test("BLOCKED without blockerReconciliationEligible never invokes reconcile-control-blocker", async () => {
  const readyVerdict = {
    exitCode: 4,
    state: "BLOCKED",
    controlIssue: 301,
    repo: REPO,
    reasons: ["Founder decision: pending"],
    blockerReconciliationEligible: false,
    actionEnvelope: getActionEnvelope("BLOCKED", { blockerReconciliationEligible: false }),
  };

  const result = await runSessionEntryGate(
    { repo: REPO, controlIssue: 301 },
    {
      checkReadyDispatchImpl: async () => readyVerdict,
      runNextReviewTransitionGateImpl: async () => {
        throw new Error("must not be called");
      },
      checkReconcileControlBlockerImpl: async () => {
        throw new Error("must not be called");
      },
      resolveRepoIdentityImpl: stubResolveRepoIdentity,
      resolveEntryActivationImpl: noActivation,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.state, "BLOCKED");
  assert.equal(result.actionEnvelope.mode, "none");
  assert.equal(result.provenance.length, 1);
});

// -- Negative control: a bounded verdict is returned without auto-consuming the action -------

test("mode:bounded (READY_TO_DISPATCH) is returned without executing a further lifecycle transition", async () => {
  const readyVerdict = {
    exitCode: 0,
    state: "READY_TO_DISPATCH",
    stopAfter: true,
    controlIssue: 311,
    repo: REPO,
    executionIssue: 310,
    route: "implementation worker",
    actionEnvelope: getActionEnvelope("READY_TO_DISPATCH"),
  };

  const result = await runSessionEntryGate(
    { repo: REPO, controlIssue: 311 },
    {
      checkReadyDispatchImpl: async () => readyVerdict,
      runNextReviewTransitionGateImpl: async () => {
        throw new Error("must not be called for a bounded verdict");
      },
      checkReconcileControlBlockerImpl: async () => {
        throw new Error("must not be called for a bounded verdict");
      },
      resolveRepoIdentityImpl: stubResolveRepoIdentity,
      resolveEntryActivationImpl: noActivation,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.state, "READY_TO_DISPATCH");
  assert.equal(result.actionEnvelope.mode, "bounded");
  assert.deepEqual(result.actionEnvelope.authorizedActions, ["dispatch-execution-worker"]);
  assert.equal(result.provenance.length, 1);
});

// -- Operational-error fixtures ----------------------------------------------------------

test("operational failure from ready-dispatch-gate.mjs is reported as ok:false, never as a domain verdict", async () => {
  const result = await runSessionEntryGate(
    { repo: REPO, controlIssue: 639 },
    {
      checkReadyDispatchImpl: async () => ({ exitCode: 1, message: "gh issue view failed for LouPineWays/Loop-Dee-Loup#639: boom" }),
      runNextReviewTransitionGateImpl: async () => {
        throw new Error("must not be called");
      },
      checkReconcileControlBlockerImpl: async () => {
        throw new Error("must not be called");
      },
      resolveRepoIdentityImpl: stubResolveRepoIdentity,
      resolveEntryActivationImpl: noActivation,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh issue view failed/);
  assert.equal(result.state, undefined);
  assert.equal(result.provenance.length, 1);
});

test("operational failure from a chained next-review-transition-gate.mjs call is reported as ok:false", async () => {
  const readyVerdict = {
    exitCode: 3,
    state: "NOT_READY",
    controlIssue: 639,
    repo: REPO,
    postPrLifecycle: "REVIEW",
    actionEnvelope: getActionEnvelope("NOT_READY", { postPrLifecycle: "REVIEW" }),
  };

  const result = await runSessionEntryGate(
    { repo: REPO, controlIssue: 639 },
    {
      checkReadyDispatchImpl: async () => readyVerdict,
      runNextReviewTransitionGateImpl: async () => ({ exitCode: 1, message: "gh pr view failed" }),
      checkReconcileControlBlockerImpl: async () => {
        throw new Error("must not be called");
      },
      resolveRepoIdentityImpl: stubResolveRepoIdentity,
      resolveEntryActivationImpl: noActivation,
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /gh pr view failed/);
  assert.equal(result.provenance.length, 2);
});

test("missing --control-issue is an immediate operational failure with no gate calls", async () => {
  let called = false;
  const result = await runSessionEntryGate(
    { repo: REPO, controlIssue: undefined },
    {
      checkReadyDispatchImpl: async () => {
        called = true;
        return {};
      },
      resolveRepoIdentityImpl: stubResolveRepoIdentity,
      resolveEntryActivationImpl: noActivation,
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /--control-issue is required/);
  assert.equal(called, false);
});

test("unresolved repository identity is an immediate operational failure with no gate calls", async () => {
  let called = false;
  const result = await runSessionEntryGate(
    { controlIssue: 639 },
    {
      checkReadyDispatchImpl: async () => {
        called = true;
        return {};
      },
      resolveRepoIdentityImpl: () => ({ ok: false, reason: "no configured remote" }),
    },
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /Could not determine the current repository identity/);
  assert.equal(called, false);
});

// -- Fail-closed circuit breakers ------------------------------------------------------------

test("an unrecognized chain-shaped verdict fails closed to an operational error rather than guessing", async () => {
  const surprisingVerdict = {
    exitCode: 42,
    state: "SOME_FUTURE_CHAIN_STATE",
    controlIssue: 999,
    repo: REPO,
    actionEnvelope: { mode: "chain", authorizedActions: ["run-some-future-gate"] },
  };

  const result = await runSessionEntryGate(
    { repo: REPO, controlIssue: 999 },
    {
      checkReadyDispatchImpl: async () => surprisingVerdict,
      runNextReviewTransitionGateImpl: async () => {
        throw new Error("must not be called");
      },
      checkReconcileControlBlockerImpl: async () => {
        throw new Error("must not be called");
      },
      resolveRepoIdentityImpl: stubResolveRepoIdentity,
      resolveEntryActivationImpl: noActivation,
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /recognizes no chain shape/);
});

test("an unbounded chain loop trips the circuit breaker instead of looping forever", async () => {
  const readyVerdict = {
    exitCode: 3,
    state: "NOT_READY",
    controlIssue: 639,
    repo: REPO,
    postPrLifecycle: "REVIEW",
    actionEnvelope: getActionEnvelope("NOT_READY", { postPrLifecycle: "REVIEW" }),
  };
  // A synthetic, never-real shape: keeps re-declaring itself as NOT_READY/postPrLifecycle/chain
  // forever, to prove the router's own circuit breaker — not the leaf gates' real behavior —
  // bounds the loop.
  let transitionCallCount = 0;
  const result = await runSessionEntryGate(
    { repo: REPO, controlIssue: 639 },
    {
      checkReadyDispatchImpl: async () => readyVerdict,
      runNextReviewTransitionGateImpl: async () => {
        transitionCallCount += 1;
        return readyVerdict;
      },
      checkReconcileControlBlockerImpl: async () => {
        throw new Error("must not be called");
      },
      resolveRepoIdentityImpl: stubResolveRepoIdentity,
      resolveEntryActivationImpl: noActivation,
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /Exceeded \d+ chained gate hops/);
  assert.equal(transitionCallCount, 6);
});

// -- Issue #1165: ordinary-entry activation (source-level reproduction of fixtures A and B) -----
//
// A stateful fake control world drives the REAL resolveEntryActivation/activateControlPair/
// checkWriteControlSnapshot transaction through the ordinary session-entry router: the gate verdict
// is derived from the live fake control body each call, so "fresh gate after persistence" is
// genuinely re-evaluated. This is source-test evidence only, not real unassisted session proof.

import { resolveEntryActivation } from "./activate-control-pair.mjs";

const FENCE = "```";
const jb = (obj) => `${FENCE}json\n${JSON.stringify(obj)}\n${FENCE}`;
const REVIEW_GRANT = { executorSubstrate: [{ component: "review-control", paths: [".github/workflows/ldl-launcher.yml"], intendedChange: "x", verification: "y" }] };
const THICK_1163 = `### Parent loop\n#1164 - control.\n\n### ACTIVE founder-approved qualification and exact protected-component grant - 2026-10-14\nYes, authorized.\n\n${jb(REVIEW_GRANT)}\n`;
const BODY_1164 = `### State\n\nNEEDS_FOUNDER\n\n### Current state\n\n- **Execution:** #1163\n- **Route:** none\n- **Founder decision:** pending narrow proof / exact protected-workflow grant\n\n### Current blocker\n\nNot yet separately authorized; assessment remains to be accepted.\n\n### Founder interrupt\n\nMay engineering proceed after the exact component grant?\n`;
const NEW_PACKET = `### Parent loop\n#438\n\n### ACTIVE founder-authorized new packet\n${jb({ newPacketAuthority: { controlIssue: 438, executionIssue: 1165 } })}\n`;
const BODY_438 = `### State\n\nDONE\n\n### Current state\n\n- **Execution:** #1151\n- **Founder decision:** none\n- **PR:** #1159\n- **Stage 1:** CLEAN\n- **Stage 2:** #1160\n\n### Current blocker\n\nNone\n`;

function makeEntryWorld({ controlNumber, control, controlState = "OPEN", issues, list = [] }) {
  const w = { control: { body: control, state: controlState }, issues, writes: 0, gateCalls: 0, listCalls: 0 };
  const lifecycle = () => (w.control.body.match(/^### State\n\n(.+)$/m) ?? w.control.body.match(/- \*\*Lifecycle:\*\* (.+)$/m))?.[1]?.trim();
  w.checkReadyDispatchImpl = async () => {
    w.gateCalls++;
    const lc = lifecycle();
    const exec = Number(w.control.body.match(/- \*\*Execution:\*\* #(\d+)/)?.[1]);
    if (lc === "READY") {
      return { exitCode: 0, state: "READY_TO_DISPATCH", controlIssue: controlNumber, executionIssue: exec, route: "implementation worker", actionEnvelope: getActionEnvelope("READY_TO_DISPATCH", {}) };
    }
    if (lc === "NEEDS_FOUNDER") {
      return { exitCode: 4, state: "BLOCKED", controlIssue: controlNumber, blockerReconciliationEligible: true, actionEnvelope: getActionEnvelope("BLOCKED", { blockerReconciliationEligible: true }) };
    }
    return { exitCode: 3, state: "NOT_READY", controlIssue: controlNumber, reasons: ["terminal"], actionEnvelope: getActionEnvelope("NOT_READY", {}) };
  };
  const readIssueImpl = ({ number }) => (number === controlNumber ? { ...w.control } : { ...w.issues[number] });
  const ghEditImpl = ({ body }) => {
    w.writes++;
    w.control = { ...w.control, body };
  };
  w.deps = {
    checkReadyDispatchImpl: w.checkReadyDispatchImpl,
    checkReconcileControlBlockerImpl: async () => ({ exitCode: 4, state: "AMBIGUOUS_BLOCKER" }),
    runNextReviewTransitionGateImpl: async () => {
      throw new Error("must not run");
    },
    resolveRepoIdentityImpl: stubResolveRepoIdentity,
    resolveEntryActivationImpl: ({ repo, controlIssue }) =>
      resolveEntryActivation({ repo, controlIssue }, { readIssueImpl, ghEditImpl, listOpenIssuesImpl: () => (w.listCalls++, list) }),
  };
  return w;
}

test("#1165 fixture A (#1164): ordinary entry on a stale ACTIVE-grant control reaches READY_TO_DISPATCH instead of BLOCKED/AMBIGUOUS_BLOCKER", async () => {
  const w = makeEntryWorld({ controlNumber: 1164, control: BODY_1164, issues: { 1163: { body: THICK_1163, state: "OPEN" } } });
  const result = await runSessionEntryGate({ repo: REPO, controlIssue: 1164 }, w.deps);
  assert.equal(result.ok, true);
  assert.equal(result.state, "READY_TO_DISPATCH");
  assert.equal(result.executionIssue, 1163);
  assert.equal(w.writes, 1);
  assert.deepEqual(result.provenance.map((p) => p.gate), ["ready-dispatch-gate", "activate-control-pair", "ready-dispatch-gate"]);
});

test("#1165 fixture B (#438): ordinary entry on an OPEN/DONE control with an authorized new packet reaches READY_TO_DISPATCH for it", async () => {
  const w = makeEntryWorld({ controlNumber: 438, control: BODY_438, issues: { 1151: { body: "old", state: "CLOSED" }, 1165: { body: NEW_PACKET, state: "OPEN" } }, list: [{ number: 1165, body: NEW_PACKET }] });
  const result = await runSessionEntryGate({ repo: REPO, controlIssue: 438 }, w.deps);
  assert.equal(result.state, "READY_TO_DISPATCH");
  assert.equal(result.executionIssue, 1165);
  assert.match(w.control.body, /Completed packet history .*Execution #1151; PR #1159/);
  assert.match(w.control.body, /- \*\*PR:\*\* none/);
});

test("#1165 negatives at ordinary entry: unauthorized child / unproven grant leave the original verdict with no write", async () => {
  const unauthorized = makeEntryWorld({ controlNumber: 438, control: BODY_438, issues: { 1151: { body: "old", state: "CLOSED" }, 1165: { body: "### Parent loop\n#438\n", state: "OPEN" } }, list: [{ number: 1165, body: "### Parent loop\n#438\n" }] });
  const r1 = await runSessionEntryGate({ repo: REPO, controlIssue: 438 }, unauthorized.deps);
  assert.equal(r1.state, "NOT_READY");
  assert.equal(r1.actionEnvelope.mode, "fallthrough");
  assert.equal(unauthorized.writes, 0);

  const revoked = makeEntryWorld({ controlNumber: 1164, control: BODY_1164, issues: { 1163: { body: THICK_1163.replace("### ACTIVE", "### REVOKED ACTIVE"), state: "OPEN" } } });
  const r2 = await runSessionEntryGate({ repo: REPO, controlIssue: 1164 }, revoked.deps);
  assert.equal(r2.state, "BLOCKED");
  assert.equal(r2.reconciliation.state, "AMBIGUOUS_BLOCKER");
  assert.equal(revoked.writes, 0);
});

test("#1165 idempotence: a second ordinary entry after activation writes nothing and dispatches the same packet", async () => {
  const w = makeEntryWorld({ controlNumber: 1164, control: BODY_1164, issues: { 1163: { body: THICK_1163, state: "OPEN" } } });
  await runSessionEntryGate({ repo: REPO, controlIssue: 1164 }, w.deps);
  const again = await runSessionEntryGate({ repo: REPO, controlIssue: 1164 }, w.deps);
  assert.equal(again.state, "READY_TO_DISPATCH");
  assert.equal(w.writes, 1);
});

test("#1165 an activation operational failure (readback/write) is an operational error, never a verdict", async () => {
  const w = makeEntryWorld({ controlNumber: 1164, control: BODY_1164, issues: { 1163: { body: THICK_1163, state: "OPEN" } } });
  const result = await runSessionEntryGate({ repo: REPO, controlIssue: 1164 }, { ...w.deps, resolveEntryActivationImpl: () => ({ exitCode: 1, state: "READBACK_MISMATCH", message: "readback mismatch" }) });
  assert.equal(result.ok, false);
  assert.match(result.message, /readback mismatch/);
});

test("#1165 post-PR chain verdicts never attempt activation", async () => {
  let attempts = 0;
  const result = await runSessionEntryGate(
    { repo: REPO, controlIssue: 5 },
    {
      checkReadyDispatchImpl: async () => ({ exitCode: 3, state: "NOT_READY", postPrLifecycle: "REVIEW", actionEnvelope: getActionEnvelope("NOT_READY", { postPrLifecycle: "REVIEW" }) }),
      runNextReviewTransitionGateImpl: async () => ({ exitCode: 5, state: "STAGE1_CORRECTION_REQUIRED", actionEnvelope: getActionEnvelope("STAGE1_CORRECTION_REQUIRED", { correctionReason: "x" }) }),
      resolveRepoIdentityImpl: stubResolveRepoIdentity,
      resolveEntryActivationImpl: () => {
        attempts++;
        return { exitCode: 0, state: "NO_CANDIDATE" };
      },
    },
  );
  assert.equal(result.state, "STAGE1_CORRECTION_REQUIRED");
  assert.equal(attempts, 0);
});
