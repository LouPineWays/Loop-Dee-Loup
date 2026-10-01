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
//     with a PATCH method and a `body` field, or any non-GET `--input` payload;
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

// Shell-aware lexer: splits a command into statements of tokens, honoring quotes, backslash
// line-continuations, and quoted multiline arguments, so a forbidden `gh` call is judged on its
// own tokens regardless of how it is wrapped. Quote characters are stripped from tokens.
function lex(command) {
  const statements = [];
  let toks = [];
  let cur = "";
  let has = false;
  let quote = null;
  const endTok = () => { if (has) toks.push(cur); cur = ""; has = false; };
  const endStmt = () => { endTok(); if (toks.length) statements.push(toks); toks = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === "\\" && i + 1 < command.length) { cur += command[++i]; }
      else cur += c;
      continue;
    }
    if (c === "\\") {
      const n = command[i + 1];
      if (n === "\n") { i++; continue; }
      if (n === "\r" && command[i + 2] === "\n") { i += 2; continue; }
      if (n !== undefined) { cur += n; has = true; i++; }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "\r") { endStmt(); continue; }
    if (c === " " || c === "\t") { endTok(); continue; }
    cur += c; has = true;
  }
  endStmt();
  return statements;
}

// gh global/inherited options that consume a following value.
const GH_VALUE_OPTS = new Set(["-R", "--repo", "--hostname"]);

// Locates the `gh` invocation and returns { sub: [first two non-option words], rest: [remaining tokens] }.
function ghInvocation(toks) {
  let i = toks.findIndex((t) => t === "gh" || /[\/]gh(?:\.exe)?$/.test(t));
  if (i === -1) return null;
  i++;
  const words = [];
  let restStart = toks.length;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (words.length >= 2) { restStart = i; break; }
    if (t.startsWith("-")) {
      if (GH_VALUE_OPTS.has(t)) i++;
      continue;
    }
    words.push(t);
  }
  return { sub: words, rest: toks.slice(restStart), all: toks };
}

function isGhIssueEditBodyWrite(inv) {
  if (inv.sub[0] !== "issue" || inv.sub[1] !== "edit") return false;
  return inv.all.some((t) => {
    if (t === "--body" || t === "--body-file" || t.startsWith("--body=") || t.startsWith("--body-file=")) return true;
    // Short flags, including attached values (-bX, -b=X, -Fbody.md) and clusters.
    return /^-[A-Za-z]*[bF]/.test(t) && !t.startsWith("--");
  });
}

function isGhApiIssueBodyPatch(inv) {
  if (inv.sub[0] !== "api" || inv.sub[1] === "graphql") return false;
  const toks = inv.all;
  // A bare `issues/<N>` endpoint (query string stripped); comment endpoints are never an
  // Issue-body write.
  const endpoint = toks.find((t) => /(?:^|\/)issues\/(?:\d+|\$\{?\w+\}?|\{\w+\})$/.test(t.split("?")[0]));
  if (!endpoint) return false;
  const joined = toks.join(" ");
  const get = toks.some((t, i) => /^(?:-X|--method)$/.test(t) && /^GET$/i.test(toks[i + 1] || "")) || /--method=GET\b/i.test(joined) || /(?:^| )-XGET\b/i.test(joined);
  if (get) return false;
  const patch =
    toks.some((t, i) => /^(?:-X|--method)$/.test(t) && /^PATCH$/i.test(toks[i + 1] || "")) ||
    /(?:^|\s)(?:--method=|-X=?)PATCH\b/i.test(joined);
  // `--input` supplies the whole request body from a file/stdin we cannot inspect: deny
  // conservatively on any non-GET call to an issue endpoint.
  const input = toks.some((t) => t === "--input" || t.startsWith("--input="));
  const bodyField = toks.some((t, i) => {
    if (/^(?:-f|-F|--field|--raw-field)$/.test(t)) return /^body(?:=|$)/.test(toks[i + 1] || "");
    if (/^--(?:field|raw-field)=body(?:=|$)/.test(t)) return true;
    return /^-[fF]body(?:=|$)/.test(t);
  });
  return input || (patch && bodyField);
}

function isGraphqlUpdateIssue(inv, statementText) {
  if (inv.sub[0] !== "api" || inv.sub[1] !== "graphql") return false;
  return /updateIssue\b/.test(statementText);
}

// Pure. Returns { permissionDecision: "allow" } or a deny decision with a reason.
export function decideRawControlBodyWrite({ toolName, command } = {}) {
  if (toolName !== "Bash" || typeof command !== "string" || command.length === 0) {
    return { permissionDecision: "allow" };
  }
  for (const toks of lex(command)) {
    const inv = ghInvocation(toks);
    if (!inv) continue;
    if (
      isGhIssueEditBodyWrite(inv) ||
      isGhApiIssueBodyPatch(inv) ||
      isGraphqlUpdateIssue(inv, toks.join(" "))
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
