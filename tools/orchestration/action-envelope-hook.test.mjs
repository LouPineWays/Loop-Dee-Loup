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

// Stage 1 review finding on PR #642: a real Claude Code Bash invocation commonly quotes the
// script path via $CLAUDE_PROJECT_DIR, e.g.
// `node "$CLAUDE_PROJECT_DIR/tools/orchestration/next-review-transition-gate.mjs" --control-issue 487`.
// Splitting on whitespace alone previously left the closing quote attached to the basename
// (`next-review-transition-gate.mjs"`), so this exact shape was never recognized.
test("invokedGateScriptBasenames: recognizes a double-quoted $CLAUDE_PROJECT_DIR-prefixed invocation", async () => {
  const { invokedGateScriptBasenames } = await import("./action-envelope-hook.mjs");
  assert.deepEqual(
    invokedGateScriptBasenames(
      'node "$CLAUDE_PROJECT_DIR/tools/orchestration/next-review-transition-gate.mjs" --control-issue 487',
    ),
    ["next-review-transition-gate.mjs"],
  );
});

test("invokedGateScriptBasenames: recognizes a single-quoted script path", async () => {
  const { invokedGateScriptBasenames } = await import("./action-envelope-hook.mjs");
  assert.deepEqual(
    invokedGateScriptBasenames("node 'tools/orchestration/ready-dispatch-gate.mjs' --control-issue 301"),
    ["ready-dispatch-gate.mjs"],
  );
});

test("invokedGateScriptBasenames: a quoted non-gate script still does not match", async () => {
  const { invokedGateScriptBasenames } = await import("./action-envelope-hook.mjs");
  assert.deepEqual(invokedGateScriptBasenames('node "some-other-tool.mjs" --flag'), []);
});

