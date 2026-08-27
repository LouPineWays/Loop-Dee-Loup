#!/usr/bin/env node
// Deterministic lifecycle gate for docs/bounded-review-cycle.md's implementation-issue
// invariant: "merge != acceptance; CLEAN Stage 2 == acceptance." The doc already states in
// prose that a review-worthy work issue may only close on a CLEAN Stage 2 disposition
// (Stage 1 step 8, Verdict handling), but PR #154 merged carrying `Fixes #151` in its body
// and GitHub auto-closed issue #151 the instant it reached `main`, before Stage 2 ever ran
// (issue #156). Prose alone did not stop that any more than it stopped the Stage 1 omissions
// stage1-gate.mjs exists to close — this script is the mechanical stop for the closing side
// of the lifecycle, on the same "compute state from durable GitHub evidence, never from
// conversation memory" model.
//
// Two independent checks, one file, because they gate the same invariant at its two
// enforcement points rather than being separate concerns:
//
//   merge-ready  — run before merge (Stage 1 step 8). Fails closed if the PR carries any
//                  GitHub closing mechanism for the named work issue: a PR-body/Development-
//                  sidebar closing reference (both surfaced by `closingIssuesReferences`) or a
//                  closing keyword in a commit message already on the PR (not surfaced by that
//                  field — GitHub only reads commit-message keywords once they land on the
//                  default branch, so this scans commits directly), including GitHub's
//                  repository-qualified form (`Fixes owner/repo#N`). Both checks compare the
//                  referenced issue's repository against `--repo`, not just its number, so a
//                  same-numbered issue in a *different* repository never blocks this merge. It
//                  cannot see an operator-edited squash-merge message typed interactively at
//                  merge time; docs/bounded-review-cycle.md still requires eyeballing that one
//                  by hand.
//
//   post-audit   — run when Stage 2 begins or resumes, and again after a verdict lands.
//                  Reads the audit-control issue's own "Work issue" and "Verdict" fields (never
//                  a second, separately-tracked mapping) and reports whether current repository
//                  state matches the invariant: PREMATURE_CLOSURE (work issue closed without a
//                  CLEAN verdict — the exact defect PR #154 produced), READY_TO_CLOSE (a CLEAN
//                  verdict backed by a genuine post-trigger Codex response is recorded but the
//                  work issue is still open), or OK (already consistent). A CLEAN dropdown value
//                  with no genuine response behind it (e.g. set by hand before Stage 2 actually
//                  ran) is never trusted — it is treated the same as no verdict, per the
//                  "modify nothing without provenance" reasoning already governing Stage 1/Stage
//                  2 responses elsewhere in this cycle. `--recover true` reopens a
//                  PREMATURE_CLOSURE work issue and records why; if the environment cannot
//                  reopen it, this reports the blocked state rather than silently accepting the
//                  premature closure.
//
// Usage:
//   node tools/review-watch/lifecycle-gate.mjs merge-ready --repo OWNER/REPO --pr 50 --issue 151
//   node tools/review-watch/lifecycle-gate.mjs post-audit --repo OWNER/REPO --audit-issue 160 [--recover true]
//
// Exit codes: 0 = MERGE_READY / OK / READY_TO_CLOSE (safe to proceed), 2 = BLOCKED_CLOSING_REFERENCE
// / PREMATURE_CLOSURE (must not merge / must not treat as accepted), 1 = operational error.
//
// Tests: node --test tools/review-watch/lifecycle-gate.test.mjs

import { execFileSync } from "node:child_process";
import { endpointsFor, findAllMatches } from "./poll.mjs";
import { findExistingTrigger } from "./trigger.mjs";
import { isGenuineResponse } from "./genuine-response.mjs";

const DEFAULT_BOT = "chatgpt-codex-connector[bot]";

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const value = argv[++i];
    args[key] = value;
  }
  return args;
}

