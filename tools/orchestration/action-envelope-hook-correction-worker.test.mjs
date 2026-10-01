// Tests for the Stage 1 correction of PR #765 (issue #764, control #577): the correction-completion
// postcondition is bound to the actual dispatched correction worker, is monotonic across worker
// activity, has a genuinely bounded retry budget, and blocked stops leave no telemetry sample.
//
// Run with: node --test tools/orchestration/action-envelope-hook-correction-worker.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "action-envelope-hook.mjs");

const CORRECTION_VERDICT = {
  state: "STAGE1_CORRECTION_REQUIRED",
  correctionReason: "findings",
  pr: 763,
  controlIssue: 726,
  issue: 725,
  head: "fb32d7faad47284e45689ce3a0710e8433b6555c",
  actionEnvelope: { mode: "bounded", authorizedActions: ["reserve-correction-checkout", "dispatch-correction-worker"] },
};
const COMPLETION = { pr: 763, controlIssue: 726, executionIssue: 725, reviewedHead: "r", blocks: 0 };
const bad = () => ({ ok: false, detail: "Stage 1 is requested" });

test("SubagentStart binds the correction worker; a helper's start/stop neither rebinds nor spends the budget", async () => {
  const { writeMarker, recordSubagentDispatchStart, decideSubagentStop } = await import("./action-envelope-hook.mjs");
  const impls = { mkdirImpl: () => {}, writeFileImpl: () => {} };
  const marker = writeMarker("s1", CORRECTION_VERDICT, impls);
  const exhausted = recordSubagentDispatchStart("s1", marker, { ...impls, agentId: "worker-1" });
  assert.equal(exhausted.mode, "none");
  assert.equal(exhausted.correctionCompletion.workerAgentId, "worker-1");
  assert.equal(recordSubagentDispatchStart("s1", exhausted, { ...impls, agentId: "helper-9" }), null);
  const helper = decideSubagentStop(exhausted, { verifyImpl: () => assert.fail("helper must not verify"), agentId: "helper-9" });
  assert.equal(helper.action, "allow");
  assert.equal(exhausted.correctionCompletion.blocks, 0);
  assert.equal(decideSubagentStop(exhausted, { verifyImpl: bad, agentId: "worker-1" }).action, "block");
  assert.equal(decideSubagentStop(exhausted, { verifyImpl: bad }).action, "allow");
});

test("worker-originated gate observation cannot erase the active postcondition; a controller re-dispatch replaces it", async () => {
  const { writeMarker } = await import("./action-envelope-hook.mjs");
  const impls = { mkdirImpl: () => {}, writeFileImpl: () => {} };
  const existing = { correctionCompletion: { ...COMPLETION, workerAgentId: "w1" } };
  const gateVerdict = { state: "NO_ACTION_YET", actionEnvelope: { mode: "none", authorizedActions: [] } };
  assert.equal(writeMarker("s", gateVerdict, { ...impls, existingMarker: existing, workerOriginated: true }).correctionCompletion.workerAgentId, "w1");
  assert.equal(writeMarker("s", gateVerdict, { ...impls, existingMarker: existing }).correctionCompletion.workerAgentId, "w1");
  assert.equal(
    writeMarker("s", CORRECTION_VERDICT, { ...impls, existingMarker: existing, workerOriginated: true }).correctionCompletion.workerAgentId,
    "w1",
  );
  const redispatch = writeMarker("s", CORRECTION_VERDICT, { ...impls, existingMarker: existing });
  assert.equal(redispatch.correctionCompletion.workerAgentId, undefined);
  assert.equal(redispatch.correctionCompletion.pr, 763);
});

test("handleSubagentStop: retry-counter persistence failure terminates fail-closed, never an unbounded block", async () => {
  const { handleSubagentStop } = await import("./action-envelope-hook.mjs");
  const marker = { correctionCompletion: { ...COMPLETION, workerAgentId: "w1" } };
  const payload = { session_id: "s1", agent_id: "w1" };
  const decideImpl = () => ({ action: "block", blocks: 1, reason: "r" });
  const ok = handleSubagentStop(payload, { readMarkerImpl: () => marker, decideImpl, writeFileImpl: () => {} });
  assert.equal(JSON.parse(ok.stdout).decision, "block");
  const failed = handleSubagentStop(payload, {
    readMarkerImpl: () => marker,
    decideImpl,
    writeFileImpl: () => {
      throw new Error("EACCES");
    },
  });
  const out = JSON.parse(failed.stdout);
  assert.equal(out.continue, false);
  assert.match(out.stopReason, /^CORRECTION_BREAKPOINT_UNVERIFIED 763/);
  assert.equal(out.decision, undefined);
});

test("handleSubagentStop: telemetry forwarded only for allowed/terminal stops, never a blocked attempt", async () => {
  const { handleSubagentStop } = await import("./action-envelope-hook.mjs");
  const marker = { correctionCompletion: { ...COMPLETION, workerAgentId: "w1" } };
  const io = { readMarkerImpl: () => marker, writeFileImpl: () => {} };
  const stop = (decision) => handleSubagentStop({ session_id: "s", agent_id: "w1" }, { ...io, decideImpl: () => decision });
  assert.equal(stop({ action: "block", blocks: 1, reason: "x" }).forwardTelemetry, false);
  assert.equal(stop({ action: "allow", verified: true }).forwardTelemetry, true);
  assert.equal(stop({ action: "stop", blocks: 2, reason: "x" }).forwardTelemetry, true);
  assert.equal(handleSubagentStop({ session_id: "s", agent_id: "helper" }, { ...io }).forwardTelemetry, true);
});

test("forwardSubagentStopToTelemetry replays the payload; a missing script or failure is ignored", async () => {
  const { forwardSubagentStopToTelemetry } = await import("./action-envelope-hook.mjs");
  const seen = [];
  assert.equal(
    forwardSubagentStopToTelemetry({ a: 1 }, { existsImpl: () => true, execFileImpl: (_n, _a, o) => seen.push(o.input) }),
    true,
  );
  assert.equal(seen[0], JSON.stringify({ a: 1 }));
  assert.equal(forwardSubagentStopToTelemetry({}, { existsImpl: () => false }), false);
  const boom = () => {
    throw new Error("x");
  };
  assert.equal(forwardSubagentStopToTelemetry({}, { existsImpl: () => true, execFileImpl: boom }), false);
});

test("hook process: helper stop is silent with budget untouched; settings wire SubagentStop only through the envelope hook", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-hook-764b-"));
  try {
    const env = { ...process.env, LDL_ACTION_ENVELOPE_STATE_DIR: dir, PATH: "" };
    writeFileSync(
      join(dir, "sess-b.json"),
      JSON.stringify({ state: "S", mode: "none", authorizedActions: [], correctionCompletion: { ...COMPLETION, workerAgentId: "w1" } }),
    );
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: "SubagentStop", session_id: "sess-b", agent_id: "helper" }),
      env,
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(JSON.parse(readFileSync(join(dir, "sess-b.json"), "utf8")).correctionCompletion.blocks, 0);
    const settings = JSON.parse(readFileSync(join(dirname(HOOK), "..", "..", ".claude", "settings.json"), "utf8"));
    const cmds = settings.hooks.SubagentStop.flatMap((e) => e.hooks.map((h) => h.command));
    assert.equal(cmds.length, 1);
    assert.match(cmds[0], /action-envelope-hook\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
