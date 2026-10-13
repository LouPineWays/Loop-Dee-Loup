// Tests for tools/orchestration/activate-control-pair.mjs — issue #1151 approval-consumption /
// control-execution pair activation. Run with:
//   node --test tools/orchestration/activate-control-pair.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { activateControlPair, findActiveGrantWitness, controlAdvertisesPendingState, buildActivatedControlBody } from "./activate-control-pair.mjs";

const FENCE = "```";
const GRANT_JSON = JSON.stringify({
  executorSubstrate: [{ component: "authority-guards", paths: ["tools/orchestration/write-control-snapshot.mjs"], intendedChange: "x", verification: "y" }],
});
const jsonBlock = (j) => `${FENCE}json\n${j}\n${FENCE}`;
const ACTIVE_THICK = `### Observable outcome\nfoo\n\n### INACTIVE proposed exact substrate grant\n\n${jsonBlock(GRANT_JSON)}\n\n### ACTIVE founder-approved exact protected component grant — 2026-10-13\nApproved.\n\n${jsonBlock(GRANT_JSON)}\n`;
const INACTIVE_ONLY_THICK = `### INACTIVE proposed exact substrate grant\n\n${jsonBlock(GRANT_JSON)}\n`;
const BAD_COMPONENT_THICK = `### ACTIVE grant\n${jsonBlock('{"executorSubstrate":[{"component":"nope"}]}')}\n`;

// The literal #1149 shape: template headings, NEEDS_FOUNDER, prose blocker, pending decision.
const BODY_1149 = `### State

NEEDS_FOUNDER

### Current state

- **Execution:** #1150
- **Route:** none
- **Founder decision:** pending exact protected workflow component grant

### Current blocker

Waiting for the founder to approve the exact protected workflow component grant.

### Founder interrupt

Approve the exact grant.
`;

// The #438 shape: reopened on GitHub but body still DONE / historical #804.
const BODY_438 = `- **Lifecycle:** DONE
- **Execution:** #804
- **Route:** none
- **Blocker:** none
- **Founder decision:** none
`;

function makeWorld({ control = BODY_1149, controlState = "OPEN", exec = ACTIVE_THICK, execState = "OPEN", gate } = {}) {
  const w = { issues: { 10: { body: control, state: controlState }, 11: { body: exec, state: execState } }, writes: [], gateCalls: 0 };
  w.readIssueImpl = ({ number }) => ({ ...w.issues[number] });
  w.ghEditImpl = ({ controlIssue, body }) => {
    w.writes.push(body);
    w.issues[controlIssue] = { ...w.issues[controlIssue], body };
  };
  w.runGateImpl = ({ controlIssue }) => {
    w.gateCalls++;
    return gate ? gate(w) : { state: "READY_TO_DISPATCH", executionIssue: 11, route: "implementation worker", controlIssue };
  };
  return w;
}
const run = (w, extra = {}) =>
  activateControlPair({ repo: "o/r", controlIssue: 10, executionIssue: 11, ...extra }, { readIssueImpl: w.readIssueImpl, ghEditImpl: w.ghEditImpl, runGateImpl: w.runGateImpl });

test("witness: ACTIVE section with valid authority JSON is accepted; INACTIVE-only, malformed, revoked and unknown-component are not", () => {
  assert.equal(findActiveGrantWitness(ACTIVE_THICK).ok, true);
  assert.deepEqual(findActiveGrantWitness(ACTIVE_THICK).components, ["authority-guards"]);
  assert.equal(findActiveGrantWitness(INACTIVE_ONLY_THICK).ok, false);
  assert.equal(findActiveGrantWitness(`### ACTIVE grant\n${jsonBlock("{not json}")}`).ok, false);
  assert.equal(findActiveGrantWitness(`### REVOKED ACTIVE grant\n${jsonBlock(GRANT_JSON)}`).ok, false);
  assert.equal(findActiveGrantWitness(BAD_COMPONENT_THICK).ok, false);
});

