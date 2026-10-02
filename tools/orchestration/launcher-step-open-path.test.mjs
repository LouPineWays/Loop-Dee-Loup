// Unit 73-C: open path and Chat guidance boundary, integrated through runLauncherStep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runLauncherStep, Outcome } from "./launcher-step.mjs";

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