// Issue #675: session-entry-gate.mjs composes the two leaf gates and, on success, prints their
// final resolved verdict's fields verbatim (same state + actionEnvelope.mode shape). It must be
// recognized as a verdict source exactly like the two leaf gates, so a session invoking the gate
// chain through this entrypoint gets the identical live "none"/"bounded" stop-boundary
// enforcement as a session invoking either leaf gate directly.
test("invokedGateScriptBasenames: recognizes a direct session-entry-gate.mjs invocation", async () => {
  const { invokedGateScriptBasenames } = await import("./action-envelope-hook.mjs");
  assert.deepEqual(
    invokedGateScriptBasenames("node tools/orchestration/session-entry-gate.mjs --control-issue 639"),
    ["session-entry-gate.mjs"],
  );
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

// Issue #675: session-entry-gate.mjs's own final resolved verdict (after it has internally
// consumed any "chain" hops) carries the identical state + actionEnvelope shape as a leaf gate's
// own output, so it must be recognized as a marking source in exactly the same way.
test("detectNoActionVerdict: marks a no-action verdict resolved via session-entry-gate.mjs (the #639 shape after chaining)", async () => {
  const { detectNoActionVerdict } = await import("./action-envelope-hook.mjs");
  const stdout = JSON.stringify({
    ok: true,
    state: "STAGE2_RESPONSE_UNUSABLE",
    stopAfter: true,
    actionEnvelope: { mode: "none", authorizedActions: [] },
    provenance: [
      { gate: "ready-dispatch-gate", state: "NOT_READY", leafExitCode: 3, actionEnvelopeMode: "chain" },
      { gate: "next-review-transition-gate", state: "STAGE2_RESPONSE_UNUSABLE", leafExitCode: 4, actionEnvelopeMode: "none" },
    ],
  });
  const verdict = detectNoActionVerdict("node tools/orchestration/session-entry-gate.mjs --control-issue 639", stdout);
  assert.equal(verdict?.state, "STAGE2_RESPONSE_UNUSABLE");
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

// -- extractFailureOutput: PostToolUseFailure payload field tolerance ----------------------
//
// Stage 1 review finding on PR #642: several no-action gate verdicts (BLOCKED, AMBIGUOUS,
// STAGE2_RESPONSE_UNUSABLE) intentionally exit nonzero, which Claude Code routes through
// PostToolUseFailure rather than PostToolUse — a wiring gap this module previously had no
// coverage for at all.

test("extractFailureOutput: reads the documented tool_output field", async () => {
  const { extractFailureOutput } = await import("./action-envelope-hook.mjs");
  const body = JSON.stringify({ state: "BLOCKED", actionEnvelope: { mode: "none", authorizedActions: [] } });
  assert.equal(extractFailureOutput({ tool_output: body }), body);
});

test("extractFailureOutput: falls back to tool_response.stdout, then error, then empty string", async () => {
  const { extractFailureOutput } = await import("./action-envelope-hook.mjs");
  assert.equal(extractFailureOutput({ tool_response: { stdout: "fallback-stdout" } }), "fallback-stdout");
  assert.equal(extractFailureOutput({ error: "fallback-error" }), "fallback-error");
  assert.equal(extractFailureOutput({}), "");
  assert.equal(extractFailureOutput(null), "");
});

test("detectNoActionVerdict: marks a nonzero-exit BLOCKED verdict delivered via PostToolUseFailure's tool_output", async () => {
  const { detectNoActionVerdict, extractFailureOutput } = await import("./action-envelope-hook.mjs");
  const failurePayload = {
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "node tools/orchestration/ready-dispatch-gate.mjs --control-issue 301" },
    tool_output: JSON.stringify({
      state: "BLOCKED",
      stopAfter: true,
      actionEnvelope: { mode: "none", authorizedActions: [] },
    }),
  };
  const verdict = detectNoActionVerdict(
    failurePayload.tool_input.command,
    extractFailureOutput(failurePayload),
  );
  assert.equal(verdict?.state, "BLOCKED");
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

// -- detectBoundedVerdict: the PostToolUse/PostToolUseFailure bounded-mode marking decision --
// (issue #678)

test("detectBoundedVerdict: marks a genuine STAGE1_CORRECTION_REQUIRED bounded verdict from next-review-transition-gate.mjs", async () => {
  const { detectBoundedVerdict } = await import("./action-envelope-hook.mjs");
  const stdout = JSON.stringify({
    state: "STAGE1_CORRECTION_REQUIRED",
    stopAfter: true,
    correctionReason: "findings",
    actionEnvelope: { mode: "bounded", authorizedActions: ["reserve-correction-checkout", "dispatch-correction-worker"] },
  });
  const verdict = detectBoundedVerdict(
    "node tools/orchestration/next-review-transition-gate.mjs --control-issue 631",
    stdout,
  );
  assert.equal(verdict?.state, "STAGE1_CORRECTION_REQUIRED");
  assert.deepEqual(verdict?.actionEnvelope.authorizedActions, ["reserve-correction-checkout", "dispatch-correction-worker"]);
});

test("detectBoundedVerdict: does NOT mark a none-mode verdict (must not widen the none-mode marker path)", async () => {
  const { detectBoundedVerdict } = await import("./action-envelope-hook.mjs");
  const stdout = JSON.stringify({ state: "NO_ACTION_YET", actionEnvelope: { mode: "none", authorizedActions: [] } });
  assert.equal(
    detectBoundedVerdict("node tools/orchestration/next-review-transition-gate.mjs --control-issue 487", stdout),
    null,
  );
});

test("detectBoundedVerdict: does NOT mark a chain or fallthrough verdict", async () => {
  const { detectBoundedVerdict } = await import("./action-envelope-hook.mjs");
  const chainStdout = JSON.stringify({
    state: "AUDIT_ISSUE_DETECTED",
    actionEnvelope: { mode: "chain", authorizedActions: ["run-next-review-transition-gate"] },
  });
  assert.equal(
    detectBoundedVerdict("node tools/orchestration/ready-dispatch-gate.mjs --control-issue 487", chainStdout),
    null,
  );
  const fallthroughStdout = JSON.stringify({ state: "NOT_READY", actionEnvelope: { mode: "fallthrough", authorizedActions: [] } });
  assert.equal(
    detectBoundedVerdict("node tools/orchestration/ready-dispatch-gate.mjs --control-issue 999", fallthroughStdout),
    null,
  );
});

test("detectBoundedVerdict: ignores a bounded-shaped JSON line from an unrelated command", async () => {
  const { detectBoundedVerdict } = await import("./action-envelope-hook.mjs");
  const stdout = JSON.stringify({
    state: "STAGE1_CORRECTION_REQUIRED",
    actionEnvelope: { mode: "bounded", authorizedActions: ["dispatch-correction-worker"] },
  });
  assert.equal(detectBoundedVerdict("node some-other-script.mjs", stdout), null);
});

// -- shouldConsumeBoundedDispatch / consumeBoundedDispatch (issue #678) --------------------

test("shouldConsumeBoundedDispatch: true for a bounded marker naming a worker-dispatch action", async () => {
  const { shouldConsumeBoundedDispatch } = await import("./action-envelope-hook.mjs");
  assert.equal(
    shouldConsumeBoundedDispatch({ mode: "bounded", authorizedActions: ["dispatch-correction-worker"] }),
    true,
  );
  assert.equal(
    shouldConsumeBoundedDispatch({
      mode: "bounded",
      authorizedActions: ["reserve-correction-checkout", "dispatch-correction-worker"],
    }),
    true,
  );
});

test("shouldConsumeBoundedDispatch: false for a non-dispatch bounded marker, a none marker, or no marker", async () => {
  const { shouldConsumeBoundedDispatch } = await import("./action-envelope-hook.mjs");
  assert.equal(
    shouldConsumeBoundedDispatch({
      mode: "bounded",
      authorizedActions: ["prepare-dispatch-manifest", "write-control-snapshot"],
    }),
    false,
  );
  assert.equal(shouldConsumeBoundedDispatch({ mode: "none", authorizedActions: [] }), false);
  assert.equal(shouldConsumeBoundedDispatch(null), false);
});

test("consumeBoundedDispatch: overwrites a bounded marker into an exhausted none-mode marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);
  const sessionId = "session-consume";

  mod.writeMarker(sessionId, {
    state: "STAGE2_CORRECTION_REQUIRED",
    actionEnvelope: { mode: "bounded", authorizedActions: ["dispatch-correction-worker"] },
  });
  const marker = mod.readMarker(sessionId);
  const exhausted = mod.consumeBoundedDispatch(sessionId, marker);
  assert.equal(exhausted.mode, "none");
  assert.equal(exhausted.state, "STAGE2_CORRECTION_REQUIRED");

  const readBack = mod.readMarker(sessionId);
  assert.equal(readBack.mode, "none");
  assert.equal(mod.decidePreToolUse(readBack).permissionDecision, "deny");

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});

// -- decidePreToolUse: bounded-mode gate-rerun denial (issue #678) -------------------------

test("decidePreToolUse: bounded marker denies a Bash rerun of either gate script", async () => {
  const { decidePreToolUse } = await import("./action-envelope-hook.mjs");
  const marker = {
    state: "STAGE1_CORRECTION_REQUIRED",
    mode: "bounded",
    authorizedActions: ["reserve-correction-checkout", "dispatch-correction-worker"],
  };
  const decision = decidePreToolUse(marker, {
    toolName: "Bash",
    command: "node tools/orchestration/next-review-transition-gate.mjs --control-issue 631",
  });
  assert.equal(decision.permissionDecision, "deny");
  assert.match(decision.permissionDecisionReason, /STAGE1_CORRECTION_REQUIRED/);
  assert.match(decision.permissionDecisionReason, /dispatch-correction-worker/);

  const decisionOtherGate = decidePreToolUse(marker, {
    toolName: "Bash",
    command: "node tools/orchestration/ready-dispatch-gate.mjs --control-issue 487",
  });
  assert.equal(decisionOtherGate.permissionDecision, "deny");
});

test("decidePreToolUse: bounded marker allows a non-gate-script Bash call and a subagent dispatch", async () => {
  const { decidePreToolUse } = await import("./action-envelope-hook.mjs");
  const marker = {
    state: "STAGE1_CORRECTION_REQUIRED",
    mode: "bounded",
    authorizedActions: ["reserve-correction-checkout", "dispatch-correction-worker"],
  };
  assert.deepEqual(
    decidePreToolUse(marker, { toolName: "Bash", command: "node tools/orchestration/pr-head-checkout-preflight.mjs --reserve-from-gate" }),
    { permissionDecision: "allow" },
  );
  assert.deepEqual(decidePreToolUse(marker, { toolName: "Agent" }), { permissionDecision: "allow" });
  // Omitted toolCall (backward compatible with every pre-#678 caller) also allows through.
  assert.deepEqual(decidePreToolUse(marker), { permissionDecision: "allow" });
});

// -- #631 live reproduction: bounded STAGE1_CORRECTION_REQUIRED rerun denied, dispatch --------
// allowed exactly once, and every action after consumption is denied.

test("#631 reproduction: bounded correction verdict rejects a same-context gate rerun before the dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);
  const sessionId = "session-631-work-on-487";

  // 1. next-review-transition-gate.mjs returns the exact #631 bounded verdict.
  const stdout = JSON.stringify({
    state: "STAGE1_CORRECTION_REQUIRED",
    stopAfter: true,
    correctionReason: "findings",
    controlIssue: 631,
    issue: 630,
    pr: 637,
    actionEnvelope: { mode: "bounded", authorizedActions: ["reserve-correction-checkout", "dispatch-correction-worker"] },
  });
  const verdict = mod.detectBoundedVerdict(
    "node tools/orchestration/next-review-transition-gate.mjs --control-issue 631",
    stdout,
  );
  assert.ok(verdict, "the bounded STAGE1_CORRECTION_REQUIRED verdict must be detected");
  mod.writeMarker(sessionId, verdict);

  // 2. AC2: attempting to rerun next-review-transition-gate.mjs before consuming the
  //    authorized dispatch — the exact #631 defect — is rejected; the second gate never runs.
  const rerunDecision = mod.decidePreToolUse(mod.readMarker(sessionId), {
    toolName: "Bash",
    command: "node tools/orchestration/next-review-transition-gate.mjs --control-issue 631",
  });
  assert.equal(rerunDecision.permissionDecision, "deny");

  // 3. AC3: the reservation pre-step and the correction-worker dispatch itself remain
  //    permitted — this hook never blocks the envelope's own authorized action(s).
  const reserveDecision = mod.decidePreToolUse(mod.readMarker(sessionId), {
    toolName: "Bash",
    command: "node tools/orchestration/pr-head-checkout-preflight.mjs --reserve-from-gate --execution-issue 630",
  });
  assert.equal(reserveDecision.permissionDecision, "allow");
  const dispatchDecision = mod.decidePreToolUse(mod.readMarker(sessionId), { toolName: "Agent" });
  assert.equal(dispatchDecision.permissionDecision, "allow");

  // 4. The dispatch actually happens: Claude Code fires SubagentStart for the spawned
  //    correction worker, carrying this same orchestrating session's session_id.
  const markerBeforeDispatch = mod.readMarker(sessionId);
  assert.equal(mod.shouldConsumeBoundedDispatch(markerBeforeDispatch), true);
  mod.consumeBoundedDispatch(sessionId, markerBeforeDispatch);

  // 5. AC4: after the bounded dispatch is consumed, a same-context gate rerun, a
  //     representative repository/GitHub operation, and any other operational continuation
  //     are all rejected — the initiating controller cannot continue.
  const postDispatchMarker = mod.readMarker(sessionId);
  const postRerun = mod.decidePreToolUse(postDispatchMarker, {
    toolName: "Bash",
    command: "node tools/orchestration/next-review-transition-gate.mjs --control-issue 631",
  });
  assert.equal(postRerun.permissionDecision, "deny");
  const postGhOp = mod.decidePreToolUse(postDispatchMarker, { toolName: "Bash", command: "gh pr view 637" });
  assert.equal(postGhOp.permissionDecision, "deny");
  const postRead = mod.decidePreToolUse(postDispatchMarker, { toolName: "Read" });
  assert.equal(postRead.permissionDecision, "deny");

  // 6. AC5: a fresh invocation (new session_id) is unaffected by this session's exhausted marker.
  assert.deepEqual(mod.decidePreToolUse(mod.readMarker("a-later-fresh-session-487")), { permissionDecision: "allow" });

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});

// -- Stage 2 correction-required parity fixture (AC6) ---------------------------------------

test("Stage 2 correction-required parity: STAGE2_CORRECTION_REQUIRED gets identical bounded enforcement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);
  const sessionId = "session-stage2-correction";

  const stdout = JSON.stringify({
    state: "STAGE2_CORRECTION_REQUIRED",
    stopAfter: true,
    actionEnvelope: { mode: "bounded", authorizedActions: ["dispatch-correction-worker"] },
  });
  const verdict = mod.detectBoundedVerdict(
    "node tools/orchestration/next-review-transition-gate.mjs --audit-issue 700",
    stdout,
  );
  assert.ok(verdict);
  mod.writeMarker(sessionId, verdict);

  // Rerun denied before dispatch.
  assert.equal(
    mod.decidePreToolUse(mod.readMarker(sessionId), {
      toolName: "Bash",
      command: "node tools/orchestration/next-review-transition-gate.mjs --audit-issue 700",
    }).permissionDecision,
    "deny",
  );
  // Dispatch allowed, then consumed via SubagentStart.
  assert.equal(mod.decidePreToolUse(mod.readMarker(sessionId), { toolName: "Agent" }).permissionDecision, "allow");
  mod.consumeBoundedDispatch(sessionId, mod.readMarker(sessionId));
  // Everything denied afterward.
  assert.equal(mod.decidePreToolUse(mod.readMarker(sessionId), { toolName: "Agent" }).permissionDecision, "deny");

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});

// -- Non-dispatch bounded envelope control: gate rerun still denied, but SubagentStart never --
// exhausts it (a stray dispatch is not how this envelope's own actions are fulfilled).

test("non-dispatch bounded envelope: gate rerun denied, but an unrelated SubagentStart never exhausts it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);
  const sessionId = "session-manifest";

  const stdout = JSON.stringify({
    state: "READY_TO_RUN_DISPATCH_MANIFEST",
    actionEnvelope: { mode: "bounded", authorizedActions: ["prepare-dispatch-manifest", "write-control-snapshot"] },
  });
  const verdict = mod.detectBoundedVerdict("node tools/orchestration/ready-dispatch-gate.mjs --control-issue 487", stdout);
  assert.ok(verdict);
  mod.writeMarker(sessionId, verdict);

  assert.equal(
    mod.decidePreToolUse(mod.readMarker(sessionId), {
      toolName: "Bash",
      command: "node tools/orchestration/ready-dispatch-gate.mjs --control-issue 487",
    }).permissionDecision,
    "deny",
  );
  assert.equal(mod.shouldConsumeBoundedDispatch(mod.readMarker(sessionId)), false);
  // Its own authorized Bash actions remain allowed.
  assert.equal(
    mod.decidePreToolUse(mod.readMarker(sessionId), {
      toolName: "Bash",
      command: "node tools/orchestration/prepare-dispatch-manifest.mjs --execution-issue 630 --create",
    }).permissionDecision,
    "allow",
  );

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});

// -- Regression: none/chain/fallthrough modes remain unaffected by the bounded extension -----
// (AC7)

test("regression: a none-mode marker's enforcement is identical with or without a toolCall argument", async () => {
  const { decidePreToolUse } = await import("./action-envelope-hook.mjs");
  const marker = { state: "NO_ACTION_YET", mode: "none", authorizedActions: [] };
  const withoutToolCall = decidePreToolUse(marker);
  const withToolCall = decidePreToolUse(marker, { toolName: "Bash", command: "gh pr view 1" });
  assert.equal(withoutToolCall.permissionDecision, "deny");
  assert.equal(withToolCall.permissionDecision, "deny");
  assert.equal(withoutToolCall.permissionDecisionReason, withToolCall.permissionDecisionReason);
});

test("regression: chain and fallthrough verdicts are still never marked by either detector", async () => {
  const { detectNoActionVerdict, detectBoundedVerdict } = await import("./action-envelope-hook.mjs");
  const chainStdout = JSON.stringify({
    state: "BLOCKED",
    blockerReconciliationEligible: true,
    actionEnvelope: { mode: "chain", authorizedActions: ["run-reconcile-control-blocker"] },
  });
  const fallthroughStdout = JSON.stringify({ state: "NOT_READY", actionEnvelope: { mode: "fallthrough", authorizedActions: [] } });
  for (const stdout of [chainStdout, fallthroughStdout]) {
    assert.equal(detectNoActionVerdict("node tools/orchestration/ready-dispatch-gate.mjs --control-issue 1", stdout), null);
    assert.equal(detectBoundedVerdict("node tools/orchestration/ready-dispatch-gate.mjs --control-issue 1", stdout), null);
  }
});

// -- Stage 1 correction on PR #714 (issue #678): finding 1, verdict capture on the real -------
// piped dispatch pipeline, via the side channel gate scripts persist at emission time.

test("persistLastGateVerdict/consumeLastGateVerdict round-trip through the side channel; consuming deletes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);

  assert.equal(mod.consumeLastGateVerdict(), null);
  const verdict = {
    state: "STAGE1_CORRECTION_REQUIRED",
    actionEnvelope: { mode: "bounded", authorizedActions: ["dispatch-correction-worker"] },
  };
  mod.persistLastGateVerdict(verdict);
  assert.deepEqual(mod.consumeLastGateVerdict(), verdict);
  // Consuming deletes it -- a second read finds nothing, so the same verdict is never
  // attributed to a later, unrelated command.
  assert.equal(mod.consumeLastGateVerdict(), null);

  mod.persistLastGateVerdict(verdict);
  mod.clearLastGateVerdict();
  assert.equal(mod.consumeLastGateVerdict(), null);

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});

