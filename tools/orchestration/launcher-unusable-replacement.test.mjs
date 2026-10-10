// Issue #888: the unattended launcher consumes the #985 unusable-response replacement states as
// verified closed-path transitions, end to end through buildDeps (gate -> authority -> read-back
// -> bounded canonical action -> independent postcondition), plus the compatibility guard that
// makes a newly machine-emittable closed-path state absent from the launcher visible.
//
// Tests: node --test tools/orchestration/launcher-unusable-replacement.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeps } from "./launcher-run.mjs";
import { runLauncherStep, Outcome, TRANSITIONS, OPEN_PATH_STATES } from "./launcher-step.mjs";
import { knownEnvelopeStates, getActionEnvelope, ENVELOPE_MODES } from "./action-envelope.mjs";

const PREP = "STAGE2_UNUSABLE_REPLACEMENT_PREPARATION_REQUIRED";
const READY = "STAGE2_UNUSABLE_REPLACEMENT_READY";
const RECOVERY = "tools/orchestration/unusable-audit-recovery.mjs";
const FINALIZE = "tools/orchestration/finalize-audit-breakpoint.mjs";
const TRIGGER = "tools/review-watch/trigger.mjs";

const prepVerdict = (over = {}) => ({
  state: PREP,
  stopAfter: true,
  repo: "o/r",
  controlIssue: 379,
  workIssue: 73,
  pr: 824,
  auditIssue: 381,
  predecessorAuditIssue: 381,
  nextCommand: `node ${RECOVERY} prepare --repo o/r --audit-issue 381`,
  ...over,
});
const readyVerdict = (over = {}) => ({
  ...prepVerdict(),
  state: READY,
  replacementAuditIssue: 390,
  nextCommand:
    `node ${FINALIZE} --control-issue 379 --execution-issue 73 --pr 824 --audit-issue 390 --stale-audit-issue 381 --revalidate-uniqueness true` +
    ` && node ${TRIGGER} --repo o/r --kind issue --number 390`,
  ...over,
});

// A small stateful world: the durable facts the real scripts would change. Scripts the launcher
// runs mutate it; the launcher's read-backs observe it. `recovery` overrides the evaluator.
function world({ gate, replacement = false, projected = false, triggered = false, recovery, noEffect = false } = {}) {
  const w = { replacement, projected, triggered, calls: [], gate: [...gate] };
  const count = (file) => w.calls.filter((c) => c[0] === file).length;
  w.count = count;
  const io = {
    node: (file, args) => {
      w.calls.push([file, ...args]);
      if (file.endsWith("control-plane-bootstrap.mjs")) return JSON.stringify(w.gate[Math.min(w.gate.length > 1 ? w.gateReads++ : 0, w.gate.length - 1)]);
      if (noEffect) return "";
      if (file === RECOVERY) w.replacement = true;
      if (file === FINALIZE) w.projected = true;
      if (file === TRIGGER) w.triggered = true;
      return "";
    },
    gh: (args) => {
      const path = args.at(-1);
      if (/collaborators/.test(path)) return JSON.stringify({ permission: "write" });
      if (/issues\/390\/comments/.test(path)) {
        return JSON.stringify([w.triggered ? [{ id: 1, body: "@codex review", user: { login: "u" }, created_at: "2026-10-01T00:00:00Z" }] : []]);
      }
      return JSON.stringify([[]]);
    },
  };
  w.gateReads = 0;
  const recov = () =>
    recovery ??
    (w.replacement
      ? { status: "REPLACEMENT_EXISTS", replacement: { number: 390, state: "OPEN", pending: true } }
      : { status: "ELIGIBLE", replacement: null });
  const readIssue = ({ number }) =>
    number === 379
      ? { body: `- **Lifecycle:** AUDIT\n- **Stage 2:** #${w.projected ? 390 : 381}\n`, state: "OPEN" }
      : { body: "", state: "OPEN" };
  w.deps = (executionIssue = 73) =>
    buildDeps({ controlIssue: 379, executionIssue, repo: "o/r", io, readIssue, readPr: () => null, readUnusableRecovery: async () => recov() });
  w.step = (executionIssue) => runLauncherStep({ controlIssue: 379, deps: w.deps(executionIssue) });
  const mutations = () => w.calls.filter((c) => [RECOVERY, FINALIZE, TRIGGER].includes(c[0]));
  w.mutations = mutations;
  return w;
}

