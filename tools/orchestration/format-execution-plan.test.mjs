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
import { CAPABILITY_CLASS_ROUTE_TABLE, resolveUnitRoute, extractCapabilityClassLabel } from "./prepare-dispatch-manifest.mjs";

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
    prerequisitesDependencies: "none.",
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

test("publishPlanArtifacts surfaces a failed live round-trip verification as a non-ok result", async () => {
  const postImpl = async ({ body }) => ({ html_url: commentUrl(300), body });
  const verifyImpl = async () => ({ ok: false, errors: ["synthetic failure for this test"] });
  const result = await publishPlanArtifacts(validInput(), { repo: REPO, postImpl, verifyImpl });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /live round-trip verification failed/.test(e)));
});
