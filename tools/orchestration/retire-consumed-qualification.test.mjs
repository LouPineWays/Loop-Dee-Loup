// Tests for tools/orchestration/retire-consumed-qualification.mjs — issue #1198 (control #1197).
//
// Run with: node --test tools/orchestration/retire-consumed-qualification.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkRetireConsumedQualification,
  buildRetiredControlBody,
  readRetirementMarker,
  parentLoopReferences,
  RETIREMENT_RECORD_HEADING,
} from "./retire-consumed-qualification.mjs";
import { checkReadyDispatch, evaluateReadyDispatchGate } from "./ready-dispatch-gate.mjs";
import { validateControlSnapshot } from "./control-field-validator.mjs";

const REPO = "LouPineWays/Loop-Dee-Loup";
const C = 1164;
const P = 1180;
const ATTEMPT = "38682968969-1";
const bot = { login: "github-actions[bot]", type: "Bot" };
const human = { login: "someone", type: "User" };

// Shaped like live #1164: template "### State" heading, ad hoc bullets, a stale CLEAN Terminal result.
const CONTROL_BODY = `### Source item

Founder-directed setup.

### State

READY

### Current state

- **Execution:** #${P}
- **Route:** implementation worker
- **PR:** none
- **Stage 1:** none
- **Stage 2:** none
- **Founder decision:** none
- **Priority:** Now
- **Terminal result:** Backed CLEAN Stage 2 audit #1173 closed; work issue #1163 closed; control terminalized by tools/orchestration/close-control.mjs.

### Current blocker

none

---

Completed packet history (retired from current pointers when #${P} was activated): Execution #1163; PR #1172; Stage 2 #1173 — CLEAN, closed.
`;

const GRANT = { controlIssue: C, executionIssue: P, oneShot: true, scope: "claude-sandbox-child-egress-v1", host: "ubuntu-22.04" };
const packetBody = (grants = [GRANT], parent = `#${C} — sole governing thin control.`) =>
  ["### Parent loop", parent, "", "### Observable outcome", "One proof.", "", ...grants.map((g) => "```json\n" + JSON.stringify({ claudeQualification: g }, null, 2) + "\n```")].join("\n");

const claim = (id, o = {}) => ({
  id,
  user: o.user ?? bot,
  body: [
    "## Launch Attempt (v1)",
    "",
    `- **Attempt id:** ${o.attempt ?? ATTEMPT}`,
    `- **Authorization nonce:** ${o.nonce ?? `qualification-${P}`}`,
    "- **Claimed at:** 2026-10-15T04:44:13.440Z",
    `- **Runner:** ${o.runner ?? "github-actions"}`,
    `- **Phase:** ${o.phase ?? "DONE"}`,
    ...(o.outcome === null ? [] : [`- **Outcome:** ${o.outcome ?? "NO_GO"}`]),
    "",
  ].join("\n"),
});

const result = (id, o = {}) => ({
  id,
  user: o.user ?? bot,
  body: [
    "## Claude Qualification Result (v1)",
    "",
    `- **Verdict:** ${o.verdict ?? "NO-GO"}`,
    `- **Control issue:** #${o.control ?? C}`,
    `- **Proof packet:** #${o.packet ?? P}`,
    `- **Attempt id:** ${o.attempt ?? ATTEMPT}`,
    "- **Initiator:** LouPineWays",
    `- **Host:** ${o.host ?? "ubuntu-22.04"}`,
    "- **Child network egress:** allowed",
    `- **Reason:** ${o.reason ?? "child network egress was NOT denied"}`,
    "",
  ].join("\n"),
});