// Pure. Accepts a bare positive integer or one prefixed with "#" (the natural pasted form,
// e.g. `--issue "#151"`) and returns its digits as a string, or null if `raw` is neither.
// Stage 1 review finding on this PR: without this, `--issue "#151"` silently fails open —
// `String(ref.number) === String(issue)` can never equal `"#151"`, and the generated
// commit-message pattern searches for the literal (harmless, always-absent) text "##151" —
// so a PR that actually carries `Fixes #151` in both closingIssuesReferences and a commit
// message would incorrectly report MERGE_READY. Rejects "0"/"#0" (Stage 2 audit finding on
// issue #187: `\d+` alone accepts an all-zero string, and `checkMergeReady`'s `!issue` guard
// treats the non-empty string "0" as present, so a zero --issue previously passed validation
// and silently checked nonexistent issue #0 instead of failing closed) — GitHub issue numbers
// are always positive, so requiring `Number(match[1]) > 0` rejects it without rejecting any
// real issue number.
export function normalizeIssueNumber(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const match = /^#?(\d+)$/.exec(String(raw).trim());
  if (!match) return null;
  return Number(match[1]) > 0 ? match[1] : null;
}

// GitHub's own closing-keyword set (close/closes/closed, fix/fixes/fixed, resolve/resolves/
// resolved), case-insensitive, optionally followed by a colon, before "#N" or GitHub's
// repository-qualified "owner/repo#N" form (Stage 1 review finding on this PR: a
// commit-only closing reference like `Fixes owner/repo#151` is not surfaced by
// closingIssuesReferences at all, since that field only covers PR-body/sidebar sources, so
// this scan needs to recognize the qualified form directly or miss it entirely). The
// trailing \b on the issue number keeps "#151" from matching inside "#1510" — both are word
// characters, so \b only holds where the digit run actually ends. Global so
// findClosingKeywordMatch can walk every match in the text, not just the first, to find one
// scoped to the right repository.
function closingKeywordPatternFor(issueNumber) {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b\\s*:?\\s*(?:([\\w.-]+/[\\w.-]+)\\s*)?#${issueNumber}\\b`, "gi");
}

// Pure. Returns the matched closing-keyword phrase (e.g. "Fixes #151") if `text` closes
// `issueNumber` via a GitHub auto-close keyword, or null. Deliberately does not match
// non-closing references like "Addresses #151" or "Implements #151" — those are the
// documented safe form (docs/bounded-review-cycle.md Stage 1 step 8) and must never be
// flagged as a violation. When `repo` is given, a repository-qualified match
// (`owner/repo#N`) only counts when its repository equals `repo` — a commit that closes a
// same-numbered issue in a *different* repository must not block this one (Stage 1 review
// finding on this PR). Without `repo`, any qualified match counts, failing closed rather
// than silently ignoring a qualifier it can't evaluate.
export function findClosingKeywordMatch(text, issueNumber, repo) {
  if (!text) return null;
  const pattern = closingKeywordPatternFor(issueNumber);
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const qualifiedRepo = match[1];
    if (!qualifiedRepo || !repo || qualifiedRepo.toLowerCase() === repo.toLowerCase()) {
      return match[0];
    }
  }
  return null;
}

// Pure. Extracts one GitHub issue-form field's rendered value from an issue/PR body: forms
// render each field as a "### <Label>" heading followed by its value on the next non-blank
// line(s), up to the next "### " heading or end of body. Returns the first non-blank line
// under the *last* matching heading (not the first), trimmed, or null if the heading isn't
// present. Last, not first, per Stage 1 review finding on this PR: an audit response
// naturally quotes the required findings structure (which itself mentions "Verdict") inside
// the Findings field, which precedes the real Verdict field in template order — matching
// the first occurrence could read an example/quoted "CLEAN" out of Findings prose instead of
// the actual dropdown value. Shared by the "Work issue" and "Verdict" fields on the
// audit-control-issue template so both read the same rendered-body shape through one parser
// instead of two ad hoc regexes drifting apart.
export function parseFormField(body, label) {
  const lines = (body ?? "").split("\n");
  const heading = `### ${label}`;
  let headingIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === heading) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return null;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("### ")) break;
    if (line === "") continue;
    return line;
  }
  return null;
}

// Pure. The audit-control-issue template's Verdict dropdown only ever renders one of these
// three literal values; anything else (a missing heading, a stripped/edited field) is
// treated as "no verdict" rather than guessed at.
export function parseStage2Verdict(body) {
  const value = parseFormField(body, "Verdict");
  return value === "PENDING" || value === "CLEAN" || value === "NOT CLEAN" ? value : null;
}