test("markObservedVerdict: falls back to the side channel when a downstream pipeline stage transformed the command's captured stdout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);
  const sessionId = "session-piped-dispatch";

  const verdict = {
    state: "STAGE1_CORRECTION_REQUIRED",
    stopAfter: true,
    actionEnvelope: { mode: "bounded", authorizedActions: ["reserve-correction-checkout", "dispatch-correction-worker"] },
  };
  // The gate script's own side effect (added to both gate scripts' main()): persists its
  // verdict the instant it is emitted, before any downstream stage can transform stdout.
  mod.persistLastGateVerdict(verdict);

  // The Bash tool's own captured stdout is the FINAL pipeline stage's rendered prompt text,
  // not JSON at all -- exactly the real
  // `next-review-transition-gate.mjs | pr-head-checkout-preflight.mjs --reserve-from-gate |
  // format-dispatch-prompt.mjs` dispatch pipeline shape.
  const renderedPromptText = "Stage 1 correction worker dispatch.\nExecution Issue: #678.\n";
  mod.markObservedVerdict(
    sessionId,
    "node tools/orchestration/next-review-transition-gate.mjs --control-issue 487 | node tools/orchestration/format-dispatch-prompt.mjs",
    renderedPromptText,
  );

  const marker = mod.readMarker(sessionId);
  assert.ok(marker, "the side channel must supply the verdict the transformed stdout lost");
  assert.equal(marker.state, "STAGE1_CORRECTION_REQUIRED");
  assert.equal(marker.mode, "bounded");
  // The side channel is consumed (deleted), so a later unrelated command never reuses it.
  assert.equal(mod.consumeLastGateVerdict(), null);

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});

