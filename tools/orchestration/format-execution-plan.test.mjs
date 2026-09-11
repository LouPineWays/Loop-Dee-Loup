// Tests for tools/orchestration/format-execution-plan.mjs — worker unit 497-A's
// deterministic writer/formatter for a #294-shaped multi-unit execution plan's durable
// artifacts (Plan Index / Shared Contract / Worker Unit Contract comments).
//
// Run with:
//   node --test tools/orchestration/format-execution-plan.test.mjs
//
// Every check below is offline: no live `gh`/network calls. The full-plan round-trip
// checks feed the writer's own freshly-formatted output through the REAL
// `parse-execution-plan.mjs` (and `prepare-dispatch-manifest.mjs`) functions against
// synthesized in-memory comment arrays — never a re-implementation of their grammar —
// per this unit's "Verification required" contract.

import test from "node:test";
import assert from "node:assert/strict";
import {
  STATE_VOCABULARY,
  CANONICAL_CAPABILITY_TOKENS,
  findCanonicalCapabilityToken,
  validateWorkerUnitInput,
  validateDependsOn,
  validateSharedContractInput,
  validatePlanIndexInput,
  validatePlanInput,
  formatSharedContractBody,
  formatWorkerUnitBody,
  formatUnitListEntry,
  formatPlanIndexBody,
  verifyFullRoundTrip,
  buildPlanArtifacts,
  publishPlanArtifacts,
} from "./format-execution-plan.mjs";
import { parseExecutionPlan, parseUnitListItem, parseBulletBlock } from "./parse-execution-plan.mjs";
import { CAPABILITY_CLASS_ROUTE_TABLE, resolveUnitRoute, extractCapabilityClassLabel, buildManifestEntries } from "./prepare-dispatch-manifest.mjs";
import { extractDependencyUnitIds, hasUnrecognizedDependencyWording } from "./dependency-grammar.mjs";

const REPO = "example/example";
const EXECUTION_ISSUE = 999;

function commentUrl(id) {
  return `https://github.com/${REPO}/issues/${EXECUTION_ISSUE}#issuecomment-${id}`;
}

function validWorkerUnit(unitId, overrides = {}) {
  return {
    unitId,
    requiredBoundedOutcome: "Do the bounded thing.",
    applicableRoleCapability: "bounded coding worker",
    authorityInputPointers: "Issue #999.",
    relevantSharedContractPointer: "this Issue's Shared Contract comment.",
    dependsOn: [],
    filesSurfacesExpectedToChange: "tools/orchestration/example.mjs.",
    observableCompletionCondition: "the script exists and works.",
    verificationRequired: "node --test passes.",
    durableOutputStateExpected: "commits on the shared branch.",
    interruptEscalationConditions: "none anticipated.",
    state: "PLANNED",
    ...overrides,
  };
}

function validPlanIndexUnit(unitId, overrides = {}) {
  return {
    unitId,
    state: "PLANNED",
    outcome: "First unit outcome.",
    commentUrl: commentUrl(101),
    ...overrides,
  };
}