// Pure. Reads the work issue this audit gates from the template's own "Work issue" field
// (added alongside this script — see .github/ISSUE_TEMPLATE/audit-control-issue.yml) rather
// than inferring it from the merged PR's non-closing reference, which is free-text prose and
// not a structured, machine-checkable source. Accepts "#151", "151", or a full issue URL
// ending in the number.
export function parseWorkIssueRef(body) {
  const value = parseFormField(body, "Work issue");
  if (!value) return null;
  const match = value.match(/#?(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

// Pure. The repository an issue/PR URL belongs to ("owner/repo"), or null if `url` doesn't
// match GitHub's issue URL shape.
function extractRepoFromIssueUrl(url) {
  const match = /github\.com\/([^/]+\/[^/]+)\/issues\/\d+/i.exec(url ?? "");
  return match ? match[1] : null;
}

// Pure. Whether a closingIssuesReferences entry refers to `issueNumber` *in `repo`*, not
// merely an issue sharing that number in an unrelated repository (Stage 1 review finding on
// this PR: `gh pr view --json closingIssuesReferences` can include cross-repository closing
// references such as `Fixes other/repo#151`, and comparing only `.number` would falsely
// block a merge whose local work issue #151 is untouched). Falls back to counting the match
// when no URL is present to check, the same fail-closed default as the unqualified branch of
// findClosingKeywordMatch above.
function closingRefMatchesIssue(ref, repo, issueNumber) {
  if (String(ref.number) !== String(issueNumber)) return false;
  const refRepo = extractRepoFromIssueUrl(ref.url);
  return refRepo ? refRepo.toLowerCase() === repo.toLowerCase() : true;
}

// `ghPrViewImpl` is injected so tests can drive this end-to-end without touching the real
// network or `gh` CLI.
export async function checkMergeReady(args, { ghPrViewImpl = defaultGhPrView } = {}) {
  const { repo, pr } = args;
  const issue = normalizeIssueNumber(args.issue);
  if (!repo || !pr || !issue) {
    return {
      exitCode: 1,
      message:
        "Missing or invalid required args: --repo, --pr are required, and --issue must be a positive integer " +
        `(optionally prefixed with "#"); got --issue=${JSON.stringify(args.issue)}.`,
    };
  }

  let data;
  try {
    data = await ghPrViewImpl({ repo, number: pr });
  } catch (err) {
    return { exitCode: 1, message: `gh pr view failed for ${repo}#${pr}: ${err.message}` };
  }

  const violations = [];

  // Covers both PR-body closing keywords and a manually-linked Development-sidebar closing
  // reference: GitHub's closingIssuesReferences field is populated by either source. See
  // docs/bounded-review-cycle.md Stage 1 step 8's own note on this field's coverage.
  const closingRefs = data.closingIssuesReferences ?? [];
  if (closingRefs.some((ref) => closingRefMatchesIssue(ref, repo, issue))) {
    violations.push({
      source: "closingIssuesReferences",
      detail:
        `PR ${repo}#${pr} carries a GitHub closing reference (PR-body keyword or Development-sidebar ` +
        `link) to issue #${issue}. Use a non-closing reference (e.g. "Addresses #${issue}") instead, and ` +
        `remove or decline the Development-sidebar link if one is set.`,
    });
  }

  // Not covered by closingIssuesReferences: GitHub only recognizes a commit-message closing
  // keyword once the commit lands on the default branch, so this scans the PR's existing
  // commits directly instead. It cannot see an operator-edited squash-merge message typed
  // interactively at merge time — that still needs eyeballing per Stage 1 step 8.
  for (const commit of data.commits ?? []) {
    const text = `${commit.messageHeadline ?? ""}\n${commit.messageBody ?? ""}`;
    const match = findClosingKeywordMatch(text, issue, repo);
    if (match) {
      violations.push({
        source: `commit:${commit.oid ?? "unknown"}`,
        detail: `Commit ${commit.oid ?? "unknown"} message contains a closing keyword for issue #${issue}: "${match}".`,
      });
    }
  }

  if (violations.length > 0) {
    return { exitCode: 2, state: "BLOCKED_CLOSING_REFERENCE", violations };
  }

  return { exitCode: 0, state: "MERGE_READY" };
}

// Whether the audit issue's comment thread already carries a genuine post-trigger Codex
// response — reusing trigger.mjs's dedup read and genuine-response.mjs's classifier, never a
// second, competing definition of "did Stage 2 actually happen" (the same reuse discipline
// stage1-gate.mjs already follows for Stage 1). `ghApiImpl` is injected for tests.
async function hasGenuineAuditResponse({ repo, auditIssue, bot }, ghApiImpl) {
  const commentsPath = endpointsFor("issue", repo, auditIssue).find((e) => e.name === "issue-comments").path;
  const comments = await ghApiImpl(commentsPath);
  const trigger = findExistingTrigger(comments, {});
  if (!trigger) return false;
  const sinceMs = new Date(trigger.created_at).getTime();
  return findAllMatches(comments, { bot, sinceMs, endpointName: "issue-comments" }).some((m) => isGenuineResponse(m.body_excerpt));
}

// `ghIssueViewImpl` and `ghApiImpl` are injected so tests can drive this end-to-end without
// touching the real network or `gh` CLI.
export async function checkPostAudit(
  args,
  { ghIssueViewImpl = defaultGhIssueView, ghApiImpl = defaultGhApi, bot = DEFAULT_BOT } = {},
) {
  const { repo, "audit-issue": auditIssue } = args;
  if (!repo || !auditIssue) {
    return { exitCode: 1, message: "Missing required args: --repo and --audit-issue are both required." };
  }

  let auditIssueData;
  try {
    auditIssueData = await ghIssueViewImpl({ repo, number: auditIssue });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo}#${auditIssue}: ${err.message}` };
  }

  const workIssueNumber = parseWorkIssueRef(auditIssueData.body ?? "");
  if (!workIssueNumber) {
    return {
      exitCode: 1,
      message:
        `Could not find a "Work issue" field in audit issue ${repo}#${auditIssue}. The audit-control-issue ` +
        `template's Work issue field must name the implementation issue this audit gates.`,
    };
  }

  const rawVerdict = parseStage2Verdict(auditIssueData.body ?? "");

  // A CLEAN dropdown value is only trusted once a genuine post-trigger Codex response backs
  // it (Stage 1 review finding on this PR: the template exposes CLEAN as a selectable value
  // at issue *creation*, before Stage 2 has run at all, so reading the field alone would let
  // the gate authorize closing on an unreviewed audit). Any other raw value passes through
  // unchanged — PENDING/NOT CLEAN/malformed all correctly keep the work issue open regardless
  // of response provenance.
  let verdict = rawVerdict;
  let verdictBacked = null;
  if (rawVerdict === "CLEAN") {
    try {
      verdictBacked = await hasGenuineAuditResponse({ repo, auditIssue, bot }, ghApiImpl);
    } catch (err) {
      return {
        exitCode: 1,
        message: `gh api call failed while verifying the CLEAN verdict on ${repo}#${auditIssue}: ${err.message}`,
      };
    }
    if (!verdictBacked) verdict = null;
  }

  let workIssueData;
  try {
    workIssueData = await ghIssueViewImpl({ repo, number: workIssueNumber });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo}#${workIssueNumber}: ${err.message}` };
  }

  const isClosed = workIssueData.state === "CLOSED";

  if (isClosed && verdict !== "CLEAN") {
    return {
      exitCode: 2,
      state: "PREMATURE_CLOSURE",
      workIssue: workIssueNumber,
      auditIssue: Number(auditIssue),
      verdict,
      rawVerdict,
      message:
        `Work issue ${repo}#${workIssueNumber} is closed but audit issue ${repo}#${auditIssue} records no ` +
        `verified CLEAN verdict (found: ${rawVerdict ?? "none/malformed"}${
          rawVerdict === "CLEAN" ? ", but no genuine post-trigger Codex response backs it" : ""
        }). Per docs/bounded-review-cycle.md, only a CLEAN Stage 2 disposition may close the work issue. ` +
        `Re-run with --recover true to reopen it.`,
    };
  }

  if (!isClosed && verdict === "CLEAN") {
    return { exitCode: 0, state: "READY_TO_CLOSE", workIssue: workIssueNumber, auditIssue: Number(auditIssue), verdict };
  }

  return {
    exitCode: 0,
    state: "OK",
    workIssue: workIssueNumber,
    auditIssue: Number(auditIssue),
    verdict,
    rawVerdict,
    workIssueState: workIssueData.state,
  };
}