// In-memory GitHub: issues + comments, with injectable failures and call logs.
function world(over = {}) {
  const w = {
    issues: {
      [C]: { body: CONTROL_BODY, state: "OPEN" },
      [P]: { body: packetBody(), state: "OPEN" },
    },
    comments: {
      [C]: [claim(1, { phase: "CLAIMED", outcome: null }), result(2), claim(3)],
      [P]: [result(4)],
    },
    meta: { author: "LouPineWays", association: "OWNER", isPullRequest: false },
    permission: "admin",
    run: { status: "completed", conclusion: "failure" },
    fail: {},
    log: [],
    nextId: 100,
    ...over,
  };
  const guard = (name) => {
    if (w.fail[name]) {
      const f = w.fail[name];
      if (typeof f === "number") {
        w.fail[name] = f - 1 > 0 ? f - 1 : undefined;
      } else if (f === "once") {
        w.fail[name] = undefined;
      }
      throw new Error(`${name} failed`);
    }
  };
  w.impls = {
    readIssueImpl: ({ number }) => {
      guard("read");
      return { ...w.issues[number] };
    },
    readPacketMetaImpl: () => {
      guard("meta");
      return w.meta;
    },
    permissionForImpl: () => w.permission,
    listCommentsImpl: ({ number }) => {
      guard("list");
      return w.comments[number].map((c) => ({ ...c }));
    },
    readRunImpl: () => {
      guard("run");
      return w.run;
    },
    ghEditImpl: ({ controlIssue, body }) => {
      guard("edit");
      w.log.push(["edit", controlIssue]);
      if (!w.fail.silentEdit) w.issues[controlIssue].body = body;
    },
    commentImpl: ({ issue, body }) => {
      guard(`comment-${issue}`);
      w.log.push(["comment", issue]);
      w.comments[issue].push({ id: w.nextId++, user: { login: "LouPineWays", type: "User" }, body });
    },
    closeImpl: ({ issue }) => {
      guard(`close-${issue}`);
      w.log.push(["close", issue]);
      w.issues[issue].state = "CLOSED";
    },
    gateImpl: ({ repo, controlIssue }) =>
      checkReadyDispatch(
        { repo, controlIssue },
        {
          ghIssueViewImpl: ({ number }) => ({ ...w.issues[number] }),
          listCommentsImpl: ({ number }) => w.comments[number],
          ghPrListImpl: async () => [],
        },
      ),
  };
  w.writes = () => w.log.length;
  return w;
}

const run = (w, extra = {}) => checkRetireConsumedQualification({ repo: REPO, "control-issue": C, "execution-issue": P, ...extra }, w.impls);

// ------------------------------------------------------------------------------------------------

