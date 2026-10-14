// Tests for tools/orchestration/activate-control-pair.mjs — issue #1151 approval-consumption /
// control-execution pair activation. Run with:
//   node --test tools/orchestration/activate-control-pair.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  activateControlPair,
  findActiveGrantWitness,
  findNewPacketAuthority,
  controlAdvertisesPendingState,
  buildActivatedControlBody,
  isTerminalControl,
  resolveEntryActivation,
  pendingMatchesGrant,
  defaultListOpenIssues,
} from "./activate-control-pair.mjs";
import { defaultGhPatchControlIssue } from "./write-control-snapshot.mjs";
import { validateActivationPair } from "./control-field-validator.mjs";

const FENCE = "```";
const GRANT_JSON = JSON.stringify({
  executorSubstrate: [{ component: "authority-guards", paths: ["tools/orchestration/write-control-snapshot.mjs"], intendedChange: "x", verification: "y" }],
});
const jsonBlock = (j) => `${FENCE}json\n${j}\n${FENCE}`;
const ACTIVE_THICK = `### Parent loop\n#10\n\n### Observable outcome\nfoo\n\n### INACTIVE proposed exact substrate grant\n\n${jsonBlock(GRANT_JSON)}\n\n### ACTIVE founder-approved exact protected component grant — 2026-10-13\nApproved.\n\n${jsonBlock(GRANT_JSON)}\n`;
const INACTIVE_ONLY_THICK = `### Parent loop\n#10\n\n### INACTIVE proposed exact substrate grant\n\n${jsonBlock(GRANT_JSON)}\n`;
const PARENT = "### Parent loop\n#10\n";
const BAD_COMPONENT_THICK = `### Parent loop\n#10\n\n### ACTIVE grant\n${jsonBlock('{"executorSubstrate":[{"component":"nope"}]}')}\n`;

// The literal #1149 shape: template headings, NEEDS_FOUNDER, prose blocker, pending decision.
const BODY_1149 = `### State

NEEDS_FOUNDER

### Current state

- **Execution:** #11
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

function makeWorld({ control = BODY_1149, controlState = "OPEN", exec = ACTIVE_THICK, execState = "OPEN", gate, extra = {} } = {}) {
  const w = { issues: { 10: { body: control, state: controlState }, 11: { body: exec, state: execState }, ...extra }, writes: [], patches: [], gateCalls: 0 };
  w.reopenImpl = ({ controlIssue, body, state }) => {
    w.patches.push({ body, state });
    w.issues[controlIssue] = { body, state: state.toUpperCase() };
  };
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
  activateControlPair({ repo: "o/r", controlIssue: 10, executionIssue: 11, ...extra }, { readIssueImpl: w.readIssueImpl, ghEditImpl: w.ghEditImpl, reopenImpl: w.reopenImpl, runGateImpl: w.runGateImpl });

const NEW_PACKET_THICK = `### Parent loop\n#10\n\n### ACTIVE founder-authorized new packet — 2026-10-14\nFounder directed this outcome.\n\n${jsonBlock(JSON.stringify({ newPacketAuthority: { controlIssue: 10, executionIssue: 11 } }))}\n`;
// The #438 shape with the full completed cycle still projected as current pointers (issue #1165 fixture B).
const BODY_438_FULL = `### State

DONE

### Current state

- **Execution:** #804
- **Route:** implementation worker
- **Founder decision:** none
- **PR:** #1159
- **Stage 1:** CLEAN at e6f2fe7
- **Stage 2:** #1160

### Current blocker

None
`;
const fx = (extra = {}) => ({ 804: { body: "old", state: "CLOSED" }, ...extra });

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

test("(f) handoff-only emits a deterministic qualified-executor handoff with no founder prompt, after read-only proof and no writes", () => {
  const w = makeWorld();
  const r = run(w, { handoffOnly: true });
  assert.equal(r.exitCode, 0);
  assert.equal(r.state, "HANDOFF");
  assert.equal(r.founderPromptRequired, false);
  assert.match(r.command, /activate-control-pair\.mjs --control-issue 10 --execution-issue 11/);
  assert.equal(w.writes.length, 0);
  assert.equal(w.gateCalls, 0);
});

