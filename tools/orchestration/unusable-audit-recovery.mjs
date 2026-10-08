#!/usr/bin/env node
// Bounded one-replacement recovery for a first unusable Stage 2 reviewer response — issue #985
// (control #867; clean restart of abandoned #868 / PR #869; live reproduction #859 / #860 /
// PR #865 / Audit #866).
//
// The gap: a genuine reviewer response that is not a completed Stage 2 report under the existing
// evidence contract (#230/#447) resolves to `STAGE2_RESPONSE_UNUSABLE`, a mode "none" founder
// interrupt with no authorized recovery action, even though the exact merge is audited and a fresh
// canonical audit of the same target would re-obtain independent assurance. Reusing or retriggering
// the unusable thread is forbidden (#259), and the parser must not be relaxed.
//
// This module is the deterministic half of the smallest recovery: create (or recover,
// idempotently) exactly ONE fresh canonical replacement Audit for the same repository / PR / work
// Issue / exact merge commit. The replacement is a clone of the predecessor's own canonical body
// (so the reviewer receives the unchanged canonical Stage 2 contract and checklist) with Verdict
// PENDING and one provenance block in "Stage 1 inline review disposition" naming the predecessor
// and the unusable response. The predecessor Audit, its trigger and its response are never edited,
// closed, retriggered or commented on. Projection onto the thin control Issue and the single
// reviewer trigger stay the existing finalize-audit-breakpoint.mjs (`--stale-audit-issue`) and
// trigger.mjs steps, composed by next-review-transition-gate.mjs.
//
// Bound (fail closed, never retry-until-CLEAN): an audit that is itself an unusable-response (or
// evidence-recovery) replacement is NOT_ELIGIBLE, as is any exact PR/work/merge lineage that already
// holds a replacement naming a different predecessor. A second unusable response therefore keeps the
// existing STAGE2_RESPONSE_UNUSABLE founder interrupt and never creates a third audit.
//
// Usage:
//   node tools/orchestration/unusable-audit-recovery.mjs verify  --audit-issue <A> [--repo <o/r>]
//   node tools/orchestration/unusable-audit-recovery.mjs prepare --audit-issue <A> [--repo <o/r>] [--dry-run true]
//
// Exit codes: 0 (ELIGIBLE / REPLACEMENT_PREPARED / REPLACEMENT_ALREADY_PREPARED / dry run),
// 1 (operational error), 2 (a fail-closed refusal: NOT_ELIGIBLE, AMBIGUOUS).
//
// Tests: node --test tools/orchestration/unusable-audit-recovery.test.mjs

import { createHash } from "node:crypto";
import { resolveRepoIdentity, referencesExecutionIssue, defaultGhPrList } from "./ready-dispatch-gate.mjs";
import {
  defaultIo,
  readIssueRest,
  appendToFormBlock,
  parseMergedPrNumber,
} from "./evidence-correction.mjs";
import {
  DEFAULT_BOT,
  findStage2ReportEvidence,
  hasCanonicalAuditShape,
  checkPreAuditPendingState,
  parseEvidenceRecoveryRef,
  parseUnusableReplacementRef,
  parseMergeCommitRef,
  parseStage2Verdict,
  parseVerificationChecklistRef,
  parseReviewedHeadCommitRef,
  parseWorkIssueRef,
  replaceVerdictField,
} from "../review-watch/lifecycle-gate.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/i;

export const Status = Object.freeze({
  NOT_ELIGIBLE: "NOT_ELIGIBLE",
  ELIGIBLE: "ELIGIBLE",
  REPLACEMENT_EXISTS: "REPLACEMENT_EXISTS",
  AMBIGUOUS: "AMBIGUOUS",
});

const isPositiveInteger = (v) => typeof v === "number" && Number.isInteger(v) && v > 0;
const sha256 = (t) => createHash("sha256").update(String(t ?? "")).digest("hex");
const refuse = (status, reason, extra = {}) => ({ status, reason, ...extra });

