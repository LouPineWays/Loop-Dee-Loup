// Tests for tools/orchestration/prepare-dispatch-manifest.mjs -- worker unit 294-C's
// deterministic capability->route table and Dispatch Manifest composer.
//
// Run with:
//   node --test tools/orchestration/prepare-dispatch-manifest.test.mjs
//
// All fixtures below are synthetic unit/plan objects shaped like parse-execution-plan.mjs's
// own output, plus injected fileExists/skillNames/personaNames/parseExecutionPlanImpl --
// no live network calls. The one-time live run against the real issue #294 (this worker
// unit's observable completion condition) is a manual verification step, mirroring
// 294-B's own test-suite precedent.

import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCodeSpans,
  findExistingScriptPath,
  isUnitsOwnDeliverable,
  findSkillOrPersonaMatch,
  extractCapabilityClassLabel,
  resolveUnitRoute,
  extractDependencyUnitIds,
  hasUnrecognizedDependencyWording,
  isDoneState,
  computeDispatchReady,
  buildNote,
  buildManifestEntries,
  formatDispatchManifestBody,
  runPrepareDispatchManifest,
  CAPABILITY_CLASS_ROUTE_TABLE,
} from "./prepare-dispatch-manifest.mjs";

function fileExistsFrom(existingPaths) {
  const set = new Set(existingPaths);
  return (p) => set.has(p);
}

function unit(overrides = {}) {
  return {
    unitId: "294-X",
    state: "PLANNED",
    applicableRoleCapability: "bounded coding worker (see Shared Contract).",
    filesSurfacesExpectedToChange: "`tools/orchestration/example.mjs`, `tools/orchestration/example.test.mjs`.",
    prerequisitesDependencies: "none. Parallel with 294-A.",
    ...overrides,
  };
}

// --- extractCodeSpans --------------------------------------------------------------

test("extractCodeSpans finds every backtick span in order", () => {
  assert.deepEqual(extractCodeSpans("see `a/b.mjs` and `c/d.mjs`."), ["a/b.mjs", "c/d.mjs"]);
  assert.deepEqual(extractCodeSpans("no spans here"), []);
  assert.deepEqual(extractCodeSpans(null), []);
});

// --- findExistingScriptPath --------------------------------------------------------

test("findExistingScriptPath picks the first existing non-test script span", () => {
  const fileExists = fileExistsFrom(["tools/orchestration/parse-execution-plan.mjs"]);
  const field = "`tools/orchestration/parse-execution-plan.mjs`, `tools/orchestration/parse-execution-plan.test.mjs`.";
  assert.equal(findExistingScriptPath(field, { fileExists }), "tools/orchestration/parse-execution-plan.mjs");
});

test("findExistingScriptPath excludes .test. companions even when they exist", () => {
  const fileExists = fileExistsFrom(["tools/orchestration/example.test.mjs"]);
  const field = "`tools/orchestration/example.test.mjs`.";
  assert.equal(findExistingScriptPath(field, { fileExists }), null);
});

test("findExistingScriptPath returns null when nothing in the field exists on disk", () => {
  const fileExists = fileExistsFrom([]);
  const field = "`tools/orchestration/not-shipped-yet.mjs`.";
  assert.equal(findExistingScriptPath(field, { fileExists }), null);
});

test("findExistingScriptPath ignores non-path, non-script code spans (e.g. bare filenames)", () => {
  const fileExists = fileExistsFrom(["AGENTS.md"]);
  const field = "`AGENTS.md` (pointer-only addition, budget-respecting).";
  assert.equal(findExistingScriptPath(field, { fileExists }), null);
});

// --- isUnitsOwnDeliverable -----------------------------------------------------------

test("isUnitsOwnDeliverable is true when the script also appears in Required bounded outcome", () => {
  assert.equal(
    isUnitsOwnDeliverable(
      "tools/orchestration/prepare-dispatch-manifest.mjs",
      "`tools/orchestration/prepare-dispatch-manifest.mjs` (+ test) that consumes 294-B's parser.",
    ),
    true,
  );
});

