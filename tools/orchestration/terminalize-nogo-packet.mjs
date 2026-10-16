#!/usr/bin/env node
// Deterministic terminalization of a consumed one-shot qualification packet that recorded a NO-GO.
//
// Gap this closes (Automation Campaign #661, #1180 / #1164): a `qualification_only` workflow attempt
// consumes its one-shot grant and records a durable `Claude Qualification Result (v1)` comment. A NO-GO
// there is a completed diagnostic observation, not worker qualification, and there is no CLEAN Stage 2
// audit behind it - so `close-control.mjs` (CLEAN-audit-backed only) correctly refuses, and no other
// repository mechanism retires the packet. The thin control kept advertising the consumed packet as
// `READY_TO_DISPATCH`, which would hand an ordinary implementation worker to a spent proof packet.
//
// This primitive is deliberately NOT a general close path and never relaxes close-control.mjs. It
// proves, from durable GitHub evidence only:
//   - the control's single Execution pointer names exactly the packet being retired;
//   - the packet's `Parent loop` binds exactly this control;
//   - the packet's own body carries the exact one-shot `claudeQualification` record for this pair;
//   - exactly one `Claude Qualification Result (v1)` comment exists on the packet, authored by
//     `github-actions[bot]`, naming this control and packet, with Verdict exactly `NO-GO`
//     (PASS, multiple, forged, or mismatched results all refuse);
// then closes the packet (its comments and body are left untouched, preserving the historical proof),
// persists a terminal control snapshot through the canonical `write-control-snapshot.mjs` writer, and
// closes the control, leaving it a normal terminal control that a separately authorized successor packet
// may reopen through `activate-control-pair.mjs`. It authorizes no dispatch, no retry, and no PASS claim.
//
// Idempotent and resumable: an already-closed control is ALREADY_TERMINAL; a closed packet with an open
// control continues from the control write. Every refusal leaves GitHub unchanged.
//
// Usage:
//   node tools/orchestration/terminalize-nogo-packet.mjs --control-issue 1164 --execution-issue 1180
//
// Exit codes: 0 (TERMINALIZED or ALREADY_TERMINAL), 1 (operational error), 2 (REJECTED).
// Tests: node --test tools/orchestration/terminalize-nogo-packet.test.mjs

import { execFileSync } from "node:child_process";
import { readGithubIssue } from "./github-read.mjs";
import { upsertControlBullet, resolveRepoIdentity, readExecutionBulletField, parseExecutionPointer } from "./ready-dispatch-gate.mjs";
import { parentLoopIdentifiesControl } from "./activate-control-pair.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";
import { validateControlSnapshot } from "./control-field-validator.mjs";
import { ghRestCloseIssue, ghRestCommentIssue } from "../review-watch/lifecycle-gate.mjs";

const RESULT_HEADING = /^\s*#{1,6}\s*Claude Qualification Result \(v1\)\s*$/m;
const BOT_LOGIN = "github-actions[bot]";

function bulletValue(body, label) {
  const m = String(body ?? "").match(new RegExp("^\\s*[-*]\\s*\\*\\*" + label + ":\\*\\*\\s*(.+?)\\s*$", "mi"));
  return m ? m[1] : null;
}

