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
//                  verdict backed by a *completed* Stage 2 audit report is recorded but the
//                  work issue is still open), or OK (already consistent). A CLEAN dropdown value
//                  is never trusted on its own (e.g. set by hand before Stage 2 actually ran) —
//                  it is treated the same as no verdict unless stage2-report.mjs's
//                  isCompletedStage2AuditReport finds a post-trigger response that references the
//                  exact merge commit (still unconditionally required — issue #335 investigated
//                  and rejected accepting the audit issue's own trusted frozen Stage 1 reviewed
//                  head as an alternative; see parseReviewedHeadCommitRef below and
//                  stage2-report.mjs's module comment for why), states an explicit CLEAN verdict
//                  of its own, and shows verification-results content; a genuine-but-incomplete
//                  response — e.g. issue #229's "Starting #178." kickoff,
//                  which findStage2ReportEvidence below evaluates and correctly rejects — does
//                  not count (issue #230). `--recover
//                  true` reopens a PREMATURE_CLOSURE work issue and records why; if the
//                  environment cannot reopen it, this reports the blocked state rather than
//                  silently accepting the
//                  premature closure.
//
// Not every review-worthy PR has a gated work issue to protect: LDL's own recurring
// consumer-sync PRs (issue #190) are review-worthy but have no per-update implementation
// issue. `--issue none` (merge-ready) and the literal typed word "none" in the (still
// required) `Work issue` template field (post-audit) are the explicit no-work-issue
// sentinels — deliberately distinct from an omitted/malformed value, which still fails closed
// as an operational error, so a forgotten argument or a forgotten template field can never
// silently pass as "no work issue applies." In that explicit state, merge-ready and post-audit
// still run — Stage 1, Stage 2, CI, and the bounded-reviewer-invocation rules are unaffected —
// they only skip the closing-reference/premature-closure checks that have no issue to protect.
//
//   close-audit  — a Stage 2 audit's own verdict is not fully consumed until the audit
//                  artifact itself reaches truthful durable terminal state (issue #407,
//                  correcting #380/#384 and the #396→#406 correction-chain gap). `post-audit`
//                  above only ever closes/reopens the *work* issue; a CLEAN, fully-consumed
//                  audit could still sit open indefinitely (#380/#384), and a superseded
//                  NOT CLEAN predecessor in a correction chain had no mechanical route to
//                  terminal state at all even once its successor reached CLEAN (#396, closed
//                  only by a founder writing the explanatory comment by hand). `close-audit`
//                  computes this audit issue's own terminal state from durable evidence —
//                  reusing `evaluateBackedCleanVerdict` (shared with `post-audit`'s
//                  no-work-issue branch, so "is this audit's own verdict backed CLEAN" has
//                  exactly one implementation) — and never inspects the gated work issue's own
//                  state at all: `ALREADY_TERMINAL` (already CLOSED, a safe no-op, no mutation
//                  even without `--dry-run`); `CLOSE_READY`/`CLOSED` (this audit's own verdict
//                  is backed CLEAN by a completed Stage 2 audit report, regardless of the gated
//                  work issue's open/closed state — the #380/#384 fix); `SUPERSEDED_CLOSE_READY`/
//                  `SUPERSEDED_CLOSED` (this audit's own verdict is not backed CLEAN, but a
//                  distinct, later-created audit issue naming the same Work issue independently
//                  re-derives its own CLOSE_READY-ness under this same predicate — never merely
//                  "exists," "has a newer number," or "is titled similarly" — the #396→#406
//                  correction-chain fix); or `NOT_TERMINAL_YET` (none of the above — a normal,
//                  non-error result, not a failure: active PENDING, invalid/incomplete/
//                  provenance-unbacked evidence, or a NOT CLEAN/PENDING predecessor with no
//                  qualifying successor yet). The `[Audit]` title prefix is used only to
//                  *enumerate candidate* successor issues (`gh issue list --search`); it never
//                  by itself authorizes a close — every close is authorized only by the
//                  structured field/report evidence above. A real (non-dry-run) close posts one
//                  explanatory comment naming the backing evidence, closing first and commenting
//                  second (mirroring `recoverPrematureClosure`'s own precedent below): closing is
//                  the primary, idempotency-observable state change, so a rerun after a
//                  comment-post failure sees `ALREADY_TERMINAL` and never re-attempts either step
//                  (never a duplicate close, never a duplicate comment).
//
//   close-work-issue — Stage 1 review finding on PR #435: `close-audit` above deliberately never
//                  touches the gated work issue (Shared Contract item 3), which correctly closed
//                  the audit-side half of the #380/#384 gap but left the work-issue half as only
//                  a prose reminder in docs/bounded-review-cycle.md ("also close the implemented
//                  work issue itself") — the same "mechanically unenforced" shape that already
//                  proved insufficient once. This is a separate command, not a change to
//                  `close-audit`'s own independence from work-issue state: idempotent
//                  (`ALREADY_TERMINAL` on an already-closed work issue, no mutation attempted),
//                  and closes first, then posts one explanatory comment naming the backing Stage
//                  2 audit issue (same close-then-comment ordering as `close-audit`).
//
//   record-verdict — issue #439's fix for a distinct lifecycle-seam gap the live #408/#436
//                  cycle exposed after PR #435 merged: Codex posted one fully completed Stage 2
//                  report (comment 5571784678, exact merge commit
//                  8fe3ddc42141d383740dde786da13b79022e1acd), but the audit issue's own durable
//                  `Verdict` field still read `PENDING` — nobody/nothing had promoted it yet —
//                  and `checkPostAudit` (before this fix) only ever fetched report evidence
//                  when the dropdown already said `CLEAN`, so a still-`PENDING` dropdown fell
//                  straight to the generic `OK`/`rawVerdict: "PENDING"` result, indistinguishable
//                  from true "nobody has responded yet." The composed
//                  `next-review-transition-gate.mjs` then reported `NO_ACTION_YET`, and the
//                  controlling session described a fully completed report as "no genuine
//                  completed response has landed yet." `checkPostAudit` now also fetches report
//                  evidence (via the same `findStage2ReportEvidence`, never a second parser)
//                  whenever the durable `Verdict` field is `PENDING` or missing/malformed, and
//                  reports the new `REPORT_READY_TO_RECORD` state — carrying the audit issue
//                  number, current `rawVerdict`, and the evidence found (for either verdict,
//                  `CLEAN` or `NOT CLEAN`) — instead of falling through to generic `OK`. This
//                  narrows the fix to exactly that gap: a settled `CLEAN`/`NOT CLEAN` dropdown
//                  still resolves through its own existing (unmodified) branches, and a closed
//                  work issue with no backing evidence still reports `PREMATURE_CLOSURE`
//                  unchanged — `REPORT_READY_TO_RECORD` only replaces the generic-`OK` fallthrough
//                  for an *open* work issue (or the no-work-issue state) whose verdict is not yet
//                  recorded.
//
//                  `record-verdict` is the deterministic promotion command `REPORT_READY_TO_RECORD`
//                  authorizes: it reuses `checkPostAudit` internally (never re-adjudicating finding
//                  substance) to find the evidence, then re-reads the audit issue fresh
//                  immediately before mutating it — closing the race window between that read and
//                  the evidence check, and giving genuine meaning to its own idempotent-rerun
//                  states. `RECORDED` (the durable `Verdict` field, previously `PENDING`/malformed,
//                  is now set to the evidence-backed verdict, plus one explanatory comment naming
//                  the backing evidence — never a rewritten copy of the report's own finding
//                  content, per issue #439's Shared Contract); `ALREADY_RECORDED` (the fresh
//                  re-read already shows the evidence-backed verdict recorded — a safe no-op,
//                  never a duplicate mutation or comment); `CONFLICTING_VERDICT` (exit 2 — the
//                  fresh re-read shows a *different*, already-settled verdict than the evidence
//                  found; never silently overwritten, mirroring `PREMATURE_CLOSURE`'s fail-closed
//                  refusal). When `checkPostAudit` itself does not report `REPORT_READY_TO_RECORD`
//                  (no completed report exists yet, or the field is already a settled value its
//                  own existing branches already evaluated), `record-verdict` passes that result
//                  through verbatim rather than inventing a state this file's vocabulary already
//                  covers — this is also what makes a rerun *after* a successful `RECORDED`
//                  idempotent: the now-settled verdict reaches checkPostAudit's own existing
//                  `READY_TO_CLOSE`/`ACCEPTED_NO_WORK_ISSUE`/`OK` path exactly as if a human had
//                  set the field by hand.
//
// Usage:
//   node tools/review-watch/lifecycle-gate.mjs merge-ready --repo OWNER/REPO --pr 50 --issue 151
//   node tools/review-watch/lifecycle-gate.mjs merge-ready --repo OWNER/REPO --pr 50 --issue none
//   node tools/review-watch/lifecycle-gate.mjs post-audit --repo OWNER/REPO --audit-issue 160 [--recover true]
//   node tools/review-watch/lifecycle-gate.mjs record-verdict --repo OWNER/REPO --audit-issue 160
//   node tools/review-watch/lifecycle-gate.mjs close-audit --repo OWNER/REPO --audit-issue 160 [--dry-run true]
//   node tools/review-watch/lifecycle-gate.mjs close-work-issue --repo OWNER/REPO --work-issue 151 --audit-issue 160
//
// Exit codes: 0 = MERGE_READY / MERGE_READY_NO_WORK_ISSUE / OK / READY_TO_CLOSE /
// REPORT_READY_TO_RECORD / RECORDED / ALREADY_RECORDED / ALREADY_TERMINAL / CLOSE_READY / CLOSED /
// SUPERSEDED_CLOSE_READY / SUPERSEDED_CLOSED / NOT_TERMINAL_YET (safe to proceed),
// 2 = BLOCKED_CLOSING_REFERENCE / PREMATURE_CLOSURE / CONFLICTING_VERDICT (must not merge / must
// not treat as accepted / must not silently overwrite), 1 = operational error.
//
// Tests: node --test tools/review-watch/lifecycle-gate.test.mjs