test("isUnitsOwnDeliverable is false when the script is not mentioned in Required bounded outcome", () => {
  assert.equal(
    isUnitsOwnDeliverable(
      "tools/orchestration/parse-execution-plan.mjs",
      "`tools/orchestration/prepare-dispatch-manifest.mjs` (+ test) that consumes 294-B's parser.",
    ),
    false,
  );
});

test("isUnitsOwnDeliverable is false for an empty/absent Required bounded outcome field", () => {
  assert.equal(isUnitsOwnDeliverable("tools/orchestration/example.mjs", ""), false);
  assert.equal(isUnitsOwnDeliverable("tools/orchestration/example.mjs", null), false);
});

// --- findSkillOrPersonaMatch --------------------------------------------------------

test("findSkillOrPersonaMatch finds a named skill", () => {
  const result = findSkillOrPersonaMatch("route via the local-worker skill for this bounded subtask.", {
    skillNames: ["local-worker", "sift"],
    personaNames: ["audit-verdict-extractor"],
  });
  assert.deepEqual(result, { type: "skill", name: "local-worker" });
});

test("findSkillOrPersonaMatch finds a named persona when no skill matches", () => {
  const result = findSkillOrPersonaMatch("use the audit-verdict-extractor persona.", {
    skillNames: ["local-worker"],
    personaNames: ["audit-verdict-extractor"],
  });
  assert.deepEqual(result, { type: "persona", name: "audit-verdict-extractor" });
});

test("findSkillOrPersonaMatch returns null when nothing matches", () => {
  const result = findSkillOrPersonaMatch("bounded coding worker (see Shared Contract).", {
    skillNames: ["local-worker"],
    personaNames: ["audit-verdict-extractor"],
  });
  assert.equal(result, null);
});

// --- extractCapabilityClassLabel ----------------------------------------------------

test("extractCapabilityClassLabel strips the '(see Shared Contract)' parenthetical", () => {
  assert.equal(extractCapabilityClassLabel("bounded coding worker (see Shared Contract)."), "bounded coding worker");
  assert.equal(extractCapabilityClassLabel("doc-authority worker (see Shared Contract)."), "doc-authority worker");
});

test("extractCapabilityClassLabel truncates at a dash-separated elaboration", () => {
  assert.equal(
    extractCapabilityClassLabel("stronger/general worker — judgment-heavy (selecting representative real work)."),
    "stronger/general worker",
  );
  assert.equal(
    extractCapabilityClassLabel("integration worker (see Shared Contract) — judgment-heavy."),
    "integration worker",
  );
});

test("extractCapabilityClassLabel returns null for an empty field", () => {
  assert.equal(extractCapabilityClassLabel(""), null);
  assert.equal(extractCapabilityClassLabel(null), null);
});

// Real-world regression: worker unit 294-C's own real "Applicable role/capability" field
// (Stage 2 audit #396). Its explanatory prose after the class-label sentence carries its own
// unrelated em-dash ("Kept as one unit deliberately — a parallel-negative-control
// decision: ..."), which the pre-fix dash-only truncation wrongly treated as the label/
// trailing-detail separator, returning "bounded coding worker  Kept as one unit
// deliberately" instead of "bounded coding worker" -- a value that doesn't resolve in
// CAPABILITY_CLASS_ROUTE_TABLE and wrongly fell through to REPLAN_REQUIRED. Verbatim field
// text (whitespace/newlines collapsed to single spaces, matching parseBulletBlock's own
// collapsing), from https://github.com/LouPineWays/Loop-Dee-Loup/issues/294#issuecomment-5550653170.
const UNIT_294C_REAL_CAPABILITY_FIELD =
  "bounded coding worker (see Shared Contract). Kept as one unit deliberately — a " +
  "parallel-negative-control decision: these two scripts are individually small, share the " +
  "same immediate consumer (a future Route/Prepare-stage controller session) and the same " +
  "input (294-B's parser output), and splitting them into two separate dispatches was judged " +
  "not to earn its coordination cost over one worker producing both together.";