function validInput(overrides = {}) {
  return {
    executionIssue: EXECUTION_ISSUE,
    sharedContract: { body: "Durable shared contract body text." },
    workerUnits: [validWorkerUnit("999-A")],
    planIndex: {
      planState: "PLANNED",
      dependencies: "none",
      dispatchManifest: "none",
      integrationRoute: "none",
      sharedContractUrl: commentUrl(100),
      units: [validPlanIndexUnit("999-A")],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// Canonical capability token matching (exact, case-insensitive, never fuzzy)
// ---------------------------------------------------------------------------------------

test("findCanonicalCapabilityToken matches case-insensitively but never fuzzily", () => {
  assert.equal(findCanonicalCapabilityToken("bounded coding worker"), "bounded coding worker");
  assert.equal(findCanonicalCapabilityToken("BOUNDED CODING WORKER"), "bounded coding worker");
  assert.equal(findCanonicalCapabilityToken("Bounded Coding Worker"), "bounded coding worker");
  assert.equal(findCanonicalCapabilityToken("  bounded coding worker  "), "bounded coding worker");
  assert.equal(findCanonicalCapabilityToken("bounded coding"), null);
  assert.equal(findCanonicalCapabilityToken("bounded coding worker!!"), null);
  assert.equal(findCanonicalCapabilityToken(""), null);
  assert.equal(findCanonicalCapabilityToken(null), null);
});

test("CANONICAL_CAPABILITY_TOKENS is exactly prepare-dispatch-manifest.mjs's own route-table keys", () => {
  assert.deepEqual(CANONICAL_CAPABILITY_TOKENS.slice().sort(), Object.keys(CAPABILITY_CLASS_ROUTE_TABLE).slice().sort());
});

// ---------------------------------------------------------------------------------------
// Verification (2): the #407/#439/#454 free-form-capability regression
// ---------------------------------------------------------------------------------------

test("validateWorkerUnitInput rejects free-form capability prose (#407/#439/#454 regression)", () => {
  const freeformValues = [
    "needs strong architectural judgment about routing tradeoffs and cross-file consistency",
    // Deliberately includes the dash-decorated shape resolveUnitRoute's OWN reader-side
    // leniency would still resolve correctly (extractCapabilityClassLabel strips the
    // dash suffix) -- the writer imposes a strictER input contract than the reader's
    // acceptance, exactly per #497 Required behavior item 3: descriptive detail belongs
    // in Authority/input pointers or Required bounded outcome, never here.
    "stronger/general worker — judgment-heavy (architecture review, cross-cutting risk assessment)",
    "a worker capable of understanding both the parser and the router deeply",
    "",
  ];
  for (const value of freeformValues) {
    const errors = validateWorkerUnitInput(validWorkerUnit("999-A", { applicableRoleCapability: value }), {
      unitId: "999-A",
    });
    assert.ok(
      errors.some((e) => /canonical token|missing required field "applicableRoleCapability"/.test(e)),
      `expected rejection for ${JSON.stringify(value)}, got: ${JSON.stringify(errors)}`,
    );
  }
});

// ---------------------------------------------------------------------------------------
// Verification (6): a genuinely ambiguous/invalid capability value fails closed, never
// defaulted or fuzzy-matched
// ---------------------------------------------------------------------------------------

test("an ambiguous/invalid capability value fails closed rather than being defaulted or fuzzy-matched", () => {
  const ambiguousValues = ["bounded", "coding worker", "Bounded Coding Worker!!", "generalist", "worker"];
  for (const value of ambiguousValues) {
    assert.equal(findCanonicalCapabilityToken(value), null, `expected ${JSON.stringify(value)} to not resolve`);
    const errors = validateWorkerUnitInput(validWorkerUnit("999-A", { applicableRoleCapability: value }), {
      unitId: "999-A",
    });
    assert.ok(errors.some((e) => /canonical token/.test(e)));
  }
});

// ---------------------------------------------------------------------------------------
// Verification (3): a valid-input control for every canonical capability class, and a
// no-regression check against prepare-dispatch-manifest.mjs's own routing.
// ---------------------------------------------------------------------------------------

test("every canonical capability class validates, formats, and resolves to the same manifest route as before this change", () => {
  for (const token of CANONICAL_CAPABILITY_TOKENS) {
    const unit = validWorkerUnit("999-A", { applicableRoleCapability: token });
    const errors = validateWorkerUnitInput(unit, { unitId: "999-A" });
    assert.deepEqual(errors, [], `expected ${JSON.stringify(token)} to be accepted, got: ${JSON.stringify(errors)}`);

    const body = formatWorkerUnitBody(unit, { executionIssue: EXECUTION_ISSUE });
    const parsedField = parseBulletBlock(body, "Applicable role/capability");
    assert.ok(parsedField, "the formatted body must carry a parseable Applicable role/capability bullet");
    const parsedLabel = extractCapabilityClassLabel(parsedField);
    assert.equal(parsedLabel.toLowerCase(), token.toLowerCase());

    const routeResult = resolveUnitRoute(
      {
        applicableRoleCapability: parsedField,
        filesSurfacesExpectedToChange: unit.filesSurfacesExpectedToChange,
        requiredBoundedOutcome: unit.requiredBoundedOutcome,
      },
      { fileExists: () => false },
    );
    assert.equal(routeResult.isReplanRequired, false, `expected ${token} to resolve, got REPLAN_REQUIRED`);
    assert.equal(routeResult.route, CAPABILITY_CLASS_ROUTE_TABLE[token]);
  }
});

// ---------------------------------------------------------------------------------------
// Verification (1): the #439 embedded-newline/continuation-line regression, both halves
// ---------------------------------------------------------------------------------------

test("validatePlanInput rejects a Plan Index outcome containing an embedded newline (#439 regression)", () => {
  const input = validInput({
    planIndex: {
      ...validInput().planIndex,
      units: [
        validPlanIndexUnit("999-A", {
          outcome: "Line one of the outcome.\nLine two that would become a continuation line.",
        }),
      ],
    },
  });
  const result = buildPlanArtifacts(input);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /embedded newline/.test(e)));
});

test("a long one-line outcome remains exactly one physical Plan Index source line and parses cleanly (#439 line-wrap regression)", () => {
  const longOutcome =
    "Implement a deterministic writer/validator for Plan Index, Shared Contract, and Worker Unit Contract " +
    "artifacts that fully satisfies every acceptance criterion listed on the parent execution issue without " +
    "requiring any manual or model-driven Markdown cleanup afterward, regardless of how long this sentence gets.";
  const input = validInput({
    planIndex: {
      ...validInput().planIndex,
      units: [validPlanIndexUnit("999-A", { outcome: longOutcome })],
    },
  });
  const result = buildPlanArtifacts(input);
  assert.equal(result.ok, true, JSON.stringify(result.errors));

  const unitLines = result.artifacts.planIndexBody.split("\n").filter((l) => l.includes("999-A:"));
  assert.equal(unitLines.length, 1, "the unit entry must occupy exactly one physical source line, never a continuation");

  const parsedUnit = parseUnitListItem(unitLines[0]);
  assert.ok(parsedUnit, "the emitted line must be parseable by parse-execution-plan.mjs's parseUnitListItem");
  assert.equal(parsedUnit.outcome, longOutcome);
  assert.equal(parsedUnit.unitId, "999-A");
  assert.equal(parsedUnit.state, "PLANNED");
});

test("formatUnitListEntry output round-trips through parseUnitListItem for outcomes containing internal punctuation", () => {
  const tricky = [
    "Do X (see the referenced script) and confirm it works.",
    "Handle A — then B — then C, in that order.",
    "A single (parenthetical) note at the very end (of the sentence)",
  ];
  for (const outcome of tricky) {
    const line = formatUnitListEntry({ unitId: "999-A", state: "PLANNED", outcome, url: commentUrl(101) });
    const parsed = parseUnitListItem(line);
    assert.ok(parsed, `expected ${JSON.stringify(line)} to parse`);
    assert.equal(parsed.outcome, outcome);
    assert.equal(parsed.url, commentUrl(101));
  }
});

// ---------------------------------------------------------------------------------------
// Verification (5): missing-required-value rejection (Worker Unit and Shared Contract)
// ---------------------------------------------------------------------------------------

test("buildPlanArtifacts rejects a plan missing a required Worker Unit Contract field", () => {
  const unit = validWorkerUnit("999-A");
  delete unit.verificationRequired;
  const result = buildPlanArtifacts(validInput({ workerUnits: [unit] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /verificationRequired/.test(e)));
});

test("buildPlanArtifacts rejects a plan missing the required Shared Contract body", () => {
  const result = buildPlanArtifacts(validInput({ sharedContract: {} }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Shared Contract/.test(e) && /body/.test(e)));
});

test("buildPlanArtifacts rejects a Plan Index missing required fields", () => {
  const base = validInput();
  for (const key of ["planState", "dependencies", "dispatchManifest", "integrationRoute", "sharedContractUrl"]) {
    const planIndex = { ...base.planIndex };
    delete planIndex[key];
    const result = buildPlanArtifacts({ ...base, planIndex });
    assert.equal(result.ok, false, `expected rejection when "${key}" is missing`);
    assert.ok(result.errors.some((e) => e.includes(key)), `expected an error mentioning "${key}", got: ${JSON.stringify(result.errors)}`);
  }
});

test("buildPlanArtifacts rejects a Plan Index unit missing required fields", () => {
  const base = validInput();
  for (const key of ["unitId", "state", "outcome", "commentUrl"]) {
    const unit = { ...base.planIndex.units[0] };
    delete unit[key];
    const result = buildPlanArtifacts({ ...base, planIndex: { ...base.planIndex, units: [unit] } });
    assert.equal(result.ok, false, `expected rejection when unit "${key}" is missing`);
  }
});

// ---------------------------------------------------------------------------------------
// Verification (4): full parser round-trip (writer output -> real parse-execution-plan.mjs)
// ---------------------------------------------------------------------------------------

test("buildPlanArtifacts's output round-trips through the real parseExecutionPlan with two units", () => {
  const input = validInput({
    workerUnits: [
      validWorkerUnit("999-A"),
      validWorkerUnit("999-B", { applicableRoleCapability: "doc-authority worker", state: "DONE" }),
    ],
    planIndex: {
      ...validInput().planIndex,
      units: [
        validPlanIndexUnit("999-A", { commentUrl: commentUrl(101) }),
        validPlanIndexUnit("999-B", { state: "DONE", outcome: "Second unit outcome.", commentUrl: commentUrl(102) }),
      ],
    },
  });
  const result = buildPlanArtifacts(input);
  assert.equal(result.ok, true, JSON.stringify(result.errors));

  const comments = [
    { id: 100, html_url: commentUrl(100), body: result.artifacts.sharedContractBody },
    { id: 101, html_url: commentUrl(101), body: result.artifacts.workerUnitBodies["999-A"] },
    { id: 102, html_url: commentUrl(102), body: result.artifacts.workerUnitBodies["999-B"] },
    { id: 103, html_url: commentUrl(103), body: result.artifacts.planIndexBody },
  ];
  const parsed = parseExecutionPlan(comments, { executionIssue: EXECUTION_ISSUE });
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.plan.planIndex.planState, "PLANNED");
  assert.equal(parsed.plan.units["999-A"].applicableRoleCapability, "bounded coding worker (see Shared Contract).");
  assert.equal(parsed.plan.units["999-B"].applicableRoleCapability, "doc-authority worker (see Shared Contract).");
  assert.equal(parsed.plan.units["999-B"].state, "DONE");
  assert.equal(parsed.plan.units["999-A"].indexOutcome, "First unit outcome.");
  assert.equal(parsed.plan.units["999-B"].indexOutcome, "Second unit outcome.");
});

test("verifyFullRoundTrip catches a mismatched Plan Index / Worker Unit set internally, before external round-trip is attempted", () => {
  // A Plan Index naming a unit absent from workerUnits is already rejected by
  // validatePlanInput's own cross-check -- confirm buildPlanArtifacts surfaces that as a
  // clean validation error rather than a raw parser crash.
  const input = validInput({
    planIndex: {
      ...validInput().planIndex,
      units: [validPlanIndexUnit("999-Z")],
    },
  });
  const result = buildPlanArtifacts(input);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /999-Z/.test(e) && /workerUnits/.test(e)));
});

