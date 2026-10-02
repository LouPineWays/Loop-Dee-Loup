import test from "node:test";
import assert from "node:assert/strict";
import { parseAttemptClaims, renderClaimBody, classifyAttempt, planClaim, formatAttemptId } from "./attempt-claim.mjs";

const claim = (attemptId, o = {}) => ({ id: 1, authorPermission: "write", body: renderClaimBody({ attemptId, nonce: o.nonce ?? "n1", claimedAt: "t", runner: "ubuntu", phase: o.phase }) });

test("classify: none, live, orphaned, ambiguous", () => {
  assert.equal(classifyAttempt([]), "NO_CLAIM");
  const claims = parseAttemptClaims([claim("1-1")]);
  assert.equal(classifyAttempt(claims, { "1-1": { status: "in_progress" } }), "LIVE");
  assert.equal(classifyAttempt(claims, { "1-1": { status: "completed", conclusion: "cancelled" } }), "ORPHANED");
  assert.equal(classifyAttempt(claims, {}), "AMBIGUOUS");
  assert.equal(classifyAttempt(claims, { "1-1": { status: "weird" } }), "AMBIGUOUS");
});

test("settled claims do not block; claim text never decides liveness", () => {
  assert.equal(classifyAttempt(parseAttemptClaims([claim("1-1", { phase: "DONE" })]), {}), "NO_CLAIM");
  assert.equal(parseAttemptClaims([{ ...claim("1-1"), authorPermission: "read" }]).length, 0);
});

test("planClaim: duplicate event yields one claim; replay, live and ambiguous block", () => {
  const id = formatAttemptId(5, 1);
  assert.equal(planClaim([], {}, { attemptId: id, nonce: "n1" }).action, "CLAIM");
  const claims = parseAttemptClaims([claim(id)]);
  assert.equal(planClaim(claims, { [id]: { status: "queued" } }, { attemptId: id, nonce: "n1" }).action, "ALREADY_CLAIMED");
  assert.equal(planClaim(claims, { [id]: { status: "in_progress" } }, { attemptId: "6-1", nonce: "n1" }).action, "BLOCK");
  assert.equal(planClaim(claims, {}, { attemptId: "6-1", nonce: "n1" }).action, "BLOCK");
  assert.equal(planClaim(claims, { [id]: { status: "completed" } }, { attemptId: "6-1", nonce: "n1" }).action, "RECONCILE_THEN_CLAIM");
  const settled = parseAttemptClaims([claim(id, { phase: "DONE" })]);
  assert.equal(planClaim(settled, {}, { attemptId: "7-1", nonce: "n1" }).action, "REPLAY");
});
