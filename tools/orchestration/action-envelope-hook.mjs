#!/usr/bin/env node
// Claude Code PreToolUse/PostToolUse hook — issue #641, extending issue #486/#607's
// action-envelope invariant from post-hoc classification to live, fail-closed tool-call
// denial for the "none" envelope mode.
//
// Problem this closes: `tools/orchestration/action-envelope.mjs`'s `classifyEnvelopeCompliance`
// already correctly judges a RECORDED action sequence against a verdict's envelope, and
// `verify-action-envelope.mjs` is the CLI wrapper for that judgment — but both are read-only
// analysis over an action list someone already produced (a diagnostic trace, a hand-built
// fixture). Neither one, by itself, stops a live controller from calling another tool in the
// same context. The live #639/PR #640 reproduction (2026-09-17) showed the previously-missing
// failure mode precisely: `next-review-transition-gate.mjs` returned `NO_ACTION_YET` with
// `stopAfter: true`, the controller explicitly recognized the contract required stopping, and
// still spent additional reasoning considering — though, in that run, ultimately not
// executing — reading `docs/bounded-review-cycle.md`, inspecting the gate implementation and
// issue content, invoking the `stage1-classifier-hardening` skill, and `spawn_task`, before
// eventually stopping. Prose recognition of the stop verdict is not itself enforcement; this
// module makes the zero-further-tool-calls boundary a property of the tool-call mechanism
// itself, not of the model's own follow-through.
//
// Mechanism: both `ready-dispatch-gate.mjs` and `next-review-transition-gate.mjs` already
// stamp a deterministic `actionEnvelope` (from `action-envelope.mjs`'s own authoritative
// table) onto every verdict object they print to stdout as their one JSON output line (issue
// #486). This hook does not re-derive that classification a second way — it only reads the
// `actionEnvelope.mode` the gate script itself already computed:
//
//   PostToolUse (Bash only): when the completed command actually invoked one of the two gate
//   scripts (a structural parse of the command's own "node <script>" token, never a raw
//   substring search — mirrors action-envelope.mjs's own `parseChainedCommands` discipline)
//   and its stdout's last JSON-shaped line carries `actionEnvelope.mode === "none"`, persist a
//   small session-scoped marker recording that this controller context's action authority is
//   exhausted.
//
//   PostToolUseFailure (Bash only, issue #641/Stage 1 review on PR #642): Claude Code routes a
//   Bash invocation through this distinct event — not PostToolUse — whenever the underlying
//   command exits nonzero, times out, or otherwise errors. Several no-action gate verdicts
//   (`BLOCKED`, `AMBIGUOUS`, `STAGE2_RESPONSE_UNUSABLE`, among others) intentionally exit
//   nonzero while still printing a complete `actionEnvelope`-stamped verdict to stdout, so a
//   PostToolUse-only wiring never observed them and the stop boundary went unenforced for
//   exactly the verdicts most likely to need it. This hook applies the identical
//   detect-and-mark logic to PostToolUseFailure's own payload, reading the failed command's
//   captured output from whichever field the payload actually carries (`tool_output`, then
//   `tool_response.stdout`, then `error` — the first is Claude Code's documented failure-output
//   field; the others are tolerated defensively since this repository had no prior
//   PostToolUseFailure wiring to cross-check against, consistent with this module's fail-open
//   philosophy on payload-shape uncertainty).
//
//   PreToolUse (every tool): if this session already has that marker, deny the call —
//   unconditionally, regardless of tool or intent — with a reason naming the verdict and
//   pointing at the fresh-invocation path. A denial does not itself end the turn (Claude Code
//   feeds the denial reason back and the model may attempt something else), but every further
//   attempt in the same session is denied identically, so the mechanically enforced outcome is
//   exactly "zero further operational tool calls succeed in this context" — provable from the
//   marker and the denied-call log alone, not from a transcript reading of whether the model
//   "chose" to stop.
//
// Scope: deliberately narrow to `mode === "none"`, reusing the verdict's own stamped field
// rather than hand-listing states — so `AMBIGUOUS`, `STAGE2_RESPONSE_UNUSABLE`, ordinary
// `BLOCKED`, and any future no-action verdict state are covered automatically, with zero
// changes here when action-envelope.mjs's table changes. `bounded`/`chain`-mode verdicts never
// set this marker, so an action-bearing transition's own authorized tool calls (dispatching a
// worker, merging, writing a control snapshot, chaining to the next gate) are never blocked by
// this mechanism — only `action-envelope.mjs`'s existing post-hoc classifier polices those,
// unchanged. This hook adds real-time enforcement for the "none" case specifically because
// that is the shape the #639/PR #640 near-miss (and #440 before it) actually demonstrated:
// deliberation drift after a verdict that authorizes nothing at all.
//
// Marker storage mirrors tools/telemetry/collect.mjs's own TELEMETRY_DIR convention: a
// gitignored, session-scoped directory outside durable repository state
// (`LDL_ACTION_ENVELOPE_STATE_DIR` overrides it, primarily so tests never touch a real
// session's on-disk marker). `sanitizeSessionId` is defined locally below (Stage 1 review
// finding on PR #642), with behavior matching collect.mjs's own function of the same name —
// the same path-traversal defense that module already documents — rather than imported from it.
//
// This module intentionally never throws and never exits non-zero for a data problem (a
// missing/malformed hook payload, an unwritable state directory): a fail-open default on
// infrastructure errors, unchanged from tools/telemetry/hook.mjs's own documented philosophy.
// "Fail closed" in this feature's own name refers to the no-action stop BOUNDARY once a real
// verdict has been observed, not to hook plumbing errors — an unreadable/absent marker means
// "no verdict observed yet in this session," which is the correct default allow state for
// every session before it ever runs a gate script.
//
// Wired in .claude/settings.json for PreToolUse (all tools), PostToolUse (Bash only), and
// PostToolUseFailure (Bash only).
// Tests: node --test tools/orchestration/action-envelope-hook.test.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const STATE_DIR = process.env.LDL_ACTION_ENVELOPE_STATE_DIR || join(ROOT, ".claude", "action-envelope-state");