test("validatePlanInput rejects a workerUnits entry absent from the Plan Index Units list (#497 Stage 1 review finding)", () => {
  // The reverse direction of the mismatch above: a submitted Worker Unit Contract that the
  // Plan Index never lists would still be persisted on --publish, yet the Plan Index (and
  // any Dispatch Manifest derived from it) would never reference it, so it could never be
  // dispatched even though the submitted plan included it.
  const input = validInput({
    workerUnits: [validWorkerUnit("999-A"), validWorkerUnit("999-B")],
    planIndex: { ...validInput().planIndex, units: [validPlanIndexUnit("999-A")] },
  });
  const result = validatePlanInput(input);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /999-B/.test(e) && /Plan Index/.test(e)),
    `expected a reverse-direction mismatch error, got: ${JSON.stringify(result.errors)}`,
  );
});

// ---------------------------------------------------------------------------------------
// Dependency declarations (#522): structured `dependsOn` replaces hand-authored
// "Prerequisites/dependencies" prose, closing the live #498/#500 regression where a
// planner-authored dependency clause was not recognized by prepare-dispatch-manifest.mjs's
// own grammar and required manual Worker Unit Contract repair.
// ---------------------------------------------------------------------------------------

test("validateWorkerUnitInput requires dependsOn as an array; a hand-authored prose string is rejected, not silently accepted", () => {
  const unit = validWorkerUnit("999-A");
  delete unit.dependsOn;
  unit.prerequisitesDependencies = "depends on 999-B (imports its parser).";
  const errors = validateWorkerUnitInput(unit, { unitId: "999-A", executionIssue: EXECUTION_ISSUE });
  assert.ok(
    errors.some((e) => /dependsOn/.test(e) && /missing required field/.test(e)),
    `expected a missing-dependsOn rejection, got: ${JSON.stringify(errors)}`,
  );
});

