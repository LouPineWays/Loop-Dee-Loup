import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNextCommand, buildDeps } from "./launcher-run.mjs";
import { runLauncherStep, Outcome } from "./launcher-step.mjs";

test("parseNextCommand accepts only chained node-tools commands with plain tokens", () => {
  const ok = parseNextCommand("node tools/review-watch/lifecycle-gate.mjs close-work-issue --repo o/r --issue 5 && node tools/review-watch/lifecycle-gate.mjs close-audit --repo o/r --audit-issue 9");
  assert.equal(ok.length, 2);
  assert.equal(ok[0].file, "tools/review-watch/lifecycle-gate.mjs");
  assert.deepEqual(ok[1].args, ["close-audit", "--repo", "o/r", "--audit-issue", "9"]);
  for (const bad of ["rm -rf /", "node tools/a.mjs; rm x", "node tools/a.mjs $(id)", "node ../x.mjs", "node tools/../x.mjs", "", undefined, "node tools/a.mjs `x`", "bash tools/a.mjs"]) {
    assert.throws(() => parseNextCommand(bad), undefined, String(bad));
  }
});

function fakeIo({ gateStates, prStates = ["OPEN", "MERGED"], headRef = "h1" }) {
  const calls = [];
  let g = 0, p = 0;
  return {
    calls,
    readPr: () => {
      calls.push(["readPr"]);
      return { state: prStates[Math.min(p++, prStates.length - 1)], headRefOid: headRef };
    },
    io: {
      node: (file, args, input) => {
        calls.push(["node", file, ...args]);
        if (file.endsWith("session-entry-gate.mjs")) return JSON.stringify(gateStates[Math.min(g++, gateStates.length - 1)]);
        return "";
      },
      gh: (args) => {
        calls.push(["gh", ...args]);
        return "";
      },
    },
  };
}

test("claimed launch advances: a projection runs the verdict's own body and is verified by reading the control body back", async () => {
  const proposedBody = "- **Lifecycle:** ROUTED\n";
  const verdict = { state: "READY_TO_PROJECT_ROUTED", controlIssue: 379, executionIssue: 73, proposedBody, actionEnvelope: {} };
  let body = "- **Lifecycle:** PLAN_READY\n";
  const { io, calls, readPr } = fakeIo({ gateStates: [verdict] });
  const nodeFn = io.node;
  io.node = (file, args, input) => {
    if (file.endsWith("write-control-snapshot.mjs")) body = input;
    return nodeFn(file, args, input);
  };
  const readIssue = () => ({ body, state: "OPEN" });
  const r = await runLauncherStep({ controlIssue: 379, deps: buildDeps({ controlIssue: 379, executionIssue: 73, readPr, readIssue, io }) });
  assert.equal(r.outcome, Outcome.ADVANCED);
  assert.ok(calls.some((c) => c[1] === "tools/orchestration/write-control-snapshot.mjs"));
});

test("a write that leaves the control body on the wrong successor is not proof: FAIL_CLOSED, no unlock", async () => {
  const verdict = { state: "READY_TO_PROJECT_ROUTED", controlIssue: 379, executionIssue: 73, proposedBody: "- **Lifecycle:** ROUTED\n" };
  const { io, readPr } = fakeIo({ gateStates: [verdict, { state: "READY_TO_DISPATCH_UNITS", controlIssue: 379 }] });
  const readIssue = () => ({ body: "- **Lifecycle:** BLOCKED\n", state: "OPEN" }); // gate state "changed", effect not there
  const r = await runLauncherStep({ controlIssue: 379, deps: buildDeps({ controlIssue: 379, executionIssue: 73, readPr, readIssue, io }) });
  assert.equal(r.outcome, Outcome.FAIL_CLOSED);
  assert.equal(r.successorEligible, false);
});

test("clean Stage 1 satisfied merges the exact authorized head after finalize + merge-ready gate", async () => {
  const verdict = { state: "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", controlIssue: 379, issue: 73, repo: "o/r", pr: 824, head: "h1" };
  const { io, calls, readPr } = fakeIo({ gateStates: [verdict], prStates: ["OPEN", "OPEN", "MERGED"] });
  const r = await runLauncherStep({ controlIssue: 379, deps: buildDeps({ controlIssue: 379, executionIssue: 73, readPr, io }) });
  assert.equal(r.outcome, Outcome.ADVANCED);
  const order = calls.map((c) => c[1]);
  assert.ok(order.indexOf("tools/orchestration/finalize-stage1-satisfied-breakpoint.mjs") < order.indexOf("tools/review-watch/merge-ready-gate.mjs"));
  const merge = calls.find((c) => c[0] === "gh" && c[1] === "pr" && c[2] === "merge");
  assert.ok(merge.includes("--match-head-commit") && merge.includes("h1"));
});

