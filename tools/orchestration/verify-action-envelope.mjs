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

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    args[a.slice(2)] = argv[++i];
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
  const args = parseArgs(process.argv.slice(2));
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
