// Tests for tools/orchestration/terminalize-nogo-packet.mjs.
// Run with: node --test tools/orchestration/terminalize-nogo-packet.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { defaultReadComments, terminalizeNoGoPacket, selectNoGoResult, buildNoGoTerminalControlBody, packetHasQualificationRecord } from "./terminalize-nogo-packet.mjs";
import { isTerminalControl, findNewPacketAuthority } from "./activate-control-pair.mjs";

const CONTROL = `### State
READY

### Current state
- **Execution:** #1180
- **Route:** implementation worker
- **PR:** none
- **Stage 1:** none
- **Stage 2:** none
- **Founder decision:** none
- **Lifecycle:** READY
- **Terminal result:** Backed CLEAN Stage 2 audit #1173 closed; control terminalized by tools/orchestration/close-control.mjs.

### Current blocker
none
`;

const PACKET = `### Parent loop
#1164 — sole governing thin control.

### ACTIVE founder-approved new-packet authority
\`\`\`json
{
  "newPacketAuthority": { "controlIssue": 1164, "executionIssue": 1180 },
  "claudeQualification": { "controlIssue": 1164, "executionIssue": 1180, "oneShot": true, "scope": "claude-sandbox-child-egress-v1", "host": "ubuntu-22.04" }
}
\`\`\`
`;

const RESULT = (over = {}) => ({
  body: `## Claude Qualification Result (v1)\n\n- **Verdict:** ${over.verdict ?? "NO-GO"}\n- **Control issue:** #${over.control ?? 1164}\n- **Proof packet:** #${over.packet ?? 1180}\n- **Attempt id:** 38682968969-1\n- **Reason:** child network egress was NOT denied\n`,
  user: { login: over.login ?? "github-actions[bot]" },
  html_url: "https://github.com/o/r/issues/1180#issuecomment-1",
});

function harness({ controlState = "OPEN", packetState = "OPEN", controlBody = CONTROL, packetBody = PACKET, comments = [RESULT()] } = {}) {
  const log = [];
  const state = { control: controlState, packet: packetState, body: controlBody };
  return {
    log,
    state,
    impls: {
      readIssueImpl: ({ number }) => (number === 1164 ? { state: state.control, body: state.body } : { state: state.packet, body: packetBody }),
      readCommentsImpl: () => comments,
      ghEditImpl: ({ controlIssue, body }) => {
        state.body = body;
        log.push(["edit", controlIssue]);
      },
      closeImpl: ({ issue }) => {
        log.push(["close", issue]);
        if (issue === 1164) state.control = "CLOSED";
        else state.packet = "CLOSED";
      },
      commentImpl: ({ auditIssue }) => log.push(["comment", auditIssue]),
    },
  };
}
const run = (h) => terminalizeNoGoPacket({ repo: "o/r", "control-issue": "1164", "execution-issue": "1180" }, h.impls);

test("terminalizes a consumed NO-GO packet: packet closed, control DONE + closed, history preserved", () => {
  const h = harness();
  const r = run(h);
  assert.equal(r.exitCode, 0);
  assert.equal(r.state, "TERMINALIZED");
  assert.deepEqual(h.log.map((x) => x.join(":")), ["comment:1180", "close:1180", "edit:1164", "close:1164"]);
  assert.match(h.state.body, /\*\*Lifecycle:\*\* DONE/);
  assert.match(h.state.body, /\*\*Route:\*\* none/);
  assert.match(h.state.body, /NO-GO, attempt 38682968969-1/);
  assert.match(h.state.body, /NOT worker qualification/);
  assert.equal(isTerminalControl(h.state.body, h.state.control), true);
});

test("terminal control accepts a separately authorized successor via the existing activator proof", () => {
  const succ = `### Parent loop\n#1164\n\n### ACTIVE new-packet authority\n\`\`\`json\n{"newPacketAuthority":{"controlIssue":1164,"executionIssue":1999}}\n\`\`\`\n`;
  assert.equal(findNewPacketAuthority(succ, { controlIssue: 1164, executionIssue: 1999 }).ok, true);
  // the consumed packet's grant never authorizes a different pair
  assert.equal(findNewPacketAuthority(PACKET, { controlIssue: 1164, executionIssue: 1999 }).ok, false);
});

test("idempotent: both closed is ALREADY_TERMINAL with no mutation", () => {
  const h = harness({ controlState: "CLOSED", packetState: "CLOSED" });
  assert.equal(run(h).state, "ALREADY_TERMINAL");
  assert.equal(h.log.length, 0);
});

