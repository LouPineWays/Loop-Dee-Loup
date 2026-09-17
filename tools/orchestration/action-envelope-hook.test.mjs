// Tests for tools/orchestration/action-envelope-hook.mjs — issue #641's live, fail-closed
// PreToolUse/PostToolUse enforcement of the "none" action-envelope mode, extending issue
// #486/#607's post-hoc classifier (action-envelope.mjs) to real-time tool-call denial.
//
// Run with: node --test tools/orchestration/action-envelope-hook.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// -- invokedGateScriptBasenames: structural command parsing -------------------------------

test("invokedGateScriptBasenames: recognizes a direct next-review-transition-gate.mjs invocation", async () => {
  const { invokedGateScriptBasenames } = await import("./action-envelope-hook.mjs");
  assert.deepEqual(
    invokedGateScriptBasenames("node tools/orchestration/next-review-transition-gate.mjs --control-issue 639"),
    ["next-review-transition-gate.mjs"],
  );
});

test("invokedGateScriptBasenames: recognizes ready-dispatch-gate.mjs, including a chained command", async () => {
  const { invokedGateScriptBasenames } = await import("./action-envelope-hook.mjs");
  assert.deepEqual(
    invokedGateScriptBasenames(
      "node tools/orchestration/ready-dispatch-gate.mjs --control-issue 487 && echo done",
    ),
    ["ready-dispatch-gate.mjs"],
  );
});

test("invokedGateScriptBasenames: does not match the script name appearing only inside an unrelated argument value", async () => {
  const { invokedGateScriptBasenames } = await import("./action-envelope-hook.mjs");
  assert.deepEqual(
    invokedGateScriptBasenames('node some-other-tool.mjs --label "see next-review-transition-gate.mjs"'),
    [],
  );
});

test("invokedGateScriptBasenames: does not match a *.test.mjs file for the gate script", async () => {
  const { invokedGateScriptBasenames } = await import("./action-envelope-hook.mjs");
  assert.deepEqual(
    invokedGateScriptBasenames("node --test tools/orchestration/next-review-transition-gate.test.mjs"),
    [],
  );
});

test("invokedGateScriptBasenames: tolerates non-string/empty input", async () => {
  const { invokedGateScriptBasenames } = await import("./action-envelope-hook.mjs");
  assert.deepEqual(invokedGateScriptBasenames(undefined), []);
  assert.deepEqual(invokedGateScriptBasenames(""), []);
  assert.deepEqual(invokedGateScriptBasenames(null), []);
});

// -- extractVerdict: robust last-JSON-line parsing -----------------------------------------

test("extractVerdict: parses the gate script's single JSON stdout line", async () => {
  const { extractVerdict } = await import("./action-envelope-hook.mjs");
  const stdout = `${JSON.stringify({
    state: "NO_ACTION_YET",
    stopAfter: true,
    actionEnvelope: { mode: "none", authorizedActions: [] },
  })}\n`;
  const verdict = extractVerdict(stdout);
  assert.equal(verdict.state, "NO_ACTION_YET");
  assert.equal(verdict.actionEnvelope.mode, "none");
});

test("extractVerdict: scans from the end past incidental non-JSON noise", async () => {
  const { extractVerdict } = await import("./action-envelope-hook.mjs");
  const stdout = [
    "npm warn deprecated something",
    JSON.stringify({ state: "READY_TO_DISPATCH", actionEnvelope: { mode: "bounded", authorizedActions: ["dispatch-execution-worker"] } }),
  ].join("\n");
  const verdict = extractVerdict(stdout);
  assert.equal(verdict.state, "READY_TO_DISPATCH");
});

test("extractVerdict: returns null for the exitCode-1 operational-error shape (no verdict on stdout)", async () => {
  const { extractVerdict } = await import("./action-envelope-hook.mjs");
  assert.equal(extractVerdict(""), null);
  assert.equal(extractVerdict("Missing required arg: --control-issue"), null);
  assert.equal(extractVerdict(undefined), null);
});

test("extractVerdict: rejects JSON that lacks the recognizable verdict shape", async () => {
  const { extractVerdict } = await import("./action-envelope-hook.mjs");
  assert.equal(extractVerdict(JSON.stringify({ hello: "world" })), null);
  assert.equal(extractVerdict(JSON.stringify({ state: "X" })), null); // no actionEnvelope
});

// -- detectNoActionVerdict: the PostToolUse marking decision -------------------------------

