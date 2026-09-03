#!/usr/bin/env node
// Deterministic reference-only dispatch-prompt formatter for AGENTS.md § Subagent
// dispatch / docs/operating-model.md § Two-plane Issue dispatch — issue #321.
//
// `ready-dispatch-gate.mjs` already returns the exact reference-only triple a READY
// control Issue authorizes dispatching on: { controlIssue, executionIssue, route }. That
// script's own module comment says "nothing else belongs in that prompt" — but nothing
// upstream of the actual Agent/Task tool call enforced that in practice. A live fresh
// proof run for #321 itself (control Issue #322, execution Issue #321,
// docs/diagnostic-traces/615f2b4a-69eb-42f1-bef6-432a4e32f4dc.json) recorded a real
// controller session that correctly skipped every pre-dispatch execution-Issue read and
// all reconnaissance (`pre_dispatch_events: []`,
// `execution_issue_read_by_controller_before_dispatch: false`) and then still composed a
// 2554-character dispatch prompt — well past `diagnostic-trace.mjs`'s 700-char
// reference-only threshold — by restating large parts of AGENTS.md's own general
// contract sections (Session execution, Subagent dispatch, Founder interrupt conditions,
// the Slice handoff field list, the bounded review cycle) into the prompt instead of
// simply pointing at them. `classifyPreDispatch` correctly flagged that as
// `"violation"` ("dispatch prompt exceeded the reference-only size threshold (possible
// requirement retransmission)") even though the dispatched worker never received any
// #321-specific requirements/acceptance-criteria content — the two prior boundary
// failures (#282/#283, #314) and this one are distinct failure modes with the same root
// cause: nothing deterministic stood between "the gate says READY_TO_DISPATCH" and "the
// text actually handed to the Agent/Task tool."
//
// This script is that missing deterministic step. It takes exactly the JSON object
// `ready-dispatch-gate.mjs` already emits on `READY_TO_DISPATCH` and renders one fixed,
// short template from it — no free-form composition, no restated AGENTS.md prose, no
// review-cycle mechanics, no Slice-handoff field list. AGENTS.md instructs the
// orchestrating session to use this script's output verbatim as the dispatched worker's
// prompt: the worker already has AGENTS.md (imported via CLAUDE.md at session start) and
// reads the execution Issue directly, so nothing else belongs in the dispatch prompt
// itself.
//
// Usage (piped from the gate, the normal path):
//   node tools/orchestration/ready-dispatch-gate.mjs --repo OWNER/REPO --control-issue 322 \
//     | node tools/orchestration/format-dispatch-prompt.mjs
//
// Usage (explicit fields, e.g. for a legacy-unsplit routing worker's own compact
// projection per docs/operating-model.md § Two-plane Issue dispatch):
//   node tools/orchestration/format-dispatch-prompt.mjs \
//     --control-issue 322 --execution-issue 321 --route "implementation worker"
//
// Tests: node --test tools/orchestration/format-dispatch-prompt.test.mjs

import { readFileSync } from "node:fs";

// Pure. Renders the fixed reference-only template. Kept deliberately inert — no
// conditionals that grow the text based on route or issue content — so its length is
// bounded by construction rather than by reviewer discipline. A route string picked up
// from a control Issue's "- **Route:** <value>" bullet is inserted verbatim (already
// validated non-empty/non-"none" by `evaluateReadyDispatchGate` upstream), so an unusually
// long route value could in principle push this over the reference-only threshold;
// `assertReferenceOnly` below is the guard against that, not a length cap baked into the
// template itself.
export function formatDispatchPrompt({ controlIssue, executionIssue, route }) {
  if (controlIssue == null || executionIssue == null || !route) {
    throw new Error(
      "formatDispatchPrompt requires all three of controlIssue, executionIssue, and route",
    );
  }
  return (
    `Implementation worker dispatch. Execution Issue: #${executionIssue}. ` +
    `Controlling Issue: #${controlIssue}. Route: ${route}.\n\n` +
    `Read #${executionIssue} directly from GitHub for its full outcome, constraints, and ` +
    `acceptance criteria — it was not restated here on purpose. Execute it per AGENTS.md ` +
    `and, for review-worthy work, docs/bounded-review-cycle.md. Report back using ` +
    `AGENTS.md's Slice handoff format.`
  );
}

// Pure. Same reference-only size proxy diagnostic-trace.mjs's classifyPreDispatch uses
// (DEFAULT_REFERENCE_THRESHOLD_CHARS = 700), duplicated rather than imported: this
// directory and tools/telemetry are separate consumer-distributed units that should not
// depend on each other's internals (the same reasoning ready-dispatch-gate.mjs's module
// comment already gives for its own small parseHeadingField copy).
const REFERENCE_ONLY_THRESHOLD_CHARS = 700;

export function assertReferenceOnly(promptText, thresholdChars = REFERENCE_ONLY_THRESHOLD_CHARS) {
  if (promptText.length > thresholdChars) {
    throw new Error(
      `formatDispatchPrompt produced a ${promptText.length}-char prompt, over the ${thresholdChars}-char reference-only threshold — this should be structurally impossible from the fixed template; check for an unusually long route value`,
    );
  }
  return promptText;
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

function readStdinIfPiped() {
  try {
    if (process.stdin.isTTY) return null;
    const raw = readFileSync(0, "utf8").trim();
    return raw ? raw : null;
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let fields = null;
  if (args["control-issue"] || args["execution-issue"] || args.route) {
    fields = {
      controlIssue: args["control-issue"] != null ? Number(args["control-issue"]) : null,
      executionIssue: args["execution-issue"] != null ? Number(args["execution-issue"]) : null,
      route: args.route ?? null,
    };
  } else {
    const stdin = readStdinIfPiped();
    if (!stdin) {
      process.stderr.write(
        "format-dispatch-prompt.mjs: pipe ready-dispatch-gate.mjs's JSON output on stdin, or pass --control-issue/--execution-issue/--route explicitly\n",
      );
      process.exit(2);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(stdin);
    } catch (err) {
      process.stderr.write(`format-dispatch-prompt.mjs: could not parse stdin as JSON: ${err.message}\n`);
      process.exit(2);
      return;
    }
    if (parsed.state && parsed.state !== "READY_TO_DISPATCH") {
      process.stderr.write(
        `format-dispatch-prompt.mjs: input state is "${parsed.state}", not READY_TO_DISPATCH — refusing to format a dispatch prompt for a non-ready gate result\n`,
      );
      process.exit(2);
      return;
    }
    fields = { controlIssue: parsed.controlIssue, executionIssue: parsed.executionIssue, route: parsed.route };
  }

  let prompt;
  try {
    prompt = assertReferenceOnly(formatDispatchPrompt(fields));
  } catch (err) {
    process.stderr.write(`format-dispatch-prompt.mjs: ${err.message}\n`);
    process.exit(1);
    return;
  }

  process.stdout.write(`${prompt}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("format-dispatch-prompt.mjs")) {
  main();
}