// Inlined rather than imported from tools/telemetry/collect.mjs (Stage 1 review finding on
// PR #642): tools/orchestration/** is a MANAGED_ITEMS-installed path for consumer repositories
// (docs/consumer-contract.md), but tools/telemetry/** deliberately is not, so an installed
// consumer hook importing from it would throw ERR_MODULE_NOT_FOUND before main()'s own
// fail-open try ever runs. Keeping this hook self-contained inside its own already-managed
// path means it resolves correctly wherever tools/orchestration/** itself is installed.
// Identical behavior to collect.mjs's own sanitizeSessionId — same path-traversal defense.
export function sanitizeSessionId(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

// The only two scripts that ever emit an action-envelope-stamped verdict. Kept as a literal
// set (not derived from a directory scan) so an unrelated script sharing a stdout shape by
// coincidence is never treated as a verdict source.
const GATE_SCRIPT_BASENAMES = new Set(["ready-dispatch-gate.mjs", "next-review-transition-gate.mjs"]);

// Strips one layer of matching surrounding quotes (both '"' and "'") from a single shell
// token, e.g. the `"$CLAUDE_PROJECT_DIR/tools/orchestration/next-review-transition-gate.mjs"`
// shape real Claude Code Bash invocations of this repository's own gate scripts commonly use.
// Deliberately minimal — not a general shell tokenizer — because the only thing that matters
// here is recognizing the gate script's own basename regardless of whether the invoking
// command happened to quote its path.
function stripSurroundingQuotes(token) {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

// Structural parse of an executed shell command's own "&&"-separated segments: only the token
// immediately after a literal "node" token in each segment is ever treated as "the script
// being invoked" — never a raw substring match that could fire on an unrelated argument's own
// value (e.g. a `--label` containing the gate script's name in prose). Mirrors
// action-envelope.mjs's `parseChainedCommands` discipline, applied here to a real invoked
// command line rather than an internally-generated `nextCommand` chain string. The script-path
// token is quote-stripped before computing its basename (Stage 1 review finding on PR #642):
// a normal quoted invocation such as
// `node "$CLAUDE_PROJECT_DIR/tools/orchestration/next-review-transition-gate.mjs" --control-issue 487`
// previously produced the literal basename `next-review-transition-gate.mjs"` — carrying the
// closing quote character — and was never recognized as a gate script invocation at all.
export function invokedGateScriptBasenames(command) {
  if (typeof command !== "string" || command.length === 0) return [];
  const found = [];
  for (const segment of command.split("&&")) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const nodeIdx = tokens.indexOf("node");
    if (nodeIdx === -1) continue;
    const scriptPath = stripSurroundingQuotes(tokens[nodeIdx + 1] ?? "");
    const basename = scriptPath.split(/[\\/]/).pop() ?? "";
    if (GATE_SCRIPT_BASENAMES.has(basename)) found.push(basename);
  }
  return found;
}

// Parses the LAST line of stdout that is valid JSON and carries a recognizable verdict shape
// — a string `state` plus an `actionEnvelope` object with a string `mode` — exactly what both
// gate scripts' own `main()` prints via `console.log(JSON.stringify(result))`. Scanning from
// the end, and requiring the full shape (not just "is this JSON"), keeps this robust against
// incidental non-JSON noise earlier in the same command's output. Returns null for anything
// else, including the exitCode-1 operational-error shape that never reaches a verdict at all
// (that shape is written to stderr, not stdout, by both gate scripts).
export function extractVerdict(stdout) {
  if (typeof stdout !== "string") return null;
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.state === "string" &&
      parsed.actionEnvelope &&
      typeof parsed.actionEnvelope === "object" &&
      typeof parsed.actionEnvelope.mode === "string"
    ) {
      return parsed;
    }
  }
  return null;
}