import { execFileSync } from "node:child_process";
import { endpointsFor, findAllMatches } from "./poll.mjs";
import { findExistingTrigger, findCommentById } from "./trigger.mjs";
import { isCompletedStage2AuditReport } from "./stage2-report.mjs";

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

// Pure. True only for the literal, case-insensitive sentinel "none" — `checkMergeReady`'s
// explicit no-work-issue declaration for `--issue` (issue #190; the template's `Work issue`
// field has its own, separately-matched marker set below). Deliberately narrow: an omitted,
// empty, or merely unparseable value must keep failing closed as an operational error rather
// than being silently treated as "no work issue applies," so this never matches
// undefined/null/"" the way normalizeIssueNumber's callers might expect a "no value" case to.
export function isNoWorkIssueSentinel(raw) {
  return typeof raw === "string" && raw.trim().toLowerCase() === "none";
}

// Pure. The free-text sentinels a human deliberately types into the (required — see
// .github/ISSUE_TEMPLATE/audit-control-issue.yml) "Work issue" field to declare no
// implementation issue applies. Deliberately does NOT include GitHub's own "_No response_"
// marker for a left-blank *optional* field: an earlier version of this template made the field
// optional so a blank render of that exact marker could stand for the sentinel, but that made a
// deliberate no-work-issue declaration indistinguishable from an operator simply forgetting to
// fill in a real work issue on an audit that has one — both render identically, silently
// stripping that issue's premature-closure protection (Stage 1 review finding on PR #197).
// Keeping the field required and requiring an explicit typed word closes that gap: an omission
// now fails GitHub's own form validation instead of reaching this parser as ambiguous blank
// text.
const NO_WORK_ISSUE_FIELD_MARKERS = new Set(["none", "n/a"]);

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

// Pure. Like parseFormField, but returns the field's *entire* rendered block (every line under
// the heading up to the next "### " heading or end of body, trimmed), not just the first
// non-blank line — for a multi-line textarea field such as "Verification checklist" where the
// first line alone would discard every item after it. Returns null when the heading is absent
// or its block is empty / GitHub's own "_No response_" marker for an unanswered field.
//
// Anchors to the *first* matching heading, deliberately the opposite of parseFormField's
// last-match convention. parseFormField reads "Verdict"/"Work issue"/"Exact merge commit",
// fields the template renders *before* "Findings" — so an audit response's own quoted structure
// pasted into Findings (which itself mentions "Verdict") sits earlier in the body than the real
// field, and last-match is what skips past it. "Verification checklist" is the reverse: the
// template renders the real field *before* Findings (see
// .github/ISSUE_TEMPLATE/audit-control-issue.yml), so a response pasted into Findings that
// echoes a "### Verification checklist" heading of its own (per the required response
// structure's item 3) sits *later* in the body. Stage 1 review finding on this PR: matching last
// would read that pasted, possibly-truncated response section as the "requested" checklist
// instead of the original authored one — letting a truncated response redefine the very count it
// is being checked against, and pass trivially. First-match reads the original field regardless
// of what a later Findings paste echoes back.
export function parseFormFieldBlock(body, label) {
  const lines = (body ?? "").split("\n");
  const heading = `### ${label}`;
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === heading) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return null;
  const collected = [];
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("### ")) break;
    collected.push(lines[i]);
  }
  const text = collected.join("\n").trim();
  return text === "" || text === "_No response_" ? null : text;
}

