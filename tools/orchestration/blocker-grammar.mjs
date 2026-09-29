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

// The one complete canonical serialization this grammar accepts as fully well-formed --
// mirrors formatBlockedBy's own output exactly: the field must, in its entirety (once
// trimmed), read "Blocked by #N[, #N...]." with nothing before "Blocked by" and nothing after
// the final ".". Issue #768 Stage 1 finding: `hasUnrecognizedBlockerWording`'s own
// clause-then-remainder check only ever flags a *stray issue token* outside the matched
// clause -- it does not itself require the matched clause to be the canonical join-by-comma
// shape, and it does not require "blocked by" to appear at the very start of the field. Both
// gaps let non-canonical shapes slip through as if they were the documented grammar: "Blocked
// by #407 or #408." captures both numbers via the same all-must-close semantics the canonical
// comma-joined form uses, silently discarding the field's own stated "or" alternative; "Not
// blocked by #407." matches "blocked by #407" as a substring and leaves only "Not " outside
// the clause, which carries no issue token for the remainder check to flag, silently
// discarding the field's own stated negation. Requiring the whole field to match this single
// anchored pattern closes both: neither shape is anchored at position 0, and neither uses only
// ", " to join its issue tokens.
const CANONICAL_BLOCKED_BY_FIELD = /^blocked by\s+#\d+(?:\s*,\s*#\d+)*\.$/i;

function isCanonicalBlockedByField(text) {
  return CANONICAL_BLOCKED_BY_FIELD.test(String(text ?? "").trim());
}

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

