// Scenario 5 (Escalation/recombination) constructed exercise for worker unit 294-D.
//
// #294's own REAL history recorded NO genuine escalation/recombination event:
//   - 294-B's completion note: "No API ambiguity requiring REPLAN_REQUIRED was encountered."
//   - 294-C's completion note: "REPLAN_REQUIRED escalation was not triggered for any real
//     unit."
// So there is no real live occurrence of this scenario in #294's actual dispatch history to
// point to, and no other live multi-unit plan currently exists in this repository.
//
// Per worker unit 294-D's own contract (comment 5550653317) and its escalation condition,
// this script instead genuinely exercises the REAL shipped, unmodified
// `resolveUnitRoute` / `computeDispatchReady` / `buildManifestEntries` functions -- imported
// directly from tools/orchestration/prepare-dispatch-manifest.mjs, never reimplemented --
// against the REAL live #294 plan data (fetched via the real, unmodified
// parse-execution-plan.mjs / `gh` CLI), with one additional synthetic unit appended
// in-memory to simulate discovering, mid-plan, that a unit's capability/coupling cannot be
// resolved deterministically. This demonstrates:
//   (a) REPLAN_REQUIRED is correctly raised for exactly that one synthetic unit, with a
//       reason naming the unresolved capability class; and
//   (b) every one of the five REAL #294 units in the SAME plan/manifest run is completely
//       unaffected -- their routes, dispatch-readiness, and durable state are identical to
//       the real live run in scenario 4 -- i.e. one unit's unresolved coupling does not
//       corrupt or require re-deriving anything for the rest of the plan, and no micro-Issue
//       is created merely to flag it.
//
// This is clearly-labeled synthetic input (one added unit) layered onto real, unmodified
// live plan data and real, unmodified shipped code -- not a fabricated "passing result" for
// a real occurrence that did not happen. Run with:
//   node scenario5-exercise.mjs
// from this file's own directory (requires network/`gh` access to fetch #294's real
// comments, same as any other live parse-execution-plan.mjs invocation).

import path, { dirname } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

// This file lives at docs/execution-planning-proof-runs/<this file>, two directories below
// the repository root.
const REPO_ROOT = path.resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { runParseExecutionPlan } = await import(
  pathToFileURL(path.join(REPO_ROOT, "tools/orchestration/parse-execution-plan.mjs")).href
);
const { buildManifestEntries } = await import(
  pathToFileURL(path.join(REPO_ROOT, "tools/orchestration/prepare-dispatch-manifest.mjs")).href
);

const parsed = await runParseExecutionPlan({ repo: "LouPineWays/Loop-Dee-Loup", executionIssue: "294" });
if (parsed.exitCode !== 0) {
  console.error("Could not fetch the real live #294 plan:", parsed);
  process.exit(1);
}

// Append one synthetic unit, in-memory only, never posted to GitHub, simulating a unit
// whose capability/coupling was discovered mid-plan to be unresolvable.
const planWithSynthetic = {
  ...parsed.plan,
  units: {
    ...parsed.plan.units,
    "294-SYNTH": {
      unitId: "294-SYNTH",
      state: "PLANNED",
      filesSurfacesExpectedToChange: "`docs/some-newly-discovered-coupling.md` (new).",
      applicableRoleCapability: "quantum whisperer worker (undefined capability class).",
      prerequisitesDependencies: "none.",
    },
  },
};

function realFileExists(relPath) {
  // Same semantics as prepare-dispatch-manifest.mjs's own defaultFileExists.
  return existsSync(path.join(REPO_ROOT, relPath));
}

const entries = buildManifestEntries(planWithSynthetic, {
  fileExists: realFileExists,
  skillNames: [],
  personaNames: [],
});

console.log(JSON.stringify(entries, null, 2));
