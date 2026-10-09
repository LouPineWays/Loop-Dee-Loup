#!/usr/bin/env node
// Issue #740 (the live #691/#737/PR #738/Audit #739 reproduction): a Stage 2 preparation worker
// persisted the pre-merge corrected/control-plane-CI head `bd4a32c...` into the Audit Issue's
// "Exact merge commit" field instead of PR #738's real merge commit `5d588a5...`, then reported
// `AUDIT_READY #739` from its own belief rather than from a deterministic check. The two
// identities are distinct on purpose: the merge commit binds the audit to the merged state, and
// the pre-merge head (stage2-control-plane-ci-head.mjs) is used only for the control-plane CI
// checklist item.
//
// This script is the deterministic boundary between them. The preparation worker must not
// assert `AUDIT_READY #<n>` itself; it runs this script and relays its single stdout line.
//
//   node tools/orchestration/verify-audit-ready.mjs --pr <N>
//       -> prints `MERGE_COMMIT <full-sha>` (the PR's actual merge commit, straight from
//          GitHub) so the worker writes exactly this value into "Exact merge commit".
//   node tools/orchestration/verify-audit-ready.mjs --pr <N> --execution-issue <N|none> --audit-issue <N>
//       -> directly re-reads the persisted Audit Issue and validates, against live durable
//          identity, that it is OPEN, has the complete canonical shape, records the PR's actual
//          merge commit and the given work issue, and is the sole matching OPEN canonical Audit
//          Issue. Prints `AUDIT_READY #<n>` (exit 0) or `AUDIT_PREPARATION_FAILED <reason>`
//          (exit 2). Never posts a reviewer trigger and never writes anything.
//   node tools/orchestration/verify-audit-ready.mjs --pr <N> --scope
//       -> prints `MERGE_SCOPE <first-parent-sha> <merge-sha> <changed-file-count>` (issue #1005):
//          the truthful exact-merge change-scope range, derived from the merged commit's actual
//          first parent -- never from the PR's saved base SHA, which goes stale when the default
//          branch advances before merge. The checklist's change-scope `git diff` MUST use exactly
//          this range. The full check also fails closed (before any reviewer trigger) when the
//          Audit Issue's checklist carries a `git diff <base> <merge>` whose base is not that
//          first parent (scope-baseline.mjs).
//
// Reuses finalize-audit-breakpoint.mjs's verifyPrMerged/verifyAuditIssueMatches/
// verifyAuditIssueStillUnique so there is exactly one definition of "matches this merge".
import { execFileSync } from "node:child_process";
import { readGithubIssue, readGithubPr } from "./github-read.mjs";
import { verifyPrMerged, verifyAuditIssueMatches } from "./finalize-audit-breakpoint.mjs";
import { defaultGhIssueList, findMatchingOpenAuditIssues, parseFormField, parseVerificationChecklistRef } from "../review-watch/lifecycle-gate.mjs";
import { verifyAuditScopeBaseline, defaultReadCommit, deriveMergeScope, describeScopeFailure } from "./scope-baseline.mjs";
import { resolveRepoIdentity } from "./ready-dispatch-gate.mjs";

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function defaultGhPrView({ repo, pr }) {
  return readGithubPr({ repo, number: pr, fields: ["state", "mergeCommit"] });
}

function defaultGhAuditIssueView({ repo, auditIssue }) {
  return readGithubIssue({ repo, number: auditIssue, fields: ["body", "state"] });
}

// Pure. The "Merged PR" field must reference exactly one PR: a bare `#N` (same repository by
// construction) or a github.com pull URL whose owner/repo equals `repo` (case-insensitive).
function checkMergedPrIdentity(prField, { repo, pr }) {
  const text = String(prField ?? "");
  const refs = [];
  const re = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)|(?:^|[^\w/])#(\d+)/g;
  for (const m of text.matchAll(re)) {
    refs.push(m[2] ? { repo: m[1], number: Number(m[2]) } : { repo: null, number: Number(m[3]) });
  }
  const fail = {
    ok: false,
    reason: `Audit Issue's "Merged PR" field is ${JSON.stringify(prField)}, expected exactly PR #${pr}${repo ? ` in ${repo}` : ""}`,
  };
  if (refs.length !== 1 || refs[0].number !== pr) return fail;
  if (refs[0].repo && repo && refs[0].repo.toLowerCase() !== String(repo).toLowerCase()) return fail;
  return { ok: true };
}

function failed(reason) {
  return { exitCode: 2, state: "AUDIT_PREPARATION_FAILED", message: `AUDIT_PREPARATION_FAILED ${reason}` };
}