test("markObservedVerdict: the direct stdout extraction is preferred over the side channel when both are present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);
  const sessionId = "session-direct-preferred";

  // A stale/unrelated side-channel entry must not override a verdict already recovered
  // directly from this command's own captured stdout (the common non-piped case).
  mod.persistLastGateVerdict({
    state: "STALE_UNRELATED",
    actionEnvelope: { mode: "none", authorizedActions: [] },
  });
  const stdout = JSON.stringify({
    state: "NO_ACTION_YET",
    actionEnvelope: { mode: "none", authorizedActions: [] },
  });
  mod.markObservedVerdict(sessionId, "node tools/orchestration/next-review-transition-gate.mjs --control-issue 487", stdout);
  assert.equal(mod.readMarker(sessionId).state, "NO_ACTION_YET");
  // The side channel is left alone since it was never consulted.
  assert.equal(mod.consumeLastGateVerdict().state, "STALE_UNRELATED");

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});

test("markObservedVerdict: the side-channel fallback is never consulted when the command did not invoke a gate script", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);
  const sessionId = "session-unrelated-command";

  mod.persistLastGateVerdict({ state: "NO_ACTION_YET", actionEnvelope: { mode: "none", authorizedActions: [] } });
  mod.markObservedVerdict(sessionId, "gh pr view 637", "some unrelated output");
  assert.equal(mod.readMarker(sessionId), null);
  // Leftover side-channel content from an unrelated prior gate run is untouched here.
  assert.ok(mod.consumeLastGateVerdict());

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});

