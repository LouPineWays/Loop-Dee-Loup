// Scenario 4 (Deterministic route) constructed exercise -- Stage 2 audit #396 correction.
//
// The ORIGINAL scenario-4 proof-run (see 294-scenario-04-deterministic-route.json's own
// "honest_caveat" for the full history) pointed at real #294 units 294-B/294-C, whose own
// "Files/surfaces expected to change" field happened to name the very script each unit was
// itself building. That was never actually the right example for this scenario: the
// "deterministic route" case in #294's own "Verification" section is about a planner routing
// a unit to a genuine PRE-EXISTING mechanism the unit merely invokes, not a script the unit
// is itself producing. PR #393's Stage 1 fix (`isUnitsOwnDeliverable`) correctly closed that
// gap -- a script named as a unit's own deliverable in its "Required bounded outcome" field
// is now excluded from the deterministic-script route -- which means 294-B/294-C no longer
// demonstrate this scenario at all post-fix (see the refreshed live-run section of the
// sibling JSON artifact).
//
// No real unit in #294's own history has "Files/surfaces expected to change" naming a
// pre-existing script that is genuinely NOT that unit's own deliverable (every real unit in
// this plan built the scripts it named). So, per the same constructed-exercise precedent
// scenario 5 already established (294-scenario-05-escalation-recombination-exercise.mjs --
// see that file for the full precedent rationale), this script instead genuinely exercises
// the REAL shipped, unmodified `resolveUnitRoute` function -- imported directly from
// tools/orchestration/prepare-dispatch-manifest.mjs, never reimplemented -- against one
// synthetic unit constructed in-memory only (never posted to GitHub) whose
// "Files/surfaces expected to change" field names a real, already-existing repository script
// (`tools/orchestration/ready-dispatch-gate.mjs`, a pre-fix-era script this synthetic unit
// merely invokes) while its own "Required bounded outcome" names a completely different
// synthetic deliverable file. This demonstrates the fixed mechanism still correctly routes
// to a genuine pre-existing mechanism when that is what the unit's own fields actually
// describe -- the case scenario 4 is meant to cover.
//
// Run with:
//   node docs/execution-planning-proof-runs/294-scenario-04-deterministic-route-exercise.mjs
// from this file's own directory (no network/`gh` access required -- this exercise checks
// real on-disk file existence only, no live issue fetch).

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

// A synthetic unit that merely INVOKES a real, pre-existing script
// (tools/orchestration/ready-dispatch-gate.mjs) -- named in "Files/surfaces expected to
// change" -- while its own "Required bounded outcome" names a completely different,
// unrelated deliverable file. The pre-existing script is not this unit's own deliverable.
// Deliberately, "Required bounded outcome" below names ONLY the synthetic unit's own
// deliverable file -- never the invoked gate script's path in backticks -- because
// isUnitsOwnDeliverable() checks for the script's path appearing as a code span in this
// exact field. Mentioning the invoked script's path there (even just to describe invoking
// it) would wrongly self-trigger the "own deliverable" exclusion this exercise is meant to
// stay clear of; the field describes invoking a prerequisite gate check only in prose.
const syntheticUnit = {
  unitId: "294-SYNTH-ROUTE",
  state: "PLANNED",
  requiredBoundedOutcome:
    "`docs/some-other-synthetic-deliverable.md` (new) -- a short documentation note " +
    "unrelated to any existing script, produced after invoking a real, pre-existing " +
    "orchestration gate check as a prerequisite step.",
  applicableRoleCapability: "bounded coding worker (see Shared Contract).",
  filesSurfacesExpectedToChange:
    "`tools/orchestration/ready-dispatch-gate.mjs` (invoked as a pre-existing gate check, " +
    "not modified), `docs/some-other-synthetic-deliverable.md` (new).",
  prerequisitesDependencies: "none.",
};

const result = resolveUnitRoute(syntheticUnit, {
  fileExists: realFileExists,
  skillNames: [],
  personaNames: [],
});

console.log(JSON.stringify(result, null, 2));
