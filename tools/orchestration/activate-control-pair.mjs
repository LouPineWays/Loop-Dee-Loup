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
// get, after the same read-only control/execution/grant proof (no write), a deterministic HANDOFF record naming the exact command a qualified executor runs; no founder
// question is produced for an already-proven grant.
//
// A terminal control (CLOSED, or OPEN while its snapshot reads DONE) is activated only for a new
// post-completion packet with explicit founder-authorized new-packet authority in the thick Issue
// (issue #1165): the GitHub state and the coherent READY snapshot are persisted as ONE guarded
// mutation, independently read back, and gated; completed pointers are retired to "none" and kept as
// a history line. It is never reopened as a standalone state change.
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
import { upsertControlBullet, resolveRepoIdentity, parseControlBullet, parseHeadingField, isNoneSentinel, readExecutionBulletField, parseExecutionPointer } from "./ready-dispatch-gate.mjs";
import { parseAuthority, EXECUTOR_COMPONENTS } from "./executor-substrate-authority.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";

const DEFAULT_ROUTE = "implementation worker";
// Fail-closed grammar (#1225): a heading is an ACTIVE witness only when its text begins with the word
// ACTIVE (after heading hashes and markdown emphasis) AND carries no negation/non-current status word
// anywhere. Anything else is refused rather than enumerating only some negated forms.
const NOT_ACTIVE_WORDS = /\b(INACTIVE|NON[\s-]*ACTIVE|NOT|NO|NEVER|NONE|WITHOUT|REVOKED|REVOKE|RESCINDED|RESCIND|SUPERSEDED|WITHDRAWN|EXPIRED|CANCELL?ED|DENIED|REJECTED|PROPOSED|UNAPPROVED|PENDING|DRAFT|FORMER|FORMERLY|LAPSED|SUSPENDED|VOID|VOIDED|INVALID|DISABLED)\b|n['’]t\b/i;
export function isCanonicalActiveHeading(heading) {
  const text = String(heading ?? "").replace(/^#{1,6}\s+/, "").replace(/^[\s*_`~]+/, "");
  return /^ACTIVE\b/.test(text) && !NOT_ACTIVE_WORDS.test(text);
}

// Pure. Finds a mechanically valid ACTIVE grant section in the thick Issue body.
// Returns { ok: true, components } or { ok: false, reason }.
export function findActiveGrantWitness(executionBody) {
  const lines = String(executionBody ?? "").split(/\r?\n/);
  const headingIdx = lines.map((l, i) => (/^#{1,6}\s+/.test(l) ? i : -1)).filter((i) => i >= 0);
  const problems = [];
  for (const start of headingIdx) {
    const heading = lines[start];
    if (!isCanonicalActiveHeading(heading)) continue;
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
    return { ok: true, components: [...grants.keys()], sectionText: heading + "\n" + section };
  }
  return { ok: false, reason: problems[0] ?? "execution Issue body carries no ACTIVE grant section" };
}

// Pure. Every non-none pending value the control advertises, across BOTH representations (the
// bullet block and the template headings). Either representation being non-none is pending; a
// bullet saying `none` never masks a pending heading (or vice versa).
export function pendingValues(body) {
  const sources = [
    ["Founder decision", parseControlBullet(body, "Founder decision")],
    ["Founder interrupt", parseHeadingField(body, "Founder interrupt")],
    ["Blocker", parseControlBullet(body, "Blocker")],
    ["Current blocker", parseHeadingField(body, "Current blocker")],
  ];
  return sources.filter(([, v]) => v !== null && !isNoneSentinel(v)).map(([label, value]) => ({ label, value }));
}

// Pure. True when the control still advertises an unresolved Founder decision or Blocker.
export function controlAdvertisesPendingState(body) {
  return pendingValues(body).length > 0;
}

// Pure. The witnessed ACTIVE grant may clear a pending state only when that state is itself a
// canonical grant-specific pending state: it must be about an exact protected/executor-substrate
// component grant, and any registered component it names must be among the witnessed components.
// A product choice, credential, external prerequisite, or different component stays pending.
//
// Issue #1165 (the #1164 reproduction): the control's "### Current blocker" prose explained the
// same pending approval without ever using the word "grant". Two kinds of pending field are
// therefore distinguished:
//   - decision fields (`Founder decision`, `Founder interrupt`) carry the actual founder-owned
//     question and must each be grant-specific;
//   - blocker fields (`Blocker`, `Current blocker`) only explain the block; one is accepted when
//     it is authorization-shaped and names no Issue prerequisite (an Issue-ref blocker is a real
//     dependency owned by the blocker reconciler, never consumed here).
const DECISION_LABELS = new Set(["Founder decision", "Founder interrupt"]);
const AUTHORIZATION_SHAPED = /\b(grant\w*|authori[sz]\w*|approv\w*|accept\w*)\b/i;
export function pendingMatchesGrant(body, components) {
  const witnessed = new Set(components);
  const pending = pendingValues(body);
  const namesWitnessed = (v) => [...witnessed].some((c) => v.includes(c));
  // A blocker field must be provably about the witnessed grant: it names a witnessed component, is itself
  // grant-specific, or the control also carries a canonical grant-specific decision field (which the blocker then merely explains).
  // An authorization-shaped blocker on an unrelated subject (e.g. privacy approval) never qualifies.
  const isGrantSpecific = (v) => /\bgrant\b/i.test(v) && /\b(protected|executor[- ]substrate|component|exact)\b/i.test(v);
  const hasGrantDecision = pending.some(({ label, value }) => DECISION_LABELS.has(label) && isGrantSpecific(value));
  for (const { label, value } of pending) {
    if (DECISION_LABELS.has(label)) {
      if (!/\bgrant\b/i.test(value) || !/\b(protected|executor[- ]substrate|component|exact)\b/i.test(value)) {
        return { ok: false, reason: `${label} ${JSON.stringify(value)} is not a canonical grant-specific pending state` };
      }
    } else if (!AUTHORIZATION_SHAPED.test(value) || /(?:#|\/issues\/|\/pull\/)\d+/.test(value)) {
      return { ok: false, reason: `${label} ${JSON.stringify(value)} is not an authorization-shaped pending state free of an Issue prerequisite` };
    } else if (!namesWitnessed(value) && !hasGrantDecision && !isGrantSpecific(value)) {
      return { ok: false, reason: `${label} ${JSON.stringify(value)} is not proven to concern the witnessed granted component(s) ${[...witnessed].join(", ")}` };
    }
    for (const { component } of EXECUTOR_COMPONENTS) {
      if (value.includes(component) && !witnessed.has(component)) {
        return { ok: false, reason: `${label} names component "${component}" but the ACTIVE grant covers only ${[...witnessed].join(", ")}` };
      }
    }
  }
  return { ok: true };
}

// Pure. The thick packet's `### Parent loop` provenance must identify exactly this control.
export function parentLoopIdentifiesControl(executionBody, controlIssue) {
  const lines = String(executionBody ?? "").split(/\r?\n/);
  const idx = lines.findIndex((l) => /^###\s+Parent loop\s*$/i.test(l.trim()));
  if (idx === -1) return { ok: false, reason: "execution Issue has no `### Parent loop` section binding it to the control" };
  const end = lines.findIndex((l, i) => i > idx && /^#{1,6}\s+/.test(l));
  const section = lines.slice(idx + 1, end === -1 ? lines.length : end).join("\n");
  const refs = new Set([...section.matchAll(/(?:\/issues\/|#)(\d+)\b/g)].map((m) => Number(m[1])));
  if (refs.size !== 1 || !refs.has(Number(controlIssue))) {
    return { ok: false, reason: `execution Issue Parent loop references ${refs.size ? [...refs].map((n) => `#${n}`).join(", ") : "no Issue"}, not exactly control #${controlIssue}` };
  }
  return { ok: true };
}

// Pure. True when the control is a completed/terminal control: GitHub CLOSED, or a lifecycle that
// reads DONE (the externally or historically reopened OPEN/DONE shape, issue #1165). Activating
// such a control is a new post-completion packet, never merely a stale-approval consumption.
export function isTerminalControl(controlBody, controlState) {
  if (String(controlState ?? "").toUpperCase() === "CLOSED") return true;
  const lifecycle = parseControlBullet(controlBody, "Lifecycle") ?? parseHeadingField(controlBody, "State");
  return lifecycle !== null && /^done\b/i.test(lifecycle.trim());
}

// Pure. Explicit founder-authorization witness for a NEW post-completion packet on a terminal
// control (issue #1165). Never an OPEN child alone, a comment, or prose: the thick packet's own body
// must carry an ACTIVE section whose fenced JSON either (a) is a dedicated new-packet record
//   {"newPacketAuthority": {"controlIssue": <C>, "executionIssue": <E>}}
// naming exactly this pair, or (b) the execution Issue's own mechanically valid ACTIVE component-scoped
// grant (Audit #1167: the literal #1165 packet carries this shape, never a newPacketAuthority record).
// Either way the thick Issue's own body is the witness; Parent-loop binding to this exact control, the
// single-candidate rule and the no-competing-packet rule are verified separately and still apply, and an
// absent, revoked, inactive, malformed or other-parent grant never qualifies.
export function findNewPacketAuthority(executionBody, { controlIssue, executionIssue }) {
  const lines = String(executionBody ?? "").split(/\r?\n/);
  const headingIdx = lines.map((l, i) => (/^#{1,6}\s+/.test(l) ? i : -1)).filter((i) => i >= 0);
  for (const start of headingIdx) {
    const heading = lines[start];
    if (!isCanonicalActiveHeading(heading) || !/new[- ]packet|new[- ]work/i.test(heading)) continue;
    const next = headingIdx.find((i) => i > start) ?? lines.length;
    const fence = lines.slice(start + 1, next).join("\n").match(/```json\s*\n([\s\S]*?)\n```/);
    if (!fence) continue;
    let record;
    try {
      record = JSON.parse(fence[1]);
    } catch {
      continue;
    }
    const a = record?.newPacketAuthority;
    if (a && Number(a.controlIssue) === Number(controlIssue) && Number(a.executionIssue) === Number(executionIssue)) {
      return { ok: true, via: "newPacketAuthority" };
    }
  }
  const grant = findActiveGrantWitness(executionBody);
  if (grant.ok) {
    // Packet-specific: a component grant is only terminal authority when its own section is not bound to a
    // different packet (a leftover grant from a historical same-parent Issue names that Issue). Any Issue
    // reference other than this exact control/execution pair disqualifies it (Stage 1 finding on PR #1168).
    const allowed = new Set([Number(controlIssue), Number(executionIssue)]);
    const foreign = [...grant.sectionText.matchAll(/(?:\/issues\/|#)(\d+)\b/g)].map((m) => Number(m[1])).filter((n) => !allowed.has(n));
    if (foreign.length === 0) return { ok: true, via: "activeGrant", components: grant.components };
    return { ok: false, reason: `ACTIVE component grant references other Issue(s) ${[...new Set(foreign)].map((n) => "#" + n).join(", ")}, so it is not proven packet-specific to #${executionIssue} under #${controlIssue}` };
  }
  return { ok: false, reason: "terminal control has no explicit founder-authorized new-packet record in the execution Issue (an open child Issue, comment, or GitHub OPEN state alone is never sufficient authority)" };
}

// Pure. Full execution-packet proof used both before composing and at the write boundary:
// parent binding always; for a terminal control also the explicit new-packet authority; ACTIVE
// grant witness matching the pending state when the control is pending.
export function verifyExecutionPacket({ controlBody, executionBody, controlIssue, executionIssue = null, controlState = "OPEN" }) {
  const parent = parentLoopIdentifiesControl(executionBody, controlIssue);
  if (!parent.ok) return parent;
  if (isTerminalControl(controlBody, controlState)) {
    const authority = findNewPacketAuthority(executionBody, { controlIssue, executionIssue });
    if (!authority.ok) return authority;
  }
  if (controlAdvertisesPendingState(controlBody)) {
    const witness = findActiveGrantWitness(executionBody);
    if (!witness.ok) return witness;
    const match = pendingMatchesGrant(controlBody, witness.components);
    if (!match.ok) return match;
  }
  return { ok: true };
}

const HISTORY_FIELDS = ["Execution", "PR", "Stage 1", "Stage 2"];

// Pure. Composes the activated control snapshot from the live body. For a terminal control the
// historical current pointers (Execution, PR, Stage 1, Stage 2) are retired to "none" and
// preserved verbatim as one prose history line, so a prior closed cycle is never erased.
export function buildActivatedControlBody(body, { executionIssue, route = DEFAULT_ROUTE, retireHistory = false }) {
  let next = body ?? "";
  if (retireHistory) {
    const old = [];
    for (const label of HISTORY_FIELDS) {
      const value = label === "Execution" ? (readExecutionBulletField(next).value ?? null) : parseControlBullet(next, label);
      if (value !== null && value !== undefined && !isNoneSentinel(value) && !new RegExp("^#" + executionIssue + "\\b").test(value.trim())) {
        old.push(label + " " + value.trim().replace(/\s+/g, " "));
      }
    }
    for (const label of ["PR", "Stage 1", "Stage 2"]) {
      if (parseControlBullet(next, label) !== null) next = upsertControlBullet(next, label, "none");
    }
    if (old.length > 0) {
      const line = "Completed packet history (retired from current pointers when #" + executionIssue + " was activated): " + old.join("; ") + ".";
      if (!next.includes(line)) next = next.replace(/\n*$/, "\n\n") + line + "\n";
    }
  }
  next = upsertControlBullet(next, "Lifecycle", "READY");
  next = upsertControlBullet(next, "Execution", "#" + executionIssue);
  next = upsertControlBullet(next, "Route", route);
  next = upsertControlBullet(next, "Founder decision", "none");
  next = upsertControlBullet(next, "Blocker", "none");
  // The witnessed grant settles the decision in every representation, so the template headings
  // must not keep advertising the stale pending prose.
  next = setHeadingField(next, "Founder interrupt", "none");
  next = setHeadingField(next, "Current blocker", "none");
  return next;
}

// Pure. Rewrites the first non-empty line of an existing `### label` section (the line
// parseHeadingField reads) to the given value; other lines in the section are left untouched. No-op if absent.
function setHeadingField(body, label, value) {
  const lines = body.split("\n");
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === "### " + label) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return body;
  for (let i = idx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("### ")) break;
    if (t === "") continue;
    lines[i] = value;
    break;
  }
  return lines.join("\n");
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
//
// Issue #1165: this is also the one mandatory reopen-and-activate transaction. A terminal control
// (GitHub CLOSED, or OPEN while its snapshot still reads DONE) is activated for a new packet only
// when the thick packet carries explicit founder-authorized new-packet authority and no other
// nonterminal packet competes; the GitHub state and the coherent READY snapshot are persisted by the
// canonical writer as ONE guarded mutation, independently read back, and only a fresh gate returning
// READY_TO_DISPATCH for exactly this packet reports ACTIVATED. This module never reopens a control
// as a standalone GitHub state change: on any proof/writer failure the control is left as it was.
export function activateControlPair(
  { repo, controlIssue, executionIssue, route = DEFAULT_ROUTE, handoffOnly = false, skipGate = false },
  { readIssueImpl = readGithubIssue, writeImpl = checkWriteControlSnapshot, ghEditImpl, reopenImpl, runGateImpl = defaultRunGate } = {},
) {
  if (!repo || !controlIssue || !executionIssue) {
    return { exitCode: 1, message: "Missing required args: --control-issue and --execution-issue are required (and a resolvable repository)." };
  }
  const c = Number(controlIssue);
  const e = Number(executionIssue);
  if (c === e) return { exitCode: 2, state: "REJECTED", errors: ["control and execution Issue must differ"], message: "control and execution Issue must differ" };

  if (/plan/i.test(String(route))) {
    return {
      exitCode: 2,
      state: "REJECTED",
      errors: [`route ${JSON.stringify(route)} is a planning route; activation projects READY (direct execution) only`],
      message: `Refusing to activate with planning route ${JSON.stringify(route)}: READY projects the direct execution-worker transition and would bypass the planning-stage boundary.`,
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

  const controlState = String(control.state ?? "").toUpperCase();
  if (controlState !== "OPEN" && controlState !== "CLOSED") {
    return { exitCode: 2, state: "REJECTED", controlIssue: c, errors: [`control ${repo}#${c} is ${control.state}`], message: `Refusing to activate: control ${repo}#${c} is ${control.state}.` };
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

  const terminal = isTerminalControl(control.body, controlState);
  const proofArgs = (executionBody) => ({ controlBody: control.body, executionBody, controlIssue: c, executionIssue: e, controlState });
  const proof = verifyExecutionPacket(proofArgs(execution.body));
  if (!proof.ok) {
    return {
      exitCode: 2,
      state: "BLOCKED",
      controlIssue: c,
      executionIssue: e,
      errors: [proof.reason],
      message: `Not activating ${repo}#${c}: ${proof.reason}. Control left unchanged (no reopen, no write).`,
    };
  }

  // No competing nonterminal packet: a different Execution pointer must name a closed Issue.
  const field = readExecutionBulletField(control.body);
  if (field.conflict) {
    return { exitCode: 2, state: "BLOCKED", controlIssue: c, executionIssue: e, errors: ["control Execution pointer is ambiguous"], message: `Not activating ${repo}#${c}: control Execution pointer is ambiguous. Control left unchanged.` };
  }
  const pointer = field.value ? parseExecutionPointer(field.value) : { ok: false };
  if (pointer.ok && pointer.issue !== e) {
    let other;
    try {
      other = readIssueImpl({ repo, number: pointer.issue, fields: ["body", "state"] });
    } catch (err) {
      return { exitCode: 1, message: `activation read of the control's current packet #${pointer.issue} failed: ${err.message}` };
    }
    if (String(other.state ?? "").toUpperCase() !== "CLOSED") {
      return {
        exitCode: 2,
        state: "BLOCKED",
        controlIssue: c,
        executionIssue: e,
        errors: [`competing packet #${pointer.issue} is ${other.state}`],
        message: `Not activating ${repo}#${c}: its current Execution pointer #${pointer.issue} is ${other.state}, a competing nonterminal packet. Control left unchanged.`,
      };
    }
  }

  if (handoffOnly) {
    return {
      exitCode: 0,
      state: "HANDOFF",
      controlIssue: c,
      executionIssue: e,
      founderPromptRequired: false,
      reopens: controlState === "CLOSED",
      command: handoffCommand({ controlIssue: c, executionIssue: e, route }),
      message:
        "This actor cannot run the canonical control writer. A qualified repository executor runs the command above" +
        (controlState === "CLOSED" ? " (it reopens and activates the control as one guarded mutation; the control stays CLOSED until then)" : "") +
        "; the authorization was read-only verified just now and must not be re-requested from the founder.",
    };
  }

  const proposed = buildActivatedControlBody(control.body, { executionIssue: e, route, retireHistory: terminal });
  const alreadyActive = controlState === "OPEN" && norm(proposed) === norm(control.body);

  if (!alreadyActive) {
    const written = writeImpl(
      { repo, controlIssue: c, proposedBody: proposed, activation: {
          executionIssue: e,
          baseBody: control.body,
          baseState: controlState,
          reopen: controlState === "CLOSED",
          verifyExecution: (executionBody) => verifyExecutionPacket(proofArgs(executionBody)),
        },
      },
      { readIssueImpl, ...(ghEditImpl ? { ghEditImpl } : {}), ...(reopenImpl ? { ghReopenImpl: reopenImpl } : {}) },
    );
    if (written.exitCode !== 0) return { ...written, controlIssue: c, executionIssue: e };
  }

  if (skipGate) {
    // The caller (the ordinary session-entry gate) runs the fresh gate itself in-process and judges
    // it; the persisted pair has already been independently read back above.
    return { exitCode: 0, state: alreadyActive ? "ALREADY_ACTIVE" : "ACTIVATED_PENDING_GATE", controlIssue: c, executionIssue: e, route };
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

// Issue #1165: bounded ordinary-entry activation. The session-entry gate calls this once, before a
// BLOCKED or fallthrough NOT_READY verdict is final, to consume an already-settled authorization:
//   - stale grant: an OPEN, non-terminal control still advertising a pending state whose sole
//     Execution pointer names a thick packet with a verifiable ACTIVE grant (consumption);
//   - post-completion packet: an OPEN control whose snapshot still reads DONE, with exactly one OPEN
//     thick Issue whose Parent loop binds exactly this control AND which carries explicit
//     founder-authorized new-packet authority.
// Every proof lives in activateControlPair (no second policy here); anything unproven, ambiguous or
// absent returns a non-mutating NO_CANDIDATE/BLOCKED result. A CLOSED control is never activated at
// ordinary entry: reopening it is an explicit actor operation (activate-control-pair CLI).
export function resolveEntryActivation(
  { repo, controlIssue },
  { readIssueImpl = readGithubIssue, listOpenIssuesImpl = defaultListOpenIssues, activateImpl = activateControlPair, ...rest } = {},
) {
  const c = Number(controlIssue);
  let control;
  try {
    control = readIssueImpl({ repo, number: c, fields: ["body", "state"] });
  } catch (err) {
    return { exitCode: 1, state: "READ_FAILED", message: "entry activation read failed: " + err.message };
  }
  if (String(control.state ?? "").toUpperCase() !== "OPEN") return { exitCode: 0, state: "NO_CANDIDATE", reason: "control is not OPEN" };
  const terminal = isTerminalControl(control.body, control.state);
  if (!terminal && !controlAdvertisesPendingState(control.body)) return { exitCode: 0, state: "NO_CANDIDATE", reason: "control advertises no pending state and is not terminal" };

  let execution;
  let route = DEFAULT_ROUTE;
  if (terminal) {
    let issues;
    try {
      issues = listOpenIssuesImpl({ repo });
    } catch (err) {
      return { exitCode: 1, state: "READ_FAILED", message: "entry activation could not list open Issues: " + err.message };
    }
    const candidates = issues.filter(
      (i) => i.number !== c && parentLoopIdentifiesControl(i.body, c).ok && findNewPacketAuthority(i.body, { controlIssue: c, executionIssue: i.number }).ok,
    );
    if (candidates.length !== 1) {
      return { exitCode: 0, state: candidates.length === 0 ? "NO_CANDIDATE" : "AMBIGUOUS_CANDIDATES", reason: candidates.length + " authorized new packet(s) bind this terminal control", candidates: candidates.map((i) => i.number) };
    }
    execution = candidates[0].number;
  } else {
    const field = readExecutionBulletField(control.body);
    const pointer = !field.conflict && field.value ? parseExecutionPointer(field.value) : { ok: false };
    if (!pointer.ok) return { exitCode: 0, state: "NO_CANDIDATE", reason: "control has no single current Execution pointer" };
    execution = pointer.issue;
    const existing = parseControlBullet(control.body, "Route");
    if (existing && !isNoneSentinel(existing)) {
      // A planning route must not be silently converted to direct implementation.
      if (/plan/i.test(existing)) return { exitCode: 0, state: "NO_CANDIDATE", reason: "control records a planning route; not converted to implementation at ordinary entry" };
      route = existing.trim();
    }
  }
  return activateImpl({ repo, controlIssue: c, executionIssue: execution, route, skipGate: true }, { readIssueImpl, ...rest });
}

// Exhaustive REST scan of every open Issue (not PRs; paginated until a short page). Uniqueness is the
// safety condition for the reopen mutation, so no older competing packet may be invisible.
export function defaultListOpenIssues({ repo, execFileImpl = execFileSync }) {
  const out = [];
  for (let page = 1; ; page++) {
    const raw = execFileImpl("gh", ["api", "repos/" + repo + "/issues?state=open&sort=created&direction=desc&per_page=100&page=" + page], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error("open Issue listing is not a JSON array");
    for (const row of rows) if (!row.pull_request) out.push({ number: Number(row.number), body: String(row.body ?? "") });
    if (rows.length < 100) break;
  }
  return out;
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
  const identity = resolveRepoIdentity();
  if (!identity.ok) {
    console.error(`Could not determine the current repository identity: ${identity.reason}`);
    process.exit(1);
    return;
  }
  // The fresh gate and the qualified handoff both resolve repository identity from this checkout,
  // so an explicit --repo that differs would mutate one repository and verify another.
  if (args.repo && args.repo.toLowerCase() !== String(identity.repo).toLowerCase()) {
    console.error(`Refusing --repo ${args.repo}: it differs from this checkout's repository ${identity.repo}; run from the target repository's checkout.`);
    process.exit(2);
    return;
  }
  const repo = identity.repo;
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
