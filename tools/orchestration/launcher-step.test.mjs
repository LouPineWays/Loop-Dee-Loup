import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runLauncherStep,
  classifyExternalEffect,
  verifyPostcondition,
  TRANSITIONS,
  Outcome,
  EffectClass,
} from "./launcher-step.mjs";

const ev = (o = {}) => ({ expectedTarget: "PR#5", target: "PR#5", readBackOk: true, effect: "absent", projected: false, ...o });
const done = () => ev({ effect: "present", projected: true });

function harness(state, reads, { execThrows = false } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    deps: {
      runGate: async () => ({ state }),
      readEffect: async () => reads[Math.min(i++, reads.length - 1)],
      execute: async () => {
        calls.push("execute");
        if (execThrows) throw new Error("boom");
      },
      finalize: async () => calls.push("finalize"),
    },
  };
}

test("classifyExternalEffect: not completed / completed-unprojected / ambiguous", () => {
  assert.equal(classifyExternalEffect(ev()), EffectClass.NOT_COMPLETED);
  assert.equal(classifyExternalEffect(ev({ effect: "present" })), EffectClass.COMPLETED_UNPROJECTED);
  assert.equal(classifyExternalEffect(ev({ effect: "unknown" })), EffectClass.AMBIGUOUS);
  assert.equal(classifyExternalEffect(ev({ target: "PR#6" })), EffectClass.AMBIGUOUS);
  assert.equal(classifyExternalEffect(ev({ readBackOk: false })), EffectClass.AMBIGUOUS);
  assert.equal(classifyExternalEffect(ev({ effect: "absent", projected: true })), EffectClass.AMBIGUOUS);
  assert.equal(classifyExternalEffect(null), EffectClass.AMBIGUOUS);
  assert.equal(classifyExternalEffect({}), EffectClass.AMBIGUOUS);
});

test("closed-path transition completes with no reasoning worker", async () => {
  const h = harness("STAGE2_CLOSE_READY", [ev(), done()]);
  const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  assert.equal(r.outcome, Outcome.ADVANCED);
  assert.equal(r.successorEligible, true);
  assert.deepEqual(h.calls, ["execute"]);
});

test("every mechanical transition case advances via injected evidence", async () => {
  for (const state of Object.keys(TRANSITIONS)) {
    const h = harness(state, [ev(), done()]);
    const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
    assert.equal(r.outcome, Outcome.ADVANCED, state);
    assert.ok(TRANSITIONS[state].verifier && TRANSITIONS[state].invalidation.length, state);
  }
});

test("self-report without provable postcondition does not unlock successor", async () => {
  const h = harness("STAGE2_TRIGGER_REQUIRED", [ev(), ev()]);
  const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  assert.equal(r.outcome, Outcome.FAIL_CLOSED);
  assert.equal(r.successorEligible, false);
});

test("completed-unprojected finalizes without replay", async () => {
  const h = harness("READY_TO_PROJECT_ROUTED", [ev({ effect: "present", projected: false }), done()]);
  const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  assert.equal(r.outcome, Outcome.ADVANCED);
  assert.deepEqual(h.calls, ["finalize"]);
});

test("ambiguous effect fails closed with no action", async () => {
  const h = harness("STAGE2_CLOSE_READY", [ev({ effect: "unknown" })]);
  const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  assert.equal(r.outcome, Outcome.FAIL_CLOSED);
  assert.deepEqual(h.calls, []);
});

test("definitely-unperformed effect retries (execute runs)", async () => {
  const h = harness("STAGE2_REPORT_READY_TO_RECORD", [ev(), done()]);
  const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  assert.equal(r.evidence.replayed, true);
  assert.deepEqual(h.calls, ["execute"]);
});

test("already-satisfied postcondition is not replayed", async () => {
  const h = harness("STAGE2_CLOSE_READY", [done()]);
  const r = await runLauncherStep({ controlIssue: 1, deps: h.deps });
  assert.equal(r.outcome, Outcome.ADVANCED);
  assert.deepEqual(h.calls, []);
});

test("stale, wrong-target, malformed evidence cannot unlock", () => {
  assert.equal(verifyPostcondition(ev({ effect: "present", projected: true, target: "PR#4" })), false);
  assert.equal(verifyPostcondition(ev({ effect: "present", projected: true, readBackOk: undefined })), false);
  assert.equal(verifyPostcondition({ effect: "present", projected: true }), false);
  assert.equal(verifyPostcondition(undefined), false);
  assert.equal(verifyPostcondition(done()), true);
});

test("execute throwing fails closed; waiting/open-path/unknown verdicts map correctly", async () => {
  const h = harness("STAGE2_CLOSE_READY", [ev()], { execThrows: true });
  assert.equal((await runLauncherStep({ controlIssue: 1, deps: h.deps })).outcome, Outcome.FAIL_CLOSED);
  const mk = (state) => ({ runGate: async () => ({ state }) });
  assert.equal((await runLauncherStep({ controlIssue: 1, deps: mk("NO_ACTION_YET") })).outcome, Outcome.WAITING);
  assert.equal((await runLauncherStep({ controlIssue: 1, deps: mk("STAGE1_CORRECTION_REQUIRED") })).outcome, Outcome.OPEN_PATH_REQUIRED);
  assert.equal((await runLauncherStep({ controlIssue: 1, deps: mk("WEIRD") })).outcome, Outcome.FAIL_CLOSED);
  assert.equal((await runLauncherStep({ controlIssue: 1, deps: mk("BLOCKED") })).successorEligible, false);
});