// Pure. Reads the audit-control-issue template's "Verification checklist" field — the
// change-specific, numbered list of checks the audit response is required to work through (see
// .github/ISSUE_TEMPLATE/audit-control-issue.yml). Passed to stage2-report.mjs's
// isCompletedStage2AuditReport as `requestedChecklist` so a response's own checklist
// walk-through is checked for completeness against what was actually requested, not merely
// checked for presence (issue #268 finding 2).
export function parseVerificationChecklistRef(body) {
  return parseFormFieldBlock(body, "Verification checklist");
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
// ending in the number. Returns the literal string "none" for the explicit no-work-issue
// state (issue #190) — a deliberately typed "none"/"n/a" in the (required) field — kept
// distinct from `null`, which still means "the heading is missing or its content doesn't
// parse," an operational error rather than a declared state. Does not treat GitHub's own
// "_No response_" marker for an unanswered field as this sentinel: the field is required
// precisely so that marker can never legitimately appear here (Stage 1 review finding on PR
// #197 against an earlier, optional-field version of this template) — if it somehow does, it
// falls through to the unparseable-content branch below and reports as `null`, not "none".
export function parseWorkIssueRef(body) {
  const value = parseFormField(body, "Work issue");
  if (value === null) return null;
  if (NO_WORK_ISSUE_FIELD_MARKERS.has(value.trim().toLowerCase())) return "none";
  const match = value.match(/#?(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

// Pure. Extracts the frozen Stage 1 reviewed head SHA from the audit issue's own "Stage 1 inline
// review disposition" field, passed through to stage2-report.mjs's `isCompletedStage2AuditReport`
// as `reviewedHeadCommit`. Issue #335 (audit #334): a genuine CLEAN response cited only this
// value — while verifying the checklist's own control-plane-paths item, which the template
// instructs to use the frozen reviewed head, not the merge commit — and `bodyReferencesCommit`
// had no way to explain that in its failure reason.
//
// Does NOT relax target-identity checking: a Stage 1 review finding on the PR that introduced
// this function found that letting `reviewedHeadCommit` substitute for `mergeCommit` was unsafe
// (a response naming an *incorrect* merge commit while still citing the correct reviewed head for
// the workflow-check item would otherwise pass) — see stage2-report.mjs's module comment.
// `mergeCommit` therefore remains unconditionally required; this value is used only to produce a
// more specific failure `reason` string, distinguishing "cites the reviewed head but not the
// required merge commit" from "cites nothing at all."
//
// Scoped narrowly to keep even that diagnostic use trustworthy: only the audit-control-issue
// template's own "Stage 1 inline review disposition" field (pre-trigger content the controlling
// session authors before ever triggering Codex — the reviewer-only boundary in AGENTS.md's Code
// Review Rules means Codex can never edit an issue body to plant a spoofed value here), and only
// the exact "frozen ... head `<sha>`" phrasing that field has used in every real audit issue
// observed so far (e.g. "frozen head `9d775fc...`", issue #330; "frozen head `82651b3c...`",
// issue #334) — allowing a short run of words between "frozen" and "head" (e.g. "frozen Stage 1
// reviewed head") without matching an unrelated later SHA-looking token elsewhere in the block.
// Returns null when the field is absent or does not contain that phrase.
export function parseReviewedHeadCommitRef(body) {
  const block = parseFormFieldBlock(body, "Stage 1 inline review disposition");
  if (!block) return null;
  const match = /\bfrozen\b[^`\n]{0,40}?\bhead\b\s*`([0-9a-f]{7,40})`/i.exec(block);
  return match ? match[1] : null;
}

const SHA_TOKEN_PATTERN = /\b[0-9a-f]{7,40}\b/i;

// Pure. Reads the audit-control-issue template's "Exact merge commit" field — the target
// identity a completed Stage 2 audit response must reference (stage2-report.mjs's
// bodyReferencesCommit), so a genuine response's own evidence is checked against the same
// commit this audit was actually opened for, never a different one. Extracts the standalone
// hex SHA token from the field's rendered value rather than trusting it to be a bare SHA —
// real audit issues wrap it in backticks with trailing annotation (e.g. "`<sha>` (on `main`)",
// the exact shape issue #95's audit used), and requiring the whole field value to be pure hex
// would silently fail to match every real-world entry. Returns null when the heading is absent
// or no hex-looking token is found in its value.
export function parseMergeCommitRef(body) {
  const value = parseFormField(body, "Exact merge commit");
  if (!value) return null;
  const match = SHA_TOKEN_PATTERN.exec(value);
  return match ? match[0] : null;
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
  const noWorkIssue = isNoWorkIssueSentinel(args.issue);
  const issue = noWorkIssue ? null : normalizeIssueNumber(args.issue);
  if (!repo || !pr || (!noWorkIssue && !issue)) {
    return {
      exitCode: 1,
      message:
        "Missing or invalid required args: --repo, --pr are required, and --issue must be a positive integer " +
        `(optionally prefixed with "#") or the literal "none" for an explicit no-work-issue state; ` +
        `got --issue=${JSON.stringify(args.issue)}.`,
    };
  }

  // Explicit no-work-issue state (issue #190): there is no work-issue closure invariant to
  // protect, so this reports that directly instead of inspecting closingIssuesReferences or
  // commits against a nonexistent issue number. This is scoped narrowly — it says nothing
  // about whether Stage 1, CI, or any other merge prerequisite is satisfied; those are
  // separate checks (stage1-gate.mjs, CI) that still apply unchanged.
  if (noWorkIssue) {
    return {
      exitCode: 0,
      state: "MERGE_READY_NO_WORK_ISSUE",
      workIssue: null,
      message:
        `PR ${repo}#${pr} declares no gated work issue (--issue none); the work-issue closing-reference ` +
        `check does not apply. This does not evaluate any other merge prerequisite (Stage 1, CI, etc.).`,
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

// The moment isCompletedStage2AuditReport's strict evidence contract took effect: the merge
// time of LDL PR #231, which introduced it. Stage 2 audit finding on that very PR (issue #233):
// an earlier revision of the legacy-compatibility fallback below was gated only on "is the work
// issue currently closed," with no check that the backing response actually predates this
// contract — so a *new*, post-contract audit whose response was merely a terse "CLEAN" (missing
// the now-required checklist) could still back a closure once the work issue was closed by any
// means, silently masking exactly the premature-closure class this whole mechanism exists to
// catch. A candidate response timestamped at or after this cutoff is never eligible for the
// relaxed check, only for the strict one — see findStage2ReportEvidence's `legacyCutoff` option.
//
// This is a single global LDL-repository timestamp, not a per-consumer-repository adoption
// time (Stage 1 review finding on PR #234, P2/deliberately deferred): `tools/review-watch/` is
// distributed to consumer repositories via `ldl-init`/`ldl-sync` (docs/consumer-contract.md) at
// various later times, so a consumer that has not yet synced past this LDL merge could in
// principle still legitimately accept a terse audit response *after* this cutoff under its own
// then-current, unsynced rules — a later `post-audit` re-run in that consumer would treat that
// response as post-contract and report PREMATURE_CLOSURE, reopening a work issue that consumer
// accepted validly under its own installed revision at the time. Deriving a true per-consumer
// adoption boundary would need a durable per-file sync-version marker this repository does not
// currently track anywhere reachable from this script, and is a distinct, larger mechanism than
// this correction's scope (gating a Loop-Dee-Loup-side evidence-contract bug). The failure mode
// is a recoverable, visible reopen-with-explanation (recoverPrematureClosure), not a silent
// false acceptance — the asymmetric-but-lesser risk this fix's own non-goals accept rather than
// chase indefinitely (see genuine-response.mjs's own "smallest reliable boundary" precedent).
const STAGE2_LEGACY_CONTRACT_CUTOFF = "2026-08-31T09:19:22Z";

// Whether the audit issue's comment thread already carries a *completed* Stage 2 audit report
// (stage2-report.mjs's isCompletedStage2AuditReport) — not merely a genuine-but-incomplete
// response such as issue #229's "Starting #178." kickoff. Reuses trigger.mjs's dedup read,
// never a second, competing definition of "did Stage 2 actually happen" (the same reuse
// discipline stage1-gate.mjs already follows for Stage 1). Every post-trigger bot comment is
// evaluated against its own *full* body (via findCommentById), not findAllMatches' 200-character
// body_excerpt — issue #230 acceptance criteria: evidence beyond the first 200 characters must
// be considered, not just an excerpt. Scans every post-trigger response, not just the first, so
// a kickoff/acknowledgement followed later by a genuine completed report on the same thread
// still gets found (bounded follow-up remains discoverable); the *latest complete* report is
// authoritative when more than one exists (a retry round).
//
// `legacyCutoff`, when given, relaxes the verification-checklist signal *only* for a candidate
// whose own timestamp predates it (see STAGE2_LEGACY_CONTRACT_CUTOFF) — every candidate is
// still evaluated and kept in chronological order, never discarded up front by timestamp alone
// (Stage 1 review finding on PR #234: an earlier revision filtered candidates to
// timestamp-eligible ones *before* evaluating them, so a pre-cutoff terse CLEAN response could
// still be selected as "latest complete" even when a *later*, fully complete NOT CLEAN report
// existed on the same thread — the older grandfathered response silently outranked newer,
// definitive evidence. Evaluating every candidate and keeping the true chronological order means
// a later complete report — of either verdict — always wins over an older, merely-relaxed one).
// `requestedChecklist`, when given (the audit issue's own "Verification checklist" field text
// via parseVerificationChecklistRef), is passed through to isCompletedStage2AuditReport so the
// completeness check in issue #268 finding 2 applies; omitted for the relaxed legacy-
// compatibility evaluation, which already forgives the checklist signal entirely.
// `ghApiImpl` is injected for tests.
async function findStage2ReportEvidence(
  { repo, auditIssue, bot, mergeCommit, requestedChecklist = null, reviewedHeadCommit = null },
  ghApiImpl,
  { legacyCutoff = null } = {},
) {
  const commentsPath = endpointsFor("issue", repo, auditIssue).find((e) => e.name === "issue-comments").path;
  const comments = await ghApiImpl(commentsPath);
  const trigger = findExistingTrigger(comments, {});
  if (!trigger) {
    return { backed: false, verdict: null, responsesSeen: 0, reason: "no @codex review trigger found on the audit issue thread" };
  }

  const sinceMs = new Date(trigger.created_at).getTime();
  const candidates = findAllMatches(comments, { bot, sinceMs, endpointName: "issue-comments" });
  const cutoffMs = legacyCutoff ? new Date(legacyCutoff).getTime() : null;
  const reports = candidates.map((match) => {
    const full = findCommentById(comments, match.id);
    const body = full?.body ?? "";
    const strict = isCompletedStage2AuditReport(body, {
      mergeCommit,
      requireVerificationEvidence: true,
      requestedChecklist,
      reviewedHeadCommit,
    });
    const isPreCutoff = cutoffMs !== null && new Date(match.created_at).getTime() < cutoffMs;
    if (strict.complete || !isPreCutoff) {
      return { id: match.id, url: match.url, legacyCompatible: false, ...strict };
    }
    const relaxed = isCompletedStage2AuditReport(body, { mergeCommit, requireVerificationEvidence: false, reviewedHeadCommit });
    return { id: match.id, url: match.url, legacyCompatible: relaxed.complete, ...relaxed };
  });

  const completed = reports.filter((r) => r.complete);
  if (completed.length === 0) {
    return {
      backed: false,
      verdict: null,
      responsesSeen: reports.length,
      reason:
        reports.length === 0
          ? "no post-trigger bot response found on the audit issue thread"
          : `${reports.length} post-trigger bot response(s) found, none is a completed audit report ` +
            `(${reports.map((r) => r.reasons.join("; ")).join(" | ")})`,
    };
  }

  const latest = completed[completed.length - 1];
  return {
    backed: true,
    verdict: latest.verdict,
    responsesSeen: reports.length,
    matchedCommentUrl: latest.url,
    legacyCompatible: latest.legacyCompatible,
  };
}

// Pure orchestration over already-parsed fields (throws only if `ghApiImpl` throws — callers
// catch and wrap as an operational error the same way every other gh-calling function in this
// file does). Computes whether an audit issue's own recorded verdict is backed CLEAN by a
// completed Stage 2 audit report — the exact evidence contract `checkPostAudit`'s no-work-issue
// branch already applied before this extraction, now shared verbatim with `checkCloseAudit`
// (both its own-verdict evaluation and its candidate-successor re-evaluation) so "is this
// audit's own verdict backed CLEAN" has exactly one implementation, per issue #407's explicit
// instruction not to reimplement or relax this machinery. Deliberately takes no work-issue
// argument at all: this decision never depends on any gated work issue's own open/closed state
// (issue #407 Shared Contract item 3 / the #380/#384 fix).
async function evaluateBackedCleanVerdict(
  { repo, auditIssue, bot, rawVerdict, mergeCommit, requestedChecklist, reviewedHeadCommit },
  ghApiImpl,
) {
  let verdict = rawVerdict;
  let reportEvidence = null;
  if (rawVerdict === "CLEAN") {
    reportEvidence = await findStage2ReportEvidence(
      { repo, auditIssue, bot, mergeCommit, requestedChecklist, reviewedHeadCommit },
      ghApiImpl,
    );
    if (!reportEvidence.backed || reportEvidence.verdict !== "CLEAN") verdict = null;
  }
  return { rawVerdict, verdict, backedClean: verdict === "CLEAN", reportEvidence };
}

// Pure orchestration wrapper around evaluateBackedCleanVerdict for a candidate audit issue's own
// body text — used by checkCloseAudit for both the primary audit issue and every later-created
// candidate successor it considers for supersession. Parses the four fields fresh from `body`
// (mergeCommit/reviewedHeadCommit/requestedChecklist/rawVerdict), since checkCloseAudit
// evaluates a different issue's body on each call, unlike checkPostAudit's single already-parsed
// audit issue.
async function evaluateAuditCloseReadiness(repo, auditIssueNumber, body, { ghApiImpl, bot }) {
  const rawVerdict = parseStage2Verdict(body ?? "");
  const mergeCommit = parseMergeCommitRef(body ?? "");
  const reviewedHeadCommit = parseReviewedHeadCommitRef(body ?? "");
  const requestedChecklist = parseVerificationChecklistRef(body ?? "");
  return evaluateBackedCleanVerdict(
    { repo, auditIssue: auditIssueNumber, bot, rawVerdict, mergeCommit, requestedChecklist, reviewedHeadCommit },
    ghApiImpl,
  );
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

  const workIssueRef = parseWorkIssueRef(auditIssueData.body ?? "");
  if (workIssueRef === null) {
    return {
      exitCode: 1,
      message:
        `Could not find a valid "Work issue" field in audit issue ${repo}#${auditIssue}. The audit-control-` +
        `issue template's Work issue field must name the implementation issue this audit gates, or ` +
        `explicitly type "none" to declare no work issue applies.`,
    };
  }
  // Explicit no-work-issue state (issue #190): distinct from workIssueRef === null above, which
  // is an operational error (missing/malformed field), not a declared state.
  const noWorkIssue = workIssueRef === "none";
  const workIssueNumber = noWorkIssue ? null : workIssueRef;

  const rawVerdict = parseStage2Verdict(auditIssueData.body ?? "");
  const mergeCommit = parseMergeCommitRef(auditIssueData.body ?? "");
  const reviewedHeadCommit = parseReviewedHeadCommitRef(auditIssueData.body ?? "");
  const requestedChecklist = parseVerificationChecklistRef(auditIssueData.body ?? "");

  // Explicit no-work-issue state (issue #190): evaluated first and independently — always
  // strictly (there is no already-closed work issue whose historical closure could need
  // preserving here, so the legacy-compatibility fallback below never applies). An unbacked
  // CLEAN just reports OK; nothing is fetched, reopened, or closed.
  if (noWorkIssue) {
    let evaluated;
    try {
      evaluated = await evaluateBackedCleanVerdict(
        { repo, auditIssue, bot, rawVerdict, mergeCommit, requestedChecklist, reviewedHeadCommit },
        ghApiImpl,
      );
    } catch (err) {
      return {
        exitCode: 1,
        message: `gh api call failed while verifying the CLEAN verdict on ${repo}#${auditIssue}: ${err.message}`,
      };
    }

    // Issue #439: about to fall through to generic OK — the durable Verdict field is not a
    // settled CLEAN (evaluated.verdict !== "CLEAN"; a settled NOT CLEAN keeps its existing,
    // unmodified OK result below). Before reporting that, check whether a completed report
    // already exists for a still-PENDING/malformed field — the live #408/#436 gap, where a
    // fully completed CLEAN report sat unrecorded while this branch reported plain OK and a
    // controller concluded "no completed response has landed."
    if (evaluated.verdict !== "CLEAN" && (rawVerdict === "PENDING" || rawVerdict === null)) {
      let reportEvidence;
      try {
        reportEvidence = await findStage2ReportEvidence(
          { repo, auditIssue, bot, mergeCommit, requestedChecklist, reviewedHeadCommit },
          ghApiImpl,
        );
      } catch (err) {
        return {
          exitCode: 1,
          message: `gh api call failed while checking for completed Stage 2 report evidence on ${repo}#${auditIssue}: ${err.message}`,
        };
      }
      if (reportEvidence.backed) {
        return {
          exitCode: 0,
          state: "REPORT_READY_TO_RECORD",
          workIssue: null,
          auditIssue: Number(auditIssue),
          rawVerdict,
          reportEvidence,
        };
      }
    }

    return {
      exitCode: 0,
      state: evaluated.verdict === "CLEAN" ? "ACCEPTED_NO_WORK_ISSUE" : "OK",
      workIssue: null,
      auditIssue: Number(auditIssue),
      verdict: evaluated.verdict,
      rawVerdict: evaluated.rawVerdict,
      workIssueState: null,
      ...(evaluated.reportEvidence ? { reportEvidence: evaluated.reportEvidence } : {}),
    };
  }

  // Fetched before the CLEAN-evidence decision below (not after, as an earlier revision did) so
  // an already-closed work issue can fall back to the relaxed legacy-compatibility check without
  // a second, separately-ordered round trip.
  let workIssueData;
  try {
    workIssueData = await ghIssueViewImpl({ repo, number: workIssueNumber });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo}#${workIssueNumber}: ${err.message}` };
  }
  const isClosed = workIssueData.state === "CLOSED";

  // A CLEAN dropdown value is only trusted once a *completed* Stage 2 audit report backs it —
  // not merely a genuine-but-incomplete response (Stage 1 review finding on this PR's earlier
  // revision: the template exposes CLEAN as a selectable value at issue *creation*, before
  // Stage 2 has run at all, so reading the field alone would let the gate authorize closing on
  // an unreviewed audit; issue #230's reproduced defect: a kickoff/acknowledgement reply,
  // classified as merely "genuine" rather than "complete," previously satisfied this same
  // check). A completed report whose own stated verdict disagrees with the dropdown — e.g. the
  // dropdown says CLEAN but the actual response says NOT CLEAN — must not back a CLEAN closure
  // either (issue #230 acceptance criteria: "CLEAN entered into the issue body cannot override
  // ... contradictory ... response evidence"). Any raw value other than CLEAN passes through
  // unchanged — PENDING/NOT CLEAN/malformed all correctly keep the work issue open regardless
  // of response provenance.
  let verdict = rawVerdict;
  let reportEvidence = null;
  if (rawVerdict === "CLEAN") {
    // Legacy compatibility (issue #230 Required layer 8: preserve an already-closed work
    // issue's historical CLEAN closure — e.g. issue #95's terse "CLEAN — ... no actionable
    // findings. Next: None." shape, with no numbered checklist — rather than treating it as
    // grounds to reopen the issue) only applies when the work issue is *already* closed, and
    // only relaxes the verification-checklist signal for a candidate response that itself
    // predates STAGE2_LEGACY_CONTRACT_CUTOFF (Stage 2 audit finding on issue #233: being closed
    // alone is not evidence of being historical — without the cutoff, a *new*, post-contract
    // audit whose response is merely terse "CLEAN" could still back a closure once its work
    // issue was closed by any means). findStage2ReportEvidence evaluates every candidate in
    // chronological order regardless of the cutoff (Stage 1 review finding on PR #234: an
    // earlier revision filtered out later candidates before evaluating them, so a later, fully
    // complete NOT CLEAN report could be silently outranked by an older grandfathered CLEAN) —
    // the *latest* complete response, of either verdict, is always authoritative.
    try {
      reportEvidence = await findStage2ReportEvidence(
        { repo, auditIssue, bot, mergeCommit, requestedChecklist, reviewedHeadCommit },
        ghApiImpl,
        { legacyCutoff: isClosed ? STAGE2_LEGACY_CONTRACT_CUTOFF : null },
      );
    } catch (err) {
      return {
        exitCode: 1,
        message: `gh api call failed while verifying the CLEAN verdict on ${repo}#${auditIssue}: ${err.message}`,
      };
    }
    verdict = reportEvidence.backed && reportEvidence.verdict === "CLEAN" ? "CLEAN" : null;
  }

  if (isClosed && verdict !== "CLEAN") {
    return {
      exitCode: 2,
      state: "PREMATURE_CLOSURE",
      workIssue: workIssueNumber,
      auditIssue: Number(auditIssue),
      verdict,
      rawVerdict,
      ...(reportEvidence ? { reportEvidence } : {}),
      message:
        `Work issue ${repo}#${workIssueNumber} is closed but audit issue ${repo}#${auditIssue} records no ` +
        `verified CLEAN verdict (found: ${rawVerdict ?? "none/malformed"}${
          rawVerdict === "CLEAN" ? `, but no completed Stage 2 audit report backs it (${reportEvidence?.reason ?? "not evaluated"})` : ""
        }). Per docs/bounded-review-cycle.md, only a CLEAN Stage 2 disposition may close the work issue. ` +
        `Re-run with --recover true to reopen it.`,
    };
  }

  if (!isClosed && verdict === "CLEAN") {
    return {
      exitCode: 0,
      state: "READY_TO_CLOSE",
      workIssue: workIssueNumber,
      auditIssue: Number(auditIssue),
      verdict,
      ...(reportEvidence ? { reportEvidence } : {}),
    };
  }

  // Issue #439: reached only when neither PREMATURE_CLOSURE nor READY_TO_CLOSE fired above —
  // i.e. the work issue is still open and `verdict` is not the settled CLEAN a completed report
  // already backed (rawVerdict === "CLEAN" only reaches this point when unbacked, in which case
  // `reportEvidence` is already set above and this is a genuine non-completed-report case, not
  // silently re-checked a second way). Narrowly re-checks only the PENDING/malformed case — a
  // settled NOT CLEAN keeps falling through to the unmodified generic OK below unchanged, per
  // the Shared Contract's "existing (unmodified) branches" instruction — for the same
  // live #408/#436 gap the no-work-issue branch above closes: a completed report may already
  // exist on the thread even though the durable field was never fetched for it, because
  // rawVerdict !== "CLEAN" never triggered the block above.
  if (!isClosed && reportEvidence === null && (rawVerdict === "PENDING" || rawVerdict === null)) {
    let pendingReportEvidence;
    try {
      pendingReportEvidence = await findStage2ReportEvidence(
        { repo, auditIssue, bot, mergeCommit, requestedChecklist, reviewedHeadCommit },
        ghApiImpl,
      );
    } catch (err) {
      return {
        exitCode: 1,
        message: `gh api call failed while checking for completed Stage 2 report evidence on ${repo}#${auditIssue}: ${err.message}`,
      };
    }
    if (pendingReportEvidence.backed) {
      return {
        exitCode: 0,
        state: "REPORT_READY_TO_RECORD",
        workIssue: workIssueNumber,
        auditIssue: Number(auditIssue),
        rawVerdict,
        reportEvidence: pendingReportEvidence,
      };
    }
  }

  return {
    exitCode: 0,
    state: "OK",
    workIssue: workIssueNumber,
    auditIssue: Number(auditIssue),
    verdict,
    rawVerdict,
    workIssueState: workIssueData.state,
    ...(reportEvidence ? { reportEvidence } : {}),
  };
}

// Pure. Replaces the audit-control-issue template's rendered "### Verdict" dropdown value in
// `body` with `newVerdict` ("CLEAN" or "NOT CLEAN"). Anchors to the LAST matching "### Verdict"
// heading and rewrites only the first non-blank line beneath it — the exact same anchor and
// value line parseFormField/parseStage2Verdict themselves read (deliberately duplicating that
// anchor logic narrowly rather than sharing a combined read/write helper, so this stays a small,
// auditable diff against the existing read path): if the mutation ever wrote a different line
// than the parser reads, the two would silently disagree and every downstream consumer of
// parseStage2Verdict would see a value record-verdict never actually wrote. Returns null when no
// "### Verdict" heading, or no non-blank value line beneath it, is found — checkRecordVerdict
// then fails closed as an operational error rather than guessing where to write.
export function replaceVerdictField(body, newVerdict) {
  const lines = (body ?? "").split("\n");
  const heading = "### Verdict";
  let headingIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === heading) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return null;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("### ")) break;
    if (lines[i].trim() === "") continue;
    lines[i] = newVerdict;
    return lines.join("\n");
  }
  return null;
}

// Pure. Builds the explanatory comment posted on a real `RECORDED` run — names the recorded
// verdict and the backing evidence comment so a fresh reader never has to re-derive why the
// durable Verdict field changed. Deliberately never restates or summarizes the report's own
// finding content (issue #439's Shared Contract: "never a rewritten or summarized copy of the
// report's actual finding content") — only the mechanically-established evidence pointer
// (verdict + matched comment permalink), the same "post one explanatory comment naming the
// backing evidence" convention close-audit/close-work-issue already use above.
function recordedVerdictComment({ repo, auditIssue, verdict, reportEvidence }) {
  const evidenceRef = reportEvidence?.matchedCommentUrl ?? `this issue's own comment thread (audit issue ${repo}#${auditIssue})`;
  return (
    `Recorded by \`tools/review-watch/lifecycle-gate.mjs record-verdict\`: this audit issue's durable \`Verdict\` ` +
    `field is now set to ${verdict}, backed by a completed Stage 2 audit report (${evidenceRef}). Per ` +
    `docs/bounded-review-cycle.md, this promotion never adjudicates finding substance — it only promotes the ` +
    `report's own already-established structural evidence (merge-commit identity, an explicit verdict, and a ` +
    `complete verification-checklist walk-through) into this issue's durable state (issue #439).`
  );
}

// Deterministic, idempotent, fail-closed-on-conflict verdict-promotion command (issue #439): the
// mechanism `REPORT_READY_TO_RECORD` (checkPostAudit above) authorizes. Reuses checkPostAudit
// internally — never a second evidence parser, never re-adjudicating finding substance — to
// decide whether a completed report already backs a not-yet-recorded verdict, then re-reads the
// audit issue fresh immediately before mutating it: this closes the race window between the
// evidence check and the mutation, and is what gives ALREADY_RECORDED/CONFLICTING_VERDICT their
// own genuine meaning below rather than merely restating checkPostAudit's already-stale read.
// `ghIssueViewImpl`, `ghApiImpl`, `ghEditImpl`, and `ghCommentImpl` are all injected so tests can
// drive this end-to-end without touching the real network or `gh` CLI.
export async function checkRecordVerdict(
  args,
  {
    ghIssueViewImpl = defaultGhIssueView,
    ghApiImpl = defaultGhApi,
    ghEditImpl = defaultGhEditAuditVerdict,
    ghCommentImpl = defaultGhRecordVerdictComment,
    bot = DEFAULT_BOT,
    checkPostAuditImpl = checkPostAudit,
  } = {},
) {
  const { repo, "audit-issue": auditIssue } = args;
  if (!repo || !auditIssue) {
    return { exitCode: 1, message: "Missing required args: --repo and --audit-issue are both required." };
  }

  let postAudit;
  try {
    postAudit = await checkPostAuditImpl(args, { ghIssueViewImpl, ghApiImpl, bot });
  } catch (err) {
    return { exitCode: 1, message: `checkPostAudit threw while evaluating ${repo}#${auditIssue}: ${err.message}` };
  }

  if (postAudit.exitCode === 1) {
    // Not this command's own operational error — pass checkPostAudit's message through
    // unchanged rather than wrapping it, so a caller sees the actual underlying failure.
    return postAudit;
  }

  if (postAudit.state !== "REPORT_READY_TO_RECORD") {
    // Nothing to promote: either no completed report exists yet (checkPostAudit's own existing
    // OK/PENDING result), or the durable field is already a settled value checkPostAudit's own
    // existing (unmodified) branches already evaluated on their own terms — a settled CLEAN
    // backed by evidence reaches READY_TO_CLOSE/ACCEPTED_NO_WORK_ISSUE; a settled CLEAN not
    // backed, a settled NOT CLEAN, or a PREMATURE_CLOSURE all reach their own existing states.
    // Passed through verbatim — this is also what makes a rerun *after* a successful RECORDED
    // idempotent (Shared Contract verification #6): the now-settled verdict reaches
    // checkPostAudit's own existing path exactly as if a human had set the field by hand, never
    // inventing a state this file's vocabulary already covers.
    return postAudit;
  }

  // REPORT_READY_TO_RECORD: checkPostAudit's own precondition for this state already establishes
  // that its read of the durable Verdict field was PENDING/malformed and that reportEvidence
  // backs exactly one verdict (CLEAN or NOT CLEAN). Re-read the audit issue fresh — never trust
  // the value checkPostAudit read a moment ago for the mutation decision itself.
  let auditIssueData;
  try {
    auditIssueData = await ghIssueViewImpl({ repo, number: auditIssue });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo}#${auditIssue}: ${err.message}` };
  }
  const currentRawVerdict = parseStage2Verdict(auditIssueData.body ?? "");
  const evidenceVerdict = postAudit.reportEvidence.verdict;

  if (currentRawVerdict === evidenceVerdict) {
    return {
      exitCode: 0,
      state: "ALREADY_RECORDED",
      auditIssue: postAudit.auditIssue,
      verdict: currentRawVerdict,
      reportEvidence: postAudit.reportEvidence,
    };
  }

  if (currentRawVerdict !== "PENDING" && currentRawVerdict !== null) {
    return {
      exitCode: 2,
      state: "CONFLICTING_VERDICT",
      auditIssue: postAudit.auditIssue,
      recordedVerdict: currentRawVerdict,
      evidenceVerdict,
      reportEvidence: postAudit.reportEvidence,
      message:
        `Refusing to record ${repo}#${auditIssue}'s evidence-backed verdict (${evidenceVerdict}, backed by ` +
        `${postAudit.reportEvidence.matchedCommentUrl ?? "this issue's own comment thread"}) over its already-` +
        `recorded, conflicting durable Verdict field (${currentRawVerdict}). This is never silently overwritten; ` +
        `resolve the conflict by hand.`,
    };
  }

  const newBody = replaceVerdictField(auditIssueData.body ?? "", evidenceVerdict);
  if (newBody === null) {
    return {
      exitCode: 1,
      message: `Could not find a "### Verdict" field to update in audit issue ${repo}#${auditIssue}'s body.`,
    };
  }

  try {
    await ghEditImpl({ repo, auditIssue, body: newBody });
  } catch (err) {
    return { exitCode: 1, message: `gh issue edit failed for ${repo}#${auditIssue}: ${err.message}` };
  }

  let commentPosted = true;
  let commentError = null;
  try {
    await ghCommentImpl({ repo, auditIssue, verdict: evidenceVerdict, reportEvidence: postAudit.reportEvidence });
  } catch (err) {
    commentPosted = false;
    commentError = err.message;
  }

  return {
    exitCode: 0,
    state: "RECORDED",
    auditIssue: postAudit.auditIssue,
    verdict: evidenceVerdict,
    reportEvidence: postAudit.reportEvidence,
    commentPosted,
    ...(commentError
      ? {
          commentError,
          message:
            `Recorded ${repo}#${auditIssue}'s Verdict field as ${evidenceVerdict}, but could not post the ` +
            `durable explanation comment: ${commentError}. The field is recorded; a follow-up should post the ` +
            `explanation by hand (rerunning record-verdict will not retry this step on its own, since the issue ` +
            `now reads as a settled verdict, not REPORT_READY_TO_RECORD).`,
        }
      : {}),
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

// Pure. Builds the explanatory comment posted on a real (non-dry-run) `CLOSED` run — this
// audit's own verdict is backed CLEAN, independent of the gated work issue's state (the
// #380/#384 fix). Names the backing evidence (the matched completed-report comment URL) so a
// fresh reader never has to re-derive why this audit issue was closed.
function ownCleanCloseComment({ repo, auditIssue, reportEvidence }) {
  const evidenceRef = reportEvidence?.matchedCommentUrl ?? `this issue's own comment thread (audit issue ${repo}#${auditIssue})`;
  return (
    `Closed by \`tools/review-watch/lifecycle-gate.mjs close-audit\`: this audit issue's own recorded verdict is ` +
    `backed CLEAN by a completed Stage 2 audit report (${evidenceRef}). Per docs/bounded-review-cycle.md, a CLEAN ` +
    `Stage 2 disposition on this audit issue is terminal regardless of the gated work issue's own open/closed ` +
    `state — a Stage 2 audit's verdict is not fully consumed until the audit artifact itself reaches truthful ` +
    `durable terminal state (issue #407, the #380/#384 fix).`
  );
}

// Pure. Builds the explanatory comment posted on a real (non-dry-run) `SUPERSEDED_CLOSED` run —
// this audit's own verdict is not backed CLEAN, but a distinct, later-created audit issue naming
// the same work issue independently resolves to CLOSE_READY/CLOSED. Modeled on the real,
// founder-authored precedent that closed issue #396 by hand ("Superseded by the correction chain
// terminating in Stage 2 audit #406 (CLEAN). See control issue #306's closing state for the full
// chain.") — naming the specific superseding issue and its own backing evidence, never merely
// "a later audit exists."
function supersededCloseComment({ repo, supersededBy, reportEvidence }) {
  const evidenceRef = reportEvidence?.matchedCommentUrl ?? `its own completed Stage 2 audit report (audit issue ${repo}#${supersededBy})`;
  return (
    `Closed by \`tools/review-watch/lifecycle-gate.mjs close-audit\`: this audit issue's own verdict is not backed ` +
    `CLEAN, but a distinct, later-created audit issue naming the same work issue — #${supersededBy} — ` +
    `independently resolves to CLOSE_READY/CLOSED under this same evidence contract (backed by ${evidenceRef}), ` +
    `not merely by existing, being numbered later, or sharing a similar title. Superseded by that correction ` +
    `chain; see #${supersededBy} for its own closing evidence (issue #407, the #396→#406 correction-chain fix).`
  );
}

// `ghCloseImpl` and `ghCommentImpl` are injected so tests can drive this without touching the
// real network or `gh` CLI, and are kept as two independently-failing steps — close first, then
// comment — mirroring recoverPrematureClosure's own precedent above, but in the opposite order:
// closing is the primary, idempotency-observable state change here (unlike recovery, where
// reopening is), so a rerun after a successful close sees ALREADY_TERMINAL immediately and never
// re-attempts either step — never a duplicate close, and never a duplicate explanatory comment,
// even if the comment step itself fails and is never automatically retried.
async function performCloseAudit(kind, { repo, auditIssue, body }, { ghCloseImpl, ghCommentImpl }) {
  try {
    await ghCloseImpl({ repo, auditIssue });
  } catch (err) {
    return { exitCode: 1, message: `gh issue close failed for ${repo}#${auditIssue}: ${err.message}` };
  }

  let commentPosted = true;
  let commentError = null;
  try {
    await ghCommentImpl({ repo, auditIssue, body });
  } catch (err) {
    commentPosted = false;
    commentError = err.message;
  }

  return {
    exitCode: 0,
    state: kind,
    auditIssue,
    commentPosted,
    ...(commentError
      ? {
          commentError,
          message:
            `Closed ${repo}#${auditIssue}, but could not post the durable explanation comment: ${commentError}. ` +
            `The issue is closed; a follow-up should post the explanation by hand (rerunning close-audit will not ` +
            `retry this step on its own, since the issue now reads as ALREADY_TERMINAL).`,
        }
      : {}),
  };
}

// Pure. Builds the explanatory comment posted on a real (non-dry-run) work-issue close —
// names the backing Stage 2 audit issue so a fresh reader never has to re-derive why this
// work issue was closed by automation rather than by GitHub auto-close (Stage 1 step 8
// deliberately forbids the latter).
function closeWorkIssueComment({ repo, auditIssue }) {
  return (
    `Closed by \`tools/review-watch/lifecycle-gate.mjs close-work-issue\`: Stage 2 audit issue ` +
    `${repo}#${auditIssue} recorded a CLEAN verdict backed by a completed Stage 2 audit report. Per ` +
    `docs/bounded-review-cycle.md, merge != acceptance — only a CLEAN Stage 2 disposition may close a ` +
    `review-worthy implementation issue, never GitHub auto-close on merge (issue #156).`
  );
}

// Deterministic, idempotent work-issue close-out command (Stage 1 review finding on PR #435,
// issue #407's own #380/#384 fix carried one step further): `checkCloseAudit`/`close-audit`
// deliberately never touches the gated work issue at all (Shared Contract item 3 — this
// audit's own terminal state must never depend on it), which correctly closed the audit-side
// gap but left the *work*-issue side of `STAGE2_CLOSE_READY` as only a prose reminder ("also
// close the implemented work issue itself") — exactly the kind of mechanically-unenforced step
// that already proved insufficient once for the audit issue itself. This is a separate,
// narrowly-scoped command rather than a change to `close-audit`'s own behavior, so
// `checkCloseAudit`'s documented independence from work-issue state is preserved unchanged.
// `ghIssueViewImpl`, `ghCloseImpl`, and `ghCommentImpl` are all injected so tests can drive
// this end-to-end without touching the real network or `gh` CLI.
export async function checkCloseWorkIssue(
  args,
  { ghIssueViewImpl = defaultGhIssueView, ghCloseImpl = defaultGhCloseWorkIssue, ghCommentImpl = defaultGhCloseWorkIssueComment } = {},
) {
  const { repo, "work-issue": workIssue, "audit-issue": auditIssue } = args;
  if (!repo || !workIssue || !auditIssue) {
    return { exitCode: 1, message: "Missing required args: --repo, --work-issue, and --audit-issue are all required." };
  }
  const workIssueNumber = Number(workIssue);
  const auditIssueNumber = Number(auditIssue);

  let workIssueData;
  try {
    workIssueData = await ghIssueViewImpl({ repo, number: workIssue });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo}#${workIssue}: ${err.message}` };
  }

  // Safe no-op regardless of caller: an already-closed work issue is already terminal, so a
  // rerun (e.g. a fresh session resuming after a prior close, or after this command's own
  // comment step failed) never re-attempts either mutation.
  if (workIssueData.state === "CLOSED") {
    return { exitCode: 0, state: "ALREADY_TERMINAL", workIssue: workIssueNumber };
  }

  try {
    await ghCloseImpl({ repo, workIssue: workIssueNumber });
  } catch (err) {
    return { exitCode: 1, message: `gh issue close failed for ${repo}#${workIssue}: ${err.message}` };
  }

  let commentPosted = true;
  let commentError = null;
  try {
    await ghCommentImpl({ repo, workIssue: workIssueNumber, auditIssue: auditIssueNumber });
  } catch (err) {
    commentPosted = false;
    commentError = err.message;
  }

  return {
    exitCode: 0,
    state: "CLOSED",
    workIssue: workIssueNumber,
    commentPosted,
    ...(commentError
      ? {
          commentError,
          message:
            `Closed ${repo}#${workIssue}, but could not post the durable explanation comment: ${commentError}. ` +
            `The issue is closed; a follow-up should post the explanation by hand (rerunning close-work-issue will ` +
            `not retry this step on its own, since the issue now reads as ALREADY_TERMINAL).`,
        }
      : {}),
  };
}

// Deterministic, idempotent audit-issue terminalization predicate and close-out command (issue
// #407) — see this file's module comment for the full state vocabulary and rationale.
// `ghIssueViewImpl`, `ghApiImpl`, `ghIssueListImpl`, `ghCloseImpl`, and `ghCommentImpl` are all
// injected so tests can drive this end-to-end without touching the real network or `gh` CLI.
//
// Deliberately never fetches the gated work issue at all (contrast checkPostAudit's normal
// branch, which must): this audit's own terminal state never depends on the work issue's
// open/closed state (the #380/#384 fix — Shared Contract item 3), so there is nothing to look
// up there.
export async function checkCloseAudit(
  args,
  {
    ghIssueViewImpl = defaultGhIssueView,
    ghApiImpl = defaultGhApi,
    ghIssueListImpl = defaultGhIssueList,
    ghCloseImpl = defaultGhCloseAuditIssue,
    ghCommentImpl = defaultGhCloseAuditComment,
    bot = DEFAULT_BOT,
  } = {},
) {
  const { repo, "audit-issue": auditIssue } = args;
  if (!repo || !auditIssue) {
    return { exitCode: 1, message: "Missing required args: --repo and --audit-issue are both required." };
  }
  const dryRun = args["dry-run"] === "true" || args["dry-run"] === "1";
  const auditIssueNumber = Number(auditIssue);

  let auditData;
  try {
    auditData = await ghIssueViewImpl({ repo, number: auditIssue });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo}#${auditIssue}: ${err.message}` };
  }

  // Safe no-op regardless of --dry-run: an already-closed audit issue is already terminal, so
  // there is nothing to compute or mutate. Checked before any evidence evaluation so a rerun
  // against a just-closed issue never re-derives (or re-posts) anything.
  if (auditData.state === "CLOSED") {
    return { exitCode: 0, state: "ALREADY_TERMINAL", auditIssue: auditIssueNumber };
  }

  let own;
  try {
    own = await evaluateAuditCloseReadiness(repo, auditIssueNumber, auditData.body ?? "", { ghApiImpl, bot });
  } catch (err) {
    return { exitCode: 1, message: `gh api call failed while evaluating audit issue ${repo}#${auditIssue}: ${err.message}` };
  }

  // (a) This audit's own verdict is backed CLEAN — close regardless of the gated work issue's
  // state (the #380/#384 fix). No supersession search is needed or performed.
  if (own.backedClean) {
    if (dryRun) {
      return { exitCode: 0, state: "CLOSE_READY", auditIssue: auditIssueNumber, reportEvidence: own.reportEvidence };
    }
    return performCloseAudit(
      "CLOSED",
      { repo, auditIssue: auditIssueNumber, body: ownCleanCloseComment({ repo, auditIssue: auditIssueNumber, reportEvidence: own.reportEvidence }) },
      { ghCloseImpl, ghCommentImpl },
    );
  }

  // (b) Not backed CLEAN on its own — look for a distinct, later-created successor audit issue
  // naming the same Work issue that independently resolves to CLOSE_READY/CLOSED (the
  // #396→#406 correction-chain fix). Requires a real, non-"none" Work issue reference: with no
  // work issue (or an unparseable field), there is no shared key to search successors against.
  const workIssueRef = parseWorkIssueRef(auditData.body ?? "");
  if (workIssueRef === null || workIssueRef === "none") {
    return {
      exitCode: 0,
      state: "NOT_TERMINAL_YET",
      auditIssue: auditIssueNumber,
      rawVerdict: own.rawVerdict,
      reason:
        workIssueRef === null
          ? "audit issue has no valid Work issue field, so no supersession search is possible"
          : `audit issue declares no gated work issue (Work issue: none), so no supersession search applies` +
            (own.reportEvidence ? ` (${own.reportEvidence.reason})` : ""),
    };
  }

  let candidates;
  try {
    candidates = await ghIssueListImpl({ repo });
  } catch (err) {
    return { exitCode: 1, message: `gh issue list failed for ${repo}: ${err.message}` };
  }

  const auditCreatedMs = new Date(auditData.createdAt ?? 0).getTime();
  // Sorted oldest-created-first so that, when more than one later candidate independently
  // qualifies (a correction chain longer than two issues), the earliest qualifying successor is
  // found first — deterministic regardless of gh issue list's own return order.
  const sortedCandidates = [...candidates].sort(
    (a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime(),
  );

  let supersededBy = null;
  for (const candidate of sortedCandidates) {
    if (Number(candidate.number) === auditIssueNumber) continue;
    const candidateCreatedMs = new Date(candidate.createdAt ?? 0).getTime();
    if (!(candidateCreatedMs > auditCreatedMs)) continue;
    const candidateWorkIssueRef = parseWorkIssueRef(candidate.body ?? "");
    if (candidateWorkIssueRef !== workIssueRef) continue;

    let candidateOwn;
    try {
      candidateOwn = await evaluateAuditCloseReadiness(repo, Number(candidate.number), candidate.body ?? "", { ghApiImpl, bot });
    } catch (err) {
      return {
        exitCode: 1,
        message: `gh api call failed while evaluating candidate successor audit issue ${repo}#${candidate.number}: ${err.message}`,
      };
    }
    if (candidateOwn.backedClean) {
      supersededBy = { number: Number(candidate.number), reportEvidence: candidateOwn.reportEvidence };
      break;
    }
  }

  if (supersededBy) {
    if (dryRun) {
      return {
        exitCode: 0,
        state: "SUPERSEDED_CLOSE_READY",
        auditIssue: auditIssueNumber,
        supersededBy: supersededBy.number,
        reportEvidence: supersededBy.reportEvidence,
      };
    }
    return performCloseAudit(
      "SUPERSEDED_CLOSED",
      {
        repo,
        auditIssue: auditIssueNumber,
        body: supersededCloseComment({ repo, supersededBy: supersededBy.number, reportEvidence: supersededBy.reportEvidence }),
      },
      { ghCloseImpl, ghCommentImpl },
    );
  }

  // (c) Neither this audit's own evidence nor any later successor's backs a close — this audit
  // correctly stays open. A normal, non-error result, not a failure.
  return {
    exitCode: 0,
    state: "NOT_TERMINAL_YET",
    auditIssue: auditIssueNumber,
    rawVerdict: own.rawVerdict,
    reason:
      own.rawVerdict === "PENDING"
        ? "verdict is PENDING and no qualifying later successor audit was found"
        : own.reportEvidence
          ? `${own.reportEvidence.reason}, and no qualifying later successor audit was found`
          : "no qualifying later successor audit was found",
  };
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
  // `createdAt` is fetched unconditionally (not only for close-audit's callers) — a harmless
  // extra field for merge-ready/post-audit, and what checkCloseAudit needs to compare this
  // audit issue's own creation time against a candidate successor's (Shared Contract item 6:
  // "created after," never issue-number comparison).
  const raw = execFileSync("gh", ["issue", "view", String(number), "--repo", repo, "--json", "body,state,createdAt"], {
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

// Pure. Normalizes one page of the REST Search API's `/search/issues` response shape (`{
// total_count, incomplete_results, items: [...] }`, each item's fields in GitHub's REST
// snake_case with a lowercase "open"/"closed" state) into the same { number, title, body,
// state, createdAt } shape `gh issue list --json` produces, which checkCloseAudit's candidate
// walk (parseWorkIssueRef(candidate.body), candidate.createdAt, candidate.number) already
// expects. The Search API's result set can include pull requests matching the same query
// text; `pull_request` is present only on those, so filtering it out keeps candidates to
// actual issues, matching what `gh issue list` itself would have returned.
export function normalizeSearchIssuesPage(page) {
  return (page?.items ?? [])
    .filter((item) => !item.pull_request)
    .map((item) => ({
      number: item.number,
      title: item.title,
      body: item.body,
      state: item.state === "open" ? "OPEN" : "CLOSED",
      createdAt: item.created_at,
    }));
}

// Candidate-discovery only (Shared Contract item 7): the "[Audit]" title prefix enumerates
// candidate successor issues for checkCloseAudit's supersession search. The literal title text
// never itself authorizes a close — every candidate found this way is still independently
// re-evaluated through evaluateAuditCloseReadiness against its own structured fields.
//
// Stage 1 review finding on PR #435: `gh issue list --limit 200` silently drops every
// candidate past the 200th once a repository's own `[Audit]`-titled corpus grows beyond that —
// `gh issue list --help` documents `--limit` as "Maximum number of issues to fetch," a hard
// truncation, not a page size, and sorting the returned array afterward cannot recover an
// omitted issue. Fetches the REST Search API directly instead (`gh api search/issues`, the
// same `--paginate --slurp` idiom `defaultGhApi` above already uses for issue-comments pages),
// which follows the response's own `Link: rel="next"` header until exhausted rather than
// stopping at one fixed page — recovering every candidate up to GitHub Search's own
// documented 1,000-result ceiling, a platform limit this script cannot raise, rather than an
// arbitrary client-side cap chosen without evidence of the real corpus size.
function defaultGhIssueList({ repo }) {
  const raw = execFileSync(
    "gh",
    [
      "api", "search/issues",
      // `-X GET` is required: `gh api` defaults to POST once any `-f` field is present, but
      // `search/issues` only accepts `q` as a GET query parameter.
      "-X", "GET",
      "-f", `q=[Audit] in:title repo:${repo}`,
      "-f", "per_page=100",
      "--paginate", "--slurp",
    ],
    // Same rationale as issue #407's own maxBuffer fix above: full issue `body` text across a
    // multi-page `[Audit]` corpus can exceed Node's 1 MiB execFileSync default.
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  const pages = JSON.parse(raw);
  return pages.flatMap((page) => normalizeSearchIssuesPage(page));
}

// `--body-file -` (stdin) rather than `--body <text>`: the rewritten issue body is the audit
// issue's own full multi-field body text, which can exceed a shell's argv length limit and,
// unlike `--body`, is never subject to the argv-escaping risk of passing arbitrary Markdown
// (backticks, `#N` references, etc.) as a single execFileSync argument. `execFileSync`'s
// `input` option pipes it via stdin directly, with no shell involved.
function defaultGhEditAuditVerdict({ repo, auditIssue, body }) {
  execFileSync("gh", ["issue", "edit", String(auditIssue), "--repo", repo, "--body-file", "-"], {
    encoding: "utf8",
    input: body,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function defaultGhRecordVerdictComment({ repo, auditIssue, verdict, reportEvidence }) {
  const body = recordedVerdictComment({ repo, auditIssue, verdict, reportEvidence });
  execFileSync("gh", ["issue", "comment", String(auditIssue), "--repo", repo, "--body", body], { encoding: "utf8" });
}

function defaultGhCloseAuditIssue({ repo, auditIssue }) {
  execFileSync("gh", ["issue", "close", String(auditIssue), "--repo", repo], { encoding: "utf8" });
}

function defaultGhCloseAuditComment({ repo, auditIssue, body }) {
  execFileSync("gh", ["issue", "comment", String(auditIssue), "--repo", repo, "--body", body], { encoding: "utf8" });
}

function defaultGhCloseWorkIssue({ repo, workIssue }) {
  execFileSync("gh", ["issue", "close", String(workIssue), "--repo", repo], { encoding: "utf8" });
}

function defaultGhCloseWorkIssueComment({ repo, workIssue, auditIssue }) {
  const body = closeWorkIssueComment({ repo, auditIssue });
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

  if (subcommand === "record-verdict") {
    const result = await checkRecordVerdict(args);
    if (result.exitCode === 1) {
      console.error(result.message);
      process.exit(1);
      return;
    }
    console.log(JSON.stringify(result));
    process.exit(result.exitCode);
    return;
  }

  if (subcommand === "close-audit") {
    const result = await checkCloseAudit(args);
    if (result.exitCode === 1) {
      console.error(result.message);
      process.exit(1);
      return;
    }
    console.log(JSON.stringify(result));
    process.exit(result.exitCode);
    return;
  }

  if (subcommand === "close-work-issue") {
    const result = await checkCloseWorkIssue(args);
    if (result.exitCode === 1) {
      console.error(result.message);
      process.exit(1);
      return;
    }
    console.log(JSON.stringify(result));
    process.exit(result.exitCode);
    return;
  }

  console.error(
    `Unknown subcommand: ${subcommand ?? "(none)"}. Use "merge-ready", "post-audit", "record-verdict", "close-audit", or "close-work-issue".`,
  );
  process.exit(1);
}

// Only run as a CLI when invoked directly, not when the test file imports these functions.
if (process.argv[1] && process.argv[1].endsWith("lifecycle-gate.mjs")) {
  main();
}