test("resumes when the packet is already closed but the control is not", () => {
  const h = harness({ packetState: "CLOSED" });
  assert.equal(run(h).state, "TERMINALIZED");
  assert.deepEqual(h.log.map((x) => x.join(":")), ["edit:1164", "close:1164"]);
});

for (const [name, over] of [
  ["PASS verdict", { comments: [RESULT({ verdict: "PASS" })] }],
  ["no result", { comments: [] }],
  ["duplicate results", { comments: [RESULT(), RESULT()] }],
  ["forged author", { comments: [RESULT({ login: "LouPineWays" })] }],
  ["mismatched packet", { comments: [RESULT({ packet: 1181 })] }],
  ["mismatched control", { comments: [RESULT({ control: 1100 })] }],
  ["no qualification record", { packetBody: PACKET.replace("claudeQualification", "other") }],
  ["not one-shot", { packetBody: PACKET.replace('"oneShot": true', '"oneShot": false') }],
  ["wrong parent loop", { packetBody: PACKET.replace("#1164", "#1100") }],
  ["wrong scope", { packetBody: PACKET.replace("claude-sandbox-child-egress-v1", "weaker") }],
  ["wrong host", { packetBody: PACKET.replace("ubuntu-22.04", "ubuntu-24.04") }],
  ["conflicting extra record", { packetBody: PACKET + '\n```json\n{"claudeQualification":{"controlIssue":1164,"executionIssue":1180,"oneShot":true,"scope":"x","host":"y"}}\n```\n' }],
  ["control advanced to REVIEW", { controlBody: CONTROL.replace("**Lifecycle:** READY", "**Lifecycle:** REVIEW") }],
  ["control has a PR pointer", { controlBody: CONTROL.replace("**PR:** none", "**PR:** #1200") }],
  ["control has a Stage 2 pointer", { controlBody: CONTROL.replace("**Stage 2:** none", "**Stage 2:** #1201") }],
  ["control points elsewhere", { controlBody: CONTROL.replace("#1180", "#1170") }],
]) {
  test(`refuses and mutates nothing: ${name}`, () => {
    const h = harness(over);
    const r = run(h);
    assert.equal(r.exitCode, 2);
    assert.equal(r.state, "REJECTED");
    assert.equal(h.log.length, 0);
  });
}

test("packet close failure leaves control unchanged and is resumable", () => {
  const h = harness();
  h.impls.closeImpl = () => {
    throw new Error("boom");
  };
  assert.equal(run(h).exitCode, 1);
  assert.equal(h.state.body, CONTROL);
});

test("resumes this tool's own earlier terminal write (OPEN control, DONE with marker)", () => {
  const h0 = harness();
  run(h0);
  const h = harness({ controlBody: h0.state.body, packetState: "CLOSED" });
  assert.equal(run(h).state, "TERMINALIZED");
});

test("does not close a control that a successor activation changed after the snapshot write", () => {
  const h = harness();
  const base = h.impls.readIssueImpl;
  let writes = 0;
  h.impls.ghEditImpl = ({ body }) => {
    writes++;
    h.state.body = body.replace("**Lifecycle:** DONE", "**Lifecycle:** READY");
  };
  const r = run(h);
  assert.equal(writes, 1);
  assert.equal(r.exitCode, 2);
  assert.equal(h.log.some((x) => x[0] === "close" && x[1] === 1164), false);
  void base;
});

test("comment pagination reads to exhaustion and fails closed at the safety bound", () => {
  const full = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i })));
  let calls = 0;
  const finite = (_c, args) => (++calls <= 3 ? full : JSON.stringify([{ id: 1 }]));
  assert.equal(defaultReadComments({ repo: "o/r", number: 1, execFileImpl: finite }).length, 301);
  assert.throws(() => defaultReadComments({ repo: "o/r", number: 1, execFileImpl: () => full }), /pagination bound reached/);
});

test("pure helpers", () => {
  assert.equal(packetHasQualificationRecord(PACKET, { controlIssue: 1164, executionIssue: 1180 }), true);
  assert.equal(selectNoGoResult([RESULT()], { controlIssue: 1164, executionIssue: 1180 }).ok, true);
  assert.match(buildNoGoTerminalControlBody(CONTROL, { executionIssue: 1180, attemptId: "a-1", url: null }), /Lifecycle:\*\* DONE/);
});

test("missing args are an operational error", () => {
  assert.equal(terminalizeNoGoPacket({ repo: "o/r" }, {}).exitCode, 1);
});
