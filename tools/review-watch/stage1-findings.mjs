// Stage 1 findings-bearing evidence contract (issue #638): distinguishes a genuine Stage 1
// response that reports actionable findings from one that reports no actionable findings
// ("clean"), and identifies which GitHub API surface (endpoint) a genuine matched response
// item came from. `pull-comments` (an inline PR review comment) and `pull-reviews` (a formal
// PR review submission) both carry durable reviewer provenance and, per issue #163, exact-
// head commit identity GitHub itself assigns; `issue-comments` (a plain top-level PR
// conversation comment) carries neither.
//
// Live reproduction: PR #637's Stage 1 round posted only a findings-bearing top-level PR
// Issue comment — trigger `#issuecomment-5712321853`, response `#issuecomment-5712333910`
// (a substantive P1 finding), with `pull_request_review_id: null` — i.e. no formal review
// object at all. `stage1-gate.mjs` previously accepted any genuine bound match regardless of
// which endpoint it came from, so that response alone satisfied `RESPONSE_RECEIVED` despite
// carrying no durable review-object provenance for its finding, and despite #163's own
// contract already distinguishing formal review/review-comment objects (which carry commit
// identity) from plain issue comments (which often do not).
//
// This module supplies the narrow evidence rule `stage1-gate.mjs` composes: a findings-
// bearing round must be backed by at least one genuine match on a formal-review endpoint
// (`isFormalReviewEndpoint`); a *clean* (no-actionable-findings) round is unaffected and
// keeps today's behavior — any genuine bound match, on any endpoint, satisfies it, exactly
// as before this issue (issue #638's own "Clean/no-actionable response regression"
// requirement).
//
// `isFindingsBearingResponse` is deliberately narrow and structural, in the same spirit as
// genuine-response.mjs's and stage2-report.mjs's own Non-goals (no arbitrary Markdown
// parsing, no semantic adjudication of finding validity): it recognizes a small, explicit
// set of "no issues" phrasings actually observed from Codex Stage 1 replies (see this
// module's own tests, and stage1-gate.test.mjs's pre-existing "No issues found."/"LGTM"
// fixtures) and, failing that, classifies the response as findings-bearing by default —
// fail-closed, per issue #638's own Required layers ("If the provider produces only a
// substantive findings-bearing Issue comment and no qualifying review artifact, fail closed
// ... do not silently degrade it to RESPONSE_RECEIVED/satisfied"). A longer genuine "no
// issues" reply that happens to exceed `poll.mjs`'s 200-character `body_excerpt` truncation
// also falls on the findings-bearing (stricter) side rather than matching this narrow
// allowlist — an accepted, safe-direction tradeoff: requiring formal evidence for an
// actually-clean-but-verbose reply is the over-cautious failure mode, never the under-
// cautious one that would let a real finding through unbacked.
//
// Deliberately excludes explicit textual commit citations ("Reviewed commit: <sha>") from
// ever substituting for GitHub's own review-object provenance (issue #638 required check 6):
// this module only ever looks at a match's `endpoint`, never at parsed prose, to decide
// whether it carries formal reviewer provenance. Classifying *content* (clean vs. findings-
// bearing) and classifying *provenance* (formal vs. plain surface) are kept as two
// independent, single-purpose checks for exactly this reason — neither can be satisfied by
// the other.
//
// isCleanReviewResponse also recognizes Codex's own fixed clean-pass preamble already
// documented and relied on by consumer-sync-gate.mjs's (independent) `CLEAN_REVIEW_PATTERN`
// — "Codex Review: Didn't find any major issues.", observed live and unchanged on this
// repository's own merged PRs (e.g. #257, #266), delivered as a plain top-level PR Issue
// comment. Without this, a genuine real-world clean-pass reply arriving on the
// issue-comments endpoint (the exact surface consumer-sync-gate.mjs's whole automated flow
// depends on) would be misclassified as findings-bearing by this module's own fail-closed
// default and incorrectly report FINDINGS_LACK_FORMAL_REVIEW instead of RESPONSE_RECEIVED —
// a regression this issue's own "Clean/no-actionable response regression" required check
// exists to prevent. Not deduplicated into a shared constant with consumer-sync-gate.mjs/
// next-review-transition-gate.mjs's own (already independently duplicated between those two
// files) pattern: those two perform a different, aggregate-level "does this whole round have
// a clean match and no findings match" computation this module does not reproduce, and
// refactoring their existing, separately-tested logic is out of this issue's scope
// (Non-goals: do not redesign Stage 1 finding disposition or correction-satisfied
// semantics). Keeping the exact same literal pattern text here is what keeps the two
// independent checks from silently diverging on what counts as Codex's known clean-pass
// reply.

