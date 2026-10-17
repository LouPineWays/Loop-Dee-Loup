// Tests for tools/orchestration/convert-issue-pair.mjs -- issue #1244 (control #1211). Run with:
//   node --test tools/orchestration/convert-issue-pair.test.mjs
//
// The world is an in-memory repository; the REAL checkWriteControlSnapshot and activateControlPair
// run against it (only GitHub I/O and the fresh gate transport are injected), so these prove the
// composition, not a mock of it.

import test from "node:test";
import assert from "node:assert/strict";
import {
  convertIssuePair,
  classifySourceBody,
  classifyChildren,
  composeThickBody,
  composeControlBody,
  parentLoopRefs,
  markerFor,
  expectedThickTitle,
  renderProposedGrant,
  splitSections,
} from "./convert-issue-pair.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";
import { activateControlPair, findActiveGrantWitness } from "./activate-control-pair.mjs";
import { evaluateReadyDispatchGate, parseExecutionPointer, readExecutionBulletField } from "./ready-dispatch-gate.mjs";

const REPO = "owner/repo";
const FENCE = "```";
const INTAKE = `### What do you want added or changed?

> **As a new user, I want to convert one accepted Issue into a runnable pair, so that I can start quickly.**

**Minimum useful success:** one operation, two linked Issues.

### Why does it matter?

Removes bespoke setup. See #1 and #2.

### Evidence or example

- #3 needed manual setup.

### Priority horizon

Now
`;
const GRANT = { executorSubstrate: [{ component: "orchestration-lifecycle", paths: ["tools/orchestration/x.mjs"], intendedChange: "add x", verification: "tests" }] };

function makeWorld({ source = { number: 10, title: "[Idea] Convert one Issue", body: INTAKE, labels: ["priority:now", "idea-intake"] }, extra = [], prs = [] } = {}) {
  const issues = new Map();
  issues.set(source.number, { state: "OPEN", labels: [], isPr: false, ...source });
  for (const e of extra) issues.set(e.number, { state: "OPEN", labels: [], isPr: false, title: "", body: "", ...e });
  const calls = { create: 0, edits: [], gate: 0 };
  let next = Math.max(...issues.keys()) + 1;
  const failures = { createAfterMaterializing: false, writeThrows: false, writeNoop: false };
  const get = (n) => {
    const i = issues.get(Number(n));
    if (!i) throw new Error(`no such issue ${n}`);
    return i;
  };
  const readIssue = ({ number }) => ({ body: get(number).body, state: get(number).state });
  const ghEditImpl = ({ controlIssue, body }) => {
    calls.edits.push(controlIssue);
    if (failures.writeThrows) throw new Error("boom: transport down");
    if (!failures.writeNoop) get(controlIssue).body = body;
  };
  const deps = {
    readSource: ({ number }) => ({ ...get(number) }),
    readIssue,
    listIssues: () => [...issues.values()].filter((i) => !i.isPr).map(({ number, title, body, state }) => ({ number, title, body, state })),
    listLinkedPrs: ({ issue }) => prs.filter((p) => p.issue === issue),
    createIssue: ({ title, body }) => {
      calls.create += 1;
      const number = next++;
      issues.set(number, { number, title, body, state: "OPEN", labels: [], isPr: false });
      if (failures.createAfterMaterializing) {
        failures.createAfterMaterializing = false;
        throw new Error("network died after the Issue was created");
      }
      return { number };
    },
    writeSnapshot: (a) => checkWriteControlSnapshot(a, { ghEditImpl, readIssueImpl: readIssue }),
    activate: activateControlPair,
    activateDeps: {
      readIssueImpl: readIssue,
      ghEditImpl,
      runGateImpl: ({ controlIssue }) => {
        calls.gate += 1;
        const v = evaluateReadyDispatchGate(get(controlIssue).body, controlIssue);
        return { state: v.status, executionIssue: v.executionIssue, route: v.route };
      },
    },
  };
  return { issues, calls, failures, deps, get };
}

const run = (world, extra = {}) => convertIssuePair({ repo: REPO, sourceIssue: 10, founderAuthorized: true, ...extra }, world.deps);
const total = (world) => world.issues.size;

