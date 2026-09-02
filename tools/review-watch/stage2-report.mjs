// Stage 2 completed-audit-report evidence contract (issue #230): distinguishes a genuine
// *completed* Stage 2 audit response from an acknowledgement, kickoff, task-link-only, or
// otherwise incomplete reply on the same thread.
//
// Reproduced defect: issue #229's Codex reply was "Starting #178." followed by a task link.
// genuine-response.mjs's isGenuineResponse correctly classifies it as a genuine RESPONSE (it
// isn't a BLOCKED/refusal/setup-prompt reply), but lifecycle-gate.mjs's post-audit check was
// treating "genuine response" and "completed audit" as the same thing, so that kickoff alone
// could back a CLEAN verdict recorded in the audit issue's dropdown.
//
// This module is deliberately separate from genuine-response.mjs and does not change its
// behavior or Stage 1's semantics — Stage 1 has no per-response completed-report contract, only
// the genuine-vs-BLOCKED/refusal distinction isGenuineResponse already makes. isGenuineResponse
// is reused here (unmodified) as a precondition: a response that fails its checks (BLOCKED, a
// refused mutation attempt, a Codex Cloud setup prompt) can never be a completed audit report
// either.
//
// Deliberately narrow, per issue #230's Non-goals (no arbitrary Markdown parsing, no semantic
// adjudication of whether findings are correct). Three structural signals, all required for a
// response to count as a completed report:
//
//   1. references the exact target merge commit — the full SHA, or a case-insensitive prefix of
//      it at least 7 hex characters long (Git's own minimum unambiguous abbreviation length) —
//      appearing as a standalone hex token, not merely as a substring of an unrelated token.
//
//   2. states an explicit CLEAN or NOT CLEAN verdict, in either of two shapes actually observed
//      from Codex: a leading status line ("CLEAN — Stage 2 audit of PR #94 at `<sha>`; no
//      actionable findings. Next: None.", issue #95 — the same fixed-format convention
//      AGENTS.md's own "Fixed chat report formats" documents), or a "Verdict"-labelled value
//      (the shape the audit-control-issue template's own Verdict field describes, and the shape
//      parseFormField in lifecycle-gate.mjs already reads from the audit issue body itself).
//
//   3. shows verification-results content, not merely a bare verdict: at least one numbered
//      item together with some mention of verification. This is what a kickoff/acknowledgement
//      can never accidentally satisfy, and it is what the audit-control-issue template already
//      documents as required — "Required findings structure" already asks every response to
//      include "a verification-performed checklist that works through every item in the
//      Verification checklist field ... and states its result," and states a "no findings"
//      audit must still report "in this structure," not a bare one-liner. This module makes
//      that existing prose requirement mechanically enforced rather than only aspirational.
//      When the caller supplies the audit issue's own requested checklist text (`isCompleted
//      Stage2AuditReport`'s `requestedChecklist` option), this signal additionally requires the
//      response's numbered-item count to meet the requested count (issue #268 finding 2) — a
//      response truncated partway through a multi-item checklist no longer passes on the
//      strength of its first item alone.
//
// A historical response that predates this contract (e.g. issue #95's terse "CLEAN — ... no
// actionable findings. Next: None.", which has no numbered checklist walk-through) would report
// `complete: false` if evaluated fresh against it — that is expected, not a regression. This
// module only gates *new* post-audit evaluations going forward; it never re-certifies,
// rewrites, or retroactively revokes a historical audit's already-recorded and already-acted-
// upon verdict. See issue #230's Required layer 8.

import { isGenuineResponse } from "./genuine-response.mjs";

const HEX_CHARS = /^[0-9a-f]+$/i;
const HEX_TOKEN_PATTERN = /\b[0-9a-f]{7,40}\b/gi;

// Pure. Whether `text` references `mergeCommit`: the exact SHA, or a case-insensitive prefix of
// at least 7 hex characters of it, appearing as a standalone hex token in `text`. Matches in
// either direction (a short token in `text` that is a prefix of the full SHA, or vice versa) so
// this works whether the response quotes the full 40-character SHA or an abbreviated one.
export function bodyReferencesCommit(text, mergeCommit) {
  if (!text || !mergeCommit) return false;
  const sha = String(mergeCommit).trim().toLowerCase();
  if (!HEX_CHARS.test(sha) || sha.length < 7) return false;
  HEX_TOKEN_PATTERN.lastIndex = 0;
  let match;
  while ((match = HEX_TOKEN_PATTERN.exec(text)) !== null) {
    const token = match[0].toLowerCase();
    if (sha.startsWith(token) || token.startsWith(sha)) return true;
  }
  return false;
}

