#!/usr/bin/env node
// Deterministic READY immediate-dispatch gate for AGENTS.md § Session execution /
// docs/operating-model.md § Two-plane Issue dispatch — issue #321.
//
// Both #310/#311's diagnostic-trace artifact and control Issue #322's own body record a
// live regression: a fresh controller session given a complete READY thin control Issue
// (every immediate-dispatch gate field already satisfied) still read the linked thick
// execution Issue — and, in the #310/#311 case, also queried unrelated PRs — before ever
// dispatching a worker. AGENTS.md's prose already states the gate outcome unambiguously
// ("dispatch the linked execution worker immediately by reference ... without first
// performing execution-Issue inspection, repository reconnaissance ... or implementation
// planning"); two independent live sessions violated it anyway. docs/operating-model.md
// already anticipated this: "A future genuine deterministic dispatch surface should carry
// the smallest reliable guard, proven against a real named exception as well as the
// forbidden transition; until one exists, live dispatch behavior is verified by #283's
// fresh-session proof, not a fabricated test." This script is that guard.
//
// It performs exactly ONE read — `gh issue view <control-issue>` — and nothing else: no
// execution-Issue read, no PR query, no comment fetch. That is deliberate, not an
// oversight: bundling a second read into the same investigative step is exactly how both
// prior regressions happened, so the gate itself must be structurally incapable of
// reconnaissance. AGENTS.md's corrected Session execution text requires this script to be
// the orchestrating session's first tool call for a dispatched control-plane Issue,
// followed immediately by acting on its verdict — never a second freeform
// `gh issue view` on the same Issue number first.
//
// Parses the "Current state" bullet block LDL's parent-execution control template uses
// (see docs/operating-model.md § Parent snapshots and control Issues #311/#322):
//   - **Lifecycle:** READY
//   - **Execution:** #123
//   - **Route:** implementation worker
//   - **Blocker:** none
//   - **Founder decision:** none — <optional trailing explanation>
//
// Verdicts:
//   READY_TO_DISPATCH — every gate field satisfied. exit 0. Result carries
//     { controlIssue, executionIssue, route } — the exact reference-only triple to hand
//     the dispatched worker; nothing else belongs in that prompt (AGENTS.md § Subagent
//     dispatch).
//   NOT_READY — the control Issue does not currently satisfy the gate (wrong lifecycle
//     state, a blocker, a pending founder decision, a missing/malformed/multi-valued
//     field). exit 3. Falls through to normal Decomposition-boundary / Direct-inspection
//     reasoning — this script has no opinion on what to do next, only on whether the
//     immediate-dispatch shortcut applies.
//   ERROR — the control Issue could not be read, or --control-issue was missing/invalid.
//     exit 1.
//
// Usage:
//   node tools/orchestration/ready-dispatch-gate.mjs --repo OWNER/REPO --control-issue 322
//
// Tests: node --test tools/orchestration/ready-dispatch-gate.test.mjs

import { execFileSync } from "node:child_process";

const KNOWN_LIFECYCLE_STATES = ["READY", "EXECUTING", "VERIFYING", "REVIEW", "AUDIT", "CORRECTION", "BLOCKED"];

// Pure. Reads one "- **Label:** value" bullet line from a control Issue's body — the
// "Current state" block's own rendering convention (not a GitHub issue-form field, so
// this is deliberately a different, simpler parser than lifecycle-gate.mjs's
// parseFormField/parseFormFieldBlock, which read "### Heading" form fields instead).
// Case-insensitive on the label so "**Lifecycle:**" and "**lifecycle:**" both match;
// returns the trimmed remainder of the line (which may include a trailing explanation
// after an em/en dash, e.g. "none — founder selected explicit opt-in diagnostic capture"),
// or null if the label's bullet is absent. When a label appears more than once, the last
// occurrence wins — mirroring lifecycle-gate.mjs's parseFormField precedent of preferring
// the field that actually governs current state over an earlier mention (e.g. inside a
// quoted historical excerpt higher in the body).
export function parseControlBullet(body, label) {
  const pattern = new RegExp(`^-\\s*\\*\\*${label}:\\*\\*\\s*(.*)$`, "im");
  let match = null;
  for (const line of (body ?? "").split("\n")) {
    const m = pattern.exec(line);
    if (m) match = m;
  }
  return match ? match[1].trim() : null;
}

// Pure. True when `value` is the explicit "none" sentinel this repository's control
// template uses for an empty Blocker/Founder-decision field, tolerating a trailing
// explanation after the word itself (e.g. "none — founder selected ..."). A value that is
// merely absent (null) is not the same as a present, explicit "none" — callers distinguish
// the two.
export function isNoneSentinel(value) {
  return typeof value === "string" && /^none\b/i.test(value.trim());
}