export async function run(
  { repo, pr, executionIssue, auditIssue, scope = false },
  {
    ghPrViewImpl = defaultGhPrView,
    ghAuditIssueViewImpl = defaultGhAuditIssueView,
    ghIssueListImpl = defaultGhIssueList,
    readCommitImpl = defaultReadCommit,
  } = {},
) {
  if (!isPositiveInteger(pr)) {
    return { exitCode: 1, message: "Missing/invalid required arg: --pr must be a positive integer." };
  }
  const resolveOnly = executionIssue == null && auditIssue == null;
  if (!resolveOnly) {
    if (!isPositiveInteger(auditIssue)) {
      return { exitCode: 1, message: "Missing/invalid required arg: --audit-issue must be a positive integer." };
    }
    if (executionIssue !== "none" && !isPositiveInteger(executionIssue)) {
      return { exitCode: 1, message: 'Missing/invalid required arg: --execution-issue must be a positive integer, or "none".' };
    }
  }

  let prView;
  try {
    prView = await ghPrViewImpl({ repo, pr });
  } catch (err) {
    return failed(`gh pr view failed for PR #${pr}: ${err.message}`);
  }
  const merged = verifyPrMerged(prView);
  if (!merged.ok) return failed(merged.reason);
  if (resolveOnly && scope) {
    let commit = null;
    try {
      commit = await readCommitImpl({ repo, sha: merged.mergeCommitOid });
    } catch (err) {
      return failed(`could not read merge commit ${merged.mergeCommitOid}: ${err.message}`);
    }
    const derived = deriveMergeScope(commit);
    if (!derived || String(commit.sha).toLowerCase() !== merged.mergeCommitOid.toLowerCase()) {
      return failed(`merge commit ${merged.mergeCommitOid} has no provable first parent; cannot derive an exact-merge scope`);
    }
    const count = commit.filesComplete === false ? "unknown" : String((derived.files ?? []).length);
    return {
      exitCode: 0,
      state: "MERGE_SCOPE",
      base: derived.base,
      head: derived.head,
      files: derived.files,
      message: `MERGE_SCOPE ${derived.base} ${derived.head} ${count}`,
    };
  }
  if (resolveOnly) {
    return { exitCode: 0, state: "MERGE_COMMIT", mergeCommitOid: merged.mergeCommitOid, message: `MERGE_COMMIT ${merged.mergeCommitOid}` };
  }

  let auditView;
  try {
    auditView = await ghAuditIssueViewImpl({ repo, auditIssue });
  } catch (err) {
    return failed(`gh issue view failed for Audit Issue #${auditIssue}: ${err.message}`);
  }
  // The shared matcher checks merge commit + work issue; the Merged PR field must also name this PR.
  const prField = parseFormField(auditView?.body ?? "", "Merged PR");
  const prIdentity = checkMergedPrIdentity(prField, { repo, pr });
  if (!prIdentity.ok) return failed(prIdentity.reason);
  const match = verifyAuditIssueMatches(auditView, { mergeCommitOid: merged.mergeCommitOid, executionIssue });
  if (!match.ok) return failed(match.reason);

  // Issue #1005: the mandatory change-scope command must truthfully isolate the audited merge.
  const scopeCheck = await verifyAuditScopeBaseline(
    { repo, checklist: parseVerificationChecklistRef(auditView?.body ?? "") ?? "", mergeCommit: merged.mergeCommitOid },
    { readCommitImpl },
  );
  if (!scopeCheck.ok) return failed(`checklist change-scope baseline rejected before any reviewer trigger - ${describeScopeFailure(scopeCheck)}`);

  let candidates;
  try {
    candidates = await ghIssueListImpl({ repo });
  } catch (err) {
    return failed(`could not list Audit Issue candidates for the uniqueness check: ${err.message}`);
  }
  // The persisted issue was just directly re-read and validated above, so its own existence is
  // not re-proved through the eventually consistent Search index (a freshly created issue may not
  // be indexed yet). Search only detects OTHER matching canonical candidates, which still fail
  // closed as ambiguous; the given audit issue itself may be absent from the results.
  const others = findMatchingOpenAuditIssues(candidates, { mergeCommitOid: merged.mergeCommitOid, executionIssue })
    .map((m) => Number(m.number))
    .filter((n) => n !== auditIssue)
    .sort((x, y) => x - y);
  if (others.length > 0) {
    return failed(
      `another OPEN canonical Audit Issue also matches merge commit ${merged.mergeCommitOid} and work issue ` +
        `${JSON.stringify(executionIssue)}: ${others.map((n) => `#${n}`).join(", ")} - ambiguous, refusing AUDIT_READY #${auditIssue}`,
    );
  }

  return { exitCode: 0, state: "AUDIT_READY", auditIssue, scopeBaseline: scopeCheck.state, message: `AUDIT_READY #${auditIssue}` };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

async function main() {
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
  const ei = args["execution-issue"];
  const result = await run({
    repo,
    pr: args.pr != null ? Number(args.pr) : null,
    executionIssue: ei === "none" ? "none" : ei != null ? Number(ei) : null,
    auditIssue: args["audit-issue"] != null ? Number(args["audit-issue"]) : null,
    scope: process.argv.includes("--scope"),
  });
  if (result.exitCode === 1) console.error(result.message);
  else console.log(result.message);
  process.exit(result.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("verify-audit-ready.mjs")) {
  main();
}
