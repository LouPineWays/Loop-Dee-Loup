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
// Activation mode (issue #1151): add `--activate-execution <N> --base-body-file <path>` to also
// require a stale-proof write, an executable control/thick pair, and an independent readback.
//
// Exit codes:
//   0 — WRITTEN. The proposed body passed validateControlSnapshot and was persisted verbatim
//       via REST `PATCH /repos/{repo}/issues/{n}` (issue #818; response identity/body verified).
//   1 — operational error (missing required arg, unresolved repository identity, or the `gh`
//       write itself failed/threw). The durable Issue body is left exactly as it was: this
//       script never mutates the issue until after validation has already passed.
//   2 — REJECTED. The proposed body failed validateControlSnapshot; the reasons are printed
//       and the durable Issue body is left byte-for-byte unchanged — the write is never
//       attempted (Verification case 7's write-before-validate ordering).
//
// Tests: node --test tools/orchestration/write-control-snapshot.test.mjs

import { readFileSync } from "node:fs";
import { validateControlSnapshot, validateActivationPair } from "./control-field-validator.mjs";
import { readGithubIssue } from "./github-read.mjs";
import { resolveRepoIdentity } from "./ready-dispatch-gate.mjs";
import { ghRestEditIssueBody, isKnownAttributionDecoration } from "../review-watch/lifecycle-gate.mjs";

// Issue #818: persistence goes through REST (`PATCH /repos/{repo}/issues/{n}` via `gh api --input -`,
// the #808 helper), not `gh issue edit`, which uses GitHub GraphQL — HTTP 403 in the remote/cloud
// profile of the #379 reproduction while repository REST works. The helper pipes a JSON body over
// stdin (no argv/shell escaping) and verifies response Issue identity, not-a-PR, and body echo, so
// a wrong-target/partial/malformed response throws and surfaces here as an operational failure.
// Issue #835: tolerate only the one known trailing attribution block; any other mismatch still throws.
export function defaultGhEditControlIssue({ repo, controlIssue, body }, runImpl) {
  ghRestEditIssueBody({ repo, auditIssue: controlIssue, body, allowKnownAttribution: true }, runImpl);
}

