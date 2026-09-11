#!/usr/bin/env node
// CLI wrapper around action-envelope.mjs's classifyEnvelopeCompliance — issue #486.
//
// Deterministically checks a recorded sequence of controller actions against the action
// envelope a lifecycle gate verdict authorized, so a violation of AGENTS.md § Session
// execution's "one verdict-authorized transition per controller context" invariant is
// detectable and fail-closed rather than resting on a controller's own self-report.
//
// Usage:
//   node tools/orchestration/verify-action-envelope.mjs --state <VERDICT_STATE> \
//     --actions <comma-separated action-kind list> [--actions-file <path-to-json-array>]
//
// Exit codes: 0 compliant, 5 violation, 1 usage/operational error. Prints one JSON line with
// {status, envelope, reasons} to stdout (violation reasons also go to stderr for a quick
// human-readable read).

import { readFileSync } from "node:fs";
import { classifyEnvelopeCompliance } from "./action-envelope.mjs";

// Stage 1 finding on PR #534: the previous version consumed the next token unconditionally,
// whether or not it was actually present or was itself another `--option`. That let a malformed
// invocation silently certify compliance instead of failing — `--state --actions rerun-gate`
// read as state `"--actions"` (unrecognized, so `getActionEnvelope` failed closed to
// zero-authorized-actions) with the real actions list dropped entirely, and
// `--state READY_TO_DISPATCH --actions-file` (missing its value) silently fell back to an empty
// actions list — both exited 0 (compliant) despite never checking the actions the caller
// actually meant to supply. Every option now requires a real value: a following token that is
// absent, or itself starts with "--", is a usage error, not a silently-accepted empty value.
const KNOWN_OPTIONS = new Set(["state", "actions", "actions-file"]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      throw new Error(`unexpected positional argument "${a}"`);
    }
    const name = a.slice(2);
    if (!KNOWN_OPTIONS.has(name)) {
      throw new Error(`unknown option "--${name}"`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`option "--${name}" requires a value`);
    }
    args[name] = value;
    i++;
  }
  return args;
}

function loadActions(args) {
  if (args["actions-file"]) {
    const raw = JSON.parse(readFileSync(args["actions-file"], "utf8"));
    if (!Array.isArray(raw)) throw new Error(`--actions-file must contain a JSON array of action-kind strings`);
    return raw;
  }
  if (typeof args.actions === "string") {
    return args.actions
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`verify-action-envelope.mjs: ${err.message}\n`);
    process.exit(1);
    return;
  }
  if (!args.state) {
    process.stderr.write("verify-action-envelope.mjs: --state <VERDICT_STATE> is required\n");
    process.exit(1);
    return;
  }

  let actions;
  try {
    actions = loadActions(args);
  } catch (err) {
    process.stderr.write(`verify-action-envelope.mjs: ${err.message}\n`);
    process.exit(1);
    return;
  }

  const result = classifyEnvelopeCompliance(args.state, actions);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "violation") {
    for (const reason of result.reasons) process.stderr.write(`violation: ${reason}\n`);
    process.exit(5);
    return;
  }
  process.exit(0);
}

const isMain = process.argv[1] && process.argv[1].endsWith("verify-action-envelope.mjs");
if (isMain) {
  main();
}
