#!/usr/bin/env node
// Canonical NO-GO retirement of a consumed one-shot Claude qualification — issue #1198 (control #1197).
//
// The #1164/#1180 incident: a one-shot `claudeQualification` proof ran once (Actions run 38682968969),
// recorded an honest NO-GO on both Issue threads and settled its `Launch Attempt (v1)` claim, yet the
// thin control #1164 stayed OPEN with `Lifecycle: READY` / `Execution: #1180` and a fresh gate still
// returned READY_TO_DISPATCH. No existing primitive could retire it truthfully: `close-control.mjs` is
// only for a backed CLEAN Stage 2, `activate-control-pair.mjs` only activates, and a generic Issue-body
// edit is (correctly) refused by the control-write perimeter. This module is that missing terminal
// transition. It is NOT a general terminal-state framework and never claims a worker PASS, a backed
// CLEAN Stage 2, or Campaign completion.
//
// Safety model
//   - Explicit identity: `--control-issue` and `--execution-issue` are both required; nothing is searched
//     for or inferred. The control's single Execution pointer must name exactly that packet.
//   - Evidence, not prose: the packet must carry exactly one exact one-shot `claudeQualification` grant
//     for the pair (same detection the dispatch gate uses — `ready-dispatch-gate.mjs`
//     `classifyQualificationPacket`), authored by a writer; the control thread must carry exactly one
//     trusted (github-actions[bot]) settled `Launch Attempt (v1)` claim with nonce `qualification-<packet>`
//     and Outcome NO_GO; each thread must carry exactly one trusted `Claude Qualification Result (v1)`
//     naming the pair with Verdict NO-GO, identical to the other, for that same attempt id; the Actions
//     run attempt must read back as completed. A PASS, a missing/duplicate/mismatched/untrusted record, a
//     conflicting result on the packet thread, or an unreadable fact fails closed with NO mutation.
//   - Truthful, replayable sequence (GitHub REST offers no multi-Issue transaction, so none is claimed):
//       1. write the terminal control snapshot through the validated writer `write-control-snapshot.mjs`
//          (`Lifecycle: DONE`, `Route: none`, an explicit NO-GO `Terminal result`) — from this point the
//          control is non-dispatchable even while OPEN;
//       2. post the packet retirement record, 3. close the packet, 4. close the control, 5. post the
//          control record (best effort), 6. confirm a fresh ready-dispatch gate no longer authorizes
//          dispatch of the packet.
//     Every mutation is followed by an independent readback. A failure after step 1 reports a precise
//     PARTIAL diagnosis (completed / failed / remaining) and exits 1; re-running the same command
//     resumes from live state and is idempotent. A fully retired pair re-runs as ALREADY_TERMINAL with
//     no write.
//   - Historical provenance is preserved: only the control's current-state fields change; the previous
//     `Terminal result` value, `Execution` pointer, completed-packet history, and every comment stay.
//
// Usage:
//   node tools/orchestration/retire-consumed-qualification.mjs --control-issue 1164 --execution-issue 1180 [--dry-run]
// `--repo` is optional and derived from the checkout's origin remote when omitted.
//
// Exit codes: 0 RETIRED | ALREADY_TERMINAL | DRY_RUN_VERIFIED; 1 operational error or PARTIAL (resume by
// re-running); 2 REJECTED / STALE (nothing was written).
//
// Tests: node --test tools/orchestration/retire-consumed-qualification.test.mjs

import { execFileSync } from "node:child_process";
import {
  upsertControlBullet,
  parseControlBullet,
  parseHeadingBlock,
  parseExecutionPointer,
  readExecutionBulletField,
  describeExecutionConflict,
  isNoneSentinel,
  evaluateReadyDispatchGate,
  resolveRepoIdentity,
  classifyQualificationPacket,
  collectQualificationEvidence,
  defaultListIssueComments,
  checkReadyDispatch,
  QUALIFICATION_NONCE_PREFIX,
  QUALIFICATION_HOST,
} from "./ready-dispatch-gate.mjs";
import { readGithubIssue } from "./github-read.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";
import { parseBoldBullets, hasWritePermission } from "./launch-authorization.mjs";
import { SETTLED_PHASES, parseAttemptId } from "./attempt-claim.mjs";
import { ghRestCloseIssue, ghRestCommentIssue, isKnownAttributionDecoration } from "../review-watch/lifecycle-gate.mjs";