// Pure decision: does this completed Bash tool call's command + stdout constitute observing a
// "none"-mode verdict from one of the two gate scripts? Returns the verdict object to persist
// (the marker-writer only reads a few fields off it), or null when nothing should be marked —
// either the command never invoked a gate script, no verdict-shaped JSON was found, or the
// verdict's own envelope mode is not "none" (bounded/chain/fallthrough all return null here;
// those remain governed by action-envelope.mjs's existing post-hoc classifier, unchanged).
export function detectNoActionVerdict(command, stdout) {
  if (invokedGateScriptBasenames(command).length === 0) return null;
  const verdict = extractVerdict(stdout);
  if (!verdict) return null;
  return verdict.actionEnvelope.mode === "none" ? verdict : null;
}

function markerPath(sessionId) {
  return join(STATE_DIR, `${sanitizeSessionId(sessionId)}.json`);
}

// Returns the parsed marker object for this session, or null if none exists / it is
// unreadable or malformed (fail-open on infrastructure trouble — see module header).
export function readMarker(sessionId, { readFileImpl = readFileSync, existsImpl = existsSync } = {}) {
  if (!sessionId) return null;
  const file = markerPath(sessionId);
  try {
    if (!existsImpl(file)) return null;
    return JSON.parse(readFileImpl(file, "utf8"));
  } catch {
    return null;
  }
}

// Persists the marker recording that this session's controller action authority is exhausted.
// Idempotent: re-observing another "none"-mode verdict in the same session simply overwrites
// the marker with the latest one (still a marker; still denies).
export function writeMarker(
  sessionId,
  verdict,
  { mkdirImpl = mkdirSync, writeFileImpl = writeFileSync } = {},
) {
  if (!sessionId) return null;
  mkdirImpl(STATE_DIR, { recursive: true });
  const marker = {
    state: verdict.state,
    mode: verdict.actionEnvelope.mode,
    reason: typeof verdict.reason === "string" ? verdict.reason : null,
    ts: new Date().toISOString(),
  };
  writeFileImpl(markerPath(sessionId), JSON.stringify(marker), "utf8");
  return marker;
}

// Pure: given an already-read marker (or null), decide the PreToolUse hook's own output.
// No exceptions by tool name or intent — a "none" envelope authorizes zero further
// operational tool calls, full stop; the one legitimate remaining action (a concise text
// handoff) needs no tool call at all and is therefore never denied by this hook.
export function decidePreToolUse(marker) {
  if (!marker) return { permissionDecision: "allow" };
  return {
    permissionDecision: "deny",
    permissionDecisionReason:
      `Action-envelope stop boundary already reached in this session (verdict "${marker.state}", ` +
      `envelope mode "${marker.mode}"). Per AGENTS.md § Session execution and docs/operating-model.md ` +
      "§ Action envelope enforcement (issue #486/#641), a no-action verdict authorizes zero further " +
      "repository/GitHub operational tool calls in this controller context. Do not retry this or any " +
      "other tool call — end this turn with the concise handoff instead. A fresh invocation re-reads " +
      "durable state and decides the next authorized transition.",
  };
}

// Extracts the captured output text from a PostToolUseFailure payload. Claude Code's
// documented field is `tool_output`; `tool_response.stdout` and `error` are tolerated as
// defensive fallbacks (see module header) in case the running harness version shapes this
// payload differently. Returns "" — never throws — when none of them hold a string.
export function extractFailureOutput(payload) {
  if (typeof payload?.tool_output === "string") return payload.tool_output;
  if (typeof payload?.tool_response?.stdout === "string") return payload.tool_response.stdout;
  if (typeof payload?.error === "string") return payload.error;
  return "";
}

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw || raw.trim().length === 0) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function main() {
  try {
    const payload = readStdinJson();
    const sessionId = typeof payload?.session_id === "string" ? payload.session_id : null;

    if (payload?.hook_event_name === "PostToolUse" && sessionId) {
      if (payload.tool_name === "Bash") {
        const command = payload.tool_input?.command;
        const stdout = payload.tool_response?.stdout;
        const verdict = detectNoActionVerdict(command, stdout);
        if (verdict) writeMarker(sessionId, verdict);
      }
      process.exit(0);
      return;
    }

    if (payload?.hook_event_name === "PostToolUseFailure" && sessionId) {
      if (payload.tool_name === "Bash") {
        const command = payload.tool_input?.command;
        const stdout = extractFailureOutput(payload);
        const verdict = detectNoActionVerdict(command, stdout);
        if (verdict) writeMarker(sessionId, verdict);
      }
      process.exit(0);
      return;
    }

    if (payload?.hook_event_name === "PreToolUse" && sessionId) {
      const marker = readMarker(sessionId);
      const decision = decidePreToolUse(marker);
      if (decision.permissionDecision === "deny") {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: decision.permissionDecisionReason,
            },
          }),
        );
      }
      process.exit(0);
      return;
    }
  } catch {
    // Deliberately swallowed — see module header: a hook infrastructure failure must never
    // interrupt or slow down real session use.
  }
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