// ---- positive end to end ---------------------------------------------------------------------

test("positive: one authorized intake becomes exactly two linked Issues and a READY gate for `work on #10`", () => {
  const w = makeWorld();
  const r = run(w);
  assert.equal(r.state, "CONVERTED_READY", JSON.stringify(r));
  assert.equal(r.exitCode, 0);
  assert.equal(r.executable, true);
  assert.equal(r.workOn, "#10");
  assert.equal(r.gateState, "READY_TO_DISPATCH");
  assert.equal(total(w), 2, "exactly the original thin + one new thick");
  assert.equal(w.calls.create, 1);

  const thick = w.get(r.executionIssue);
  assert.equal(thick.title, "[Slice] Convert one Issue");
  assert.deepEqual(parentLoopRefs(thick.body, REPO), [{ repo: REPO, number: 10 }], "exact, sole Parent loop");
  assert.ok(thick.body.includes("As a new user, I want to convert one accepted Issue"), "accepted story translated verbatim");
  assert.ok(thick.body.includes("Removes bespoke setup. See #1 and #2."), "why translated");
  assert.ok(thick.body.includes("#3 needed manual setup."), "evidence translated");
  assert.ok(thick.body.includes(markerFor(REPO, 10)));
  assert.ok(!/^#{1,6}\s.*ACTIVE/m.test(thick.body), "no grant is ever invented");

  const control = w.get(10);
  const ptr = parseExecutionPointer(readExecutionBulletField(control.body).value);
  assert.deepEqual(ptr, { ok: true, issue: r.executionIssue });
  assert.ok(control.body.includes(INTAKE.trimEnd()), "original body preserved verbatim under Source item");
  assert.match(control.body, /- \*\*Priority:\*\* Now/);
  assert.match(control.body, /### State\n\nREADY/);
  assert.equal(control.state, "OPEN", "original Issue identity kept and not closed");
});

test("a source that is only the original Issue number needs no further questions: dry run shows the plan and writes nothing", () => {
  const w = makeWorld();
  const r = run(w, { dryRun: true });
  assert.equal(r.state, "DRY_RUN");
  assert.equal(w.calls.create, 0);
  assert.equal(w.calls.edits.length, 0);
  assert.equal(total(w), 1);
  assert.match(r.plan, /exactly one thick Issue/);
});

test("--bind-only binds and reads back but does not activate", () => {
  const w = makeWorld();
  const r = run(w, { bindOnly: true });
  assert.equal(r.state, "BOUND_NOT_ACTIVATED");
  assert.equal(r.executable, false);
  assert.equal(w.calls.gate, 0);
  assert.match(w.get(10).body, /### State\n\nPROPOSED/);
  assert.match(r.nextAction, /activate-control-pair\.mjs --control-issue 10 --execution-issue 11/);
});

// ---- authorization --------------------------------------------------------------------------

test("without explicit founder authorization nothing is created or changed", () => {
  const w = makeWorld();
  const r = run(w, { founderAuthorized: false });
  assert.equal(r.state, "NOT_AUTHORIZED");
  assert.equal(r.exitCode, 2);
  assert.equal(w.calls.create, 0);
  assert.equal(total(w), 1);
});

// ---- pending exact grant ----------------------------------------------------------------------

test("pending grant: same unique pair is retained, truthfully non-executable, never READY; then activates after promotion", () => {
  const w = makeWorld();
  const r = run(w, { proposedGrant: GRANT });
  assert.equal(r.state, "CONVERTED_PENDING_GRANT", JSON.stringify(r));
  assert.equal(r.exitCode, 0);
  assert.equal(r.executable, false);
  assert.equal(r.workOn, null);
  assert.match(r.nextAction, /write-thick-grant\.mjs/);
  assert.equal(total(w), 2);

  const e = r.executionIssue;
  const control = w.get(10).body;
  assert.deepEqual(parseExecutionPointer(readExecutionBulletField(control).value), { ok: true, issue: e }, "Execution pointer retained");
  assert.match(control, /### State\n\nNEEDS_FOUNDER/);
  assert.match(control, /\*\*Founder decision:\*\* Approve or decline the exact executor-substrate component grant/);
  assert.ok(!/- \*\*Lifecycle:\*\* READY/.test(control) && !/### State\n\nREADY/.test(control));
  assert.equal(w.calls.gate, 0, "no gate is run for a blocked activation");

  const thick = w.get(e).body;
  assert.match(thick, /^### PROPOSED executor-substrate grant/m);
  assert.equal(findActiveGrantWitness(thick).ok, false, "a proposed grant is never a witness");

  // Founder approval is recorded by the canonical grant writer (simulated here as its exact one-line heading change).
  w.get(e).body = thick.replace(/^### PROPOSED executor-substrate grant.*$/m, "### ACTIVE executor-substrate grant — founder-approved");
  const again = run(w, { proposedGrant: GRANT });
  assert.equal(again.state, "CONVERTED_READY", JSON.stringify(again));
  assert.equal(again.executionIssue, e);
  assert.equal(w.calls.create, 1, "re-entry created nothing");
  assert.equal(total(w), 2);
});

test("an invalid grant proposal is refused before anything is created", () => {
  const w = makeWorld();
  const r = run(w, { proposedGrant: { executorSubstrate: [{ component: "not-a-component" }] } });
  assert.equal(r.state, "BAD_GRANT_PROPOSAL");
  assert.equal(total(w), 1);
  assert.equal(renderProposedGrant(null).section, "");
});

// ---- replay / interruption / ambiguity --------------------------------------------------------

test("replay: converting an already converted Issue creates and writes nothing more", () => {
  const w = makeWorld();
  const first = run(w);
  const editsAfterFirst = w.calls.edits.length;
  const second = run(w);
  assert.equal(second.state, "CONVERTED_READY");
  assert.equal(second.executionIssue, first.executionIssue);
  assert.equal(w.calls.create, 1);
  assert.equal(w.calls.edits.length, editsAfterFirst, "no second body write");
  assert.equal(total(w), 2);
});

test("interruption: the writer fails after the thick Issue exists -> unbound partial state, never converted; re-run recovers the same child", () => {
  const w = makeWorld();
  w.failures.writeThrows = true;
  const r = run(w);
  assert.equal(r.state, "PARTIAL_THICK_CREATED");
  assert.equal(r.exitCode, 1);
  assert.equal(r.executable, false);
  assert.match(r.message, /unbound/);
  assert.equal(readExecutionBulletField(w.get(10).body).value ?? null, null, "Execution never set; not reported converted");
  w.failures.writeThrows = false;
  const again = run(w);
  assert.equal(again.state, "CONVERTED_READY", JSON.stringify(again));
  assert.equal(again.recovered, true);
  assert.equal(again.executionIssue, r.executionIssue);
  assert.equal(w.calls.create, 1, "no duplicate thick Issue");
  assert.equal(total(w), 2);
});

test("interruption: creation reports failure after the Issue materialized -> re-run recovers it", () => {
  const w = makeWorld();
  w.failures.createAfterMaterializing = true;
  const r = run(w);
  assert.equal(r.state, "CREATE_FAILED");
  assert.equal(total(w), 2);
  const again = run(w);
  assert.equal(again.state, "CONVERTED_READY");
  assert.equal(again.recovered, true);
  assert.equal(w.calls.create, 1);
  assert.equal(total(w), 2);
});

test("a writer that reports success but does not persist the pointer fails the readback", () => {
  const w = makeWorld();
  w.failures.writeNoop = true;
  const r = run(w);
  assert.equal(r.state, "BIND_READBACK_MISMATCH");
  assert.equal(r.exitCode, 1);
  assert.equal(r.executable, false);
});

test("concurrent edit of the source between read and bind is refused (stale source) and nothing is written to it", () => {
  const w = makeWorld();
  const original = w.deps.createIssue;
  w.deps.createIssue = (a) => {
    const out = original(a);
    w.get(10).body += "\nA concurrent edit.\n";
    return out;
  };
  const r = run(w);
  assert.equal(r.state, "STALE_SOURCE");
  assert.equal(r.exitCode, 2);
  assert.equal(w.calls.edits.length, 0);
  assert.ok(w.get(10).body.includes("A concurrent edit."));
  w.deps.createIssue = original;
  const again = run(w);
  assert.equal(again.state, "CONVERTED_READY", "re-run against the new source recovers the child");
  assert.equal(w.calls.create, 1);
});

const childBody = (parent, { marked = true, repo = REPO } = {}) => `### Parent loop\n\n${parent}\n\n### Observable outcome\n\nx\n\n${marked ? markerFor(repo, 10) + "\n" : ""}`;

test("ambiguity: two attributable children, a similarly titled Issue, an unmarked child, a closed child, a wrong-parent marker all fail closed", () => {
  const cases = {
    "two attributable": [{ number: 11, title: "a", body: childBody("#10") }, { number: 12, title: "b", body: childBody("#10") }],
    "similar title": [{ number: 11, title: "[Slice] Convert one Issue", body: "unrelated" }],
    "unmarked child": [{ number: 11, title: "other", body: childBody("#10", { marked: false }) }],
    "closed marked child": [{ number: 11, title: "other", state: "CLOSED", body: childBody("#10") }],
    "marker, wrong parent": [{ number: 11, title: "other", body: childBody("#99") }],
    "marker, parent in another repo": [{ number: 11, title: "other", body: childBody("https://github.com/other/repo/issues/10") }],
    "audit naming the source": [{ number: 11, title: "[Audit] x", body: "### Merged PR\n\n#50\n\n### Work issue\n\n#10\n\n### Verdict\n\nPENDING\n" }],
  };
  for (const [name, extra] of Object.entries(cases)) {
    const w = makeWorld({ extra });
    const r = run(w);
        assert.equal(r.state, "AMBIGUOUS_CHILDREN", `${name}: ${JSON.stringify(r)}`);
    assert.equal(w.calls.create, 0, name);
    assert.equal(w.calls.edits.length, 0, name);
  }
  // The other-repo parent is not this source's child at all, so it is simply ignored (not mistaken for an attributable one).
  const w = makeWorld({ extra: [{ number: 11, title: "other", body: childBody("https://github.com/other/repo/issues/10", { marked: false }) }] });
  const r = run(w);
  assert.equal(r.state, "CONVERTED_READY");
  assert.equal(w.calls.create, 1);
});

test("duplicate current packet for an already bound pair is refused and nothing changes", () => {
  const w = makeWorld();
  const first = run(w);
  w.issues.set(40, { number: 40, title: "dup", body: childBody("#10"), state: "OPEN", labels: [], isPr: false });
  const before = w.get(10).body;
  const r = run(w);
  assert.equal(r.state, "AMBIGUOUS_CHILDREN");
  assert.equal(w.get(10).body, before);
  assert.equal(first.state, "CONVERTED_READY");
});

test("wrong parent on the bound packet is refused", () => {
  const w = makeWorld();
  const first = run(w);
  w.get(first.executionIssue).body = childBody("#77");
  const r = run(w);
  assert.equal(r.state, "WRONG_PARENT");
});

test("wrong repository identity cannot produce a pair: a missing repo or a PR source fails before any write", () => {
  const w = makeWorld();
  assert.equal(convertIssuePair({ repo: "", sourceIssue: 10, founderAuthorized: true }, w.deps).state, "NO_REPO");
  w.get(10).isPr = true;
  assert.equal(run(w).state, "NOT_AN_ISSUE");
  assert.equal(total(w), 1);
});

// ---- unsupported: in-flight / completed -------------------------------------------------------

test("in-flight: a source with PR / Stage 1 / Stage 2 / mid-cycle lifecycle, or a linked PR/audit, is refused and left unchanged", () => {
  const ctl = (extra) => `### State\n\nREADY\n\n### Current state\n\n- **Execution:** #11\n- **Route:** implementation worker\n${extra}\n`;
  const shapes = {
    "open PR bullet": ctl("- **PR:** #55"),
    "stage 2 bullet": ctl("- **Stage 2:** #60"),
    "review lifecycle": ctl("- **PR:** none").replace("READY", "REVIEW"),
    "done lifecycle": ctl("- **PR:** none").replace("READY", "DONE"),
  };
  for (const [name, body] of Object.entries(shapes)) {
    const w = makeWorld({ source: { number: 10, title: "[Loop] x", body } });
    const before = w.get(10).body;
    const r = run(w);
    assert.equal(r.state, "UNSUPPORTED_IN_FLIGHT", `${name}: ${JSON.stringify(r)}`);
    assert.equal(r.exitCode, 2);
    assert.equal(w.get(10).body, before);
    assert.equal(w.calls.create, 0);
  }
  const linked = makeWorld({ prs: [{ issue: 10, number: 77 }] });
  assert.equal(run(linked).state, "UNSUPPORTED_IN_FLIGHT");
  assert.equal(linked.calls.create, 0);

  const boundLinked = makeWorld();
  run(boundLinked);
  boundLinked.deps.listLinkedPrs = ({ issue }) => (issue === 11 ? [{ number: 90 }] : []);
  const editsBefore = boundLinked.calls.edits.length;
  assert.equal(run(boundLinked).state, "UNSUPPORTED_IN_FLIGHT");
  assert.equal(boundLinked.calls.edits.length, editsBefore);
});

test("completed or non-intake sources are unsupported: CLOSED, an unbound existing control, a thick packet, an empty body", () => {
  const closed = makeWorld();
  closed.get(10).state = "CLOSED";
  assert.equal(run(closed).state, "UNSUPPORTED_COMPLETED");
  const unboundControl = makeWorld({ source: { number: 10, title: "[Loop] c", body: "### State\n\nPROPOSED\n\n### Current state\n\n- **Execution:** none\n- **PR:** none\n" } });
  const r = run(unboundControl);
  assert.equal(r.state, "UNSUPPORTED_CLASS");
  assert.match(r.message, /never reported as converted/);
  assert.equal(run(makeWorld({ source: { number: 10, title: "x", body: childBody("#3") } })).state, "UNSUPPORTED_CLASS");
  assert.equal(run(makeWorld({ source: { number: 10, title: "x", body: "  \n" } })).state, "UNSUPPORTED_CLASS");
});

// ---- pure units -----------------------------------------------------------------------------------

test("classifySourceBody distinguishes intake / bound / in-flight / not-intake", () => {
  assert.equal(classifySourceBody(INTAKE).kind, "INTAKE");
  assert.equal(classifySourceBody("a plain legacy issue body without headings").kind, "INTAKE");
  assert.deepEqual(classifySourceBody("### Current state\n\n- **Execution:** #4\n"), { kind: "BOUND", executionIssue: 4 });
  assert.equal(classifySourceBody("### Current state\n\n- **Execution:** #4 and #5\n").kind, "NOT_INTAKE");
  assert.equal(classifySourceBody("### Current state\n\n- **Execution:** #4\n- **Stage 1:** #9\n").kind, "IN_FLIGHT");
});

test("composeControlBody leaves the control valid for the canonical writer and thick body round-trips through the witness checks", () => {
  const thick = composeThickBody({ repo: REPO, sourceIssue: 10, sourceTitle: "[Idea] t", sourceBody: INTAKE, grantSection: renderProposedGrant(GRANT).section });
  assert.equal([...splitSections(thick).keys()].filter((k) => /^Parent loop$/.test(k)).length, 1);
  assert.deepEqual(parentLoopRefs(thick, REPO), [{ repo: REPO, number: 10 }]);
  const control = composeControlBody({ sourceIssue: 10, sourceTitle: "[Idea] t", sourceBody: INTAKE, executionIssue: 11 });
  assert.match(control, /- \*\*Execution:\*\* #11/);
  assert.equal(expectedThickTitle("[Idea] Foo"), "[Slice] Foo");
  const kids = classifyChildren([{ number: 11, title: "x", body: thick, state: "OPEN" }], { repo: REPO, sourceIssue: 10, expectedTitle: "none" });
  assert.deepEqual(kids.attributable, [11]);
});