test("retires the consumed #1164/#1180 NO-GO end to end: terminal body, packet closed, control closed, gate non-dispatchable", async () => {
  const w = world();
  const r = await run(w);
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(r.state, "RETIRED");
  assert.equal(r.attemptId, ATTEMPT);
  assert.equal(r.verdict, "NO-GO");
  assert.deepEqual(r.completed, ["write-control-snapshot", "packet-record-comment", "close-packet", "close-control", "control-record-comment"]);
  // Ordering: the dispatch-relevant control body is made non-dispatchable FIRST, controls close last.
  assert.deepEqual(w.log.map((e) => e.join(":")), [`edit:${C}`, `comment:${P}`, `close:${P}`, `close:${C}`, `comment:${C}`]);
  assert.equal(w.issues[C].state, "CLOSED");
  assert.equal(w.issues[P].state, "CLOSED");
  const marker = readRetirementMarker(w.issues[C].body);
  assert.deepEqual(marker, { packet: P, attemptId: ATTEMPT });
  assert.match(w.issues[C].body, /not a worker PASS, no backed CLEAN Stage 2, no Campaign completion/);
  // Fresh gate: not any dispatch verdict.
  assert.equal(r.gateState, "NOT_READY");
  // Original claim/result comments are preserved byte-for-byte; two retirement records were added.
  assert.equal(w.comments[C].length, 3 + 1);
  assert.equal(w.comments[P].length, 1 + 1);
  assert.equal(w.comments[C].at(-1).body.split("\n")[0], RETIREMENT_RECORD_HEADING);
  // No CLEAN claim, no Stage 2 pointer, Execution pointer and history preserved.
  assert.match(w.issues[C].body, /- \*\*Execution:\*\* #1180/);
  assert.match(w.issues[C].body, /- \*\*Stage 2:\*\* none/);
  assert.match(w.issues[C].body, /Prior terminal result: Backed CLEAN Stage 2 audit #1173 closed/);
  assert.match(w.issues[C].body, /Completed packet history/);
});

test("the retirement record comments never parse as qualification evidence (no self-consumption loop)", async () => {
  const w = world();
  await run(w);
  const { collectQualificationEvidence } = await import("./ready-dispatch-gate.mjs");
  const before = collectQualificationEvidence({ controlComments: [claim(1), result(2), claim(3)], packetComments: [result(4)], controlIssue: C, executionIssue: P });
  const after = collectQualificationEvidence({ controlComments: w.comments[C], packetComments: w.comments[P], controlIssue: C, executionIssue: P });
  // Retirement records authored by a non-bot are ignored; evidence is unchanged.
  assert.deepEqual(after.results.map((x) => x.commentId), before.results.map((x) => x.commentId));
  assert.equal(after.conflicts.length, 0);
});

test("dry run verifies and plans without a single write", async () => {
  const w = world();
  const r = await run(w, { dryRun: true });
  assert.equal(r.exitCode, 0);
  assert.equal(r.state, "DRY_RUN_VERIFIED");
  assert.equal(r.pending.length, 5);
  assert.equal(w.writes(), 0);
  assert.equal(w.issues[C].state, "OPEN");
});

test("re-invocation after full retirement is ALREADY_TERMINAL and writes nothing", async () => {
  const w = world();
  await run(w);
  const logLen = w.writes();
  const again = await run(w);
  assert.equal(again.exitCode, 0);
  assert.equal(again.state, "ALREADY_TERMINAL");
  assert.equal(w.writes(), logLen);
  assert.equal(again.gateState, "NOT_READY");
});

test("resumes idempotently after a failure at each step (precise PARTIAL diagnosis, no false terminal claim)", async () => {
  const plans = [
    { fail: { edit: "once" }, step: "write-control-snapshot", after: [] },
    { fail: { [`comment-${P}`]: "once" }, step: "packet-record-comment", after: ["write-control-snapshot"] },
    { fail: { [`close-${P}`]: "once" }, step: "close-packet", after: ["write-control-snapshot", "packet-record-comment"] },
    { fail: { [`close-${C}`]: "once" }, step: "close-control", after: ["write-control-snapshot", "packet-record-comment", "close-packet"] },
  ];
  for (const { fail, step, after } of plans) {
    const w = world({ fail });
    const first = await run(w);
    assert.equal(first.exitCode, 1, step);
    assert.equal(first.state, "PARTIAL", step);
    assert.equal(first.failedStep, step);
    assert.deepEqual(first.completed, after);
    assert.ok(first.remaining.includes(step));
    assert.match(first.message, /Re-running the same command resumes/);
    // The control is never reported terminal while incomplete.
    assert.notEqual(w.issues[C].state === "CLOSED" && w.issues[P].state === "CLOSED", true, step);
    const second = await run(w);
    assert.equal(second.exitCode, 0, `${step}: ${JSON.stringify(second)}`);
    assert.equal(second.state, "RETIRED");
    assert.equal(w.issues[C].state, "CLOSED");
    assert.equal(w.issues[P].state, "CLOSED");
    // Comments are never duplicated by a resume.
    assert.equal(w.comments[P].filter((c) => c.body.startsWith(RETIREMENT_RECORD_HEADING)).length, 1, step);
    assert.equal(w.comments[C].filter((c) => c.body.startsWith(RETIREMENT_RECORD_HEADING)).length, 1, step);
    // And a third run is a pure no-op.
    const n = w.writes();
    assert.equal((await run(w)).state, "ALREADY_TERMINAL");
    assert.equal(w.writes(), n);
  }
});

test("a control already non-dispatchable (body written) while OPEN is the documented partial state and still resumes", async () => {
  const w = world({ fail: { [`comment-${P}`]: "once" } });
  const first = await run(w);
  assert.equal(first.state, "PARTIAL");
  assert.equal(w.issues[C].state, "OPEN");
  assert.equal(evaluateReadyDispatchGate(w.issues[C].body, C).status, "NOT_READY");
});

test("a failed control-record comment after both closes is a warning, never an un-terminalization", async () => {
  const w = world({ fail: { [`comment-${C}`]: "once" } });
  const r = await run(w);
  assert.equal(r.exitCode, 0);
  assert.equal(r.state, "RETIRED");
  assert.match(r.warning, /control record comment/);
  const again = await run(w);
  assert.equal(again.exitCode, 0);
  assert.equal(w.comments[C].filter((c) => c.body.startsWith(RETIREMENT_RECORD_HEADING)).length, 1);
});

test("a silently non-persisting write fails the independent readback: PARTIAL, nothing else mutated", async () => {
  const w = world({ fail: { silentEdit: true } });
  const r = await run(w);
  assert.equal(r.exitCode, 1);
  assert.equal(r.state, "PARTIAL");
  assert.equal(r.failedStep, "write-control-snapshot");
  assert.deepEqual(w.log.map((e) => e[0]), ["edit"]);
  assert.equal(w.issues[P].state, "OPEN");
  assert.equal(w.issues[C].state, "OPEN");
});

test("a fresh gate that would still authorize dispatch is reported PARTIAL, not success", async () => {
  const w = world();
  w.impls.gateImpl = async () => ({ exitCode: 0, state: "READY_TO_DISPATCH" });
  const r = await run(w);
  assert.equal(r.exitCode, 1);
  assert.equal(r.failedStep, "gate-verification");
  const w2 = world();
  w2.impls.gateImpl = async () => ({ exitCode: 1, message: "gate unreadable" });
  assert.equal((await run(w2)).failedStep, "gate-verification");
});

test("concurrent change between verification and the first write is STALE with no mutation", async () => {
  const w = world();
  let reads = 0;
  const base = w.impls.readIssueImpl;
  w.impls.readIssueImpl = (a) => {
    const r = base(a);
    if (a.number === C) {
      reads++;
      // The second control read (the pre-write re-read) sees a changed body.
      if (reads === 2) return { ...r, body: r.body + "\n- **Observed:** edited concurrently\n" };
    }
    return r;
  };
  const r = await run(w);
  assert.equal(r.exitCode, 2);
  assert.equal(r.state, "STALE");
  assert.equal(w.writes(), 0);
});

// ---- rejections: every shape leaves GitHub byte-for-byte unchanged ------------------------------

const REJECTIONS = [
  ["no claim at all", (w) => (w.comments[C] = [result(2)]), /exactly one trusted .* claim.*found 0/],
  ["duplicate claims for different attempts", (w) => w.comments[C].push(claim(9, { attempt: "38682968970-1" })), /found 2/],
  ["claim not settled", (w) => (w.comments[C] = [claim(1, { phase: "CLAIMED", outcome: null }), result(2)]), /not settled/],
  ["claim outcome is not NO_GO", (w) => (w.comments[C][2] = claim(3, { outcome: "PASS" })), /not NO_GO/],
  ["claim outcome absent", (w) => (w.comments[C][2] = claim(3, { outcome: null })), /not NO_GO/],
  ["claim nonce for another packet", (w) => (w.comments[C] = [claim(1, { nonce: "qualification-1163" }), result(2)]), /found 0/],
  ["claim from an untrusted author", (w) => (w.comments[C] = [claim(1, { user: human }), result(2)]), /found 0/],
  ["claim runner is not github-actions", (w) => (w.comments[C][2] = claim(3, { runner: "someone" })), /runner/],
  ["no result on the control", (w) => (w.comments[C] = [claim(1)]), /Result on control #1164, found 0/],
  ["no result on the packet", (w) => (w.comments[P] = []), /Result on packet #1180, found 0/],
  ["duplicate result on the control", (w) => w.comments[C].push(result(9)), /control #1164, found 2/],
  ["result is a PASS", (w) => { w.comments[C][1] = result(2, { verdict: "PASS" }); w.comments[P][0] = result(4, { verdict: "PASS" }); }, /not NO-GO/],
  ["result attempt id differs from the claim", (w) => { w.comments[C][1] = result(2, { attempt: "1-1" }); w.comments[P][0] = result(4, { attempt: "1-1" }); }, /does not match claim attempt/],
  ["control and packet results differ", (w) => (w.comments[P][0] = result(4, { reason: "something else" })), /not identical/],
  ["result from an untrusted author", (w) => (w.comments[P] = [result(4, { user: human })]), /Result on packet #1180, found 0/],
  ["result for another packet on the packet thread (conflict)", (w) => w.comments[P].push(result(8, { packet: 1163 })), /name a different pair/],
  ["wrong host", (w) => { w.comments[C][1] = result(2, { host: "ubuntu-24.04" }); w.comments[P][0] = result(4, { host: "ubuntu-24.04" }); }, /host/],
  ["Execution pointer names another packet", (w) => (w.issues[C].body = CONTROL_BODY.replace(`#${P}`, "#1163")), /not the packet #1180/],
  ["Execution pointer ambiguous (two pointers)", (w) => (w.issues[C].body = CONTROL_BODY.replace(`**Execution:** #${P}`, `**Execution:** #${P} and #1163`)), /Execution/],
  ["packet Parent loop binds another control", (w) => (w.issues[P].body = packetBody([GRANT], "#1999 — other")), /Parent loop/],
  ["packet Parent loop names two controls", (w) => (w.issues[P].body = packetBody([GRANT], "#1164 and #1999")), /Parent loop/],
  ["packet has no grant", (w) => (w.issues[P].body = "### Parent loop\n#1164\n"), /no claudeQualification grant/],
  ["packet has duplicate grants", (w) => (w.issues[P].body = packetBody([GRANT, GRANT])), /exactly one is required/],
  ["grant names another control", (w) => (w.issues[P].body = packetBody([{ ...GRANT, controlIssue: 1999 }])), /does not name exactly/],
  ["grant is not one-shot", (w) => (w.issues[P].body = packetBody([{ ...GRANT, oneShot: false }])), /not an exact one-shot/],
  ["grant wrong scope", (w) => (w.issues[P].body = packetBody([{ ...GRANT, scope: "x" }])), /not an exact one-shot/],
  ["grant wrong host", (w) => (w.issues[P].body = packetBody([{ ...GRANT, host: "ubuntu-24.04" }])), /not an exact one-shot/],
  ["control Lifecycle is not READY", (w) => (w.issues[C].body = CONTROL_BODY.replace("\nREADY\n", "\nREVIEW\n")), /only a stale READY control/],
  ["control Lifecycle already DONE without marker", (w) => (w.issues[C].body = CONTROL_BODY.replace("\nREADY\n", "\nDONE\n")), /only a stale READY control/],
  ["control has an in-flight PR", (w) => (w.issues[C].body = CONTROL_BODY.replace("**PR:** none", "**PR:** #1300")), /"PR" is "#1300"/],
  ["control has a Stage 2 pointer", (w) => (w.issues[C].body = CONTROL_BODY.replace("**Stage 2:** none", "**Stage 2:** #1301")), /"Stage 2"/],
  ["control closed without this tool's marker", (w) => (w.issues[C].state = "CLOSED"), /without this tool's terminal marker/],
  ["packet already closed without marker", (w) => (w.issues[P].state = "CLOSED"), /only an OPEN packet/],
  ["packet is a pull request", (w) => (w.meta = { ...w.meta, isPullRequest: true }), /pull request/],
  ["packet author is not a writer", (w) => { w.meta = { author: "rando", association: "NONE", isPullRequest: false }; w.permission = "read"; }, /not a repository writer/],
  ["control carries an active Blocker", (w) => (w.issues[C].body = CONTROL_BODY.replace("### Current blocker\n\nnone", "### Current blocker\n\nwaiting on #1500")), /active Blocker/],
  ["control carries an unresolved Founder decision", (w) => (w.issues[C].body = CONTROL_BODY.replace("**Founder decision:** none", "**Founder decision:** pick a host")), /unresolved Founder decision/],
  ["contradictory settled claims for one attempt", (w) => w.comments[C].push(claim(9, { outcome: "PASS" })), /contradictory settled claim/],
  ["grant naming a different packet is malformed, not absent", (w) => (w.issues[P].body = packetBody([{ ...GRANT, executionIssue: 1163 }])), /does not name exactly/],
  ["a conflicting packet retirement record already exists", (w) => w.comments[P].push({ id: 50, user: bot, body: [RETIREMENT_RECORD_HEADING, "", "- **Verdict:** PASS", `- **Control issue:** #${C}`, `- **Proof packet:** #${P}`, `- **Attempt id:** ${ATTEMPT}`, "- **Retired by:** tools/orchestration/retire-consumed-qualification.mjs", ""].join("\n") }), /conflicts with the canonical NO-GO record/],
  ["Actions run still in progress", (w) => (w.run = { status: "in_progress", conclusion: null }), /not completed/],
];

for (const [name, mutate, expected] of REJECTIONS) {
  test(`rejects with no mutation: ${name}`, async () => {
    const w = world();
    mutate(w);
    const before = JSON.stringify([w.issues, w.comments]);
    const r = await run(w);
    assert.equal(r.exitCode, 2, JSON.stringify(r));
    assert.equal(r.state, "REJECTED");
    assert.match(r.errors.join("\n"), expected);
    assert.equal(w.writes(), 0);
    assert.equal(JSON.stringify([w.issues, w.comments]), before);
  });
}

test("a marker for a different attempt on the control is rejected (never silently adopted)", async () => {
  const w = world();
  w.issues[C].body = buildRetiredControlBody(CONTROL_BODY, { executionIssue: P, attemptId: "1-1" });
  const r = await run(w);
  assert.equal(r.exitCode, 2);
  assert.match(r.errors.join("\n"), /terminal marker names packet/);
  assert.equal(w.writes(), 0);
});

test("unreadable facts are operational failures (exit 1), never a retirement and never a write", async () => {
  for (const fail of [{ read: "once" }, { meta: "once" }, { list: "once" }, { run: "once" }]) {
    const w = world({ fail });
    const r = await run(w);
    assert.equal(r.exitCode, 1, JSON.stringify(fail));
    assert.equal(r.state, "READ_FAILED");
    assert.equal(w.writes(), 0);
  }
});

test("argument validation: both Issues required, distinct, numeric", async () => {
  const w = world();
  for (const args of [{ "control-issue": C }, { "execution-issue": P }, { "control-issue": C, "execution-issue": C }, { "control-issue": "x", "execution-issue": P }]) {
    const r = await checkRetireConsumedQualification({ repo: REPO, ...args }, w.impls);
    assert.equal(r.exitCode, 1);
  }
  assert.equal(w.writes(), 0);
});

// ---- pure composition ----------------------------------------------------------------------------

test("terminal body: validator-clean, not dispatchable, preserves pointers and history (heading and bullet shapes)", () => {
  const out = buildRetiredControlBody(CONTROL_BODY, { executionIssue: P, attemptId: ATTEMPT });
  assert.ok(validateControlSnapshot(out, { controlIssue: C }).ok);
  assert.equal(evaluateReadyDispatchGate(out, C).status, "NOT_READY");
  assert.match(out, /### State\n\nDONE/);
  assert.match(out, /- \*\*Route:\*\* none/);
  assert.match(out, /- \*\*Execution:\*\* #1180/);
  assert.deepEqual(readRetirementMarker(out), { packet: P, attemptId: ATTEMPT });
  // Re-composing an already-retired body does not stack or duplicate the previous-result clause.
  const twice = buildRetiredControlBody(out, { executionIssue: P, attemptId: ATTEMPT });
  assert.equal((twice.match(/Prior terminal result:/g) ?? []).length, 1);

  const bulletShaped = `- **Lifecycle:** READY\n- **Execution:** #${P}\n- **Route:** implementation worker\n- **Blocker:** none\n- **Founder decision:** none\n`;
  const out2 = buildRetiredControlBody(bulletShaped, { executionIssue: P, attemptId: ATTEMPT });
  assert.match(out2, /- \*\*Lifecycle:\*\* DONE/);
  assert.ok(validateControlSnapshot(out2, { controlIssue: C }).ok);
  assert.equal(evaluateReadyDispatchGate(out2, C).status, "NOT_READY");
});

test("parentLoopReferences: unique refs in the Parent loop section only", () => {
  assert.deepEqual(parentLoopReferences(packetBody()), [C]);
  assert.deepEqual(parentLoopReferences("### Parent loop\n#1 and #2 and #1\n\n### Other\n#3"), [1, 2]);
  assert.deepEqual(parentLoopReferences("no heading #5"), []);
});

test("readRetirementMarker ignores the stale CLEAN terminal result and absent fields", () => {
  assert.equal(readRetirementMarker(CONTROL_BODY), null);
  assert.equal(readRetirementMarker(""), null);
});

test("close-control revalidates at the mutation boundary: a control reactivated for a successor is never closed", async () => {
  const w = world();
  const baseClose = w.impls.closeImpl;
  w.impls.closeImpl = (a) => {
    baseClose(a);
    if (a.issue === P) {
      // A separately authorized successor activation lands after the packet close.
      w.issues[C].body = CONTROL_BODY.replace(`#${P}`, "#1300");
    }
  };
  const r = await run(w);
  assert.equal(r.exitCode, 1);
  assert.equal(r.state, "PARTIAL");
  assert.equal(r.failedStep, "close-control");
  assert.equal(w.issues[C].state, "OPEN");
  assert.ok(!w.log.some(([k, n]) => k === "close" && n === C));
});
