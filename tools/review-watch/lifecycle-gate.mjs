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
//                  default branch, so this scans commits directly). It cannot see a squash-merge
//                  message an operator types interactively at merge time; docs/bounded-review-
//                  cycle.md still requires eyeballing that one by hand.
//
//   post-audit   — run when Stage 2 begins or resumes, and again after a verdict lands.
//                  Reads the audit-control issue's own "Work issue" and "Verdict" fields (never
//                  a second, separately-tracked mapping) and reports whether current repository
//                  state matches the invariant: PREMATURE_CLOSURE (work issue closed without a
//                  CLEAN verdict — the exact defect PR #154 produced), READY_TO_CLOSE (CLEAN
//                  verdict recorded but the work issue is still open), or OK (already
//                  consistent). `--recover true` reopens a PREMATURE_CLOSURE work issue and
//                  records why; if the environment cannot reopen it, this reports the blocked
//                  state rather than silently accepting the premature closure.
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

// GitHub's own closing-keyword set (close/closes/closed, fix/fixes/fixed, resolve/resolves/
// resolved), case-insensitive, optionally followed by a colon, immediately before "#N". The
// trailing \b on the issue number keeps "#151" from matching inside "#1510" — both are word
// characters, so \b only holds where the digit run actually ends.
function closingKeywordPatternFor(issueNumber) {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b\\s*:?\\s*#${issueNumber}\\b`, "i");
}

// Pure. Returns the matched closing-keyword phrase (e.g. "Fixes #151") if `text` closes
// `issueNumber` via a GitHub auto-close keyword, or null. Deliberately does not match
// non-closing references like "Addresses #151" or "Implements #151" — those are the
// documented safe form (docs/bounded-review-cycle.md Stage 1 step 8) and must never be
// flagged as a violation.
export function findClosingKeywordMatch(text, issueNumber) {
  if (!text) return null;
  const match = closingKeywordPatternFor(issueNumber).exec(text);
  return match ? match[0] : null;
}

// Pure. Extracts one GitHub issue-form field's rendered value from an issue/PR body: forms
// render each field as a "### <Label>" heading followed by its value on the next non-blank
// line(s), up to the next "### " heading or end of body. Returns the first non-blank line
// under the heading, trimmed, or null if the heading isn't present. Shared by the "Work
// issue" and "Verdict" fields on the audit-control-issue template so both read the same
// rendered-body shape through one parser instead of two ad hoc regexes drifting apart.
export function parseFormField(body, label) {
  const lines = (body ?? "").split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === `### ${label}`);
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

// `ghPrViewImpl` is injected so tests can drive this end-to-end without touching the real
// network or `gh` CLI.
export async function checkMergeReady(args, { ghPrViewImpl = defaultGhPrView } = {}) {
  const { repo, pr, issue } = args;
  if (!repo || !pr || !issue) {
    return { exitCode: 1, message: "Missing required args: --repo, --pr, and --issue are all required." };
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
  if (closingRefs.some((ref) => String(ref.number) === String(issue))) {
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
    const match = findClosingKeywordMatch(text, issue);
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

// `ghIssueViewImpl` is injected so tests can drive this end-to-end without touching the real
// network or `gh` CLI.
export async function checkPostAudit(args, { ghIssueViewImpl = defaultGhIssueView } = {}) {
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

  const verdict = parseStage2Verdict(auditIssueData.body ?? "");

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
      message:
        `Work issue ${repo}#${workIssueNumber} is closed but audit issue ${repo}#${auditIssue} records no ` +
        `CLEAN verdict (found: ${verdict ?? "none/malformed"}). Per docs/bounded-review-cycle.md, only a ` +
        `CLEAN Stage 2 disposition may close the work issue. Re-run with --recover true to reopen it.`,
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
    workIssueState: workIssueData.state,
  };
}

// `ghReopenImpl` is injected so tests can drive this without touching the real network or
// `gh` CLI. Posts a durable comment explaining the reopen alongside the state change, so a
// fresh session reading the work issue later sees why it was reopened without needing this
// conversation's memory.
export async function recoverPrematureClosure({ repo, workIssue, auditIssue }, { ghReopenImpl = defaultGhReopen } = {}) {
  try {
    await ghReopenImpl({ repo, workIssue, auditIssue });
    return { exitCode: 0, recovered: true, workIssue, auditIssue };
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

function defaultGhReopen({ repo, workIssue, auditIssue }) {
  execFileSync("gh", ["issue", "reopen", String(workIssue), "--repo", repo], { encoding: "utf8" });
  const body =
    `Reopened by tools/review-watch/lifecycle-gate.mjs: this issue was closed without a CLEAN Stage 2 ` +
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
      process.exit(recovery.exitCode === 0 ? 0 : recovery.exitCode);
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