test("(f2) handoff-only fails closed (no HANDOFF) for absent, revoked, wrong-parent, and closed pairs; no writes", () => {
  const revoked = ACTIVE_THICK.replace("### ACTIVE founder-approved", "### REVOKED ACTIVE founder-approved");
  const cases = {
    absent: makeWorld({ exec: INACTIVE_ONLY_THICK }),
    revoked: makeWorld({ exec: revoked }),
    mismatched: makeWorld({ exec: BAD_COMPONENT_THICK }),
    wrongParent: makeWorld({ exec: ACTIVE_THICK.replace("#10", "#99") }),
    closedControl: makeWorld({ controlState: "CLOSED", exec: PARENT }),
    closedExecution: makeWorld({ execState: "CLOSED" }),
  };
  for (const [name, w] of Object.entries(cases)) {
    const r = run(w, { handoffOnly: true });
    assert.equal(r.exitCode, 2, name);
    assert.notEqual(r.state, "HANDOFF", name);
    assert.equal(w.writes.length, 0, name);
  }
});

test("(g) a normal fresh control with no pending state activates without needing a grant witness", () => {
  const w = makeWorld({ control: "- **Lifecycle:** READY_FOR_PLAN\n- **Execution:** none\n- **Route:** planning worker\n- **Blocker:** none\n- **Founder decision:** none\n", exec: PARENT });
  const r = run(w);
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(r.state, "ACTIVATED");
});