test("extractCapabilityClassLabel truncates at the first sentence boundary before checking for a dash (294-C real field, #396)", () => {
  assert.equal(extractCapabilityClassLabel(UNIT_294C_REAL_CAPABILITY_FIELD), "bounded coding worker");
});

test("extractCapabilityClassLabel still truncates at the dash when the field has no earlier sentence boundary (no regression)", () => {
  assert.equal(
    extractCapabilityClassLabel("stronger/general worker — judgment-heavy (widest authority/input sweep, cross-file synthesis, no fixed template)."),
    "stronger/general worker",
  );
});

// Stage 1 review finding on this correction's own first attempt (issue #396's correction
// PR): an unconditional sentence-boundary truncation -- applied to every field, regardless
// of whether the "(see Shared Contract)" marker is present -- cut a label short at an
// abbreviation's internal period ("e.g.") that happens to precede the field's real dash
// separator, producing "stronger/general worker (e.g" instead of "stronger/general worker".
// Gating sentence-truncation on the marker's presence (only that marker's own recovered
// period is a reliable class-label boundary) fixes this: a marker-less field falls through
// to the pre-existing dash-only truncation unchanged, so the dash after the abbreviation is
// still found and used, exactly as it was before the 294-C fix was introduced.
test("extractCapabilityClassLabel does not treat an abbreviation's period as a sentence boundary in a marker-less field", () => {
  assert.equal(
    extractCapabilityClassLabel("stronger/general worker (e.g. architecture review) — judgment-heavy."),
    "stronger/general worker (e.g. architecture review)",
  );
});

// --- resolveUnitRoute ---------------------------------------------------------------

test("resolveUnitRoute routes to a deterministic script when Files/surfaces already names one that exists", () => {
  const fileExists = fileExistsFrom(["tools/orchestration/parse-execution-plan.mjs"]);
  const u = unit({
    filesSurfacesExpectedToChange: "`tools/orchestration/parse-execution-plan.mjs`, `tools/orchestration/parse-execution-plan.test.mjs`.",
  });
  const result = resolveUnitRoute(u, { fileExists, skillNames: [], personaNames: [] });
  assert.equal(result.route, "deterministic script: tools/orchestration/parse-execution-plan.mjs");
  assert.equal(result.isReplanRequired, false);
});

// Real-world regression: worker unit 294-C's own contract names its own deliverable
// (prepare-dispatch-manifest.mjs) in "Files/surfaces expected to change" AND in "Required
// bounded outcome". After 294-C shipped, a live Dispatch Manifest run wrongly routed 294-C
// to "deterministic script: tools/orchestration/prepare-dispatch-manifest.mjs" -- i.e. "just
// run the existing file" -- which only happened to be harmless because 294-C was already
// DONE by then. A unit whose job is to build/modify a script must not be marked
// deterministically satisfied by running that script's pre-change contents.
test("resolveUnitRoute does NOT route to the deterministic-script route when the script is this unit's own deliverable", () => {
  const fileExists = fileExistsFrom(["tools/orchestration/prepare-dispatch-manifest.mjs"]);
  const u = unit({
    requiredBoundedOutcome:
      "`tools/orchestration/prepare-dispatch-manifest.mjs` (+ test) that consumes 294-B's shipped parser output.",
    filesSurfacesExpectedToChange:
      "`tools/orchestration/prepare-dispatch-manifest.mjs`, `tools/orchestration/prepare-dispatch-manifest.test.mjs`.",
    applicableRoleCapability: "bounded coding worker (see Shared Contract).",
  });
  const result = resolveUnitRoute(u, { fileExists, skillNames: [], personaNames: [] });
  // Falls through to the capability-class table instead of the script route.
  assert.equal(result.route, "bounded implementation worker");
  assert.equal(result.isReplanRequired, false);
});