// `ghReopenImpl` and `ghCommentImpl` are injected so tests can drive this without touching
// the real network or `gh` CLI, and are kept as two independently-failing steps rather than
// one combined operation (Stage 1 review finding on this PR: when reopen succeeds but the
// follow-up explanation comment fails transiently or on a permission edge case, the work
// issue is correctly open again — a retry then sees it as already OK and never attempts the
// comment again, so folding both into one try/catch would permanently and silently drop the
// durable explanation while still reporting the whole recovery as failed).
export async function recoverPrematureClosure(
  { repo, workIssue, auditIssue },
  { ghReopenImpl = defaultGhReopen, ghCommentImpl = defaultGhComment } = {},
) {
  try {
    await ghReopenImpl({ repo, workIssue });
  } catch (err) {
    return {
      exitCode: 1,
      recovered: false,
      message:
        `BLOCKED — merge != acceptance, but the execution environment could not reopen ${repo}#${workIssue}: ` +
        `${err.message}. Next: founder reopens the issue manually and confirms no CLEAN Stage 2 verdict exists ` +
        `at ${repo} audit issue #${auditIssue} before treating it as complete.`,
    };
  }

  try {
    await ghCommentImpl({ repo, workIssue, auditIssue });
  } catch (err) {
    return {
      exitCode: 0,
      recovered: true,
      commentPosted: false,
      workIssue,
      auditIssue,
      message:
        `Reopened ${repo}#${workIssue}, but could not post the durable explanation comment: ${err.message}. ` +
        `The issue is open; a follow-up should post the explanation by hand (re-running --recover true will ` +
        `not retry this step on its own, since the issue no longer reads as PREMATURE_CLOSURE).`,
    };
  }

  return { exitCode: 0, recovered: true, commentPosted: true, workIssue, auditIssue };
}

