// Tests for tools/orchestration/blocker-grammar.mjs — issue #437 (unit 437-B)'s canonical
// Blocker-prerequisite-declaration grammar, mirroring dependency-grammar.test.mjs's own
// coverage shape.
//
// Run with:
//   node --test tools/orchestration/blocker-grammar.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { extractBlockedByIssueNumbers, hasUnrecognizedBlockerWording, formatBlockedBy } from "./blocker-grammar.mjs";

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
