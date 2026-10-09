#!/usr/bin/env node
// Bounded evidence-only Stage 2 correction and same-merge re-audit — issue #883 (control #882,
// live reproduction #780 / #877 / PR #880 / Audit #881).
//
// The gap: a structurally valid, recorded Stage 2 NOT CLEAN audit whose sole accepted finding is
// missing external/live *proof* — not a demonstrated source defect — still resolved to
// `STAGE2_CORRECTION_REQUIRED`, and the correction worker contract assumed every accepted finding
// produces a correction PR and a fresh-merge Stage 2. There was no repository-authorized way to
// satisfy an evidence-only finding without inventing a no-op PR, and no way to obtain fresh
// independent assurance of the same exact merge afterward.
//
// This module is the deterministic half of that path. The semantic half (classifying a finding as
// source-correction vs evidence-only) stays inside the already-reasoning Stage 2 correction worker
// (format-dispatch-prompt.mjs's template; docs/bounded-review-cycle.md § Stage 2 evidence-only
// correction) — nothing here keyword-parses reviewer prose. What is deterministic and fail-closed:
//
//   record    Composes and posts ONE fixed-format "Stage 2 Evidence Correction Result" comment on
//             the authoritative work/execution Issue, after verifying every cited evidence comment
//             independently (exists, same repository, authored by the same trusted account that
//             created the audit, created strictly after the NOT CLEAN report). Idempotent.
//   verify    Read-only. Independently re-derives, from GitHub state alone (never from a worker's
//             claim that "proof passed"), whether the evidence correction is durably satisfied:
//             the predecessor is a backed recorded NOT CLEAN of an exactly-merged PR, no open
//             correction PR claims a source change, the result comment's identity matches the
//             audit's own PR/work/merge fields, and the one-re-audit-per-lineage bound still has
//             its single slot free (or already holds exactly the one valid replacement).
//   prepare   Creates (or recovers, idempotently) exactly ONE fresh canonical replacement Stage 2
//             Audit for the same repository/PR/work/merge identity. The replacement is a clone of
//             the predecessor's own audit body (so the reviewer receives the unchanged canonical
//             Stage 2 contract and checklist) with the Verdict reset to PENDING and one provenance
//             block in "Stage 1 inline review disposition" naming the predecessor and the result
//             comment. The predecessor Audit and its report are never edited, closed, or rewritten.
//             Projection onto the thin control Issue and the reviewer trigger stay the existing
//             finalize-audit-breakpoint.mjs (`--stale-audit-issue`) and trigger.mjs steps.
//
// Bounds (fail closed, never retry-until-CLEAN): an audit that is itself an evidence-recovery
// re-audit is NOT_ELIGIBLE; so is any audit whose exact PR/work/merge lineage already holds an
// evidence-recovery re-audit naming a different predecessor. Replacement NOT CLEAN therefore
// follows the ordinary source-correction route only.
//
// Usage:
//   node tools/orchestration/evidence-correction.mjs verify  --audit-issue <A> [--repo <o/r>]
//   node tools/orchestration/evidence-correction.mjs record  --audit-issue <A> --evidence <commentUrl>[,<commentUrl>...] [--repo <o/r>]
//   node tools/orchestration/evidence-correction.mjs prepare --audit-issue <A> [--repo <o/r>] [--dry-run true]
//
// Exit codes: 0 (state EVIDENCE_SATISFIED / EVIDENCE_RECORDED / REAUDIT_PREPARED /
// REAUDIT_ALREADY_PREPARED), 1 (operational error), 2 (a fail-closed refusal: NOT_ELIGIBLE,
// NOT_SATISFIED, PROVENANCE_MISMATCH, AMBIGUOUS).
//
// Tests: node --test tools/orchestration/evidence-correction.test.mjs

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveRepoIdentity, findOpenExecutionLinkedPr, defaultGhOpenPrList } from "./ready-dispatch-gate.mjs";
import { readGithubPr } from "./github-read.mjs";
import { checkScopeBaseline, ScopeState, substituteScopeBase, defaultReadCommit } from "./scope-baseline.mjs";
import {
  DEFAULT_BOT,
  defaultGhApi,
  findStage2ReportEvidence,
  hasCanonicalAuditShape,
  checkPreAuditPendingState,
  parseEvidenceRecoveryRef,
  parseFormFieldBlock,
  parseMergeCommitRef,
  parseStage2Verdict,
  parseVerificationChecklistRef,
  parseReviewedHeadCommitRef,
  parseWorkIssueRef,
  replaceVerdictField,
} from "../review-watch/lifecycle-gate.mjs";

export const RESULT_HEADING = "## Stage 2 Evidence Correction Result";
const FULL_SHA = /^[0-9a-f]{40}$/i;
const MAX_ISSUE_LIST_PAGES = 50;

export const Status = Object.freeze({
  NOT_ELIGIBLE: "NOT_ELIGIBLE",
  NO_RESULT: "NO_RESULT",
  INCOMPLETE: "INCOMPLETE",
  PROVENANCE_MISMATCH: "PROVENANCE_MISMATCH",
  SATISFIED: "SATISFIED",
  AMBIGUOUS: "AMBIGUOUS",
});

const isPositiveInteger = (v) => typeof v === "number" && Number.isInteger(v) && v > 0;
const normalizeEol = (t) => String(t ?? "").replace(/\r\n/g, "\n");

// -- Pure: fixed-format result comment ----------------------------------------------------------

