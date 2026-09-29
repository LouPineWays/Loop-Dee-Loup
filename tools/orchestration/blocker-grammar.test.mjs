// Tests for tools/orchestration/blocker-grammar.mjs — issue #437 (unit 437-B)'s canonical
// Blocker-prerequisite-declaration grammar, mirroring dependency-grammar.test.mjs's own
// coverage shape.
//
// Run with:
//   node --test tools/orchestration/blocker-grammar.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  extractBlockedByIssueNumbers,
  hasUnrecognizedBlockerWording,
  formatBlockedBy,
  evaluateBlockerAuthoring,
} from "./blocker-grammar.mjs";

// Fixture classifiers mirroring ready-dispatch-gate.mjs's own recognized vocabulary, injected
// rather than imported so blocker-grammar.mjs itself stays free of any tools/orchestration
// dependency.
const isNoneSentinel = (value) => /^none\b/i.test(String(value ?? "").trim());
const isKnownLifecycleValue = (value) =>
  ["READY", "READY_FOR_PLAN", "EXECUTING", "REVIEW", "AUDIT", "CORRECTION", "BLOCKED", "BLOCKED_FAILURE"].includes(String(value).toUpperCase());
const isRouteCompatibleWithLifecycle = (lifecycle, route) =>
  String(lifecycle).toUpperCase() !== "READY_FOR_PLAN" || String(route).trim().toLowerCase() === "planning worker";
const classifiers = { isNoneSentinel, isKnownLifecycleValue, isRouteCompatibleWithLifecycle };

// -- extractBlockedByIssueNumbers -----------------------------------------------------------

test("extractBlockedByIssueNumbers: a single-prerequisite clause", () => {
  assert.deepEqual(extractBlockedByIssueNumbers("Blocked by #407."), [407]);
});

test("extractBlockedByIssueNumbers: a multi-prerequisite clause preserves order", () => {
  assert.deepEqual(extractBlockedByIssueNumbers("Blocked by #407, #408, #436."), [407, 408, 436]);
});

test("extractBlockedByIssueNumbers: case-insensitive on 'blocked by'", () => {
  assert.deepEqual(extractBlockedByIssueNumbers("blocked by #407, #408."), [407, 408]);
});

test("extractBlockedByIssueNumbers: stops at the first following period, ignoring trailing prose", () => {
  assert.deepEqual(extractBlockedByIssueNumbers("Blocked by #407, #408. Historically also referenced #999."), [407, 408]);
});

test("extractBlockedByIssueNumbers: the 'none' sentinel has no clause and returns []", () => {
  assert.deepEqual(extractBlockedByIssueNumbers("none"), []);
  assert.deepEqual(extractBlockedByIssueNumbers("none — #407, #408, #436 closed"), []);
});

test("extractBlockedByIssueNumbers: real historical #440 free-prose shape (no recognized clause) returns []", () => {
  const body = "#407/#408 must first terminalize their already-CLEAN #436 cycle so the new follow-up defect does not contaminate PR #435's audited result.";
  assert.deepEqual(extractBlockedByIssueNumbers(body), []);
});

test("extractBlockedByIssueNumbers: absent/empty field returns []", () => {
  assert.deepEqual(extractBlockedByIssueNumbers(null), []);
  assert.deepEqual(extractBlockedByIssueNumbers(undefined), []);
  assert.deepEqual(extractBlockedByIssueNumbers(""), []);
});

test("extractBlockedByIssueNumbers: a wrapped multi-line field still matches as one clause (dotall)", () => {
  const body = "Blocked by #407,\n#408,\n#436.";
  assert.deepEqual(extractBlockedByIssueNumbers(body), [407, 408, 436]);
});

// -- hasUnrecognizedBlockerWording -----------------------------------------------------------

test("hasUnrecognizedBlockerWording: a fully recognized clause is not unrecognized", () => {
  assert.equal(hasUnrecognizedBlockerWording("Blocked by #407, #408."), false);
});

test("hasUnrecognizedBlockerWording: the 'none' sentinel is not unrecognized", () => {
  assert.equal(hasUnrecognizedBlockerWording("none"), false);
});

