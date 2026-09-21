// Tests for tools/orchestration/dependency-grammar.mjs — the shared dependency-declaration
// grammar issue #522 split out of prepare-dispatch-manifest.mjs so
// format-execution-plan.mjs's writer and prepare-dispatch-manifest.mjs's router can never
// independently drift on what constitutes a recognized "Prerequisites/dependencies" field.
//
// prepare-dispatch-manifest.test.mjs already covers extractDependencyUnitIds/
// hasUnrecognizedDependencyWording's own parsing behavior in depth (via that file's
// re-export of these same functions) — the tests here focus on formatPrerequisitesDependencies,
// the new canonical serializer, and its round-trip guarantee against the extractor/flagger
// it shares this module with.
//
// Run with:
//   node --test tools/orchestration/dependency-grammar.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  extractDependencyUnitIds,
  hasUnrecognizedDependencyWording,
  formatPrerequisitesDependencies,
} from "./dependency-grammar.mjs";

test("formatPrerequisitesDependencies serializes no dependencies as the fixed 'None.' literal", () => {
  assert.equal(formatPrerequisitesDependencies([]), "None.");
  assert.equal(formatPrerequisitesDependencies(undefined), "None.");
  assert.equal(formatPrerequisitesDependencies(null), "None.");
});

test("formatPrerequisitesDependencies serializes one or more dependencies as 'Depends on <ids>.'", () => {
  assert.equal(formatPrerequisitesDependencies(["294-A"]), "Depends on 294-A.");
  assert.equal(formatPrerequisitesDependencies(["294-A", "294-B"]), "Depends on 294-A, 294-B.");
  assert.equal(formatPrerequisitesDependencies(["294-A", "294-B", "294-C"]), "Depends on 294-A, 294-B, 294-C.");
});

test("every formatPrerequisitesDependencies output round-trips cleanly through extractDependencyUnitIds", () => {
  for (const deps of [[], ["294-A"], ["294-A", "294-B"], ["294-A", "294-B", "294-C", "294-D"]]) {
    const serialized = formatPrerequisitesDependencies(deps);
    assert.deepEqual(extractDependencyUnitIds(serialized), deps, `round trip failed for ${JSON.stringify(deps)}`);
  }
});

test("every formatPrerequisitesDependencies output is never flagged as unrecognized wording", () => {
  for (const deps of [[], ["294-A"], ["294-A", "294-B"], ["522-C", "522-D", "522-E"]]) {
    const serialized = formatPrerequisitesDependencies(deps);
    assert.equal(
      hasUnrecognizedDependencyWording(serialized),
      false,
      `expected ${JSON.stringify(serialized)} (from ${JSON.stringify(deps)}) to be recognized`,
    );
  }
});

test("formatPrerequisitesDependencies is the only canonical form — an equivalent but differently-worded field is not required to be produced", () => {
  // Documents intent rather than testing a negative space exhaustively: this writer never
  // emits the pre-existing hand-authored variants (e.g. "depends on 294-B (imports its
  // parser). Independent of 294-A.") even though the router still accepts them for
  // historical comments — see prepare-dispatch-manifest.test.mjs's own extractDependencyUnitIds
  // coverage for that reader-side leniency, which this module intentionally preserves
  // unchanged for backward compatibility with already-published plans.
  assert.equal(formatPrerequisitesDependencies(["294-B"]), "Depends on 294-B.");
});
