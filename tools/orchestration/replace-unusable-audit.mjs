#!/usr/bin/env node
// Bounded one-replacement recovery for a FIRST unusable Stage 2 response -- issue #868 (control
// #867, live #859 / #860 / PR #865 / Audit #866 reproduction).
//
// A Stage 2 reviewer replied genuinely (exact merge target, "CLEAN") but without the canonical
// numbered `## Verification` walk-through, so `stage2-report.mjs` correctly refuses it as a
// completed report and `next-review-transition-gate.mjs` reports STAGE2_RESPONSE_UNUSABLE -- with
// no authorized recovery, a routine founder interrupt. The recovery family (precedent: #446 -> #480,
// #425 -> #426) is replacement, never same-thread retriggering or coaching (#259) and never parser
// relaxation (#230): preserve the unusable audit untouched as historical evidence and start Stage 2
// over on a fresh thread for the SAME exact merge commit. This script is the one deterministic,
// idempotent mutating step of that recovery. It never edits, comments on, closes, or triggers the
// superseded audit, and it never posts a reviewer trigger at all: the replacement's single ordinary
// `@codex review` trigger is the next fresh gate invocation's STAGE2_TRIGGER_REQUIRED (the
// projection this script lands is what makes that verdict reachable, in the issue #561 order).
//
// What it does, every step re-derived from live GitHub state (never from caller claims):
//   1. verifies the control Issue's Execution/PR pointers, Lifecycle `AUDIT`, and that its Stage 2
//      pointer names the superseded audit (or, on a re-entry after projection, the replacement);
//   2. verifies the PR is MERGED and the superseded audit is an OPEN, canonical, still-pending audit
//      of that exact merge commit / work issue that is NOT itself a replacement (a replacement that
//      is also unusable is the bound's end: this script refuses, no third audit);
//   3. re-proves the audit really is RESPONSE_UNUSABLE through lifecycle-gate `checkPostAudit`;
//   4. scans for replacements with an immediately-consistent REST issue listing (never the search
//      index, whose lag would let a retry duplicate): none -> create exactly one; exactly one
//      well-formed -> reuse it; any competing/closed/wrong-predecessor claimant -> fail closed;
//   5. creates the replacement (body = the superseded audit's own body, byte-for-byte, behind a
//      leading `### Supersedes audit` / `#<predecessor>` provenance section -- the canonical audit
//      contract is otherwise unchanged and contains no response-shape guidance) and re-scans to prove
//      it is the sole replacement;
//   6. projects it onto the control Issue through `finalize-audit-breakpoint.mjs`'s own validated
//      compose-write-verify path with `--stale-audit-issue <superseded>`.
// Re-entry is idempotent at every boundary: before creation (creates), after creation but before
// projection (reuses, projects), after projection (a no-op re-finalize). Exit codes mirror
// finalize-audit-breakpoint.mjs: 0 REPLACEMENT_FINALIZED, 1 operational error, 2
// REPLACEMENT_UNVERIFIED (fail-closed refusal; a prior created replacement is reported, never
// silently abandoned or duplicated).
//
// Usage:
//   node tools/orchestration/replace-unusable-audit.mjs --control-issue 859 --execution-issue 860 \
//     --pr 865 --audit-issue 866
//
// Tests: node --test tools/orchestration/replace-unusable-audit.test.mjs

import { readGithubIssue, readGithubPr } from "./github-read.mjs";
import { resolveRepoIdentity, parseControlBullet, parseHeadingField } from "./ready-dispatch-gate.mjs";
import {
  run as finalizeAuditRun,
  verifyExecutionMatchesAudit,
  verifyControlPrMatches,
  verifyPrMerged,
  verifyAuditIssueMatches,
} from "./finalize-audit-breakpoint.mjs";
import {
  checkPostAudit,
  parseFormField,
  parseSupersedesAuditRef,
  classifyAuditReplacements,
  composeReplacementAuditBody,
  composeReplacementAuditTitle,
  ghRestCreateIssue,
  listIssuesCreatedSince,
} from "../review-watch/lifecycle-gate.mjs";

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function unverified({ controlIssue, executionIssue, pr, auditIssue, replacementAudit = null, reason }) {
  return {
    exitCode: 2,
    state: "REPLACEMENT_UNVERIFIED",
    controlIssue,
    executionIssue,
    pr,
    auditIssue,
    replacementAudit,
    reason,
    message: `REPLACEMENT_UNVERIFIED ${controlIssue} ${pr} ${auditIssue}`,
  };
}