// Pure. The replacement Audit Issue body: the predecessor's own canonical body, unchanged except
// (1) Verdict reset to PENDING and (2) one provenance block appended to the "Stage 1 inline review
// disposition" field. The block carries the unusable-response marker (parseUnusableReplacementRef --
// bounds the lineage and supersedes the predecessor) and the established correction-chain phrase
// (parseCorrectsAuditRef -- lets close-audit retire the preserved predecessor on a backed CLEAN).
// It deliberately describes the failure only as provenance; it never prescribes a reply shape.
export function composeReplacementAuditBody(predecessorBody, { predecessor, workIssue, mergeCommit, responseUrl }) {
  const provenance =
    `Unusable-response replacement audit of audit issue #${predecessor} (issue #985): the first genuine reviewer ` +
    `response ${responseUrl} on audit issue #${predecessor} was not a completed Stage 2 audit report under the ` +
    `current evidence contract, so the prior Stage 2 PENDING verdict on issue #${predecessor} was never settled. ` +
    `This fresh audit targets the same exact merge commit ${mergeCommit} and work issue ` +
    `${workIssue === "none" ? "none" : `#${workIssue}`} and is the single permitted unusable-response replacement ` +
    `for this exact PR/work/merge target. #${predecessor}, its trigger and its response are preserved unchanged ` +
    "as historical evidence.";
  const withProvenance = appendToFormBlock(predecessorBody, "Stage 1 inline review disposition", provenance);
  if (withProvenance === null) return null;
  return replaceVerdictField(withProvenance, "PENDING");
}

// Issue #992: resuming an existing correction PR while a Stage 2 Audit is mechanically unusable
// (and therefore not a backed NOT CLEAN). Authority to mutate is never read from GitHub content --
// not a PR body's `Addresses #N`, not reviewer prose, and not even a trusted owner-authored comment
// (AGENTS.md § Execution authority boundary). It comes only from an explicit founder instruction,
// which the invoking session passes in as `resumeCorrectionPr`. This module only re-proves, from
// live GitHub state, that the founder-named PR is the one unambiguous candidate.
export function evaluateCorrectionResume({ auditIssue, workIssue, auditedPr, candidates, resumeCorrectionPr }) {
  const open = candidates.filter((p) => String(p?.state ?? "").toUpperCase() === "OPEN");
  const merged = candidates.filter((p) => String(p?.state ?? "").toUpperCase() === "MERGED" && Number(p.number) > Number(auditedPr));
  const pool = [...open, ...merged];
  const descriptor = (authority) => ({
    openNumbers: open.map((p) => Number(p.number)),
    mergedNumbers: merged.map((p) => Number(p.number)),
    candidateCount: pool.length,
    ...(pool.length === 1
      ? { number: Number(pool[0].number), state: String(pool[0].state).toUpperCase(), headRefOid: pool[0].headRefOid ?? null }
      : {}),
    authority,
  });
  if (pool.length !== 1) {
    return descriptor({
      proven: false,
      reason: `${pool.length} execution-linked correction PRs (open or merged after PR #${auditedPr}) reference #${workIssue}; exactly one is required, and none is resumed automatically`,
    });
  }
  const only = Number(pool[0].number);
  const resume = `founder decision: confirm PR #${only} is the intended correction of unusable audit #${auditIssue}, then re-run next-review-transition-gate.mjs with --resume-correction-pr ${only}`;
  if (resumeCorrectionPr === undefined || resumeCorrectionPr === null) {
    return descriptor({ proven: false, reason: `PR #${only} is linked to #${workIssue}, but no founder instruction authorizes resuming it`, resume });
  }
  if (Number(resumeCorrectionPr) !== only) {
    return descriptor({ proven: false, reason: `the founder-named PR #${resumeCorrectionPr} is not the single linked correction PR (#${only})`, resume });
  }
  return descriptor({ proven: true, reason: `explicit founder instruction names the single linked correction PR #${only} for unusable audit #${auditIssue}` });
}

