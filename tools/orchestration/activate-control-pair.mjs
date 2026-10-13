#!/usr/bin/env node
// Deterministic, idempotent control/execution pair activation (approval consumption) — issue #1151.
//
// Live reproducers: #1149 stayed `NEEDS_FOUNDER` / "Founder decision: pending ..." after the
// founder's exact grant was already recorded as ACTIVE on its thick packet #1150, so a fresh
// `work on #1149` re-asked a proven approval; and #1151 was created OPEN under governing control
// #438 while #438 was CLOSED/DONE with historical `Execution: #804`. Both are the same missing
// transaction: nothing consumed the approval by projecting the control to an executable state.
//
// This helper is that transaction, as ONE bounded unit, reusing (never reimplementing) the
// canonical pieces:
//   1. read the live control and the thick execution Issue (REST, github-read.mjs);
//   2. if the control still advertises a pending Founder decision / Blocker, require a mechanical
//      witness that the grant is settled: the thick Issue's own body must carry a section whose
//      heading names an ACTIVE grant (not INACTIVE/REVOKED/SUPERSEDED/WITHDRAWN) with a fenced
//      JSON authority record that executor-substrate-authority.mjs `parseAuthority` accepts with
//      no problems and at least one grant. Comments, prose, link plausibility and timing are never
//      consulted. No witness => BLOCKED, control untouched, no speculative repair;
//   3. compose the activated snapshot with `upsertControlBullet` (Lifecycle READY, sole Execution
//      pointer, Route, Founder decision none, Blocker none);
//   4. persist ONLY through `checkWriteControlSnapshot`'s `activation` mode (field validation,
//      stale-base refusal, open-pair validation, independent readback);
//   5. run the fresh session-entry gate and only report ACTIVATED when it returns
//      READY_TO_DISPATCH.
// Retrying the same call on an already-activated control skips the write (ALREADY_ACTIVE) and just
// re-runs the gate: it never rewrites the body twice and never dispatches work itself.
//
// A caller that cannot run the canonical writer (remote/Chat-style author) passes --handoff-only to
// get a deterministic HANDOFF record naming the exact command a qualified executor runs; no founder
// question is produced for an already-proven grant.
//
// A CLOSED control is never activated here: reopen the existing control first (founder direction
// permitting), then rerun. An open thick packet under a closed/DONE control is non-executable.
//
// Usage:
//   node tools/orchestration/activate-control-pair.mjs --control-issue 1149 --execution-issue 1150 [--route "implementation worker"] [--handoff-only]
//
// Exit codes: 0 ACTIVATED / ALREADY_ACTIVE / HANDOFF; 1 operational failure (read/write/readback/gate not READY);
// 2 REJECTED / BLOCKED / STALE_CONTROL (durable control left unchanged).
//
// Tests: node --test tools/orchestration/activate-control-pair.test.mjs

import { execFileSync } from "node:child_process";
import { readGithubIssue } from "./github-read.mjs";
import { upsertControlBullet, resolveRepoIdentity, parseControlBullet, parseHeadingField, isNoneSentinel } from "./ready-dispatch-gate.mjs";
import { parseAuthority } from "./executor-substrate-authority.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";

const DEFAULT_ROUTE = "implementation worker";
const NOT_ACTIVE_WORDS = /\b(INACTIVE|REVOKED|SUPERSEDED|WITHDRAWN)\b/i;