// Pure. Parses one qualification-result comment body into its compared fields.
export function parseQualificationResult(body) {
  const issueNum = (label) => {
    const v = bulletValue(body, label);
    const m = v && v.match(/^#(\d+)$/);
    return m ? Number(m[1]) : null;
  };
  return {
    verdict: bulletValue(body, "Verdict"),
    controlIssue: issueNum("Control issue"),
    packetIssue: issueNum("Proof packet"),
    attemptId: bulletValue(body, "Attempt id"),
    reason: bulletValue(body, "Reason"),
  };
}

// Pure. True only when the packet body carries exactly ONE `claudeQualification` record and it is the
// canonical grant the workflow itself requires (.github/workflows/ldl-launcher.yml claude-qualification):
// this pair, oneShot true, scope claude-sandbox-child-egress-v1, host ubuntu-22.04. A weaker, wrong-scope
// or additional conflicting record never qualifies.
export function packetHasQualificationRecord(packetBody, { controlIssue, executionIssue }) {
  const grants = [];
  for (const m of String(packetBody ?? "").matchAll(/```json\s*\n([\s\S]*?)\n\s*```/g)) {
    let record;
    try {
      record = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (record && typeof record === "object" && "claudeQualification" in record) grants.push(record.claudeQualification);
  }
  const [g] = grants;
  return (
    grants.length === 1 &&
    !!g &&
    Number(g.controlIssue) === controlIssue &&
    Number(g.executionIssue) === executionIssue &&
    g.oneShot === true &&
    g.scope === "claude-sandbox-child-egress-v1" &&
    g.host === "ubuntu-22.04"
  );
}

// Pure. Selects the single trustworthy NO-GO result from the packet's comments, or explains the refusal.
export function selectNoGoResult(comments, { controlIssue, executionIssue }) {
  const candidates = (comments ?? []).filter((c) => RESULT_HEADING.test(String(c?.body ?? "")));
  if (candidates.length === 0) return { ok: false, reason: "packet has no Claude Qualification Result (v1) comment" };
  if (candidates.length > 1) return { ok: false, reason: `packet has ${candidates.length} Claude Qualification Result (v1) comments; refusing an ambiguous or tampered record` };
  const [c] = candidates;
  if (c.user?.login !== BOT_LOGIN) return { ok: false, reason: `qualification result was authored by ${JSON.stringify(c.user?.login ?? null)}, not ${BOT_LOGIN}` };
  const r = parseQualificationResult(c.body);
  if (r.controlIssue !== controlIssue || r.packetIssue !== executionIssue) {
    return { ok: false, reason: `qualification result names control #${r.controlIssue} / packet #${r.packetIssue}, not #${controlIssue} / #${executionIssue}` };
  }
  if (r.verdict !== "NO-GO") return { ok: false, reason: `qualification verdict is ${JSON.stringify(r.verdict)}, not NO-GO; only a consumed NO-GO is terminalized here` };
  if (!r.attemptId) return { ok: false, reason: "qualification result carries no attempt id" };
  return { ok: true, result: r, url: c.html_url ?? null };
}

const TERMINAL_MARKER = "tools/orchestration/terminalize-nogo-packet.mjs";

// Pure. The control may be retired only while it still sits at the pre-dispatch qualification state
// (Lifecycle READY, no PR / Stage 1 / Stage 2 pointers), or when resuming this tool's own earlier
// terminal write (Lifecycle DONE carrying this tool's Terminal result marker). A control that advanced
// (REVIEW, AUDIT, ...) or carries downstream pointers is never rewritten.
export function controlIsRetirable(body) {
  const lifecycle = (bulletValue(body, "Lifecycle") ?? "").trim();
  const downstreamClear = ["PR", "Stage 1", "Stage 2"].every((l) => {
    const v = bulletValue(body, l);
    return v === null || /^none\b/i.test(v.trim());
  });
  if (!downstreamClear) return { ok: false, reason: "control carries a PR / Stage 1 / Stage 2 pointer; it has advanced beyond qualification" };
  if (/^READY\b/i.test(lifecycle)) return { ok: true, resume: false };
  if (/^DONE\b/i.test(lifecycle) && String(bulletValue(body, "Terminal result") ?? "").includes(TERMINAL_MARKER)) return { ok: true, resume: true };
  return { ok: false, reason: `control Lifecycle is ${JSON.stringify(lifecycle || null)}, not the pre-dispatch READY qualification state` };
}

// Pure. Composes the terminal control body. The Execution pointer is kept (it names the now-closed
// packet) so the historical record stays readable; every other current pointer is cleared.
export function buildNoGoTerminalControlBody(body, { executionIssue, attemptId, url }) {
  const ref = url ? ` (${url})` : "";
  const terminal =
    `Consumed one-shot qualification packet #${executionIssue} closed with durable NO-GO, attempt ${attemptId}${ref}; ` +
    "diagnostic observation only, NOT worker qualification; control terminalized by tools/orchestration/terminalize-nogo-packet.mjs.";
  let next = body ?? "";
  next = upsertControlBullet(next, "Lifecycle", "DONE");
  next = upsertControlBullet(next, "Route", "none");
  for (const label of ["PR", "Stage 1", "Stage 2"]) next = upsertControlBullet(next, label, "none");
  next = upsertControlBullet(next, "Blocker", "none");
  next = upsertControlBullet(next, "Founder decision", "none");
  next = upsertControlBullet(next, "Terminal result", terminal);
  return next;
}

function packetComment({ controlIssue, attemptId, url }) {
  return (
    `Retired by \`tools/orchestration/terminalize-nogo-packet.mjs\`: this one-shot qualification packet's durable ` +
    `NO-GO (attempt ${attemptId}${url ? `, ${url}` : ""}) is a completed diagnostic observation, not worker qualification. ` +
    `Its grant is consumed and cannot be reused or retried. Control #${controlIssue} is terminalized; this packet's body and ` +
    "result comment are preserved unchanged as historical proof. A successor requires a separate exact-packet ACTIVE authorization."
  );
}

export function defaultReadComments({ repo, number, execFileImpl = execFileSync }) {
  const all = [];
  for (let page = 1; ; page++) {
    if (page > 200) throw new Error(`comment pagination bound reached for ${repo}#${number}; refusing to judge on incomplete evidence`);
    const raw = execFileImpl("gh", ["api", `repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    const batch = JSON.parse(raw);
    if (!Array.isArray(batch)) throw new Error(`malformed comments response for ${repo}#${number}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

export function terminalizeNoGoPacket(
  args,
  { readIssueImpl = readGithubIssue, readCommentsImpl = defaultReadComments, ghEditImpl, closeImpl = ghRestCloseIssue, commentImpl = ghRestCommentIssue } = {},
) {
  const { repo } = args;
  const c = Number(args["control-issue"]);
  const e = Number(args["execution-issue"]);
  if (!repo || !Number.isInteger(c) || !Number.isInteger(e) || c <= 0 || e <= 0 || c === e) {
    return { exitCode: 1, message: "Missing or invalid args: --control-issue and --execution-issue (distinct positive integers) and a resolvable repository are required." };
  }
  const reject = (errors) => ({ exitCode: 2, state: "REJECTED", controlIssue: c, executionIssue: e, errors, message: `Refusing to terminalize ${repo}#${c} / packet #${e}:\n- ${errors.join("\n- ")}\nGitHub left unchanged.` });

  let control, packet, comments;
  try {
    control = readIssueImpl({ repo, number: c, fields: ["body", "state"] });
    packet = readIssueImpl({ repo, number: e, fields: ["body", "state"] });
    comments = readCommentsImpl({ repo, number: e });
  } catch (err) {
    return { exitCode: 1, message: `read failed: ${err.message}` };
  }

  if (control.state === "CLOSED" && packet.state === "CLOSED") return { exitCode: 0, state: "ALREADY_TERMINAL", controlIssue: c, executionIssue: e };

  const errors = [];
  const field = readExecutionBulletField(control.body);
  const pointer = !field.conflict && field.value ? parseExecutionPointer(field.value) : { ok: false };
  if (!pointer.ok || pointer.issue !== e) errors.push(`control Execution pointer does not name exactly #${e}`);
  const parent = parentLoopIdentifiesControl(packet.body, c);
  if (!parent.ok) errors.push(parent.reason);
  const retirable = controlIsRetirable(control.body);
  if (!retirable.ok) errors.push(retirable.reason);
  if (!packetHasQualificationRecord(packet.body, { controlIssue: c, executionIssue: e })) errors.push(`packet #${e} carries no exact one-shot claudeQualification record for control #${c}`);
  const selected = selectNoGoResult(comments, { controlIssue: c, executionIssue: e });
  if (!selected.ok) errors.push(selected.reason);
  if (errors.length > 0) return reject(errors);

  const { attemptId } = selected.result;
  const url = selected.url;
  const proposedBody = buildNoGoTerminalControlBody(control.body, { executionIssue: e, attemptId, url });

  // Validate the composed body before any mutation, so a refusal can never leave a closed packet behind.
  const validation = validateControlSnapshot(proposedBody, { controlIssue: c });
  if (!validation.ok) return reject(validation.errors);

  try {
    if (packet.state !== "CLOSED") {
      commentImpl({ repo, auditIssue: e, body: packetComment({ controlIssue: c, attemptId, url }) });
      closeImpl({ repo, issue: e });
    }
  } catch (err) {
    return { exitCode: 1, message: `packet #${e} retirement failed: ${err.message}; control left unchanged, rerun to resume.` };
  }

  const snapshot = checkWriteControlSnapshot({ repo, controlIssue: c, proposedBody }, { ...(ghEditImpl ? { ghEditImpl } : {}) });
  if (snapshot.exitCode === 2) return { exitCode: 2, state: "REJECTED", controlIssue: c, executionIssue: e, errors: snapshot.errors, message: snapshot.message };
  if (snapshot.exitCode !== 0) return { exitCode: 1, message: snapshot.message };

  // A successor activation may legitimately treat the temporary OPEN/DONE control as terminal. Re-read
  // immediately before closing and refuse unless the control is still exactly the terminal snapshot just
  // written, so a newly activated successor control is never closed underneath its own READY snapshot.
  try {
    if (control.state !== "CLOSED") {
      const live = readIssueImpl({ repo, number: c, fields: ["body", "state"] });
      if (live.state !== "OPEN" || String(live.body ?? "").trim() !== proposedBody.trim()) {
        return { exitCode: 2, state: "REJECTED", controlIssue: c, executionIssue: e, errors: ["control changed after the terminal snapshot was written"], message: `Not closing ${repo}#${c}: it no longer matches the terminal snapshot just written (a successor may have been activated). Left open; inspect before rerunning.` };
      }
      closeImpl({ repo, issue: c });
    }
  } catch (err) {
    return { exitCode: 1, message: `terminal snapshot written for #${c} but close failed: ${err.message}; rerun to resume.` };
  }
  return { exitCode: 0, state: "TERMINALIZED", controlIssue: c, executionIssue: e, attemptId, verdict: "NO-GO" };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let repo = args.repo;
  if (!repo) {
    const identity = resolveRepoIdentity();
    if (!identity.ok) {
      console.error(`Could not determine the current repository identity: ${identity.reason}`);
      process.exit(1);
    }
    repo = identity.repo;
  }
  const result = terminalizeNoGoPacket({ ...args, repo });
  if (result.exitCode !== 0) {
    console.error(result.message);
    process.exit(result.exitCode);
  }
  console.log(JSON.stringify(result));
}

if (process.argv[1] && process.argv[1].endsWith("terminalize-nogo-packet.mjs")) main();
