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
const LABEL_PATTERN = /\bverdict\b/i;
const VERDICT_TOKEN_PATTERN = /\b(NOT CLEAN|CLEAN)\b/i;

function normalizeVerdictToken(token) {
  return token.toUpperCase() === "CLEAN" ? "CLEAN" : "NOT CLEAN";
}

// Pure. Extracts the response's own explicit verdict, or null. Two recognized shapes: a
// leading status line, or a "Verdict" label followed — on the same line or the next non-blank
// line — by the token. Only the immediate next non-blank line is checked after a label with no
// same-line token, so an unrelated later mention of CLEAN/NOT CLEAN elsewhere in the body is
// never mistaken for the labelled value.
export function extractResponseVerdict(text) {
  const normalized = (text ?? "").trim();
  if (!normalized) return null;

  const leading = LEADING_VERDICT_PATTERN.exec(normalized);
  if (leading) return normalizeVerdictToken(leading[1]);

  const lines = normalized.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!LABEL_PATTERN.test(lines[i])) continue;
    const sameLine = VERDICT_TOKEN_PATTERN.exec(lines[i].replace(LABEL_PATTERN, ""));
    if (sameLine) return normalizeVerdictToken(sameLine[1]);
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

// Pure. Whether `text` shows actual verification-results content: a numbered checklist
// walk-through together with some mention of verification itself, rather than a bare verdict
// with nothing behind it.
export function hasVerificationEvidence(text) {
  const normalized = text ?? "";
  return VERIFICATION_MENTION_PATTERN.test(normalized) && NUMBERED_ITEM_PATTERN.test(normalized);
}

// Combines the three signals into one completion decision. `reasons` lists every failed
// signal — issue #230's acceptance criteria requires that "a fresh session can determine ...
// verification limitations ... from durable state," so a bare true/false is not enough.
export function isCompletedStage2AuditReport(body, { mergeCommit } = {}) {
  const text = body ?? "";
  const reasons = [];

  if (!isGenuineResponse(text.slice(0, 200))) {
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
  if (!hasVerification) reasons.push("no verification-results content (a numbered checklist walk-through)");

  const complete = hasCommit && verdict !== null && hasVerification;
  return { complete, verdict: complete ? verdict : null, reasons };
}