test("validateDependsOn accepts [] (no dependencies) and a canonical execution-scoped sibling list", () => {
  assert.deepEqual(validateDependsOn([], { unitId: "999-A", executionIssue: EXECUTION_ISSUE, label: "unit" }), []);
  assert.deepEqual(
    validateDependsOn(["999-B", "999-C"], { unitId: "999-A", executionIssue: EXECUTION_ISSUE, label: "unit" }),
    [],
  );
});

test("validateDependsOn rejects a non-array, self-dependency, duplicates, whitespace, and out-of-convention IDs", () => {
  const ctx = { unitId: "999-A", executionIssue: EXECUTION_ISSUE, label: "unit" };
  assert.ok(validateDependsOn("999-B", ctx).some((e) => /must be an array/.test(e)));
  assert.ok(validateDependsOn(undefined, ctx).some((e) => /missing required field "dependsOn"/.test(e)));
  assert.ok(validateDependsOn(["999-A"], ctx).some((e) => /self-dependency/.test(e)));
  assert.ok(validateDependsOn(["999-B", "999-B"], ctx).some((e) => /duplicate/.test(e)));
  assert.ok(validateDependsOn(["999 B"], ctx).some((e) => /whitespace/.test(e)));
  assert.ok(validateDependsOn(["1000-B"], ctx).some((e) => /execution-scoped/.test(e)));
  assert.ok(validateDependsOn(["not-a-unit-id"], ctx).some((e) => /execution-scoped/.test(e)));
});

test("formatPrerequisitesDependencies canonical forms round-trip through the router's own extractDependencyUnitIds/hasUnrecognizedDependencyWording", () => {
  const noneBody = formatWorkerUnitBody(validWorkerUnit("999-A", { dependsOn: [] }), { executionIssue: EXECUTION_ISSUE });
  const noneField = parseBulletBlock(noneBody, "Prerequisites/dependencies");
  assert.equal(noneField, "None.");
  assert.deepEqual(extractDependencyUnitIds(noneField), []);
  assert.equal(hasUnrecognizedDependencyWording(noneField), false);

  const oneDepBody = formatWorkerUnitBody(validWorkerUnit("999-B", { dependsOn: ["999-A"] }), {
    executionIssue: EXECUTION_ISSUE,
  });
  const oneDepField = parseBulletBlock(oneDepBody, "Prerequisites/dependencies");
  assert.equal(oneDepField, "Depends on 999-A.");
  assert.deepEqual(extractDependencyUnitIds(oneDepField), ["999-A"]);
  assert.equal(hasUnrecognizedDependencyWording(oneDepField), false);

  const multiDepBody = formatWorkerUnitBody(validWorkerUnit("999-D", { dependsOn: ["999-A", "999-B", "999-C"] }), {
    executionIssue: EXECUTION_ISSUE,
  });
  const multiDepField = parseBulletBlock(multiDepBody, "Prerequisites/dependencies");
  assert.equal(multiDepField, "Depends on 999-A, 999-B, 999-C.");
  assert.deepEqual(extractDependencyUnitIds(multiDepField), ["999-A", "999-B", "999-C"]);
  assert.equal(hasUnrecognizedDependencyWording(multiDepField), false);
});

test("a plan authored through dependsOn never publishes a Worker Unit dependency field prepare-dispatch-manifest.mjs classifies as unrecognized (#522 acceptance criterion)", () => {
  // Every dependsOn-derived unit across this whole test file, not just a hand-picked
  // sample, must be unrecognized-proof -- confirm no unit input anywhere in this file's own
  // fixtures could ever have produced the #498/#500 "unrecognized prerequisites wording"
  // note by construction.
  for (const deps of [[], ["999-A"], ["999-A", "999-B"], ["999-A", "999-B", "999-C"]]) {
    const serialized = formatPrerequisitesDependenciesLike(deps);
    assert.equal(hasUnrecognizedDependencyWording(serialized), false, `dependsOn=${JSON.stringify(deps)}`);
  }

  function formatPrerequisitesDependenciesLike(dependsOn) {
    const unit = validWorkerUnit("999-Z", { dependsOn });
    const body = formatWorkerUnitBody(unit, { executionIssue: EXECUTION_ISSUE });
    return parseBulletBlock(body, "Prerequisites/dependencies");
  }
});

