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
// Second operation (issue #1223, control #1222): `--amend` appends newly founder-approved component
// grants to the ONE existing ACTIVE grant record of a thick packet. Authority comes only from a
// fixed-format approval comment (`## Founder Grant Amendment Approval (v1)`, naming this exact
// control/execution pair and carrying the exact fenced `executorSubstrate` entries) authored by a
// repository admin on the control or execution Issue -- never from an arbitrary comment. Entries are
// spliced into the existing fenced JSON array at the text level, so every other byte (existing grants,
// prose, EOLs) is preserved; the operation refuses (exit 2, nothing written) on a missing/ambiguous
// ACTIVE section, a stale base, a conflicting component, an unbounded or mis-attributed path envelope,
// or an untrusted/malformed approval, and verifies the COMPLETE effective grant set on readback.
//
// Usage:
//   node tools/orchestration/write-thick-grant.mjs --control-issue C --execution-issue E --body-file F [--founder-approval-ref URL]
//   node tools/orchestration/write-thick-grant.mjs --amend --control-issue C --execution-issue E --founder-approval-ref URL --dispatch-authority '<trigger JSON>'
//
// Exit codes: 0 WRITTEN (verified) / ALREADY_ACTIVE; 1 operational failure (args, read, write, readback);
// 2 REFUSED (durable body left unchanged).
//
// Tests: node --test tools/orchestration/write-thick-grant.test.mjs

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { readGithubIssue } from "./github-read.mjs";
import { resolveRepoIdentity, readExecutionBulletField, parseExecutionPointer, parseControlBullet, isKnownLifecycleValue, isBlockingLifecycleValue, isNoneSentinel } from "./ready-dispatch-gate.mjs";
import { classifyExecutionAuthority } from "./execution-authority-gate.mjs";
import { parseAuthority, classifyPath, normalizePath, EXECUTOR_SUBSTRATE } from "./executor-substrate-authority.mjs";
import { findActiveGrantWitness, isCanonicalActiveHeading, parentLoopIdentifiesControl } from "./activate-control-pair.mjs";
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

// ---- #1223: post-ACTIVE amendment ----------------------------------------------------------------

export const APPROVAL_HEADING = "## Founder Grant Amendment Approval (v1)";

// Pure. The COMPLETE effective ACTIVE grant set of a thick body. Unlike findActiveGrantWitness (first
// valid section wins), this is unambiguous or not ok: exactly one canonical ACTIVE heading, a valid
// record, and no duplicated component.
export function effectiveActiveGrants(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const headings = lines.map((l, i) => (HEADING.test(l) ? i : -1)).filter((i) => i >= 0);
  const active = headings.filter((i) => isCanonicalActiveHeading(lines[i]));
  if (active.length === 0) return { ok: false, reason: "thick Issue body carries no ACTIVE grant section" };
  if (active.length > 1) return { ok: false, ambiguous: true, reason: `thick Issue body carries ${active.length} ACTIVE grant sections; the effective grant set is ambiguous` };
  const next = headings.find((i) => i > active[0]) ?? lines.length;
  const fence = lines.slice(active[0] + 1, next).join("\n").match(/```json\s*\n([\s\S]*?)\n```/);
  if (!fence) return { ok: false, reason: "ACTIVE grant section has no fenced JSON authority record" };
  let record;
  try {
    record = JSON.parse(fence[1]);
  } catch (err) {
    return { ok: false, reason: `ACTIVE grant JSON is not parseable: ${err.message}` };
  }
  const { grants, problems } = parseAuthority(record);
  if (problems.length > 0 || grants.size === 0) return { ok: false, reason: `ACTIVE grant record invalid: ${problems.join("; ") || "no grants"}` };
  const entries = record.executorSubstrate;
  if (entries.length !== grants.size) return { ok: false, ambiguous: true, reason: "ACTIVE grant record names a component more than once; the effective grant set is ambiguous" };
  return { ok: true, components: [...grants.keys()], entries };
}

// Pure. True when any JSON object in `text` repeats a key (JSON.parse would silently keep the last).
export function hasDuplicateJsonKeys(text) {
  const s = String(text);
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const str = () => {
    const start = i++;
    while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(s.slice(start, i));
  };
  const value = () => {
    ws();
    if (s[i] === "{") {
      i++;
      const seen = new Set();
      ws();
      if (s[i] === "}") { i++; return false; }
      for (;;) {
        ws();
        const k = str();
        if (seen.has(k)) return true;
        seen.add(k);
        ws();
        i++; // colon
        if (value()) return true;
        ws();
        if (s[i++] === "}") return false;
      }
    }
    if (s[i] === "[") {
      i++;
      ws();
      if (s[i] === "]") { i++; return false; }
      for (;;) {
        if (value()) return true;
        ws();
        if (s[i++] === "]") return false;
      }
    }
    if (s[i] === '"') { str(); return false; }
    while (i < s.length && !/[,\]}\s]/.test(s[i])) i++;
    return false;
  };
  try {
    return value();
  } catch {
    return false;
  }
}

