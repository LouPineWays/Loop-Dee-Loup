import { test } from "node:test";
import assert from "node:assert/strict";
import { runLauncherSupervisor, SupervisorOutcome } from "./launcher-supervisor.mjs";
import { Outcome, renderDecisionSurface, parseDecisionSurface } from "./launcher-step.mjs";
import { buildDeps, buildSupervisorDeps, dispatchFreshWorker } from "./launcher-run.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";
import { renderClaimBody, parseAttemptClaims, planClaim } from "./attempt-claim.mjs";
import { upsertControlBullet } from "./ready-dispatch-gate.mjs";

// ---------------------------------------------------------------------------------------------
// Pure supervisor routing
// ---------------------------------------------------------------------------------------------

const steps = (...rs) => {
  let i = 0;
  return () => rs[Math.min(i++, rs.length - 1)];
};
const R = (outcome, evidence = {}) => ({ outcome, successorEligible: outcome === Outcome.ADVANCED, evidence });
const dispatchResult = (state, extra = {}) =>
  R(Outcome.OPEN_PATH_REQUIRED, { state, dispatch: { role: "implementation worker", route: "claude-subagent", byReference: { state, executionIssue: 73, ...extra }, freshWorker: true, supervisorAuthors: false } });

test("the supervisor does not stop after one step: open path -> dispatch -> next breakpoint", async () => {
  const dispatched = [];
  const r = await runLauncherSupervisor({
    deps: {
      step: steps(dispatchResult("READY_TO_DISPATCH"), R(Outcome.ADVANCED, { state: "READY_TO_PROJECT_ROUTED" }), R(Outcome.WAITING, { state: "NO_ACTION_YET" })),
      dispatchWorker: async (d) => (dispatched.push(d), { launched: true }),
    },
  });
  assert.equal(dispatched.length, 1);
  assert.equal(r.outcome, SupervisorOutcome.WAITING);
  assert.equal(r.trail.filter((t) => t.outcome).length, 3);
});

test("an unchanged open path after a dispatch is no durable progress: FAIL_CLOSED", async () => {
  const r = await runLauncherSupervisor({
    deps: { step: steps(dispatchResult("READY_TO_DISPATCH")), dispatchWorker: async () => ({ launched: true }) },
  });
  assert.equal(r.outcome, SupervisorOutcome.FAIL_CLOSED);
  assert.match(r.reason, /no durable progress/);
});

test("no configured worker runner is a durable waiting boundary, not a silent success", async () => {
  const r = await runLauncherSupervisor({
    deps: { step: steps(dispatchResult("READY_TO_DISPATCH")), dispatchWorker: async () => ({ launched: false, reason: "no runner" }) },
  });
  assert.equal(r.outcome, SupervisorOutcome.WAITING);
  assert.equal(r.reason, "no runner");
});

test("guidance-required and fail-closed steps stop; same transition advancing twice is a loop", async () => {
  assert.equal(
    (await runLauncherSupervisor({ deps: { step: steps(R(Outcome.WAITING, { state: "STAGE2_CORRECTION_REQUIRED", chatGuidanceRequired: true, handoff: "h" })) } })).outcome,
    SupervisorOutcome.WAITING,
  );
  assert.equal((await runLauncherSupervisor({ deps: { step: steps(R(Outcome.FAIL_CLOSED, { reason: "x" })) } })).outcome, SupervisorOutcome.FAIL_CLOSED);
  const loop = await runLauncherSupervisor({ deps: { step: steps(R(Outcome.ADVANCED, { state: "READY_TO_PROJECT_ROUTED" })) } });
  assert.equal(loop.outcome, SupervisorOutcome.FAIL_CLOSED);
  assert.match(loop.reason, /twice/);
});

test("a reviewer wait polls within the budget and then stops WAITING", async () => {
  let slept = 0;
  let t = 0;
  const r = await runLauncherSupervisor({
    waitBudgetMs: 3000,
    pollIntervalMs: 1000,
    deps: { step: steps(R(Outcome.WAITING, { state: "NO_ACTION_YET" })), sleep: async (ms) => { slept += 1; t += ms; }, now: () => t },
  });
  assert.equal(r.outcome, SupervisorOutcome.WAITING);
  assert.ok(slept >= 2 && slept <= 3);
});