test("regression (#498/#500 failure class): a dependsOn-authored plan resolves dispatch_ready correctly through the real router, with no manual Worker Unit Contract repair", () => {
  // Reproduces the live #498/#500 shape: unit B depends on sibling unit A. Previously a
  // planner hand-authoring "Prerequisites/dependencies" prose could produce wording
  // prepare-dispatch-manifest.mjs's own grammar did not recognize, yielding
  // dispatch_ready=false with an "unrecognized prerequisites wording" note even once A was
  // DONE. Authored via dependsOn instead, the writer's own canonical serialization must
  // always be recognized, and readiness must correctly track A's own State.
  const unitA = validWorkerUnit("999-A", { dependsOn: [], state: "PLANNED" });
  const unitB = validWorkerUnit("999-B", { dependsOn: ["999-A"], state: "PLANNED" });
  const input = validInput({
    workerUnits: [unitA, unitB],
    planIndex: {
      ...validInput().planIndex,
      units: [
        validPlanIndexUnit("999-A", { commentUrl: commentUrl(101) }),
        validPlanIndexUnit("999-B", { outcome: "Second unit outcome.", commentUrl: commentUrl(102) }),
      ],
    },
  });
  const built = buildPlanArtifacts(input);
  assert.equal(built.ok, true, JSON.stringify(built.errors));

  const comments = [
    { id: 100, html_url: commentUrl(100), body: built.artifacts.sharedContractBody },
    { id: 101, html_url: commentUrl(101), body: built.artifacts.workerUnitBodies["999-A"] },
    { id: 102, html_url: commentUrl(102), body: built.artifacts.workerUnitBodies["999-B"] },
    { id: 103, html_url: commentUrl(103), body: built.artifacts.planIndexBody },
  ];
  const parsed = parseExecutionPlan(comments, { executionIssue: EXECUTION_ISSUE });
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));

  // A is still PLANNED (not DONE): B must not be dispatch_ready, and — the actual #498/#500
  // defect — must never be flagged as "unrecognized prerequisites wording".
  const notYetReady = buildManifestEntries(parsed.plan, { fileExists: () => false });
  const bEntryNotYetReady = notYetReady.find((e) => e.unitId === "999-B");
  assert.equal(bEntryNotYetReady.dispatchReady, false);
  assert.doesNotMatch(bEntryNotYetReady.note, /unrecognized prerequisites wording/);
  assert.match(bEntryNotYetReady.note, /blocked on: 999-A/);

  // Once A is DONE, B becomes dispatch_ready with no manual edit to either comment.
  parsed.plan.units["999-A"].state = "DONE";
  const nowReady = buildManifestEntries(parsed.plan, { fileExists: () => false });
  const bEntryNowReady = nowReady.find((e) => e.unitId === "999-B");
  assert.equal(bEntryNowReady.dispatchReady, true);
  assert.doesNotMatch(bEntryNowReady.note, /unrecognized prerequisites wording/);
});

// ---------------------------------------------------------------------------------------
// Structural validation coverage: unitId shape, duplicates, missing executionIssue, etc.
// ---------------------------------------------------------------------------------------

test("validatePlanInput requires a positive integer executionIssue", () => {
  for (const bad of [undefined, null, 0, -1, "497", 1.5]) {
    const result = validatePlanInput(validInput({ executionIssue: bad }));
    assert.equal(result.ok, false, `expected rejection for executionIssue=${JSON.stringify(bad)}`);
  }
});

test("validatePlanInput rejects an empty input object", () => {
  const result = validatePlanInput({ executionIssue: EXECUTION_ISSUE });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /at least one of/.test(e)));
});

test("validatePlanInput rejects a unitId containing whitespace or a colon", () => {
  for (const badId of ["999 A", "999:A", "999\tA"]) {
    const result = validatePlanInput(validInput({ workerUnits: [validWorkerUnit(badId)] }));
    assert.equal(result.ok, false, `expected rejection for unitId ${JSON.stringify(badId)}`);
  }
});