// No-regression companion: a genuine pre-existing mechanism the unit merely invokes (not
// named in its own Required bounded outcome) must still resolve to the deterministic-script
// route exactly as before.
test("resolveUnitRoute still routes to the deterministic script when it is NOT this unit's own deliverable", () => {
  const fileExists = fileExistsFrom(["tools/orchestration/parse-execution-plan.mjs"]);
  const u = unit({
    requiredBoundedOutcome: "Consume the existing parser to produce a dispatch manifest.",
    filesSurfacesExpectedToChange:
      "`tools/orchestration/parse-execution-plan.mjs`, `tools/orchestration/parse-execution-plan.test.mjs`.",
  });
  const result = resolveUnitRoute(u, { fileExists, skillNames: [], personaNames: [] });
  assert.equal(result.route, "deterministic script: tools/orchestration/parse-execution-plan.mjs");
  assert.equal(result.isReplanRequired, false);
});

test("resolveUnitRoute routes to a matching skill before falling back to the capability-class table", () => {
  const fileExists = fileExistsFrom([]);
  const u = unit({ applicableRoleCapability: "route via the sift skill to evaluate this external tool." });
  const result = resolveUnitRoute(u, { fileExists, skillNames: ["sift"], personaNames: [] });
  assert.equal(result.route, "skill: sift");
  assert.equal(result.isReplanRequired, false);
});

test("resolveUnitRoute falls back to 'bounded implementation worker' for a bounded coding worker", () => {
  const fileExists = fileExistsFrom([]);
  const u = unit({ applicableRoleCapability: "bounded coding worker (see Shared Contract)." });
  const result = resolveUnitRoute(u, { fileExists, skillNames: [], personaNames: [] });
  assert.equal(result.route, "bounded implementation worker");
  assert.equal(result.isReplanRequired, false);
});

// Real-world regression: 294-C's own real capability field (#396), with no matching
// script/skill/persona, must resolve via the capability-class table to "bounded
// implementation worker" -- not fall through to REPLAN_REQUIRED.
test("resolveUnitRoute resolves 294-C's real capability field to 'bounded implementation worker', not REPLAN_REQUIRED (#396)", () => {
  const fileExists = fileExistsFrom([]);
  const u = unit({
    filesSurfacesExpectedToChange: "`tools/orchestration/some-other-unit-deliverable.mjs`.",
    applicableRoleCapability: UNIT_294C_REAL_CAPABILITY_FIELD,
  });
  const result = resolveUnitRoute(u, { fileExists, skillNames: [], personaNames: [] });
  assert.equal(result.route, "bounded implementation worker");
  assert.equal(result.isReplanRequired, false);
});

test("resolveUnitRoute falls back to 'stronger/general worker' for a doc-authority worker", () => {
  const fileExists = fileExistsFrom([]);
  const u = unit({
    filesSurfacesExpectedToChange: "`docs/operating-model.md`, `AGENTS.md` (pointer-only).",
    applicableRoleCapability: "doc-authority worker (see Shared Contract).",
  });
  const result = resolveUnitRoute(u, { fileExists, skillNames: [], personaNames: [] });
  assert.equal(result.route, "stronger/general worker");
  assert.equal(result.isReplanRequired, false);
});

test("resolveUnitRoute passes through a capability field that already states the final label verbatim", () => {
  const fileExists = fileExistsFrom([]);
  const u = unit({
    filesSurfacesExpectedToChange: "`docs/execution-planning-proof-runs.md` (new).",
    applicableRoleCapability: "stronger/general worker — judgment-heavy (selecting representative real work).",
  });
  const result = resolveUnitRoute(u, { fileExists, skillNames: [], personaNames: [] });
  assert.equal(result.route, "stronger/general worker");
});

// The required REPLAN_REQUIRED fixture: a capability class not in the fixed table, no
// matching script, no matching skill/persona -- routing cannot resolve deterministically.
test("resolveUnitRoute marks REPLAN_REQUIRED when nothing resolves deterministically", () => {
  const fileExists = fileExistsFrom([]);
  const u = unit({
    filesSurfacesExpectedToChange: "`docs/some-new-thing.md` (new).",
    applicableRoleCapability: "quantum whisperer worker (undefined capability class).",
  });
  const result = resolveUnitRoute(u, { fileExists, skillNames: ["sift"], personaNames: ["audit-verdict-extractor"] });
  assert.equal(result.route, "REPLAN_REQUIRED");
  assert.equal(result.isReplanRequired, true);
  assert.match(result.reason, /does not resolve/);
  assert.match(result.reason, /quantum whisperer worker/);
});

