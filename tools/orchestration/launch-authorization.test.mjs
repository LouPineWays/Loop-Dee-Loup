import test from "node:test";
import assert from "node:assert/strict";
import { TRANSITIONS, OPEN_PATH_STATES } from "./launcher-step.mjs";
import { parseLaunchAuthorization, verifyTrustedTrigger } from "./launch-authorization.mjs";

const body = (extra = {}) => [
  "## Launch Authorization (v1)", "",
  `- **Control issue:** #${extra.control ?? 10}`,
  "- **Execution issue:** #73",
  "- **Authorized objective:** ship it",
  "- **Authorized by:** founder",
  `- **Nonce:** ${extra.nonce ?? "nonce-12345"}`,
].join("\n");
const ok = { id: 1, body: body(), authorPermission: "admin" };

test("single authorization parses; duplicate identical comment stays single", () => {
  const r = parseLaunchAuthorization([ok, { ...ok, id: 2 }], { controlIssue: 10 });
  assert.equal(r.status, "LAUNCH_REQUESTED");
  assert.equal(r.authorization.executionIssue, 73);
});

test("untrusted author, wrong control issue, or prose-only is not authority", () => {
  assert.equal(parseLaunchAuthorization([{ ...ok, authorPermission: "read" }], { controlIssue: 10 }).status, "NONE");
  assert.equal(parseLaunchAuthorization([ok], { controlIssue: 11 }).status, "NONE");
  assert.equal(parseLaunchAuthorization([{ id: 3, body: "please launch #10", authorPermission: "admin" }], { controlIssue: 10 }).status, "NONE");
});

test("conflicting authorizations are ambiguous", () => {
  const r = parseLaunchAuthorization([ok, { id: 2, body: body({ nonce: "other-nonce-1" }), authorPermission: "write" }], { controlIssue: 10 });
  assert.equal(r.status, "AMBIGUOUS");
});

const authorization = { controlIssue: 10, nonce: "nonce-12345" };
const ev = (o = {}) => ({ name: "issue_comment", action: "created", actorPermission: "write", isFork: false, isPullRequest: false, issueNumber: 10, commentBody: "/ldl launch nonce-12345", ...o });

test("trusted comment trigger and dispatch accepted", () => {
  assert.equal(verifyTrustedTrigger(ev(), { authorization }).trusted, true);
  assert.equal(verifyTrustedTrigger({ name: "workflow_dispatch", actorPermission: "admin", isFork: false, inputs: { control_issue: "10", nonce: "nonce-12345" } }, { authorization }).trusted, true);
});

test("untrusted actor, fork, PR comment, wrong nonce, edited, unknown origin rejected", () => {
  for (const o of [{ actorPermission: "read" }, { isFork: true }, { isFork: undefined }, { isPullRequest: true }, { commentBody: "/ldl launch wrong" }, { action: "edited" }, { issueNumber: 11 }, { name: "pull_request_target" }]) {
    assert.equal(verifyTrustedTrigger(ev(o), { authorization }).trusted, false, JSON.stringify(o));
  }
  assert.equal(verifyTrustedTrigger(ev(), {}).trusted, false);
});

import {
  verifyDispatchLaunchRequest, resolveDispatchExecution, buildDispatchAuthorization,
  renderDispatchLaunchRecord, LAUNCH_AUTHORIZATION_HEADING,
} from "./launch-authorization.mjs";
import { parseAttemptClaims, planClaim, renderClaimBody } from "./attempt-claim.mjs";

const dev = (o = {}) => ({
  name: "workflow_dispatch", action: "dispatch", actor: "founder", actorPermission: "write", isFork: false,
  ref: "refs/heads/main", defaultBranch: "main", inputs: { control_issue: "10" }, ...o,
});

test("dispatch request: writer on default branch with control only is trusted", () => {
  const r = verifyDispatchLaunchRequest(dev());
  assert.equal(r.trusted, true);
  assert.equal(r.controlIssue, 10);
  for (const p of ["admin", "maintain"]) assert.equal(verifyDispatchLaunchRequest(dev({ actorPermission: p })).trusted, true);
});

test("dispatch request: nonwriter, fork, wrong event, non-default ref, bad input all refused", () => {
  const bad = [
    { actorPermission: "read" }, { actorPermission: "none" }, { actorPermission: undefined },
    { actor: "" }, { actor: undefined }, { isFork: true }, { isFork: undefined },
    { name: "issue_comment" }, { name: "pull_request_target" }, { action: "created" },
    { ref: "refs/heads/feature" }, { ref: "refs/pull/1/merge" }, { defaultBranch: undefined },
    { inputs: {} }, { inputs: { control_issue: "" } }, { inputs: { control_issue: "0" } },
    { inputs: { control_issue: "10abc" } }, { inputs: { control_issue: "-3" } }, { inputs: { control_issue: "010" } },
    { inputs: { control_issue: 10 } },
    { inputs: { control_issue: "10 " } }, { inputs: { control_issue: " 10" } }, { inputs: { control_issue: "10\n" } },
  ];
  for (const o of bad) assert.equal(verifyDispatchLaunchRequest(dev(o)).trusted, false, JSON.stringify(o));
  assert.equal(verifyDispatchLaunchRequest(null).trusted, false);
});

