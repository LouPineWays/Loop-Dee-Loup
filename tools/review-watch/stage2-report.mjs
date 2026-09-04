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
//      appearing as a standalone hex token, not merely as a substring of an unrelated token. This
//      stays mandatory (issue #335, audit #334): #334's genuine CLEAN response never restated the
//      merge commit — it cited the audit issue's own trusted, pre-trigger frozen Stage 1 reviewed
//      head instead (the caller's `reviewedHeadCommit` option, parsed by lifecycle-gate.mjs's
//      parseReviewedHeadCommitRef) while verifying the required Control-plane-paths workflow
//      item, a legitimate citation the audit-control-issue template's own checklist instructions
//      explicitly ask for on that one item. issue #335 investigated accepting `reviewedHeadCommit`
//      as an alternative to `mergeCommit` for this signal, but a Stage 1 review finding on the PR
//      that introduced it proved that relaxation unsafe: a response that misidentifies the actual
//      merged target — naming some *incorrect* merge commit — while still (correctly) citing the
//      reviewed head for the workflow-check item would pass target identity under an `||`, even
//      though the response's own claimed audit target is wrong. The reviewed head only identifies
//      the revision CI ran against pre-merge; it can even predate Stage 1 correction commits that
//      *are* part of the actual merged result, so citing it proves nothing about whether the
//      response covered the real merge commit. Per issue #335's own fallback ("if that cannot be
//      made deterministic and fail-closed, retain the merge-commit requirement"), this signal
//      still requires `mergeCommit` unconditionally — `reviewedHeadCommit`, when supplied, is used
//      only to produce a more specific *reason* string when this signal fails (distinguishing "no
//      commit reference at all" from "cites the reviewed head but not the required merge commit"),
//      never to satisfy the signal itself.
//
//   2. states an explicit CLEAN or NOT CLEAN verdict, in either of two shapes actually observed
//      from Codex: a leading status line ("CLEAN — Stage 2 audit of PR #94 at `<sha>`; no
//      actionable findings. Next: None.", issue #95 — the same fixed-format convention
//      AGENTS.md's own "Fixed chat report formats" documents), or a "Verdict"-labelled value
//      (the shape the audit-control-issue template's own Verdict field describes, and the shape
//      parseFormField in lifecycle-gate.mjs already reads from the audit issue body itself).
//
//   3. shows verification-results content, not merely a bare verdict: at least one checklist
//      item — either a numbered item ("1. ...") or a per-item status-marker bullet ("- ✅ ...",
//      issue #330's genuine Stage 2 audit response, comment 5525865299) — together with some
//      mention of verification. This is what a kickoff/acknowledgement can never accidentally
//      satisfy, and it is what the audit-control-issue template already documents as required —
//      "Required findings structure" already asks every response to include "a
//      verification-performed checklist that works through every item in the Verification
//      checklist field ... and states its result," and states a "no findings" audit must still
//      report "in this structure," not a bare one-liner. The template does not mandate numbering
//      specifically, so a status-marker bullet list satisfies it exactly as well. This module
//      makes that existing prose requirement mechanically enforced rather than only aspirational.
//      When the caller supplies the audit issue's own requested checklist text (`isCompleted
//      Stage2AuditReport`'s `requestedChecklist` option), this signal additionally requires the
//      response's own walk-through item count (numbered or marker-bullet) to meet the requested
//      count (issue #268 finding 2) — a response truncated partway through a multi-item checklist
//      no longer passes on the strength of its first item alone.
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

// A top-level bullet item carrying its own per-item status marker — the shape observed on
// issue #330's genuine Stage 2 audit response (comment 5525865299): "- ✅ `command` — result"
// for each checklist item, with no numbering at all. Deliberately restricted to a small,
// unambiguous set of pass/fail glyphs (checkmark and cross families only) rather than "any
// emoji after a bullet" — a findings list that happens to bullet unrelated emoji must not be
// misread as a checklist walk-through. Stage 1 review finding on this PR: an earlier version
// also accepted a warning glyph (⚠️/⚠), which the audit-control-issue template's own required
// response structure separately uses for its "whether founder judgment is required" field —
// with that glyph included, a trailing "- ⚠️ Founder judgment required" note (not itself a
// checklist item) could either get miscounted as an extra checklist item or, worse, stand in
// entirely for a real checklist walk-through that was never actually performed. Checkmark/cross
// glyphs carry no such ambiguity with any other required-structure field, so dropping the
// warning glyph removes the confusion at its source rather than trying to distinguish the two
// meanings positionally.
//
// Requires zero leading whitespace (not `^\s*[-*+]`, deliberately) — a *top-level* list item, as
// every real checklist item observed so far is. Stage 1 review finding on this PR: allowing
// arbitrary leading whitespace let an indented sub-bullet nested under one checklist item (e.g.
// "  - ✅ subcheck") be miscounted as its own additional top-level item, inflating the walk-
// through count above what was actually addressed.
const CHECKLIST_STATUS_MARKER = "(?:✅|✔️|✔|☑️|☑|❌|✗|✘)";
const CHECKLIST_MARKER_ITEM_PATTERN_SOURCE = `^[-*+]\\s*${CHECKLIST_STATUS_MARKER}\\s+\\S`;
const CHECKLIST_MARKER_ITEM_PATTERN = new RegExp(CHECKLIST_MARKER_ITEM_PATTERN_SOURCE, "m");
const CHECKLIST_MARKER_ITEM_LINE_PATTERN = new RegExp(CHECKLIST_MARKER_ITEM_PATTERN_SOURCE);