test("hasUnrecognizedBlockerWording: an empty/absent field is not unrecognized", () => {
  assert.equal(hasUnrecognizedBlockerWording(""), false);
  assert.equal(hasUnrecognizedBlockerWording(null), false);
});

test("hasUnrecognizedBlockerWording: real historical #440 free-prose shape (no recognized clause at all) is unrecognized", () => {
  const body = "#407/#408 must first terminalize their already-CLEAN #436 cycle so the new follow-up defect does not contaminate PR #435's audited result.";
  assert.equal(hasUnrecognizedBlockerWording(body), true);
});

test("hasUnrecognizedBlockerWording: an issue-shaped token outside the recognized clause is unrecognized even when a valid clause is also present", () => {
  assert.equal(hasUnrecognizedBlockerWording("Blocked by #407. Also see #999 for background."), true);
});

test("hasUnrecognizedBlockerWording: free-text founder-decision-shaped prose with no '#N' token at all is not unrecognized", () => {
  assert.equal(hasUnrecognizedBlockerWording("Waiting on founder input to decide the pricing model."), false);
});

// -- formatBlockedBy --------------------------------------------------------------------------

test("formatBlockedBy: a single issue number", () => {
  assert.equal(formatBlockedBy([407]), "Blocked by #407.");
});

test("formatBlockedBy: multiple issue numbers preserve order", () => {
  assert.equal(formatBlockedBy([407, 408, 436]), "Blocked by #407, #408, #436.");
});

test("formatBlockedBy: an empty or absent array canonicalizes to the 'none.' sentinel", () => {
  assert.equal(formatBlockedBy([]), "none.");
  assert.equal(formatBlockedBy(undefined), "none.");
  assert.equal(formatBlockedBy(null), "none.");
});

test("formatBlockedBy round-trips through extractBlockedByIssueNumbers unchanged", () => {
  const numbers = [407, 408, 436];
  assert.deepEqual(extractBlockedByIssueNumbers(formatBlockedBy(numbers)), numbers);
});

test("formatBlockedBy output is never flagged by hasUnrecognizedBlockerWording", () => {
  assert.equal(hasUnrecognizedBlockerWording(formatBlockedBy([407, 408, 436])), false);
  assert.equal(hasUnrecognizedBlockerWording(formatBlockedBy([])), false);
});

// -- evaluateBlockerAuthoring -- issue #768's write/read shared classification --------------

test("evaluateBlockerAuthoring: absent field is NONE", () => {
  assert.deepEqual(evaluateBlockerAuthoring({ blockerRaw: null, blockedLifecycleRaw: null, blockedRouteRaw: null }, classifiers), { kind: "NONE" });
});

test("evaluateBlockerAuthoring: the 'none' sentinel is NONE", () => {
  assert.deepEqual(evaluateBlockerAuthoring({ blockerRaw: "none", blockedLifecycleRaw: null, blockedRouteRaw: null }, classifiers), { kind: "NONE" });
});

test("evaluateBlockerAuthoring: genuine free-form/manual/external blocker prose naming no issue number is FREE_FORM, not rejected", () => {
  const result = evaluateBlockerAuthoring(
    { blockerRaw: "Waiting on founder input to decide the pricing model.", blockedLifecycleRaw: null, blockedRouteRaw: null },
    classifiers,
  );
  assert.deepEqual(result, { kind: "FREE_FORM" });
});

test("evaluateBlockerAuthoring: real historical #440 free-prose shape (issue numbers with no recognized clause) is UNRECOGNIZED_WORDING", () => {
  const body = "#407/#408 must first terminalize their already-CLEAN #436 cycle so the new follow-up defect does not contaminate PR #435's audited result.";
  const result = evaluateBlockerAuthoring({ blockerRaw: body, blockedLifecycleRaw: null, blockedRouteRaw: null }, classifiers);
  assert.equal(result.kind, "UNRECOGNIZED_WORDING");
  assert.match(result.reason, /outside the recognized/);
});