const LAUNCHABLE = new Set([...Object.keys(TRANSITIONS), ...OPEN_PATH_STATES]);
const verdict = (o = {}) => ({ state: "READY_TO_DISPATCH", controlIssue: 10, executionIssue: 73, ...o });

test("execution issue resolved only from the verdict for the requested control", () => {
  assert.deepEqual(resolveDispatchExecution(verdict(), { controlIssue: 10, launchableStates: LAUNCHABLE }), { status: "RESOLVED", executionIssue: 73, state: "READY_TO_DISPATCH" });
  assert.equal(resolveDispatchExecution(verdict({ executionIssue: undefined, workIssue: 73 }), { controlIssue: 10, launchableStates: LAUNCHABLE }).executionIssue, 73);
  assert.equal(resolveDispatchExecution(verdict({ workIssue: 73, issue: 73 }), { controlIssue: 10, launchableStates: LAUNCHABLE }).status, "RESOLVED");
});

test("stale, terminal, ambiguous, competing, cross-control or absent execution fails closed", () => {
  const refused = [
    verdict({ controlIssue: 11 }), verdict({ controlIssue: undefined }), verdict({ executionIssue: undefined }),
    verdict({ executionIssue: 73, workIssue: 74 }), verdict({ executionIssue: "73x" }), verdict({ executionIssue: 10 }),
    verdict({ state: "BLOCKED" }), verdict({ state: "NOT_READY" }), verdict({ state: "AMBIGUOUS" }),
    verdict({ state: "PR_BREAKPOINT_NEEDS_FINALIZATION" }), verdict({ state: "READY_TO_PROJECT_NO_PR_COMPLETION" }),
    verdict({ state: "POST_UNIT_REPAIR_REQUIRED" }), verdict({ state: "SOMETHING_UNKNOWN" }),
    { controlIssue: 10, executionIssue: 73 }, null,
  ];
  for (const v of refused) assert.equal(resolveDispatchExecution(v, { controlIssue: 10, launchableStates: LAUNCHABLE }).status, "REFUSED", JSON.stringify(v));
  assert.equal(resolveDispatchExecution(verdict(), { controlIssue: 0, launchableStates: LAUNCHABLE }).status, "REFUSED");
});

test("dispatch authorization is deterministic, run-bound, and rejects incomplete provenance", () => {
  const a = buildDispatchAuthorization({ controlIssue: 10, executionIssue: 73, initiator: "founder", runId: "555" });
  assert.deepEqual(a, buildDispatchAuthorization({ controlIssue: 10, executionIssue: 73, initiator: "founder", runId: "555" }));
  assert.equal(a.nonce, "dispatch-555");
  assert.match(a.nonce, /^[A-Za-z0-9._-]{8,}$/);
  assert.notEqual(a.nonce, buildDispatchAuthorization({ controlIssue: 10, executionIssue: 73, initiator: "founder", runId: "556" }).nonce);
  for (const o of [{ runId: "x1" }, { runId: "" }, { initiator: " " }, { executionIssue: 0 }, { controlIssue: 0 }]) {
    assert.equal(buildDispatchAuthorization({ controlIssue: 10, executionIssue: 73, initiator: "founder", runId: "555", ...o }), null, JSON.stringify(o));
  }
});

test("launch record is auditable and never parses as a legacy authorization", () => {
  const a = buildDispatchAuthorization({ controlIssue: 10, executionIssue: 73, initiator: "founder", runId: "555" });
  const rec = renderDispatchLaunchRecord({ authorization: a, attemptId: "555-1", state: "READY_TO_DISPATCH", requestedAt: "2026-10-12T00:00:00Z" });
  for (const s of ["founder", "#10", "#73", "555-1", "dispatch-555", "READY_TO_DISPATCH"]) assert.ok(rec.includes(s), s);
  assert.ok(!rec.includes(LAUNCH_AUTHORIZATION_HEADING));
  assert.equal(parseLaunchAuthorization([{ id: 1, body: rec, authorPermission: "admin" }], { controlIssue: 10 }).status, "NONE");
});

test("claim replay: same request after settle is REPLAY, live blocks, orphan reconciles, new run claims", () => {
  const a = buildDispatchAuthorization({ controlIssue: 10, executionIssue: 73, initiator: "founder", runId: "555" });
  const claim = (phase, attemptId, id) => ({ id, author: "github-actions[bot]", authorPermission: "none", body: renderClaimBody({ attemptId, nonce: a.nonce, claimedAt: "t", runner: "github-actions", phase }) });
  const settled = parseAttemptClaims([claim("CLAIMED", "555-1", 1), claim("DONE", "555-1", 2)]);
  assert.equal(planClaim(settled, {}, { attemptId: "555-2", nonce: a.nonce }).action, "REPLAY");
  const open = parseAttemptClaims([claim("CLAIMED", "555-1", 1)]);
  assert.equal(planClaim(open, { "555-1": { status: "in_progress" } }, { attemptId: "556-1", nonce: "dispatch-556" }).action, "BLOCK");
  assert.equal(planClaim(open, { "555-1": { status: "completed", conclusion: "failure" } }, { attemptId: "556-1", nonce: "dispatch-556" }).action, "RECONCILE_THEN_CLAIM");
  assert.equal(planClaim(settled, {}, { attemptId: "556-1", nonce: "dispatch-556" }).action, "CLAIM");
});