test("detectNoActionVerdict: marks a genuine NO_ACTION_YET verdict from next-review-transition-gate.mjs", async () => {
  const { detectNoActionVerdict } = await import("./action-envelope-hook.mjs");
  const stdout = JSON.stringify({
    state: "NO_ACTION_YET",
    stopAfter: true,
    actionEnvelope: { mode: "none", authorizedActions: [] },
  });
  const verdict = detectNoActionVerdict(
    "node tools/orchestration/next-review-transition-gate.mjs --control-issue 639",
    stdout,
  );
  assert.equal(verdict?.state, "NO_ACTION_YET");
});

test("detectNoActionVerdict: marks ordinary BLOCKED (none-mode) from ready-dispatch-gate.mjs", async () => {
  const { detectNoActionVerdict } = await import("./action-envelope-hook.mjs");
  const stdout = JSON.stringify({
    state: "BLOCKED",
    stopAfter: true,
    actionEnvelope: { mode: "none", authorizedActions: [] },
  });
  const verdict = detectNoActionVerdict("node tools/orchestration/ready-dispatch-gate.mjs --control-issue 301", stdout);
  assert.equal(verdict?.state, "BLOCKED");
});

test("detectNoActionVerdict: does NOT mark a bounded action-bearing verdict (must not over-constrain authorized actions)", async () => {
  const { detectNoActionVerdict } = await import("./action-envelope-hook.mjs");
  const stdout = JSON.stringify({
    state: "READY_TO_DISPATCH",
    actionEnvelope: { mode: "bounded", authorizedActions: ["dispatch-execution-worker"] },
  });
  assert.equal(
    detectNoActionVerdict("node tools/orchestration/ready-dispatch-gate.mjs --control-issue 487", stdout),
    null,
  );
});

test("detectNoActionVerdict: does NOT mark a chain verdict (e.g. BLOCKED eligible for reconciliation)", async () => {
  const { detectNoActionVerdict } = await import("./action-envelope-hook.mjs");
  const stdout = JSON.stringify({
    state: "BLOCKED",
    blockerReconciliationEligible: true,
    actionEnvelope: { mode: "chain", authorizedActions: ["run-reconcile-control-blocker"] },
  });
  assert.equal(
    detectNoActionVerdict("node tools/orchestration/ready-dispatch-gate.mjs --control-issue 301", stdout),
    null,
  );
});

test("detectNoActionVerdict: does NOT mark ordinary NOT_READY fallthrough", async () => {
  const { detectNoActionVerdict } = await import("./action-envelope-hook.mjs");
  const stdout = JSON.stringify({ state: "NOT_READY", actionEnvelope: { mode: "fallthrough", authorizedActions: [] } });
  assert.equal(
    detectNoActionVerdict("node tools/orchestration/ready-dispatch-gate.mjs --control-issue 999", stdout),
    null,
  );
});

test("detectNoActionVerdict: ignores a none-mode-shaped JSON line from an unrelated command", async () => {
  const { detectNoActionVerdict } = await import("./action-envelope-hook.mjs");
  const stdout = JSON.stringify({ state: "NO_ACTION_YET", actionEnvelope: { mode: "none", authorizedActions: [] } });
  assert.equal(detectNoActionVerdict("node some-other-script.mjs", stdout), null);
});

// -- decidePreToolUse: pure allow/deny decision --------------------------------------------

test("decidePreToolUse: allows when there is no marker", async () => {
  const { decidePreToolUse } = await import("./action-envelope-hook.mjs");
  assert.deepEqual(decidePreToolUse(null), { permissionDecision: "allow" });
});

test("decidePreToolUse: denies unconditionally once a marker exists, naming the verdict", async () => {
  const { decidePreToolUse } = await import("./action-envelope-hook.mjs");
  const decision = decidePreToolUse({ state: "NO_ACTION_YET", mode: "none", ts: "2026-09-17T00:00:00.000Z" });
  assert.equal(decision.permissionDecision, "deny");
  assert.match(decision.permissionDecisionReason, /NO_ACTION_YET/);
  assert.match(decision.permissionDecisionReason, /#486\/#641/);
});

// -- writeMarker / readMarker round-trip, isolated state dir --------------------------------

test("writeMarker + readMarker round-trip through an isolated state dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  // action-envelope-hook.mjs reads LDL_ACTION_ENVELOPE_STATE_DIR at import time.
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);

  assert.equal(mod.readMarker("session-a"), null);
  const written = mod.writeMarker("session-a", {
    state: "NO_ACTION_YET",
    actionEnvelope: { mode: "none" },
  });
  assert.equal(written.state, "NO_ACTION_YET");
  const readBack = mod.readMarker("session-a");
  assert.equal(readBack.state, "NO_ACTION_YET");
  assert.equal(readBack.mode, "none");

  // A different session_id (the fresh-invocation case) has no marker of its own.
  assert.equal(mod.readMarker("session-b"), null);

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});