test("CAPABILITY_CLASS_ROUTE_TABLE contains exactly the three Shared Contract classes plus the two generic labels", () => {
  assert.deepEqual(Object.keys(CAPABILITY_CLASS_ROUTE_TABLE).sort(), [
    "bounded coding worker",
    "bounded implementation worker",
    "doc-authority worker",
    "integration worker",
    "stronger/general worker",
  ]);
});

// --- extractDependencyUnitIds --------------------------------------------------------

test("extractDependencyUnitIds returns [] when there is no 'depends on' clause", () => {
  assert.deepEqual(extractDependencyUnitIds("none. Parallel with 294-B."), []);
  assert.deepEqual(extractDependencyUnitIds("none."), []);
  assert.deepEqual(extractDependencyUnitIds(null), []);
});

test("extractDependencyUnitIds excludes a trailing 'Independent of' mention", () => {
  assert.deepEqual(
    extractDependencyUnitIds("depends on 294-B (imports its parser). Independent of 294-A."),
    ["294-B"],
  );
});

test("extractDependencyUnitIds extracts every unit ID in a multi-unit 'depends on' clause", () => {
  assert.deepEqual(
    extractDependencyUnitIds("depends on 294-A, 294-B, and 294-C all being DONE."),
    ["294-A", "294-B", "294-C"],
  );
  assert.deepEqual(
    extractDependencyUnitIds("depends on 294-A, 294-B, 294-C, and 294-D all being DONE."),
    ["294-A", "294-B", "294-C", "294-D"],
  );
});

// --- hasUnrecognizedDependencyWording -------------------------------------------------

test("hasUnrecognizedDependencyWording flags a unit-ID mention this parser's grammar does not capture", () => {
  assert.equal(hasUnrecognizedDependencyWording("Blocked by 294-A"), true);
  assert.equal(hasUnrecognizedDependencyWording("Requires 294-A"), true);
});

test("hasUnrecognizedDependencyWording does not flag a recognized 'depends on ... Independent of ...' field", () => {
  assert.equal(hasUnrecognizedDependencyWording("depends on 294-B (imports its parser). Independent of 294-A."), false);
});

test("hasUnrecognizedDependencyWording does not flag genuinely dependency-free text", () => {
  assert.equal(hasUnrecognizedDependencyWording("none. Parallel with 294-B."), false);
  assert.equal(hasUnrecognizedDependencyWording("none."), false);
  assert.equal(hasUnrecognizedDependencyWording(null), false);
});

// --- computeDispatchReady + unrecognized wording (fails closed) ------------------------

test("computeDispatchReady fails closed (not ready) for 'Blocked by 294-A' prerequisites wording", () => {
  const u = unit({ prerequisitesDependencies: "Blocked by 294-A." });
  const result = computeDispatchReady(u, { "294-X": u, "294-A": unit({ unitId: "294-A", state: "DONE" }) });
  assert.equal(result.ready, false);
  assert.equal(result.unrecognized, true);
});

test("computeDispatchReady fails closed (not ready) for 'Requires 294-A' prerequisites wording", () => {
  const u = unit({ prerequisitesDependencies: "Requires 294-A." });
  const result = computeDispatchReady(u, { "294-X": u, "294-A": unit({ unitId: "294-A", state: "DONE" }) });
  assert.equal(result.ready, false);
  assert.equal(result.unrecognized, true);
});

test("computeDispatchReady: 'depends on 294-B ... Independent of 294-A.' still extracts only 294-B and is not flagged as unrecognized", () => {
  const depB = unit({ unitId: "294-B", state: "DONE" });
  const u = unit({ prerequisitesDependencies: "depends on 294-B (imports its parser). Independent of 294-A." });
  const result = computeDispatchReady(u, { "294-X": u, "294-B": depB, "294-A": unit({ unitId: "294-A", state: "PLANNED" }) });
  assert.equal(result.ready, true);
  assert.deepEqual(result.dependencies, ["294-B"]);
  assert.equal(result.unrecognized, undefined);
});