export const RETIREMENT_RECORD_HEADING = "## Consumed Qualification Retired (v1)";
const TERMINAL_MARKER = /retire-consumed-qualification\.mjs: packet #(\d+), attempt (\d+-\d+) \(nonce /;

// ---- default (real) transports; every one is injectable so tests never touch the network -------

function ghJson(args, runImpl = execFileSync) {
  const raw = runImpl("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw);
}

function defaultReadIssue({ repo, number }) {
  return readGithubIssue({ repo, number, fields: ["body", "state"] });
}

function defaultReadPacketMeta({ repo, number }) {
  const res = ghJson([`repos/${repo}/issues/${number}`]);
  return { author: res?.user?.login ?? null, association: res?.author_association ?? null, isPullRequest: Boolean(res?.pull_request) };
}

function defaultPermissionFor({ repo, login }) {
  try {
    return ghJson([`repos/${repo}/collaborators/${login}/permission`])?.permission ?? "none";
  } catch {
    return "none";
  }
}

function defaultReadRun({ repo, runId, runAttempt }) {
  const res = ghJson([`repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}`]);
  return { status: res?.status ?? null, conclusion: res?.conclusion ?? null };
}

function defaultComment({ repo, issue, body }) {
  ghRestCommentIssue({ repo, auditIssue: issue, body });
}

function defaultClose({ repo, issue }) {
  ghRestCloseIssue({ repo, issue });
}

// ---- pure helpers -----------------------------------------------------------------------------

function normalize(body) {
  return String(body ?? "").replace(/\r\n/g, "\n").trimEnd();
}

function firstLine(body) {
  return String(body ?? "").split(/\r?\n/).find((l) => l.trim() !== "")?.trim();
}

// Pure. The control's single current Execution pointer: { kind: "issue", issue } | { kind: "bad", reason }.
function readExecutionPointer(body) {
  const field = readExecutionBulletField(body);
  if (field.conflict) return { kind: "bad", reason: describeExecutionConflict(field) };
  if (field.value === null || field.value === undefined) return { kind: "bad", reason: 'control body has no "- **Execution:**" pointer' };
  const parsed = parseExecutionPointer(field.value);
  if (!parsed.ok) return { kind: "bad", reason: `Execution ${JSON.stringify(field.value)}: ${parsed.reason}` };
  return { kind: "issue", issue: parsed.issue };
}

// Pure. Issue numbers referenced inside the packet's "### Parent loop" section.
export function parentLoopReferences(packetBody) {
  const block = parseHeadingBlock(packetBody ?? "", "Parent loop");
  if (!block) return [];
  return [...new Set([...block.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
}

// Pure. Does the control body carry this tool's terminal marker? -> { packet, attemptId } | null
export function readRetirementMarker(body) {
  const raw = parseControlBullet(body ?? "", "Terminal result");
  const m = raw ? TERMINAL_MARKER.exec(raw) : null;
  return m ? { packet: Number(m[1]), attemptId: m[2] } : null;
}

// Pure. The terminal control snapshot. Reuses `upsertControlBullet` (the one bullet/heading rewriter), so it
// works for the ad hoc bullet convention and the template's "### State" heading shape alike. Execution,
// PR, Stage 1/2 and every historical line are untouched; a previous Terminal result is kept verbatim.
export function buildRetiredControlBody(body, { executionIssue, attemptId }) {
  const previous = parseControlBullet(body ?? "", "Terminal result");
  const keepPrevious = previous && !isNoneSentinel(previous) && !TERMINAL_MARKER.test(previous);
  // Re-composing an already-retired body is a no-op for this field (history is never stacked or dropped).
  const alreadyRetired = previous && TERMINAL_MARKER.test(previous);
  const fresh =
    `Consumed one-shot qualification NO-GO retired by tools/orchestration/retire-consumed-qualification.mjs: ` +
    `packet #${executionIssue}, attempt ${attemptId} (nonce ${QUALIFICATION_NONCE_PREFIX}${executionIssue}). ` +
    `Honest diagnostic NO-GO only; not a worker PASS, no backed CLEAN Stage 2, no Campaign completion. ` +
    `A separately authorized successor packet may reopen this control.` +
    (keepPrevious ? ` Prior terminal result: ${previous}` : "");
  const terminalResult = alreadyRetired ? previous : fresh;
  let next = body ?? "";
  next = upsertControlBullet(next, "Lifecycle", "DONE");
  next = upsertControlBullet(next, "Route", "none");
  next = upsertControlBullet(next, "Blocker", "none");
  next = upsertControlBullet(next, "Founder decision", "none");
  next = upsertControlBullet(next, "Terminal result", terminalResult);
  return next;
}

function packetRecordComment({ controlIssue, executionIssue, attemptId, verdict }) {
  return [
    RETIREMENT_RECORD_HEADING,
    "",
    `- **Verdict:** ${verdict}`,
    `- **Control issue:** #${controlIssue}`,
    `- **Proof packet:** #${executionIssue}`,
    `- **Attempt id:** ${attemptId}`,
    "- **Retired by:** tools/orchestration/retire-consumed-qualification.mjs",
    "",
    "This one-shot qualification is consumed and terminal. The recorded NO-GO is an honest diagnostic observation, " +
      "not a worker PASS, not a backed CLEAN Stage 2, and not Campaign completion. The attempt is never retried or " +
      "ordinarily dispatched; the original claim and result comments are preserved unchanged.",
    "",
  ].join("\n");
}

function controlRecordComment({ controlIssue, executionIssue, attemptId, verdict }) {
  return [
    RETIREMENT_RECORD_HEADING,
    "",
    `- **Verdict:** ${verdict}`,
    `- **Control issue:** #${controlIssue}`,
    `- **Proof packet:** #${executionIssue}`,
    `- **Attempt id:** ${attemptId}`,
    "- **Retired by:** tools/orchestration/retire-consumed-qualification.mjs",
    "",
    `Control #${controlIssue} is terminalized (Lifecycle DONE, closed) and can no longer dispatch packet #${executionIssue}. ` +
      "This is a NO-GO diagnostic terminal state only; it does not qualify a worker. A successor requires a separately " +
      "authorized new packet activated through activate-control-pair.mjs.",
    "",
  ].join("\n");
}

function hasRecordComment(rawComments, { executionIssue, attemptId }) {
  return (Array.isArray(rawComments) ? rawComments : []).some((c) => {
    if (firstLine(c?.body) !== RETIREMENT_RECORD_HEADING) return false;
    const f = parseBoldBullets(c.body);
    return f.get("Proof packet") === `#${executionIssue}` && f.get("Attempt id") === attemptId;
  });
}

// ---- verification (read-only) -----------------------------------------------------------------

// Gathers every fact the decision needs. Throws on any unreadable fact (callers map to exit 1).
async function gather({ repo, controlIssue, executionIssue }, impls) {
  const control = await impls.readIssueImpl({ repo, number: controlIssue });
  const packet = await impls.readIssueImpl({ repo, number: executionIssue });
  const meta = await impls.readPacketMetaImpl({ repo, number: executionIssue });
  const controlComments = await impls.listCommentsImpl({ repo, number: controlIssue });
  const packetComments = await impls.listCommentsImpl({ repo, number: executionIssue });
  return { control, packet, meta, controlComments, packetComments };
}

// Pure-ish verification over gathered facts. Returns { errors: string[], facts }.
async function verify({ repo, controlIssue, executionIssue }, g, impls) {
  const errors = [];
  const cBody = g.control.body ?? "";
  const cState = String(g.control.state ?? "").toUpperCase();
  const pState = String(g.packet.state ?? "").toUpperCase();
  const marker = readRetirementMarker(cBody);

  // -- control identity / lifecycle --
  const pointer = readExecutionPointer(cBody);
  if (pointer.kind === "bad") errors.push(pointer.reason);
  else if (pointer.issue !== executionIssue) {
    errors.push(`control #${controlIssue}'s Execution pointer is #${pointer.issue}, not the packet #${executionIssue} being retired`);
  }
  const lifecycle = evaluateLifecycle(cBody);
  if (lifecycle === null) {
    errors.push(`control #${controlIssue} records no Lifecycle/State`);
  } else if (marker) {
    if (lifecycle !== "DONE") errors.push(`control #${controlIssue} carries this tool's terminal marker but Lifecycle is ${JSON.stringify(lifecycle)}, not DONE`);
  } else if (lifecycle !== "READY") {
    errors.push(`control #${controlIssue} Lifecycle is ${JSON.stringify(lifecycle)}; only a stale READY control (or one already retired by this tool) is retired here`);
  }
  for (const label of ["PR", "Stage 1", "Stage 2"]) {
    const v = parseControlBullet(cBody, label);
    if (v !== null && !isNoneSentinel(v)) errors.push(`control #${controlIssue} "${label}" is ${JSON.stringify(v)}, not none — an in-flight review lifecycle is never retired as a consumed qualification`);
  }
  if (cState !== "OPEN" && !(cState === "CLOSED" && marker)) {
    errors.push(`control #${controlIssue} is ${cState}${cState === "CLOSED" ? " without this tool's terminal marker" : ""}; refusing to retire it`);
  }

  // -- packet identity / grant --
  if (g.meta.isPullRequest) errors.push(`#${executionIssue} is a pull request, not a proof packet`);
  const parents = parentLoopReferences(g.packet.body);
  if (parents.length !== 1 || parents[0] !== controlIssue) {
    errors.push(`packet #${executionIssue}'s "Parent loop" must bind exactly control #${controlIssue} (found ${parents.length ? parents.map((n) => `#${n}`).join(", ") : "none"})`);
  }
  const cls = classifyQualificationPacket(g.packet.body ?? "", { controlIssue, executionIssue });
  if (cls.kind !== "qualification") {
    errors.push(cls.kind === "none" ? `packet #${executionIssue} carries no claudeQualification grant for this pair` : cls.reason);
  }
  let authorOk = g.meta.association === "OWNER";
  if (!authorOk && g.meta.author) {
    const perm = await impls.permissionForImpl({ repo, login: g.meta.author });
    authorOk = hasWritePermission(perm);
  }
  if (!authorOk) errors.push(`packet #${executionIssue}'s author ${JSON.stringify(g.meta.author)} is not a repository writer`);
  if (pState !== "OPEN" && !(pState === "CLOSED" && marker)) {
    errors.push(`packet #${executionIssue} is ${pState}; only an OPEN packet (or one this tool already closed) is retired`);
  }

  // -- consumption evidence --
  const evidence = collectQualificationEvidence({ controlComments: g.controlComments, packetComments: g.packetComments, controlIssue, executionIssue });
  if (evidence.conflicts.length > 0) errors.push(`${evidence.conflicts.length} trusted result comment(s) on packet #${executionIssue} name a different pair`);
  let attemptId = null;
  if (evidence.claims.length !== 1) {
    errors.push(`expected exactly one trusted ${QUALIFICATION_NONCE_PREFIX}${executionIssue} claim on control #${controlIssue}, found ${evidence.claims.length}`);
  } else {
    const claim = evidence.claims[0];
    attemptId = claim.attemptId;
    if (!SETTLED_PHASES.has(claim.phase)) errors.push(`claim ${claim.attemptId} is ${JSON.stringify(claim.phase)}, not settled`);
    if (claim.runner !== "github-actions") errors.push(`claim ${claim.attemptId} runner is ${JSON.stringify(claim.runner)}, not github-actions`);
    const raw = (g.controlComments ?? []).find((c) => c?.id === claim.commentId);
    const outcome = raw ? parseBoldBullets(raw.body).get("Outcome") : null;
    if (outcome !== "NO_GO") errors.push(`claim ${claim.attemptId} settled outcome is ${JSON.stringify(outcome ?? null)}, not NO_GO`);
  }
  const onControl = evidence.results.filter((r) => r.where === "control");
  const onPacket = evidence.results.filter((r) => r.where === "packet");
  if (onControl.length !== 1) errors.push(`expected exactly one matching Claude Qualification Result on control #${controlIssue}, found ${onControl.length}`);
  if (onPacket.length !== 1) errors.push(`expected exactly one matching Claude Qualification Result on packet #${executionIssue}, found ${onPacket.length}`);
  for (const r of evidence.results) {
    if (r.verdict !== "NO-GO") errors.push(`${r.where} result verdict is ${JSON.stringify(r.verdict)}, not NO-GO (a PASS is never retired here)`);
    if (r.host !== QUALIFICATION_HOST) errors.push(`${r.where} result host is ${JSON.stringify(r.host)}, not ${QUALIFICATION_HOST}`);
    if (attemptId && r.attemptId !== attemptId) errors.push(`${r.where} result attempt id ${JSON.stringify(r.attemptId)} does not match claim attempt ${attemptId}`);
  }
  if (onControl.length === 1 && onPacket.length === 1) {
    const cr = (g.controlComments ?? []).find((c) => c?.id === onControl[0].commentId);
    const pr = (g.packetComments ?? []).find((c) => c?.id === onPacket[0].commentId);
    if (normalize(cr?.body) !== normalize(pr?.body)) errors.push("the control and packet result records are not identical");
  }
  if (marker && attemptId && (marker.packet !== executionIssue || marker.attemptId !== attemptId)) {
    errors.push(`control #${controlIssue}'s terminal marker names packet #${marker.packet} attempt ${marker.attemptId}, not packet #${executionIssue} attempt ${attemptId}`);
  }

  // -- authoritative run liveness (a live or unreadable run never retires) --
  if (attemptId && errors.length === 0) {
    const id = parseAttemptId(attemptId);
    if (!id) {
      errors.push(`attempt id ${JSON.stringify(attemptId)} is not <run_id>-<run_attempt>`);
    } else {
      const run = await impls.readRunImpl({ repo, runId: id.runId, runAttempt: id.runAttempt });
      if (String(run?.status ?? "").toLowerCase() !== "completed") {
        errors.push(`Actions run attempt ${attemptId} reads back as ${JSON.stringify(run?.status ?? null)}, not completed`);
      }
    }
  }

  return { errors, facts: { marker, attemptId, lifecycle, cState, pState } };
}

// Pure. Lifecycle via the gate's own reader (bullet, else "### State"), upper-cased.
function evaluateLifecycle(body) {
  const bullet = parseControlBullet(body, "Lifecycle");
  const raw = bullet ?? headingState(body);
  return raw === null || raw === undefined ? null : String(raw).toUpperCase();
}

function headingState(body) {
  // Same last-heading, first-non-blank-line read as the gate's parseHeadingField("State").
  const lines = String(body ?? "").split("\n");
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim() === "### State") { idx = i; break; }
  if (idx === -1) return null;
  for (let i = idx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("### ")) break;
    if (t === "") continue;
    return t === "_No response_" ? null : t;
  }
  return null;
}

function fingerprint(g) {
  return JSON.stringify({
    cb: normalize(g.control.body),
    cs: g.control.state,
    pb: normalize(g.packet.body),
    ps: g.packet.state,
    cc: (g.controlComments ?? []).map((c) => c?.id),
    pc: (g.packetComments ?? []).map((c) => c?.id),
  });
}

// ---- orchestration ----------------------------------------------------------------------------

export async function checkRetireConsumedQualification(args, impls = {}) {
  const i = {
    readIssueImpl: defaultReadIssue,
    readPacketMetaImpl: defaultReadPacketMeta,
    permissionForImpl: defaultPermissionFor,
    listCommentsImpl: defaultListIssueComments,
    readRunImpl: defaultReadRun,
    ghEditImpl: undefined, // write-control-snapshot.mjs's own default REST writer
    commentImpl: defaultComment,
    closeImpl: defaultClose,
    gateImpl: (a) => checkReadyDispatch(a),
    ...impls,
  };
  const repo = args.repo;
  const controlIssue = Number(args["control-issue"]);
  const executionIssue = Number(args["execution-issue"]);
  const dryRun = args.dryRun === true;
  if (!repo || !Number.isInteger(controlIssue) || controlIssue <= 0 || !Number.isInteger(executionIssue) || executionIssue <= 0) {
    return { exitCode: 1, message: "Missing or invalid args: --repo (or derivable origin), --control-issue and --execution-issue are all required positive integers." };
  }
  if (controlIssue === executionIssue) return { exitCode: 1, message: "--control-issue and --execution-issue must be different Issues." };
  const ids = { repo, controlIssue, executionIssue };

  let g;
  try {
    g = await gather(ids, i);
  } catch (err) {
    return { exitCode: 1, state: "READ_FAILED", message: `could not read live state for ${repo}#${controlIssue}/#${executionIssue}: ${err.message}` };
  }
  let v;
  try {
    v = await verify(ids, g, i);
  } catch (err) {
    return { exitCode: 1, state: "READ_FAILED", message: `could not verify ${repo}#${controlIssue}/#${executionIssue}: ${err.message}` };
  }
  if (v.errors.length > 0) {
    return {
      exitCode: 2,
      state: "REJECTED",
      controlIssue,
      executionIssue,
      errors: v.errors,
      message: `Refusing to retire ${repo}#${controlIssue}/#${executionIssue}; nothing was written:\n- ${v.errors.join("\n- ")}`,
    };
  }

  const { attemptId, marker } = v.facts;
  const verdict = "NO-GO";
  const bodyDone = Boolean(marker);
  const packetRecorded = hasRecordComment(g.packetComments, { executionIssue, attemptId });
  const controlRecorded = hasRecordComment(g.controlComments, { executionIssue, attemptId });
  const pending = [];
  if (!bodyDone) pending.push("write-control-snapshot");
  if (!packetRecorded) pending.push("packet-record-comment");
  if (v.facts.pState !== "CLOSED") pending.push("close-packet");
  if (v.facts.cState !== "CLOSED") pending.push("close-control");
  if (!controlRecorded) pending.push("control-record-comment");

  if (dryRun) {
    return { exitCode: 0, state: "DRY_RUN_VERIFIED", controlIssue, executionIssue, attemptId, verdict, pending };
  }

  const completed = [];
  const partial = (failedStep, message) => ({
    exitCode: 1,
    state: "PARTIAL",
    controlIssue,
    executionIssue,
    completed: [...completed],
    failedStep,
    remaining: pending.filter((s) => !completed.includes(s)),
    message:
      `${message} Completed: ${completed.length ? completed.join(", ") : "nothing"}; failed: ${failedStep}; remaining: ${pending.filter((s) => !completed.includes(s)).join(", ")}. ` +
      "Re-running the same command resumes from live state; the control is not claimed terminal until it completes.",
  });

  if (pending.length > 0) {
    // Stale-base proof immediately before the first mutation: any concurrent change refuses the whole run.
    let again;
    try {
      again = await gather(ids, i);
    } catch (err) {
      return { exitCode: 1, state: "READ_FAILED", message: `pre-write re-read failed: ${err.message}` };
    }
    if (fingerprint(again) !== fingerprint(g)) {
      return {
        exitCode: 2,
        state: "STALE",
        controlIssue,
        executionIssue,
        errors: ["live control/packet state changed since it was verified; nothing was written"],
        message: `Refusing to retire ${repo}#${controlIssue}/#${executionIssue}: live state changed during verification. Re-run to re-verify.`,
      };
    }
  }

  // 1. validated terminal control snapshot, then independent readback.
  if (pending.includes("write-control-snapshot")) {
    const proposedBody = buildRetiredControlBody(g.control.body ?? "", { executionIssue, attemptId });
    if (evaluateReadyDispatchGate(proposedBody, controlIssue).status === "READY_TO_DISPATCH") {
      return { exitCode: 1, state: "COMPOSE_FAILED", message: "the composed terminal snapshot would still read READY_TO_DISPATCH; refusing to write it" };
    }
    const write = checkWriteControlSnapshot({ repo, controlIssue, proposedBody }, { ghEditImpl: i.ghEditImpl });
    if (write.exitCode === 2) {
      return { exitCode: 2, state: "REJECTED", controlIssue, executionIssue, errors: write.errors, message: write.message };
    }
    if (write.exitCode !== 0) return partial("write-control-snapshot", `The validated control write failed: ${write.message}.`);
    try {
      const back = await i.readIssueImpl({ repo, number: controlIssue });
      const same = normalize(back.body) === normalize(proposedBody) || isKnownAttributionDecoration(proposedBody, back.body ?? "");
      const m = readRetirementMarker(back.body);
      if (!same || !m || m.packet !== executionIssue || m.attemptId !== attemptId || evaluateLifecycle(back.body) !== "DONE") {
        return partial("write-control-snapshot", "The control body did not read back as the proposed terminal snapshot.");
      }
    } catch (err) {
      return partial("write-control-snapshot", `Readback of the control body failed: ${err.message}.`);
    }
    completed.push("write-control-snapshot");
  }

  // 2. packet retirement record (idempotent by marker), verified by re-listing.
  if (pending.includes("packet-record-comment")) {
    try {
      await i.commentImpl({ repo, issue: executionIssue, body: packetRecordComment({ controlIssue, executionIssue, attemptId, verdict }) });
      const listed = await i.listCommentsImpl({ repo, number: executionIssue });
      if (!hasRecordComment(listed, { executionIssue, attemptId })) return partial("packet-record-comment", "The packet retirement record did not read back.");
    } catch (err) {
      return partial("packet-record-comment", `Posting the packet retirement record failed: ${err.message}.`);
    }
    completed.push("packet-record-comment");
  }

  // 3. close the packet, verify CLOSED.
  if (pending.includes("close-packet")) {
    try {
      await i.closeImpl({ repo, issue: executionIssue });
      const back = await i.readIssueImpl({ repo, number: executionIssue });
      if (String(back.state).toUpperCase() !== "CLOSED") return partial("close-packet", `Packet #${executionIssue} did not read back CLOSED.`);
    } catch (err) {
      return partial("close-packet", `Closing packet #${executionIssue} failed: ${err.message}.`);
    }
    completed.push("close-packet");
  }

  // 4. close the control, verify CLOSED and that the terminal body survived.
  if (pending.includes("close-control")) {
    try {
      await i.closeImpl({ repo, issue: controlIssue });
      const back = await i.readIssueImpl({ repo, number: controlIssue });
      const m = readRetirementMarker(back.body);
      if (String(back.state).toUpperCase() !== "CLOSED" || !m || evaluateLifecycle(back.body) !== "DONE") {
        return partial("close-control", `Control #${controlIssue} did not read back CLOSED with its terminal body.`);
      }
    } catch (err) {
      return partial("close-control", `Closing control #${controlIssue} failed: ${err.message}.`);
    }
    completed.push("close-control");
  }

  // 5. control record: explanatory only — a failure here never un-terminalizes, but is reported.
  let controlRecordWarning = null;
  if (pending.includes("control-record-comment")) {
    try {
      await i.commentImpl({ repo, issue: controlIssue, body: controlRecordComment({ controlIssue, executionIssue, attemptId, verdict }) });
      completed.push("control-record-comment");
    } catch (err) {
      controlRecordWarning = `could not post the control record comment: ${err.message}; re-running will post it`;
    }
  }

  // 6. a fresh gate must no longer authorize dispatch of the consumed packet.
  let gate;
  try {
    gate = await i.gateImpl({ repo, controlIssue });
  } catch (err) {
    return partial("gate-verification", `The fresh gate could not be evaluated: ${err.message}.`);
  }
  const dispatchStates = new Set([
    "READY_TO_DISPATCH", "READY_TO_DISPATCH_PLANNING", "READY_TO_RUN_DISPATCH_MANIFEST", "READY_TO_DISPATCH_UNITS",
    "READY_TO_DISPATCH_INTEGRATION", "READY_TO_PROJECT_PLAN_READY", "READY_TO_PROJECT_ROUTED", "PR_BREAKPOINT_NEEDS_FINALIZATION",
  ]);
  if (gate?.exitCode === 1 || dispatchStates.has(gate?.state) || gate?.state === undefined) {
    return partial("gate-verification", `A fresh ready-dispatch gate returned ${JSON.stringify(gate?.state ?? gate?.message ?? null)}, not a non-dispatchable verdict.`);
  }

  return {
    exitCode: 0,
    state: pending.length === 0 ? "ALREADY_TERMINAL" : "RETIRED",
    controlIssue,
    executionIssue,
    attemptId,
    verdict,
    completed,
    gateState: gate.state,
    ...(controlRecordWarning ? { warning: controlRecordWarning } : {}),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++k];
  }
  return args;
}

async function main() {
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
  const result = await checkRetireConsumedQualification({ ...args, repo });
  if (result.exitCode !== 0) {
    console.error(result.message ?? JSON.stringify(result));
    if (result.exitCode === 1 && result.state === "PARTIAL") console.error(JSON.stringify(result));
    process.exit(result.exitCode);
    return;
  }
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("retire-consumed-qualification.mjs")) {
  main();
}
