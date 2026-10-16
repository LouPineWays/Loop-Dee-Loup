#!/usr/bin/env node
// Guarded writer that promotes ONE founder-approved `### PROPOSED executor-substrate grant ...`
// section of a thick execution Issue body to ACTIVE — issue #1215 (control #1214).
//
// control-body-write-guard.mjs rejects every raw Issue-body write and write-control-snapshot.mjs is
// thin-control only, so an approved grant could be recorded ACTIVE only by hand-editing GitHub or
// bypassing the guard. This is the one verified tool for that single transition, so
// activate-control-pair.mjs's `findActiveGrantWitness` can accept the result.
//
// Contract: `--body-file` is the PROPOSED full thick body. It must equal the live body with exactly
// one line changed: the single PROPOSED grant heading, replaced by an ACTIVE heading. The fenced
// JSON (and every other byte) is therefore preserved by construction; any other difference means the
// base is stale or the proposal does more than promote, and nothing is written. It never creates a
// grant from nothing and is not a generic thick-body editor.
//
// Usage:
//   node tools/orchestration/write-thick-grant.mjs --control-issue C --execution-issue E --body-file F [--founder-approval-ref URL]
//
// Exit codes: 0 WRITTEN (verified) / ALREADY_ACTIVE; 1 operational failure (args, read, write, readback);
// 2 REFUSED (durable body left unchanged).
//
// Tests: node --test tools/orchestration/write-thick-grant.test.mjs

import { readFileSync } from "node:fs";
import { readGithubIssue } from "./github-read.mjs";
import { resolveRepoIdentity, readExecutionBulletField, parseExecutionPointer } from "./ready-dispatch-gate.mjs";
import { parseAuthority } from "./executor-substrate-authority.mjs";
import { findActiveGrantWitness } from "./activate-control-pair.mjs";
import { ghRestEditIssueBody, isKnownAttributionDecorationExact } from "../review-watch/lifecycle-gate.mjs";

const HEADING = /^#{1,6}\s+/;
const NOT_ACTIVE_WORDS = /\b(INACTIVE|REVOKED|SUPERSEDED|WITHDRAWN)\b/i;

const refuse = (state, message) => ({ exitCode: 2, state, message });
const fail = (message, state) => ({ exitCode: 1, ...(state ? { state } : {}), message });

export function defaultGhEditThickIssue({ repo, executionIssue, body }, runImpl) {
  ghRestEditIssueBody({ repo, auditIssue: executionIssue, body, allowKnownAttribution: true }, runImpl);
}

// Pure. Returns { ok, index, reason } for the single PROPOSED heading whose section carries a
// parseable, valid fenced authority record.
export function findSingleProposedGrant(body) {
  const lines = String(body ?? "").split("\n");
  const headings = lines.map((l, i) => (HEADING.test(l) ? i : -1)).filter((i) => i >= 0);
  const proposed = headings.filter((i) => /\bPROPOSED\b/.test(lines[i]));
  if (proposed.length === 0) return { ok: false, reason: "thick Issue body carries no PROPOSED grant section" };
  if (proposed.length > 1) return { ok: false, reason: `thick Issue body carries ${proposed.length} PROPOSED grant sections; exactly one is required`, multiple: true };
  const start = proposed[0];
  const next = headings.find((i) => i > start) ?? lines.length;
  const section = lines.slice(start + 1, next).join("\n");
  const fence = section.match(/```json\s*\r?\n([\s\S]*?)\r?\n```/);
  if (!fence) return { ok: false, reason: "PROPOSED grant section has no fenced JSON authority record" };
  let record;
  try {
    record = JSON.parse(fence[1]);
  } catch (err) {
    return { ok: false, reason: `PROPOSED grant JSON is not parseable: ${err.message}` };
  }
  const { grants, problems } = parseAuthority(record);
  if (problems.length > 0 || grants.size === 0) {
    return { ok: false, reason: `PROPOSED grant record invalid: ${problems.join("; ") || "no grants"}` };
  }
  return { ok: true, index: start };
}