test("a head that moved since the verdict is never merged", async () => {
  const verdict = { state: "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2", controlIssue: 379, issue: 73, repo: "o/r", pr: 824, head: "h1" };
  const { io, calls, readPr } = fakeIo({ gateStates: [verdict], headRef: "h2" });
  const r = await runLauncherStep({ controlIssue: 379, deps: buildDeps({ controlIssue: 379, executionIssue: 73, readPr, io }) });
  assert.equal(r.outcome, Outcome.FAIL_CLOSED);
  assert.ok(!calls.some((c) => c[2] === "merge"));
});

test("a verdict for a different execution issue is refused before any mutation", async () => {
  const verdict = { state: "READY_TO_PROJECT_ROUTED", controlIssue: 379, executionIssue: 99, proposedBody: "BODY" };
  const { io, calls, readPr } = fakeIo({ gateStates: [verdict] });
  const r = await runLauncherStep({ controlIssue: 379, deps: buildDeps({ controlIssue: 379, executionIssue: 73, readPr, io }) });
  assert.equal(r.outcome, Outcome.FAIL_CLOSED);
  assert.ok(!calls.some((c) => c[1] === "tools/orchestration/write-control-snapshot.mjs"));
});

test("open-path verdict returns a by-reference dispatch with the gate's targets", async () => {
  const verdict = { state: "READY_TO_DISPATCH", controlIssue: 379, executionIssue: 73, route: "impl", repo: "o/r" };
  const { io, readPr } = fakeIo({ gateStates: [verdict] });
  const evidence = [{ route: "claude-subagent", outcomeClass: "bounded-implementation", verifiedClean: true, reworkRate: 0.1, founderInterventions: 0, relativeCost: 3, requiresLocalInference: false }];
  const r = await runLauncherStep({ controlIssue: 379, deps: buildDeps({ controlIssue: 379, executionIssue: 73, readPr, io, readEvidence: () => evidence }) });
  assert.equal(r.outcome, Outcome.OPEN_PATH_REQUIRED);
  assert.equal(r.evidence.dispatch.byReference.executionIssue, 73);
  assert.equal(r.evidence.dispatch.route, "claude-subagent");
});

// Issue #837 / PR #838: the launcher executes STAGE1_CORRECTION_FINALIZATION_REQUIRED by running
// only the canonical finalizer, verifying the exact disposition by read-back, and failing closed
// on head movement or a failed/absent projection.
const R_HEAD = "1111111111111111111111111111111111111111";
const C_HEAD = "2222222222222222222222222222222222222222";
const finalizationVerdict = (over = {}) => ({
  state: "STAGE1_CORRECTION_FINALIZATION_REQUIRED",
  controlIssue: 379,
  issue: 73,
  repo: "o/r",
  pr: 824,
  head: C_HEAD,
  reviewedHead: R_HEAD,
  correctedHead: C_HEAD,
  nextCommand: `node tools/orchestration/finalize-correction-breakpoint.mjs --control-issue 379 --execution-issue 73 --pr 824 --reviewed-head ${R_HEAD} --corrected-head ${C_HEAD}`,
  ...over,
});
const stranded = "- **Lifecycle:** REVIEW\n- **PR:** #824\n- **Stage 1:** requested\n";
const finalized = `- **Lifecycle:** REVIEW\n- **PR:** #824\n- **Stage 1:** correction-satisfied at ${C_HEAD} (reviewed ${R_HEAD})\n`;

test("correction finalization verdict: runs the canonical finalizer, verifies the read-back, and advances (no 'unrecognized verdict state')", async () => {
  let body = stranded;
  const { io, calls, readPr } = fakeIo({ gateStates: [finalizationVerdict()], headRef: C_HEAD, prStates: ["OPEN"] });
  const nodeFn = io.node;
  io.node = (file, args, input) => {
    if (file.endsWith("finalize-correction-breakpoint.mjs")) body = finalized;
    return nodeFn(file, args, input);
  };
  const r = await runLauncherStep({ controlIssue: 379, deps: buildDeps({ controlIssue: 379, executionIssue: 73, readPr, readIssue: () => ({ body, state: "OPEN" }), io }) });
  assert.equal(r.outcome, Outcome.ADVANCED);
  assert.equal(calls.filter((c) => c[1] === "tools/orchestration/finalize-correction-breakpoint.mjs").length, 1);
  assert.ok(!calls.some((c) => c[2] === "merge"));
});

test("correction finalization verdict: finalizer that leaves the disposition unprojected is not proof (FAIL_CLOSED)", async () => {
  const { io, readPr } = fakeIo({ gateStates: [finalizationVerdict()], headRef: C_HEAD, prStates: ["OPEN"] });
  const r = await runLauncherStep({ controlIssue: 379, deps: buildDeps({ controlIssue: 379, executionIssue: 73, readPr, readIssue: () => ({ body: stranded, state: "OPEN" }), io }) });
  assert.equal(r.outcome, Outcome.FAIL_CLOSED);
  assert.equal(r.successorEligible, false);
});

