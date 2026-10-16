// Tests for action-envelope-hook.mjs's SubagentStop correction-completion enforcement (issue #764,
// control #577: the #726/#725/PR #763 escape). Kept in its own file so the pre-existing hook test
// file stays focused on the #641/#678/#737 stop-boundary behavior.
//
// Run with: node --test tools/orchestration/action-envelope-hook-correction-stop.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

test("correctionCompletionField: ci-failed gets a marker-verifying (kind ci-failed) postcondition, not the findings finalizer (issue #1202, Audit #1204)", async () => {
  const { correctionCompletionField } = await import("./action-envelope-hook.mjs");
  assert.deepEqual(correctionCompletionField({ ...CORRECTION_VERDICT, correctionReason: "ci-failed" }), {
    correctionCompletion: { pr: 763, controlIssue: 726, executionIssue: 725, reviewedHead: CORRECTION_VERDICT.head, kind: "ci-failed", blocks: 0 },
  });
  assert.deepEqual(correctionCompletionField({ ...CORRECTION_VERDICT, correctionReason: "ci-failed", head: "" }), {});
  assert.deepEqual(correctionCompletionField({ ...CORRECTION_VERDICT, correctionReason: "ci-failed", pr: undefined }), {});
});

test("evaluateCiFailedCorrectionCommits: requires an advanced head and a pushed commit naming the execution Issue with the marker (Audit #1204 P1)", async () => {
  const { evaluateCiFailedCorrectionCommits } = await import("./action-envelope-hook.mjs");
  const o = { reviewedHead: "aaa", executionIssue: 725 };
  const base = [{ sha: "x", message: "old" }, { sha: "aaa", message: "reviewed" }];
  assert.equal(evaluateCiFailedCorrectionCommits(base, o).ok, false); // not advanced
  assert.equal(evaluateCiFailedCorrectionCommits([...base, { sha: "b", message: "fix it for #725" }], o).ok, false); // no marker
  assert.equal(evaluateCiFailedCorrectionCommits([...base, { sha: "b", message: "[ci-failed-correction] fix" }], o).ok, false); // no issue
  assert.equal(evaluateCiFailedCorrectionCommits([...base, { sha: "b", message: "[ci-failed-correction] fix #7250" }], o).ok, false); // wrong issue
  assert.equal(evaluateCiFailedCorrectionCommits([{ sha: "z", message: "[ci-failed-correction] #725" }], o).ok, false); // reviewed head gone
  assert.equal(evaluateCiFailedCorrectionCommits([{ sha: "b", message: "[ci-failed-correction] #725" }, { sha: "aaa", message: "r" }], o).ok, false); // marker predates head
  assert.equal(evaluateCiFailedCorrectionCommits([...base, { sha: "b", message: "[ci-failed-correction] fix other/repo#725" }], o).ok, false); // qualified ref
  assert.equal(evaluateCiFailedCorrectionCommits([...base, { sha: "b", message: "[ci-failed-correction] fix #725abc" }], o).ok, false); // partial ref
  assert.equal(evaluateCiFailedCorrectionCommits(null, o).ok, false);
  assert.equal(evaluateCiFailedCorrectionCommits([...base, { sha: "b", message: "Address #725 [ci-failed-correction] fix" }], o).ok, true);
});

test("defaultVerifyCiFailedCorrection: reads PR commits via gh; read failure or 250-cap fails closed", async () => {
  const { defaultVerifyCiFailedCorrection } = await import("./action-envelope-hook.mjs");
  const c = { pr: 9, executionIssue: 725, reviewedHead: "aaa" };
  const page = (msgs) => JSON.stringify([[{ sha: "aaa", commit: { message: "r" } }, ...msgs.map((m, i) => ({ sha: `n${i}`, commit: { message: m } }))]]);
  assert.equal(defaultVerifyCiFailedCorrection(c, { execFileImpl: () => page(["Address #725 [ci-failed-correction]"]) }).ok, true);
  assert.equal(defaultVerifyCiFailedCorrection(c, { execFileImpl: () => page(["Address #725"]) }).ok, false);
  assert.equal(defaultVerifyCiFailedCorrection(c, { execFileImpl: () => { throw new Error("gh down"); } }).ok, false);
  assert.equal(defaultVerifyCiFailedCorrection(c, { execFileImpl: () => page(Array(250).fill("m")) }).ok, false);
});

