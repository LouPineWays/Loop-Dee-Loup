// Scenario 4 (Deterministic route) constructed exercise. This scenario's own evidence has
// gone through eight correction rounds -- see 294-scenario-04-deterministic-route.json's
// `history` field for the complete record; summary: audit #396 found the original real-world
// example (real units 294-B/294-C routing to their own deliverables) was the wrong example
// entirely, fixed by PR #393's `isUnitsOwnDeliverable`; two subsequent synthetic substitutes
// were found invalid (PR #399's Stage 1 review, Stage 2 audit #400); PR #401's Stage 1 review
// then found the underlying `resolveUnitRoute` mechanism itself had a live truthfulness gap
// (existence-on-disk plus textual absence from "Required bounded outcome" is not proof of
// non-modification), fixed with an explicit "(invoked, not modified)" annotation requirement;
// Stage 2 audit #402 found that fix incomplete (it protected only the annotated entry, not
// the unit's whole outcome, so a second real deliverable named alongside it was silently
// skipped); PR #403's own Stage 1 review then found THAT fix incomplete too, twice over: a
// second surface named in plain unquoted text bypassed a backtick-code-span count entirely,
// and (in tension with that first finding) a genuinely single-surface field wrapped in its
// own explanatory prose or duplicate mention was needlessly declined.
//
// The `extractSoleInvokedNotModifiedPath` fix (in prepare-dispatch-manifest.mjs) resolved
// those by anchoring the ENTIRE "Files/surfaces expected to change" field to be exactly one
// backtick-quoted path immediately followed by the fixed "(invoked, not modified)" phrase and
// nothing else (an optional trailing period aside) -- see that function's own module comment
// for the full defect/fix history and the deliberate precision trade-off this whole-field
// anchor makes (a genuinely safe field wrapped in extra prose is declined too, rather than
// risk another per-token exception).
//
// Stage 2 audit #404 then found a deeper limit: this route verifies FIELD STRUCTURE only
// (Files/surfaces names exactly one valid pre-existing script) -- it cannot verify that a
// unit's full "Required bounded outcome" is completely satisfied by running that script
// alone. A unit whose outcome genuinely needs follow-up judgment beyond the script call (this
// exercise's own `validInvocationUnit` outcome text originally said "...and acting on its
// verdict", exposing exactly this gap) would still take this route. Closing that would
// require semantically parsing outcome prose -- the per-unit judgment #294's own founder
// clarification says deterministic routing must never become. This was resolved by
// documenting the limit as an explicit trust boundary in `resolveUnitRoute`'s own module
// comment (routing verifies field structure, not outcome-completeness -- a contract whose
// outcome isn't actually complete once its script runs is a contract-authoring error this
// tool does not catch, same as trusting a "State" field isn't lying) rather than attempting a
// further structural fix, and by correcting this exercise's own outcome text below to
// genuinely match what the route verifies rather than overclaim it.
//
// This exercise demonstrates THREE cases against the real, unmodified, shipped
// `resolveUnitRoute` (imported directly, never reimplemented):
//   1. A synthetic unit whose Files/surfaces field is EXACTLY the one annotated path and
//      nothing else correctly routes deterministically -- the case this scenario covers.
//   2. A valid contract whose outcome paraphrases the same file without quoting its exact
//      path, and whose Files/surfaces entry carries NO annotation, correctly falls through to
//      a reasoning-worker route instead of being wrongly treated as a deterministic
//      mechanism.
//   3. A unit whose Files/surfaces names BOTH an annotated, genuinely pre-existing script AND
//      a separate, real deliverable correctly falls through to a reasoning-worker route too,
//      rather than being routed solely to the annotated script and silently leaving the
//      separate deliverable unimplemented.
//
// Run with (from the repository root; no network/`gh` access required -- this exercise
// checks real on-disk file existence only, no live issue fetch):
//   node docs/execution-planning-proof-runs/294-scenario-04-deterministic-route-exercise.mjs

import path, { dirname } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

// This file lives at docs/execution-planning-proof-runs/<this file>, two directories below
// the repository root.
const REPO_ROOT = path.resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { resolveUnitRoute } = await import(
  pathToFileURL(path.join(REPO_ROOT, "tools/orchestration/prepare-dispatch-manifest.mjs")).href
);

function realFileExists(relPath) {
  // Same semantics as prepare-dispatch-manifest.mjs's own defaultFileExists.
  return existsSync(path.join(REPO_ROOT, relPath));
}

// Boilerplate common to all three synthetic units below, so each is a genuinely complete
// 13-field Worker Unit Contract -- a shape parse-execution-plan.mjs's own required-field
// validation (PR #393's Stage 1 fix) would accept if ever posted as a real comment, not an
// internally injected object missing fields that check never sees (Stage 1 review finding on
// PR #403: the prior version of this exercise populated only 6 of 13 fields per unit, which
// only proved resolveUnitRoute handles a malformed object, not that a valid planned unit can
// reach each case).
function commonFields(caseLabel) {
  return {
    parentExecutionIssue: "#294",
    authorityInputPointers: "this exercise's own module comment above.",
    relevantSharedContractPointer:
      "this Issue's \"## Shared Contract (v1)\" comment -- \"Route-relevant capability classes\" section.",
    observableCompletionCondition: `resolveUnitRoute() resolves this synthetic unit's '${caseLabel}' case to the route recorded in this exercise's own committed JSON output.`,
    verificationRequired: "manual review of this exercise script's own recorded output against its JSON artifact.",
    durableOutputStateExpected: "none -- this synthetic unit is never posted to GitHub; it exists only in this exercise's own in-memory run.",
    interruptEscalationConditions: "not applicable -- this is a constructed exercise input, not a real dispatched unit.",
  };
}