// Pure. Composes the exact fixed-format result comment. Every field is machine-parsed back by
// parseEvidenceCorrectionResult; nothing in it is free prose a parser must interpret.
export function formatEvidenceCorrectionResult({ auditIssue, workIssue, pr, mergeCommit, findingUrl, evidenceUrls }) {
  return (
    `${RESULT_HEADING}\n\n` +
    `- **Audit issue:** #${auditIssue}\n` +
    `- **Work issue:** #${workIssue}\n` +
    `- **PR:** #${pr}\n` +
    `- **Exact merge commit:** ${mergeCommit}\n` +
    `- **Classification:** EVIDENCE_ONLY\n` +
    `- **Source changed:** none\n` +
    `- **Finding addressed:** ${findingUrl}\n` +
    `- **Disposition:** SATISFIED\n` +
    `- **Evidence:**\n` +
    evidenceUrls.map((u) => `  - ${u}`).join("\n") +
    "\n"
  );
}

const DEFAULT_HOST = "github.com";
const escapeRegExp = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Issue #883 Stage 1 correction: the permalink host is the configured GitHub host (the host GitHub
// itself reports for the audit Issue), not a hard-coded github.com, so GitHub Enterprise checkouts
// work. Only the host source is generalized; repo/comment identity rules are unchanged.
const commentUrlPattern = (host = DEFAULT_HOST) =>
  new RegExp(`^https://${escapeRegExp(host)}/([^/\\s]+/[^/\\s]+)/(?:issues|pull)/(\\d+)#issuecomment-(\\d+)$`, "i");

const hostOf = (htmlUrl) => {
  try {
    return new URL(String(htmlUrl)).host.toLowerCase() || DEFAULT_HOST;
  } catch {
    return DEFAULT_HOST;
  }
};
const sha256 = (t) => createHash("sha256").update(String(t ?? "")).digest("hex");

// Pure. Parses a result comment. Returns { ok: true, fields } or { ok: false, errors, auditIssue }
// where auditIssue (when recoverable) lets the caller tell "a malformed result for THIS audit"
// apart from "a result for some other audit".
export function parseEvidenceCorrectionResult(body, { host = DEFAULT_HOST } = {}) {
  const COMMENT_URL = commentUrlPattern(host);
  const text = normalizeEol(body).trim();
  if (!text.startsWith(RESULT_HEADING)) return { ok: false, errors: ["missing result heading"], auditIssue: null };
  // Issue #891: the canonical payload is the heading plus the single contiguous block of field lines
  // that follows it (the writer never emits a blank line inside it). The first blank line after the
  // fields ends the payload; anything after is non-authoritative presentation metadata appended by
  // the posting surface (e.g. an attribution footer) and is never parsed, so it cannot add,
  // override, or duplicate a canonical field. Non-blank text inside the block still fails closed.
  const allLines = text.slice(RESULT_HEADING.length).split("\n");
  let start = 0;
  while (start < allLines.length && allLines[start].trim() === "") start++;
  let end = start;
  while (end < allLines.length && allLines[end].trim() !== "") end++;
  const lines = allLines.slice(start, end);
  const labeled = new Map();
  const errors = [];
  let current = null;
  for (const line of lines) {
    const top = /^- \*\*([^:*]+):\*\*\s*(.*)$/.exec(line);
    if (top) {
      const label = top[1].trim();
      if (labeled.has(label)) errors.push(`duplicate field "${label}"`);
      current = { value: top[2].trim(), nested: [] };
      labeled.set(label, current);
      continue;
    }
    const nested = /^\s+- (\S.*)$/.exec(line);
    if (nested && current) {
      current.nested.push(nested[1].trim());
      continue;
    }
    if (line.trim() !== "") errors.push(`unrecognized line ${JSON.stringify(line.trim())}`);
  }
  const issueRef = (label) => {
    const raw = labeled.get(label)?.value ?? "";
    const m = /^#(\d+)$/.exec(raw);
    return m ? Number(m[1]) : null;
  };
  const auditIssue = issueRef("Audit issue");
  const fields = {
    auditIssue,
    workIssue: issueRef("Work issue"),
    pr: issueRef("PR"),
    mergeCommit: labeled.get("Exact merge commit")?.value ?? null,
    classification: labeled.get("Classification")?.value ?? null,
    sourceChanged: labeled.get("Source changed")?.value ?? null,
    findingUrl: labeled.get("Finding addressed")?.value ?? null,
    disposition: labeled.get("Disposition")?.value ?? null,
    evidenceUrls: [...(labeled.get("Evidence")?.nested ?? []), ...(labeled.get("Evidence")?.value ? [labeled.get("Evidence").value] : [])],
  };
  for (const [key, label] of [
    ["auditIssue", "Audit issue"],
    ["workIssue", "Work issue"],
    ["pr", "PR"],
  ]) {
    if (fields[key] === null) errors.push(`field "${label}" missing or not a #<number> reference`);
  }
  if (!fields.mergeCommit || !FULL_SHA.test(fields.mergeCommit)) errors.push('field "Exact merge commit" is not a full 40-hex commit id');
  if (!fields.findingUrl || !COMMENT_URL.test(fields.findingUrl)) errors.push('field "Finding addressed" is not a GitHub issue-comment URL');
  if (fields.evidenceUrls.length === 0) errors.push('field "Evidence" lists no comment URL');
  if (fields.evidenceUrls.some((u) => !COMMENT_URL.test(u))) errors.push('field "Evidence" contains a value that is not a GitHub issue-comment URL');
  return errors.length === 0 ? { ok: true, fields } : { ok: false, errors, auditIssue };
}

// Pure. Appends `extra` as new lines at the end of the `### <label>` block of an issue body.
export function appendToFormBlock(body, label, extra) {
  const lines = normalizeEol(body).split("\n");
  const idx = lines.findIndex((l) => l.trim() === `### ${label}`);
  if (idx === -1) return null;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("### ")) {
      end = i;
      break;
    }
  }
  let insertAt = end;
  while (insertAt > idx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, "", ...extra.split("\n"));
  return lines.join("\n");
}