test("computeDispatchReady: 'none. Parallel with 294-B.' still resolves ready with zero dependencies", () => {
  const u = unit({ prerequisitesDependencies: "none. Parallel with 294-B." });
  const result = computeDispatchReady(u, { "294-X": u, "294-B": unit({ unitId: "294-B", state: "PLANNED" }) });
  assert.equal(result.ready, true);
  assert.deepEqual(result.dependencies, []);
  assert.equal(result.unrecognized, undefined);
});

// --- isDoneState -----------------------------------------------------------------------

// Real Worker Unit Contract "State" fields carry a trailing one-line completion note and
// commit range after the word DONE (see #294 comment 5550652746's real State field:
// "DONE — implemented and verified; commits 192af18 ..."), per AGENTS.md's own "update
// this comment's own State field to DONE with a one-line note" convention. A live run of
// this tool against issue #294 itself caught an exact `state === "DONE"` equality check
// wrongly treating unit 294-B (genuinely DONE) as not-done, which in turn wrongly marked
// 294-C (which depends only on 294-B) as blocked. isDoneState must recognize this shape.
test("isDoneState recognizes DONE with a trailing completion note, not just the bare word", () => {
  assert.equal(isDoneState("DONE — implemented and verified; commits 192af18 (feature/x, parent 2ece1f8)."), true);
  assert.equal(isDoneState("DONE"), true);
  assert.equal(isDoneState("DONE."), true);
  assert.equal(isDoneState("PLANNED"), false);
  assert.equal(isDoneState("REPLAN_REQUIRED"), false);
  assert.equal(isDoneState(null), false);
  assert.equal(isDoneState(undefined), false);
});

// --- computeDispatchReady ------------------------------------------------------------

test("computeDispatchReady is always ready for a DONE unit", () => {
  const u = unit({ state: "DONE", prerequisitesDependencies: "depends on 294-B." });
  const result = computeDispatchReady(u, { "294-X": u, "294-B": unit({ unitId: "294-B", state: "PLANNED" }) });
  assert.equal(result.ready, true);
});

test("computeDispatchReady is ready when there are no prerequisites", () => {
  const u = unit({ prerequisitesDependencies: "none. Parallel with 294-A." });
  const result = computeDispatchReady(u, { "294-X": u });
  assert.equal(result.ready, true);
  assert.deepEqual(result.dependencies, []);
});

test("computeDispatchReady is ready only once every named dependency is DONE", () => {
  const dep = unit({ unitId: "294-B", state: "DONE" });
  const u = unit({ prerequisitesDependencies: "depends on 294-B (imports its parser)." });
  const unitsById = { "294-X": u, "294-B": dep };
  assert.equal(computeDispatchReady(u, unitsById).ready, true);

  dep.state = "PLANNED";
  assert.equal(computeDispatchReady(u, unitsById).ready, false);
});

test("computeDispatchReady recognizes a dependency DONE with a trailing completion note", () => {
  const dep = unit({ unitId: "294-B", state: "DONE — implemented and verified; commits 192af18." });
  const u = unit({ prerequisitesDependencies: "depends on 294-B (imports its parser)." });
  const result = computeDispatchReady(u, { "294-X": u, "294-B": dep });
  assert.equal(result.ready, true);
});

test("computeDispatchReady treats a referenced-but-missing dependency as not ready", () => {
  const u = unit({ prerequisitesDependencies: "depends on 294-Z." });
  const result = computeDispatchReady(u, { "294-X": u });
  assert.equal(result.ready, false);
  assert.deepEqual(result.notDone, ["294-Z"]);
});

// --- buildNote -------------------------------------------------------------------------

test("buildNote reports the REPLAN_REQUIRED reason when routing failed", () => {
  const routeResult = { isReplanRequired: true, reason: "some reason" };
  assert.equal(buildNote({ unit: unit(), routeResult, readiness: { ready: true, dependencies: [], notDone: [] } }), "some reason");
});

test("buildNote reports DONE for a completed unit", () => {
  const routeResult = { isReplanRequired: false };
  assert.equal(
    buildNote({ unit: unit({ state: "DONE" }), routeResult, readiness: { ready: true, dependencies: [], notDone: [] } }),
    "DONE",
  );
});

