#!/usr/bin/env node
// Detects and classifies the "GitHub Actions is not permitted to create pull requests"
// repository-setting failure mode for an LDL Sync workflow (issue #217; see
// docs/consumer-contract.md, "Automated consumer sync"). A workflow's own
// `permissions: pull-requests: write` block is necessary but not sufficient: GitHub also has a
// repository-level Settings -> Actions -> General -> Workflow permissions setting ("Allow
// GitHub Actions to create and approve pull requests") that must independently be enabled, and
// a valid token cannot override it. This script gives an ldl-sync workflow two independent ways
// to detect that condition distinctly from a managed-file conflict or an unexpected failure:
//
//   preflight  - a best-effort read of the repository setting itself, so the workflow can fail
//                fast before ever pushing the shared sync branch, when the calling token
//                happens to have read access to it.
//   classify   - a reliable, after-the-fact classification of a failed `gh pr create`/`gh pr
//                edit` invocation's stderr, for when preflight can't answer (the common case:
//                the default GITHUB_TOKEN does not carry the "administration: read" scope
//                reading the repository setting requires, so preflight reports "unknown" rather
//                than guessing).
//
// Usage:
//   node tools/ldl-sync/pr-permission.mjs preflight --repo <owner/repo>
//     Prints {"status":"allowed"|"denied"|"unknown","reason"?} to stdout. Exit 3 only for a
//     confidently "denied" result (fail fast, before any push); exit 0 for "allowed" or
//     "unknown" — the workflow proceeds to the real gh pr create attempt either way, since
//     "unknown" means preflight genuinely could not tell.
//   node tools/ldl-sync/pr-permission.mjs classify <<< "$STDERR_TEXT"
//     Reads gh pr create/edit's captured stderr from stdin, prints
//     {"outcome":"pr_creation_denied"|"unexpected","summary":"<markdown>"} to stdout. Exit 4 for
//     "pr_creation_denied", exit 1 for "unexpected" — two distinct non-zero exit codes so the
//     calling workflow step can branch on which failure class actually occurred.
//
// Tests: node --test tools/ldl-sync/pr-permission.test.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REMEDIATION =
  'Settings -> Actions -> General -> Workflow permissions -> "Allow GitHub Actions to create and approve pull requests"';

// The literal substring GitHub's GraphQL API returns when a repository has the setting above
// disabled (reproduced verbatim on YouTubery scheduled run 33310402496, issue #217): "GraphQL:
// GitHub Actions is not permitted to create or approve pull requests (createPullRequest)".
// Matched case-insensitively against gh's own formatted stderr, since gh does not expose the
// underlying GraphQL error type separately from its "pull request create failed: ..." wrapper.
const PR_CREATION_DENIED_SUBSTRING = "is not permitted to create or approve pull requests";

// Classifies a failed `gh pr create`/`gh pr edit` invocation's captured stderr text. Pure
// string match, no I/O, so it's trivially unit-testable against real captured stderr without
// depending on gh or a live repository.
export function classifyPrCreateFailure(stderrText) {
  const text = (stderrText || "").toLowerCase();
  return text.includes(PR_CREATION_DENIED_SUBSTRING) ? "pr_creation_denied" : "unexpected";
}

export function formatDeniedSummary() {
  return [
    "### LDL Sync: PR creation blocked by repository policy",
    "",
    "GitHub Actions is not permitted to create or approve pull requests in this repository.",
    `Fix: ${REMEDIATION}`,
    "",
    "The LDL update and scope verification already succeeded, and the sync branch may already",
    "have been pushed, but no pull request exists yet. This is not a managed-file conflict and",
    "not an unexpected operational failure — it is a missing repository prerequisite. Do not",
    "treat the pushed sync branch as a completed synchronization. See",
    'docs/consumer-contract.md, "Automated consumer sync".',
  ].join("\n");
}

export function formatUnexpectedSummary(stderrText) {
  return [
    "### LDL Sync: PR creation failed unexpectedly",
    "",
    "```",
    (stderrText || "").trim(),
    "```",
    "",
    "This does not match the known GitHub Actions PR-creation-permission failure — see",
    'docs/consumer-contract.md, "Automated consumer sync" for that specific case. This needs',
    "founder/agent investigation before the next automated run can proceed.",
  ].join("\n");
}

// Best-effort preflight read of GET /repos/{repo}/actions/permissions/workflow's
// `can_approve_pull_request_reviews` field — GitHub's own (confusingly named) API field for the
// exact "Allow GitHub Actions to create and approve pull requests" checkbox; it governs both PR
// approval and PR creation by Actions as one combined setting. Reading it requires the calling
// token to hold "administration: read" on the repository, which the default GITHUB_TOKEN does
// not have unless a workflow explicitly requests that permission — so this is deliberately
// best-effort, not authoritative: any failure to read (missing scope, gh not installed, network
// error, unexpected response shape) reports "unknown" rather than being treated as either
// "allowed" or "denied". The reliable signal for this failure mode is classifyPrCreateFailure()
// above, applied to the actual gh pr create/edit attempt; this preflight exists only to fail
// fast and skip the branch push/PR attempt entirely in the case where the token *does* have
// read access (requirement 2 of issue #217: detect before pushing/mutating the shared sync
// branch, where GitHub exposes a reliable way to do so).
export function preflightPrPermission(repo, deps = {}) {
  const { execImpl = execFileSync } = deps;
  let raw;
  try {
    raw = execImpl("gh", ["api", `repos/${repo}/actions/permissions/workflow`], { encoding: "utf8" });
  } catch (err) {
    return { status: "unknown", reason: `preflight read failed: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: "unknown", reason: `preflight response was not valid JSON: ${err.message}` };
  }
  if (typeof parsed.can_approve_pull_request_reviews !== "boolean") {
    return { status: "unknown", reason: "preflight response did not include can_approve_pull_request_reviews" };
  }
  return parsed.can_approve_pull_request_reviews ? { status: "allowed" } : { status: "denied" };
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    args[a.slice(2)] = argv[++i];
  }
  return args;
}

function readStdin(readFileImpl) {
  try {
    return readFileImpl(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (mode === "preflight") {
    if (!args.repo) {
      console.error("Missing required arg: --repo <owner/repo>");
      process.exit(1);
    }
    const result = preflightPrPermission(args.repo);
    console.log(JSON.stringify(result));
    process.exit(result.status === "denied" ? 3 : 0);
  } else if (mode === "classify") {
    const stderrText = readStdin(readFileSync);
    const outcome = classifyPrCreateFailure(stderrText);
    const summary = outcome === "pr_creation_denied" ? formatDeniedSummary() : formatUnexpectedSummary(stderrText);
    console.log(JSON.stringify({ outcome, summary }));
    process.exit(outcome === "pr_creation_denied" ? 4 : 1);
  } else {
    console.error("Usage: node tools/ldl-sync/pr-permission.mjs preflight --repo <owner/repo>");
    console.error("       node tools/ldl-sync/pr-permission.mjs classify < stderr.log");
    process.exit(1);
  }
}

// Only run as a CLI when this exact file is the process entrypoint, not merely when some
// other script's argv[1] happens to end in "pr-permission.mjs" (Stage 1 review finding on PR
// #219) — matching the same exact-identity guard tools/ldl-init/index.mjs and
// tools/ldl-update/index.mjs already use.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