test("validatePlanInput rejects duplicate workerUnits entries for the same unitId", () => {
  const result = validatePlanInput(validInput({ workerUnits: [validWorkerUnit("999-A"), validWorkerUnit("999-A")] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /duplicate/.test(e)));
});

test("validatePlanInput enforces the execution-scoped unitId convention against the current executionIssue (#497 Stage 1 review finding)", () => {
  // docs/operating-model.md § Durable plan artifacts fixes the convention as
  // "<execution-issue-number>-<Letter>". prepare-dispatch-manifest.mjs's own dependency
  // matcher (UNIT_ID_TOKEN = /\d+-[A-Za-z]+/) silently treats an out-of-convention ID as no
  // dependency at all, so this must be rejected at write time, not merely discovered later.
  for (const badId of ["foo", "999", "A-999", "1000-A"]) {
    const input = validInput({
      workerUnits: [validWorkerUnit(badId)],
      planIndex: { ...validInput().planIndex, units: [validPlanIndexUnit(badId)] },
    });
    const result = validatePlanInput(input);
    assert.equal(result.ok, false, `expected rejection for unitId ${JSON.stringify(badId)}`);
    assert.ok(
      result.errors.some((e) => /execution-scoped/.test(e)),
      `expected an execution-scoped-convention error, got: ${JSON.stringify(result.errors)}`,
    );
  }
});

test("validatePlanIndexInput and validateWorkerUnitInput skip the execution-scoped check when executionIssue is not supplied", () => {
  // Existing direct callers (e.g. this file's own validatePlanIndexInput(planIndex) tests
  // below) do not pass executionIssue at all -- the new check must not force that on every
  // caller; validatePlanInput is the one that always threads it through.
  assert.deepEqual(validateWorkerUnitInput(validWorkerUnit("not-scoped"), { unitId: "not-scoped" }), []);
});

test("validatePlanIndexInput rejects a duplicate unitId within the Units list", () => {
  const planIndex = validInput().planIndex;
  planIndex.units = [validPlanIndexUnit("999-A"), validPlanIndexUnit("999-A")];
  const errors = validatePlanIndexInput(planIndex);
  assert.ok(errors.some((e) => /duplicate/.test(e)));
});

test("validatePlanIndexInput rejects a state value outside the fixed vocabulary", () => {
  const planIndex = validInput().planIndex;
  planIndex.planState = "WAITING";
  const errors = validatePlanIndexInput(planIndex);
  assert.ok(errors.some((e) => /planState/.test(e)));
  assert.deepEqual(STATE_VOCABULARY, ["PLANNED", "ROUTED", "IN_PROGRESS", "BLOCKED", "DONE", "REPLAN_REQUIRED"]);
});

test("validateSharedContractInput rejects a missing or blank body", () => {
  assert.ok(validateSharedContractInput({}).length > 0);
  assert.ok(validateSharedContractInput({ body: "   " }).length > 0);
  assert.deepEqual(validateSharedContractInput({ body: "real content" }), []);
});

test("validatePlanIndexInput rejects a sharedContractUrl/commentUrl that is not a real comment permalink (#497 Stage 1 review finding)", () => {
  // A merely whitespace-free string (e.g. "not-a-comment-url") previously passed this
  // check; it would then fail to resolve via parse-execution-plan.mjs's own
  // extractCommentIdFromUrl once actually read back, and buildPlanArtifacts's own
  // verifyFullRoundTrip did not catch this because it replaces supplied URLs with
  // synthetic valid ones before checking (see the "buildPlanArtifacts round-trip check
  // does not mask" test below).
  const planIndexBadShared = { ...validInput().planIndex, sharedContractUrl: "not-a-comment-url" };
  const sharedErrors = validatePlanIndexInput(planIndexBadShared);
  assert.ok(
    sharedErrors.some((e) => /sharedContractUrl/.test(e) && /permalink/.test(e)),
    `expected a permalink rejection, got: ${JSON.stringify(sharedErrors)}`,
  );

  const planIndexBadUnit = {
    ...validInput().planIndex,
    units: [validPlanIndexUnit("999-A", { commentUrl: "not-a-comment-url" })],
  };
  const unitErrors = validatePlanIndexInput(planIndexBadUnit);
  assert.ok(
    unitErrors.some((e) => /commentUrl/.test(e) && /permalink/.test(e)),
    `expected a permalink rejection, got: ${JSON.stringify(unitErrors)}`,
  );

  // A real permalink shape still passes.
  assert.deepEqual(validatePlanIndexInput(validInput().planIndex), []);
});

test("validatePlanIndexInput rejects a fragment-bearing non-URL and a malformed permalink path (Stage 2 audit #506 finding)", () => {
  // Stage 2 audit #506: `isCommentPermalink` previously delegated straight to
  // `extractCommentIdFromUrl`, which only regex-matches "#issuecomment-<id>" anywhere in
  // the string — so a non-URL that merely contains the fragment (e.g.
  // "garbage#issuecomment-1") incorrectly passed. It must require a real
  // ".../issues/<N>#issuecomment-<id>" permalink.
  const notAUrlButHasFragment = "garbage#issuecomment-1";
  const sharedErrors = validatePlanIndexInput({
    ...validInput().planIndex,
    sharedContractUrl: notAUrlButHasFragment,
  });
  assert.ok(
    sharedErrors.some((e) => /sharedContractUrl/.test(e) && /permalink/.test(e)),
    `expected a permalink rejection for a fragment-bearing non-URL, got: ${JSON.stringify(sharedErrors)}`,
  );

  // A real URL missing the required "/issues/<N>" path (e.g. a "/pull/<N>" URL) must also
  // be rejected, not just a bare non-URL string.
  const pullRequestUrl = `https://github.com/${REPO}/pull/${EXECUTION_ISSUE}#issuecomment-1`;
  const unitErrors = validatePlanIndexInput({
    ...validInput().planIndex,
    units: [validPlanIndexUnit("999-A", { commentUrl: pullRequestUrl })],
  });
  assert.ok(
    unitErrors.some((e) => /commentUrl/.test(e) && /permalink/.test(e)),
    `expected a permalink rejection for a malformed (pull-request) path, got: ${JSON.stringify(unitErrors)}`,
  );

  // A well-formed host/path but with a scheme other than http(s) must also be rejected.
  const nonHttpScheme = `ftp://github.com/${REPO}/issues/${EXECUTION_ISSUE}#issuecomment-1`;
  const schemeErrors = validatePlanIndexInput({
    ...validInput().planIndex,
    sharedContractUrl: nonHttpScheme,
  });
  assert.ok(
    schemeErrors.some((e) => /sharedContractUrl/.test(e) && /permalink/.test(e)),
    `expected a permalink rejection for a non-http(s) scheme, got: ${JSON.stringify(schemeErrors)}`,
  );
});

test("validatePlanInput rejects a non-exact fragment and a cross-issue/cross-repo permalink (#507 Stage 1 review finding)", () => {
  // A shape-valid GitHub URL whose fragment carries trailing characters after the numeric
  // comment id (e.g. "#issuecomment-1junk") previously still resolved a comment id via a
  // non-anchored regex match and passed.
  const trailingJunkFragment = `https://github.com/${REPO}/issues/${EXECUTION_ISSUE}#issuecomment-1junk`;
  const junkResult = validatePlanInput(validInput({ planIndex: { ...validInput().planIndex, sharedContractUrl: trailingJunkFragment } }));
  assert.equal(junkResult.ok, false);
  assert.ok(
    junkResult.errors.some((e) => /sharedContractUrl/.test(e) && /permalink/.test(e)),
    `expected a permalink rejection for a non-exact fragment, got: ${JSON.stringify(junkResult.errors)}`,
  );

  // A real GitHub permalink for a completely different repo/issue must be rejected when
  // executionIssue/repo context is known (validatePlanInput always knows executionIssue from
  // the input itself, and repo when the caller supplies it) — not merely accepted because it
  // happens to still be a well-formed GitHub issue-comment URL.
  const crossRepoUrl = "https://github.com/attacker/other-repo/issues/123#issuecomment-1";
  const crossRepoResult = validatePlanInput(
    validInput({ planIndex: { ...validInput().planIndex, sharedContractUrl: crossRepoUrl } }),
    { repo: REPO },
  );
  assert.equal(crossRepoResult.ok, false);
  assert.ok(
    crossRepoResult.errors.some((e) => /sharedContractUrl/.test(e) && /permalink/.test(e)),
    `expected a permalink rejection for a cross-repo URL, got: ${JSON.stringify(crossRepoResult.errors)}`,
  );

  // A real GitHub permalink for the right repo but the wrong issue number must also be
  // rejected — executionIssue identity is always known (it comes from input.executionIssue
  // itself), so this check applies even when `repo` context is not supplied.
  const crossIssueUrl = `https://github.com/${REPO}/issues/${EXECUTION_ISSUE + 1}#issuecomment-1`;
  const crossIssueResult = validatePlanInput(
    validInput({ planIndex: { ...validInput().planIndex, sharedContractUrl: crossIssueUrl } }),
  );
  assert.equal(crossIssueResult.ok, false);
  assert.ok(
    crossIssueResult.errors.some((e) => /sharedContractUrl/.test(e) && /permalink/.test(e)),
    `expected a permalink rejection for a cross-issue URL, got: ${JSON.stringify(crossIssueResult.errors)}`,
  );

  // The real permalink shape, for the correct issue and repo, still passes both with and
  // without repo context supplied.
  assert.equal(validatePlanInput(validInput()).ok, true);
  assert.equal(validatePlanInput(validInput(), { repo: REPO }).ok, true);
});

// ---------------------------------------------------------------------------------------
// Formatting shape: exact headings and field order
// ---------------------------------------------------------------------------------------

test("formatSharedContractBody produces the exact required heading", () => {
  const body = formatSharedContractBody({ body: "text" }, { executionIssue: EXECUTION_ISSUE });
  assert.equal(body.split("\n")[0], "## Shared Contract (v1)");
  assert.ok(body.includes(`- **Parent execution issue:** #${EXECUTION_ISSUE}`));
});

test("formatWorkerUnitBody produces the exact required heading and 13 bullets in order", () => {
  const unit = validWorkerUnit("999-A");
  const body = formatWorkerUnitBody(unit, { executionIssue: EXECUTION_ISSUE });
  assert.equal(body.split("\n")[0], "## Worker Unit: 999-A (v1)");
  const labels = body
    .split("\n")
    .filter((l) => l.startsWith("- **"))
    .map((l) => l.match(/^- \*\*(.+?):\*\*/)[1]);
  assert.deepEqual(labels, [
    "Unit ID",
    "Parent execution issue",
    "Required bounded outcome",
    "Applicable role/capability",
    "Authority/input pointers",
    "Relevant shared-contract pointer",
    "Prerequisites/dependencies",
    "Files/surfaces expected to change",
    "Observable completion condition",
    "Verification required",
    "Durable output/state expected",
    "Interrupt/escalation conditions",
    "State",
  ]);
});

test("formatPlanIndexBody produces the exact required heading and bullet order, with indented Units entries", () => {
  const planIndex = validInput().planIndex;
  const body = formatPlanIndexBody(planIndex, { executionIssue: EXECUTION_ISSUE });
  const lines = body.split("\n");
  assert.equal(lines[0], "## Execution Plan Index (v1)");
  assert.ok(lines.includes("- **Plan state:** PLANNED"));
  assert.ok(lines.includes(`- **Parent execution issue:** #${EXECUTION_ISSUE}`));
  assert.ok(lines.includes("- **Units:**"));
  assert.ok(lines.some((l) => l.startsWith("  - 999-A:")), "unit entries must be indented under Units:");
  assert.ok(!lines.some((l) => /^-\s*999-A:/.test(l)), "unit entries must not appear as unindented top-level bullets");
  assert.ok(lines.includes("- **Dependencies:** none"));
  assert.ok(lines.includes("- **Dispatch manifest:** none"));
  assert.ok(lines.includes("- **Integration/PR route:** none"));
});

// ---------------------------------------------------------------------------------------
// publishPlanArtifacts: injectable I/O, no live network. Confirms fail-closed-before-write
// and the Shared Contract -> Worker Units -> Plan Index posting order.
// ---------------------------------------------------------------------------------------

test("publishPlanArtifacts performs no write at all when input is invalid", async () => {
  let calls = 0;
  const postImpl = async () => {
    calls++;
    return { html_url: "unused" };
  };
  const input = validInput({ workerUnits: [validWorkerUnit("999-A", { applicableRoleCapability: "not a real token" })] });
  const result = await publishPlanArtifacts(input, { repo: REPO, postImpl });
  assert.equal(result.ok, false);
  assert.equal(calls, 0, "no gh write should happen for invalid input");
});

test("publishPlanArtifacts posts Shared Contract, then Worker Units, then Plan Index referencing the resolved URLs", async () => {
  const posted = [];
  let nextId = 200;
  const postImpl = async ({ body }) => {
    const id = nextId++;
    const url = commentUrl(id);
    posted.push({ body, url });
    return { html_url: url, id };
  };
  const verifyImpl = async () => ({ ok: true, plan: {} });

  const input = validInput();
  const result = await publishPlanArtifacts(input, { repo: REPO, postImpl, verifyImpl });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(posted.length, 3);
  assert.match(posted[0].body, /^## Shared Contract \(v1\)/);
  assert.match(posted[1].body, /^## Worker Unit: 999-A \(v1\)/);
  assert.match(posted[2].body, /^## Execution Plan Index \(v1\)/);
  assert.ok(posted[2].body.includes(posted[0].url), "Plan Index must reference the freshly-posted Shared Contract URL");
  assert.ok(posted[2].body.includes(posted[1].url), "Plan Index must reference the freshly-posted Worker Unit URL");
});

test("publishPlanArtifacts surfaces a failed live round-trip verification as a non-ok, operational-error result (#507 Stage 1 review finding)", async () => {
  const postImpl = async ({ body }) => ({ html_url: commentUrl(300), body });
  const verifyImpl = async () => ({ ok: false, errors: ["synthetic failure for this test"] });
  const result = await publishPlanArtifacts(validInput(), { repo: REPO, postImpl, verifyImpl });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /live round-trip verification failed/.test(e)));
  // A post-write verification failure happens after the input was already validated, so it
  // is an operational failure the CLI must map to exit 2 — distinct from a validated-but-
  // rejected plan input (exit 1) — not the generic exit-1 rejection status.
  assert.equal(result.operationalError, true);
});

test("publishPlanArtifacts converts a thrown gh write failure into a non-ok, operational-error result instead of an uncaught exception (#507 Stage 1 review finding)", async () => {
  // A prior version left `await postImpl(...)` unguarded, so a `gh api` failure (network,
  // permission, or any other error `execFileSync` throws for) propagated straight through
  // this function and the CLI's `main()` as an uncaught exception -- a bare Node stack trace
  // on exit 1, indistinguishable from a genuine invalid-plan rejection.
  const postImpl = async () => {
    throw new Error("simulated gh api failure (e.g. network or permission error)");
  };
  const result = await publishPlanArtifacts(validInput(), { repo: REPO, postImpl });
  assert.equal(result.ok, false);
  assert.equal(result.operationalError, true);
  assert.ok(result.errors.some((e) => /GitHub write failed/.test(e) && /simulated gh api failure/.test(e)));
});

test("publishPlanArtifacts writes nothing when Shared Contract and Worker Units are valid but the Plan Index is malformed (#497 Stage 1 review finding)", async () => {
  // A prior version stripped planIndex out of publishPlanArtifacts' own pre-validation
  // call, so a structurally invalid Plan Index (here: an empty "units" array) was only
  // discovered by buildPlanArtifacts further downstream -- after the Shared Contract and
  // Worker Unit comments had already been posted for real. Confirm zero writes happen now.
  let calls = 0;
  const postImpl = async () => {
    calls++;
    return { html_url: "unused" };
  };
  const input = validInput({ planIndex: { ...validInput().planIndex, units: [] } });
  const result = await publishPlanArtifacts(input, { repo: REPO, postImpl });
  assert.equal(result.ok, false);
  assert.equal(calls, 0, "no gh write should happen when the Plan Index itself is malformed");
});

// ---------------------------------------------------------------------------------------
// CLI (#497 Stage 1 review finding: exit codes must distinguish operational errors from
// validated-but-rejected plan input)
// ---------------------------------------------------------------------------------------

test("CLI: a missing --input file fails closed with the documented operational-error exit code, not an uncaught exception", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const scriptPath = fileURLToPath(new URL("./format-execution-plan.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath, "--input", "definitely-does-not-exist.json"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2, `expected operational-error exit code 2, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /could not read --input file/);
  assert.equal(result.stdout, "");
});