// Independently re-derives the recovery state for `auditIssue` from GitHub state alone.
export async function evaluateUnusableRecovery({ repo, auditIssue, resumeCorrectionPr }, io = defaultIo, { bot = DEFAULT_BOT } = {}) {
  const audit = await readIssueRest(io, repo, auditIssue);
  const body = audit.body;
  if (!hasCanonicalAuditShape(body)) return refuse(Status.NOT_ELIGIBLE, "audit issue lacks the complete canonical Stage 2 audit shape");

  const priorUnusable = parseUnusableReplacementRef(body);
  const priorEvidence = parseEvidenceRecoveryRef(body);
  if (priorUnusable !== null || priorEvidence !== null) {
    return refuse(
      Status.NOT_ELIGIBLE,
      "this audit is itself a replacement audit; one replacement per exact PR/work/merge target is the bound, so a second " +
        "unusable response is a founder interrupt and never a third audit",
      { predecessorAuditIssue: priorUnusable ?? priorEvidence },
    );
  }
  const verdict = parseStage2Verdict(body);
  if (verdict !== "PENDING" && verdict !== null) {
    return refuse(Status.NOT_ELIGIBLE, `audit issue's durable Verdict is ${JSON.stringify(verdict)}, not an unsettled PENDING`);
  }
  if (audit.state !== "OPEN") return refuse(Status.NOT_ELIGIBLE, `audit issue is ${audit.state}, not OPEN`);
  const workIssue = parseWorkIssueRef(body);
  if (!(isPositiveInteger(workIssue) || workIssue === "none")) {
    return refuse(Status.NOT_ELIGIBLE, "audit issue's Work issue field names neither a work/execution Issue nor the explicit none state");
  }
  const mergeCommit = parseMergeCommitRef(body);
  if (!mergeCommit || !FULL_SHA.test(mergeCommit)) return refuse(Status.NOT_ELIGIBLE, "audit issue's exact merge commit is not a full 40-hex commit id");
  const pr = parseMergedPrNumber(body);
  if (!isPositiveInteger(pr)) return refuse(Status.NOT_ELIGIBLE, "audit issue's Merged PR field names no PR number");
  if (!audit.author) return refuse(Status.AMBIGUOUS, "audit issue's author could not be determined");

  const prView = await io.readPr({ repo, number: pr });
  if (prView?.state !== "MERGED" || String(prView.mergeCommit?.oid ?? "").toLowerCase() !== mergeCommit.toLowerCase()) {
    return refuse(Status.NOT_ELIGIBLE, `PR #${pr} is not MERGED at the audited exact merge commit ${mergeCommit}`);
  }
  if (isPositiveInteger(workIssue)) {
    // Open AND merged linked PRs: a correction that already merged must preempt a replacement of the
    // original merge, never be invisible to it (Stage 1 finding on PR #993).
    const listLinked = io.listLinkedPrs ?? (io === defaultIo ? (a) => defaultGhPrList(a) : null);
    const linked = listLinked ? await listLinked({ repo, executionIssue: workIssue }) : await io.listOpenPrs({ repo });
    const candidates = (Array.isArray(linked) ? linked : []).filter(
      (p) => referencesExecutionIssue(p ?? {}, workIssue) && Number(p.number) !== Number(pr),
    );
    const underway = candidates.filter((p) => {
      const st = String(p?.state ?? "").toUpperCase();
      return st === "OPEN" || (st === "MERGED" && Number(p.number) > Number(pr));
    });
    if (underway.length > 0) {
      const correctionPr = evaluateCorrectionResume({ auditIssue: Number(auditIssue), workIssue, auditedPr: pr, candidates: underway, resumeCorrectionPr });
      return refuse(Status.NOT_ELIGIBLE, `execution-linked correction PR(s) exist (${underway.map((p) => `#${p.number}`).join(", ")}): a source correction is already underway or merged`, {
        correctionPr,
        workIssue,
        pr,
        mergeCommit,
      });
    }
  }

  // The unusable evidence is re-proven from the audit thread itself, never taken from a caller.
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
  if (reportEvidence.backed || !reportEvidence.hasTrigger || !reportEvidence.hasUnusableGenuineResponse) {
    return refuse(Status.NOT_ELIGIBLE, "audit thread does not show a genuine but unusable reviewer response (it is waiting, unsent, or has a completed report)");
  }
  const responses = reportEvidence.genuineResponses ?? [];
  const latestResponse = responses.at(-1);
  const responseComment = auditComments.find((c) => String(c.id) === String(latestResponse?.id));
  const responseMs = new Date(responseComment?.created_at ?? NaN).getTime();
  if (!latestResponse?.url || !Number.isFinite(responseMs)) {
    return refuse(Status.AMBIGUOUS, "the unusable reviewer response's identity or timestamp could not be determined");
  }
  const responseUrl = latestResponse.url;

  // Lineage bound + replacement discovery over every Issue created since the PR merged (an audit of
  // this exact merge cannot predate it). REST listing, never the Search API.
  const recent = await io.listIssuesSince({ repo, since: prView.mergedAt ?? audit.createdAt });
  const sameTarget = recent.filter((c) => {
    if (Number(c.number) === Number(auditIssue)) return false;
    if (!hasCanonicalAuditShape(c.body ?? "")) return false;
    if (c.author !== audit.author) return false;
    const cm = parseMergeCommitRef(c.body ?? "");
    return cm && cm.toLowerCase() === mergeCommit.toLowerCase() && parseWorkIssueRef(c.body ?? "") === workIssue;
  });
  const replacementsByRef = (c) => parseUnusableReplacementRef(c.body ?? "");
  const foreign = sameTarget.filter((c) => replacementsByRef(c) !== null && replacementsByRef(c) !== Number(auditIssue));
  if (foreign.length > 0) {
    return refuse(
      Status.NOT_ELIGIBLE,
      `this PR/work/merge target already holds replacement audit(s) ${foreign.map((c) => `#${c.number}`).join(", ")} ` +
        "of a different predecessor; the one-replacement bound is exhausted",
    );
  }
  const unrelated = sameTarget.filter((c) => replacementsByRef(c) === null);
  if (unrelated.length > 0) {
    return refuse(
      Status.AMBIGUOUS,
      `other canonical audit(s) ${unrelated.map((c) => `#${c.number}`).join(", ")} already target this exact PR/work/merge; ` +
        "refusing to create or select a replacement against ambiguous lineage",
    );
  }
  const replacements = sameTarget;
  if (replacements.length > 1) {
    return refuse(Status.AMBIGUOUS, `more than one unusable-response replacement names #${auditIssue}: ${replacements.map((c) => `#${c.number}`).join(", ")}`);
  }

  const base = {
    auditIssue: Number(auditIssue),
    workIssue,
    pr,
    mergeCommit,
    responseUrl,
    trustedLogin: audit.author,
    auditBodyHash: sha256(body),
    responseBodyHash: sha256(responseComment?.body ?? ""),
    host: audit.host,
  };
  const replacement = replacements[0] ?? null;
  if (!replacement) return { status: Status.ELIGIBLE, reason: "first unusable response with no replacement yet", replacement: null, ...base };

  if (replacement.state !== "OPEN") {
    return refuse(Status.AMBIGUOUS, `replacement #${replacement.number} exists but is ${replacement.state}`, { ...base, replacementNumber: Number(replacement.number) });
  }
  // The adopted replacement must name the same PR as the audited target, not merely the same merge
  // commit and work Issue (a mismatched Merged PR field would otherwise be projected and triggered).
  if (parseMergedPrNumber(replacement.body ?? "") !== pr) {
    return refuse(
      Status.AMBIGUOUS,
      `replacement #${replacement.number}'s Merged PR field does not name PR #${pr}`,
      { ...base, replacementNumber: Number(replacement.number) },
    );
  }
  // Bind the replacement's provenance to THIS unusable response: it must cite it and postdate it.
  if (!String(replacement.body ?? "").includes(responseUrl) || !(new Date(replacement.createdAt).getTime() > responseMs)) {
    return refuse(
      Status.AMBIGUOUS,
      `replacement #${replacement.number} is not bound to the unusable response ${responseUrl} (it must cite it and postdate it)`,
      { ...base, replacementNumber: Number(replacement.number) },
    );
  }
  return {
    status: Status.REPLACEMENT_EXISTS,
    reason: "single replacement already exists",
    replacement: {
      number: Number(replacement.number),
      state: replacement.state,
      pending: checkPreAuditPendingState(replacement.body ?? "").ok,
    },
    ...base,
  };
}

