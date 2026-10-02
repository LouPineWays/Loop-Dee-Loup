import { test } from "node:test";
import assert from "node:assert/strict";
import { runLauncherSupervisor, SupervisorOutcome } from "./launcher-supervisor.mjs";
import { Outcome, renderDecisionSurface, parseDecisionSurface } from "./launcher-step.mjs";
import { buildDeps, buildSupervisorDeps, dispatchFreshWorker, findStage2ReportCommentId, upsertResolvedDecisions } from "./launcher-run.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";
import { renderClaimBody, parseAttemptClaims, planClaim } from "./attempt-claim.mjs";
import { upsertControlBullet } from "./ready-dispatch-gate.mjs";
import { authorizeLauncherVerdict } from "./launcher-step.mjs";
const authorize = (v, a) => authorizeLauncherVerdict(v, a);
const reestablish = async () => ({ evidence: { dispatch: { route: "r", byReference: { guidance: null } } } });

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

test("a reviewer wait uses the canonical poller within the budget, re-reads the gate on a match, then stops WAITING", async () => {
  const waits = [];
  let t = 0;
  const wait = { kind: "issue", number: 825, repo: "o/r" };
  const r = await runLauncherSupervisor({
    waitBudgetMs: 3000,
    deps: {
      step: steps(R(Outcome.WAITING, { state: "NO_ACTION_YET", wait }), R(Outcome.WAITING, { state: "NO_ACTION_YET", wait })),
      waitForReviewer: async (w, budget) => {
        waits.push([w, budget]);
        t += 1500;
        return { matched: waits.length === 1 };
      },
      now: () => t,
    },
  });
  assert.equal(r.outcome, SupervisorOutcome.WAITING);
  assert.equal(waits.length, 2);
  assert.deepEqual(waits[0][0], wait);
  // no wait target -> never a hand-rolled sleep loop, just stop WAITING
  const r2 = await runLauncherSupervisor({ deps: { step: steps(R(Outcome.WAITING, { state: "NO_ACTION_YET" })), waitForReviewer: async () => assert.fail("no target"), now: () => 0 }, waitBudgetMs: 9000 });
  assert.equal(r2.outcome, SupervisorOutcome.WAITING);
});

test("findStage2ReportCommentId derives the latest NOT CLEAN reviewer report after the trigger", () => {
  const bot = "chatgpt-codex-connector[bot]";
  const c = (id, login, body, at) => ({ id, login, body, created_at: at });
  const comments = [
    c(1, "github-actions[bot]", "@codex review", "2026-10-01T00:00:00Z"),
    c(2, bot, "Starting #825.", "2026-10-01T00:01:00Z"),
    c(3, bot, "## Stage 2 Audit Report\n\nVerdict: NOT CLEAN\n\nFound a P1 defect in the launcher.", "2026-10-01T00:05:00Z"),
  ];
  assert.equal(findStage2ReportCommentId(comments), 3);
  assert.equal(findStage2ReportCommentId([comments[1], comments[2]]), null); // no trigger -> no derivable report
  assert.equal(findStage2ReportCommentId([comments[0], comments[1]]), null);
});

test("dispatchFreshWorker reserves the PR-head checkout for a Stage 1 findings correction, runs the worker there, and releases it", async () => {
  const calls = [];
  const gate = { state: "STAGE1_CORRECTION_REQUIRED", pr: 826, issue: 73, controlIssue: 379, correctionReason: "findings" };
  const binding = { path: "C:/wt/pr-826", token: "efb5522c", scriptPath: "C:/s.mjs" };
  const io = {
    node: (f, a, input) => {
      calls.push([f.split("/").pop(), a]);
      if (f.endsWith("session-entry-gate.mjs")) return JSON.stringify(gate);
      if (f.endsWith("pr-head-checkout-preflight.mjs") && a[0] === "--reserve-from-gate") return JSON.stringify({ ...gate, checkoutBinding: binding });
      if (f.endsWith("format-dispatch-prompt.mjs")) return input.includes("checkoutBinding") ? "PROMPT" : "NO-BINDING";
      return "";
    },
  };
  const ran = [];
  const dispatch = { route: "r", byReference: { state: "STAGE1_CORRECTION_REQUIRED", pr: 826, issue: 73, controlIssue: 379, correctionReason: "findings" } };
  const out = await dispatchFreshWorker({ dispatch, io, controlIssue: 379, executionIssue: 73, authorize, reestablish, env: { LDL_WORKER_COMMAND: JSON.stringify(["w"]) }, runWorker: (p, o) => ran.push([p, o.cwd]) });
  assert.equal(out.launched, true);
  assert.deepEqual(ran, [["PROMPT", "C:/wt/pr-826"]]);
  assert.deepEqual(calls.map((c) => c[0]), ["session-entry-gate.mjs", "pr-head-checkout-preflight.mjs", "format-dispatch-prompt.mjs", "pr-head-checkout-preflight.mjs"]);
  assert.deepEqual(calls[3][1], ["--release-binding", "efb5522c"]);
  // a failed reservation fails closed before any worker runs
  const bad = { node: (f) => (f.endsWith("session-entry-gate.mjs") ? JSON.stringify(gate) : JSON.stringify({ state: "CHECKOUT_BINDING_UNVERIFIED", reason: "locked" })) };
  await assert.rejects(dispatchFreshWorker({ dispatch, io: bad, controlIssue: 379, executionIssue: 73, authorize, reestablish, env: { LDL_WORKER_COMMAND: JSON.stringify(["w"]) }, runWorker: () => assert.fail("no worker") }), /reservation failed/);
});