// A leading status line: "CLEAN ..." / "NOT CLEAN ...", optionally wrapped in harmless leading
// Markdown presentation (heading/list/blockquote/emphasis markers) the same way
// genuine-response.mjs's BLOCKED_STATUS_PATTERN family tolerates it.
const LEADING_VERDICT_PATTERN =
  /^(?:\s|>+|#{1,6}(?=\s)|[-+*](?=\s)|\d{1,3}[.)](?=\s)|[*_]{1,3}(?=\S))*\s*(NOT CLEAN|CLEAN)\b/i;
// A genuine "Verdict" *label* line — a heading ("### Verdict"), a bold/plain label with an
// optional colon ("Verdict:", "**Verdict:**"), optionally followed by the value on the same
// line — anchored to the start of the (trimmed) line. Stage 1 review finding on this PR: an
// earlier version matched the bare word "verdict" appearing *anywhere* in a line, so a NOT
// CLEAN report's own findings prose — e.g. "Prevent a CLEAN verdict from overriding
// contradictory evidence" — was read as a same-line label with value "CLEAN", short-circuiting
// before the report's actual "Verdict: NOT CLEAN" line was ever reached. Anchoring to the start
// of the line (after optional heading/bold markup) means only an actual label field can supply
// the verdict, never a sentence that merely contains the word.
//
// Issue #268: anchoring alone was not enough — the colon was optional (`:?`), so a prose
// sentence that merely *opens* with "Verdict" (e.g. "Verdict handling must not allow CLEAN to
// override evidence") still matched as a label, with the rest of the sentence read as its
// value. A real label line either ends right after "verdict" (a bare heading like "### Verdict",
// whose value follows on the next non-blank line) or is immediately followed by a colon before
// any other text. There is no third shape: requiring one of those two — instead of merely
// optional, freely-skippable punctuation — is what actually distinguishes a label from a
// sentence that happens to start with the same word.
const VERDICT_LABEL_LINE_PATTERN = /^(?:#{1,6}\s*)?\*{0,2}verdict\*{0,2}\s*(?::\s*\*{0,2}\s*(.*))?$/i;
const VERDICT_TOKEN_PATTERN = /\b(NOT CLEAN|CLEAN)\b/i;

// A heading combining "Stage 2 Audit" with an explicit verdict declaration on the same line —
// issue #259's actual defect recurring a second time (this file's own verdict extraction was
// apparently never extended for either combined-heading shape, only trigger.mjs's --force guard
// was fixed after that incident). Two real observed examples, both from Codex's own replies:
// "## Stage 2 Audit Verdict: **CLEAN**" (issue #259, trigger.mjs's own header comment) and
// "## Stage 2 Audit — NOT CLEAN" (issue #278, the audit response on this correction PR's own
// target issue). Neither matches LEADING_VERDICT_PATTERN (the token isn't the very first content
// after heading/list/emphasis markup — "Stage 2 Audit" precedes it) or VERDICT_LABEL_LINE_PATTERN
// (the line literally says "Stage 2 Audit", not "verdict").
//
// Stage 1 review finding on this PR: an earlier version of this pattern accepted the token
// *anywhere* on a line opening with "Stage 2 Audit", which would misread "## Stage 2 Audit of
// clean-close behavior" (a heading about the topic, declaring nothing) as CLEAN, and would pick
// the wrong token entirely from "## Stage 2 Audit status was CLEAN, now NOT CLEAN" (the first
// match, not the actual final verdict) — either could authorize an incorrect CLEAN closure.
// Requiring an explicit declaration — an optional "Verdict" word, then a colon or dash, then
// (only) the token, to the end of the line — is what actually distinguishes the two real
// examples above from a heading merely discussing the topic: both open with "Stage 2 Audit",
// then go straight from an optional "Verdict" word into a declaring punctuation mark and the
// token with nothing else, while "Stage 2 Audit of clean-close behavior" and "Stage 2 Audit
// status was CLEAN, now NOT CLEAN" both interpose ordinary prose between "Audit" and any
// separator, so neither reaches the token position this pattern requires.
const STAGE2_HEADING_VERDICT_PATTERN =
  /^(?:#{1,6}\s*)?stage\s*2\s+audit\b(?:\s*verdict)?\s*[:—-]\s*\*{0,2}\s*(NOT CLEAN|CLEAN)\b\*{0,2}[.!]?\s*$/im;

function normalizeVerdictToken(token) {
  return token.toUpperCase() === "CLEAN" ? "CLEAN" : "NOT CLEAN";
}

// Pure. Extracts the response's own explicit verdict, or null. Three recognized shapes: a
// leading status line, a "Verdict" label followed — on the same line or the next non-blank
// line — by the token, or a "Stage 2 Audit [Verdict] <sep> <token>" heading declaring the token
// directly. Only the immediate next non-blank line is checked after a label with no same-line
// token, so an unrelated later mention of CLEAN/NOT CLEAN elsewhere in the body is never
// mistaken for the labelled value. The three checks are tried in order but are mutually
// exclusive in practice (a given line matches at most one shape), so order does not matter.
export function extractResponseVerdict(text) {
  const normalized = (text ?? "").trim();
  if (!normalized) return null;

  const leading = LEADING_VERDICT_PATTERN.exec(normalized);
  if (leading) return normalizeVerdictToken(leading[1]);

  const stage2Heading = STAGE2_HEADING_VERDICT_PATTERN.exec(normalized);
  if (stage2Heading) return normalizeVerdictToken(stage2Heading[1]);

  const lines = normalized.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const labelMatch = VERDICT_LABEL_LINE_PATTERN.exec(lines[i].trim());
    if (!labelMatch) continue;
    const rest = (labelMatch[1] ?? "").trim();
    if (rest) {
      const sameLine = VERDICT_TOKEN_PATTERN.exec(rest);
      if (sameLine) return normalizeVerdictToken(sameLine[1]);
      continue;
    }
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const candidate = lines[j].trim();
      if (candidate === "") continue;
      const match = VERDICT_TOKEN_PATTERN.exec(candidate);
      if (match) return normalizeVerdictToken(match[1]);
      break;
    }
  }
  return null;
}

const VERIFICATION_MENTION_PATTERN = /\bverif(?:y|ies|ied|ication|ying)\b/i;
const NUMBERED_ITEM_PATTERN = /^\s*\d{1,3}[.)]\s+\S/m;
const NUMBERED_ITEM_PATTERN_GLOBAL = /^\s*\d{1,3}[.)]\s+\S/gm;
const NUMBERED_ITEM_NUMBER_PATTERN = /^\s*(\d{1,3})[.)]\s+\S/gm;