export async function runVerify({ repo, auditIssue }, io = defaultIo) {
  const result = await evaluateUnusableRecovery({ repo, auditIssue }, io);
  const ok = result.status === Status.ELIGIBLE || result.status === Status.REPLACEMENT_EXISTS;
  return { exitCode: ok ? 0 : 2, state: `UNUSABLE_RECOVERY_${result.status}`, ...result };
}

export async function runPrepare({ repo, auditIssue, dryRun = false }, io = defaultIo) {
  const evaluated = await evaluateUnusableRecovery({ repo, auditIssue }, io);
  if (evaluated.status === Status.REPLACEMENT_EXISTS) {
    return {
      exitCode: 0,
      state: "REPLACEMENT_ALREADY_PREPARED",
      auditIssue: Number(auditIssue),
      replacementAuditIssue: evaluated.replacement.number,
      message: `REPLACEMENT_ALREADY_PREPARED ${evaluated.replacement.number}`,
    };
  }
  if (evaluated.status !== Status.ELIGIBLE) {
    return { exitCode: 2, state: `UNUSABLE_RECOVERY_${evaluated.status}`, ...evaluated };
  }
  const predecessor = await readIssueRest(io, repo, auditIssue);
  if (sha256(predecessor.body) !== evaluated.auditBodyHash) {
    return {
      exitCode: 2,
      state: "UNUSABLE_RECOVERY_AMBIGUOUS",
      reason: `predecessor audit #${auditIssue} changed after the unusable response was evaluated; refusing to clone mixed authority`,
      auditIssue: Number(auditIssue),
    };
  }
  const body = composeReplacementAuditBody(predecessor.body, {
    predecessor: Number(auditIssue),
    workIssue: evaluated.workIssue,
    mergeCommit: evaluated.mergeCommit,
    responseUrl: evaluated.responseUrl,
  });
  const validate = (candidateBody) => {
    if (!candidateBody) return "body could not be composed";
    if (!hasCanonicalAuditShape(candidateBody)) return "replacement body lost the canonical Stage 2 audit shape";
    const pending = checkPreAuditPendingState(candidateBody);
    if (!pending.ok) return `replacement body is not in the canonical pre-audit pending state: ${pending.errors.join("; ")}`;
    if (parseUnusableReplacementRef(candidateBody) !== Number(auditIssue)) return "replacement body does not carry the unusable-response provenance marker";
    if (parseMergeCommitRef(candidateBody)?.toLowerCase() !== evaluated.mergeCommit.toLowerCase()) return "replacement body's exact merge commit drifted";
    if (parseWorkIssueRef(candidateBody) !== evaluated.workIssue) return "replacement body's work issue drifted";
    if (parseMergedPrNumber(candidateBody) !== evaluated.pr) return "replacement body's merged PR drifted";
    return null;
  };
  const problem = validate(body);
  if (problem) return { exitCode: 2, state: "UNUSABLE_RECOVERY_AMBIGUOUS", reason: problem, auditIssue: Number(auditIssue) };
  const title = `[Audit] Unusable-response replacement audit of PR #${evaluated.pr} (${evaluated.mergeCommit}) after Audit #${auditIssue}`;
  if (dryRun) return { exitCode: 0, state: "REPLACEMENT_DRY_RUN", auditIssue: Number(auditIssue), title, body };

  // Re-prove the whole lineage immediately before the mutation.
  const recheck = await evaluateUnusableRecovery({ repo, auditIssue }, io);
  if (recheck.status !== Status.ELIGIBLE || recheck.auditBodyHash !== evaluated.auditBodyHash || recheck.responseUrl !== evaluated.responseUrl) {
    return {
      exitCode: 2,
      state: "UNUSABLE_RECOVERY_AMBIGUOUS",
      reason: `lineage changed before the replacement could be created (${recheck.status}: ${recheck.reason})`,
      auditIssue: Number(auditIssue),
    };
  }
  // The discovery/post-create trust predicate only recognizes issues authored by the audit's own
  // controlling account, so a different authorized account must not create the replacement.
  let viewerLogin = null;
  try {
    viewerLogin = (await io.ghGet("user"))?.login ?? null;
  } catch {
    viewerLogin = null;
  }
  if (!viewerLogin || viewerLogin !== evaluated.trustedLogin) {
    return {
      exitCode: 2,
      state: "UNUSABLE_RECOVERY_AMBIGUOUS",
      reason:
        `the current GitHub account ${JSON.stringify(viewerLogin)} is not the predecessor audit's controlling account ` +
        `${JSON.stringify(evaluated.trustedLogin)}; refusing to create a replacement that lineage discovery would not recognize`,
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
    return { exitCode: 2, state: "UNUSABLE_RECOVERY_AMBIGUOUS", reason: `created replacement #${number} failed read-back: ${readBackProblem}`, auditIssue: Number(auditIssue), replacementAuditIssue: number };
  }
  // A concurrent preparer could have raced this creation; exactly one replacement may exist.
  const after = await evaluateUnusableRecovery({ repo, auditIssue }, io);
  if (after.status !== Status.REPLACEMENT_EXISTS || after.replacement?.number !== number) {
    return {
      exitCode: 2,
      state: "UNUSABLE_RECOVERY_AMBIGUOUS",
      reason: `after creating #${number}, the lineage no longer resolves to exactly that one replacement (${after.status}: ${after.reason})`,
      auditIssue: Number(auditIssue),
      replacementAuditIssue: number,
    };
  }
  return {
    exitCode: 0,
    state: "REPLACEMENT_PREPARED",
    auditIssue: Number(auditIssue),
    replacementAuditIssue: number,
    message: `REPLACEMENT_PREPARED ${number}`,
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
  if (!["verify", "prepare"].includes(subcommand) || !isPositiveInteger(auditIssue)) {
    console.error("Usage: unusable-audit-recovery.mjs <verify|prepare> --audit-issue <N> [--repo owner/repo] [--dry-run true]");
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
    result = subcommand === "verify" ? await runVerify({ repo, auditIssue }) : await runPrepare({ repo, auditIssue, dryRun: args["dry-run"] === "true" });
  } catch (err) {
    console.error(`unusable-audit-recovery.mjs ${subcommand} failed: ${err.message}`);
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

if (process.argv[1] && process.argv[1].endsWith("unusable-audit-recovery.mjs")) {
  main();
}