// -- Stage 1 correction on PR #714 (issue #678): finding 2, a dispatch-unit-wave marker -------
// must survive multiple SubagentStart events until its full authorized wave has started.

test("expectedDispatchCount/recordSubagentDispatchStart: a dispatch-unit-wave marker survives multiple SubagentStart events until its full wave has started", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);
  const sessionId = "session-unit-wave";

  const verdict = {
    state: "READY_TO_DISPATCH_UNITS",
    stopAfter: true,
    dispatchReadyUnitIds: ["498-A", "498-B", "498-C"],
    actionEnvelope: { mode: "bounded", authorizedActions: ["dispatch-unit-wave"] },
  };
  mod.writeMarker(sessionId, verdict);
  assert.equal(mod.expectedDispatchCount(mod.readMarker(sessionId)), 3);

  // First worker starts: the wave is not fully dispatched yet, so the marker must stay
  // bounded and the formatter/Agent calls for the remaining ready units must still be allowed.
  mod.recordSubagentDispatchStart(sessionId, mod.readMarker(sessionId));
  let marker = mod.readMarker(sessionId);
  assert.equal(marker.mode, "bounded", "one worker start must not exhaust a 3-unit wave");
  assert.equal(marker.dispatchStartsConsumed, 1);
  assert.equal(
    mod.decidePreToolUse(marker, {
      toolName: "Bash",
      command: "node tools/orchestration/format-unit-dispatch-prompt.mjs --execution-issue 487 --unit 498-B",
    }).permissionDecision,
    "allow",
  );
  // A same-controller gate rerun stays denied throughout the wave.
  assert.equal(
    mod.decidePreToolUse(marker, {
      toolName: "Bash",
      command: "node tools/orchestration/ready-dispatch-gate.mjs --control-issue 487",
    }).permissionDecision,
    "deny",
  );

  // Second worker starts: still short of the full wave.
  mod.recordSubagentDispatchStart(sessionId, mod.readMarker(sessionId));
  marker = mod.readMarker(sessionId);
  assert.equal(marker.mode, "bounded");
  assert.equal(marker.dispatchStartsConsumed, 2);

  // Third worker starts: the wave is now fully dispatched -- exhaust exactly like the
  // single-worker case already does.
  mod.recordSubagentDispatchStart(sessionId, mod.readMarker(sessionId));
  marker = mod.readMarker(sessionId);
  assert.equal(marker.mode, "none");
  assert.equal(mod.decidePreToolUse(marker, { toolName: "Bash", command: "gh pr view 1" }).permissionDecision, "deny");

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});