// Pure. Whether `text` shows actual verification-results content: a numbered checklist
// walk-through together with some mention of verification itself, rather than a bare verdict
// with nothing behind it.
export function hasVerificationEvidence(text) {
  const normalized = text ?? "";
  return VERIFICATION_MENTION_PATTERN.test(normalized) && NUMBERED_ITEM_PATTERN.test(normalized);
}

// Pure. Counts top-level numbered list lines ("1. ...", "2) ...") in `text`. Used against the
// audit-control issue's own Verification checklist field, which contains nothing but the
// requested list, so a plain count of every numbered line in it is accurate. Do not reuse this
// against a full response body — see countVerificationWalkthroughItems below for why a response
// needs its checklist section isolated first.
export function countNumberedItems(text) {
  const normalized = text ?? "";
  const matches = normalized.match(NUMBERED_ITEM_PATTERN_GLOBAL);
  return matches ? matches.length : 0;
}

// Pure. Counts the numbered items in `text`'s *verification-checklist walk-through* specifically
// — not every numbered line in the response body. Stage 1 review finding on this PR: the
// required response structure's item (2), one numbered entry per finding, precedes item (3), the
// checklist walk-through — so a response with two numbered findings plus only item 1 of a
// three-item requested checklist has three numbered lines total, and a plain count would call it
// complete against a 3-item request while checklist items 2-3 were never actually addressed.
//
// A genuine checklist walk-through is its own freshly-numbered list, restarting at 1, and per the
// required structure's ordering it is the *last* numbered list before the verdict. This returns
// the length of the last contiguous run of numbered items that begins at 1 and increases by
// exactly 1 each step — deliberately a numbering-sequence heuristic, not heading-text matching
// (which response authors are not required to phrase identically), consistent with this module's
// Non-goals (no arbitrary Markdown parsing, no semantic adjudication of finding content).
export function countVerificationWalkthroughItems(text) {
  const normalized = text ?? "";
  const numbers = [];
  NUMBERED_ITEM_NUMBER_PATTERN.lastIndex = 0;
  let match;
  while ((match = NUMBERED_ITEM_NUMBER_PATTERN.exec(normalized)) !== null) {
    numbers.push(Number(match[1]));
  }
  if (numbers.length === 0) return 0;
  let runStart = numbers.length - 1;
  for (let i = numbers.length - 1; i > 0; i--) {
    if (numbers[i] === numbers[i - 1] + 1) {
      runStart = i - 1;
    } else {
      break;
    }
  }
  return numbers[runStart] === 1 ? numbers.length - runStart : 0;
}

