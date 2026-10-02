// node --test tools/orchestration/route-qualification.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { selectRoute, loadRouteEvidence } from "./route-qualification.mjs";

const ev = (route, cost, over = {}) => ({
  route, outcomeClass: "impl", verifiedClean: true, reworkRate: 0.1, founderInterventions: 0,
  relativeCost: cost, requiresLocalInference: false, ...over,
});

test("picks the cheapest qualified route", () => {
  const r = selectRoute({ outcomeClass: "impl", assurance: {}, candidates: ["a", "b"], evidence: [ev("a", 5), ev("b", 2)], availability: {} });
  assert.equal(r.route, "b");
});

test("cheaper but unqualified route is never chosen", () => {
  const r = selectRoute({ outcomeClass: "impl", assurance: { maxReworkRate: 0.2 }, candidates: ["cheap", "ok"],
    evidence: [ev("cheap", 1, { verifiedClean: false }), ev("ok", 4)], availability: {} });
  assert.equal(r.route, "ok");
  const r2 = selectRoute({ outcomeClass: "impl", assurance: { maxReworkRate: 0.2 }, candidates: ["cheap", "ok"],
    evidence: [ev("cheap", 1, { reworkRate: 0.9 }), ev("ok", 4)], availability: {} });
  assert.equal(r2.route, "ok");
});

test("check 8: unavailable preferred route falls to another qualified route", () => {
  const r = selectRoute({ outcomeClass: "impl", assurance: { maxReworkRate: 0.2 }, candidates: ["pref", "alt"],
    evidence: [ev("pref", 1), ev("alt", 3)], availability: { pref: false } });
  assert.equal(r.route, "alt");
  assert.notEqual(r.failClosed, true);
});

test("local inference absent is a non-failure", () => {
  const evidence = [ev("local", 1, { requiresLocalInference: true }), ev("hosted", 3)];
  const absent = selectRoute({ outcomeClass: "impl", assurance: {}, candidates: ["local", "hosted"], evidence, availability: { localInference: false } });
  assert.equal(absent.route, "hosted");
  const present = selectRoute({ outcomeClass: "impl", assurance: {}, candidates: ["local", "hosted"], evidence, availability: { localInference: true } });
  assert.equal(present.route, "local");
});

test("check 9: no qualified route fails closed explicitly", () => {
  const r = selectRoute({ outcomeClass: "impl", assurance: {}, candidates: ["a"], evidence: [ev("a", 1, { verifiedClean: false })], availability: {} });
  assert.deepEqual({ route: r.route, failClosed: r.failClosed }, { route: null, failClosed: true });
  assert.match(r.reason, /no qualified/);
});

test("fails closed on missing, ambiguous, or unmatched input", () => {
  assert.equal(selectRoute({}).failClosed, true);
  assert.equal(selectRoute({ outcomeClass: "impl", candidates: ["a"], evidence: [ev("a", 1), ev("a", 2)] }).failClosed, true);
  assert.equal(selectRoute({ outcomeClass: "other", candidates: ["a"], evidence: [ev("a", 1)] }).failClosed, true);
  assert.equal(selectRoute({ outcomeClass: "impl", candidates: ["a"], evidence: [ev("a", 1)], assurance: { maxFounderInterventions: 0 } }).route, "a");
});

test("committed evidence: no copilot route; unqualified local is not chosen", () => {
  const evidence = loadRouteEvidence();
  assert.ok(!JSON.stringify(evidence).toLowerCase().includes("copilot"));
  const r = selectRoute({ outcomeClass: "bounded-implementation", assurance: {}, candidates: ["local-inference", "claude-subagent"], evidence, availability: { localInference: true } });
  assert.equal(r.route, "claude-subagent");
});
