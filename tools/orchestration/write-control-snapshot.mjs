#!/usr/bin/env node
// Deterministic write-before-validate helper for normal LDL-authored thin control Issue body
// mutations — issue #510 (unit 510-A).
//
// The #499 corruption (see control-field-validator.mjs's own module comment for the exact
// reproduction) was not written by any script: the Shared Contract on #510 records that no
// centralized mutation surface currently mediates a session editing a thin control Issue's own
// body ("an orchestrating Claude Code session directly editing a thin control Issue body per
// AGENTS.md § Session execution step 4 ... No script currently mediates this path"). #510's
// Required Behavior #1 explicitly authorizes "the smallest bounded helper/procedure needed to
// make normal LDL-authored control updates pass through this validation" for exactly this case
// — this script is that helper. It is not a generalized Issue-editing framework: it accepts one
// already-composed proposed body and either writes it verbatim (valid) or refuses without
// touching the issue at all (invalid) — see AGENTS.md § Parent snapshots for the pointer that
// makes this the required path for a normal control-state update.
//
// Usage:
//   node tools/orchestration/write-control-snapshot.mjs --control-issue 499 --body-file ./proposed-body.md
//   cat proposed-body.md | node tools/orchestration/write-control-snapshot.mjs --control-issue 499 --body-file -
//
// Repository identity: like ready-dispatch-gate.mjs, --repo is accepted only as an explicit
// tests/exceptional-invocation override; the normal path derives it from the checkout's own
// configured `origin` remote via resolveRepoIdentity (issue #344) so a caller never hand-types
// (or mistypes) the owner/repo slug that governs which Issue is mutated.
//
// Exit codes:
//   0 — WRITTEN. The proposed body passed validateControlSnapshot and was persisted verbatim
//       via `gh issue edit --body-file -`.
//   1 — operational error (missing required arg, unresolved repository identity, or the `gh`
//       write itself failed/threw). The durable Issue body is left exactly as it was: this
//       script never mutates the issue until after validation has already passed.
//   2 — REJECTED. The proposed body failed validateControlSnapshot; the reasons are printed
//       and the durable Issue body is left byte-for-byte unchanged — the write is never
//       attempted (Verification case 7's write-before-validate ordering).
//
// Tests: node --test tools/orchestration/write-control-snapshot.test.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { validateControlSnapshot } from "./control-field-validator.mjs";
import { resolveRepoIdentity } from "./ready-dispatch-gate.mjs";

function defaultGhEditControlIssue({ repo, controlIssue, body }) {
  execFileSync("gh", ["issue", "edit", String(controlIssue), "--repo", repo, "--body-file", "-"], {
    input: body,
    encoding: "utf8",
  });
}

// Pure core (`ghEditImpl` injected so tests never touch the network or the real `gh` CLI):
// validates `proposedBody` before ever calling `ghEditImpl`, so an invalid proposal cannot
// reach the mutation step at all — the ordering Verification case 7 requires, not merely a
// convention this function happens to follow.
export function checkWriteControlSnapshot({ repo, controlIssue, proposedBody }, { ghEditImpl = defaultGhEditControlIssue } = {}) {
  if (!controlIssue) {
    return { exitCode: 1, message: "Missing required arg: --control-issue is required." };
  }
  if (typeof proposedBody !== "string") {
    return { exitCode: 1, message: "Missing required proposed body (--body-file produced no content)." };
  }

  const validation = validateControlSnapshot(proposedBody);
  if (!validation.ok) {
    return {
      exitCode: 2,
      state: "REJECTED",
      controlIssue: Number(controlIssue),
      repo: repo ?? null,
      errors: validation.errors,
      message:
        `Refusing to persist ${repo ?? "<repo>"}#${controlIssue}: the proposed control snapshot failed field-local ` +
        `pointer validation before persistence:\n- ${validation.errors.join("\n- ")}`,
    };
  }

  try {
    ghEditImpl({ repo, controlIssue, body: proposedBody });
  } catch (err) {
    return { exitCode: 1, message: `gh issue edit failed for ${repo}#${controlIssue}: ${err.message}` };
  }

  return { exitCode: 0, state: "WRITTEN", controlIssue: Number(controlIssue), repo: repo ?? null };
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

function readBodyFile(path) {
  if (path === "-") {
    return readFileSync(0, "utf8");
  }
  return readFileSync(path, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const controlIssue = args["control-issue"];
  if (!controlIssue) {
    console.error("Missing required arg: --control-issue is required.");
    process.exit(1);
    return;
  }
  if (!args["body-file"]) {
    console.error("Missing required arg: --body-file is required (pass \"-\" to read the proposed body from stdin).");
    process.exit(1);
    return;
  }

  let resolvedRepo = args.repo;
  if (!resolvedRepo) {
    const identity = resolveRepoIdentity();
    if (!identity.ok) {
      console.error(`Could not determine the current repository identity (--repo was not supplied): ${identity.reason}`);
      process.exit(1);
      return;
    }
    resolvedRepo = identity.repo;
  }

  let proposedBody;
  try {
    proposedBody = readBodyFile(args["body-file"]);
  } catch (err) {
    console.error(`Could not read --body-file "${args["body-file"]}": ${err.message}`);
    process.exit(1);
    return;
  }

  const result = checkWriteControlSnapshot({ repo: resolvedRepo, controlIssue, proposedBody });
  if (result.exitCode === 1) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  if (result.exitCode === 2) {
    console.error(result.message);
    process.exit(2);
    return;
  }
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("write-control-snapshot.mjs")) {
  main();
}
