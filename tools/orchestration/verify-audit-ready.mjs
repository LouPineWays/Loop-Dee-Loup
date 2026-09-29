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
//
// Reuses finalize-audit-breakpoint.mjs's verifyPrMerged/verifyAuditIssueMatches/
// verifyAuditIssueStillUnique so there is exactly one definition of "matches this merge".
import { execFileSync } from "node:child_process";
import {
  verifyPrMerged,
  verifyAuditIssueMatches,
  verifyAuditIssueStillUnique,
} from "./finalize-audit-breakpoint.mjs";
import { defaultGhIssueList, parseFormField } from "../review-watch/lifecycle-gate.mjs";
import { resolveRepoIdentity } from "./ready-dispatch-gate.mjs";

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function defaultGhPrView({ repo, pr }) {
  const args = ["pr", "view", String(pr), "--json", "state,mergeCommit"];
  if (repo) args.push("--repo", repo);
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

function defaultGhAuditIssueView({ repo, auditIssue }) {
  const args = ["issue", "view", String(auditIssue), "--json", "body,state"];
  if (repo) args.push("--repo", repo);
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

function failed(reason) {
  return { exitCode: 2, state: "AUDIT_PREPARATION_FAILED", message: `AUDIT_PREPARATION_FAILED ${reason}` };
}

export async function run(
  { repo, pr, executionIssue, auditIssue },
  { ghPrViewImpl = defaultGhPrView, ghAuditIssueViewImpl = defaultGhAuditIssueView, ghIssueListImpl = defaultGhIssueList } = {},
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
  const prRefs = [...String(prField ?? "").matchAll(/(?:\/pull\/|#)(\d+)/g)].map((m) => Number(m[1]));
  if (prRefs.length !== 1 || prRefs[0] !== pr) {
    return failed(`Audit Issue's "Merged PR" field is ${JSON.stringify(prField)}, expected exactly PR #${pr}`);
  }
  const match = verifyAuditIssueMatches(auditView, { mergeCommitOid: merged.mergeCommitOid, executionIssue });
  if (!match.ok) return failed(match.reason);

  let candidates;
  try {
    candidates = await ghIssueListImpl({ repo });
  } catch (err) {
    return failed(`could not list Audit Issue candidates for the uniqueness check: ${err.message}`);
  }
  const unique = verifyAuditIssueStillUnique(candidates, { mergeCommitOid: merged.mergeCommitOid, executionIssue, auditIssue });
  if (!unique.ok) return failed(unique.reason);

  return { exitCode: 0, state: "AUDIT_READY", auditIssue, message: `AUDIT_READY #${auditIssue}` };
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
  });
  if (result.exitCode === 1) console.error(result.message);
  else console.log(result.message);
  process.exit(result.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("verify-audit-ready.mjs")) {
  main();
}