// Pure core (`ghEditImpl` injected so tests never touch the network or the real `gh` CLI):
// validates `proposedBody` before ever calling `ghEditImpl`, so an invalid proposal cannot
// reach the mutation step at all — the ordering Verification case 7 requires, not merely a
// convention this function happens to follow.
//
// Issue #1151: an optional `activation` ({ executionIssue, baseBody }) turns this into the
// approval-consumption / pair-activation write. Beyond the field-local validation it (1) re-reads
// the control and refuses with STALE_CONTROL, writing nothing, when its live body is no longer the
// `baseBody` the proposal was composed from (concurrent change / re-close), (2) requires the
// proposed body to form an executable pair with the OPEN thick `executionIssue`
// (validateActivationPair), and (3) after the write, independently reads the control back and
// re-validates the persisted body, so success is never reported on an unproven or partial write.
// Without `activation` behavior is byte-for-byte unchanged.
export function checkWriteControlSnapshot(
  { repo, controlIssue, proposedBody, activation = null },
  { ghEditImpl = defaultGhEditControlIssue, readIssueImpl = readGithubIssue } = {},
) {
  if (!controlIssue) {
    return { exitCode: 1, message: "Missing required arg: --control-issue is required." };
  }
  if (typeof proposedBody !== "string") {
    return { exitCode: 1, message: "Missing required proposed body (--body-file produced no content)." };
  }

  const validation = validateControlSnapshot(proposedBody, { controlIssue: Number(controlIssue) });
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

  if (activation) {
    let live;
    let execution;
    try {
      live = readIssueImpl({ repo, number: Number(controlIssue), fields: ["body", "state"] });
      execution = readIssueImpl({ repo, number: Number(activation.executionIssue), fields: ["body", "state"] });
    } catch (err) {
      return { exitCode: 1, message: `activation pre-write read failed for ${repo}#${controlIssue}: ${err.message}` };
    }
    if (typeof activation.baseBody !== "string" || normalizeBody(live.body) !== normalizeBody(activation.baseBody)) {
      return {
        exitCode: 2,
        state: "STALE_CONTROL",
        controlIssue: Number(controlIssue),
        repo: repo ?? null,
        errors: ["control body changed (or no base body was supplied) since the proposal was composed; nothing was written"],
        message: `Refusing to overwrite ${repo ?? "<repo>"}#${controlIssue}: its live body is not the base the proposed snapshot was composed from. Re-read and recompose.`,
      };
    }
    // Revalidate the execution packet (parent binding + ACTIVE grant) against the body just read,
    // so a grant revoked after the caller's initial check cannot be consumed.
    if (typeof activation.verifyExecution !== "function") {
      return { exitCode: 1, message: "activation requires a verifyExecution proof callback; refusing to write without revalidating the execution packet." };
    }
    const packet = activation.verifyExecution(execution.body ?? "");
    if (!packet || !packet.ok) {
      return {
        exitCode: 2,
        state: "BLOCKED",
        controlIssue: Number(controlIssue),
        repo: repo ?? null,
        errors: [packet?.reason ?? "execution packet proof failed"],
        message: `Refusing to activate ${repo ?? "<repo>"}#${controlIssue}: execution packet no longer proves the activation (${packet?.reason ?? "unproven"}); nothing was written.`,
      };
    }
    const pair = validateActivationPair(proposedBody, {
      controlIssue: Number(controlIssue),
      executionIssue: Number(activation.executionIssue),
      controlState: live.state,
      executionState: execution.state,
    });
    if (!pair.ok) {
      return {
        exitCode: 2,
        state: "REJECTED",
        controlIssue: Number(controlIssue),
        repo: repo ?? null,
        errors: pair.errors,
        message: `Refusing to activate ${repo ?? "<repo>"}#${controlIssue}: the proposed pair is not executable:\n- ${pair.errors.join("\n- ")}`,
      };
    }
  }

  try {
    ghEditImpl({ repo, controlIssue, body: proposedBody });
  } catch (err) {
    return { exitCode: 1, message: `control snapshot REST write failed for ${repo}#${controlIssue}: ${err.message}` };
  }

  if (activation) {
    let back;
    try {
      back = readIssueImpl({ repo, number: Number(controlIssue), fields: ["body", "state"] });
    } catch (err) {
      return { exitCode: 1, state: "READBACK_FAILED", message: `wrote ${repo}#${controlIssue} but the independent readback failed: ${err.message}` };
    }
    const sameBody = normalizeBody(back.body) === normalizeBody(proposedBody) || isKnownAttributionDecoration(proposedBody, back.body ?? "");
    const pairBack = validateActivationPair(back.body ?? "", {
      controlIssue: Number(controlIssue),
      executionIssue: Number(activation.executionIssue),
      controlState: back.state,
      executionState: "OPEN",
    });
    if (!sameBody || !pairBack.ok) {
      return {
        exitCode: 1,
        state: "READBACK_MISMATCH",
        message: `wrote ${repo}#${controlIssue} but the persisted body did not read back as the proposed activated pair${pairBack.ok ? "" : `: ${pairBack.errors.join("; ")}`}; do not report ready`,
      };
    }
    return { exitCode: 0, state: "WRITTEN", verified: true, controlIssue: Number(controlIssue), repo: repo ?? null };
  }

  return { exitCode: 0, state: "WRITTEN", controlIssue: Number(controlIssue), repo: repo ?? null };
}

// Pure. EOL- and trailing-whitespace-normalized body for stale/readback comparison only.
function normalizeBody(body) {
  return String(body ?? "").replace(/\r\n/g, "\n").trimEnd();
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

  let activation = null;
  if (args["activate-execution"]) {
    if (!args["base-body-file"]) {
      console.error("--activate-execution requires --base-body-file (the live body the proposal was composed from) so a stale write can be refused.");
      process.exit(1);
      return;
    }
    let baseBody;
    try {
      baseBody = readFileSync(args["base-body-file"], "utf8");
    } catch (err) {
      console.error(`Could not read --base-body-file "${args["base-body-file"]}": ${err.message}`);
      process.exit(1);
      return;
    }
    activation = { executionIssue: Number(args["activate-execution"]), baseBody };
  }

  const result = checkWriteControlSnapshot({ repo: resolvedRepo, controlIssue, proposedBody, activation });
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