test("writeMarker/readMarker are no-ops for a missing session id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);
  assert.equal(mod.writeMarker(null, { state: "NO_ACTION_YET", actionEnvelope: { mode: "none" } }), null);
  assert.equal(mod.readMarker(null), null);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});

// -- Live-equivalent #639/PR #640 reproduction ----------------------------------------------
//
// Reproduces the exact incident shape named in issue #641: next-review-transition-gate.mjs
// returns NO_ACTION_YET/stopAfter:true; the controller then attempts several of the specific
// operational steps #641 names as having been merely *considered* in the live run (reading
// docs/bounded-review-cycle.md, inspecting the gate implementation, gh issue view on #640,
// invoking the stage1-classifier-hardening skill, spawn_task) — every one of them must now be
// denied, proving zero post-verdict operational calls can succeed in this session, while a
// fresh session_id (the #639/#640 classifier fix's own later, separate invocation) remains
// fully unblocked.

test("#639/PR #640 reproduction: NO_ACTION_YET stop boundary denies every subsequent tool call in the same session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);
  const sessionId = "session-639-work-on-487";

  // 1. Gate call observed via PostToolUse.
  const gateStdout = JSON.stringify({
    state: "NO_ACTION_YET",
    stopAfter: true,
    actionEnvelope: { mode: "none", authorizedActions: [] },
  });
  const verdict = mod.detectNoActionVerdict(
    "node tools/orchestration/next-review-transition-gate.mjs --control-issue 487",
    gateStdout,
  );
  assert.ok(verdict, "the gate's own NO_ACTION_YET/none-mode verdict must be detected");
  mod.writeMarker(sessionId, verdict);

  // 2. Every one of the specific near-miss actions #641 names is now denied for this session.
  const attempted = [
    { tool: "Read", detail: "docs/bounded-review-cycle.md" },
    { tool: "Read", detail: "tools/orchestration/next-review-transition-gate.mjs" },
    { tool: "Bash", detail: "gh issue view 640" },
    { tool: "Skill", detail: "stage1-classifier-hardening" },
    { tool: "spawn_task", detail: "file the classifier defect" },
  ];
  for (const action of attempted) {
    const decision = mod.decidePreToolUse(mod.readMarker(sessionId));
    assert.equal(decision.permissionDecision, "deny", `expected ${action.tool} (${action.detail}) to be denied`);
    assert.match(decision.permissionDecisionReason, /NO_ACTION_YET/);
  }

  // 3. A fresh session (later invocation reading durable state) is unaffected.
  assert.deepEqual(mod.decidePreToolUse(mod.readMarker("a-later-fresh-session")), { permissionDecision: "allow" });

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});

test("#486 action-bearing verdict control: READY_TO_DISPATCH's authorized dispatch is never blocked by this hook", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);
  const sessionId = "session-action-bearing";

  const stdout = JSON.stringify({
    state: "READY_TO_DISPATCH",
    actionEnvelope: { mode: "bounded", authorizedActions: ["dispatch-execution-worker"] },
  });
  const verdict = mod.detectNoActionVerdict(
    "node tools/orchestration/ready-dispatch-gate.mjs --control-issue 487",
    stdout,
  );
  assert.equal(verdict, null, "a bounded verdict must never be treated as a none-mode marker source");

  // No marker was ever written, so the one authorized dispatch action (and anything else,
  // since this hook only ever restricts — action-envelope.mjs's own classifier still governs
  // bounded/chain compliance separately and unchanged) is allowed through this hook.
  assert.deepEqual(mod.decidePreToolUse(mod.readMarker(sessionId)), { permissionDecision: "allow" });

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});

test("#486 blocker/founder-interrupt no-action control: ordinary BLOCKED also stops the session via this hook", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);
  const sessionId = "session-blocked";

  const stdout = JSON.stringify({
    state: "BLOCKED",
    stopAfter: true,
    actionEnvelope: { mode: "none", authorizedActions: [] },
  });
  const verdict = mod.detectNoActionVerdict("node tools/orchestration/ready-dispatch-gate.mjs --control-issue 301", stdout);
  assert.ok(verdict);
  mod.writeMarker(sessionId, verdict);

  const decision = mod.decidePreToolUse(mod.readMarker(sessionId));
  assert.equal(decision.permissionDecision, "deny");
  assert.match(decision.permissionDecisionReason, /BLOCKED/);

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});