test("buildNote reports a distinct note for unrecognized prerequisites wording", () => {
  const routeResult = { isReplanRequired: false };
  const note = buildNote({
    unit: unit({ prerequisitesDependencies: "Blocked by 294-A." }),
    routeResult,
    readiness: { ready: false, dependencies: [], notDone: [], unrecognized: true },
  });
  assert.match(note, /unrecognized prerequisites wording/);
  assert.match(note, /Blocked by 294-A\./);
});

test("buildNote reports blocked dependencies when not ready", () => {
  const routeResult = { isReplanRequired: false };
  const note = buildNote({
    unit: unit(),
    routeResult,
    readiness: { ready: false, dependencies: ["294-B"], notDone: ["294-B"] },
  });
  assert.match(note, /blocked on: 294-B/);
});

// --- buildManifestEntries + formatDispatchManifestBody --------------------------------

function planWith(units) {
  return {
    planIndex: { url: "https://github.com/OWNER/REPO/issues/294#issuecomment-1" },
    units,
  };
}

test("buildManifestEntries produces one entry per unit, in plan.units order", () => {
  const fileExists = fileExistsFrom([]);
  const plan = planWith({
    "294-A": unit({ unitId: "294-A", state: "DONE", applicableRoleCapability: "doc-authority worker (see Shared Contract)." }),
    "294-B": unit({
      unitId: "294-B",
      state: "DONE",
      filesSurfacesExpectedToChange: "`tools/orchestration/parse-execution-plan.mjs`.",
    }),
  });
  const fileExistsB = fileExistsFrom(["tools/orchestration/parse-execution-plan.mjs"]);
  const entries = buildManifestEntries(plan, { fileExists: fileExistsB, skillNames: [], personaNames: [] });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].unitId, "294-A");
  assert.equal(entries[0].route, "stronger/general worker");
  assert.equal(entries[0].dispatchReady, true);
  assert.equal(entries[0].note, "DONE");
  assert.equal(entries[1].unitId, "294-B");
  assert.equal(entries[1].route, "deterministic script: tools/orchestration/parse-execution-plan.mjs");
});