test("recordSubagentDispatchStart: a single-worker dispatch-shaped envelope (no dispatchReadyUnitIds) still exhausts on the first start, unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);
  const sessionId = "session-single-worker";

  mod.writeMarker(sessionId, {
    state: "STAGE1_CORRECTION_REQUIRED",
    actionEnvelope: { mode: "bounded", authorizedActions: ["reserve-correction-checkout", "dispatch-correction-worker"] },
  });
  assert.equal(mod.expectedDispatchCount(mod.readMarker(sessionId)), 1);
  mod.recordSubagentDispatchStart(sessionId, mod.readMarker(sessionId));
  assert.equal(mod.readMarker(sessionId).mode, "none");

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});

test("recordSubagentDispatchStart: a non-dispatch bounded marker is left untouched by any SubagentStart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-action-envelope-hook-test-"));
  process.env.LDL_ACTION_ENVELOPE_STATE_DIR = dir;
  const mod = await import(`./action-envelope-hook.mjs?isolate=${Date.now()}`);
  const sessionId = "session-non-dispatch";

  mod.writeMarker(sessionId, {
    state: "READY_TO_RUN_DISPATCH_MANIFEST",
    actionEnvelope: { mode: "bounded", authorizedActions: ["prepare-dispatch-manifest", "write-control-snapshot"] },
  });
  const before = mod.readMarker(sessionId);
  const result = mod.recordSubagentDispatchStart(sessionId, before);
  assert.equal(result, null);
  assert.deepEqual(mod.readMarker(sessionId), before);

  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_ACTION_ENVELOPE_STATE_DIR;
});