// Pure. Whether `text`'s verification-results content is *complete* against `requestedChecklist`
// — the audit-control issue's own Verification checklist field text — rather than merely
// present. issue #268 finding 2: `hasVerificationEvidence` alone accepts any single numbered
// line plus a mention of "verif*", so a response truncated after item 1 of a multi-item
// requested checklist still passed as a complete walk-through. Requires the response's own
// checklist walk-through (countVerificationWalkthroughItems, scoped to just that section — see
// its own comment for why an unscoped count is unsafe) to carry at least as many items as were
// requested; deliberately count-based, not a semantic item-by-item match, consistent with this
// module's Non-goals (no arbitrary Markdown parsing, no semantic adjudication of whether findings
// are correct). When `requestedChecklist` has no countable items itself (missing, blank, or
// unparseable), completeness falls back to `hasVerificationEvidence` — there is nothing concrete
// to compare a count against.
export function hasCompleteVerificationEvidence(text, requestedChecklist) {
  if (!hasVerificationEvidence(text)) return false;
  const requestedCount = countNumberedItems(requestedChecklist);
  if (requestedCount === 0) return true;
  return countVerificationWalkthroughItems(text) >= requestedCount;
}

// Combines the three signals into one completion decision. `reasons` lists every failed
// signal — issue #230's acceptance criteria requires that "a fresh session can determine ...
// verification limitations ... from durable state," so a bare true/false is not enough.
//
// `requireVerificationEvidence` (default true) lets a caller relax signal 3 only — used
// exclusively by lifecycle-gate.mjs when checking whether an *already-closed* work issue's
// historical CLEAN closure should be preserved on a fresh post-audit re-run (issue #230
// Required layer 8 / Stage 1 review finding on this PR: without this, rerunning post-audit
// against an already-accepted pre-contract audit — e.g. issue #95's terse "CLEAN — ... no
// actionable findings. Next: None." shape, with no numbered checklist — reports
// PREMATURE_CLOSURE and its own recovery instruction would reopen a legitimately-closed work
// issue). Signals 1 and 2 (commit identity, the response's own matching verdict) are still
// required even in this mode, so it never backs a report addressing the wrong commit or
// lacking any verdict at all — it only forgives the newly-required checklist format a
// pre-existing response could never have followed.
//
// `requestedChecklist` (default null), when given the audit-control issue's own Verification
// checklist field text, makes signal 3 completeness-checked rather than presence-checked (issue
// #268 finding 2) — see hasCompleteVerificationEvidence. Ignored when
// `requireVerificationEvidence` is false: legacy-compatibility mode already forgives the
// checklist signal entirely, so there is nothing to compare completeness against.
export function isCompletedStage2AuditReport(
  body,
  { mergeCommit, requireVerificationEvidence = true, requestedChecklist = null } = {},
) {
  const text = body ?? "";
  const reasons = [];

  // Evaluated against the *full* body, not a 200-character excerpt (Stage 1 review finding on
  // this PR): isSelfReferentialRefusal scans every sentence in whatever text it is given, not
  // just the start, so a response that places the commit/checklist/verdict within its first 200
  // characters but *later* discloses a refused mutation attempt ("I tried to push a fix but
  // don't have write access") must still be excluded — that refusal is a violated reviewer-role
  // boundary per AGENTS.md's Code Review Rules regardless of where in the message it appears.
  if (!isGenuineResponse(text)) {
    reasons.push("not a genuine response (BLOCKED, a refused mutation attempt, or a setup prompt)");
    return { complete: false, verdict: null, reasons };
  }

  const hasCommit = bodyReferencesCommit(text, mergeCommit);
  if (!hasCommit) {
    reasons.push(mergeCommit ? "does not reference the exact target merge commit" : "no merge commit given to check against");
  }

  const verdict = extractResponseVerdict(text);
  if (!verdict) reasons.push("no explicit CLEAN/NOT CLEAN verdict");

  const hasVerification = hasVerificationEvidence(text);
  const meetsChecklist = requestedChecklist ? hasCompleteVerificationEvidence(text, requestedChecklist) : hasVerification;
  if (!hasVerification) {
    reasons.push(
      requireVerificationEvidence
        ? "no verification-results content (a numbered checklist walk-through)"
        : "no verification-results content (a numbered checklist walk-through) — not required in legacy-compatibility mode",
    );
  } else if (!meetsChecklist) {
    reasons.push(
      `verification checklist walk-through is incomplete (response has ${countVerificationWalkthroughItems(text)} numbered ` +
        `item(s), requested checklist has ${countNumberedItems(requestedChecklist)})`,
    );
  }

  const complete = hasCommit && verdict !== null && (meetsChecklist || !requireVerificationEvidence);
  return { complete, verdict: complete ? verdict : null, reasons };
}