test("evaluateBlockerAuthoring: real live #726 recurrence shape (issue reference with no 'blocked by' clause at all) is UNRECOGNIZED_WORDING", () => {
  const body = "#764 under governing control #577 — findings-bearing correction completion can still escape without verified durable correction-satisfied state.";
  const result = evaluateBlockerAuthoring({ blockerRaw: body, blockedLifecycleRaw: null, blockedRouteRaw: null }, classifiers);
  assert.equal(result.kind, "UNRECOGNIZED_WORDING");
});

test("evaluateBlockerAuthoring: a recognized clause with an additional issue reference outside it is UNRECOGNIZED_WORDING", () => {
  const result = evaluateBlockerAuthoring(
    { blockerRaw: "Blocked by #407. Also see #999 for background.", blockedLifecycleRaw: "REVIEW", blockedRouteRaw: "unchanged" },
    classifiers,
  );
  assert.equal(result.kind, "UNRECOGNIZED_WORDING");
});

test("evaluateBlockerAuthoring: a recognized clause with missing 'Blocked lifecycle'/'Blocked route' is MISSING_RESUME_STATE", () => {
  const result = evaluateBlockerAuthoring({ blockerRaw: "Blocked by #764.", blockedLifecycleRaw: null, blockedRouteRaw: null }, classifiers);
  assert.equal(result.kind, "MISSING_RESUME_STATE");
  assert.deepEqual(result.blockedByIssues, [764]);
});

test("evaluateBlockerAuthoring: a recognized clause with an empty (whitespace-only) 'Blocked route' is MISSING_RESUME_STATE", () => {
  const result = evaluateBlockerAuthoring({ blockerRaw: "Blocked by #764.", blockedLifecycleRaw: "REVIEW", blockedRouteRaw: "   " }, classifiers);
  assert.equal(result.kind, "MISSING_RESUME_STATE");
});

test("evaluateBlockerAuthoring: an unrecognized saved 'Blocked lifecycle' value is INVALID_RESUME_STATE", () => {
  const result = evaluateBlockerAuthoring({ blockerRaw: "Blocked by #764.", blockedLifecycleRaw: "READY_FOR_PALN", blockedRouteRaw: "unchanged" }, classifiers);
  assert.equal(result.kind, "INVALID_RESUME_STATE");
  assert.match(result.reason, /not a recognized Lifecycle value/);
});

test("evaluateBlockerAuthoring: a saved 'Blocked route' incompatible with 'Blocked lifecycle' is INVALID_RESUME_STATE", () => {
  const result = evaluateBlockerAuthoring({ blockerRaw: "Blocked by #764.", blockedLifecycleRaw: "READY_FOR_PLAN", blockedRouteRaw: "not planning worker" }, classifiers);
  assert.equal(result.kind, "INVALID_RESUME_STATE");
});

test("evaluateBlockerAuthoring: a single well-formed prerequisite with valid saved resume state is RECONCILABLE", () => {
  const result = evaluateBlockerAuthoring({ blockerRaw: "Blocked by #764.", blockedLifecycleRaw: "REVIEW", blockedRouteRaw: "unchanged" }, classifiers);
  assert.deepEqual(result, { kind: "RECONCILABLE", blockedByIssues: [764], blockedLifecycle: "REVIEW", blockedRoute: "unchanged" });
});

test("evaluateBlockerAuthoring: multiple well-formed prerequisites with valid saved resume state are RECONCILABLE", () => {
  const result = evaluateBlockerAuthoring({ blockerRaw: "Blocked by #407, #408, #436.", blockedLifecycleRaw: "REVIEW", blockedRouteRaw: "unchanged" }, classifiers);
  assert.deepEqual(result, { kind: "RECONCILABLE", blockedByIssues: [407, 408, 436], blockedLifecycle: "REVIEW", blockedRoute: "unchanged" });
});

test("evaluateBlockerAuthoring: the literal 'unchanged' Blocked route sentinel is exempt from compatibility checking", () => {
  const result = evaluateBlockerAuthoring({ blockerRaw: "Blocked by #764.", blockedLifecycleRaw: "READY_FOR_PLAN", blockedRouteRaw: "unchanged" }, classifiers);
  assert.equal(result.kind, "RECONCILABLE");
});