// Pure. The replacement Audit Issue body: the predecessor's own canonical body, unchanged except
// (1) Verdict reset to PENDING and (2) one provenance block appended to the "Stage 1 inline review
// disposition" field. The block carries both the evidence-recovery marker
// (parseEvidenceRecoveryRef — bounds the lineage) and the established correction-chain phrase
// (parseCorrectsAuditRef — lets close-audit retire this preserved predecessor on a backed CLEAN).
export function composeReplacementAuditBody(predecessorBody, { predecessor, workIssue, mergeCommit, resultUrl, checklistCorrection = null }) {
  if (checklistCorrection) {
    // Issue #1005: corrected-checklist variant. Same marker/phrases (lineage bound, supersession and
    // correction-chain retirement are unchanged); the only content change is the one proven-stale SHA
    // replaced by the merge's actual first parent inside the Verification checklist field.
    const note =
      `Evidence-recovery re-audit of audit issue #${predecessor} (issue #1005, corrected-checklist variant): the prior Stage 2 ` +
      `NOT CLEAN verdict on issue #${predecessor} reported that its mandatory change-scope check used base ` +
      `${checklistCorrection.staleBase}, which is not exact merge commit ${mergeCommit}'s first parent ` +
      `${checklistCorrection.firstParent}. No source changed since the exact merge; this fresh audit's Verification checklist ` +
      `replaces only that base SHA with the first parent and is otherwise identical. The completed report is ${resultUrl}. ` +
      `This is the single permitted evidence-recovery re-audit for this exact PR/work/merge lineage, and it must render its ` +
      `own independent verdict. #${predecessor} and its report are preserved unchanged as historical evidence.`;
    const corrected = replaceChecklistField(
      predecessorBody,
      substituteScopeBase(parseVerificationChecklistRef(predecessorBody) ?? "", checklistCorrection.staleBase, checklistCorrection.firstParent),
    );
    if (corrected === null) return null;
    const withNote = appendToFormBlock(corrected, "Stage 1 inline review disposition", note);
    if (withNote === null) return null;
    return replaceVerdictField(withNote, "PENDING");
  }
  const provenance =
    `Evidence-recovery re-audit of audit issue #${predecessor} (issue #883): the prior Stage 2 NOT CLEAN verdict on ` +
    `issue #${predecessor} was satisfied by evidence alone, with no source change since exact merge commit ` +
    `${mergeCommit}. The recorded evidence correction is ${resultUrl} on work issue #${workIssue}. This is the single ` +
    `permitted evidence-recovery re-audit for this exact PR/work/merge lineage. #${predecessor} and its report are ` +
    `preserved unchanged as historical evidence.`;
  const withProvenance = appendToFormBlock(predecessorBody, "Stage 1 inline review disposition", provenance);
  if (withProvenance === null) return null;
  return replaceVerdictField(withProvenance, "PENDING");
}

// -- Default IO (REST only; every member injectable) ---------------------------------------------

function ghGet(path) {
  const raw = execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(raw);
}