// Pure. Parses the fixed-format founder approval comment body.
export function parseApprovalComment(body, { controlIssue, executionIssue }) {
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  const first = text.split("\n").find((l) => l.trim() !== "");
  if (!first || first.trim() !== APPROVAL_HEADING) return { ok: false, reason: `approval comment must begin with the exact heading "${APPROVAL_HEADING}"` };
  const ctl = [...text.matchAll(/^- Control issue: #(\d+)\s*$/gm)];
  const exe = [...text.matchAll(/^- Execution issue: #(\d+)\s*$/gm)];
  if (ctl.length !== 1 || exe.length !== 1 || Number(ctl[0][1]) !== Number(controlIssue) || Number(exe[0][1]) !== Number(executionIssue)) {
    return { ok: false, reason: `approval comment must name exactly control #${controlIssue} and execution #${executionIssue}` };
  }
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  if (fences.length !== 1) return { ok: false, reason: "approval comment must carry exactly one fenced JSON authority record" };
  if (hasDuplicateJsonKeys(fences[0][1])) return { ok: false, reason: "approval JSON repeats an object key; the record is ambiguous" };
  let record;
  try {
    record = JSON.parse(fences[0][1]);
  } catch (err) {
    return { ok: false, reason: `approval JSON is not parseable: ${err.message}` };
  }
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).join() !== "executorSubstrate") {
    return { ok: false, reason: "approval record must be an object with exactly the key executorSubstrate" };
  }
  const { grants, problems } = parseAuthority(record);
  const entries = record.executorSubstrate;
  if (problems.length > 0 || grants.size === 0 || entries.length !== grants.size) {
    return { ok: false, reason: `approval record invalid: ${problems.join("; ") || (grants.size === 0 ? "no grants" : "duplicate component")}` };
  }
  for (const g of entries) {
    if (!Array.isArray(g.paths)) return { ok: false, reason: `grant for ${g.component} must state a bounded paths envelope` };
    for (const path of g.paths) {
      if (typeof path !== "string" || normalizePath(path) !== path) {
        return { ok: false, reason: `path ${JSON.stringify(path)} is not in canonical normalized form` };
      }
      const c = classifyPath(path);
      if (c.class !== EXECUTOR_SUBSTRATE || c.component !== g.component || /[*?]/.test(path)) {
        return { ok: false, reason: `path ${JSON.stringify(path)} is not an exact path owned by component ${g.component}` };
      }
    }
  }
  return { ok: true, entries };
}

const COMMENT_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)#issuecomment-(\d+)$/;

function ghJson(args, runImpl = execFileSync) {
  return JSON.parse(runImpl("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
}
export function defaultReadComment({ repo, commentId }, runImpl) {
  const r = ghJson([`repos/${repo}/issues/comments/${commentId}`], runImpl);
  return {
    id: r?.id,
    body: r?.body ?? "",
    login: r?.user?.login ?? null,
    userType: r?.user?.type ?? null,
    issueNumber: Number(/\/issues\/(\d+)$/.exec(String(r?.issue_url ?? ""))?.[1] ?? NaN),
  };
}
export function defaultPermissionFor({ repo, login }, runImpl) {
  // A lookup failure propagates: it is an operational error, never a durable "not admin" refusal.
  return ghJson([`repos/${repo}/collaborators/${login}/permission`], runImpl)?.permission ?? "none";
}

// Pure. Splices `newEntries` into the single ACTIVE section's fenced JSON array, preserving every
// other byte. Returns { ok, body } or { ok:false, state, reason }.
export function composeAmendedBody(live, newEntries) {
  const lines = live.split("\n");
  const offsets = [];
  let off = 0;
  for (const l of lines) {
    offsets.push(off);
    off += l.length + 1;
  }
  const headings = lines.map((l, i) => (HEADING.test(l) ? i : -1)).filter((i) => i >= 0);
  const active = headings.filter((i) => isCanonicalActiveHeading(lines[i]));
  if (active.length !== 1) return { ok: false, state: "AMBIGUOUS_ACTIVE", reason: `expected exactly one ACTIVE grant section, found ${active.length}` };
  const next = headings.find((i) => i > active[0]) ?? lines.length;
  let open = -1;
  let close = -1;
  for (let i = active[0] + 1; i < next; i++) {
    if (open < 0 && /^```json[ \t]*\r?$/.test(lines[i])) open = i;
    else if (open >= 0 && /^```[ \t]*\r?$/.test(lines[i])) {
      close = i;
      break;
    }
  }
  if (open < 0 || close < 0) return { ok: false, state: "UNSUPPORTED_LAYOUT", reason: "ACTIVE grant fence is not a line-delimited ```json block" };
  const eol = lines[open].endsWith("\r") ? "\r\n" : "\n";
  const start = offsets[open + 1];
  let raw = live.slice(start, offsets[close] - 1);
  const tailCR = raw.endsWith("\r") ? "\r" : "";
  if (tailCR) raw = raw.slice(0, -1);
  const jsonText = raw;
  const m = /\]\s*\}\s*$/.exec(jsonText);
  if (!m) return { ok: false, state: "UNSUPPORTED_LAYOUT", reason: "ACTIVE grant JSON does not end with the executorSubstrate array and its object" };
  const trimmed = jsonText.slice(0, m.index).replace(/\s+$/, "");
  const gap = jsonText.slice(trimmed.length, m.index);
  const items = newEntries.map((e) => JSON.stringify(e, null, 2).split("\n").map((l) => "    " + l).join(eol));
  const amended = `${trimmed},${eol}${items.join(`,${eol}`)}${gap}${m[0]}`;
  const body = live.slice(0, start) + amended + tailCR + live.slice(offsets[close] - 1);
  return { ok: true, body };
}

// Pure. Classifies the structured dispatch trigger through classifyExecutionAuthority (route required for
// control_plane_dispatch) and binds the classified result to the requested pair. Only dispatch origins that
// carry the control Issue (and, where the formatter carries it, the execution Issue) can bind.
export function classifyAmendAuthority(trigger, controlIssue, executionIssue) {
  const verdict = classifyExecutionAuthority(trigger);
  if (!verdict.authorized) return { ok: false, reason: `no authorized execution-authority trigger: ${verdict.reason}` };
  const c = Number(controlIssue);
  const e = Number(executionIssue);
  if (["control_plane_dispatch", "planning_dispatch", "integration_dispatch"].includes(trigger.origin)) {
    if (trigger.controlIssue === c && trigger.executionIssue === e) return { ok: true };
    return { ok: false, reason: `authorized ${trigger.origin} does not name exactly control #${c} / execution #${e}` };
  }
  if (trigger.origin === "correction_dispatch" && trigger.controlIssue === c) return { ok: true };
  // A genuinely dispatched plan unit carries only the parent execution Issue; the caller separately
  // verifies that control C currently points to E, so binding parentExecutionIssue === E is safe.
  if (trigger.origin === "worker_unit_dispatch" && trigger.parentExecutionIssue === e) return { ok: true };
  return { ok: false, reason: `origin "${trigger.origin}" cannot be bound to control #${c} / execution #${e}` };
}

export function checkAmendThickGrant(
  { repo, controlIssue, executionIssue, founderApprovalRef, authorityEnvelope },
  { readIssueImpl = readGithubIssue, ghEditImpl = defaultGhEditThickIssue, readCommentImpl = defaultReadComment, permissionImpl = defaultPermissionFor, runImpl } = {},
) {
  if (!controlIssue) return fail("Missing required arg: --control-issue is required.");
  if (!executionIssue) return fail("Missing required arg: --execution-issue is required.");
  // Execution-authority boundary (AGENTS.md): an approval comment only informs an already-authorized
  // worker. The caller must supply a structured trigger that classifyExecutionAuthority authorizes AND
  // that binds exactly this control/execution pair; a hand-typed pair, a comment-shaped trigger, or an
  // origin carrying no pair (founder_direct, worker_unit_dispatch) never authorizes the write.
  const authority = classifyAmendAuthority(authorityEnvelope, controlIssue, executionIssue);
  if (!authority.ok) {
    return refuse("NO_EXECUTION_AUTHORITY", `${authority.reason}; an approval comment alone never authorizes the write; nothing was written.`);
  }
  const urlMatch = typeof founderApprovalRef === "string" ? COMMENT_URL.exec(founderApprovalRef) : null;
  if (!urlMatch) return refuse("BAD_APPROVAL_REF", "--founder-approval-ref must be an https://github.com/<owner>/<repo>/issues/<N>#issuecomment-<id> URL; nothing was written.");
  const c = Number(controlIssue);
  const e = Number(executionIssue);
  if (c === e) return refuse("SELF_EXECUTION", `control and execution Issue are both #${c}; nothing was written.`);
  if (repo && urlMatch[1].toLowerCase() !== String(repo).toLowerCase()) return refuse("BAD_APPROVAL_REF", "approval comment is in a different repository; nothing was written.");
  const commentIssue = Number(urlMatch[2]);
  if (commentIssue !== c && commentIssue !== e) return refuse("BAD_APPROVAL_REF", `approval comment is on #${commentIssue}, not on control #${c} or execution #${e}; nothing was written.`);

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
    if (!pointer.ok || pointer.issue !== e) return refuse("NOT_SOLE_EXECUTION", `control ${repo}#${c} does not name #${e} as its sole Execution pointer; nothing was written.`);
    // The trigger is caller-supplied and shape-validated only, so corroborate it against durable control
    // state: the control must be OPEN in a live, non-blocking Lifecycle, and a control_plane_dispatch route
    // must equal the Route the control durably records (when one is settled). A fabricated envelope that
    // does not match the control's own recorded state never authorizes the write.
    const body = control.issue.body ?? "";
    const lifecycle = parseControlBullet(body, "Lifecycle");
    const lifecycleWord = lifecycle ? lifecycle.split(/\s+/)[0].replace(/[^A-Za-z_]/g, "") : "";
    if (control.issue.state !== "OPEN" || !isKnownLifecycleValue(lifecycleWord) || isBlockingLifecycleValue(lifecycleWord)) {
      return refuse("NO_EXECUTION_AUTHORITY", `control ${repo}#${c} is not OPEN in a live, non-blocking Lifecycle, so no current dispatch is corroborated; nothing was written.`);
    }
    if (authorityEnvelope?.origin === "control_plane_dispatch") {
      const recorded = parseControlBullet(body, "Route");
      if (recorded && !isNoneSentinel(recorded) && recorded.trim().toLowerCase() !== String(authorityEnvelope.route).trim().toLowerCase()) {
        return refuse("NO_EXECUTION_AUTHORITY", `dispatch route does not match the Route recorded on control ${repo}#${c}; nothing was written.`);
      }
    }
    return null;
  };
  const verifyApproval = () => {
    let comment;
    try {
      comment = readCommentImpl({ repo, commentId: urlMatch[3] }, runImpl);
    } catch (err) {
      return { failure: fail(`read of approval comment failed: ${err.message}`) };
    }
    if (!comment || String(comment.id) !== urlMatch[3] || comment.issueNumber !== commentIssue) return { refusal: refuse("UNTRUSTED_APPROVAL", "approval comment did not resolve to the cited comment; nothing was written.") };
    if (!comment.login || comment.userType !== "User") return { refusal: refuse("UNTRUSTED_APPROVAL", "approval comment is not authored by a user account; nothing was written.") };
    let permission;
    try {
      permission = permissionImpl({ repo, login: comment.login }, runImpl);
    } catch (err) {
      return { failure: fail(`permission lookup for approval author failed: ${err.message}`) };
    }
    if (permission !== "admin") return { refusal: refuse("UNTRUSTED_APPROVAL", `approval comment author ${JSON.stringify(comment.login)} does not hold repository admin permission; nothing was written.`) };
    const parsed = parseApprovalComment(comment.body, { controlIssue: c, executionIssue: e });
    if (!parsed.ok) return { refusal: refuse("BAD_APPROVAL", `${parsed.reason}; nothing was written.`) };
    return { entries: parsed.entries };
  };

  const pointerRefusal = checkControlPointer();
  if (pointerRefusal) return pointerRefusal;
  const approval = verifyApproval();
  if (approval.refusal || approval.failure) return approval.refusal ?? approval.failure;

  const execution = readOne(e);
  if (execution.refusal || execution.failure) return execution.refusal ?? execution.failure;
  if (execution.issue.state !== "OPEN") return refuse("NOT_OPEN", `execution ${repo}#${e} is ${execution.issue.state}, not OPEN; nothing was written.`);
  const live = execution.issue.body ?? "";
  const parent = parentLoopIdentifiesControl(live, c);
  if (!parent.ok) return refuse("PARENT_MISMATCH", `${parent.reason}; nothing was written.`);

  const current = effectiveActiveGrants(live);
  if (!current.ok) return refuse(current.ambiguous ? "AMBIGUOUS_ACTIVE" : "NO_ACTIVE", `${current.reason}; nothing was written.`);
  const wit = findActiveGrantWitness(live);
  if (!wit.ok || !isDeepStrictEqual(wit.components, current.components)) return refuse("AMBIGUOUS_ACTIVE", "canonical witness and effective grant set disagree; nothing was written.");

  const toAdd = [];
  for (const entry of approval.entries) {
    const existing = current.entries.find((g) => g.component === entry.component);
    if (!existing) toAdd.push(entry);
    else if (!isDeepStrictEqual(existing, entry)) return refuse("CONFLICTING_GRANT", `component ${entry.component} is already granted with a different record; amendments never alter or widen an existing grant; nothing was written.`);
  }
  const expected = [...current.entries, ...toAdd];
  const verifyEffective = (body) => {
    const eff = effectiveActiveGrants(body);
    const w = findActiveGrantWitness(body);
    return eff.ok && isDeepStrictEqual(eff.entries, expected) && w.ok && isDeepStrictEqual(w.components, expected.map((g) => g.component));
  };
  if (toAdd.length === 0) {
    return { exitCode: 0, state: "ALREADY_AMENDED", verified: true, components: current.components, controlIssue: c, executionIssue: e, repo: repo ?? null };
  }

  const composed = composeAmendedBody(live, toAdd);
  if (!composed.ok) return refuse(composed.state, `${composed.reason}; nothing was written.`);
  if (!verifyEffective(composed.body)) return refuse("COMPOSE_MISMATCH", "composed body would not verify as the exact existing grants plus the approved entries; nothing was written.");

  // Tight stale window: re-verify pointer, approval and live bytes immediately before the write.
  const pointerAgain = checkControlPointer();
  if (pointerAgain) return pointerAgain;
  const approvalAgain = verifyApproval();
  if (approvalAgain.refusal || approvalAgain.failure) return approvalAgain.refusal ?? approvalAgain.failure;
  if (!isDeepStrictEqual(approvalAgain.entries, approval.entries)) return refuse("STALE_APPROVAL", "approval comment changed during validation; nothing was written.");
  const again = readOne(e);
  if (again.refusal || again.failure) return again.refusal ?? again.failure;
  if (again.issue.state !== "OPEN" || (again.issue.body ?? "") !== live) return refuse("STALE_BASE", "execution body changed during validation; nothing was written.");
  const parentAgain = parentLoopIdentifiesControl(again.issue.body ?? "", c);
  if (!parentAgain.ok) return refuse("PARENT_MISMATCH", `${parentAgain.reason}; nothing was written.`);

  try {
    ghEditImpl({ repo, executionIssue: e, body: composed.body }, runImpl);
  } catch (err) {
    return fail(`thick grant REST write failed for ${repo}#${e}: ${err.message}`, "WRITE_FAILED");
  }
  let back;
  try {
    back = readIssueImpl({ repo, number: e, fields: ["body", "state"] });
  } catch (err) {
    return fail(`wrote ${repo}#${e} but the independent readback failed: ${err.message}`, "READBACK_FAILED");
  }
  const backBody = back.body ?? "";
  const same = backBody === composed.body || isKnownAttributionDecorationExact(composed.body, backBody);
  if (back.state !== "OPEN" || !same || !verifyEffective(backBody)) {
    return fail(`wrote ${repo}#${e} but the persisted body did not read back as the complete amended ACTIVE grant set; do not report the grant active`, "READBACK_MISMATCH");
  }
  return { exitCode: 0, state: "AMENDED", verified: true, added: toAdd.map((g) => g.component), components: expected.map((g) => g.component), controlIssue: c, executionIssue: e, repo: repo ?? null };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--amend") args.amend = true;
    else if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const k of args.amend ? ["control-issue", "execution-issue", "founder-approval-ref", "dispatch-authority"] : ["control-issue", "execution-issue", "body-file"]) {
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
  if (args.amend) {
    const result = checkAmendThickGrant({
      repo,
      controlIssue: args["control-issue"],
      executionIssue: args["execution-issue"],
      founderApprovalRef: args["founder-approval-ref"],
      authorityEnvelope: (() => {
        try {
          return JSON.parse(args["dispatch-authority"]);
        } catch {
          return null;
        }
      })(),
    });
    if (result.exitCode !== 0) {
      console.error(result.message);
      process.exit(result.exitCode);
      return;
    }
    console.log(JSON.stringify(result));
    process.exit(0);
    return;
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