// Case 1: a synthetic unit that merely INVOKES a real, pre-existing script
// (tools/orchestration/ready-dispatch-gate.mjs), correctly annotated, and whose entire
// "Required bounded outcome" is EXACTLY that invocation -- running the script IS the whole
// job, with no follow-up judgment or action required beyond it (Stage 2 audit #404 found an
// earlier version of this outcome text said "...and acting on its verdict", which
// resolveUnitRoute's own structural check cannot actually verify is complete -- see this
// mechanism's own explicit trust-boundary comment in prepare-dispatch-manifest.mjs for why
// that gap is documented rather than chased with a fifth structural fix to resolveUnitRoute
// itself; this outcome text was corrected to make the case genuinely match what the route
// verifies, not overclaim it). Fixing that outcome text dropped the only concrete argument
// the gate script actually needs (`--control-issue <N>`, per ready-dispatch-gate.mjs's own
// required-arg check), leaving a unit that would exit with a missing-arg error if its
// described invocation were literally run -- a Stage 1 review finding on THIS correction's
// own first attempt (a unit's outcome must remain concretely executable, not merely
// structurally valid). Fixed by naming a real, valid control issue (#306, this scenario's
// own control issue) as the argument. A Stage 1 review finding on this exercise's very first
// attempt separately found an outcome requiring a second, unrelated deliverable the gate
// script cannot produce; this version fixes that too. Deliberately, "Required bounded
// outcome" below never repeats the invoked script's own path in backticks, because
// isUnitsOwnDeliverable() checks for the script's path appearing as a code span in this
// exact field -- naming it there would wrongly self-trigger the "own deliverable" exclusion.
const validInvocationUnit = {
  unitId: "294-SYNTH-ROUTE-VALID",
  ...commonFields("valid_invocation"),
  requiredBoundedOutcome:
    "Invoking the pre-existing orchestration gate check named in this unit's own " +
    "Files/surfaces field, as `node tools/orchestration/ready-dispatch-gate.mjs " +
    "--control-issue 306`, is this unit's entire required outcome, complete the moment that " +
    "gate check has run -- no follow-up action and no separate deliverable exists.",
  applicableRoleCapability: "bounded coding worker (see Shared Contract).",
  // Must be EXACTLY the one annotated path with nothing else, per
  // extractSoleInvokedNotModifiedPath's whole-field anchor -- any trailing explanation here
  // (even truthful) would fail the match and wrongly fall through to a reasoning-worker
  // route, exactly the over-strictness Stage 1 review's second finding on PR #403 warned
  // against introducing accidentally.
  filesSurfacesExpectedToChange: "`tools/orchestration/ready-dispatch-gate.mjs` (invoked, not modified).",
  prerequisitesDependencies: "none.",
  state: "PLANNED",
};

// Case 2: the exact adversarial shape Stage 1 review found on PR #401 -- a VALID contract
// (the unit genuinely intends to MODIFY this script) whose "Required bounded outcome"
// paraphrases the work without quoting the file's exact path, and whose Files/surfaces entry
// carries no "(invoked, not modified)" annotation because the unit is NOT merely invoking
// this file, it is changing it. Before this fix, a script's mere existence-on-disk plus
// (coincidental) textual absence from Required bounded outcome was sufficient to wrongly
// route this unit to "just run the pre-change file" -- exactly backwards, since the unit's
// whole job is to change that file.
const paraphrasedModificationUnit = {
  unitId: "294-SYNTH-ROUTE-INVALID",
  ...commonFields("paraphrased_modification"),
  requiredBoundedOutcome:
    "Update the plan-parsing table used by the routing tool so it recognizes one new " +
    "Worker Unit Contract field, and add a regression test for the new field.",
  applicableRoleCapability: "bounded coding worker (see Shared Contract).",
  filesSurfacesExpectedToChange:
    "`tools/orchestration/parse-execution-plan.mjs`, `tools/orchestration/parse-execution-plan.test.mjs`.",
  prerequisitesDependencies: "none.",
  state: "PLANNED",
};

// Case 3: the exact adversarial shape Stage 2 audit #402 found -- a valid contract that
// genuinely both invokes a real pre-existing script (annotated correctly) AND owes a
// separate, real deliverable the invoked script cannot produce. Naming a second surface
// alongside the annotated one must disqualify the deterministic route entirely, even though
// the annotated entry itself is perfectly truthful in isolation.
const mixedSurfaceUnit = {
  unitId: "294-SYNTH-ROUTE-MIXED",
  ...commonFields("mixed_surface"),
  requiredBoundedOutcome: "Create a new feature module.",
  applicableRoleCapability: "bounded coding worker (see Shared Contract).",
  filesSurfacesExpectedToChange:
    "`tools/orchestration/ready-dispatch-gate.mjs` (invoked, not modified), " +
    "`tools/orchestration/new-feature.mjs` (new).",
  prerequisitesDependencies: "none.",
  state: "PLANNED",
};

const results = {
  valid_invocation: resolveUnitRoute(validInvocationUnit, {
    fileExists: realFileExists,
    skillNames: [],
    personaNames: [],
  }),
  paraphrased_modification: resolveUnitRoute(paraphrasedModificationUnit, {
    fileExists: realFileExists,
    skillNames: [],
    personaNames: [],
  }),
  mixed_surface: resolveUnitRoute(mixedSurfaceUnit, {
    fileExists: realFileExists,
    skillNames: [],
    personaNames: [],
  }),
};

console.log(JSON.stringify(results, null, 2));
