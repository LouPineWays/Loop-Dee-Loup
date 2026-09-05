// Scenario 4 (Deterministic route) constructed exercise -- Stage 2 audit #400 correction,
// round 3 (this repository's own live evidence of a three-round correction sequence: audit
// #396 found the original real-world example was the wrong example; PR #399's Stage 1 review
// found the first synthetic substitute's outcome was unsatisfiable by its selected route;
// Stage 2 audit #400 found the second synthetic substitute's own contract was internally
// contradictory AND that the underlying resolveUnitRoute mechanism itself had a live,
// unguarded truthfulness gap -- see below).
//
// The ORIGINAL scenario-4 proof-run pointed at real #294 units 294-B/294-C, whose own
// "Files/surfaces expected to change" field happened to name the very script each unit was
// itself building. That was never the right example: the "deterministic route" case in
// #294's own "Verification" section is about a planner routing a unit to a genuine
// PRE-EXISTING mechanism it merely invokes, not a script the unit is itself producing.
// PR #393's Stage 1 fix (`isUnitsOwnDeliverable`) closed that specific gap for the real
// units, but Stage 2 audit #400's own Stage 1 review round (on PR #401) found the deeper
// underlying problem: `resolveUnitRoute` inferred "genuine pre-existing mechanism" merely
// from a script's existence-on-disk plus absence from "Required bounded outcome" -- which is
// unsound whenever a valid unit's outcome describes the same file without literally
// repeating its exact backtick path (a paraphrase). Such a unit would be silently
// short-circuited to "just run the pre-change file" when its real job is to modify it.
//
// The fix: `resolveUnitRoute` now requires an EXPLICIT, fixed annotation --
// "(invoked, not modified)" -- immediately after a script's own backtick-quoted path in
// "Files/surfaces expected to change" before that entry is eligible for the
// deterministic-script route at all (`hasInvokedNotModifiedAnnotation`). Mere existence and
// textual absence from "Required bounded outcome" are no longer sufficient by themselves.
//
// This exercise demonstrates THREE cases against the real, unmodified, shipped
// `resolveUnitRoute` (imported directly, never reimplemented):
//   1. A synthetic unit whose Files/surfaces entry carries the annotation, and names nothing
//      else, correctly routes deterministically -- the case this scenario is meant to cover.
//   2. The adversarial shape Stage 1 review found on PR #401 -- a valid contract whose
//      outcome paraphrases the same file without quoting its exact path, and whose
//      Files/surfaces entry carries NO annotation -- correctly falls through to a
//      reasoning-worker route instead of being wrongly treated as a deterministic mechanism.
//   3. The adversarial shape Stage 2 audit #402 found -- a unit whose Files/surfaces names
//      BOTH an annotated, genuinely pre-existing script AND a separate, real deliverable --
//      correctly falls through to a reasoning-worker route too, rather than being routed
//      solely to the annotated script and silently leaving the separate deliverable
//      unimplemented.
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

// Case 1: a synthetic unit that merely INVOKES a real, pre-existing script
// (tools/orchestration/ready-dispatch-gate.mjs), correctly annotated, and whose entire
// "Required bounded outcome" is satisfied by running that one script and acting on its
// verdict -- no separate deliverable is left outstanding (a Stage 1 review finding on this
// exercise's first attempt used an outcome requiring a second, unrelated deliverable the
// gate script cannot produce; this version fixes that too). Deliberately, "Required bounded
// outcome" below never repeats the invoked script's own path in backticks, because
// isUnitsOwnDeliverable() checks for the script's path appearing as a code span in this
// exact field -- naming it there would wrongly self-trigger the "own deliverable" exclusion.
const validInvocationUnit = {
  unitId: "294-SYNTH-ROUTE-VALID",
  state: "PLANNED",
  requiredBoundedOutcome:
    "Invoking the pre-existing orchestration gate check named in this unit's own " +
    "Files/surfaces field, against this synthetic unit's own (hypothetical) control issue, " +
    "and acting on its verdict is this unit's entire required outcome -- no separate " +
    "deliverable exists once that gate check has run.",
  applicableRoleCapability: "bounded coding worker (see Shared Contract).",
  filesSurfacesExpectedToChange:
    "`tools/orchestration/ready-dispatch-gate.mjs` (invoked, not modified) -- running it " +
    "fully satisfies this unit's own required outcome above.",
  prerequisitesDependencies: "none.",
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
  state: "PLANNED",
  requiredBoundedOutcome:
    "Update the plan-parsing table used by the routing tool so it recognizes one new " +
    "Worker Unit Contract field, and add a regression test for the new field.",
  applicableRoleCapability: "bounded coding worker (see Shared Contract).",
  filesSurfacesExpectedToChange:
    "`tools/orchestration/parse-execution-plan.mjs`, `tools/orchestration/parse-execution-plan.test.mjs`.",
  prerequisitesDependencies: "none.",
};

// Case 3: the exact adversarial shape Stage 2 audit #402 found -- a valid contract that
// genuinely both invokes a real pre-existing script (annotated correctly) AND owes a
// separate, real deliverable the invoked script cannot produce. Naming a second surface
// alongside the annotated one must disqualify the deterministic route entirely, even though
// the annotated entry itself is perfectly truthful in isolation.
const mixedSurfaceUnit = {
  unitId: "294-SYNTH-ROUTE-MIXED",
  state: "PLANNED",
  requiredBoundedOutcome: "Create a new feature module.",
  applicableRoleCapability: "bounded coding worker (see Shared Contract).",
  filesSurfacesExpectedToChange:
    "`tools/orchestration/ready-dispatch-gate.mjs` (invoked, not modified), " +
    "`tools/orchestration/new-feature.mjs` (new).",
  prerequisitesDependencies: "none.",
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