test("preparation-required: absent replacement -> canonical prepare exactly once, postcondition read back, no worker", async () => {
  const w = world({ gate: [prepVerdict()] });
  const r = await w.step();
  assert.equal(r.outcome, Outcome.ADVANCED);
  assert.equal(r.successorEligible, true);
  assert.equal(w.count(RECOVERY), 1);
  assert.deepEqual(w.calls.find((c) => c[0] === RECOVERY), [RECOVERY, "prepare", "--repo", "o/r", "--audit-issue", "381"]);
  assert.equal(w.count(TRIGGER) + w.count(FINALIZE), 0);
});

test("preparation-required: replacement already created -> no duplicate creation", async () => {
  const w = world({ gate: [prepVerdict()], replacement: true });
  const r = await w.step();
  assert.equal(r.outcome, Outcome.ADVANCED);
  assert.equal(w.mutations().length, 0);
});

test("replacement-ready: created but unprojected/untriggered -> finalize/project then exactly one trigger", async () => {
  const w = world({ gate: [readyVerdict()], replacement: true });
  const r = await w.step();
  assert.equal(r.outcome, Outcome.ADVANCED);
  const order = w.mutations().map((c) => c[0]);
  assert.deepEqual(order, [FINALIZE, TRIGGER]);
  assert.deepEqual(w.calls.find((c) => c[0] === FINALIZE), [
    FINALIZE, "--control-issue", "379", "--execution-issue", "73", "--pr", "824",
    "--audit-issue", "390", "--stale-audit-issue", "381", "--revalidate-uniqueness", "true",
  ]);
  assert.equal(w.count(RECOVERY), 0);
});

test("replacement-ready: triggered but unprojected -> only the projection runs, never a second trigger", async () => {
  const w = world({ gate: [readyVerdict()], replacement: true, triggered: true });
  const r = await w.step();
  assert.equal(r.outcome, Outcome.ADVANCED);
  assert.deepEqual(w.mutations().map((c) => c[0]), [FINALIZE]);
});

test("replacement-ready: projected but untriggered -> exactly one canonical trigger", async () => {
  const w = world({ gate: [readyVerdict()], replacement: true, projected: true });
  const r = await w.step();
  assert.equal(r.outcome, Outcome.ADVANCED);
  assert.equal(w.count(TRIGGER), 1);
  assert.equal(w.count(RECOVERY), 0);
});

test("replacement-ready: postcondition already proved (stale verdict) -> no replay", async () => {
  const w = world({ gate: [readyVerdict()], replacement: true, projected: true, triggered: true });
  const r = await w.step();
  assert.equal(r.outcome, Outcome.ADVANCED);
  assert.equal(w.mutations().length, 0);
});

test("replacement already triggered and awaiting response -> ordinary WAITING, no replay", async () => {
  const w = world({ gate: [{ state: "NO_ACTION_YET", controlIssue: 379, repo: "o/r", auditIssue: 390 }], replacement: true, projected: true, triggered: true });
  const r = await w.step();
  assert.equal(r.outcome, Outcome.WAITING);
  assert.deepEqual(r.evidence.wait, { kind: "issue", number: 390, repo: "o/r" });
  assert.equal(w.mutations().length, 0);
});

test("second unusable response surfaces as the gate's founder-bounded stop: fail closed, no third audit", async () => {
  for (const state of ["STAGE2_RESPONSE_UNUSABLE", "AMBIGUOUS"]) {
    const w = world({ gate: [{ state, controlIssue: 379, repo: "o/r", auditIssue: 390 }], replacement: true, projected: true, triggered: true });
    const r = await w.step();
    assert.equal(r.outcome, Outcome.FAIL_CLOSED, state);
    assert.equal(w.mutations().length, 0, state);
  }
});

test("replacement CLEAN/NOT CLEAN flows into the ordinary lifecycle states the launcher already consumes", () => {
  assert.ok(TRANSITIONS.STAGE2_REPORT_READY_TO_RECORD && TRANSITIONS.STAGE2_CLOSE_READY);
  assert.ok(OPEN_PATH_STATES.has("STAGE2_CORRECTION_REQUIRED"));
});

test("an actually unknown state still fails closed with no mutation (negative control)", async () => {
  const w = world({ gate: [{ state: "STAGE2_FUTURE_UNKNOWN_STATE", controlIssue: 379, workIssue: 73 }] });
  const r = await w.step();
  assert.equal(r.outcome, Outcome.FAIL_CLOSED);
  assert.equal(w.mutations().length, 0);
});