import { stripLeadingMarkdownWrapper } from "./genuine-response.mjs";

const CLEAN_REVIEW_PATTERN = /^Codex Review: Didn't find any major issues\./;

// Stage 2 audit #672 (P1): the fixed clean-pass preamble is a prefix match by design (genuine
// clean-pass replies carry harmless trailing pleasantries, e.g. "Nice work!" — see this
// module's own regression test), but checking only for an *absent* severity marker
// (SEVERITY_MARKER_PATTERN, the prior approach) was the wrong test: a genuine trailing finding
// that simply omits Codex's own "P0"–"P3" label — e.g. "Codex Review: Didn't find any major
// issues. However, credentials are logged." — has no severity marker either, so it was
// misclassified clean and could bypass FINDINGS_LACK_FORMAL_REVIEW entirely. The correct rule
// is the inverse: only a small, explicit allowlist of harmless trailing clauses actually
// observed from a genuine Codex clean-pass reply may follow the preamble; anything else — with
// or without a severity marker — is treated as a potential real finding and fails closed as
// findings-bearing. Same discipline as LEADING_SUMMARY_CLAUSE_PATTERN below: each entry here
// must be a trailing clause actually observed live, not a guess at what a harmless one might
// look like.
//
// PR #673 Stage 1 review finding (P2): "Nice work!" was the only allowlisted trailing clause,
// but consumer-sync-gate.mjs's own CLEAN_REVIEW_PATTERN documents this preamble's second
// sentence as varying, and consumer-sync-gate.test.mjs's own long-standing fixture (line ~506)
// already treats "Codex Review: Didn't find any major issues. Can't wait for the next one!" as
// a genuine clean response. Without also allowlisting it here, this module's own fail-closed
// default reported that same genuine clean-pass reply as findings-bearing
// (FINDINGS_LACK_FORMAL_REVIEW), blocking the plain issue-comments-only surface
// consumer-sync-gate.mjs's whole automated flow depends on before its own downstream clean
// check ever ran — the two independent classifiers must keep the same known-clean-suffix set.
const CLEAN_PREAMBLE_TRAILING_PATTERN = /^(?:\s*(?:nice work|can't wait for the next one)[!.]?)?\s*$/i;

const FORMAL_REVIEW_ENDPOINTS = new Set(["pull-comments", "pull-reviews"]);

// Pure. Whether `endpointName` (poll.mjs's `endpointsFor` naming: "pull-comments",
// "pull-reviews", "issue-comments") is a formal GitHub PR review artifact — an inline review
// comment or a review submission — as opposed to a plain top-level PR conversation comment.
export function isFormalReviewEndpoint(endpointName) {
  return FORMAL_REVIEW_ENDPOINTS.has(endpointName);
}

// Mirrors stripLeadingMarkdownWrapper's own opening-marker normalization but for a matching
// *closing* wrapper this module's own end-anchored clean patterns need to see past —
// genuine-response.mjs's own checks (isCodexCloudSetupPrompt, BLOCKED_STATUS_PATTERN, etc.) are
// never end-anchored, so it has never needed this (PR #640 Stage 1 review finding #4: "**LGTM**",
// "- **No issues found.**", and "> _Looks good._" all left a dangling closing */_ marker that
// made every end-anchored clean pattern below fail, forcing an unrecoverable
// FINDINGS_LACK_FORMAL_REVIEW founder interrupt on an actually clean reply).
function stripTrailingMarkdownWrapper(text) {
  let s = text ?? "";
  let prev;
  do {
    prev = s;
    s = s.replace(/\s+$/, "");
    s = s.replace(/[*_]{1,3}$/, "");
  } while (s !== prev);
  return s;
}

// A leading summary clause some genuine Stage 1 clean replies open with before the actual
// no-issues statement — matches this repo's own existing fixtures: "Reviewed. No issues
// found.", "Reviewed after retry. No issues found.", "Reviewed head B. No issues found.",
// the consumer-sync-gate.test.mjs YouTubery #98 regression fixture "Looks correct, no issues
// found.", and (PR #640 Stage 1 review finding #3) the documented "Looks good, no issues
// found." shape. Stripped, if present, before the no-issues check below so it can anchor to
// what's left rather than requiring the no-issues phrase to be the very first word of the
// message. Deliberately a small, explicit allowlist of known lead-in verbs — not a generic
// bounded-clause stripper — consistent with this module's own Non-goals (no arbitrary
// Markdown/prose parsing): each addition here must be a lead-in actually observed from a
// genuine clean reply, not a guess at what one might look like.
const LEADING_SUMMARY_CLAUSE_PATTERN = /^(?:reviewed|looks?\s+correct|looks?\s+good)\b[^.!?,]*[.!,]?\s*/i;

// The response, once any leading summary clause above is stripped, states nothing but a
// short, explicit "no issues" declaration and nothing else — matched to the *end* of the
// (possibly excerpt-truncated) string, not merely as a prefix, so a longer response that
// happens to open with a clean-sounding clause but goes on to describe an actual finding is
// never misclassified as clean.
const NO_ISSUES_PATTERN =
  /^(?:no\s+(?:actionable\s+)?(?:issues?|findings?|problems?|defects?)(?:\s+(?:found|identified|noted))?|nothing\s+(?:further|actionable)(?:\s+(?:found|noted))?)[.!]?\s*$/i;
const LGTM_PATTERN = /^lgtm[.!]?\s*$/i;
const LOOKS_GOOD_PATTERN = /^looks\s+good(?:\s+to\s+me)?[.!]?\s*$/i;

// Pure. Whether `bodyExcerpt` (poll.mjs's truncated `body_excerpt`, or a full body) reports
// no actionable findings ("clean"), using the same leading-Markdown-wrapper-stripping
// discipline as genuine-response.mjs's own isGenuineResponse — plus this module's own
// symmetric trailing-wrapper strip (stripTrailingMarkdownWrapper) — so a heading/list/
// blockquote/emphasis-wrapped clean reply is still recognized even when the emphasis marker
// closes (PR #640 Stage 1 review finding #4).
export function isCleanReviewResponse(bodyExcerpt) {
  const stripped = stripTrailingMarkdownWrapper(stripLeadingMarkdownWrapper(bodyExcerpt ?? "").trim()).trim();
  const cleanPreambleMatch = CLEAN_REVIEW_PATTERN.exec(stripped);
  if (cleanPreambleMatch) {
    // PR #640 Stage 1 review finding #2 / Stage 2 audit #672 (P1): the fixed clean-pass
    // preamble is a prefix match by design, but a genuine trailing finding — labeled with a
    // severity marker or not — must still be rejected rather than hidden behind that same
    // prefix. Only the narrow CLEAN_PREAMBLE_TRAILING_PATTERN allowlist may follow it.
    const trailing = stripped.slice(cleanPreambleMatch[0].length);
    return CLEAN_PREAMBLE_TRAILING_PATTERN.test(trailing);
  }
  const isKnownCleanShape = (text) =>
    NO_ISSUES_PATTERN.test(text) || LGTM_PATTERN.test(text) || LOOKS_GOOD_PATTERN.test(text);
  if (isKnownCleanShape(stripped)) return true;
  // Only fall back to the summary-clause-stripped form when the unstripped text itself isn't
  // already a recognized clean shape — this is what keeps "Looks good to me." (no lead-in
  // clause needs stripping) and "Looks good, no issues found." (the lead-in clause must be
  // stripped before the trailing no-issues phrase can be recognized) both working without one
  // clobbering the other.
  const afterSummaryClause = stripped.replace(LEADING_SUMMARY_CLAUSE_PATTERN, "").trim();
  return isKnownCleanShape(afterSummaryClause);
}

// Pure. The inverse of isCleanReviewResponse: whether a genuine matched response should be
// treated as reporting actionable findings for Stage 1's evidence rule. Fail-closed by
// construction — see this module's header comment.
export function isFindingsBearingResponse(bodyExcerpt) {
  return !isCleanReviewResponse(bodyExcerpt);
}