function ghPost(path, payload) {
  const raw = execFileSync("gh", ["api", "-X", "POST", path, "--input", "-"], {
    encoding: "utf8",
    input: JSON.stringify(payload),
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function listIssuesSince({ repo, since }) {
  const sinceMs = new Date(since).getTime();
  const out = [];
  for (let page = 1; page <= MAX_ISSUE_LIST_PAGES; page++) {
    const raw = execFileSync(
      "gh",
      ["api", `repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`],
      { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
    );
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) throw new Error("issue listing is not a JSON array");
    for (const item of items) {
      if (item.pull_request) continue;
      out.push({
        number: item.number,
        title: item.title,
        body: item.body ?? "",
        state: item.state === "open" ? "OPEN" : "CLOSED",
        createdAt: item.created_at,
        author: item.user?.login ?? null,
      });
    }
    if (items.length < 100) return out;
    if (new Date(items[items.length - 1].created_at).getTime() < sinceMs) return out;
  }
  throw new Error(`issue listing exceeded ${MAX_ISSUE_LIST_PAGES} pages without reaching ${since} -- refusing to treat it as exhaustive`);
}

function listPrFiles({ repo, number }) {
  const raw = execFileSync("gh", ["api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/files?per_page=100`], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return JSON.parse(raw).flat().map((f) => f.filename);
}

export const defaultIo = {
  ghApi: (path) => defaultGhApi(path),
  ghGet: (path) => ghGet(path),
  ghPost: (path, payload) => ghPost(path, payload),
  readPr: ({ repo, number }) => readGithubPr({ repo, number, fields: ["state", "mergeCommit", "mergedAt"] }),
  listOpenPrs: ({ repo }) => defaultGhOpenPrList({ repo }),
  listIssuesSince: (args) => listIssuesSince(args),
  // Issue #1005: exact-merge topology and the PR's own file list, for the checklist-baseline proof.
  readCommit: ({ repo, sha }) => defaultReadCommit({ repo, sha }),
  listPrFiles: ({ repo, number }) => listPrFiles({ repo, number }),
};

export async function readIssueRest(io, repo, number) {
  const payload = await io.ghGet(`repos/${repo}/issues/${number}`);
  if (!payload || Number(payload.number) !== Number(number) || payload.pull_request) {
    throw new Error(`REST response for ${repo}#${number} is not that Issue`);
  }
  return {
    number: payload.number,
    host: hostOf(payload.html_url),
    body: normalizeEol(payload.body ?? ""),
    state: payload.state === "open" ? "OPEN" : "CLOSED",
    createdAt: payload.created_at,
    author: payload.user?.login ?? null,
  };
}

// -- Issue #1005: corrected-checklist baseline proof ---------------------------------------------
//
// A recorded NOT CLEAN whose only finding is that the audit's own mandatory change-scope command
// used a stale base (live: Audit #1004, PR #958) is not a source defect and not missing evidence;
// cloning the unchanged checklist (the #883 route) would hand a fresh reviewer the same impossible
// check. The authority to correct it is purely deterministic -- no executor claim, no keyword
// parsing of reviewer prose -- and every condition below is re-derived from GitHub:
//   1. the predecessor checklist's `git diff <base> <exact merge>` has exactly one distinct
//      full-SHA base and it is not the merge commit's actual first parent (scope-baseline.mjs);
//   2. the merge's own changed-file list (first parent -> merge) is complete and equals the merged
//      PR's file list, so the truthful range really isolates the PR;
//   3. the backed NOT CLEAN report itself names both the stale base and the true first parent and
//      its severity table totals exactly one finding of P2/P3 severity (no P0/P1, nothing else);
//   4. the mechanical substitution of that one SHA inside the checklist field alone yields a
//      checklist whose scope baseline verifies OK.

const SEVERITY_ROW = /^\s*\|\s*(P[0-3])\s*\|\s*(\d+)\s*\|\s*$/gim;

// Pure. Returns { P0, P1, P2, P3 } counts from the report's severity table, or null if not exactly
// all four rows are present.
export function parseSeverityCounts(reportText) {
  const counts = {};
  for (const m of normalizeEol(reportText).matchAll(SEVERITY_ROW)) {
    if (counts[m[1].toUpperCase()] !== undefined) return null;
    counts[m[1].toUpperCase()] = Number(m[2]);
  }
  return ["P0", "P1", "P2", "P3"].every((k) => Number.isInteger(counts[k])) ? counts : null;
}

// Pure. Replaces the "Verification checklist" field's text with `replacement`, touching nothing else.
export function replaceChecklistField(body, replacement) {
  const block = parseFormFieldBlock(body, "Verification checklist");
  if (block === null) return null;
  const headingIdx = body.indexOf("### Verification checklist");
  const at = headingIdx === -1 ? -1 : body.indexOf(block, headingIdx);
  if (at === -1) return null;
  return body.slice(0, at) + replacement + body.slice(at + block.length);
}

// Re-derives the checklist-baseline proof. Never throws on a read failure: unprovable => not proven.
async function proveChecklistBaselineCorrection(io, { repo, pr, body, mergeCommit, reportComment }) {
  const no = (reason) => ({ proven: false, reason });
  const checklist = parseVerificationChecklistRef(body);
  if (!checklist) return no("audit has no verification checklist");
  if (typeof io.readCommit !== "function" || typeof io.listPrFiles !== "function") return no("topology readers unavailable");
  let commit;
  let prFiles;
  try {
    commit = await io.readCommit({ repo, sha: mergeCommit });
    prFiles = await io.listPrFiles({ repo, number: pr });
  } catch (err) {
    return no(`could not read merge topology or PR files: ${err.message}`);
  }
  const scope = checkScopeBaseline({ checklist, mergeCommit, commit });
  if (scope.state !== ScopeState.STALE_SCOPE_BASELINE) return no(`checklist scope baseline state is ${scope.state}, not a stale full-SHA base`);
  if (scope.offending.some((o) => !FULL_SHA.test(o.base))) return no("a non-SHA scope base is present alongside the stale one");
  const stale = [...new Set(scope.offending.map((o) => o.base.toLowerCase()))];
  if (stale.length !== 1) return no("more than one distinct stale scope base");
  const staleBase = stale[0];
  const firstParent = scope.firstParent;
  const files = scope.files;
  const prSorted = Array.isArray(prFiles) ? [...prFiles].sort() : null;
  if (!files || !prSorted || files.length === 0 || files.length !== prSorted.length || files.some((f, i) => f !== prSorted[i])) {
    return no("the merge's first-parent change list is incomplete or does not equal the merged PR's file list");
  }
  const reportText = normalizeEol(reportComment?.body ?? "").toLowerCase();
  if (!reportText.includes(staleBase) || !reportText.includes(firstParent)) {
    return no("the independent NOT CLEAN report does not name both the stale base and the merge's true first parent");
  }
  const sev = parseSeverityCounts(reportComment?.body ?? "");
  if (!sev || sev.P0 !== 0 || sev.P1 !== 0 || sev.P2 + sev.P3 !== 1) {
    return no("the NOT CLEAN report's severity table is not exactly one P2/P3 finding with no P0/P1");
  }
  const corrected = substituteScopeBase(checklist, staleBase, firstParent);
  const after = checkScopeBaseline({ checklist: corrected, mergeCommit, commit });
  if (after.state !== ScopeState.OK) return no("the mechanically corrected checklist still fails the scope baseline");
  return { proven: true, staleBase, firstParent, correctedChecklist: corrected, files };
}

// -- Evaluation ---------------------------------------------------------------------------------

const refuse = (status, reason, extra = {}) => ({ status, reason, ...extra });

export function parseMergedPrNumber(body) {
  const block = parseFormFieldBlock(body, "Merged PR");
  if (!block) return null;
  const m = /\/pull\/(\d+)\b/.exec(block) ?? /#(\d+)\b/.exec(block);
  return m ? Number(m[1]) : null;
}

// Verifies one cited evidence comment against the trust/ordering rules. Returns null when valid,
// else the reason it is not.
async function verifyEvidenceComment(io, { repo, url, trustedLogin, afterMs, workIssue, host }) {
  const m = commentUrlPattern(host).exec(url);
  if (!m || m[1].toLowerCase() !== repo.toLowerCase()) return `${url} is not an issue-comment URL in ${repo}`;
  let comment;
  try {
    comment = await io.ghGet(`repos/${repo}/issues/comments/${m[3]}`);
  } catch (err) {
    return `${url} could not be read: ${err.message}`;
  }
  if (!comment || String(comment.id) !== m[3]) return `${url} did not resolve to that comment`;
  const issueNumber = /\/issues\/(\d+)$/.exec(String(comment.issue_url ?? ""))?.[1];
  if (issueNumber !== m[2]) return `${url} belongs to a different Issue than its URL names`;
  if (String(workIssue) !== issueNumber) return `${url} is not on the authoritative work Issue #${workIssue}`;
  if (comment.user?.login !== trustedLogin) {
    return `${url} is authored by ${JSON.stringify(comment.user?.login ?? null)}, not the audit's controlling account ${JSON.stringify(trustedLogin)}`;
  }
  if (!(new Date(comment.created_at).getTime() > afterMs)) return `${url} predates the NOT CLEAN report it is meant to answer`;
  return null;
}

// Independently re-derives the evidence-correction state for `auditIssue` from GitHub state alone.
export async function evaluateEvidenceCorrection({ repo, auditIssue }, io = defaultIo, { bot = DEFAULT_BOT } = {}) {
  const audit = await readIssueRest(io, repo, auditIssue);
  const body = audit.body;
  if (!hasCanonicalAuditShape(body)) return refuse(Status.NOT_ELIGIBLE, "audit issue lacks the complete canonical Stage 2 audit shape");
  if (parseStage2Verdict(body) !== "NOT CLEAN") return refuse(Status.NOT_ELIGIBLE, "audit issue's durable Verdict is not a recorded NOT CLEAN");
  const workIssue = parseWorkIssueRef(body);
  if (!isPositiveInteger(workIssue)) return refuse(Status.NOT_ELIGIBLE, "audit issue names no work/execution Issue to carry the evidence correction");
  const mergeCommit = parseMergeCommitRef(body);
  if (!mergeCommit || !FULL_SHA.test(mergeCommit)) return refuse(Status.NOT_ELIGIBLE, "audit issue's exact merge commit is not a full 40-hex commit id");
  const pr = parseMergedPrNumber(body);
  if (!isPositiveInteger(pr)) return refuse(Status.NOT_ELIGIBLE, "audit issue's Merged PR field names no PR number");
  if (parseEvidenceRecoveryRef(body) !== null) {
    return refuse(
      Status.NOT_ELIGIBLE,
      "this audit is itself an evidence-recovery re-audit; one evidence-recovery re-audit per exact PR/work/merge lineage is the bound",
    );
  }
  if (!audit.author) return refuse(Status.AMBIGUOUS, "audit issue's author could not be determined");

  const prView = await io.readPr({ repo, number: pr });
  if (prView?.state !== "MERGED" || String(prView.mergeCommit?.oid ?? "").toLowerCase() !== mergeCommit.toLowerCase()) {
    return refuse(Status.NOT_ELIGIBLE, `PR #${pr} is not MERGED at the audited exact merge commit ${mergeCommit}`);
  }
  const openPrs = findOpenExecutionLinkedPr(await io.listOpenPrs({ repo }), workIssue);
  if (openPrs) {
    return refuse(Status.NOT_ELIGIBLE, `open execution-linked PR #${openPrs.number} exists: a source correction is already underway`);
  }

  const auditComments = await io.ghApi(`repos/${repo}/issues/${auditIssue}/comments`);
  const reportEvidence = await findStage2ReportEvidence(
    {
      repo,
      auditIssue,
      bot,
      mergeCommit,
      requestedChecklist: parseVerificationChecklistRef(body),
      reviewedHeadCommit: parseReviewedHeadCommitRef(body),
    },
    async () => auditComments,
  );
  if (!reportEvidence.backed || reportEvidence.verdict !== "NOT CLEAN" || !reportEvidence.matchedCommentUrl) {
    return refuse(Status.NOT_ELIGIBLE, "no backed completed Stage 2 NOT CLEAN report was found on the audit thread");
  }
  const reportUrl = reportEvidence.matchedCommentUrl;
  const reportComment = auditComments.find((c) => c.html_url === reportUrl);
  const reportMs = new Date(reportComment?.created_at ?? NaN).getTime();
  if (!Number.isFinite(reportMs)) return refuse(Status.AMBIGUOUS, "the NOT CLEAN report comment's timestamp could not be determined");

  // Lineage bound + replacement discovery over every Issue created since the PR merged (an audit
  // of this exact merge cannot predate it). REST listing, never the Search API.
  const recent = await io.listIssuesSince({ repo, since: prView.mergedAt ?? audit.createdAt });
  const sameTarget = recent.filter((c) => {
    if (Number(c.number) === Number(auditIssue)) return false;
    if (!hasCanonicalAuditShape(c.body ?? "")) return false;
    // Only the audit's own controlling account can author a candidate that counts as lineage
    // authority; an untrusted copy of the canonical headings is ignored here (and later fails closed
    // in the finalize-time uniqueness revalidation if it duplicates the real one).
    if (c.author !== audit.author) return false;
    const cm = parseMergeCommitRef(c.body ?? "");
    return cm && cm.toLowerCase() === mergeCommit.toLowerCase() && parseWorkIssueRef(c.body ?? "") === workIssue;
  });
  const recoveryAudits = sameTarget.filter((c) => parseEvidenceRecoveryRef(c.body ?? "") !== null);
  const foreign = recoveryAudits.filter((c) => parseEvidenceRecoveryRef(c.body ?? "") !== Number(auditIssue));
  if (foreign.length > 0) {
    return refuse(
      Status.NOT_ELIGIBLE,
      `this PR/work/merge lineage already holds evidence-recovery re-audit(s) ${foreign.map((c) => `#${c.number}`).join(", ")} ` +
        "of a different predecessor; the one-re-audit-per-lineage bound is exhausted",
    );
  }
  const replacements = recoveryAudits;
  if (replacements.length > 1) {
    return refuse(Status.AMBIGUOUS, `more than one evidence-recovery re-audit names #${auditIssue}: ${replacements.map((c) => `#${c.number}`).join(", ")}`);
  }

  // Result comment(s) for THIS audit on the authoritative work Issue; the latest governs.
  const workComments = await io.ghApi(`repos/${repo}/issues/${workIssue}/comments`);
  const ours = [];
  for (const comment of workComments) {
    const text = normalizeEol(comment.body ?? "").trim();
    if (!text.startsWith(RESULT_HEADING)) continue;
    const parsed = parseEvidenceCorrectionResult(text, { host: audit.host });
    const namedAudit = parsed.ok ? parsed.fields.auditIssue : parsed.auditIssue;
    if (namedAudit !== Number(auditIssue)) continue;
    ours.push({ comment, parsed });
  }
  ours.sort((a, b) => new Date(a.comment.created_at).getTime() - new Date(b.comment.created_at).getTime());
  const latest = ours.at(-1);
  const replacement = replacements[0] ?? null;
  // reportBodyHash binds the matched report's content (a same-permalink edit changes it);
  // replacementNumber exposes the re-audit lineage even on early INCOMPLETE returns.
  const base = {
    auditIssue: Number(auditIssue), workIssue, pr, mergeCommit, reportUrl, trustedLogin: audit.author, auditBodyHash: sha256(body),
    reportBodyHash: sha256(reportComment?.body ?? ""), replacementNumber: replacement ? Number(replacement.number) : null, host: audit.host,
  };

  if (!latest) {
    // Issue #1005: no recorded evidence result -- but a recorded NOT CLEAN whose sole finding is a
    // demonstrably stale audit-checklist scope baseline is satisfied by deterministic proof alone.
    const checklist = await proveChecklistBaselineCorrection(io, { repo, pr, body, mergeCommit, reportComment });
    if (checklist.proven) {
      return finishSatisfied({
        resultUrl: reportUrl,
        resultAtMs: reportMs,
        checklistCorrection: { staleBase: checklist.staleBase, firstParent: checklist.firstParent },
        correctedChecklist: checklist.correctedChecklist,
      });
    }
    if (replacement) {
      return refuse(
        Status.AMBIGUOUS,
        `re-audit #${replacement.number} already names #${auditIssue} but no result comment for it exists on work issue #${workIssue}`,
        base,
      );
    }
    return { status: Status.NO_RESULT, reason: "no evidence-correction result recorded on the work issue", ...base };
  }

  const { comment, parsed } = latest;
  if (!parsed.ok) return refuse(Status.INCOMPLETE, `latest result comment is malformed: ${parsed.errors.join("; ")}`, base);
  const f = parsed.fields;
  if (f.workIssue !== workIssue || f.pr !== pr || f.mergeCommit.toLowerCase() !== mergeCommit.toLowerCase() || f.findingUrl !== reportUrl) {
    return refuse(
      Status.PROVENANCE_MISMATCH,
      "result comment's PR/work/merge/finding identity does not match the audit it names",
      base,
    );
  }
  if (f.classification !== "EVIDENCE_ONLY" || f.sourceChanged !== "none" || f.disposition !== "SATISFIED") {
    return refuse(Status.INCOMPLETE, "result comment does not record Classification EVIDENCE_ONLY, Source changed none, Disposition SATISFIED", base);
  }
  if (comment.user?.login !== audit.author) {
    return refuse(
      Status.INCOMPLETE,
      `result comment is authored by ${JSON.stringify(comment.user?.login ?? null)}, not the audit's controlling account ${JSON.stringify(audit.author)}`,
      base,
    );
  }
  if (!(new Date(comment.created_at).getTime() > reportMs)) {
    return refuse(Status.INCOMPLETE, "result comment predates the NOT CLEAN report it claims to answer", base);
  }
  for (const url of f.evidenceUrls) {
    const problem = await verifyEvidenceComment(io, { repo, url, trustedLogin: audit.author, afterMs: reportMs, workIssue, host: audit.host });
    if (problem) return refuse(Status.INCOMPLETE, `evidence not verified: ${problem}`, base);
  }

  return finishSatisfied({ resultUrl: comment.html_url, resultAtMs: new Date(comment.created_at).getTime() });

  // Shared tail for both satisfied routes (recorded evidence result, or issue #1005 deterministic
  // checklist-baseline proof). The single re-audit must cite the satisfying artifact and postdate it.
  function finishSatisfied({ resultUrl, resultAtMs, checklistCorrection = null, correctedChecklist = null }) {
    const extra = checklistCorrection ? { checklistCorrection, correctedChecklist } : {};
    if (!replacement) return { status: Status.SATISFIED, reason: "evidence correction durably satisfied", resultUrl, replacement: null, ...extra, ...base };

    if (replacement.state !== "OPEN") {
      return refuse(Status.AMBIGUOUS, `re-audit #${replacement.number} exists but is ${replacement.state}`, { ...base, resultUrl, ...extra });
    }
    // Bind the replacement's provenance to THIS verified result: it must cite it and have been created after it.
    if (!String(replacement.body ?? "").includes(resultUrl) || !(new Date(replacement.createdAt).getTime() > resultAtMs)) {
      return refuse(
        Status.AMBIGUOUS,
        `re-audit #${replacement.number} is not bound to the verified evidence result ${resultUrl} (it must cite it and postdate it)`,
        { ...base, resultUrl, ...extra },
      );
    }
    if (checklistCorrection) {
      // The checklist-correction replacement must carry exactly the mechanically corrected checklist
      // and name the same PR; anything else is not the one authorized corrected successor.
      if (parseMergedPrNumber(replacement.body ?? "") !== pr) {
        return refuse(Status.AMBIGUOUS, `re-audit #${replacement.number}'s Merged PR field does not name PR #${pr}`, { ...base, resultUrl, ...extra });
      }
      if (parseVerificationChecklistRef(replacement.body ?? "") !== correctedChecklist) {
        return refuse(
          Status.AMBIGUOUS,
          `re-audit #${replacement.number}'s verification checklist is not exactly the mechanically corrected checklist`,
          { ...base, resultUrl, ...extra },
        );
      }
    }
    return {
      status: Status.SATISFIED,
      reason: "evidence correction durably satisfied; its single re-audit already exists",
      resultUrl,
      replacement: {
        number: Number(replacement.number),
        state: replacement.state,
        pending: checkPreAuditPendingState(replacement.body ?? "").ok,
      },
      ...extra,
      ...base,
    };
  }
}

// -- Subcommands --------------------------------------------------------------------------------

function exitFor(status) {
  return status === Status.SATISFIED ? 0 : 2;
}

export async function runVerify({ repo, auditIssue }, io = defaultIo) {
  const result = await evaluateEvidenceCorrection({ repo, auditIssue }, io);
  const state = result.status === Status.SATISFIED ? "EVIDENCE_SATISFIED" : `EVIDENCE_${result.status}`;
  return { exitCode: exitFor(result.status), state, ...result };
}

export async function runRecord({ repo, auditIssue, evidence }, io = defaultIo) {
  const urls = (evidence ?? []).map((u) => String(u).trim()).filter(Boolean);
  const before = await evaluateEvidenceCorrection({ repo, auditIssue }, io);
  if (before.status === Status.SATISFIED) return { exitCode: 0, state: "EVIDENCE_RECORDED", alreadyRecorded: true, ...before };
  if (before.status !== Status.NO_RESULT && before.status !== Status.INCOMPLETE) {
    return { exitCode: 2, state: `EVIDENCE_${before.status}`, ...before };
  }
  if (urls.length === 0) return { exitCode: 2, state: "EVIDENCE_NOT_SATISFIED", ...before, reason: "no --evidence comment URL supplied" };

  // Verify every cited comment BEFORE posting, so a bad citation never becomes durable.
  const reportMs = new Date(
    (await io.ghApi(`repos/${repo}/issues/${auditIssue}/comments`)).find((c) => c.html_url === before.reportUrl)?.created_at ?? NaN,
  ).getTime();
  for (const url of urls) {
    const problem = await verifyEvidenceComment(io, { repo, url, trustedLogin: before.trustedLogin, afterMs: reportMs, workIssue: before.workIssue, host: before.host });
    if (problem) return { exitCode: 2, state: "EVIDENCE_NOT_SATISFIED", ...before, reason: `evidence not verified: ${problem}` };
  }
  const commentBody = formatEvidenceCorrectionResult({
    auditIssue: Number(auditIssue),
    workIssue: before.workIssue,
    pr: before.pr,
    mergeCommit: before.mergeCommit,
    findingUrl: before.reportUrl,
    evidenceUrls: urls,
  });
  // Re-prove the complete authority and lineage immediately before the durable mutation: a posted
  // result cannot be retracted by the later (fail-closed) evaluation, so a stale decision must never
  // reach the POST. Same audit/work/PR/merge/report identity, unchanged audit body, no correction PR
  // and an unspent re-audit allowance (the evaluator reports each of those as a non-recordable status).
  const fresh = await evaluateEvidenceCorrection({ repo, auditIssue }, io);
  const authorityKeys = ["auditIssue", "workIssue", "pr", "mergeCommit", "reportUrl", "trustedLogin", "auditBodyHash", "reportBodyHash"];
  const sameBase = authorityKeys.every((k) => fresh[k] === before[k]);
  // Another authorized invocation already recorded and the evaluator independently verified it for
  // the unchanged authority: converge idempotently, never POST a duplicate.
  if (fresh.status === Status.SATISFIED && sameBase) return { exitCode: 0, state: "EVIDENCE_RECORDED", alreadyRecorded: true, ...fresh };
  const recordable = fresh.status === Status.NO_RESULT || fresh.status === Status.INCOMPLETE;
  const sameAuthority = recordable && sameBase && fresh.replacementNumber === null && before.replacementNumber === null;
  if (!sameAuthority) {
    return {
      exitCode: 2,
      state: "EVIDENCE_AMBIGUOUS",
      auditIssue: Number(auditIssue),
      reason: `authority changed before the evidence-correction result could be posted (${fresh.status}: ${fresh.reason}); nothing was posted`,
    };
  }
  const posted = await io.ghPost(`repos/${repo}/issues/${before.workIssue}/comments`, { body: commentBody });
  if (!String(posted?.html_url ?? "").toLowerCase().includes(`/${repo}/issues/${before.workIssue}#issuecomment-`.toLowerCase())) {
    return { exitCode: 1, message: `result comment POST response identity does not match ${repo}#${before.workIssue}` };
  }
  const after = await evaluateEvidenceCorrection({ repo, auditIssue }, io);
  if (after.status !== Status.SATISFIED) return { exitCode: 2, state: `EVIDENCE_${after.status}`, ...after };
  return { exitCode: 0, state: "EVIDENCE_RECORDED", ...after };
}

export async function runPrepare({ repo, auditIssue, dryRun = false }, io = defaultIo) {
  const evaluated = await evaluateEvidenceCorrection({ repo, auditIssue }, io);
  if (evaluated.status !== Status.SATISFIED) {
    return { exitCode: 2, state: `EVIDENCE_${evaluated.status}`, ...evaluated };
  }
  if (evaluated.replacement) {
    return {
      exitCode: 0,
      state: "REAUDIT_ALREADY_PREPARED",
      auditIssue: Number(auditIssue),
      replacementAuditIssue: evaluated.replacement.number,
      message: `REAUDIT_ALREADY_PREPARED ${evaluated.replacement.number}`,
    };
  }
  const predecessor = await readIssueRest(io, repo, auditIssue);
  // Issue #883 Stage 1 correction: the predecessor must be exactly the body the evaluation proved
  // authority from; an edit between evaluation and cloning fails closed rather than mixing authority.
  if (sha256(predecessor.body) !== evaluated.auditBodyHash) {
    return {
      exitCode: 2,
      state: "EVIDENCE_AMBIGUOUS",
      reason: `predecessor audit #${auditIssue} changed after the evidence correction was evaluated; refusing to clone mixed authority`,
      auditIssue: Number(auditIssue),
    };
  }
  const body = composeReplacementAuditBody(predecessor.body, {
    predecessor: Number(auditIssue),
    workIssue: evaluated.workIssue,
    mergeCommit: evaluated.mergeCommit,
    resultUrl: evaluated.resultUrl,
    checklistCorrection: evaluated.checklistCorrection ?? null,
  });
  const validate = (candidateBody) => {
    if (!candidateBody) return "body could not be composed";
    if (evaluated.checklistCorrection) {
      if (parseVerificationChecklistRef(candidateBody) !== evaluated.correctedChecklist) return "replacement body's checklist is not exactly the corrected checklist";
      if (parseMergedPrNumber(candidateBody) !== evaluated.pr) return "replacement body's merged PR drifted";
    }
    if (!hasCanonicalAuditShape(candidateBody)) return "replacement body lost the canonical Stage 2 audit shape";
    const pending = checkPreAuditPendingState(candidateBody);
    if (!pending.ok) return `replacement body is not in the canonical pre-audit pending state: ${pending.errors.join("; ")}`;
    if (parseEvidenceRecoveryRef(candidateBody) !== Number(auditIssue)) return "replacement body does not carry the evidence-recovery provenance marker";
    if (parseMergeCommitRef(candidateBody)?.toLowerCase() !== evaluated.mergeCommit.toLowerCase()) return "replacement body's exact merge commit drifted";
    if (parseWorkIssueRef(candidateBody) !== evaluated.workIssue) return "replacement body's work issue drifted";
    return null;
  };
  const problem = validate(body);
  if (problem) return { exitCode: 2, state: "EVIDENCE_AMBIGUOUS", reason: problem, auditIssue: Number(auditIssue) };
  const title = evaluated.checklistCorrection
    ? `[Audit] Corrected-checklist re-audit of PR #${evaluated.pr} (${evaluated.mergeCommit}) after Audit #${auditIssue} NOT CLEAN`
    : `[Audit] Evidence-recovery re-audit of PR #${evaluated.pr} (${evaluated.mergeCommit}) after Audit #${auditIssue} NOT CLEAN`;
  if (dryRun) return { exitCode: 0, state: "REAUDIT_DRY_RUN", auditIssue: Number(auditIssue), title, body };

  // Re-prove the whole lineage immediately before the mutation: still satisfied, still no
  // replacement, and the predecessor body is unchanged.
  const recheck = await evaluateEvidenceCorrection({ repo, auditIssue }, io);
  if (recheck.status !== Status.SATISFIED || recheck.replacement || recheck.auditBodyHash !== evaluated.auditBodyHash) {
    return {
      exitCode: 2,
      state: "EVIDENCE_AMBIGUOUS",
      reason: `lineage changed before the re-audit could be created (${recheck.status}: ${recheck.reason})`,
      auditIssue: Number(auditIssue),
    };
  }
  const created = await io.ghPost(`repos/${repo}/issues`, { title, body });
  const number = Number(created?.number);
  if (!isPositiveInteger(number) || created.pull_request) {
    return { exitCode: 1, message: "create-issue response did not identify a new Issue" };
  }
  const readBack = await readIssueRest(io, repo, number);
  const readBackProblem = validate(readBack.body);
  if (readBackProblem) {
    return { exitCode: 2, state: "EVIDENCE_AMBIGUOUS", reason: `created re-audit #${number} failed read-back: ${readBackProblem}`, auditIssue: Number(auditIssue), replacementAuditIssue: number };
  }
  // A concurrent preparer could have raced this creation; exactly one replacement may exist.
  const after = await evaluateEvidenceCorrection({ repo, auditIssue }, io);
  if (after.status !== Status.SATISFIED || after.replacement?.number !== number) {
    return {
      exitCode: 2,
      state: "EVIDENCE_AMBIGUOUS",
      reason: `after creating #${number}, the lineage no longer resolves to exactly that one re-audit (${after.status}: ${after.reason})`,
      auditIssue: Number(auditIssue),
      replacementAuditIssue: number,
    };
  }
  return {
    exitCode: 0,
    state: "REAUDIT_PREPARED",
    auditIssue: Number(auditIssue),
    replacementAuditIssue: number,
    message: `REAUDIT_PREPARED ${number}`,
  };
}

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  const args = parseCliArgs(rest);
  const auditIssue = Number(String(args["audit-issue"] ?? "").replace(/^#/, ""));
  if (!["verify", "record", "prepare"].includes(subcommand) || !isPositiveInteger(auditIssue)) {
    console.error("Usage: evidence-correction.mjs <verify|record|prepare> --audit-issue <N> [--repo owner/repo] [--evidence <urls>] [--dry-run true]");
    process.exit(1);
    return;
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
  let result;
  try {
    if (subcommand === "verify") result = await runVerify({ repo, auditIssue });
    else if (subcommand === "record") result = await runRecord({ repo, auditIssue, evidence: String(args.evidence ?? "").split(",") });
    else result = await runPrepare({ repo, auditIssue, dryRun: args["dry-run"] === "true" });
  } catch (err) {
    console.error(`evidence-correction.mjs ${subcommand} failed: ${err.message}`);
    process.exit(1);
    return;
  }
  if (result.exitCode === 1) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  const { exitCode, ...printable } = result;
  console.log(JSON.stringify(printable));
  process.exit(exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("evidence-correction.mjs")) {
  main();
}