test("decideSubagentStop: ci-failed worker that pushed without the marker is blocked (then fail-closed stop), never allowed; marker present -> allow", async () => {
  const { decideSubagentStop, MAX_CORRECTION_STOP_BLOCKS } = await import("./action-envelope-hook.mjs");
  const completion = { pr: 763, controlIssue: 726, executionIssue: 725, reviewedHead: "r", kind: "ci-failed", blocks: 0, workerAgentId: "w1" };
  const noFindingsVerify = () => assert.fail("findings verifier must not run for ci-failed");
  const bad = () => ({ ok: false, detail: "no marker" });
  const first = decideSubagentStop({ correctionCompletion: completion }, { verifyImpl: noFindingsVerify, ciFailedVerifyImpl: bad, agentId: "w1" });
  assert.equal(first.action, "block");
  assert.match(first.reason, /\[ci-failed-correction\]/);
  assert.doesNotMatch(first.reason, /finalize-correction-breakpoint/);
  const spent = decideSubagentStop({ correctionCompletion: { ...completion, blocks: MAX_CORRECTION_STOP_BLOCKS } }, { verifyImpl: noFindingsVerify, ciFailedVerifyImpl: bad, agentId: "w1" });
  assert.equal(spent.action, "stop");
  assert.deepEqual(
    decideSubagentStop({ correctionCompletion: completion }, { verifyImpl: noFindingsVerify, ciFailedVerifyImpl: () => ({ ok: true }), agentId: "w1" }),
    { action: "allow", verified: true },
  );
});

test("correctionCompletionField: findings verdict with full identity gets a postcondition; closing-reference / no-control get none", async () => {
  const { correctionCompletionField } = await import("./action-envelope-hook.mjs");
  assert.deepEqual(correctionCompletionField(CORRECTION_VERDICT), {
    correctionCompletion: { pr: 763, controlIssue: 726, executionIssue: 725, reviewedHead: CORRECTION_VERDICT.head, blocks: 0 },
  });
  assert.deepEqual(correctionCompletionField({ ...CORRECTION_VERDICT, correctionReason: "closing-reference" }), {});
  assert.deepEqual(correctionCompletionField({ ...CORRECTION_VERDICT, controlIssue: undefined }), {});
  assert.deepEqual(correctionCompletionField({ ...CORRECTION_VERDICT, issue: "none" }), {});
  assert.deepEqual(correctionCompletionField({ ...CORRECTION_VERDICT, state: "NO_ACTION_YET" }), {});
});

test("postcondition survives writeMarker -> consumeBoundedDispatch (SubagentStart exhaustion)", async () => {
  const { writeMarker, consumeBoundedDispatch } = await import("./action-envelope-hook.mjs");
  const impls = { mkdirImpl: () => {}, writeFileImpl: () => {} };
  const marker = writeMarker("s1", CORRECTION_VERDICT, impls);
  assert.equal(marker.correctionCompletion.pr, 763);
  const exhausted = consumeBoundedDispatch("s1", marker, impls);
  assert.equal(exhausted.mode, "none");
  assert.equal(exhausted.correctionCompletion.controlIssue, 726);
});

test("decideSubagentStop: no postcondition -> allow (unrelated workers unaffected)", async () => {
  const { decideSubagentStop } = await import("./action-envelope-hook.mjs");
  assert.equal(decideSubagentStop(null).action, "allow");
  assert.equal(decideSubagentStop({ state: "x", mode: "none" }, { verifyImpl: () => assert.fail("must not verify") }).action, "allow");
});

test("decideSubagentStop: verified -> allow; escaped (finalizer omitted) -> block, then bounded fail-closed stop", async () => {
  const { decideSubagentStop, MAX_CORRECTION_STOP_BLOCKS } = await import("./action-envelope-hook.mjs");
  const completion = { pr: 763, controlIssue: 726, executionIssue: 725, reviewedHead: "r", blocks: 0, workerAgentId: "w1" };
  const agentId = "w1";
  assert.deepEqual(decideSubagentStop({ correctionCompletion: completion }, { verifyImpl: () => ({ ok: true }), agentId }), {
    action: "allow",
    verified: true,
  });
  const bad = () => ({ ok: false, detail: "Stage 1 is requested" });
  const first = decideSubagentStop({ correctionCompletion: completion }, { verifyImpl: bad, agentId });
  assert.equal(first.action, "block");
  assert.match(first.reason, /^CORRECTION_BREAKPOINT_UNVERIFIED 763/);
  assert.match(first.reason, /finalize-correction-breakpoint\.mjs --control-issue 726 --execution-issue 725 --pr 763/);
  const spent = decideSubagentStop({ correctionCompletion: { ...completion, blocks: MAX_CORRECTION_STOP_BLOCKS } }, { verifyImpl: bad, agentId });
  assert.equal(spent.action, "stop");
  assert.match(spent.reason, /^CORRECTION_BREAKPOINT_UNVERIFIED 763/);
});