test("wrong target / malformed payload / missing authority fail closed before any mutation", async () => {
  const cases = [
    ["prepare names a different audit", prepVerdict({ nextCommand: `node ${RECOVERY} prepare --repo o/r --audit-issue 999` })],
    ["prepare carries extra args", prepVerdict({ nextCommand: `node ${RECOVERY} prepare --repo o/r --audit-issue 381 --force true` })],
    ["prepare flag order differs", prepVerdict({ nextCommand: `node ${RECOVERY} prepare --audit-issue 381 --repo o/r` })],
    ["prepare is a different script", prepVerdict({ nextCommand: `node ${FINALIZE} --audit-issue 381` })],
    ["prepare repo differs", prepVerdict({ nextCommand: `node ${RECOVERY} prepare --repo x/y --audit-issue 381` })],
    ["prepare names no nextCommand", prepVerdict({ nextCommand: undefined })],
    ["prepare names no predecessor", prepVerdict({ predecessorAuditIssue: undefined })],
    ["different execution issue", prepVerdict({ workIssue: 99 })],
    ["different control issue", prepVerdict({ controlIssue: 999 })],
  ];
  for (const [label, verdict] of cases) {
    const w = world({ gate: [verdict] });
    const r = await w.step();
    assert.equal(r.outcome, Outcome.FAIL_CLOSED, label);
    assert.equal(r.successorEligible, false, label);
    assert.equal(w.mutations().length, 0, label);
  }
  const readyCases = [
    ["trigger names a different audit", readyVerdict({ nextCommand: readyVerdict().nextCommand.replace("--number 390", "--number 391") })],
    ["finalize names a different replacement", readyVerdict({ nextCommand: readyVerdict().nextCommand.replace("--audit-issue 390", "--audit-issue 391") })],
    ["finalize names a different PR", readyVerdict({ nextCommand: readyVerdict().nextCommand.replace("--pr 824", "--pr 825") })],
    ["only the trigger", readyVerdict({ nextCommand: `node ${TRIGGER} --repo o/r --kind issue --number 390` })],
    ["finalize injects another repo", readyVerdict({ nextCommand: readyVerdict().nextCommand.replace("--control-issue 379", "--repo other/repo --control-issue 379") })],
    ["finalize omits uniqueness revalidation", readyVerdict({ nextCommand: readyVerdict().nextCommand.replace(" --revalidate-uniqueness true", "") })],
    ["finalize disables uniqueness revalidation", readyVerdict({ nextCommand: readyVerdict().nextCommand.replace("--revalidate-uniqueness true", "--revalidate-uniqueness false") })],
    ["finalize reorders canonical flags", readyVerdict({ nextCommand: readyVerdict().nextCommand.replace("--control-issue 379 --execution-issue 73", "--execution-issue 73 --control-issue 379") })],
    ["trigger injects extra flag", readyVerdict({ nextCommand: readyVerdict().nextCommand.replace("--kind issue", "--dry-run true --kind issue") })],
    ["trigger reorders canonical flags", readyVerdict({ nextCommand: readyVerdict().nextCommand.replace("--repo o/r --kind issue", "--kind issue --repo o/r") })],
    ["replacement equals predecessor", readyVerdict({ replacementAuditIssue: 381 })],
  ];
  for (const [label, verdict] of readyCases) {
    const w = world({ gate: [verdict], replacement: true });
    const r = await w.step();
    assert.equal(r.outcome, Outcome.FAIL_CLOSED, label);
    assert.equal(w.mutations().length, 0, label);
  }
  // Reconciliation must validate the complete command before running its finalize-only segment.
  const stale = readyVerdict({
    nextCommand: readyVerdict().nextCommand.replace(" --revalidate-uniqueness true", ""),
  });
  const projectedLater = world({ gate: [stale], replacement: true, triggered: true });
  assert.equal((await projectedLater.step()).outcome, Outcome.FAIL_CLOSED);
  assert.equal(projectedLater.mutations().length, 0);
  // Launch request names a different execution issue than the verdict: refused, nothing run.
  const w = world({ gate: [prepVerdict()] });
  assert.equal((await w.step(555)).outcome, Outcome.FAIL_CLOSED);
  assert.equal(w.mutations().length, 0);
});