test("upsertResolvedDecisions routes answers into one replaceable section", () => {
  const body = "- **Founder decision:** pending\n\n### Notes\nx\n";
  const once = upsertResolvedDecisions(body, { surfaceId: "S1", answers: { Q1: "A" }, generalComments: "ok" });
  assert.match(once, /### Resolved founder decisions[\s\S]*\*\*Surface S1 Answer Q1:\*\* A/);
  const twice = upsertResolvedDecisions(once, { surfaceId: "S1", answers: { Q1: "B" } });
  assert.doesNotMatch(twice, /Answer Q1:\*\* A/);
  assert.match(twice, /Answer Q1:\*\* B/);
  assert.match(twice, /### Notes/);
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
      if (/collaborators\/.*\/permission/.test(path)) return JSON.stringify({ permission: path.includes("lookalike") ? "read" : "write" });
      const m = /issues\/(\d+)\/comments/.exec(path);
      if (m) return JSON.stringify([m[1] === "379" ? w.controlComments.map((c, i) => ({ id: i + 1, body: typeof c === "string" ? c : c.body, user: { login: typeof c === "string" ? "founder" : c.login } })) : []]);
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
  const surface = renderDecisionSurface({ controlIssue: 379, surfaceId: "379-r1-abc123", questions: [{ id: "Q1", question: "A or B?", blocking: "scope", options: ["A", "B"], resolves: "scope" }] });
  assert.deepEqual(parseDecisionSurface(surface), { surfaceId: "379-r1-abc123", questionIds: ["Q1"], questions: [{ id: "Q1", options: ["A", "B"], resolves: "scope" }], controlIssue: 379 });
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
  // the answer itself is durable in the snapshot, not merely the cleared interrupt
  assert.match(w.control, /\*\*Surface 379-r1-abc123 Answer Q1:\*\* A/);
  assert.match(w.control, /### Settled decisions[^#]*- \*\*Decision scope:\*\* A/);
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

test("dispatchFreshWorker refuses a stale dispatch and reports no runner when none is configured", async () => {
  const io = { node: (f) => (f.endsWith("session-entry-gate.mjs") ? JSON.stringify({ state: "READY_TO_DISPATCH_PLANNING", executionIssue: 73 }) : "P") };
  const dispatch = { route: "r", byReference: { state: "READY_TO_DISPATCH", executionIssue: 73 } };
  assert.equal((await dispatchFreshWorker({ dispatch, io, controlIssue: 379, executionIssue: 73, authorize, reestablish, env: {} })).launched, false);
  await assert.rejects(dispatchFreshWorker({ dispatch, io, controlIssue: 379, executionIssue: 73, authorize, reestablish, env: { LDL_WORKER_COMMAND: '["w"]' }, runWorker: () => {} }), /stale dispatch/);
  assert.equal((await dispatchFreshWorker({ dispatch, io, controlIssue: 379, executionIssue: 73, authorize, reestablish, env: { LDL_WORKER_COMMAND: "not json" } })).launched, false);
});

// ---- Stage 2 #832 corrections ----

function freshDispatchHarness(fresh, want, { authorizeFn = authorize, reestablishFn = reestablish, route = "r" } = {}) {
  const ran = [];
  const io = { node: (f) => (f.endsWith("session-entry-gate.mjs") ? JSON.stringify(fresh) : "PROMPT") };
  const call = () =>
    dispatchFreshWorker({
      dispatch: { route, byReference: want },
      io, controlIssue: 379, executionIssue: 73, authorize: authorizeFn, reestablish: reestablishFn,
      env: { LDL_WORKER_COMMAND: '["w"]' }, runWorker: (p) => ran.push(p),
    });
  return { call, ran };
}

test("fresh-worker dispatch: an unchanged, independently authorized verdict dispatches", async () => {
  const v = { state: "READY_TO_DISPATCH_INTEGRATION", controlIssue: 379, executionIssue: 73, planIndexUrl: "u" };
  const h = freshDispatchHarness(v, { ...v, guidance: null });
  assert.equal((await h.call()).launched, true);
  assert.deepEqual(h.ran, ["PROMPT"]);
});

test("fresh-worker dispatch: changing, omitting, or adding ANY dispatch-defining value blocks dispatch", async () => {
  const base = {
    state: "READY_TO_DISPATCH_UNITS", controlIssue: 379, executionIssue: 73, pr: 5, head: "h1", auditIssue: 9,
    route: "r1", planIndexUrl: "p1", manifestCommentId: 11, manifestUrl: "m1", dispatchReadyUnitIds: ["A"], correctionReason: "findings",
  };
  for (const k of Object.keys(base).filter((x) => x !== "state")) {
    const changed = freshDispatchHarness({ ...base, [k]: Array.isArray(base[k]) ? ["B"] : typeof base[k] === "number" ? base[k] + 1 : `${base[k]}x` }, base);
    await assert.rejects(changed.call(), /stale dispatch|not authorized/, `changed ${k}`);
    const { [k]: _gone, ...without } = base;
    await assert.rejects(freshDispatchHarness(without, base).call(), /stale dispatch/, `omitted-fresh ${k}`);
    if (k !== "controlIssue" && k !== "executionIssue") await assert.rejects(freshDispatchHarness(base, without).call(), /stale dispatch/, `omitted-want ${k}`);
    assert.deepEqual(changed.ran, [], `no worker ran for ${k}`);
  }
  // a fresh verdict that is not itself authorized never dispatches, even when every reference matches
  await assert.rejects(freshDispatchHarness(base, base, { authorizeFn: () => ({ authorized: false, reason: "no" }) }).call(), /not authorized/);
  await assert.rejects(
    dispatchFreshWorker({ dispatch: { route: "r", byReference: base }, io: { node: () => JSON.stringify(base) }, controlIssue: 379, executionIssue: 73, env: { LDL_WORKER_COMMAND: '["w"]' }, runWorker: () => {} }),
    /no execution-authority check/,
  );
});

// ---- Stage 1 #833 corrections ----

test("fresh-worker dispatch: the qualified route and exact-target guidance are re-established, not reused", async () => {
  const v = { state: "STAGE2_CORRECTION_REQUIRED", controlIssue: 379, executionIssue: 73, auditIssue: 9, pr: 5 };
  const guidance = { commentId: 7, target: { kind: "stage2", ref: "#9", evidenceId: "e" } };
  const want = { ...v, guidance };
  const fresh = (route, g) => async () => ({ evidence: { dispatch: { route, byReference: { guidance: g } } } });
  const ok = freshDispatchHarness(v, want, { reestablishFn: fresh("r", guidance) });
  assert.equal((await ok.call()).launched, true);
  const r2 = freshDispatchHarness(v, want, { reestablishFn: fresh("other", guidance) });
  await assert.rejects(r2.call(), /qualified route changed/);
  for (const g of [null, { ...guidance, commentId: 8 }, { ...guidance, target: { ...guidance.target, evidenceId: "e2" } }]) {
    const h = freshDispatchHarness(v, want, { reestablishFn: fresh("r", g) });
    await assert.rejects(h.call(), /Chat guidance changed/);
    assert.deepEqual(h.ran, []);
  }
  const w = freshDispatchHarness(v, want, { reestablishFn: async () => ({ outcome: "WAITING", evidence: { reason: "guidance gone" } }) });
  await assert.rejects(w.call(), /no longer yields a dispatch/);
  await assert.rejects(freshDispatchHarness(v, want, { reestablishFn: null }).call(), /no open-path re-establishment/);
});

test("decision surface: duplicate ids, reserved option token, and wrong control are rejected; open-ended stays distinct", () => {
  const SID = "379-r1-abc123";
  const q = (id, extra = {}) => ({ id, question: "x?", blocking: "b", resolves: id.toLowerCase(), ...extra });
  assert.equal(renderDecisionSurface({ controlIssue: 379, surfaceId: SID, questions: [q("Q1"), q("Q1", { resolves: "other" })] }), null);
  assert.equal(renderDecisionSurface({ controlIssue: 379, surfaceId: SID, questions: [q("Q1", { options: ["A", "open"] })] }), null);
  const open = renderDecisionSurface({ controlIssue: 379, surfaceId: SID, questions: [q("Q1")] });
  assert.deepEqual(parseDecisionSurface(open, { controlIssue: 379 }).questions[0].options, []);
  assert.equal(parseDecisionSurface(open, { controlIssue: 380 }), null);
  const dupLine = "- **Question Q1:** y? (blocks: b; options: A | B; recommended: none; resolves: z)\n- **General comments:**";
  assert.equal(parseDecisionSurface(open.replace("- **General comments:**", dupLine)), null);
  assert.equal(parseDecisionSurface(open.replace("options: open", "options: A | open")), null);
});

test("PRODUCTION: only a writer-authored surface bound to this control is consumed; lookalikes cannot affect projection", async () => {
  const SID = "379-r1-abc123";
  const mk = (control) => renderDecisionSurface({ controlIssue: control, surfaceId: SID, questions: [{ id: "Q1", question: "A or B?", blocking: "scope", options: ["A", "B"], resolves: "scope" }] });
  const trusted = mk(379);
  const lookalike = trusted.replace("options: A | B", "options: A | B | Z").replace("resolves: scope", "resolves: other");
  const answerA = "- **Surface id:** 379-r1-abc123\n- **Answer Q1:** A";
  const run = async (comments) => {
    const w = world({ founderPending: true });
    w.phase = 3;
    w.controlComments = comments;
    const r = await runLauncherSupervisor({ deps: fakeBinding(w).deps, maxSteps: 2 });
    return { w, r };
  };
  let out = await run([trusted, { body: lookalike, login: "lookalike" }, answerA]);
  assert.match(out.w.control, /[*][*]Decision scope:[*][*] A/);
  assert.doesNotMatch(out.w.control, /Decision other/);
  out = await run([mk(380), answerA]);
  assert.equal(out.r.outcome, SupervisorOutcome.WAITING);
  assert.match(out.w.control, /[*][*]Founder decision:[*][*] pending/);
  out = await run([{ body: trusted, login: "lookalike" }, answerA]);
  assert.equal(out.r.outcome, SupervisorOutcome.WAITING);
  assert.match(out.w.control, /[*][*]Founder decision:[*][*] pending/);
  const dup = trusted.replace("- **General comments:**", "- **Question Q1:** y? (blocks: b; options: A | B; recommended: none; resolves: z)\n- **General comments:**");
  out = await run([dup, answerA]);
  assert.equal(out.r.outcome, SupervisorOutcome.WAITING);
  assert.match(out.w.control, /[*][*]Founder decision:[*][*] pending/);
});

test("founder resume: an answer with no deterministic projection stays pending and leaves governing state untouched", async () => {
  const w = world({ founderPending: true });
  w.phase = 3;
  const surface = renderDecisionSurface({ controlIssue: 379, surfaceId: "379-r1-abc123", questions: [{ id: "Q1", question: "A or B?", blocking: "scope" }] });
  w.controlComments = [surface, "- **Surface id:** 379-r1-abc123\n- **Answer Q1:** A"];
  const before = w.control;
  const r = await runLauncherSupervisor({ deps: fakeBinding(w).deps, maxSteps: 3 });
  assert.equal(r.outcome, SupervisorOutcome.WAITING);
  assert.match(r.reason, /not deterministically applicable/);
  assert.equal(w.control, before);
  assert.match(w.control, /\*\*Founder decision:\*\* pending/);
  assert.ok(!w.calls.some((c) => c[0].endsWith("session-entry-gate.mjs")));
});

test("founder resume: the interrupt is cleared only after the decision is applied and read back", async () => {
  const w = world({ founderPending: true });
  w.phase = 3;
  const surface = renderDecisionSurface({ controlIssue: 379, surfaceId: "379-r1-abc123", questions: [{ id: "Q1", question: "A or B?", blocking: "scope", options: ["A", "B"], resolves: "scope" }] });
  w.controlComments = [surface, "- **Surface id:** 379-r1-abc123\n- **Answer Q1:** C"];
  assert.equal((await runLauncherSupervisor({ deps: fakeBinding(w).deps, maxSteps: 2 })).outcome, SupervisorOutcome.WAITING); // off-option
  w.controlComments = [surface, "- **Surface id:** 379-r1-abc123\n- **Answer Q1:** B"];
  const control = w.control;
  await runLauncherSupervisor({ deps: fakeBinding(w).deps, maxSteps: 2 });
  assert.match(w.control, /\*\*Decision scope:\*\* B/);
  assert.match(w.control, /\*\*Founder decision:\*\* none/);
  assert.notEqual(w.control, control);
});
