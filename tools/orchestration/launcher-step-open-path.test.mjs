// Unit 73-C: open path and Chat guidance boundary, integrated through runLauncherStep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runLauncherStep, Outcome, authorizeLauncherVerdict } from "./launcher-step.mjs";

const ev = (o = {}) => ({ expectedTarget: "T", target: "T", readBackOk: true, effect: "absent", projected: false, ...o });
const done = () => ev({ effect: "present", projected: true });
const routeEvidence = [
  { route: "worker-a", outcomeClass: "correction", verifiedClean: true, reworkRate: 0, founderInterventions: 0, relativeCost: 1, requiresLocalInference: false },
];
const routeInput = { outcomeClass: "correction", assurance: {}, candidates: ["worker-a"], evidence: routeEvidence, availability: {} };
const guidanceComment = (kind, ref, evid) => ({
  id: 11,
  authorPermission: "write",
  body: `## Chat Guidance (v1)\n\n- **Target kind:** ${kind}\n- **Target ref:** #${ref}\n- **Target evidence id:** ${evid}\n- **Guidance:** handle the edge case`,
});

function openHarness(verdict, openPath) {
  const calls = [];
  return {
    calls,
    deps: {
      runGate: async () => verdict,
      authorizeVerdict: async () => ({ authorized: true }),
      readEffect: async () => {
        calls.push("readEffect");
        return calls.filter((c) => c === "readEffect").length === 1 ? ev() : done();
      },
      execute: async () => calls.push("execute"),
      finalize: async () => calls.push("finalize"),
      readOpenPath: async () => (calls.push("readOpenPath"), openPath),
    },
  };
}

test("Stage 1 findings without guidance stop with fixed handoff and no dispatch", async () => {
  const h = openHarness({ state: "STAGE1_CORRECTION_REQUIRED", pr: 7, head: "h1" }, { comments: [], routeInput });
  const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  assert.equal(r.outcome, Outcome.WAITING);
  assert.equal(r.successorEligible, false);
  assert.equal(r.evidence.handoff, "Chat guidance required on PR #7");
  assert.equal(r.evidence.dispatch, undefined);
});

test("Stage 2 NOT CLEAN without guidance stops with fixed handoff", async () => {
  const h = openHarness({ state: "STAGE2_CORRECTION_REQUIRED", auditIssue: 9 }, { comments: [], reportCommentId: 55, routeInput });
  const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  assert.equal(r.outcome, Outcome.WAITING);
  assert.equal(r.evidence.handoff, "Chat guidance required on Stage 2 Audit #9");
});

test("matching guidance dispatches a fresh correction worker by reference", async () => {
  const h = openHarness(
    { state: "STAGE1_CORRECTION_REQUIRED", pr: 7, head: "h1" },
    { comments: [guidanceComment("stage1", 7, "h1")], routeInput },
  );
  const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  assert.equal(r.outcome, Outcome.OPEN_PATH_REQUIRED);
  assert.equal(r.evidence.dispatch.role, "correction worker");
  assert.equal(r.evidence.dispatch.route, "worker-a");
  assert.equal(r.evidence.dispatch.freshWorker, true);
  assert.equal(r.evidence.dispatch.supervisorAuthors, false);
  assert.equal(r.evidence.dispatch.byReference.guidance.commentId, 11);
  assert.deepEqual(h.calls, ["readOpenPath"]);
});

test("changed head or changed report invalidates earlier guidance", async () => {
  let h = openHarness({ state: "STAGE1_CORRECTION_REQUIRED", pr: 7, head: "h2" }, { comments: [guidanceComment("stage1", 7, "h1")], routeInput });
  let r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  assert.equal(r.outcome, Outcome.WAITING);
  assert.equal(r.evidence.guidanceStatus, "STALE");
  h = openHarness(
    { state: "STAGE2_CORRECTION_REQUIRED", auditIssue: 9 },
    { comments: [guidanceComment("stage2", 9, "55")], reportCommentId: 56, routeInput },
  );
  r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  assert.equal(r.evidence.guidanceStatus, "STALE");
});

test("no qualified route fails closed even with valid guidance", async () => {
  const h = openHarness(
    { state: "STAGE2_CORRECTION_REQUIRED", auditIssue: 9 },
    { comments: [guidanceComment("stage2", 9, "55")], reportCommentId: 55, routeInput: { ...routeInput, evidence: [] } },
  );
  const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  assert.equal(r.outcome, Outcome.FAIL_CLOSED);
});

test("Stage 2 CLEAN close path never requests Chat", async () => {
  const h = openHarness({ state: "STAGE2_CLOSE_READY" }, { comments: [], routeInput });
  const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  assert.equal(r.outcome, Outcome.ADVANCED);
  assert.ok(!h.calls.includes("readOpenPath"));
  assert.equal(r.evidence.handoff, undefined);
});

test("Stage 1 no-findings satisfied verdict is not an open path and never requests Chat", async () => {
  const h = openHarness({ state: "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2" }, { comments: [], routeInput });
  const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  assert.notEqual(r.evidence.chatGuidanceRequired, true);
  assert.ok(!h.calls.includes("readOpenPath"));
});

