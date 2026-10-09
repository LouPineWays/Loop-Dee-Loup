import { test } from "node:test";
import assert from "node:assert/strict";
import { runCorrectPlanIndexRoute, replaceRouteField, validateRouteCorrection } from "./correct-plan-index-route.mjs";

const PLAN_BODY = "## Execution Plan Index (v1)\n\n- **Plan state:** PLANNED\n- **Integration/PR route:** none\n- **Units:**\n  - 1-A\n";

function plan(route = "none") {
  return {
    planIndex: { commentId: 100, integrationRoute: route },
    units: { "1-A": { state: "PLANNED", prerequisitesDependencies: "No dependencies." } },
  };
}

function harness({ route = "none", body = PLAN_BODY, mutateOnSecondGet = null } = {}) {
  const state = { body, patched: null, gets: 0 };
  return {
    state,
    impls: {
      resolveRepoIdentityImpl: () => ({ ok: true, repo: "o/r" }),
      parseExecutionPlanImpl: async () => ({ exitCode: 0, plan: plan(route) }),
      getCommentImpl: async () => {
        state.gets += 1;
        if (mutateOnSecondGet && state.gets === 2) state.body = mutateOnSecondGet;
        return { body: state.body };
      },
      patchCommentImpl: async ({ body }) => {
        state.patched = body;
        state.body = body;
      },
    },
  };
}

test("replaceRouteField replaces only the route bullet and keeps every other line byte-identical", () => {
  const r = replaceRouteField(PLAN_BODY, "integration worker");
  assert.equal(r.ok, true);
  assert.equal(r.body, PLAN_BODY.replace("route:** none", "route:** integration worker"));
});

test("validateRouteCorrection rejects bare none, malformed prose, and unit-owned without a compliant owner", () => {
  assert.equal(validateRouteCorrection(plan(), "none").length, 1);
  assert.equal(validateRouteCorrection(plan(), "integration worker - disabled").length, 1);
  assert.equal(validateRouteCorrection(plan(), "unit-owned: 1-A").length > 0, true);
  assert.deepEqual(validateRouteCorrection(plan(), "integration worker"), []);
  assert.deepEqual(validateRouteCorrection(plan(), "no-pr: docs only"), []);
});

test("runCorrectPlanIndexRoute persists and read-back-verifies a valid route", async () => {
  const h = harness();
  const result = await runCorrectPlanIndexRoute({ executionIssue: 1, route: "integration worker" }, h.impls);
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "ROUTE_CORRECTION_VERIFIED");
  assert.match(h.state.patched, /Integration\/PR route:\*\* integration worker/);
});

test("runCorrectPlanIndexRoute writes nothing for an invalid route", async () => {
  const h = harness();
  const result = await runCorrectPlanIndexRoute({ executionIssue: 1, route: "none" }, h.impls);
  assert.equal(result.exitCode, 1);
  assert.equal(h.state.patched, null);
});

test("runCorrectPlanIndexRoute fails closed (exit 3) when the comment changes concurrently before commit", async () => {
  const h = harness({ mutateOnSecondGet: PLAN_BODY + "\nextra\n" });
  const result = await runCorrectPlanIndexRoute({ executionIssue: 1, route: "integration worker" }, h.impls);
  assert.equal(result.exitCode, 3);
  assert.equal(h.state.patched, null);
});