// The same per-item status-marker shape as CHECKLIST_MARKER_ITEM_PATTERN above, but prefixed by
// a numbered-list marker ("1. ✅ ...") instead of a bullet ("- ✅ ...") — issue #353's genuine
// Stage 2 audit response used exactly this shape for every item in its checklist walk-through
// ("1. ✅ ...", "2. ✅ ...", ...). A numbered run with a pass/fail glyph on every item is at
// least as unambiguous a walk-through signal as the bulleted-marker case already is (both carry
// an explicit per-item verdict glyph, not merely a numbered list that might be something else
// entirely, like a findings list) — see hasVerificationEvidence below for why this pattern alone
// is trusted without also requiring VERIFICATION_MENTION_PATTERN.
const NUMBERED_MARKER_ITEM_PATTERN_SOURCE = `^\\s*\\d{1,3}[.)]\\s*${CHECKLIST_STATUS_MARKER}\\s+\\S`;
const NUMBERED_MARKER_ITEM_PATTERN = new RegExp(NUMBERED_MARKER_ITEM_PATTERN_SOURCE, "m");

// A line that can genuinely separate two top-level marker items: non-blank, and itself starting
// at column 0 (no leading whitespace) — i.e. other top-level content (a heading, a new
// paragraph, an unrelated top-level bullet), never a checklist item's own indented continuation
// line. Stage 1 review finding on this PR: treating *any* non-blank line as a separator broke a
// checklist item that wrapped onto an indented continuation line (evidence/explanation directly
// under a "- ✅ ..." item) into a false run boundary, undercounting a complete walk-through. An
// indented, non-matching line is silently skipped instead — neither counted nor treated as a
// break — consistent with the zero-indentation top-level requirement above: real nested/
// continuation content is, by construction, never column-0.
function isTopLevelBoundaryLine(line) {
  return line.trim() !== "" && /^\S/.test(line);
}

