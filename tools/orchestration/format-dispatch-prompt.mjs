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
// Usage (piped from the gate, the normal path — the gate derives repository identity
// deterministically from the checkout's own "origin" remote; issue #344):
//   node tools/orchestration/ready-dispatch-gate.mjs --control-issue 322 \
//     | node tools/orchestration/format-dispatch-prompt.mjs
//
// Usage (explicit fields — only when a READY gate result's fields are already in hand
// outside a pipe, e.g. re-rendering the same dispatch prompt from a recorded gate result,
// or this script's own tests):
//   node tools/orchestration/format-dispatch-prompt.mjs \
//     --control-issue 322 --execution-issue 321 --route "implementation worker"
//
// Stage 1 review finding on this PR: this is NOT the right tool for a legacy-unsplit
// routing worker (docs/operating-model.md § Two-plane Issue dispatch, "Legacy unsplit
// Issues"). This template always says "Implementation worker dispatch" and tells the
// worker to execute the issue and report a Slice handoff — correct only for a worker
// that is actually authorized to execute a full vertical slice. A routing worker's job is
// the opposite: read the full issue and return only a compact projection (outcome shape,
// executor/persona, blocker state, authority conflicts) so the controller can decide
// decomposition, never begin implementation. Using this formatter for that dispatch would
// hand a routing worker an executor's mandate before the decomposition boundary is
// resolved. This script has exactly one template for exactly one role — an implementation
// worker dispatched on a satisfied READY immediate-dispatch gate — and that scope is
// deliberate, not an oversight to be widened with a second mode.
//
// Tests: node --test tools/orchestration/format-dispatch-prompt.test.mjs

import { readFileSync } from "node:fs";

// Pure. True only for a finite, whole, positive number — the shape a real GitHub issue
// number always has. Stage 1 review finding on this PR: `Number("abc")` is `NaN` and
// `Number("-7")`/`Number("12.5")` are finite but not valid issue numbers; none of those
// are caught by a bare `== null` check (`NaN == null` and `-7 == null` are both false), so
// a mistyped or non-integral explicit CLI argument previously reached the template
// unvalidated and produced references like "#NaN" that callers would use verbatim for
// dispatch.
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

// Pure. Renders the fixed reference-only template. Kept deliberately inert — no
// conditionals that grow the text based on route or issue content — so its length is
// bounded by construction rather than by reviewer discipline. A route string picked up
// from a control Issue's "- **Route:** <value>" bullet is inserted verbatim (already
// validated non-empty/non-"none" by `evaluateReadyDispatchGate` upstream), so an unusually
// long route value could in principle push this over the reference-only threshold;
// `assertReferenceOnly` below is the guard against that, not a length cap baked into the
// template itself.
export function formatDispatchPrompt({ controlIssue, executionIssue, route }) {
  if (!isPositiveInteger(controlIssue) || !isPositiveInteger(executionIssue) || typeof route !== "string" || !route.trim()) {
    throw new Error(
      "formatDispatchPrompt requires controlIssue and executionIssue to be positive integers and route to be a non-empty string",
    );
  }
  return (
    `Implementation worker dispatch. Execution Issue: #${executionIssue}. ` +
    `Controlling Issue: #${controlIssue}. Route: ${route}.\n\n` +
    `Read #${executionIssue} directly from GitHub for its full outcome, constraints, and ` +
    `acceptance criteria — it was not restated here on purpose. Execute it per AGENTS.md ` +
    `and, for review-worthy work, docs/bounded-review-cycle.md. Report back using ` +
    `AGENTS.md's Slice handoff format. Once the PR exists — Stage 1 review requested, or ` +
    `a recorded Stage 1 exemption for non-review-worthy work — stop: do not wait, poll, ` +
    `merge, or begin Stage 2; those are fresh-worker or deterministic steps per ` +
    `docs/operating-model.md § Watched lifecycle breakpoints.`
  );
}

// Pure. Renders the fixed reference-only "Planning worker dispatch" template for #397's new
// READY_FOR_PLAN pre-PR Lifecycle value (tools/orchestration/ready-dispatch-gate.mjs's
// READY_TO_DISPATCH_PLANNING verdict). Deliberately carries no `route` parameter, unlike
// formatDispatchPrompt above: #397's Shared Contract fixes this template to "control Issue +
// execution Issue references only" — READY_FOR_PLAN's Route is always the fixed literal
// "planning worker" (already enforced by the gate itself), so restating it in the prompt
// would add nothing a fresh planning worker doesn't already know from the word "Planning" in
// this template's own first line.
export function formatPlanningWorkerDispatchPrompt({ controlIssue, executionIssue }) {
  if (!isPositiveInteger(controlIssue) || !isPositiveInteger(executionIssue)) {
    throw new Error("formatPlanningWorkerDispatchPrompt requires controlIssue and executionIssue to be positive integers");
  }
  return (
    `Planning worker dispatch. Execution Issue: #${executionIssue}. Controlling Issue: #${controlIssue}.\n\n` +
    `Read #${executionIssue} directly from GitHub for its full outcome, constraints, and acceptance ` +
    `criteria — it was not restated here on purpose. Determine whether it is one bounded vertical ` +
    `slice or genuinely requires decomposition per AGENTS.md. If it requires decomposition, produce ` +
    `this Issue's Execution Plan Index, Shared Contract, and Worker Unit Contract comments per ` +
    `docs/operating-model.md's durable plan artifact conventions and do not begin implementing any ` +
    `resulting unit yourself. Report back using AGENTS.md's Slice handoff format once the plan (or the ` +
    `single-slice determination) is durable, then stop.`
  );
}