test("correction finalization verdict: a moved PR head fails closed and never runs the finalizer", async () => {
  const { io, calls, readPr } = fakeIo({ gateStates: [finalizationVerdict()], headRef: "3333333333333333333333333333333333333333", prStates: ["OPEN"] });
  const r = await runLauncherStep({ controlIssue: 379, deps: buildDeps({ controlIssue: 379, executionIssue: 73, readPr, readIssue: () => ({ body: stranded, state: "OPEN" }), io }) });
  assert.equal(r.outcome, Outcome.FAIL_CLOSED);
  assert.ok(!calls.some((c) => c[1] === "tools/orchestration/finalize-correction-breakpoint.mjs"));
});

test("correction finalization verdict: a nextCommand that is not the canonical finalizer for this launch is refused", async () => {
  const { io, calls, readPr } = fakeIo({
    gateStates: [finalizationVerdict({ nextCommand: `node tools/orchestration/finalize-correction-breakpoint.mjs --control-issue 379 --execution-issue 73 --pr 999 --reviewed-head ${R_HEAD} --corrected-head ${C_HEAD}` })],
    headRef: C_HEAD,
    prStates: ["OPEN"],
  });
  const r = await runLauncherStep({ controlIssue: 379, deps: buildDeps({ controlIssue: 379, executionIssue: 73, readPr, readIssue: () => ({ body: stranded, state: "OPEN" }), io }) });
  assert.equal(r.outcome, Outcome.FAIL_CLOSED);
  assert.ok(!calls.some((c) => c[1] === "tools/orchestration/finalize-correction-breakpoint.mjs"));
});

// ---- Issue #389 unit 389-B: managed-session capture at the launcher process boundary ----
import { dispatchFreshWorker as dispatchForRecords, parseTerminalResult, lifecycleStageForState } from "./launcher-run.mjs";
import { authorizeLauncherVerdict as authorizeForRecords } from "./launcher-step.mjs";
import { validateManagedSessionRecord } from "../telemetry/managed-session-record.mjs";

function recordHarness(fresh, { runWorker, persistRecord, env = { LDL_WORKER_COMMAND: '["w"]' }, routeProvenance } = {}) {
  const records = [];
  const io = { node: (f) => (f.endsWith("session-entry-gate.mjs") ? JSON.stringify(fresh) : "PROMPT") };
  const call = () =>
    dispatchForRecords({
      dispatch: { route: "r1", routeProvenance, byReference: { ...fresh, guidance: null } },
      io, controlIssue: 379, executionIssue: 73,
      authorize: (v, a) => authorizeForRecords(v, a),
      reestablish: async () => ({ evidence: { dispatch: { route: "r1", byReference: { guidance: null } } } }),
      env, runWorker, persistRecord: persistRecord ?? ((r) => records.push(r)),
    });
  return { call, records };
}

const RESULT_LINE = JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s-1", duration_ms: 1234, num_turns: 3, total_cost_usd: 0.5, result: "SECRET TEXT", usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { m: { inputTokens: 10, outputTokens: 5 } } });

test("parseTerminalResult / lifecycleStageForState", () => {
  assert.equal(parseTerminalResult(`noise\n${RESULT_LINE}\n`).session_id, "s-1");
  assert.equal(parseTerminalResult("no json"), null);
  assert.equal(parseTerminalResult(""), null);
  assert.equal(lifecycleStageForState("READY_TO_DISPATCH_PLANNING"), "PLAN");
  assert.equal(lifecycleStageForState("WHATEVER"), "OTHER");
});

test("planning, unit, and integration dispatches each yield attributable, valid records", async () => {
  const cases = [
    [{ state: "READY_TO_DISPATCH_PLANNING", controlIssue: 379, executionIssue: 73 }, "PLAN", 1, null],
    [{ state: "READY_TO_DISPATCH_UNITS", controlIssue: 379, executionIssue: 73, dispatchReadyUnitIds: ["A", "B"] }, "EXECUTE_UNIT", 2, "A"],
    [{ state: "READY_TO_DISPATCH_INTEGRATION", controlIssue: 379, executionIssue: 73 }, "INTEGRATE_PR", 1, null],
  ];
  for (const [fresh, stage, n, firstUnit] of cases) {
    const h = recordHarness(fresh, { runWorker: () => ({ exitCode: 0, stdout: `${RESULT_LINE}\n` }), routeProvenance: { qualification_ref: "cheapest qualified", fallback_used: true } });
    assert.equal((await h.call()).count, n);
    assert.equal(h.records.length, n);
    const r = h.records[0];
    assert.equal(validateManagedSessionRecord(r).valid, true);
    assert.equal(r.lifecycle_stage, stage);
    assert.equal(r.unit_id, firstUnit);
    assert.equal(r.control_issue, 379);
    assert.equal(r.execution_issue, 73);
    assert.equal(r.route, "r1");
    assert.deepEqual(r.route_provenance, { qualification_ref: "cheapest qualified", fallback_used: true, preferred_unavailable: null });
    assert.equal(r.terminal_result.available, true);
    assert.equal(r.provider_session_id, "s-1");
    assert.equal(r.economics.estimated_list_cost_usd, 0.5);
    assert.equal(JSON.stringify(r).includes("SECRET TEXT"), false);
    assert.equal(new Set(h.records.map((x) => x.run_id)).size, n);
  }
});