function defaultGhPrView({ repo, number }) {
  const raw = execFileSync(
    "gh",
    ["pr", "view", String(number), "--repo", repo, "--json", "closingIssuesReferences,commits"],
    { encoding: "utf8" },
  );
  return JSON.parse(raw);
}

function defaultGhIssueView({ repo, number }) {
  const raw = execFileSync("gh", ["issue", "view", String(number), "--repo", repo, "--json", "body,state"], {
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

function defaultGhApi(path) {
  const raw = execFileSync("gh", ["api", path, "--paginate", "--slurp"], { encoding: "utf8" });
  return JSON.parse(raw).flat();
}

function defaultGhReopen({ repo, workIssue }) {
  execFileSync("gh", ["issue", "reopen", String(workIssue), "--repo", repo], { encoding: "utf8" });
}

function defaultGhComment({ repo, workIssue, auditIssue }) {
  const body =
    `Reopened by tools/review-watch/lifecycle-gate.mjs: this issue was closed without a verified CLEAN Stage 2 ` +
    `verdict on its audit issue #${auditIssue}. Per docs/bounded-review-cycle.md, merge != acceptance — ` +
    `only a CLEAN Stage 2 disposition may close a review-worthy implementation issue.`;
  execFileSync("gh", ["issue", "comment", String(workIssue), "--repo", repo, "--body", body], { encoding: "utf8" });
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (subcommand === "merge-ready") {
    const result = await checkMergeReady({ repo: args.repo, pr: args.pr, issue: args.issue });
    if (result.exitCode === 1) console.error(result.message);
    else console.log(JSON.stringify(result));
    process.exit(result.exitCode);
    return;
  }

  if (subcommand === "post-audit") {
    const result = await checkPostAudit(args);
    if (result.exitCode === 1) {
      console.error(result.message);
      process.exit(result.exitCode);
      return;
    }

    if (result.state === "PREMATURE_CLOSURE" && (args.recover === "true" || args.recover === "1")) {
      const recovery = await recoverPrematureClosure({
        repo: args.repo,
        workIssue: result.workIssue,
        auditIssue: result.auditIssue,
      });
      console.log(JSON.stringify({ ...result, recovery }));
      process.exit(recovery.exitCode);
      return;
    }

    console.log(JSON.stringify(result));
    process.exit(result.exitCode);
    return;
  }

  console.error(`Unknown subcommand: ${subcommand ?? "(none)"}. Use "merge-ready" or "post-audit".`);
  process.exit(1);
}

// Only run as a CLI when invoked directly, not when the test file imports these functions.
if (process.argv[1] && process.argv[1].endsWith("lifecycle-gate.mjs")) {
  main();
}
