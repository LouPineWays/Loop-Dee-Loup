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
// Activation mode (issue #1151) is programmatic only: `checkWriteControlSnapshot({ activation })`
// requires an injected `verifyExecution` proof callback, which only activate-control-pair.mjs
// supplies. The CLI deliberately exposes no activation flags (Audit #1153 finding 1); use
// `node tools/orchestration/activate-control-pair.mjs --control-issue <C> --execution-issue <E>`.
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
import { execFileSync } from "node:child_process";
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

// Issue #1165: ONE guarded REST mutation that sets the control's GitHub state and its body together
// (`PATCH /repos/{repo}/issues/{n}` with both `state` and `body`), so a completed control is never
// reopened as a standalone state change that leaves an inconsistent OPEN/DONE pair. The response must
// show the intended Issue (not a PR), in the requested state, with the written body echoed (or the one
// known trailing attribution decoration). A single PATCH is not compare-and-swap; the caller's
// pre-write re-read of live state+body is the stale-base proof.
export function defaultGhPatchControlIssue({ repo, controlIssue, body, state }, runImpl = execFileSync) {
  if (state !== "open" && state !== "closed") throw new Error(`refusing REST patch with unsupported state ${JSON.stringify(state)}`);
  const raw = runImpl("gh", ["api", "-X", "PATCH", `repos/${repo}/issues/${controlIssue}`, "--input", "-"], {
    encoding: "utf8",
    input: JSON.stringify({ state, body }),
    maxBuffer: 20 * 1024 * 1024,
  });
  let res;
  try {
    res = JSON.parse(raw);
  } catch {
    throw new Error("malformed (non-JSON) REST response from state+body patch");
  }
  if (!res || typeof res !== "object") throw new Error("malformed REST state+body patch response");
  if (res.pull_request) throw new Error("REST state+body patch response describes a pull request, not an Issue");
  if (Number(res.number) !== Number(controlIssue) || !String(res.html_url ?? "").toLowerCase().endsWith(`/${repo}/issues/${controlIssue}`.toLowerCase())) {
    throw new Error(`REST state+body patch response identity does not match ${repo}#${controlIssue}`);
  }
  if (String(res.state ?? "").toLowerCase() !== state) {
    throw new Error(`REST state+body patch response shows state ${JSON.stringify(res.state)}, expected ${state}`);
  }
  if (normalizeBody(res.body) !== normalizeBody(body) && !isKnownAttributionDecoration(body, res.body ?? "")) {
    throw new Error("REST state+body patch response body does not match the body written");
  }
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
  { ghEditImpl = defaultGhEditControlIssue, readIssueImpl = readGithubIssue, ghReopenImpl = defaultGhPatchControlIssue } = {},
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
    const liveState = String(live.state ?? "").toUpperCase();
    if (activation.baseState && liveState !== String(activation.baseState).toUpperCase()) {
      return {
        exitCode: 2,
        state: "STALE_CONTROL",
        controlIssue: Number(controlIssue),
        repo: repo ?? null,
        errors: [`control GitHub state changed from ${activation.baseState} to ${live.state} since the proposal was composed; nothing was written`],
        message: `Refusing to activate ${repo ?? "<repo>"}#${controlIssue}: its live GitHub state is no longer the base the proposal was composed from.`,
      };
    }
    if (activation.reopen && liveState !== "CLOSED") {
      return { exitCode: 2, state: "STALE_CONTROL", controlIssue: Number(controlIssue), repo: repo ?? null, errors: ["reopen requested but the control is not CLOSED; nothing was written"], message: "Refusing the reopen-and-activate write: the control is not CLOSED." };
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
      // The post-write state: a reopen transaction persists OPEN together with the body.
      controlState: activation.reopen ? "OPEN" : live.state,
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

  const reopening = Boolean(activation?.reopen);
  try {
    if (reopening) ghReopenImpl({ repo, controlIssue, body: proposedBody, state: "open" });
    else ghEditImpl({ repo, controlIssue, body: proposedBody });
  } catch (err) {
    // A failed single-request reopen leaves the control exactly as it was (still CLOSED): the state
    // and body travel in one PATCH, so there is no half-reopened intermediate to recover from.
    return { exitCode: 1, ...(reopening ? { state: "REOPEN_WRITE_FAILED" } : {}), message: `control snapshot REST write failed for ${repo}#${controlIssue}: ${err.message}${reopening ? "; the control was not reopened" : ""}` };
  }

  // A reopen that cannot be proven coherent is restored to the closed base (best effort) so an
  // inconsistent OPEN pair is never left behind for an ordinary session to trip over.
  // Rollback only when a fresh read proves the live control still holds exactly this operation's
  // proposed snapshot: a concurrent actor's update (or an unreadable state) is never overwritten.
  const rollbackReopen = () => {
    if (!reopening) return null;
    try {
      const current = readIssueImpl({ repo, number: Number(controlIssue), fields: ["body", "state"] });
      if (normalizeBody(current.body) !== normalizeBody(proposedBody)) return false;
      ghReopenImpl({ repo, controlIssue, body: activation.baseBody, state: "closed" });
      return true;
    } catch {
      return false;
    }
  };
  const rollbackNote = (rolledBack) => (rolledBack === null ? "" : rolledBack ? "; the control was restored to its closed base" : "; ROLLBACK NOT PERFORMED (failed, or the live control no longer holds this operation's snapshot) - the control may be left OPEN and must be repaired");

  if (activation) {
    let back;
    let executionBack;
    try {
      back = readIssueImpl({ repo, number: Number(controlIssue), fields: ["body", "state"] });
      executionBack = readIssueImpl({ repo, number: Number(activation.executionIssue), fields: ["body", "state"] });
    } catch (err) {
      const rolledBack = rollbackReopen();
      return { exitCode: 1, state: "READBACK_FAILED", rolledBack, message: `wrote ${repo}#${controlIssue} but the independent readback failed: ${err.message}${rollbackNote(rolledBack)}` };
    }
    const sameBody = normalizeBody(back.body) === normalizeBody(proposedBody) || isKnownAttributionDecoration(proposedBody, back.body ?? "");
    const pairBack = validateActivationPair(back.body ?? "", {
      controlIssue: Number(controlIssue),
      executionIssue: Number(activation.executionIssue),
      controlState: back.state,
      executionState: String(executionBack?.state ?? "").toUpperCase(),
    });
    if (!sameBody || !pairBack.ok) {
      const rolledBack = rollbackReopen();
      return {
        exitCode: 1,
        state: "READBACK_MISMATCH",
        rolledBack,
        message: `wrote ${repo}#${controlIssue} but the persisted body did not read back as the proposed activated pair${pairBack.ok ? "" : `: ${pairBack.errors.join("; ")}`}; do not report ready${rollbackNote(rolledBack)}`,
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
  if (Object.hasOwn(args, "activate-execution") || Object.hasOwn(args, "base-body-file")) {
    console.error(
      "--activate-execution/--base-body-file are not supported on this CLI (activation needs the execution-packet proof). " +
        "Use: node tools/orchestration/activate-control-pair.mjs --control-issue <C> --execution-issue <E>",
    );
    process.exit(1);
    return;
  }
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
