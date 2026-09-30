#!/usr/bin/env node
// Live-controller enforcement boundary for raw Issue-body mutation -- issue #799 (control #438).
//
// Background: #768 made `validateControlSnapshot` (control-field-validator.mjs) the one
// write-side validator for parser-sensitive thin-control body state, and
// `write-control-snapshot.mjs` the one approved low-level persistence seam. But that perimeter
// only binds code that chooses to call it: a live controller session holding a broad
// `Bash(gh issue *)` / `Bash(gh api *)` permission could still run `gh issue edit --body-file`
// directly, persisting an unvalidated body (the 2026-09-30 #726 `Blocker: #761 -- ...`
// recurrence). This module is a Claude Code `PreToolUse` Bash hook that refuses exactly that
// shape and points the caller at `write-control-snapshot.mjs`. It is a mechanical boundary, not
// prose guidance.
//
// It refuses (deterministic, purely syntactic, no network):
//   - `gh issue edit ... --body | -b | --body-file | -F` (a body rewrite; label/assignee-only
//     edits are untouched);
//   - `gh api ... issues/<N>` (NOT `issues/comments/...`, NOT `issues/<N>/comments`) combined
//     with a PATCH method and a `body` field;
//   - `gh api graphql` carrying an `updateIssue` mutation.
// It permits `node tools/orchestration/write-control-snapshot.mjs ...`, every comment write,
// `gh pr edit`, and everything else. Human/external GitHub edits are outside this boundary by
// design (treated as untrusted input, failing closed at consumption).
//
// Fails open on any hook-infrastructure error (never interrupts real session use), exactly like
// action-envelope-hook.mjs. The decision function is pure and exported for tests.
//
// Tests: node --test tools/orchestration/control-body-write-guard.test.mjs

import { readFileSync } from "node:fs";

// Splits a command line on shell statement separators so a forbidden `gh` segment is judged on
// its own tokens rather than as a substring of an unrelated quoted argument elsewhere.
function segments(command) {
  return command.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
}

function tokens(segment) {
  return segment.split(/\s+/).filter(Boolean);
}

const BODY_FLAGS = new Set(["--body", "-b", "--body-file", "-F"]);

function isGhIssueEditBodyWrite(toks) {
  const ghIdx = toks.indexOf("gh");
  if (ghIdx === -1) return false;
  if (toks[ghIdx + 1] !== "issue" || toks[ghIdx + 2] !== "edit") return false;
  return toks.slice(ghIdx + 3).some((t) => {
    if (BODY_FLAGS.has(t)) return true;
    return t.startsWith("--body=") || t.startsWith("--body-file=");
  });
}

function isGhApiIssueBodyPatch(toks, segment) {
  const ghIdx = toks.indexOf("gh");
  if (ghIdx === -1 || toks[ghIdx + 1] !== "api") return false;
  // A bare `issues/<N>` endpoint (optionally with a trailing quote); comment endpoints are never
  // an Issue-body write.
  const endpoint = toks.slice(ghIdx + 2).find((t) => /repos\/[^/\s]+\/[^/\s]+\/issues\/(?:\d+|\$\{?\w+\}?)["']?$/.test(t));
  if (!endpoint) return false;
  const patch = /(?:^|\s)(?:-X|--method)[\s=]+PATCH\b/i.test(segment) || /--method=PATCH/i.test(segment);
  const bodyField = /(?:^|\s)(?:-f|-F|--field|--raw-field)[\s=]+["']?body\b/.test(segment);
  return patch && bodyField;
}

function isGraphqlUpdateIssue(toks, segment) {
  const ghIdx = toks.indexOf("gh");
  if (ghIdx === -1 || toks[ghIdx + 1] !== "api" || toks[ghIdx + 2] !== "graphql") return false;
  return /updateIssue\b/.test(segment);
}

// Pure. Returns { permissionDecision: "allow" } or a deny decision with a reason.
export function decideRawControlBodyWrite({ toolName, command } = {}) {
  if (toolName !== "Bash" || typeof command !== "string" || command.length === 0) {
    return { permissionDecision: "allow" };
  }
  for (const segment of segments(command)) {
    const toks = tokens(segment);
    if (
      isGhIssueEditBodyWrite(toks) ||
      isGhApiIssueBodyPatch(toks, segment) ||
      isGraphqlUpdateIssue(toks, segment)
    ) {
      return {
        permissionDecision: "deny",
        permissionDecisionReason:
          "Raw Issue-body mutation refused (issue #799, control #438): thin-control Issue bodies are " +
          "parser-sensitive, and every LDL-owned body write must pass the canonical complete-snapshot " +
          "validator before persistence. Compose the full proposed body and persist it via " +
          "`node tools/orchestration/write-control-snapshot.mjs --control-issue <N> --body-file <path|->` " +
          "(or a lifecycle transition through transition-guard / its specialized finalizer). Do not retry " +
          "this raw edit. Label/assignee edits and comment writes are unaffected.",
      };
    }
  }
  return { permissionDecision: "allow" };
}

function main() {
  try {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    if (payload?.hook_event_name !== "PreToolUse") {
      process.exit(0);
      return;
    }
    const decision = decideRawControlBodyWrite({
      toolName: payload.tool_name,
      command: payload.tool_input?.command,
    });
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
  } catch {
    // Fail open: a hook infrastructure failure must never interrupt real session use.
  }
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("control-body-write-guard.mjs")) {
  main();
}