test("formatDispatchManifestBody renders the exact fixed heading and per-unit line shape", () => {
  const plan = planWith({});
  const entries = [{ unitId: "294-A", route: "stronger/general worker", dispatchReady: true, note: "DONE" }];
  const body = formatDispatchManifestBody(plan, entries);
  assert.match(body, /^## Dispatch Manifest \(v1\)\n/);
  assert.match(body, /- \*\*Plan index:\*\* https:\/\/github\.com\/OWNER\/REPO\/issues\/294#issuecomment-1\n/);
  assert.match(body, /- 294-A: route=stronger\/general worker dispatch_ready=true note=DONE\n/);
});

// --- runPrepareDispatchManifest (end-to-end with injected plan/fs/post) ---------------

test("runPrepareDispatchManifest produces a plausible manifest for a 5-unit plan shaped like #294", async () => {
  const fakePlan = {
    ok: true,
    exitCode: 0,
    repo: "LouPineWays/Loop-Dee-Loup",
    executionIssue: 294,
    plan: planWith({
      "294-A": unit({
        unitId: "294-A",
        state: "DONE — completed; commits 57a777f..2ece1f8 on feature/294-execution-planning.",
        applicableRoleCapability: "doc-authority worker (see Shared Contract).",
        filesSurfacesExpectedToChange: "`docs/operating-model.md`, `AGENTS.md` (pointer-only).",
        prerequisitesDependencies: "none. Parallel with 294-B.",
      }),
      "294-B": unit({
        unitId: "294-B",
        state: "DONE — implemented and verified; commits 192af18 (feature/294-execution-planning, parent 2ece1f8).",
        applicableRoleCapability: "bounded coding worker (see Shared Contract).",
        filesSurfacesExpectedToChange: "`tools/orchestration/parse-execution-plan.mjs`, `tools/orchestration/parse-execution-plan.test.mjs`.",
        prerequisitesDependencies: "none. Parallel with 294-A.",
      }),
      "294-C": unit({
        unitId: "294-C",
        state: "PLANNED",
        applicableRoleCapability: "bounded coding worker (see Shared Contract).",
        filesSurfacesExpectedToChange: "`tools/orchestration/prepare-dispatch-manifest.mjs`, `tools/orchestration/prepare-dispatch-manifest.test.mjs`.",
        prerequisitesDependencies: "depends on 294-B (imports its parser). Independent of 294-A.",
      }),
      "294-D": unit({
        unitId: "294-D",
        state: "PLANNED",
        applicableRoleCapability: "stronger/general worker — judgment-heavy (selecting representative real work).",
        filesSurfacesExpectedToChange: "`docs/execution-planning-proof-runs.md` (new).",
        prerequisitesDependencies: "depends on 294-A, 294-B, and 294-C all being DONE.",
      }),
      "294-E": unit({
        unitId: "294-E",
        state: "PLANNED",
        applicableRoleCapability: "integration worker (see Shared Contract) — judgment-heavy.",
        filesSurfacesExpectedToChange: "none beyond authorized integration-seam fixes.",
        prerequisitesDependencies: "depends on 294-A, 294-B, 294-C, and 294-D all being DONE.",
      }),
    }),
  };
  const fileExists = fileExistsFrom([
    "tools/orchestration/parse-execution-plan.mjs",
    // 294-C's own scripts do not exist yet at plan time in this fixture.
  ]);

  const result = await runPrepareDispatchManifest(
    { executionIssue: 294 },
    { parseExecutionPlanImpl: async () => fakePlan, fileExists, skillNames: [], personaNames: [] },
  );

  assert.equal(result.exitCode, 0);
  const byId = Object.fromEntries(result.entries.map((e) => [e.unitId, e]));
  assert.equal(byId["294-A"].route, "stronger/general worker");
  assert.equal(byId["294-A"].dispatchReady, true);
  assert.equal(byId["294-B"].route, "deterministic script: tools/orchestration/parse-execution-plan.mjs");
  assert.equal(byId["294-B"].dispatchReady, true);
  assert.equal(byId["294-C"].route, "bounded implementation worker");
  assert.equal(byId["294-C"].dispatchReady, true); // depends only on 294-B, which is DONE
  assert.equal(byId["294-D"].route, "stronger/general worker");
  assert.equal(byId["294-D"].dispatchReady, false); // 294-C not DONE yet
  assert.equal(byId["294-E"].route, "stronger/general worker");
  assert.equal(byId["294-E"].dispatchReady, false);
  assert.match(result.body, /^## Dispatch Manifest \(v1\)\n/);
});

test("runPrepareDispatchManifest passes through a parse failure without composing a manifest", async () => {
  const failure = { exitCode: 2, ok: false, errors: ["boom"] };
  const result = await runPrepareDispatchManifest({ executionIssue: 294 }, { parseExecutionPlanImpl: async () => failure });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.errors, ["boom"]);
});

test("runPrepareDispatchManifest invokes postImpl with the composed body when --comment-id is given", async () => {
  const fakePlan = {
    ok: true,
    exitCode: 0,
    repo: "LouPineWays/Loop-Dee-Loup",
    executionIssue: 294,
    plan: planWith({ "294-A": unit({ unitId: "294-A", state: "DONE" }) }),
  };
  let captured = null;
  await runPrepareDispatchManifest(
    { executionIssue: 294, commentId: "12345" },
    {
      parseExecutionPlanImpl: async () => fakePlan,
      fileExists: fileExistsFrom([]),
      skillNames: [],
      personaNames: [],
      postImpl: (args) => {
        captured = args;
      },
    },
  );
  assert.equal(captured.commentId, "12345");
  assert.match(captured.body, /## Dispatch Manifest \(v1\)/);
});

// --- CLI ---------------------------------------------------------------------------

test("CLI: missing --execution-issue fails closed", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const scriptPath = fileURLToPath(new URL("./prepare-dispatch-manifest.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--execution-issue is required/);
  assert.equal(result.stdout, "");
});