test("ambiguous or mismatched replacement provenance fails closed before mutation", async () => {
  const ambiguous = world({ gate: [prepVerdict()], recovery: { status: "AMBIGUOUS" } });
  assert.equal((await ambiguous.step()).outcome, Outcome.FAIL_CLOSED);
  assert.equal(ambiguous.mutations().length, 0);
  const other = world({
    gate: [readyVerdict()],
    replacement: true,
    recovery: { status: "REPLACEMENT_EXISTS", replacement: { number: 391, state: "OPEN", pending: true } },
  });
  assert.equal((await other.step()).outcome, Outcome.FAIL_CLOSED);
  assert.equal(other.mutations().length, 0);
});

test("postcondition not proved by read-back keeps the successor ineligible", async () => {
  for (const verdict of [prepVerdict(), readyVerdict()]) {
    const w = world({ gate: [verdict], replacement: verdict.state === READY, noEffect: true });
    const r = await w.step();
    assert.equal(r.outcome, Outcome.FAIL_CLOSED, verdict.state);
    assert.equal(r.successorEligible, false, verdict.state);
  }
});

// ---- Compatibility guard ------------------------------------------------------------------
// The authoritative machine-emittable vocabulary is the action-envelope table (every gate verdict
// state carries one). A bounded state whose authorized actions include no worker dispatch or
// checkout reservation is deterministic closed-path work: the unattended launcher must classify
// it (TRANSITIONS) or it must be named below as deliberately not launcher-consumed. A new
// closed-path state therefore fails here until one or the other is done, instead of failing only
// at runtime as "unrecognized verdict state". The exemptions are a shrinking exception list over
// the derived set, not a second lifecycle vocabulary.
const NOT_LAUNCHER_CONSUMED = Object.freeze({
  PR_BREAKPOINT_NEEDS_FINALIZATION: "pre-PR post-unit finalization; handled by the session-entry controller, not the post-PR launcher",
  READY_TO_PROJECT_NO_PR_COMPLETION: "no-PR completion with an execution-issue close; outside the launcher's post-PR scope",
  STAGE2_PREPARATION_BLOCKED_ON_STAGE1: "Stage 1 recovery; surfaces as a stop for the controller",
});

export function derivedClosedPathStates() {
  return knownEnvelopeStates().filter((state) => {
    const env = getActionEnvelope(state, {});
    return env.mode === ENVELOPE_MODES.BOUNDED && !env.authorizedActions.some((a) => /^(dispatch-|reserve-)/.test(a));
  });
}

test("compatibility guard: every derived closed-path lifecycle state is launcher-classified or explicitly exempt", () => {
  const missing = derivedClosedPathStates().filter((s) => !TRANSITIONS[s] && !NOT_LAUNCHER_CONSUMED[s]);
  assert.deepEqual(missing, [], `closed-path state(s) emittable by the gates but absent from launcher TRANSITIONS: ${missing.join(", ")}`);
  for (const s of Object.keys(NOT_LAUNCHER_CONSUMED)) {
    assert.ok(derivedClosedPathStates().includes(s) && !TRANSITIONS[s], `stale exemption ${s}`);
  }
  for (const s of [PREP, READY]) assert.ok(derivedClosedPathStates().includes(s) && TRANSITIONS[s], s);
});

test("compatibility guard: omitting launcher handling of an expected closed-path state is detected", () => {
  const without = Object.fromEntries(Object.entries(TRANSITIONS).filter(([s]) => s !== PREP));
  const missing = derivedClosedPathStates().filter((s) => !without[s] && !NOT_LAUNCHER_CONSUMED[s]);
  assert.deepEqual(missing, [PREP]);
});

test("compatibility guard: every launcher transition has an executor and a read-back (not just a table row)", async () => {
  const deps = buildDeps({
    controlIssue: 379,
    executionIssue: 73,
    repo: "o/r",
    io: { node: () => { throw new Error("stub"); }, gh: () => { throw new Error("stub"); } },
    readIssue: () => ({ body: "", state: "OPEN" }),
    readPr: () => null,
    verifyManifest: async () => ({ ok: false }),
    readUnusableRecovery: async () => ({ status: "AMBIGUOUS" }),
    readEvidenceCorrection: async () => ({ status: "AMBIGUOUS" }),
  });
  for (const [state, transition] of Object.entries(TRANSITIONS)) {
    await assert.rejects(deps.execute(transition, { state }), (e) => !/no executor for/.test(e.message), `executor ${state}`);
    const back = await deps.readEffect(transition, { state });
    assert.ok(!/no read-back for/.test(back?.reason ?? ""), `read-back ${state}`);
  }
});