// -- Stage 1 correction on PR #714 (issue #678): finding 3, a dispatched worker's own tool ----
// calls (sharing session_id, carrying their own agentId) are exempt from the controller's
// marker, including one the worker's own dispatch just exhausted.

test("decidePreToolUse: a dispatched worker's own tool call (carrying agentId) is exempt from the controller's marker, including one just exhausted by its own dispatch", async () => {
  const { decidePreToolUse } = await import("./action-envelope-hook.mjs");

  const boundedMarker = {
    state: "STAGE1_CORRECTION_REQUIRED",
    mode: "bounded",
    authorizedActions: ["reserve-correction-checkout", "dispatch-correction-worker"],
  };
  assert.deepEqual(
    decidePreToolUse(boundedMarker, { toolName: "Bash", command: "gh pr view 637", agentId: "agent-worker-1" }),
    { permissionDecision: "allow" },
  );

  const exhaustedMarker = { state: "STAGE1_CORRECTION_REQUIRED", mode: "none", authorizedActions: [] };
  // The controller itself (no agentId) is still denied -- the live stop boundary this hook
  // enforces.
  assert.equal(decidePreToolUse(exhaustedMarker).permissionDecision, "deny");
  assert.equal(decidePreToolUse(exhaustedMarker, { toolName: "Read" }).permissionDecision, "deny");
  // The worker that dispatch just authorized to start (carrying its own agentId) is not --
  // the exact defect this finding closes.
  assert.deepEqual(
    decidePreToolUse(exhaustedMarker, { toolName: "Read", agentId: "agent-worker-1" }),
    { permissionDecision: "allow" },
  );
});

test("decidePreToolUse: an empty-string or non-string agentId does not exempt the call (fail-closed default)", async () => {
  const { decidePreToolUse } = await import("./action-envelope-hook.mjs");
  const exhaustedMarker = { state: "NO_ACTION_YET", mode: "none", authorizedActions: [] };
  assert.equal(decidePreToolUse(exhaustedMarker, { toolName: "Read", agentId: "" }).permissionDecision, "deny");
  assert.equal(decidePreToolUse(exhaustedMarker, { toolName: "Read", agentId: 42 }).permissionDecision, "deny");
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