// ---------------------------------------------------------------------------------------------
// Production binding: buildDeps + buildSupervisorDeps over a fake durable world
// ---------------------------------------------------------------------------------------------

const REPO = "o/r";
const NOT_SETTLED = { ok: false, reason: "Execution Plan Index has no settled Dispatch manifest pointer (found: null)" };

function world({ founderPending = false } = {}) {
  const w = {
    phase: 0, // 0 open path, 1 manifest, 2 close, 3 terminal
    control: [
      "### Accepted outcome",
      "Carry one authorization to terminal CLEAN.",
      "",
      "- **Lifecycle:** READY",
      "- **Execution:** #73",
      "- **PR:** none",
      "- **Stage 1:** none",
      "- **Stage 2:** none",
      `- **Founder decision:** ${founderPending ? "pending" : "none"}`,
      "- **Terminal result:** none",
      "",
    ].join("\n"),
    controlState: "OPEN",
    manifest: false,
    audit: "OPEN",
    work: "OPEN",
    controlComments: [],
    calls: [],
    prepared: 0,
    workers: 0,
  };
  return w;
}

function gateFor(w) {
  if (w.phase === 1 && /Lifecycle:\*\* ROUTED/.test(w.control)) w.phase = 2; // the real gate advances past a routed control
  if (w.phase === 0) return { state: "READY_TO_DISPATCH", controlIssue: 379, executionIssue: 73, route: "impl", repo: REPO };
  if (w.phase === 1) {
    if (w.manifest) {
      return { state: "READY_TO_PROJECT_ROUTED", controlIssue: 379, executionIssue: 73, repo: REPO, proposedBody: upsertControlBullet(w.control, "Lifecycle", "ROUTED") };
    }
    return { state: "READY_TO_RUN_DISPATCH_MANIFEST", controlIssue: 379, executionIssue: 73, repo: REPO };
  }
  if (w.phase === 2) {
    return {
      state: "STAGE2_CLOSE_READY", controlIssue: 379, repo: REPO, auditIssue: 825, postAudit: { workIssue: 73 },
      nextCommand:
        "node tools/review-watch/lifecycle-gate.mjs close-work-issue --repo o/r --work-issue 73 --audit-issue 825 && node tools/review-watch/lifecycle-gate.mjs close-audit --repo o/r --audit-issue 825 && node tools/orchestration/close-control.mjs --repo o/r --control-issue 379 --audit-issue 825 --work-issue 73",
    };
  }
  return { state: "NO_ACTION_YET", controlIssue: 379 };
}