test("defaultVerifyCorrectionCompletion: nonzero verifier exit is fail-closed; zero passes; missing script fails open", async () => {
  const { defaultVerifyCorrectionCompletion } = await import("./action-envelope-hook.mjs");
  const c = { pr: 1, controlIssue: 2, executionIssue: 3, reviewedHead: "r" };
  const seen = [];
  const ok = defaultVerifyCorrectionCompletion(c, { existsImpl: () => true, execFileImpl: (_n, a) => seen.push(a) });
  assert.equal(ok.ok, true);
  assert.ok(seen[0].includes("--reviewed-head") && seen[0].includes("r"));
  const bad = defaultVerifyCorrectionCompletion(c, {
    existsImpl: () => true,
    execFileImpl: () => {
      throw Object.assign(new Error("x"), { stderr: "a\nCORRECTION_BREAKPOINT_UNVERIFIED 1" });
    },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /UNVERIFIED/);
  assert.equal(defaultVerifyCorrectionCompletion(c, { existsImpl: () => false }).ok, true);
});

// End-to-end through the real hook process: a marker carrying the postcondition, an unrelated
// worker-less repo (verifier cannot pass -> gh/network unavailable => nonzero) must produce a
// block decision on the first SubagentStop, and a session without a postcondition must not.
test("hook process: SubagentStop with an unverifiable postcondition blocks; without one it is silent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-hook-764-"));
  try {
    const env = { ...process.env, LDL_ACTION_ENVELOPE_STATE_DIR: dir, PATH: "" };
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "sess-a.json"),
      JSON.stringify({
        state: "STAGE1_CORRECTION_REQUIRED",
        mode: "none",
        authorizedActions: [],
        correctionCompletion: { pr: 763, controlIssue: 726, executionIssue: 725, reviewedHead: "r", blocks: 0, workerAgentId: "w1" },
      }),
    );
    const run = (sid) =>
      spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ hook_event_name: "SubagentStop", session_id: sid, agent_id: "w1" }),
        env,
        encoding: "utf8",
      });
    const blocked = run("sess-a");
    assert.equal(blocked.status, 0);
    const out = JSON.parse(blocked.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /^CORRECTION_BREAKPOINT_UNVERIFIED 763/);
    assert.equal(JSON.parse(readFileSync(join(dir, "sess-a.json"), "utf8")).correctionCompletion.blocks, 1);
    const silent = run("sess-none");
    assert.equal(silent.status, 0);
    assert.equal(silent.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decideCiFailedPreRelease: bound ci-failed worker's --release-binding is denied until the marker verifies (PR #1205 P1)", async () => {
  const { decideCiFailedPreRelease } = await import("./action-envelope-hook.mjs");
  const completion = { pr: 763, controlIssue: 726, executionIssue: 725, reviewedHead: "r", kind: "ci-failed", blocks: 0, workerAgentId: "w1" };
  const call = { toolName: "Bash", command: "node tools/orchestration/pr-head-checkout-preflight.mjs --release-binding abc", agentId: "w1" };
  const bad = () => ({ ok: false, detail: "no marker" });
  const good = () => ({ ok: true });
  const denied = decideCiFailedPreRelease({ correctionCompletion: completion }, call, { verifyImpl: bad });
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /\[ci-failed-correction\]/);
  assert.equal(decideCiFailedPreRelease({ correctionCompletion: completion }, call, { verifyImpl: good }).permissionDecision, "allow");
  assert.equal(decideCiFailedPreRelease({ correctionCompletion: completion }, { ...call, agentId: "other" }, { verifyImpl: bad }).applies, false);
  assert.equal(decideCiFailedPreRelease({ correctionCompletion: completion }, { ...call, command: "ls" }, { verifyImpl: bad }).applies, false);
  assert.equal(decideCiFailedPreRelease({ correctionCompletion: { ...completion, kind: undefined } }, call, { verifyImpl: bad }).applies, false);
  assert.equal(decideCiFailedPreRelease(null, call, { verifyImpl: bad }).applies, false);
});