test("#438/#1151: an OPEN/DONE control rewrites to READY/#1151 only with explicit new-packet authority", () => {
  const unauthorized = makeWorld({ control: BODY_438, exec: PARENT });
  const ru = run(unauthorized);
  assert.equal(ru.state, "BLOCKED");
  assert.match(ru.message, /new-packet record/);
  assert.equal(unauthorized.writes.length, 0);

  const reopened = makeWorld({ control: BODY_438, exec: NEW_PACKET_THICK, extra: { 804: { body: "old", state: "CLOSED" } } });
  const ro = run(reopened);
  assert.equal(ro.state, "ACTIVATED", JSON.stringify(ro));
  const body = reopened.issues[10].body;
  assert.match(body, /- \*\*Lifecycle:\*\* READY/);
  assert.match(body, /- \*\*Execution:\*\* #11/);
  assert.match(body, /Completed packet history .*Execution #804/);
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

// Issue #1151 Stage 1 correction regressions.
test("hybrid control: bullet none + pending heading is still pending and needs the witness", () => {
  const hybrid = "- **Lifecycle:** NEEDS_FOUNDER\n- **Execution:** #11\n- **Founder decision:** none\n- **Blocker:** none\n\n### Founder interrupt\n\nApprove the exact grant.\n";
  assert.equal(controlAdvertisesPendingState(hybrid), true);
  const w = makeWorld({ control: hybrid, exec: PARENT });
  const r = run(w);
  assert.equal(r.state, "BLOCKED");
  assert.equal(w.writes.length, 0);
});

test("unrelated pending decision is not cleared by an unrelated ACTIVE grant", () => {
  const product = "- **Lifecycle:** NEEDS_FOUNDER\n- **Execution:** #11\n- **Founder decision:** pending pricing choice for the paid tier\n- **Blocker:** none\n";
  const w = makeWorld({ control: product });
  assert.equal(run(w).state, "BLOCKED");
  assert.equal(w.writes.length, 0);
  const other = BODY_1149.replace("exact protected workflow component grant", "exact grant for component routing-policy");
  assert.equal(run(makeWorld({ control: other })).state, "BLOCKED");
});

test("execution packet must name this control in Parent loop", () => {
  for (const exec of [ACTIVE_THICK.replace("#10", "#99"), ACTIVE_THICK.replace("### Parent loop\n#10\n\n", ""), ACTIVE_THICK.replace("#10", "#10 and #99")]) {
    const w = makeWorld({ exec });
    assert.equal(run(w).state, "BLOCKED");
    assert.equal(w.writes.length, 0);
  }
});

test("grant revoked between initial check and write is revalidated at the mutation boundary", () => {
  const w = makeWorld();
  let reads = 0;
  const readIssueImpl = (a) => (a.number === 11 && ++reads > 1 ? { body: INACTIVE_ONLY_THICK, state: "OPEN" } : w.readIssueImpl(a));
  const r = activateControlPair({ repo: "o/r", controlIssue: 10, executionIssue: 11 }, { readIssueImpl, ghEditImpl: w.ghEditImpl, runGateImpl: w.runGateImpl });
  assert.equal(r.exitCode, 2);
  assert.equal(w.writes.length, 0);
});

test("planning routes are rejected", () => {
  const w = makeWorld();
  const r = run(w, { route: "planning worker" });
  assert.equal(r.state, "REJECTED");
  assert.equal(w.writes.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Issue #1165 - fixture B: post-completion packet under a terminal control (#438), reopen-and-activate.
// ---------------------------------------------------------------------------------------------

test("B1: CLOSED/DONE control + explicitly authorized new packet -> ONE state+body mutation, readback, fresh gate, ACTIVATED", () => {
  const w = makeWorld({ control: BODY_438_FULL, controlState: "CLOSED", exec: NEW_PACKET_THICK, extra: fx() });
  const r = run(w);
  assert.equal(r.state, "ACTIVATED", JSON.stringify(r));
  assert.equal(w.patches.length, 1, "exactly one combined state+body PATCH");
  assert.equal(w.patches[0].state, "open");
  assert.equal(w.writes.length, 0, "no body-only write, no standalone reopen");
  assert.equal(w.issues[10].state, "OPEN");
  const body = w.issues[10].body;
  assert.match(body, /^### State\n\nREADY/m);
  assert.match(body, /- \*\*Execution:\*\* #11/);
  for (const label of ["PR", "Stage 1", "Stage 2"]) assert.match(body, new RegExp(`- \\*\\*${label}:\\*\\* none`));
  assert.equal(w.gateCalls, 1);
  // Historical cycle preserved as history, distinct from the current pointers.
  assert.match(body, /Completed packet history .*Execution #804; PR #1159; Stage 1 CLEAN at e6f2fe7; Stage 2 #1160\./);
  assert.deepEqual(validateActivationPair(body, { controlIssue: 10, executionIssue: 11, controlState: "OPEN", executionState: "OPEN" }), { ok: true });
});

test("B2: externally reopened OPEN/DONE control (the actual #438 shape) is recovered by one body write, no reopen call", () => {
  const w = makeWorld({ control: BODY_438_FULL, exec: NEW_PACKET_THICK, extra: fx() });
  const r = run(w);
  assert.equal(r.state, "ACTIVATED", JSON.stringify(r));
  assert.equal(w.writes.length, 1);
  assert.equal(w.patches.length, 0);
  assert.match(w.issues[10].body, /Completed packet history/);
});

test("B3: an OPEN child Issue binding the parent but carrying no authorization never reopens or activates", () => {
  for (const controlState of ["CLOSED", "OPEN"]) {
    const w = makeWorld({ control: BODY_438_FULL, controlState, exec: PARENT, extra: fx() });
    const r = run(w);
    assert.equal(r.exitCode, 2);
    assert.equal(r.state, "BLOCKED");
    assert.equal(w.writes.length + w.patches.length, 0);
    assert.equal(w.issues[10].state, controlState);
    assert.equal(w.gateCalls, 0);
  }
});

test("B4: authorization naming a different pair, an INACTIVE record, or another parent is not authority", () => {
  const wrongPair = NEW_PACKET_THICK.replace('"executionIssue":11', '"executionIssue":12');
  const inactive = NEW_PACKET_THICK.replace("### ACTIVE founder", "### INACTIVE ACTIVE founder");
  const wrongParent = NEW_PACKET_THICK.replace("#10\n", "#99\n");
  for (const exec of [wrongPair, inactive, wrongParent]) {
    const w = makeWorld({ control: BODY_438_FULL, controlState: "CLOSED", exec, extra: fx() });
    assert.equal(run(w).exitCode, 2);
    assert.equal(w.patches.length + w.writes.length, 0);
  }
  assert.equal(findNewPacketAuthority(NEW_PACKET_THICK, { controlIssue: 10, executionIssue: 11 }).via, "newPacketAuthority");
});

test("B5: a competing nonterminal packet (current Execution pointer still OPEN) blocks the activation", () => {
  const w = makeWorld({ control: BODY_438_FULL, controlState: "CLOSED", exec: NEW_PACKET_THICK, extra: { 804: { body: "old", state: "OPEN" } } });
  const r = run(w);
  assert.equal(r.state, "BLOCKED");
  assert.match(r.message, /competing/);
  assert.equal(w.patches.length + w.writes.length, 0);
  assert.equal(w.issues[10].state, "CLOSED");
});

test("B6: idempotent retry after success performs no write/reopen and reports ALREADY_ACTIVE", () => {
  const w = makeWorld({ control: BODY_438_FULL, controlState: "CLOSED", exec: NEW_PACKET_THICK, extra: fx() });
  assert.equal(run(w).state, "ACTIVATED");
  const before = w.issues[10].body;
  const again = run(w);
  assert.equal(again.state, "ALREADY_ACTIVE");
  assert.equal(w.patches.length, 1);
  assert.equal(w.writes.length, 0);
  assert.equal(w.issues[10].body, before);
});

test("B7: failed reopen write leaves the control CLOSED, never reports success, never runs the gate", () => {
  const w = makeWorld({ control: BODY_438_FULL, controlState: "CLOSED", exec: NEW_PACKET_THICK, extra: fx() });
  w.reopenImpl = () => {
    throw new Error("HTTP 403");
  };
  const r = run(w);
  assert.equal(r.exitCode, 1);
  assert.equal(r.state, "REOPEN_WRITE_FAILED");
  assert.equal(w.issues[10].state, "CLOSED");
  assert.equal(w.gateCalls, 0);
});

test("B8: a readback that does not show the activated pair is rolled back to the closed base", () => {
  const w = makeWorld({ control: BODY_438_FULL, controlState: "CLOSED", exec: NEW_PACKET_THICK, extra: fx() });
  const base = w.issues[10].body;
  w.reopenImpl = ({ controlIssue, body, state }) => {
    w.patches.push({ body, state });
    w.issues[controlIssue] = { body, state: state.toUpperCase() };
    // The execution packet is closed right after the reopen lands, so the readback cannot show a live pair.
    if (state === "open") w.issues[11] = { ...w.issues[11], state: "CLOSED" };
  };
  const r = run(w);
  assert.equal(r.exitCode, 1);
  assert.equal(r.state, "READBACK_MISMATCH");
  assert.equal(r.rolledBack, true);
  assert.deepEqual(w.patches.map((p) => p.state), ["open", "closed"]);
  assert.equal(w.issues[10].state, "CLOSED");
  assert.equal(w.issues[10].body, base);
  assert.equal(w.gateCalls, 0);
});

test("B9: stale-base races refuse without writing (body changed, or someone already reopened it)", () => {
  for (const mutate of [
    (w) => (w.issues[10] = { ...w.issues[10], body: w.issues[10].body + "\nconcurrent edit" }),
    (w) => (w.issues[10] = { ...w.issues[10], state: "OPEN" }),
  ]) {
    const w = makeWorld({ control: BODY_438_FULL, controlState: "CLOSED", exec: NEW_PACKET_THICK, extra: fx() });
    let reads = 0;
    const readIssueImpl = (a) => {
      const out = w.readIssueImpl(a);
      if (a.number === 11 && ++reads === 1) mutate(w); // after the caller's initial control+execution reads
      return out;
    };
    const r = activateControlPair({ repo: "o/r", controlIssue: 10, executionIssue: 11 }, { readIssueImpl, ghEditImpl: w.ghEditImpl, reopenImpl: w.reopenImpl, runGateImpl: w.runGateImpl });
    assert.equal(r.state, "STALE_CONTROL", JSON.stringify(r));
    assert.equal(w.patches.length + w.writes.length, 0);
  }
});

test("B10: gate not READY after the transaction is reported as such, never ACTIVATED", () => {
  const w = makeWorld({ control: BODY_438_FULL, controlState: "CLOSED", exec: NEW_PACKET_THICK, extra: fx(), gate: () => ({ state: "NOT_READY" }) });
  const r = run(w);
  assert.equal(r.exitCode, 1);
  assert.equal(r.state, "GATE_NOT_READY");
});

test("B11: handoff-only for a CLOSED terminal control proves authority read-only, then leaves it CLOSED", () => {
  const w = makeWorld({ control: BODY_438_FULL, controlState: "CLOSED", exec: NEW_PACKET_THICK, extra: fx() });
  const r = run(w, { handoffOnly: true });
  assert.equal(r.state, "HANDOFF");
  assert.equal(r.reopens, true);
  assert.equal(r.founderPromptRequired, false);
  assert.equal(w.patches.length + w.writes.length, 0);
  assert.equal(w.issues[10].state, "CLOSED");
  const unproven = makeWorld({ control: BODY_438_FULL, controlState: "CLOSED", exec: PARENT, extra: fx() });
  assert.notEqual(run(unproven, { handoffOnly: true }).state, "HANDOFF");
});

test("B12: an actor whose canonical writer refuses leaves the control CLOSED and does not run the gate", () => {
  const w = makeWorld({ control: BODY_438_FULL, controlState: "CLOSED", exec: NEW_PACKET_THICK, extra: fx() });
  const r = activateControlPair(
    { repo: "o/r", controlIssue: 10, executionIssue: 11 },
    { readIssueImpl: w.readIssueImpl, writeImpl: () => ({ exitCode: 1, message: "canonical writer unavailable" }), runGateImpl: w.runGateImpl },
  );
  assert.equal(r.exitCode, 1);
  assert.equal(w.issues[10].state, "CLOSED");
  assert.equal(w.gateCalls, 0);
});

test("isTerminalControl: CLOSED or DONE lifecycle only", () => {
  assert.equal(isTerminalControl("- **Lifecycle:** READY\n", "CLOSED"), true);
  assert.equal(isTerminalControl("### State\n\nDONE\n", "OPEN"), true);
  assert.equal(isTerminalControl("- **Lifecycle:** READY\n", "OPEN"), false);
});

test("defaultGhPatchControlIssue verifies identity, state, body and rejects malformed responses", () => {
  const ok = (over = {}) => () => JSON.stringify({ number: 10, html_url: "https://github.com/o/r/issues/10", state: "open", body: "B", ...over });
  assert.doesNotThrow(() => defaultGhPatchControlIssue({ repo: "o/r", controlIssue: 10, body: "B", state: "open" }, ok()));
  for (const over of [{ number: 11 }, { html_url: "https://github.com/o/r/issues/11" }, { state: "closed" }, { body: "other" }, { pull_request: {} }]) {
    assert.throws(() => defaultGhPatchControlIssue({ repo: "o/r", controlIssue: 10, body: "B", state: "open" }, ok(over)), undefined, JSON.stringify(over));
  }
  assert.throws(() => defaultGhPatchControlIssue({ repo: "o/r", controlIssue: 10, body: "B", state: "open" }, () => "not json"), /malformed/);
  assert.throws(() => defaultGhPatchControlIssue({ repo: "o/r", controlIssue: 10, body: "B", state: "reopened" }, ok()), /unsupported state/);
});

// ---------------------------------------------------------------------------------------------
// Issue #1165 - fixture A: the literal #1164/#1163 stale-approval shape.
// ---------------------------------------------------------------------------------------------

const BODY_1164 = `### State

NEEDS_FOUNDER

### Current state

- **Execution:** #11
- **Route:** none
- **PR:** none
- **Stage 1:** none
- **Stage 2:** none
- **Founder decision:** pending narrow credential-bearing proof / host-risk acceptance / exact protected-workflow grant
- **Priority:** Now

### Current blocker

One-time credential-bearing worker qualification on the alternate host and exact protected-workflow modification are not yet separately authorized; material security assessment of this host-default user namespace posture remains to be accepted.

### Founder interrupt

May engineering use the already-observed disposable Ubuntu 22.04 hosted environment for one narrowly scoped credential-bearing Claude sandbox smoke after an exact component grant?
`;
const REVIEW_GRANT_JSON = JSON.stringify({ executorSubstrate: [{ component: "review-control", paths: [".github/workflows/ldl-launcher.yml"], intendedChange: "x", verification: "y" }] });
const THICK_1163 = `### Parent loop\n#10 - governing thin control.\n\n### ACTIVE founder-approved qualification and exact protected-component grant - 2026-10-14\n**Founder approval:** Yes, authorized.\n\n${jsonBlock(REVIEW_GRANT_JSON)}\n\n### Required layers\nx\n`;

test("A1: #1164 literal stale mixed prose (decision bullet + heading blocker + interrupt) is consumed by the ACTIVE grant", () => {
  const w = makeWorld({ control: BODY_1164, exec: THICK_1163 });
  const r = run(w);
  assert.equal(r.state, "ACTIVATED", JSON.stringify(r));
  const body = w.issues[10].body;
  assert.match(body, /^### State\n\nREADY/m);
  assert.match(body, /- \*\*Founder decision:\*\* none/);
  assert.match(body, /### Current blocker\n\nnone/);
  assert.equal(controlAdvertisesPendingState(body), false);
  assert.equal(w.patches.length, 0);
});

test("A2: independent pending state is never consumed (decision, interrupt, Issue-prerequisite blocker, other scope, revoked grant)", () => {
  const cases = {
    independentDecision: BODY_1164.replace("- **Founder decision:** pending narrow credential-bearing proof / host-risk acceptance / exact protected-workflow grant", "- **Founder decision:** pending pricing choice for the paid tier"),
    independentInterrupt: BODY_1164.replace(/### Founder interrupt\n\n.*\n/, "### Founder interrupt\n\nShould we rename the product?\n"),
    issueBlocker: BODY_1164.replace("not yet separately authorized", "blocked by #99 which is not yet approved"),
    otherScope: BODY_1164.replace("exact protected-workflow grant", "exact grant for component routing-policy"),
  };
  for (const [name, control] of Object.entries(cases)) {
    const w = makeWorld({ control, exec: THICK_1163 });
    const r = run(w);
    assert.equal(r.state, "BLOCKED", name);
    assert.equal(w.writes.length + w.patches.length, 0, name);
  }
  const revoked = makeWorld({ control: BODY_1164, exec: THICK_1163.replace("### ACTIVE founder-approved", "### REVOKED ACTIVE founder-approved") });
  assert.equal(run(revoked).state, "BLOCKED");
  assert.equal(revoked.writes.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Issue #1165 - bounded ordinary-entry resolution (what session-entry-gate calls).
// ---------------------------------------------------------------------------------------------

function entry(w, { list = [], ...rest } = {}) {
  return resolveEntryActivation({ repo: "o/r", controlIssue: 10 }, { readIssueImpl: w.readIssueImpl, ghEditImpl: w.ghEditImpl, listOpenIssuesImpl: () => list, ...rest });
}

test("entry A: stale ACTIVE grant is consumed from the control's sole Execution pointer without discovery", () => {
  const w = makeWorld({ control: BODY_1164, exec: THICK_1163 });
  const r = entry(w, {
    listOpenIssuesImpl: () => {
      throw new Error("must not list");
    },
  });
  assert.equal(r.state, "ACTIVATED_PENDING_GATE", JSON.stringify(r));
  assert.equal(w.issues[10].body.includes("NEEDS_FOUNDER"), false);
});

test("entry B: OPEN/DONE control finds exactly one authorized new packet and activates it", () => {
  const w = makeWorld({ control: BODY_438_FULL, exec: NEW_PACKET_THICK, extra: fx() });
  const r = entry(w, { list: [{ number: 11, body: NEW_PACKET_THICK }, { number: 12, body: "### Parent loop\n#10\n" }] });
  assert.equal(r.state, "ACTIVATED_PENDING_GATE", JSON.stringify(r));
  assert.match(w.issues[10].body, /- \*\*Execution:\*\* #11/);
});

test("entry B negatives: unauthorized child, two authorized packets, CLOSED control, no pending state -> no mutation", () => {
  const unauth = makeWorld({ control: BODY_438_FULL, exec: PARENT, extra: fx() });
  assert.equal(entry(unauth, { list: [{ number: 11, body: PARENT }] }).state, "NO_CANDIDATE");
  const two = makeWorld({ control: BODY_438_FULL, exec: NEW_PACKET_THICK, extra: fx() });
  const twoAuthorized = entry(two, { list: [{ number: 11, body: NEW_PACKET_THICK }, { number: 12, body: NEW_PACKET_THICK.replace('"executionIssue":11', '"executionIssue":12') }] });
  assert.equal(twoAuthorized.state, "AMBIGUOUS_CANDIDATES");
  const closed = makeWorld({ control: BODY_438_FULL, controlState: "CLOSED", exec: NEW_PACKET_THICK, extra: fx() });
  assert.equal(entry(closed, { list: [{ number: 11, body: NEW_PACKET_THICK }] }).state, "NO_CANDIDATE");
  const clean = makeWorld({ control: "- **Lifecycle:** EXECUTING\n- **Execution:** #11\n- **Blocker:** none\n- **Founder decision:** none\n", exec: PARENT });
  assert.equal(entry(clean).state, "NO_CANDIDATE");
  for (const w of [unauth, two, closed, clean]) assert.equal(w.writes.length + w.patches.length, 0);
});

test("#1165 review: a blocker unrelated to the granted component is not accepted by an unrelated ACTIVE grant", () => {
  const control = "### Current state\n\n- **Founder decision:** none\n- **Blocker:** Awaiting privacy approval\n";
  assert.equal(pendingMatchesGrant(control, ["review-control"]).ok, false);
});

test("#1165 review: a terminal control is not reopened on a leftover ACTIVE component grant alone", () => {
  const leftover = `### Parent loop\n#10\n\n### ACTIVE founder-approved grant\n${jsonBlock(JSON.stringify({ executorSubstrate: [{ component: "review-control", paths: ["a"], intendedChange: "x", verification: "y" }] }))}\n`;
  assert.equal(findNewPacketAuthority(leftover, { controlIssue: 10, executionIssue: 11 }).ok, false);
});

test("#1165 review: a planning route on a pending control is not converted to implementation at entry", () => {
  const control = BODY_1164.replace("- **Route:** none", "- **Route:** planning worker");
  const w = makeWorld({ control, exec: THICK_1163 });
  const r = entry(w);
  assert.equal(r.state, "NO_CANDIDATE");
  assert.equal(w.writes.length + w.patches.length, 0);
});

test("#1165 review: terminal discovery paginates open Issues to exhaustion", () => {
  const pages = [];
  const exec = (cmd, args) => {
    const page = Number(/&page=(\d+)$/.exec(args[1])[1]);
    pages.push(page);
    const rows = page < 4 ? Array.from({ length: 100 }, (_, i) => ({ number: page * 1000 + i, body: "" })) : [{ number: 7, body: "tail" }];
    return JSON.stringify(rows);
  };
  const out = defaultListOpenIssues({ repo: "o/r", execFileImpl: exec });
  assert.deepEqual(pages, [1, 2, 3, 4]);
  assert.equal(out.length, 301);
});

test("#1165 review: history retirement does not archive the packet being activated", () => {
  const body = BODY_438_FULL.replace("- **Execution:** #804", "- **Execution:** #11");
  const next = buildActivatedControlBody(body, { executionIssue: 11, retireHistory: true });
  assert.doesNotMatch(next, /Completed packet history[^\n]*Execution #11/);
});