// A Markdown heading line at any level ("#" through "######"), used only to find section
// boundaries — not itself a candidate checklist/finding line. Captures the "#" run so callers
// can compare heading levels (computeHeadingSectionMask, below).
const HEADING_LEVEL_PATTERN = /^(#{1,6})\s+\S/;

// A heading whose own text names a *literal command log* rather than a checklist walk-through —
// observed real shape: "### Checks" (issue #381, comment 5541924356), each of whose lines is
// "- ✅ `<command run>`" — the exact same top-level marker-bullet shape CHECKLIST_MARKER_ITEM_
// PATTERN matches for a genuine per-item checklist walk-through. The two are structurally
// indistinguishable by bullet shape alone; the heading is the only signal that separates "this
// bullet asserts a checklist item was verified" from "this bullet records that a command was
// run." Matches "Checks", "Checks:", "Checks performed", "### **Checks**", etc. — the heading
// text alone, not exact punctuation/emphasis around it.
const CHECKS_SECTION_HEADING_PATTERN = /^#{1,6}\s*\*{0,2}\s*checks?\b/i;

// A heading whose own text names the response's *findings* section (the required response
// structure's item (2), one numbered entry per finding — docs/bounded-review-cycle.md) rather
// than its checklist walk-through (item (3)). Stage 1 review finding on this PR (P1): masking a
// trailing "### Checks" section can leave a numbered findings list as the *only* remaining
// numbered-run candidate when the response never actually wrote a separate walk-through section
// — e.g. three numbered findings followed only by a masked "### Checks" log — and
// findNumberedWalkthroughRun's "last run starting at 1" heuristic has no way to tell that
// findings list apart from a genuine walk-through once nothing later in the document
// disambiguates it. Excluding findings-labeled content from candidacy the same way
// CHECKS_SECTION_HEADING_PATTERN excludes command logs closes that gap: a findings list can
// then only ever be miscounted as the walk-through when it is not labeled as findings at all,
// the same pre-existing, accepted ambiguity every marker/numbered heuristic in this module
// already lives with (documented in findNumberedWalkthroughRun's own comment).
const FINDINGS_SECTION_HEADING_PATTERN = /^#{1,6}\s*\*{0,2}\s*findings?\b/i;

// Pure. For each line index in `lines`, whether that line falls inside a section opened by a
// heading matching `startPattern` — from that heading down to (but not including) the next
// heading at the *same or shallower* level, or the end of the document. A heading nested
// *deeper* than the section's own opening heading (e.g. a "#### Unit tests" subheading under a
// "### Checks" section) does not end the section — Stage 1 review finding on this PR (P2): the
// original version compared every heading against `startPattern` unconditionally, so a nested
// subheading that didn't itself say "checks" incorrectly closed the section early, exposing its
// remaining bullets to being counted as checklist items again. Lines before the first matching
// heading are never inside a section.
function computeHeadingSectionMask(lines, startPattern) {
  const mask = new Array(lines.length).fill(false);
  let sectionLevel = null;
  for (let i = 0; i < lines.length; i++) {
    const headingMatch = HEADING_LEVEL_PATTERN.exec(lines[i]);
    if (headingMatch) {
      const level = headingMatch[1].length;
      if (sectionLevel !== null && level <= sectionLevel) {
        sectionLevel = null;
      }
      if (sectionLevel === null && startPattern.test(lines[i])) {
        sectionLevel = level;
      }
    }
    mask[i] = sectionLevel !== null;
  }
  return mask;
}

// Pure. For each line index in `lines`, whether that line falls inside a literal-command-log
// section (CHECKS_SECTION_HEADING_PATTERN) or a findings section (FINDINGS_SECTION_HEADING_
// PATTERN) — see each pattern's own comment for why both are excluded from checklist-walk-
// through candidacy. Issue #381: findNumberedWalkthroughRun and findMarkerWalkthroughRun both
// use this to exclude those sections' own bullets/numbering from ever being mistaken for the
// genuine requested-checklist walk-through, even though a command log reuses the identical
// per-item status-marker glyphs a real checklist item uses, and a findings list reuses the
// identical numbered-list shape a real walk-through uses.
function computeExcludedSectionMask(lines) {
  const checksMask = computeHeadingSectionMask(lines, CHECKS_SECTION_HEADING_PATTERN);
  const findingsMask = computeHeadingSectionMask(lines, FINDINGS_SECTION_HEADING_PATTERN);
  return lines.map((_, i) => checksMask[i] || findingsMask[i]);
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

// Pure. Finds `text`'s *verification-checklist walk-through* when it is shaped as a numbered
// list, specifically — not every numbered line in the response body. Stage 1 review finding on
// an earlier revision of this module: the required response structure's item (2), one numbered
// entry per finding, precedes item (3), the checklist walk-through — so a response with two
// numbered findings plus only item 1 of a three-item requested checklist has three numbered
// lines total, and a plain count would call it complete against a 3-item request while checklist
// items 2-3 were never actually addressed.
//
// A genuine checklist walk-through is its own freshly-numbered list, restarting at 1. This finds
// the last contiguous run of numbered items that begins at 1 and increases by exactly 1 each
// step — deliberately a numbering-sequence heuristic, not heading-text matching (which response
// authors are not required to phrase identically), consistent with this module's Non-goals (no
// arbitrary Markdown parsing, no semantic adjudication of finding content). Returns `null` when
// no such run exists, and otherwise `{ count, endLineIndex, itemLineIndexes }` —
// `endLineIndex` (the 0-based line index of the run's last item) is what lets
// `countVerificationWalkthroughItems` below choose between this and a same-body marker-bullet
// run by document position, per issue #330's Stage 1 review finding 1: preferring numbered runs
// unconditionally let an early numbered *findings* entry outrank the response's real
// (marker-bullet) checklist, in both directions — a short numbered findings list could pad out
// an incomplete marker checklist's count, and a genuinely complete marker checklist could be
// discarded in favor of a single unrelated numbered finding. `itemLineIndexes` (every line index
// in the selected run, not just the last) is what lets numberedWalkthroughIsFullyMarked below
// check every item in the exact same run for a per-item marker, not just its own line count.
function findNumberedWalkthroughRun(lines) {
  const excludedSectionMask = computeExcludedSectionMask(lines);
  const numbered = [];
  lines.forEach((line, index) => {
    if (excludedSectionMask[index]) return;
    const match = /^\s*(\d{1,3})[.)]\s+\S/.exec(line);
    if (match) numbered.push({ index, number: Number(match[1]) });
  });
  if (numbered.length === 0) return null;
  let runStart = numbered.length - 1;
  for (let i = numbered.length - 1; i > 0; i--) {
    if (numbered[i].number === numbered[i - 1].number + 1) {
      runStart = i - 1;
    } else {
      break;
    }
  }
  if (numbered[runStart].number !== 1) return null;
  const runItems = numbered.slice(runStart);
  return { count: runItems.length, endLineIndex: runItems[runItems.length - 1].index, itemLineIndexes: runItems.map((r) => r.index) };
}

// Pure. True only when the *selected walk-through numbered run itself* — the exact same
// trailing 1,2,3,... run findNumberedWalkthroughRun (and therefore
// countVerificationWalkthroughItems) would count — carries a pass/fail glyph on every one of
// its items, not merely somewhere in the document. Stage 1 review finding on this PR: testing
// NUMBERED_MARKER_ITEM_PATTERN against the whole body only proves *one* line anywhere has a
// marker; a mixed run like "1. ✅ Checked A" / "2. Finding B" / "3. Finding C" still let an
// earlier revision of this fix accept the body as verification evidence while items 2-3 (no
// marker, no verification content) were silently counted as if verified, against a 3-item
// requested checklist. Requiring every item in the exact counted run to carry the glyph keeps
// the "evidence present" gate (hasVerificationEvidence below) and the "how many items" count in
// sync with each other.
function numberedWalkthroughIsFullyMarked(lines) {
  const run = findNumberedWalkthroughRun(lines);
  if (!run) return false;
  return run.itemLineIndexes.every((index) => NUMBERED_MARKER_ITEM_PATTERN.test(lines[index]));
}

// Pure. Whether `text` shows actual verification-results content: a numbered per-item
// status-marker walk-through ("1. ✅ ...", every item marked), a bulleted per-item
// status-marker walk-through ("- ✅ ...") together with some mention of verification itself, or
// a bare numbered list ("1. ...") together with the same mention — rather than a bare verdict
// with nothing behind it.
//
// Stage 2 audit finding on issue #353: a genuine, substantively complete response numbered
// every checklist item with its own pass/fail glyph ("1. ✅ ...", "2. ✅ ...", ...) but never
// used the literal word "verify"/"verification"/etc. anywhere in the body, so the original
// `VERIFICATION_MENTION_PATTERN` gate — applied unconditionally before either list shape was
// even checked — rejected it outright as showing no verification-results content at all, despite
// an unambiguous five-item walk-through sitting right there.
//
// Stage 1 review finding on this PR (two P1s against an earlier revision of this fix): the
// mention-free path stays narrowly scoped to the numbered-marker shape, and only when the
// *entire* selected walk-through run is marker-bearing (numberedWalkthroughIsFullyMarked) —
// not merely one marked line anywhere in the body (which would let a mixed run of marked and
// unmarked numbered lines pass evidence-detection while still counting the unmarked lines as if
// verified). The bulleted marker case ("- ✅ ...") deliberately keeps requiring the word
// mention, unchanged from before this fix: a lone unrelated status bullet — e.g. "- ✅ Fixed the
// finding" inside ordinary findings prose, as an existing adversarial test already demonstrates
// for this shape — must not, on its own, satisfy a single-item requested checklist with no real
// verification section or wording at all. A bare numbered list without glyphs also keeps
// requiring the mention, since that shape alone could still plausibly be something else (e.g. a
// numbered findings list).
export function hasVerificationEvidence(text) {
  const normalized = text ?? "";
  if (numberedWalkthroughIsFullyMarked(normalized.split("\n"))) return true;
  if (!VERIFICATION_MENTION_PATTERN.test(normalized)) return false;
  return NUMBERED_ITEM_PATTERN.test(normalized) || CHECKLIST_MARKER_ITEM_PATTERN.test(normalized);
}

// Pure. Finds `text`'s *verification-checklist walk-through* when it is shaped as a per-item
// status-marker bullet list ("- ✅ ...") rather than a numbered list — issue #330's genuine
// Stage 2 audit response (comment 5525865299) used exactly this shape and has no numbering at
// all, so findNumberedWalkthroughRun alone finds nothing for a content-complete response.
//
// There is no numeric sequence to anchor on here (unlike the numbered case), so this instead
// finds the *last contiguous run of matching lines* — walking backward through every line that
// matched the marker pattern and stopping as soon as a genuine top-level boundary line
// (isTopLevelBoundaryLine — non-blank and non-indented) separates two matches. Blank lines and
// indented continuation lines between two matches do not break the run. That isolates a trailing
// checklist section from an unrelated earlier bulleted list (e.g. a findings section that
// happens to use the same bullet character) the same way the numbered version isolates the last
// numbered run from earlier numbered findings. Returns `null` when no marker item is found, and
// otherwise `{ count, endLineIndex }` — see findNumberedWalkthroughRun's own comment for why the
// end position matters.
function findMarkerWalkthroughRun(lines) {
  const excludedSectionMask = computeExcludedSectionMask(lines);
  const matchedLineIndexes = [];
  lines.forEach((line, index) => {
    if (excludedSectionMask[index]) return;
    if (CHECKLIST_MARKER_ITEM_LINE_PATTERN.test(line)) matchedLineIndexes.push(index);
  });
  if (matchedLineIndexes.length === 0) return null;

  let count = 1;
  for (let k = matchedLineIndexes.length - 1; k > 0; k--) {
    let brokenByBoundary = false;
    for (let lineIndex = matchedLineIndexes[k - 1] + 1; lineIndex < matchedLineIndexes[k]; lineIndex++) {
      if (isTopLevelBoundaryLine(lines[lineIndex])) {
        brokenByBoundary = true;
        break;
      }
    }
    if (brokenByBoundary) break;
    count++;
  }
  return { count, endLineIndex: matchedLineIndexes[matchedLineIndexes.length - 1] };
}

// Pure. Counts the items in `text`'s verification-checklist walk-through, whichever of the two
// observed shapes it uses: a numbered list, or a per-item status-marker bullet list (issue
// #330). When both a numbered run and a marker-bullet run exist in the same body, picks whichever
// one ends later in the document — the genuine checklist walk-through is whichever list actually
// sits last (closest to the verdict), per the required response structure's ordering, not
// whichever shape happens to be numbered (issue #330's Stage 1 review finding 1). Both candidate
// runs are found with a trailing "### Checks" (or equivalent) literal-command-log section, and
// any findings section, already masked out (computeExcludedSectionMask, issue #381), so a
// command log's bullets — which reuse the identical status-marker glyphs a genuine checklist
// item uses — can never win this tie-break merely for sitting physically later in the document
// than the real walk-through, and a findings list can never be counted as the walk-through
// merely for being the only numbered run left once a command log is excluded.
export function countVerificationWalkthroughItems(text) {
  const lines = (text ?? "").split("\n");
  const numberedRun = findNumberedWalkthroughRun(lines);
  const markerRun = findMarkerWalkthroughRun(lines);
  if (!numberedRun && !markerRun) return 0;
  if (!markerRun) return numberedRun.count;
  if (!numberedRun) return markerRun.count;
  return numberedRun.endLineIndex > markerRun.endLineIndex ? numberedRun.count : markerRun.count;
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
//
// `reviewedHeadCommit` (default null, issue #335): the audit issue's own trusted frozen Stage 1
// reviewed head SHA, when the caller has one (lifecycle-gate.mjs's parseReviewedHeadCommitRef).
// Signal 1 does NOT accept this as an alternative to `mergeCommit` — a Stage 1 review finding on
// the PR that introduced this option proved that unsafe (see the module header comment above: a
// response naming an incorrect merge commit while still citing the correct reviewed head for the
// workflow-check item would otherwise pass). `mergeCommit` stays unconditionally required;
// `reviewedHeadCommit` only sharpens the failure `reason` text when signal 1 fails, so a fresh
// session can tell "cited nothing" apart from "cited the reviewed head but not the required
// merge commit" without that distinction ever changing the pass/fail outcome.
export function isCompletedStage2AuditReport(
  body,
  { mergeCommit, requireVerificationEvidence = true, requestedChecklist = null, reviewedHeadCommit = null } = {},
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
    if (!mergeCommit) {
      reasons.push("no merge commit given to check against");
    } else if (reviewedHeadCommit && bodyReferencesCommit(text, reviewedHeadCommit)) {
      // Diagnostic only (Stage 1 review finding, issue #335): the response does cite the audit's
      // trusted frozen reviewed head, but that is never sufficient on its own — see the module
      // header comment for why substituting it for the merge commit is unsafe.
      reasons.push(
        "does not reference the exact target merge commit (it cites the audit's trusted frozen reviewed head instead, " +
          "which only proves the revision CI ran against pre-merge, not that the response covered the actual merged result)",
      );
    } else {
      reasons.push("does not reference the exact target merge commit");
    }
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