export async function run(
  { repo, controlIssue, executionIssue, pr, auditIssue },
  {
    ghControlViewImpl = ({ repo: r, number }) => readGithubIssue({ repo: r, number, fields: ["body"] }),
    ghPrViewImpl = ({ repo: r, number }) => readGithubPr({ repo: r, number, fields: ["state", "mergeCommit"] }),
    ghAuditViewImpl = ({ repo: r, number }) => readGithubIssue({ repo: r, number, fields: ["body", "state", "createdAt", "title"] }),
    checkPostAuditImpl = checkPostAudit,
    listCandidatesImpl = listIssuesCreatedSince,
    createIssueImpl = ghRestCreateIssue,
    finalizeImpl = finalizeAuditRun,
  } = {},
) {
  if (!isPositiveInteger(controlIssue) || !isPositiveInteger(pr) || !isPositiveInteger(auditIssue)) {
    return { exitCode: 1, message: "Missing/invalid required args: --control-issue, --pr, and --audit-issue must all be positive integers." };
  }
  if (!(isPositiveInteger(executionIssue) || executionIssue === "none")) {
    return { exitCode: 1, message: 'Missing/invalid required arg: --execution-issue must be a positive integer, or the literal "none".' };
  }
  const id = { controlIssue, executionIssue, pr, auditIssue };

  let controlBody;
  try {
    controlBody = (await ghControlViewImpl({ repo, number: controlIssue })).body ?? "";
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo}#${controlIssue}: ${err.message}` };
  }
  const executionCheck = verifyExecutionMatchesAudit(controlBody, executionIssue);
  if (!executionCheck.ok) return unverified({ ...id, reason: executionCheck.reason });
  const prPointerCheck = verifyControlPrMatches(controlBody, pr);
  if (!prPointerCheck.ok) return unverified({ ...id, reason: prPointerCheck.reason });
  const lifecycle = (parseControlBullet(controlBody, "Lifecycle") ?? parseHeadingField(controlBody, "State") ?? "").trim();
  if (lifecycle !== "AUDIT") {
    return unverified({ ...id, reason: `control Issue's Lifecycle is ${JSON.stringify(lifecycle)}, not "AUDIT"` });
  }
  const stage2Pointer = (parseControlBullet(controlBody, "Stage 2") ?? "").trim();

  let prView;
  try {
    prView = await ghPrViewImpl({ repo, number: pr });
  } catch (err) {
    return unverified({ ...id, reason: `gh pr view failed for PR #${pr}: ${err.message}` });
  }
  const merged = verifyPrMerged(prView);
  if (!merged.ok) return unverified({ ...id, reason: merged.reason });

  let predecessor;
  try {
    predecessor = await ghAuditViewImpl({ repo, number: auditIssue });
  } catch (err) {
    return unverified({ ...id, reason: `gh issue view failed for Audit Issue #${auditIssue}: ${err.message}` });
  }
  const predecessorBody = predecessor.body ?? "";
  if (parseFormField(predecessorBody, "Supersedes audit") !== null) {
    return unverified({
      ...id,
      reason:
        `Audit #${auditIssue} is itself a replacement (it carries a "Supersedes audit" field): the one automatic ` +
        "replacement per exact target is exhausted -- no third audit is created",
    });
  }
  // Still-pending + OPEN + canonical shape + exact merge/work identity, via finalize's own check.
  const identity = verifyAuditIssueMatches(predecessor, { mergeCommitOid: merged.mergeCommitOid, executionIssue }, { requirePendingState: true });
  if (!identity.ok) return unverified({ ...id, reason: identity.reason });

  // Re-prove the response really is the unusable shape (never trust the caller's claim).
  let postAudit;
  try {
    postAudit = await checkPostAuditImpl({ repo, "audit-issue": String(auditIssue) });
  } catch (err) {
    return { exitCode: 1, message: `lifecycle-gate post-audit threw for ${repo}#${auditIssue}: ${err.message}` };
  }
  if (postAudit?.state !== "RESPONSE_UNUSABLE" || Number(postAudit.auditIssue) !== auditIssue) {
    return unverified({
      ...id,
      reason: `lifecycle-gate post-audit reports ${JSON.stringify(postAudit?.state ?? null)} for #${auditIssue}, not RESPONSE_UNUSABLE -- replacement is not authorized`,
    });
  }

  const classifyArgs = {
    predecessorNumber: auditIssue,
    predecessorCreatedAt: predecessor.createdAt,
    mergeCommitOid: merged.mergeCommitOid,
    executionIssue,
  };
  let candidates;
  try {
    candidates = await listCandidatesImpl({ repo, sinceIso: predecessor.createdAt });
  } catch (err) {
    return unverified({ ...id, reason: `replacement scan failed: ${err.message}` });
  }
  const existing = classifyAuditReplacements(candidates, classifyArgs);
  if (existing.kind === "AMBIGUOUS") {
    return unverified({ ...id, replacementAudit: existing.candidates?.[0] ?? null, reason: existing.reason });
  }

  let replacementAudit;
  let created = false;
  if (existing.kind === "FOUND") {
    replacementAudit = existing.auditIssue;
    if (stage2Pointer !== `#${auditIssue}` && stage2Pointer !== `#${replacementAudit}`) {
      return unverified({ ...id, replacementAudit, reason: `control Issue's Stage 2 pointer is ${JSON.stringify(stage2Pointer)}, neither the superseded #${auditIssue} nor its replacement #${replacementAudit}` });
    }
  } else {
    if (stage2Pointer !== `#${auditIssue}`) {
      return unverified({ ...id, reason: `control Issue's Stage 2 pointer is ${JSON.stringify(stage2Pointer)}, not the superseded #${auditIssue}; refusing to create a replacement` });
    }
    try {
      const made = await createIssueImpl({
        repo,
        title: composeReplacementAuditTitle(predecessor.title, auditIssue),
        body: composeReplacementAuditBody(predecessorBody, auditIssue),
      });
      replacementAudit = made.number;
      created = true;
    } catch (err) {
      return unverified({ ...id, reason: `creating the replacement Audit Issue failed (re-run to retry; the scan above found none): ${err.message}` });
    }
    // Prove the new issue is the sole replacement before anything is projected.
    let rescan;
    try {
      rescan = classifyAuditReplacements(await listCandidatesImpl({ repo, sinceIso: predecessor.createdAt }), classifyArgs);
    } catch (err) {
      return unverified({ ...id, replacementAudit, reason: `post-create replacement scan failed for created #${replacementAudit}: ${err.message}` });
    }
    if (rescan.kind !== "FOUND" || rescan.auditIssue !== replacementAudit) {
      return unverified({
        ...id,
        replacementAudit,
        reason: `after creating #${replacementAudit}, the replacement scan did not resolve it as the sole replacement (${rescan.kind}${rescan.reason ? `: ${rescan.reason}` : ""})`,
      });
    }
  }

  let finalized;
  try {
    finalized = await finalizeImpl({
      repo,
      controlIssue,
      executionIssue,
      pr,
      auditIssue: replacementAudit,
      revalidateUniqueness: false,
      staleAuditIssue: auditIssue,
    });
  } catch (err) {
    return unverified({ ...id, replacementAudit, reason: `finalize-audit-breakpoint threw: ${err.message}` });
  }
  if (finalized?.exitCode !== 0 || finalized?.state !== "FINALIZED") {
    return unverified({ ...id, replacementAudit, reason: `finalize-audit-breakpoint did not report FINALIZED (${JSON.stringify(finalized)})` });
  }

  return {
    exitCode: 0,
    state: "REPLACEMENT_FINALIZED",
    ...id,
    supersededAudit: auditIssue,
    replacementAudit,
    created,
    message: `REPLACEMENT_FINALIZED ${controlIssue} ${pr} ${auditIssue} ${replacementAudit}`,
  };
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
  const rawExecution = args["execution-issue"];
  const result = await run({
    repo,
    controlIssue: args["control-issue"] != null ? Number(args["control-issue"]) : null,
    executionIssue: rawExecution === "none" ? "none" : rawExecution != null ? Number(rawExecution) : null,
    pr: args.pr != null ? Number(args.pr) : null,
    auditIssue: args["audit-issue"] != null ? Number(args["audit-issue"]) : null,
  });
  if (result.exitCode === 1) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  console.error(JSON.stringify(result));
  console.log(result.message);
  process.exit(result.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("replace-unusable-audit.mjs")) {
  main();
}