test("(a) #1149 literal shape + ACTIVE exact grant -> READY snapshot, readback, fresh gate, no founder prompt", () => {
  const w = makeWorld();
  const r = run(w);
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(r.state, "ACTIVATED");
  assert.equal(w.writes.length, 1);
  assert.equal(w.gateCalls, 1);
  const body = w.issues[10].body;
  assert.match(body, /### State\n\nREADY/);
  assert.match(body, /- \*\*Execution:\*\* #11/);
  assert.match(body, /- \*\*Route:\*\* implementation worker/);
  assert.match(body, /- \*\*Founder decision:\*\* none/);
  assert.match(body, /### Current blocker\n\nnone/);
  assert.match(body, /### Founder interrupt\n\nnone/);
  assert.equal(controlAdvertisesPendingState(body), false);
});

test("(b) grant absent / INACTIVE / mismatched -> BLOCKED, control untouched, gate not run", () => {
  for (const exec of ["no grant here", INACTIVE_ONLY_THICK, BAD_COMPONENT_THICK]) {
    const w = makeWorld({ exec });
    const r = run(w);
    assert.equal(r.exitCode, 2);
    assert.equal(r.state, "BLOCKED");
    assert.equal(w.writes.length, 0);
    assert.equal(w.gateCalls, 0);
    assert.equal(w.issues[10].body, BODY_1149);
  }
});

test("(c) retry is idempotent: second call performs no write, re-runs the gate, reports ALREADY_ACTIVE", () => {
  const w = makeWorld();
  assert.equal(run(w).state, "ACTIVATED");
  const r2 = run(w);
  assert.equal(r2.exitCode, 0);
  assert.equal(r2.state, "ALREADY_ACTIVE");
  assert.equal(w.writes.length, 1);
  assert.equal(w.gateCalls, 2);
});

test("(d) stale/concurrent change between read and write -> STALE_CONTROL, nothing written", () => {
  const w = makeWorld();
  let reads = 0;
  const readIssueImpl = ({ number }) => {
    const out = { ...w.issues[number] };
    if (number === 10 && ++reads === 2) out.body = BODY_1149 + "\n- concurrent edit\n";
    return out;
  };
  const r = activateControlPair({ repo: "o/r", controlIssue: 10, executionIssue: 11 }, { readIssueImpl, ghEditImpl: w.ghEditImpl, runGateImpl: w.runGateImpl });
  assert.equal(r.exitCode, 2);
  assert.equal(r.state, "STALE_CONTROL");
  assert.equal(w.writes.length, 0);
  assert.equal(w.gateCalls, 0);
});

test("(d2) control re-closed between read and write -> rejected, nothing written", () => {
  const w = makeWorld();
  let reads = 0;
  const readIssueImpl = ({ number }) => {
    const out = { ...w.issues[number] };
    if (number === 10 && ++reads === 2) out.state = "CLOSED";
    return out;
  };
  const r = activateControlPair({ repo: "o/r", controlIssue: 10, executionIssue: 11 }, { readIssueImpl, ghEditImpl: w.ghEditImpl, runGateImpl: w.runGateImpl });
  assert.equal(r.exitCode, 2);
  assert.equal(w.writes.length, 0);
});

test("(e) invalid proposed body is rejected by the canonical writer validation (duplicate Execution bullet)", () => {
  const w = makeWorld({ control: BODY_1149 + "\n- **Execution:** #99\n" });
  const r = run(w);
  assert.equal(r.exitCode, 2);
  assert.equal(w.writes.length, 0);
});

test("(f) handoff-only emits a deterministic qualified-executor handoff with no founder prompt and no I/O", () => {
  const w = makeWorld();
  const r = run(w, { handoffOnly: true });
  assert.equal(r.exitCode, 0);
  assert.equal(r.state, "HANDOFF");
  assert.equal(r.founderPromptRequired, false);
  assert.match(r.command, /activate-control-pair\.mjs --control-issue 10 --execution-issue 11/);
  assert.equal(w.writes.length, 0);
});

test("(g) a normal fresh control with no pending state activates without needing a grant witness", () => {
  const w = makeWorld({ control: "- **Lifecycle:** READY_FOR_PLAN\n- **Execution:** none\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n", exec: "plain thick" });
  const r = run(w);
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(r.state, "ACTIVATED");
});

test("#438/#1151: CLOSED control + open child is rejected; reopened-but-DONE/#804 body is rewritten to READY/#1151 as the sole pointer", () => {
  const closed = makeWorld({ control: BODY_438, controlState: "CLOSED" });
  const rc = run(closed);
  assert.equal(rc.exitCode, 2);
  assert.match(rc.message, /Reopen the existing control/);
  assert.equal(closed.writes.length, 0);

  const reopened = makeWorld({ control: BODY_438, exec: "plain thick" });
  const ro = run(reopened);
  assert.equal(ro.state, "ACTIVATED", JSON.stringify(ro));
  const body = reopened.issues[10].body;
  assert.match(body, /- \*\*Lifecycle:\*\* READY/);
  assert.match(body, /- \*\*Execution:\*\* #11/);
  assert.doesNotMatch(body, /#804/);
});

test("closed execution packet is never activated", () => {
  const w = makeWorld({ execState: "CLOSED" });
  const r = run(w);
  assert.equal(r.exitCode, 2);
  assert.equal(w.writes.length, 0);
});

test("crash/partial write: gate not READY or readback mismatch never reports ready", () => {
  const notReady = makeWorld({ gate: () => ({ state: "BLOCKED" }) });
  const r1 = run(notReady);
  assert.equal(r1.exitCode, 1);
  assert.equal(r1.state, "GATE_NOT_READY");

  const lost = makeWorld();
  lost.ghEditImpl = () => {}; // write "succeeds" but nothing persisted
  const r2 = activateControlPair({ repo: "o/r", controlIssue: 10, executionIssue: 11 }, { readIssueImpl: lost.readIssueImpl, ghEditImpl: lost.ghEditImpl, runGateImpl: lost.runGateImpl });
  assert.equal(r2.exitCode, 1);
  assert.equal(r2.state, "READBACK_MISMATCH");
  assert.equal(lost.gateCalls, 0);
});

test("buildActivatedControlBody converges the lifecycle, pointer, route and blocker fields", () => {
  const b = buildActivatedControlBody("- **Lifecycle:** BLOCKED\n- **Blocker:** x\n", { executionIssue: 5 });
  assert.match(b, /- \*\*Lifecycle:\*\* READY/);
  assert.match(b, /- \*\*Execution:\*\* #5/);
  assert.match(b, /- \*\*Blocker:\*\* none/);
});