export function checkWriteThickGrant(
  { repo, controlIssue, executionIssue, proposedBody, founderApprovalRef = null },
  { readIssueImpl = readGithubIssue, ghEditImpl = defaultGhEditThickIssue, runImpl } = {},
) {
  if (!controlIssue) return fail("Missing required arg: --control-issue is required.");
  if (!executionIssue) return fail("Missing required arg: --execution-issue is required.");
  if (typeof proposedBody !== "string") return fail("Missing required proposed body (--body-file produced no content).");
  if (founderApprovalRef !== null && !/^https?:\/\/\S+$/.test(founderApprovalRef)) {
    return refuse("BAD_APPROVAL_REF", `--founder-approval-ref must be an http(s) URL, got ${JSON.stringify(founderApprovalRef)}.`);
  }
  const c = Number(controlIssue);
  const e = Number(executionIssue);
  if (c === e) {
    return refuse("SELF_EXECUTION", `control and execution Issue are both #${c}; a control can never be its own execution Issue; nothing was written.`);
  }

  const readOne = (number) => {
    try {
      return { issue: readIssueImpl({ repo, number, fields: ["body", "state"] }) };
    } catch (err) {
      if (/pull request/i.test(err.message)) return { refusal: refuse("NOT_AN_ISSUE", `${repo}#${number} is a pull request, not an Issue; nothing was written.`) };
      return { failure: fail(`read of ${repo}#${number} failed: ${err.message}`) };
    }
  };

  const checkControlPointer = () => {
    const control = readOne(c);
    if (control.refusal || control.failure) return control.refusal ?? control.failure;
    const field = readExecutionBulletField(control.issue.body ?? "");
    const pointer = field.conflict || !field.value ? { ok: false } : parseExecutionPointer(field.value);
    if (!pointer.ok || pointer.issue !== e) {
      return refuse("NOT_SOLE_EXECUTION", `control ${repo}#${c} does not name #${e} as its sole Execution pointer; nothing was written.`);
    }
    return null;
  };
  const pointerRefusal = checkControlPointer();
  if (pointerRefusal) return pointerRefusal;

  const execution = readOne(e);
  if (execution.refusal || execution.failure) return execution.refusal ?? execution.failure;
  if (execution.issue.state !== "OPEN") {
    return refuse("NOT_OPEN", `execution ${repo}#${e} is ${execution.issue.state}, not OPEN; nothing was written.`);
  }
  const live = execution.issue.body ?? "";

  // Idempotent retry: already promoted (no PROPOSED section left, ACTIVE witness valid, same bytes).
  if (!/^#{1,6}\s+.*\bPROPOSED\b/m.test(live) && findActiveGrantWitness(live).ok && (live === proposedBody || isKnownAttributionDecorationExact(proposedBody, live))) {
    return { exitCode: 0, state: "ALREADY_ACTIVE", controlIssue: c, executionIssue: e, repo: repo ?? null };
  }

  const found = findSingleProposedGrant(live);
  if (!found.ok) return refuse(found.multiple ? "MULTIPLE_PROPOSED" : "NO_PROPOSED", `${found.reason}; nothing was written.`);

  const liveLines = live.split("\n");
  const propLines = proposedBody.split("\n");
  if (liveLines.length !== propLines.length) {
    return refuse("STALE_BASE", "proposed body is not the live body with only the grant heading changed (line count differs; stale base or extra edits); nothing was written.");
  }
  const diffs = liveLines.flatMap((l, i) => (l === propLines[i] ? [] : [i]));
  if (diffs.length !== 1 || diffs[0] !== found.index) {
    return refuse("STALE_BASE", "proposed body differs from the live body other than at the single PROPOSED grant heading (stale base or extra edits); nothing was written.");
  }
  const newHeading = propLines[found.index];
  if (!HEADING.test(newHeading) || !/\bACTIVE\b/.test(newHeading) || NOT_ACTIVE_WORDS.test(newHeading) || /\bPROPOSED\b/.test(newHeading)) {
    return refuse("BAD_HEADING", `replacement heading ${JSON.stringify(newHeading)} must be a heading naming ACTIVE (not PROPOSED/INACTIVE/REVOKED/SUPERSEDED/WITHDRAWN); nothing was written.`);
  }
  if (founderApprovalRef && !newHeading.includes(founderApprovalRef)) {
    return refuse("APPROVAL_REF_MISSING", "--founder-approval-ref was given but the replacement heading does not cite it; nothing was written.");
  }
  if (!findActiveGrantWitness(proposedBody).ok) {
    return refuse("NO_WITNESS", "the proposed body would not satisfy findActiveGrantWitness; nothing was written.");
  }

  // Tight stale window: re-read immediately before the write.
  const pointerAgain = checkControlPointer();
  if (pointerAgain) return pointerAgain;
  const again = readOne(e);
  if (again.refusal || again.failure) return again.refusal ?? again.failure;
  if (again.issue.state !== "OPEN" || (again.issue.body ?? "") !== live) {
    return refuse("STALE_BASE", "execution body changed during validation; nothing was written.");
  }

  try {
    ghEditImpl({ repo, executionIssue: e, body: proposedBody }, runImpl);
  } catch (err) {
    return fail(`thick grant REST write failed for ${repo}#${e}: ${err.message}`, "WRITE_FAILED");
  }

  let back;
  try {
    back = readIssueImpl({ repo, number: e, fields: ["body", "state"] });
  } catch (err) {
    return fail(`wrote ${repo}#${e} but the independent readback failed: ${err.message}`, "READBACK_FAILED");
  }
  const same = (back.body ?? "") === proposedBody || isKnownAttributionDecorationExact(proposedBody, back.body ?? "");
  if (!same || !findActiveGrantWitness(back.body ?? "").ok) {
    return fail(`wrote ${repo}#${e} but the persisted body did not read back as the promoted ACTIVE grant; do not report the grant active`, "READBACK_MISMATCH");
  }
  return { exitCode: 0, state: "WRITTEN", verified: true, controlIssue: c, executionIssue: e, repo: repo ?? null };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const k of ["control-issue", "execution-issue", "body-file"]) {
    if (!args[k]) {
      console.error(`Missing required arg: --${k} is required.`);
      process.exit(1);
      return;
    }
  }
  let repo = args.repo;
  if (!repo) {
    const identity = resolveRepoIdentity();
    if (!identity.ok) {
      console.error(`Could not determine the current repository identity: ${identity.reason}`);
      process.exit(1);
      return;
    }
    repo = identity.repo;
  }
  let proposedBody;
  try {
    proposedBody = readFileSync(args["body-file"] === "-" ? 0 : args["body-file"], "utf8");
  } catch (err) {
    console.error(`Could not read --body-file "${args["body-file"]}": ${err.message}`);
    process.exit(1);
    return;
  }
  const result = checkWriteThickGrant({
    repo,
    controlIssue: args["control-issue"],
    executionIssue: args["execution-issue"],
    proposedBody,
    founderApprovalRef: args["founder-approval-ref"] ?? null,
  });
  if (result.exitCode !== 0) {
    console.error(result.message);
    process.exit(result.exitCode);
    return;
  }
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("write-thick-grant.mjs")) main();
