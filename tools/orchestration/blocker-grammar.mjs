#!/usr/bin/env node
// Shared, single-authority Blocker-prerequisite-declaration grammar for a thin control
// Issue's own "- **Blocker:**" field -- issue #437 (unit 437-B), Shared Contract design
// decision point 3. Built the same way tools/orchestration/dependency-grammar.mjs is built
// (one recognized clause, one canonicalizing formatter, one "unrecognized wording"
// fail-closed detector -- never a second, independently-drifting parser), so
// reconcile-control-blocker.mjs (the reader) can never diverge from whatever a future
// writer of this field adopts.
//
// Background: #437's own "Desired outcome" names two live reproductions of the same
// state-consistency class -- a resolved Founder decision (#408) and a completed
// prerequisite left BLOCKED (#440). #440's actual historical Blocker field was free prose
// ("#407/#408 must first terminalize their already-CLEAN #436 cycle ...") with no
// machine-recognized structure at all. This module defines the one canonical structured
// form a Blocker field can use to declare its prerequisites mechanically -- "Blocked by
// #N[, #N...]." -- so `reconcile-control-blocker.mjs` can reconcile a field written this
// way without guessing, while any Blocker field that does not use this exact clause (the
// #440 shape, or ordinary founder prose) fails closed to AMBIGUOUS_BLOCKER rather than
// being mechanically interpreted.
//
// Every function here is pure and has no dependency on GitHub state or any other
// tools/orchestration module.
//
// Tests: node --test tools/orchestration/blocker-grammar.test.mjs

// A "blocked by ..." clause: captures everything up to (but not including) the first
// ". " (period + whitespace), a terminating "." at the very end of the field, or the end
// of the field -- the same stopping rule dependency-grammar.mjs's DEPENDS_ON_CLAUSE uses.
// Case-insensitive ("Blocked by" / "blocked by" both match) and dotall (a wrapped
// multi-line field still matches as one clause).
const BLOCKED_BY_CLAUSE = /blocked by\s+(.*?)(?:\.\s|\.$|$)/is;
const ISSUE_TOKEN = /#(\d+)/g;
const ISSUE_TOKEN_EXISTS = /#\d+/;

// Pure. Extracts the list of issue numbers a control Issue's own "Blocker" field names as
// current prerequisites -- only issue numbers appearing inside a "blocked by ..." clause,
// stopping at the first following period (or end of field). Returns an empty array when no
// "blocked by" clause is present at all -- e.g. the "none" sentinel, or free prose like the
// real historical #440 shape -- a "#N" mention elsewhere in the field is never treated as a
// prerequisite by this function. Order and duplicates are preserved exactly as written,
// mirroring extractDependencyUnitIds's own precedent (no implicit de-duplication or
// re-sorting).
export function extractBlockedByIssueNumbers(blockerField) {
  const text = blockerField ?? "";
  const match = BLOCKED_BY_CLAUSE.exec(text);
  if (!match) return [];
  return [...match[1].matchAll(ISSUE_TOKEN)].map((m) => Number(m[1]));
}

// Pure. True when `blockerField` names an issue-shaped "#N" token that this grammar's own
// "blocked by ..." clause does not capture -- i.e. prose this grammar cannot
// deterministically resolve into a prerequisite list. Mirrors
// hasUnrecognizedDependencyWording's exact fail-closed shape: a recognized-and-fully-
// captured field (e.g. "Blocked by #407, #408.") returns false; a field naming an
// additional "#N" outside that clause, or free prose that mentions an issue without the
// recognized clause at all (the historical #440 shape), returns true. A field with no "#N"
// token anywhere (e.g. "none", or ordinary founder-decision-shaped prose with no issue
// reference) returns false -- there is nothing unrecognized to flag.
export function hasUnrecognizedBlockerWording(blockerField) {
  const text = blockerField ?? "";
  if (!text.trim()) return false;

  let remaining = text;
  const match = BLOCKED_BY_CLAUSE.exec(text);
  if (match) {
    remaining = remaining.slice(0, match.index) + remaining.slice(match.index + match[0].length);
  }

  return ISSUE_TOKEN_EXISTS.test(remaining);
}

// Pure. The single canonical serialization this grammar recognizes for a structured
// Blocker prerequisite list -- mirrors formatPrerequisitesDependencies's own precedent.
// This formatter is not required to be called by anything yet (Blocker fields are still
// hand-authored today), but establishes the one-true-serialization precedent
// dependency-grammar.mjs already set for "Prerequisites/dependencies", for a future writer
// to adopt without re-deriving the format.
//
// A non-empty `issueNumbers` array canonicalizes to "Blocked by #N, #N....": every number
// appears after one literal "Blocked by " token inside a single sentence ending in ".", so
// it round-trips back out through extractBlockedByIssueNumbers unchanged and in order, with
// nothing left over for hasUnrecognizedBlockerWording to flag. An empty/absent array
// canonicalizes to the fixed "none." literal -- this repository's own established
// live-interrupt-field sentinel (isNoneSentinel in ready-dispatch-gate.mjs), not
// dependency-grammar.mjs's "None." (a "Prerequisites/dependencies" field, not a live
// interrupt field, has no equivalent sentinel convention to match here).
export function formatBlockedBy(issueNumbers) {
  if (!Array.isArray(issueNumbers) || issueNumbers.length === 0) return "none.";
  return `Blocked by ${issueNumbers.map((n) => `#${n}`).join(", ")}.`;
}