// Pure. Extracts the single execution-Issue number a control Issue's "Execution" bullet
// points at. Returns { ok: true, issue } for exactly one distinct "#N" reference, or
// { ok: false, reason } for zero or more than one — a control Issue naming more than one
// execution pointer is not "one current execution pointer" (AGENTS.md's immediate-dispatch
// gate requirement) and must not be treated as dispatch-ready.
export function parseExecutionPointer(value) {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, reason: "Execution field is missing or empty" };
  }
  const refs = [...new Set([...value.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
  if (refs.length === 0) return { ok: false, reason: `Execution field "${value}" names no #N issue reference` };
  if (refs.length > 1) {
    return { ok: false, reason: `Execution field names more than one execution pointer (${refs.map((n) => `#${n}`).join(", ")}), not "one current execution pointer"` };
  }
  return { ok: true, issue: refs[0] };
}

// Pure core: evaluates AGENTS.md's immediate-dispatch gate against an already-fetched
// control Issue body. Exported separately from the `gh` call so tests exercise it without
// touching the network, matching this repository's existing gate-script convention
// (lifecycle-gate.mjs, stage1-gate.mjs).
export function evaluateReadyDispatchGate(body) {
  const lifecycleRaw = parseControlBullet(body, "Lifecycle");
  const executionRaw = parseControlBullet(body, "Execution");
  const routeRaw = parseControlBullet(body, "Route");
  const blockerRaw = parseControlBullet(body, "Blocker");
  const founderDecisionRaw = parseControlBullet(body, "Founder decision");

  const reasons = [];

  if (lifecycleRaw === null) {
    reasons.push('no "- **Lifecycle:**" bullet found in the control Issue body');
  } else if (lifecycleRaw.toUpperCase() !== "READY") {
    reasons.push(
      `lifecycle is "${lifecycleRaw}", not READY` +
        (KNOWN_LIFECYCLE_STATES.includes(lifecycleRaw.toUpperCase())
          ? " — this control Issue is already mid-cycle and should continue its own current step, not receive a fresh immediate dispatch"
          : ""),
    );
  }

  const execution = parseExecutionPointer(executionRaw);
  if (!execution.ok) reasons.push(execution.reason);

  if (routeRaw === null || routeRaw === "" || isNoneSentinel(routeRaw)) {
    reasons.push(`Route is not settled (found: ${JSON.stringify(routeRaw)})`);
  }

  if (blockerRaw === null) {
    reasons.push('no "- **Blocker:**" bullet found in the control Issue body');
  } else if (!isNoneSentinel(blockerRaw)) {
    reasons.push(`Blocker is not "none" (found: "${blockerRaw}")`);
  }

  if (founderDecisionRaw === null) {
    reasons.push('no "- **Founder decision:**" bullet found in the control Issue body');
  } else if (!isNoneSentinel(founderDecisionRaw)) {
    reasons.push(`Founder decision is not "none" (found: "${founderDecisionRaw}")`);
  }

  if (reasons.length > 0) {
    return { status: "NOT_READY", reasons };
  }

  return {
    status: "READY_TO_DISPATCH",
    executionIssue: execution.issue,
    route: routeRaw,
  };
}

function defaultGhIssueView({ repo, number }) {
  const raw = execFileSync("gh", ["issue", "view", String(number), "--repo", repo, "--json", "body,state"], {
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

// `ghIssueViewImpl` is injected so tests can drive this end-to-end without touching the
// real network or `gh` CLI. This function makes exactly one read of the control Issue —
// no execution-Issue read, no PR query — by construction: there is no code path here that
// could reach for anything else.
export async function checkReadyDispatch({ repo, controlIssue }, { ghIssueViewImpl = defaultGhIssueView } = {}) {
  if (!repo || !controlIssue) {
    return { exitCode: 1, message: "Missing required args: --repo and --control-issue are both required." };
  }

  let data;
  try {
    data = await ghIssueViewImpl({ repo, number: controlIssue });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo}#${controlIssue}: ${err.message}` };
  }

  if (data.state !== "OPEN") {
    return {
      exitCode: 3,
      state: "NOT_READY",
      controlIssue: Number(controlIssue),
      reasons: [`control Issue ${repo}#${controlIssue} is ${data.state}, not OPEN`],
    };
  }

  const result = evaluateReadyDispatchGate(data.body ?? "");
  if (result.status === "NOT_READY") {
    return { exitCode: 3, state: "NOT_READY", controlIssue: Number(controlIssue), reasons: result.reasons };
  }

  return {
    exitCode: 0,
    state: "READY_TO_DISPATCH",
    controlIssue: Number(controlIssue),
    executionIssue: result.executionIssue,
    route: result.route,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    args[a.slice(2)] = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await checkReadyDispatch({ repo: args.repo, controlIssue: args["control-issue"] });
  if (result.exitCode === 1) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  console.log(JSON.stringify(result));
  process.exit(result.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("ready-dispatch-gate.mjs")) {
  main();
}