function fakeBinding(w, { failProjectionOnce = false } = {}) {
  let projectionFailed = false;
  const io = {
    node: (file, args, input) => {
      w.calls.push([file, ...args]);
      if (file.endsWith("session-entry-gate.mjs")) return JSON.stringify(gateFor(w));
      if (file.endsWith("format-dispatch-prompt.mjs")) return "PROMPT";
      if (file.endsWith("prepare-dispatch-manifest.mjs")) {
        w.manifest = true;
        w.prepared += 1;
        return "";
      }
      if (file.endsWith("write-control-snapshot.mjs")) {
        if (failProjectionOnce && !projectionFailed && /ROUTED/.test(input)) {
          projectionFailed = true;
          throw new Error("write failed");
        }
        // the REAL validator + persistence core, with an in-memory GitHub
        const res = checkWriteControlSnapshot({ repo: REPO, controlIssue: 379, proposedBody: input }, { ghEditImpl: ({ body }) => { w.control = body; } });
        if (res.exitCode !== 0) throw new Error(`write-control-snapshot refused: ${res.message ?? res.reasons}`);
        return "";
      }
      if (file.endsWith("lifecycle-gate.mjs")) {
        if (args[0] === "close-work-issue") w.work = "CLOSED";
        if (args[0] === "close-audit") w.audit = "CLOSED";
        return "";
      }
      if (file.endsWith("close-control.mjs")) {
        w.controlState = "CLOSED";
        w.control = upsertControlBullet(w.control, "Lifecycle", "DONE");
        w.phase = 3;
        return "";
      }
      throw new Error(`unexpected node call ${file}`);
    },
    gh: (args) => {
      w.calls.push(["gh", ...args]);
      const path = args[args.length - 1];
      if (/collaborators\/.*\/permission/.test(path)) return JSON.stringify({ permission: "write" });
      const m = /issues\/(\d+)\/comments/.exec(path);
      if (m) return JSON.stringify([m[1] === "379" ? w.controlComments.map((c, i) => ({ id: i + 1, body: c, user: { login: "founder" } })) : []]);
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
  };
  const readIssue = ({ number }) => {
    if (number === 379) return { body: w.control, state: w.controlState };
    if (number === 825) return { body: "", state: w.audit };
    if (number === 73) return { body: "", state: w.work };
    throw new Error(`unexpected issue ${number}`);
  };
  const verifyManifest = async () => (w.manifest ? { ok: true } : NOT_SETTLED);
  const readEvidence = () => [{ route: "claude-subagent", outcomeClass: "bounded-implementation", verifiedClean: true, reworkRate: 0.1, founderInterventions: 0, relativeCost: 3, requiresLocalInference: false }];
  const stepDeps = buildDeps({ controlIssue: 379, executionIssue: 73, io, repo: REPO, readIssue, readEvidence, verifyManifest, readPr: () => ({ state: "OPEN", headRefOid: "h" }) });
  const deps = buildSupervisorDeps({
    controlIssue: 379, executionIssue: 73, stepDeps, io, repo: REPO, readIssue,
    env: { LDL_WORKER_COMMAND: JSON.stringify(["worker"]) },
    runWorker: () => { w.workers += 1; w.phase = 1; }, // the fresh worker's durable effect: plan routed, manifest due
  });
  return { deps, io };
}

test("PRODUCTION: one authorization traverses an open-path worker, a manifest+projection transition, the Stage 2 close, and the terminal return", async () => {
  const w = world();
  w.control = upsertControlBullet(w.control, "Lifecycle", "PLAN_READY");
  const { deps } = fakeBinding(w);
  const r = await runLauncherSupervisor({ deps });
  assert.equal(r.outcome, SupervisorOutcome.TERMINAL_CLEAN, JSON.stringify(r));
  assert.equal(w.workers, 1, "exactly one fresh worker dispatched");
  assert.equal(w.prepared, 1);
  assert.match(w.control, /\*\*Terminal result:\*\* CLEAN/);
  assert.match(w.control, /\*\*Founder decision:\*\* none/);
  const states = r.trail.map((t) => t.state).filter(Boolean);
  assert.deepEqual(states, ["READY_TO_DISPATCH", "READY_TO_RUN_DISPATCH_MANIFEST", "STAGE2_CLOSE_READY"]);
  assert.equal(w.workers === 1 && w.audit === "CLOSED" && w.work === "CLOSED" && w.controlState === "CLOSED", true);
  assert.ok(w.calls.some((c) => c[0].endsWith("write-control-snapshot.mjs")));
});

test("PRODUCTION: manifest created but projection failed is finalized without recreating the manifest", async () => {
  const w = world();
  w.control = upsertControlBullet(w.control, "Lifecycle", "PLAN_READY");
  w.phase = 1;
  const { deps } = fakeBinding(w, { failProjectionOnce: true });
  const first = await runLauncherSupervisor({ deps, maxSteps: 1 });
  assert.equal(first.outcome, SupervisorOutcome.FAIL_CLOSED);
  assert.equal(w.prepared, 1);
  assert.doesNotMatch(w.control, /\*\*Lifecycle:\*\* ROUTED/);
  w.phase = 1; // a fresh launch observes: manifest present, control not ROUTED
  const second = await runLauncherSupervisor({ deps, maxSteps: 2 });
  assert.equal(w.prepared, 1, "the manifest is never recreated");
  assert.doesNotMatch(w.control, /Lifecycle:\*\* PLAN_READY/, "ROUTED projection was finalized");
  assert.notEqual(second.outcome, SupervisorOutcome.FAIL_CLOSED, JSON.stringify(second));
});

test("PRODUCTION: Stage 2 close with audit/work closed but control open reconciles only the control terminalization", async () => {
  const w = world();
  w.phase = 2;
  w.audit = "CLOSED";
  w.work = "CLOSED";
  const { deps } = fakeBinding(w);
  const r = await runLauncherSupervisor({ deps });
  assert.equal(r.outcome, SupervisorOutcome.TERMINAL_CLEAN, JSON.stringify(r));
  assert.deepEqual(w.calls.filter((c) => c[0].endsWith("lifecycle-gate.mjs")), [], "closed effects are never replayed");
  assert.equal(w.controlState, "CLOSED");
});

test("PRODUCTION: a wrong-successor gate change never unlocks (verdict proposes a different Lifecycle)", async () => {
  const w = world();
  w.phase = 1;
  w.manifest = true;
  const { deps, io } = fakeBinding(w);
  const orig = io.node;
  io.node = (file, ...rest) => {
    if (file.endsWith("session-entry-gate.mjs")) {
      return JSON.stringify({ ...gateFor(w), proposedBody: upsertControlBullet(w.control, "Lifecycle", "EXECUTING") });
    }
    return orig(file, ...rest);
  };
  const r = await runLauncherSupervisor({ deps, maxSteps: 3 });
  assert.equal(r.outcome, SupervisorOutcome.FAIL_CLOSED);
  assert.doesNotMatch(w.control, /EXECUTING/);
});

test("PRODUCTION: founder resolution resumes through the production path only when one continuation remains", async () => {
  const w = world({ founderPending: true });
  w.phase = 3;
  const surface = renderDecisionSurface({ controlIssue: 379, surfaceId: "379-r1-abc123", questions: [{ id: "Q1", question: "A or B?", blocking: "scope" }] });
  assert.deepEqual(parseDecisionSurface(surface), { surfaceId: "379-r1-abc123", questionIds: ["Q1"] });
  // unanswered -> WAITING, no step taken
  w.controlComments = [surface];
  let b = fakeBinding(w);
  let r = await runLauncherSupervisor({ deps: b.deps });
  assert.equal(r.outcome, SupervisorOutcome.WAITING);
  assert.ok(!w.calls.some((c) => c[0].endsWith("session-entry-gate.mjs")));
  // answered by a writer -> the cleared decision is durable, then the gate step runs
  w.controlComments = [surface, "- **Surface id:** 379-r1-abc123\n- **Answer Q1:** A"];
  b = fakeBinding(w);
  r = await runLauncherSupervisor({ deps: b.deps, maxSteps: 3 });
  assert.match(w.control, /\*\*Founder decision:\*\* none/);
  assert.ok(w.calls.some((c) => c[0].endsWith("session-entry-gate.mjs")));
  // a control that names a different execution issue has zero authorized continuations
  const w2 = world({ founderPending: true });
  w2.control = upsertControlBullet(w2.control, "Execution", "#99");
  w2.controlComments = [surface, "- **Surface id:** 379-r1-abc123\n- **Answer Q1:** A"];
  r = await runLauncherSupervisor({ deps: fakeBinding(w2).deps });
  assert.equal(r.outcome, SupervisorOutcome.WAITING);
  assert.match(r.reason, /no authorized continuation/);
});

test("PRODUCTION: duplicate/replayed triggers still cannot start a second run once the attempt settled", () => {
  const settled = renderClaimBody({ attemptId: "1-1", nonce: "n1", claimedAt: "t", runner: "github-actions", phase: "DONE", outcome: "TERMINAL_CLEAN" });
  const claims = parseAttemptClaims([{ id: 1, body: settled, author: "github-actions[bot]" }]);
  assert.equal(planClaim(claims, {}, { attemptId: "2-1", nonce: "n1" }).action, "REPLAY");
});

test("dispatchFreshWorker refuses a stale dispatch and reports no runner when none is configured", () => {
  const io = { node: (f) => (f.endsWith("session-entry-gate.mjs") ? JSON.stringify({ state: "READY_TO_DISPATCH_PLANNING", executionIssue: 73 }) : "P") };
  const dispatch = { route: "r", byReference: { state: "READY_TO_DISPATCH", executionIssue: 73 } };
  assert.equal(dispatchFreshWorker({ dispatch, io, controlIssue: 379, env: {} }).launched, false);
  assert.throws(() => dispatchFreshWorker({ dispatch, io, controlIssue: 379, env: { LDL_WORKER_COMMAND: '["w"]' }, runWorker: () => {} }), /stale dispatch/);
  assert.equal(dispatchFreshWorker({ dispatch, io, controlIssue: 379, env: { LDL_WORKER_COMMAND: "not json" } }).launched, false);
});