test("correction dispatch is attributed to its correction stage", async () => {
  const h = recordHarness({ state: "STAGE2_CORRECTION_REQUIRED", controlIssue: 379, executionIssue: 73, auditIssue: 9 }, { runWorker: () => {} });
  // guided correction needs verified guidance in the real flow; the harness bypasses it via reestablish.
  await h.call();
  assert.equal(h.records[0].lifecycle_stage, "STAGE2_CORRECTION");
});

test("no terminal result: record is explicitly incomplete with unavailable economics", async () => {
  const h = recordHarness({ state: "READY_TO_DISPATCH_PLANNING", controlIssue: 379, executionIssue: 73 }, { runWorker: () => {} });
  await h.call();
  const r = h.records[0];
  assert.equal(r.whole_run_complete, false);
  assert.equal(r.terminal_result.available, false);
  assert.equal(r.economics.usage, null);
  assert.equal(r.process.completion_state, "completed");
});

test("abnormal child: worker failure still rethrows and yields an explicitly incomplete record", async () => {
  const h = recordHarness({ state: "READY_TO_DISPATCH_INTEGRATION", controlIssue: 379, executionIssue: 73 }, {
    runWorker: () => { throw Object.assign(new Error("boom"), { status: 3 }); },
  });
  await assert.rejects(h.call(), /boom/);
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].process.completion_state, "failed");
  assert.equal(h.records[0].process.exit_code, 3);
  assert.equal(h.records[0].whole_run_complete, false);
  const sig = recordHarness({ state: "READY_TO_DISPATCH_INTEGRATION", controlIssue: 379, executionIssue: 73 }, {
    runWorker: () => { throw Object.assign(new Error("killed"), { signal: "SIGTERM" }); },
  });
  await assert.rejects(sig.call(), /killed/);
  assert.equal(sig.records[0].process.completion_state, "interrupted");
});

test("persistence failure (throw or ok:false) never changes the dispatch result", async () => {
  const fresh = { state: "READY_TO_DISPATCH_PLANNING", controlIssue: 379, executionIssue: 73 };
  const a = recordHarness(fresh, { runWorker: () => {}, persistRecord: () => { throw new Error("disk full"); } });
  assert.deepEqual(await a.call(), { launched: true, count: 1 });
  const b = recordHarness(fresh, { runWorker: () => {}, persistRecord: () => ({ ok: false, error: "x" }) });
  assert.deepEqual(await b.call(), { launched: true, count: 1 });
  const c = recordHarness(fresh, { runWorker: () => { throw new Error("worker failed"); }, persistRecord: () => { throw new Error("disk full"); } });
  await assert.rejects(c.call(), /worker failed/);
});

test("real default runner: captures stdout terminal result and exit state; non-zero exit still throws", async () => {
  const emit = (code) => JSON.stringify(["node", "-e", `console.log(${JSON.stringify(RESULT_LINE)});process.exit(${code})`]);
  const fresh = { state: "READY_TO_DISPATCH_PLANNING", controlIssue: 379, executionIssue: 73 };
  const ok = recordHarness(fresh, { env: { LDL_WORKER_COMMAND: emit(0) } });
  assert.deepEqual(await ok.call(), { launched: true, count: 1 });
  assert.equal(ok.records[0].terminal_result.available, true);
  assert.equal(ok.records[0].process.exit_code, 0);
  assert.equal(ok.records[0].whole_run_complete, true);
  const bad = recordHarness(fresh, { env: { LDL_WORKER_COMMAND: emit(2) } });
  await assert.rejects(bad.call(), /status 2/);
  assert.equal(bad.records[0].process.completion_state, "failed");
  const missing = recordHarness(fresh, { env: { LDL_WORKER_COMMAND: '["definitely-not-a-real-binary-389"]' } });
  await assert.rejects(missing.call());
  assert.equal(missing.records[0].process.completion_state, "spawn_failed");
});