// Pure. Renders the fixed reference-only "Integration/PR worker dispatch" template for
// #397's new EXECUTION_COMPLETE pre-PR Lifecycle value (ready-dispatch-gate.mjs's
// READY_TO_DISPATCH_INTEGRATION verdict). Also carries no `route` parameter, for the same
// reason as the planning template above — the Integration/PR worker's job is fixed by
// docs/bounded-review-cycle.md § Integration/PR worker, not by a route string.
export function formatIntegrationWorkerDispatchPrompt({ controlIssue, executionIssue }) {
  if (!isPositiveInteger(controlIssue) || !isPositiveInteger(executionIssue)) {
    throw new Error("formatIntegrationWorkerDispatchPrompt requires controlIssue and executionIssue to be positive integers");
  }
  return (
    `Integration/PR worker dispatch. Execution Issue: #${executionIssue}. Controlling Issue: ` +
    `#${controlIssue}.\n\n` +
    `Read #${executionIssue}'s own Execution Plan Index, Shared Contract, and Worker Unit Contract ` +
    `comments directly from GitHub — they were not restated here on purpose. Integrate the completed ` +
    `units and open the one PR per docs/bounded-review-cycle.md § Integration/PR worker. Report back ` +
    `using AGENTS.md's Slice handoff format. Once the PR exists — Stage 1 review requested, or a ` +
    `recorded Stage 1 exemption for non-review-worthy work — stop, per docs/operating-model.md § ` +
    `Watched lifecycle breakpoints.`
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

// #397's two new templates are selected by the piped gate result's own `state` field —
// ready-dispatch-gate.mjs's READY_TO_DISPATCH_PLANNING/READY_TO_DISPATCH_INTEGRATION verdicts
// — never by a caller re-deciding which template applies. READY_TO_DISPATCH keeps using the
// original "Implementation worker dispatch" template unchanged. Neither new template takes a
// `route` field (see each formatter's own comment for why), so the field set piped through
// differs by kind.
const TEMPLATES_BY_STATE = {
  READY_TO_DISPATCH: { formatter: formatDispatchPrompt, needsRoute: true },
  READY_TO_DISPATCH_PLANNING: { formatter: formatPlanningWorkerDispatchPrompt, needsRoute: false },
  READY_TO_DISPATCH_INTEGRATION: { formatter: formatIntegrationWorkerDispatchPrompt, needsRoute: false },
};

// Explicit-fields mode's equivalent of the state-based selection above, for a caller
// re-rendering a prompt outside a live pipe (e.g. this script's own tests). Defaults to
// "implementation" so every pre-existing explicit-fields invocation keeps working unchanged.
const FORMATTERS_BY_KIND = {
  implementation: { formatter: formatDispatchPrompt, needsRoute: true },
  planning: { formatter: formatPlanningWorkerDispatchPrompt, needsRoute: false },
  integration: { formatter: formatIntegrationWorkerDispatchPrompt, needsRoute: false },
};

function main() {
  const args = parseArgs(process.argv.slice(2));

  let formatter;
  let fields = null;
  if (args["control-issue"] || args["execution-issue"] || args.route || args.kind) {
    const kind = args.kind ?? "implementation";
    const entry = FORMATTERS_BY_KIND[kind];
    if (!entry) {
      process.stderr.write(
        `format-dispatch-prompt.mjs: unknown --kind ${JSON.stringify(kind)} — use "implementation", "planning", or "integration"\n`,
      );
      process.exit(2);
      return;
    }
    formatter = entry.formatter;
    fields = {
      controlIssue: args["control-issue"] != null ? Number(args["control-issue"]) : null,
      executionIssue: args["execution-issue"] != null ? Number(args["execution-issue"]) : null,
      ...(entry.needsRoute ? { route: args.route ?? null } : {}),
    };
  } else {
    const stdin = readStdinIfPiped();
    if (!stdin) {
      process.stderr.write(
        "format-dispatch-prompt.mjs: pipe ready-dispatch-gate.mjs's JSON output on stdin, or pass --control-issue/--execution-issue/--route (and optionally --kind) explicitly\n",
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
    // Stage 1 review finding on this PR (pre-#397): the original `parsed.state &&
    // parsed.state !== "READY_TO_DISPATCH"` check only rejected an explicit non-ready
    // state — a payload that omitted `state` entirely (a malformed or schema-drifted gate
    // result that still happened to carry controlIssue/executionIssue/route) fell through
    // this check and was formatted into a dispatch prompt anyway. `state` must be exactly
    // one of the recognized ready states above; anything else, including absent, is refused.
    const entry = TEMPLATES_BY_STATE[parsed.state];
    if (!entry) {
      process.stderr.write(
        `format-dispatch-prompt.mjs: input state is ${JSON.stringify(parsed.state ?? null)}, not "READY_TO_DISPATCH" ` +
          `(or "READY_TO_DISPATCH_PLANNING"/"READY_TO_DISPATCH_INTEGRATION") — refusing to format a dispatch prompt ` +
          "for a non-ready or malformed gate result\n",
      );
      process.exit(2);
      return;
    }
    formatter = entry.formatter;
    fields = {
      controlIssue: parsed.controlIssue,
      executionIssue: parsed.executionIssue,
      ...(entry.needsRoute ? { route: parsed.route } : {}),
    };
  }

  let prompt;
  try {
    prompt = assertReferenceOnly(formatter(fields));
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