// Pure. Single-authority classification of one control's raw "Blocker"/"Current blocker"
// field text (plus its two companion "Blocked lifecycle"/"Blocked route" fields) into the
// exact shape the rest of this repository's blocker machinery needs -- issue #768, the
// write-side half of the invariant `reconcile-control-blocker.mjs` already enforces at read
// time. Built as one pure function here (rather than re-derived independently in
// `reconcile-control-blocker.mjs`'s own read-time evaluator and a second write-time
// validator) so both call sites can never drift on what counts as a well-formed
// mechanically-reconcilable blocker declaration.
//
// `classifiers` is dependency-injected (never imported) so this module keeps its own
// documented "no dependency on GitHub state or any other tools/orchestration module"
// invariant intact -- callers already import `isNoneSentinel`/`isKnownLifecycleValue`/
// `isRouteCompatibleWithLifecycle`/`isBlockingLifecycleValue`/`isRouteBearingLifecycleValue`
// from `ready-dispatch-gate.mjs` for their own purposes and pass them straight through.
//
// `currentRouteRaw` (optional) is the control body's own present "- **Route:**" bullet value --
// the Route that will actually remain in place when "Blocked route" reads the "unchanged"
// sentinel. It is only consulted for that one case; a non-"unchanged" "Blocked route" never
// reads it.
//
// Returns one of:
//   { kind: "NONE" }                    -- absent field, or the explicit "none" sentinel.
//   { kind: "FREE_FORM" }                -- non-empty field naming no "#N" token anywhere --
//                                           a genuine free-form/manual/external blocker. Never
//                                           mechanically reconcilable, and that is by design,
//                                           not a defect: it stays representable exactly as
//                                           written and simply never advances past
//                                           AMBIGUOUS_BLOCKER at reconciliation time.
//   { kind: "UNRECOGNIZED_WORDING", reason }
//                                        -- names an issue reference outside the recognized
//                                           "Blocked by #N[, #N...]." clause -- a mixed
//                                           recognized/unrecognized shape this grammar
//                                           deliberately never partially interprets.
//   { kind: "MISSING_RESUME_STATE", reason, blockedByIssues }
//                                        -- the recognized clause names at least one
//                                           prerequisite, but "Blocked lifecycle"/"Blocked
//                                           route" are missing or empty.
//   { kind: "INVALID_RESUME_STATE", reason, blockedByIssues }
//                                        -- both companion fields are present, but the saved
//                                           Lifecycle value is not recognized, or the saved
//                                           Route is not compatible with it.
//   { kind: "RECONCILABLE", blockedByIssues, blockedLifecycle, blockedRoute }
//                                        -- fully well-formed: a genuine, currently-open
//                                           mechanically-reconcilable Issue-prerequisite
//                                           declaration with valid saved resume state.
//
// `UNRECOGNIZED_WORDING`, `MISSING_RESUME_STATE`, and `INVALID_RESUME_STATE` are the three
// ways an *explicit Issue-prerequisite blocker* (one naming at least one "#N" token) can be
// malformed; `NONE` and `FREE_FORM` are the two ways a control can validly carry no such
// declaration at all. A caller deciding whether to durably persist a proposed body treats
// only the first three as rejections -- see control-field-validator.mjs's
// `validateBlockerAuthoringField`, the write-side consumer this was built for.
export function evaluateBlockerAuthoring(
  { blockerRaw, blockedLifecycleRaw, blockedRouteRaw, currentRouteRaw },
  { isNoneSentinel, isKnownLifecycleValue, isRouteCompatibleWithLifecycle, isBlockingLifecycleValue, isRouteBearingLifecycleValue },
) {
  if (blockerRaw === null || blockerRaw === undefined || isNoneSentinel(blockerRaw)) {
    return { kind: "NONE" };
  }

  if (hasUnrecognizedBlockerWording(blockerRaw)) {
    return {
      kind: "UNRECOGNIZED_WORDING",
      reason:
        `"Blocker" field ${JSON.stringify(blockerRaw)} contains issue reference(s) outside the recognized ` +
        `"Blocked by #N[, #N...]." clause -- refusing to partially resolve a mixed recognized/unrecognized blocker`,
    };
  }

  const blockedByIssues = extractBlockedByIssueNumbers(blockerRaw);
  if (blockedByIssues.length === 0) {
    return { kind: "FREE_FORM" };
  }

  // Issue #768 Stage 1 finding: a nonempty extraction used to be treated as canonical without
  // validating the rest of the clause -- "Blocked by #407 or #408." and "Not blocked by #407."
  // both extracted a plausible-looking issue list while silently discarding the field's own
  // stated OR/negation semantics. Require the whole field to match the one documented
  // serialization before treating it as anything but unrecognized wording.
  if (!isCanonicalBlockedByField(blockerRaw)) {
    return {
      kind: "UNRECOGNIZED_WORDING",
      reason:
        `"Blocker" field ${JSON.stringify(blockerRaw)} contains issue reference(s) but does not match the canonical ` +
        `"Blocked by #N[, #N...]." serialization -- refusing to guess at non-canonical join/negation wording`,
    };
  }

  if (!blockedLifecycleRaw || !blockedLifecycleRaw.trim() || !blockedRouteRaw || !blockedRouteRaw.trim()) {
    return {
      kind: "MISSING_RESUME_STATE",
      blockedByIssues,
      reason:
        '"Blocked lifecycle" and "Blocked route" must both be present and non-empty before this control can be ' +
        `mechanically reconciled (Blocked lifecycle: ${JSON.stringify(blockedLifecycleRaw)}, Blocked route: ${JSON.stringify(blockedRouteRaw)})`,
    };
  }
  const blockedLifecycle = blockedLifecycleRaw.trim();
  const blockedRoute = blockedRouteRaw.trim();

  if (!isKnownLifecycleValue(blockedLifecycle)) {
    return {
      kind: "INVALID_RESUME_STATE",
      blockedByIssues,
      reason:
        `"Blocked lifecycle" value ${JSON.stringify(blockedLifecycle)} is not a recognized Lifecycle value -- ` +
        "refusing to persist an unknown resume state",
    };
  }

  // Issue #768 Stage 1 finding: `isKnownLifecycleValue` recognizes BLOCKED/BLOCKED_FAILURE/
  // BLOCKED_EXTERNAL too, so a saved resume Lifecycle could itself be a blocking value --
  // reconciliation would then restore a Lifecycle the very next dispatch-gate invocation stops
  // on again, defeating the release this declaration promises.
  if (isBlockingLifecycleValue(blockedLifecycle)) {
    return {
      kind: "INVALID_RESUME_STATE",
      blockedByIssues,
      reason:
        `"Blocked lifecycle" value ${JSON.stringify(blockedLifecycle)} is itself a blocking lifecycle -- resuming into ` +
        "it would immediately re-block instead of releasing this control",
    };
  }

  const isUnchangedRoute = blockedRoute.toLowerCase() === "unchanged";
  // The Route that will actually be in effect once this control resumes: the saved "Blocked
  // route" value itself, or -- when it reads the "unchanged" sentinel -- whatever the control's
  // own current "- **Route:**" field presently holds, since "unchanged" means that field is
  // never touched by the reconciling write.
  const effectiveRoute = isUnchangedRoute ? currentRouteRaw : blockedRoute;
  const effectiveRouteTrimmed = typeof effectiveRoute === "string" ? effectiveRoute.trim() : "";
  const effectiveRouteUnsettled = effectiveRouteTrimmed === "" || isNoneSentinel(effectiveRouteTrimmed);

  // Issue #768 Stage 1 finding: `isRouteCompatibleWithLifecycle` only ever constrains
  // READY_FOR_PLAN, so an unsettled ("none"/empty) Route was accepted as compatible with every
  // other Lifecycle -- including the route-bearing ones (READY and #397's pre-PR pipeline
  // values) that a fresh `ready-dispatch-gate.mjs` invocation would then reject as NOT_READY
  // ("Route is not settled") the moment this control resumed. The "unchanged" exemption made
  // this worse: it passed even when the control's own current Route was already unsettled,
  // since nothing validated what would actually remain. Only route-bearing resume Lifecycles
  // require a settled Route at all -- ordinary post-PR mid-cycle resumes (REVIEW, EXECUTING,
  // ...) never consult Route, and requiring one there would reject the real #726 recovery shape
  // (Lifecycle: REVIEW resumed with Route: none).
  if (isRouteBearingLifecycleValue(blockedLifecycle) && effectiveRouteUnsettled) {
    return {
      kind: "INVALID_RESUME_STATE",
      blockedByIssues,
      reason: isUnchangedRoute
        ? `"Blocked lifecycle" is ${JSON.stringify(blockedLifecycle)}, which requires a settled Route on resume, but ` +
          `"Blocked route: unchanged" would leave the control's current Route (${JSON.stringify(currentRouteRaw ?? null)}) unset/none`
        : `"Blocked lifecycle" is ${JSON.stringify(blockedLifecycle)}, which requires a settled Route on resume, but ` +
          `"Blocked route" is ${JSON.stringify(blockedRoute)}`,
    };
  }
  if (!effectiveRouteUnsettled && !isRouteCompatibleWithLifecycle(blockedLifecycle, effectiveRouteTrimmed)) {
    return {
      kind: "INVALID_RESUME_STATE",
      blockedByIssues,
      reason:
        `"Blocked lifecycle" is ${JSON.stringify(blockedLifecycle)} but the resuming Route resolves to ` +
        `${JSON.stringify(effectiveRouteTrimmed)}, which is not a compatible Route for that Lifecycle`,
    };
  }

  return { kind: "RECONCILABLE", blockedByIssues, blockedLifecycle, blockedRoute };
}