test("non-correction semantic stage dispatches by reference without Chat", async () => {
  const h = openHarness({ state: "READY_TO_DISPATCH" }, { comments: [], routeInput });
  const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  assert.equal(r.outcome, Outcome.OPEN_PATH_REQUIRED);
  assert.equal(r.evidence.dispatch.role, "implementation worker");
});

test("open-path dispatch preserves the by-reference targets and provenance from the verdict", async () => {
  const verdict = { state: "READY_TO_DISPATCH", repo: "o/r", controlIssue: 1, executionIssue: 73, route: "impl", actionEnvelope: { mode: "bounded" }, junk: "x".repeat(50) };
  const h = openHarness(verdict, { comments: [], routeInput: { ...routeInput, outcomeClass: "correction" } });
  const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  const ref = r.evidence.dispatch.byReference;
  assert.equal(ref.controlIssue, 1);
  assert.equal(ref.executionIssue, 73);
  assert.equal(ref.route, "impl");
  assert.equal(ref.repo, "o/r");
  assert.equal(ref.junk, undefined);
  const units = openHarness({ state: "READY_TO_DISPATCH_UNITS", executionIssue: 73, dispatchReadyUnitIds: ["U1"], manifestUrl: "m" }, { comments: [], routeInput });
  const u = await runLauncherStep({ controlIssue: 1, deps: units.deps });
  assert.deepEqual(u.evidence.dispatch.byReference.dispatchReadyUnitIds, ["U1"]);
  const corr = openHarness({ state: "STAGE1_CORRECTION_REQUIRED", pr: 7, head: "h1", correctionReason: "findings" }, { comments: [guidanceComment("stage1", 7, "h1")], routeInput });
  const c = await runLauncherStep({ controlIssue: 1, deps: corr.deps });
  assert.equal(c.evidence.dispatch.byReference.pr, 7);
  assert.equal(c.evidence.dispatch.byReference.head, "h1");
});

test("clean Stage 1 satisfied verdicts (both siblings) follow the merge path, not FAIL_CLOSED", async () => {
  for (const state of ["STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2"]) {
    const h = openHarness({ state, pr: 7, head: "h1" }, { comments: [], routeInput });
    const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
    assert.equal(r.outcome, Outcome.ADVANCED, state);
    assert.deepEqual(h.calls, ["readEffect", "execute", "readEffect"], state);
  }
  // merge-conflict sibling is deliberately NOT a launcher transition
  const c = openHarness({ state: "STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT" }, { comments: [], routeInput });
  assert.equal((await runLauncherStep({ controlIssue: 1, deps: c.deps })).outcome, Outcome.FAIL_CLOSED);
});

test("no authority check, or a denied one, fails closed before any read, dispatch, or mutation", async () => {
  const h = openHarness({ state: "STAGE2_CLOSE_READY" }, { comments: [], routeInput });
  delete h.deps.authorizeVerdict;
  assert.equal((await runLauncherStep({ controlIssue: 1, deps: h.deps })).outcome, Outcome.FAIL_CLOSED);
  const d = openHarness({ state: "READY_TO_DISPATCH" }, { comments: [], routeInput });
  d.deps.authorizeVerdict = async () => ({ authorized: false, reason: "comment only" });
  const r = await runLauncherStep({ controlIssue: 1, deps: d.deps });
  assert.equal(r.outcome, Outcome.FAIL_CLOSED);
  assert.deepEqual(d.calls, []);
});

test("authorizeLauncherVerdict: authority is the verdict envelope, never the comment", () => {
  const auth = { controlIssue: 379, executionIssue: 73 };
  assert.equal(authorizeLauncherVerdict({ state: "READY_TO_DISPATCH", controlIssue: 379, executionIssue: 73, route: "impl" }, auth).authorized, true);
  // no route -> not a valid control-plane envelope, even though a launch comment exists
  assert.equal(authorizeLauncherVerdict({ state: "READY_TO_DISPATCH", controlIssue: 379, executionIssue: 73 }, auth).authorized, false);
  assert.equal(authorizeLauncherVerdict({ state: "READY_TO_DISPATCH", controlIssue: 379, executionIssue: 74, route: "impl" }, auth).authorized, false);
  assert.equal(authorizeLauncherVerdict({ state: "READY_TO_DISPATCH", controlIssue: 5, executionIssue: 73, route: "impl" }, auth).authorized, false);
  assert.equal(authorizeLauncherVerdict({ state: "STAGE2_CLOSE_READY", controlIssue: 379, auditIssue: 9 }, auth).authorized, true);
  assert.equal(authorizeLauncherVerdict({ state: "WEIRD" }, auth).authorized, false);
  assert.equal(authorizeLauncherVerdict({ state: "STAGE1_CORRECTION_REQUIRED", controlIssue: 379, pr: 7 }, auth).authorized, true);
  assert.equal(authorizeLauncherVerdict({ state: "STAGE1_CORRECTION_REQUIRED", controlIssue: 379 }, auth).authorized, false);
  assert.equal(authorizeLauncherVerdict({ state: "READY_TO_DISPATCH", controlIssue: 379, executionIssue: 73, route: "r" }, undefined).authorized, false);
});