// Pure. Finds a mechanically valid ACTIVE grant section in the thick Issue body.
// Returns { ok: true, components } or { ok: false, reason }.
export function findActiveGrantWitness(executionBody) {
  const lines = String(executionBody ?? "").split(/\r?\n/);
  const headingIdx = lines.map((l, i) => (/^#{1,6}\s+/.test(l) ? i : -1)).filter((i) => i >= 0);
  const problems = [];
  for (const start of headingIdx) {
    const heading = lines[start];
    if (!/\bACTIVE\b/.test(heading) || NOT_ACTIVE_WORDS.test(heading)) continue;
    const next = headingIdx.find((i) => i > start) ?? lines.length;
    const section = lines.slice(start + 1, next).join("\n");
    const fence = section.match(/```json\s*\n([\s\S]*?)\n```/);
    if (!fence) {
      problems.push(`ACTIVE grant heading ${JSON.stringify(heading.trim())} has no fenced JSON authority record`);
      continue;
    }
    let record;
    try {
      record = JSON.parse(fence[1]);
    } catch (err) {
      problems.push(`ACTIVE grant JSON is not parseable: ${err.message}`);
      continue;
    }
    const { grants, problems: authorityProblems } = parseAuthority(record);
    if (authorityProblems.length > 0 || grants.size === 0) {
      problems.push(`ACTIVE grant record invalid: ${authorityProblems.join("; ") || "no grants"}`);
      continue;
    }
    return { ok: true, components: [...grants.keys()] };
  }
  return { ok: false, reason: problems[0] ?? "execution Issue body carries no ACTIVE grant section" };
}

// Pure. True when the control still advertises an unresolved Founder decision or Blocker.
export function controlAdvertisesPendingState(body) {
  const founder = parseControlBullet(body, "Founder decision") ?? parseHeadingField(body, "Founder interrupt");
  const blocker = parseControlBullet(body, "Blocker") ?? parseHeadingField(body, "Current blocker");
  return (founder !== null && !isNoneSentinel(founder)) || (blocker !== null && !isNoneSentinel(blocker));
}

// Pure. Composes the activated control snapshot from the live body.
export function buildActivatedControlBody(body, { executionIssue, route = DEFAULT_ROUTE }) {
  let next = body ?? "";
  next = upsertControlBullet(next, "Lifecycle", "READY");
  next = upsertControlBullet(next, "Execution", `#${executionIssue}`);
  next = upsertControlBullet(next, "Route", route);
  next = upsertControlBullet(next, "Founder decision", "none");
  next = upsertControlBullet(next, "Blocker", "none");
  return next;
}

function defaultRunGate({ controlIssue }) {
  const out = execFileSync(
    process.execPath,
    ["tools/orchestration/control-plane-bootstrap.mjs", "session-entry-gate", "--control-issue", String(controlIssue)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out);
}

function handoffCommand({ controlIssue, executionIssue, route }) {
  return `node tools/orchestration/activate-control-pair.mjs --control-issue ${controlIssue} --execution-issue ${executionIssue} --route "${route}"`;
}

const norm = (s) => String(s ?? "").replace(/\r\n/g, "\n").trimEnd();

// All I/O injected. Returns a result object with exitCode.
export function activateControlPair(
  { repo, controlIssue, executionIssue, route = DEFAULT_ROUTE, handoffOnly = false },
  { readIssueImpl = readGithubIssue, writeImpl = checkWriteControlSnapshot, ghEditImpl, runGateImpl = defaultRunGate } = {},
) {
  if (!repo || !controlIssue || !executionIssue) {
    return { exitCode: 1, message: "Missing required args: --control-issue and --execution-issue are required (and a resolvable repository)." };
  }
  const c = Number(controlIssue);
  const e = Number(executionIssue);
  if (c === e) return { exitCode: 2, state: "REJECTED", errors: ["control and execution Issue must differ"], message: "control and execution Issue must differ" };

  if (handoffOnly) {
    return {
      exitCode: 0,
      state: "HANDOFF",
      controlIssue: c,
      executionIssue: e,
      founderPromptRequired: false,
      command: handoffCommand({ controlIssue: c, executionIssue: e, route }),
      message:
        "This actor cannot run the canonical control writer. A qualified repository executor runs the command above; " +
        "the proven grant must not be re-requested from the founder.",
    };
  }

  let control;
  let execution;
  try {
    control = readIssueImpl({ repo, number: c, fields: ["body", "state"] });
    execution = readIssueImpl({ repo, number: e, fields: ["body", "state"] });
  } catch (err) {
    return { exitCode: 1, message: `activation read failed: ${err.message}` };
  }

  if (control.state !== "OPEN") {
    return {
      exitCode: 2,
      state: "REJECTED",
      controlIssue: c,
      errors: [`control ${repo}#${c} is ${control.state}`],
      message: `Refusing to activate: control ${repo}#${c} is ${control.state}. Reopen the existing control first; an open thick packet under a closed control is not executable.`,
    };
  }
  if (execution.state !== "OPEN") {
    return {
      exitCode: 2,
      state: "REJECTED",
      controlIssue: c,
      errors: [`execution ${repo}#${e} is ${execution.state}`],
      message: `Refusing to activate: execution ${repo}#${e} is ${execution.state}, not an open packet.`,
    };
  }

  if (controlAdvertisesPendingState(control.body)) {
    const witness = findActiveGrantWitness(execution.body);
    if (!witness.ok) {
      return {
        exitCode: 2,
        state: "BLOCKED",
        controlIssue: c,
        executionIssue: e,
        errors: [witness.reason],
        message: `Not activating ${repo}#${c}: it records a pending decision/blocker and ${repo}#${e} carries no mechanically valid ACTIVE grant (${witness.reason}). Control left unchanged.`,
      };
    }
  }

  const proposed = buildActivatedControlBody(control.body, { executionIssue: e, route });
  const alreadyActive = norm(proposed) === norm(control.body);

  if (!alreadyActive) {
    const written = writeImpl(
      { repo, controlIssue: c, proposedBody: proposed, activation: { executionIssue: e, baseBody: control.body } },
      { readIssueImpl, ...(ghEditImpl ? { ghEditImpl } : {}) },
    );
    if (written.exitCode !== 0) return { ...written, controlIssue: c, executionIssue: e };
  }

  let verdict;
  try {
    verdict = runGateImpl({ controlIssue: c });
  } catch (err) {
    return { exitCode: 1, state: "GATE_FAILED", controlIssue: c, executionIssue: e, message: `control persisted but the fresh gate failed: ${err.message}; do not report ready` };
  }
  if (!verdict || verdict.state !== "READY_TO_DISPATCH" || Number(verdict.executionIssue) !== e) {
    return {
      exitCode: 1,
      state: "GATE_NOT_READY",
      controlIssue: c,
      executionIssue: e,
      gateState: verdict?.state ?? null,
      message: `control persisted but the fresh gate returned ${JSON.stringify(verdict?.state ?? null)} for #${verdict?.executionIssue ?? "?"}, not READY_TO_DISPATCH for #${e}; do not report ready`,
    };
  }
  return {
    exitCode: 0,
    state: alreadyActive ? "ALREADY_ACTIVE" : "ACTIVATED",
    controlIssue: c,
    executionIssue: e,
    route: verdict.route ?? route,
    gateState: verdict.state,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "handoff-only") args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let repo = args.repo;
  if (!repo) {
    const identity = resolveRepoIdentity();
    if (!identity.ok) {
      console.error(`Could not determine the current repository identity (--repo was not supplied): ${identity.reason}`);
      process.exit(1);
      return;
    }
    repo = identity.repo;
  }
  const result = activateControlPair({
    repo,
    controlIssue: args["control-issue"],
    executionIssue: args["execution-issue"],
    route: args.route ?? DEFAULT_ROUTE,
    handoffOnly: Boolean(args["handoff-only"]),
  });
  if (result.exitCode === 0) {
    console.log(JSON.stringify(result));
    process.exit(0);
    return;
  }
  console.error(result.message ?? JSON.stringify(result));
  process.exit(result.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("activate-control-pair.mjs")) {
  main();
}
