import test from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(r.status, "AUTHORIZED");
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
