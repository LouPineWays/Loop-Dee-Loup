#!/usr/bin/env node
// Shared, single-authority dependency-declaration grammar for a #294-shaped execution
// plan's Worker Unit "Prerequisites/dependencies" field -- split out under issue #522 so
// `format-execution-plan.mjs` (the writer) and `prepare-dispatch-manifest.mjs` (the
// router) can never independently drift on what constitutes a recognized dependency
// declaration. Both files import these functions directly from here rather than each
// re-implementing any part of this grammar, so writer output is guaranteed consumable by
// manifest preparation by construction, not by convention.
//
// Background: #497/#499 made every OTHER Worker Unit Contract field deterministically
// writer-owned (capability tokens, outcome line-wrapping), but left
// "Prerequisites/dependencies" as free-form prose a planning worker hand-authored. The
// live #498/#500 plan hit exactly the predicted failure: a Worker Unit Contract's own
// dependency wording was not recognized by this grammar's own
// `hasUnrecognizedDependencyWording`, so `prepare-dispatch-manifest.mjs` marked the unit
// `dispatch_ready=false` with an "unrecognized prerequisites wording" note, and the
// controller manually hand-edited the comment to repair it -- a recurrence of the exact
// class #497 removed elsewhere. This module removes that class for dependency wording
// too: `format-execution-plan.mjs` accepts a structured `dependsOn` unit-ID list from the
// planning worker (never hand-authored prose for this field) and
// `formatPrerequisitesDependencies` below is the ONLY place "Prerequisites/dependencies"
// prose is composed. `validateWorkerUnitInput` in `format-execution-plan.mjs` additionally
// round-trips every canonicalized value through this same module's own
// `extractDependencyUnitIds`/`hasUnrecognizedDependencyWording` before publish, so writer
// and router are proven consistent by construction rather than merely by convention.
//
// Every function here is pure and has no dependency on `parse-execution-plan.mjs`,
// `prepare-dispatch-manifest.mjs`, or GitHub state -- this module is the smallest shared
// contract needed, not a general schema/parsing engine.
//
// Tests: node --test tools/orchestration/dependency-grammar.test.mjs

// A "depends on ..." clause: captures everything up to (but not including) the first
// ". " (period + whitespace), a terminating "." at the very end of the field, the word
// "independent" (a following "Independent of ..." clause is never itself part of the
// dependency list), or the end of the field. Case-insensitive ("Depends on" / "depends
// on" both match) and dotall (a wrapped multi-line field still matches as one clause).
const DEPENDS_ON_CLAUSE = /depends on\s+(.*?)(?:\.\s|\.$|\bindependent\b|$)/is;
const UNIT_ID_TOKEN = /\d+-[A-Za-z]+/g;
const UNIT_ID_TOKEN_EXISTS = /\d+-[A-Za-z]+/;
// A unit-ID mention inside one of these clauses is an explicit non-dependency mention this
// plan's own established prose vocabulary already uses (every real "no dependency" Worker
// Unit Contract field in this plan reads "none. Parallel with <ID>." and a genuine
// dependency field excludes a sibling with "Independent of <ID>.") -- neither is
// "unrecognized" wording.
const EXCLUDED_MENTION_CLAUSE = /\b(?:independent of|parallel with)\s+[^.]*\.?/gi;

// Pure. Extracts the list of unit IDs a unit's own "Prerequisites/dependencies" field
// names as genuine dependencies -- only unit IDs appearing inside a "depends on ..."
// clause, stopping at the first following period or the word "independent" (so a trailing
// "Independent of 294-X" clause in the same field is correctly excluded, per real fields
// like 294-C's "depends on 294-B (imports its parser). Independent of 294-A."). Returns an
// empty array when no "depends on" clause is present at all (e.g. "none. Parallel with
// 294-B.") -- a mention elsewhere in the field is never treated as a dependency.
export function extractDependencyUnitIds(prerequisitesField) {
  const text = prerequisitesField ?? "";
  const match = DEPENDS_ON_CLAUSE.exec(text);
  if (!match) return [];
  return [...match[1].matchAll(UNIT_ID_TOKEN)].map((m) => m[0]);
}

// Pure. True when `prerequisitesField` names a unit-ID-shaped token that this grammar's
// own "depends on ..." clause does not capture and that is not explicitly excluded by an
// "independent of ..."/"parallel with ..." clause -- i.e. prose this grammar cannot
// deterministically resolve into a dependency list. Recognized-but-empty fields (e.g.
// "none.", "Parallel with 294-B.") return false here; only a field naming a unit ID this
// grammar fails to recognize as a dependency clause is unrecognized.
export function hasUnrecognizedDependencyWording(prerequisitesField) {
  const text = prerequisitesField ?? "";
  if (!text.trim()) return false;

  let remaining = text;
  const dependsMatch = DEPENDS_ON_CLAUSE.exec(text);
  if (dependsMatch) {
    remaining = remaining.slice(0, dependsMatch.index) + remaining.slice(dependsMatch.index + dependsMatch[0].length);
  }
  remaining = remaining.replace(EXCLUDED_MENTION_CLAUSE, "");

  return UNIT_ID_TOKEN_EXISTS.test(remaining);
}

// Pure. The single canonical serialization this grammar recognizes for a structured
// dependency list -- the ONLY form `format-execution-plan.mjs` ever writes into a
// "Prerequisites/dependencies" bullet, so a planning worker never hand-authors this
// clause. `dependsOn` is an array of sibling unit IDs; this function does not itself
// validate their shape (the caller -- `validateWorkerUnitInput` -- does that, and also
// round-trips this function's own output back through `extractDependencyUnitIds`/
// `hasUnrecognizedDependencyWording` before publish, so the two never drift).
//
// An empty/absent array canonicalizes to the fixed "None." literal: this exact string is
// already proven recognized as "no dependency" by this module's own
// `extractDependencyUnitIds` (no "depends on" clause -> []) and
// `hasUnrecognizedDependencyWording` (no unit-ID-shaped token present -> false) --
// mirroring this repository's own pre-existing "none." convention.
//
// A non-empty array canonicalizes to "Depends on <id>, <id>, ....": every id appears
// after one literal "Depends on " token inside a single sentence ending in ".". This is
// exactly the shape `DEPENDS_ON_CLAUSE`'s case-insensitive "depends on ... .$" branch
// matches in full (the whole field, since the field contains nothing after the final
// "."), so every supplied id round-trips back out through `extractDependencyUnitIds`
// unchanged and in order, with nothing left over for `hasUnrecognizedDependencyWording`
// to flag.
export function formatPrerequisitesDependencies(dependsOn) {
  if (!Array.isArray(dependsOn) || dependsOn.length === 0) return "None.";
  return `Depends on ${dependsOn.join(", ")}.`;
}
