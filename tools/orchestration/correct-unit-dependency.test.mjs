// Tests for tools/orchestration/correct-unit-dependency.mjs -- issue #618's narrow,
// deterministic planning-correction writer for an undispatched Worker Unit's dependency
// topology.
//
// Run with:
//   node --test tools/orchestration/correct-unit-dependency.test.mjs
//
// All fixtures below are mocked comment arrays/stores, not live network calls -- mirrors
// parse-execution-plan.test.mjs's and prepare-dispatch-manifest.test.mjs's own conventions.

import test from "node:test";
import assert from "node:assert/strict";
import {
  SAFE_PRE_DISPATCH_STATES,
  extractStateWord,
  isSafePreDispatchState,
  buildDependencyGraph,
  detectCycle,
  validateDependencyCorrection,
  findBulletFieldSpan,
  replacePrerequisitesDependenciesField,
  extractAllWorkerUnitFields,
  verifyOnlyDependenciesFieldPreserved,
  runCorrectUnitDependency,
  parseDependsOnArg,
} from "./correct-unit-dependency.mjs";
import { parseExecutionPlan } from "./parse-execution-plan.mjs";
import { computeDispatchReady } from "./prepare-dispatch-manifest.mjs";

const REPO = "LouPineWays/Loop-Dee-Loup";
const EXECUTION_ISSUE = 441;

function commentUrl(id) {
  return `https://github.com/${REPO}/issues/${EXECUTION_ISSUE}#issuecomment-${id}`;
}

function sharedContractBody() {
  return ["## Shared Contract (v1)", "", "- **Parent execution issue:** #441", "", "Shared contract body text.", ""].join("\n");
}

function workerUnitBody(unitId, { state = "PLANNED", dependsOnField = "None.", outcome = null } = {}) {
  return [
    `## Worker Unit: ${unitId} (v1)`,
    "",
    `- **Unit ID:** ${unitId}`,
    "- **Parent execution issue:** #441",
    `- **Required bounded outcome:** ${outcome ?? `Do the ${unitId} thing.`}`,
    "- **Applicable role/capability:** bounded coding worker (see Shared Contract).",
    "- **Authority/input pointers:** the Shared Contract comment.",
    "- **Relevant shared-contract pointer:** this Issue's Shared Contract comment.",
    `- **Prerequisites/dependencies:** ${dependsOnField}`,
    `- **Files/surfaces expected to change:** \`tools/orchestration/${unitId}-example.mjs\`.`,
    "- **Observable completion condition:** the script exists and works.",
    "- **Verification required:** node --test passes.",
    "- **Durable output/state expected:** commits on the shared branch.",
    "- **Interrupt/escalation conditions:** none anticipated.",
    `- **State:** ${state}`,
  ].join("\n");
}

function planIndexBody({ unitsLines, sharedContractUrl }) {
  const lines = [
    "## Execution Plan Index (v1)",
    "",
    "- **Plan state:** ROUTED",
    "- **Parent execution issue:** #441",
    `- **Shared contract:** ${sharedContractUrl}`,
    "- **Units:**",
  ];
  for (const line of unitsLines) lines.push(`  - ${line}`);
  lines.push("- **Dependencies:** none");
  lines.push("- **Dispatch manifest:** none");
  lines.push("- **Integration/PR route:** none");
  return lines.join("\n");
}

// Builds an in-memory, mutable "GitHub comments" store for a plan shaped exactly like the
// #441 live reproduction: 441-A DONE, 441-B PLANNED depending only on 441-A, 441-C PLANNED
// with no dependencies (a newly introduced blocker the correction will wire 441-B to).
function make441Store() {
  const sharedContractId = 100;
  const aId = 101;
  const bId = 102;
  const cId = 103;
  const planIndexId = 104;

  const comments = [
    { id: sharedContractId, html_url: commentUrl(sharedContractId), body: sharedContractBody() },
    { id: aId, html_url: commentUrl(aId), body: workerUnitBody("441-A", { state: "DONE" }) },
    { id: bId, html_url: commentUrl(bId), body: workerUnitBody("441-B", { state: "PLANNED", dependsOnField: "Depends on 441-A." }) },
    { id: cId, html_url: commentUrl(cId), body: workerUnitBody("441-C", { state: "PLANNED" }) },
    {
      id: planIndexId,
      html_url: commentUrl(planIndexId),
      body: planIndexBody({
        sharedContractUrl: commentUrl(sharedContractId),
        unitsLines: [
          `441-A: DONE — first unit outcome (${commentUrl(aId)})`,
          `441-B: PLANNED — second unit outcome (${commentUrl(bId)})`,
          `441-C: PLANNED — third unit outcome (${commentUrl(cId)})`,
        ],
      }),
    },
  ];
  return { comments, ids: { sharedContractId, aId, bId, cId, planIndexId } };
}

function storeIo(store) {
  return {
    parseExecutionPlanImpl: async ({ executionIssue }) => {
      const result = parseExecutionPlan(store.comments, { executionIssue });
      if (!result.ok) return { exitCode: 2, ok: false, errors: result.errors };
      return { exitCode: 0, ok: true, repo: REPO, executionIssue, plan: result.plan };
    },
    getCommentImpl: async ({ commentId }) => {
      const found = store.comments.find((c) => Number(c.id) === Number(commentId));
      if (!found) throw new Error(`no such comment #${commentId} in store`);
      return { ...found };
    },
    patchCommentImpl: async ({ commentId, body }) => {
      const found = store.comments.find((c) => Number(c.id) === Number(commentId));
      if (!found) throw new Error(`no such comment #${commentId} in store`);
      found.body = body;
      return { ...found };
    },
  };
}

// --- extractStateWord / isSafePreDispatchState --------------------------------------------

test("extractStateWord extracts the leading state word, ignoring a trailing completion note", () => {
  assert.equal(extractStateWord("PLANNED"), "PLANNED");
  assert.equal(extractStateWord("DONE -- verified; commits abc123..def456"), "DONE");
  assert.equal(extractStateWord("  ROUTED  "), "ROUTED");
  assert.equal(extractStateWord(null), null);
  assert.equal(extractStateWord(""), null);
});

test("isSafePreDispatchState accepts exactly PLANNED and ROUTED, rejects everything else", () => {
  assert.deepEqual(SAFE_PRE_DISPATCH_STATES, ["PLANNED", "ROUTED"]);
  assert.equal(isSafePreDispatchState("PLANNED"), true);
  assert.equal(isSafePreDispatchState("ROUTED"), true);
  assert.equal(isSafePreDispatchState("IN_PROGRESS"), false);
  assert.equal(isSafePreDispatchState("BLOCKED"), false);
  assert.equal(isSafePreDispatchState("DONE -- done note"), false);
  assert.equal(isSafePreDispatchState("REPLAN_REQUIRED"), false);
  assert.equal(isSafePreDispatchState(null), false);
});

// --- buildDependencyGraph / detectCycle ----------------------------------------------------

test("buildDependencyGraph overrides only the target unit's own edges", () => {
  const plan = {
    units: {
      "441-A": { prerequisitesDependencies: "None." },
      "441-B": { prerequisitesDependencies: "Depends on 441-A." },
      "441-C": { prerequisitesDependencies: "None." },
    },
  };
  const graph = buildDependencyGraph(plan, { unitId: "441-B", dependsOn: ["441-A", "441-C"] });
  assert.deepEqual(graph["441-B"], ["441-A", "441-C"]);
  assert.deepEqual(graph["441-A"], []);
  assert.deepEqual(graph["441-C"], []);
});

test("detectCycle returns null for an acyclic graph", () => {
  assert.equal(detectCycle({ A: ["B"], B: ["C"], C: [] }), null);
});

test("detectCycle finds a two-node cycle", () => {
  const cycle = detectCycle({ A: ["B"], B: ["A"] });
  assert.ok(cycle);
  assert.equal(cycle[0], cycle[cycle.length - 1]);
  assert.ok(cycle.includes("A") && cycle.includes("B"));
});

test("detectCycle ignores edges to unknown nodes rather than crashing", () => {
  assert.equal(detectCycle({ A: ["ghost"] }), null);
});

// --- validateDependencyCorrection -----------------------------------------------------------

function planFromStore(store) {
  const result = parseExecutionPlan(store.comments, { executionIssue: EXECUTION_ISSUE });
  assert.equal(result.ok, true);
  return result.plan;
}

test("validateDependencyCorrection accepts a well-formed correction on a PLANNED unit", () => {
  const plan = planFromStore(make441Store());
  const result = validateDependencyCorrection(plan, { executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-C"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateDependencyCorrection rejects an unknown target unit", () => {
  const plan = planFromStore(make441Store());
  const result = validateDependencyCorrection(plan, { executionIssue: EXECUTION_ISSUE, unitId: "441-Z", dependsOn: [] });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /not found in the current parsed execution plan/);
});

for (const unsafeState of ["IN_PROGRESS", "BLOCKED", "DONE -- shipped", "REPLAN_REQUIRED"]) {
  test(`validateDependencyCorrection rejects a target unit in state ${unsafeState}`, () => {
    const store = make441Store();
    const bComment = store.comments.find((c) => c.body.includes("## Worker Unit: 441-B"));
    bComment.body = workerUnitBody("441-B", { state: unsafeState, dependsOnField: "Depends on 441-A." });
    const plan = planFromStore(store);
    const result = validateDependencyCorrection(plan, { executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-C"] });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("safe pre-dispatch states")));
  });
}

test("validateDependencyCorrection rejects an unknown dependency ID", () => {
  const plan = planFromStore(make441Store());
  const result = validateDependencyCorrection(plan, { executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-Z"] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('"441-Z"') && e.includes("does not match any unit")));
});

test("validateDependencyCorrection rejects self-dependency", () => {
  const plan = planFromStore(make441Store());
  const result = validateDependencyCorrection(plan, { executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-B"] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("self-dependency")));
});

test("validateDependencyCorrection rejects a malformed dependency ID", () => {
  const plan = planFromStore(make441Store());
  const result = validateDependencyCorrection(plan, { executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441 A"] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("whitespace")));
});

test("validateDependencyCorrection rejects a duplicate dependency ID", () => {
  const plan = planFromStore(make441Store());
  const result = validateDependencyCorrection(plan, { executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-A"] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("duplicate")));
});

test("validateDependencyCorrection rejects a dependency set that would introduce a cycle", () => {
  const store = make441Store();
  // Make 441-C depend on 441-B, so correcting 441-B to depend on 441-C would cycle.
  const cComment = store.comments.find((c) => c.body.includes("## Worker Unit: 441-C"));
  cComment.body = workerUnitBody("441-C", { state: "PLANNED", dependsOnField: "Depends on 441-B." });
  const plan = planFromStore(store);
  const result = validateDependencyCorrection(plan, { executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-C"] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("dependency cycle")));
});

// --- findBulletFieldSpan / replacePrerequisitesDependenciesField ---------------------------

test("replacePrerequisitesDependenciesField replaces a single-line field, preserving all else", () => {
  const before = workerUnitBody("441-B", { state: "PLANNED", dependsOnField: "Depends on 441-A." });
  const result = replacePrerequisitesDependenciesField(before, ["441-A", "441-C"]);
  assert.equal(result.ok, true);
  assert.ok(result.body.includes("- **Prerequisites/dependencies:** Depends on 441-A, 441-C."));
  const beforeLines = before.split("\n").filter((l) => !l.startsWith("- **Prerequisites/dependencies:**"));
  const afterLines = result.body.split("\n").filter((l) => !l.startsWith("- **Prerequisites/dependencies:**"));
  assert.deepEqual(afterLines, beforeLines);
});

test("replacePrerequisitesDependenciesField collapses a wrapped multi-line field into one canonical line", () => {
  const wrapped = [
    "## Worker Unit: 441-B (v1)",
    "",
    "- **Unit ID:** 441-B",
    "- **Prerequisites/dependencies:** Depends on 441-A",
    "  (wrapped continuation prose that should be entirely discarded).",
    "- **State:** PLANNED",
  ].join("\n");
  const result = replacePrerequisitesDependenciesField(wrapped, []);
  assert.equal(result.ok, true);
  assert.equal(
    result.body,
    ["## Worker Unit: 441-B (v1)", "", "- **Unit ID:** 441-B", "- **Prerequisites/dependencies:** None.", "- **State:** PLANNED"].join(
      "\n",
    ),
  );
});

test("replacePrerequisitesDependenciesField fails closed when no such bullet exists", () => {
  const result = replacePrerequisitesDependenciesField("## Worker Unit: 441-B (v1)\n\n- **State:** PLANNED", []);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no ".*Prerequisites\/dependencies.*" bullet/);
});

// --- verifyOnlyDependenciesFieldPreserved ---------------------------------------------------

test("verifyOnlyDependenciesFieldPreserved passes when only dependencies changed", () => {
  const before = extractAllWorkerUnitFields(workerUnitBody("441-B", { dependsOnField: "Depends on 441-A." }));
  const after = extractAllWorkerUnitFields(workerUnitBody("441-B", { dependsOnField: "Depends on 441-A, 441-C." }));
  const result = verifyOnlyDependenciesFieldPreserved(before, after, { unitId: "441-B" });
  assert.equal(result.ok, true);
});

test("verifyOnlyDependenciesFieldPreserved catches an unexpected change to another field", () => {
  const before = extractAllWorkerUnitFields(workerUnitBody("441-B", { dependsOnField: "Depends on 441-A." }));
  const after = extractAllWorkerUnitFields(
    workerUnitBody("441-B", { dependsOnField: "Depends on 441-A, 441-C.", outcome: "Do something completely different." }),
  );
  const result = verifyOnlyDependenciesFieldPreserved(before, after, { unitId: "441-B" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("Required bounded outcome")));
});

test("verifyOnlyDependenciesFieldPreserved catches a heading unit-ID mismatch", () => {
  const before = extractAllWorkerUnitFields(workerUnitBody("441-B"));
  const after = extractAllWorkerUnitFields(workerUnitBody("441-Q"));
  const result = verifyOnlyDependenciesFieldPreserved(before, after, { unitId: "441-B" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("heading")));
});

// --- parseDependsOnArg -----------------------------------------------------------------------

test("parseDependsOnArg: absent flag is null (error), empty string is [] (explicit none)", () => {
  assert.equal(parseDependsOnArg(undefined), null);
  assert.deepEqual(parseDependsOnArg(""), []);
  assert.deepEqual(parseDependsOnArg("441-A,441-C"), ["441-A", "441-C"]);
  assert.deepEqual(parseDependsOnArg(" 441-A , 441-C ,"), ["441-A", "441-C"]);
});

// --- runCorrectUnitDependency: the exact #441 regression (Required check 1) ----------------

test("runCorrectUnitDependency: #441 regression -- correcting 441-B to depend on 441-A+441-C is durable and manifest-safe", async () => {
  const store = make441Store();
  const io = storeIo(store);

  // Before correction: 441-B is ready (only depends on DONE 441-A).
  const preCorrectionPlan = planFromStore(store);
  const preReadiness = computeDispatchReady(preCorrectionPlan.units["441-B"], preCorrectionPlan.units);
  assert.equal(preReadiness.ready, true);

  const result = await runCorrectUnitDependency(
    { repo: REPO, executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-C"] },
    { ...io },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, true);
  assert.equal(result.state, "DEPENDENCY_CORRECTION_VERIFIED");
  assert.deepEqual(result.dependsOn, ["441-A", "441-C"]);

  // A normal subsequent parse + computeDispatchReady (exactly what prepare-dispatch-manifest.mjs
  // itself calls) now shows 441-B NOT ready, 441-C ready, without any manual manifest override.
  const afterCorrectionPlan = planFromStore(store);
  const bReadiness = computeDispatchReady(afterCorrectionPlan.units["441-B"], afterCorrectionPlan.units);
  assert.equal(bReadiness.ready, false);
  assert.deepEqual(bReadiness.notDone, ["441-C"]);
  const cReadiness = computeDispatchReady(afterCorrectionPlan.units["441-C"], afterCorrectionPlan.units);
  assert.equal(cReadiness.ready, true);

  // Re-running manifest preparation repeatedly cannot restore dispatch_ready=true (Required
  // check 2) -- re-parsing/re-computing again and again against unchanged durable state yields
  // the identical not-ready result every time.
  for (let i = 0; i < 3; i++) {
    const rePlan = planFromStore(store);
    const reReadiness = computeDispatchReady(rePlan.units["441-B"], rePlan.units);
    assert.equal(reReadiness.ready, false);
  }

  // All non-dependency fields on 441-B are preserved exactly (Required check 3).
  const bComment = store.comments.find((c) => Number(c.id) === result.commentId);
  const beforeFields = extractAllWorkerUnitFields(workerUnitBody("441-B", { state: "PLANNED", dependsOnField: "Depends on 441-A." }));
  const afterFields = extractAllWorkerUnitFields(bComment.body);
  const preservation = verifyOnlyDependenciesFieldPreserved(beforeFields, afterFields, { unitId: "441-B" });
  assert.equal(preservation.ok, true);

  // Once 441-C becomes DONE, ordinary manifest preparation makes 441-B ready.
  const cComment = store.comments.find((c) => c.body.includes("## Worker Unit: 441-C"));
  cComment.body = workerUnitBody("441-C", { state: "DONE -- shipped" });
  const finalPlan = planFromStore(store);
  const finalReadiness = computeDispatchReady(finalPlan.units["441-B"], finalPlan.units);
  assert.equal(finalReadiness.ready, true);
});

test("runCorrectUnitDependency: correcting to an empty dependsOn set is a valid 'no dependencies' correction", async () => {
  const store = make441Store();
  const io = storeIo(store);
  const result = await runCorrectUnitDependency({ repo: REPO, executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: [] }, { ...io });
  assert.equal(result.exitCode, 0);
  const plan = planFromStore(store);
  assert.equal(plan.units["441-B"].prerequisitesDependencies, "None.");
  const readiness = computeDispatchReady(plan.units["441-B"], plan.units);
  assert.equal(readiness.ready, true);
});

// --- runCorrectUnitDependency: fail-closed input rejection (Required checks 4 and 5) -------

test("runCorrectUnitDependency rejects (exit 1, no write) a target unit outside the safe pre-dispatch state set", async () => {
  const store = make441Store();
  const bComment = store.comments.find((c) => c.body.includes("## Worker Unit: 441-B"));
  const originalBody = bComment.body;
  const io = storeIo(store);
  const result = await runCorrectUnitDependency(
    { repo: REPO, executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-C"] },
    { ...io, parseExecutionPlanImpl: async (args) => {
        // Force 441-B to look IN_PROGRESS for this call only.
        const mutatedStore = { comments: store.comments.map((c) => (c === bComment ? { ...c, body: workerUnitBody("441-B", { state: "IN_PROGRESS", dependsOnField: "Depends on 441-A." }) } : c)) };
        const parsed = parseExecutionPlan(mutatedStore.comments, { executionIssue: args.executionIssue });
        return { exitCode: 0, ok: true, repo: REPO, executionIssue: args.executionIssue, plan: parsed.plan };
      } },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("safe pre-dispatch states")));
  assert.equal(bComment.body, originalBody, "nothing should have been written");
});

test("runCorrectUnitDependency rejects (exit 1, no write) an unknown dependency ID", async () => {
  const store = make441Store();
  const bComment = store.comments.find((c) => c.body.includes("## Worker Unit: 441-B"));
  const originalBody = bComment.body;
  const io = storeIo(store);
  const result = await runCorrectUnitDependency(
    { repo: REPO, executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-Z"] },
    { ...io },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(bComment.body, originalBody);
});

test("runCorrectUnitDependency rejects (exit 1, no write) a self-dependency", async () => {
  const store = make441Store();
  const io = storeIo(store);
  const result = await runCorrectUnitDependency(
    { repo: REPO, executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-B"] },
    { ...io },
  );
  assert.equal(result.exitCode, 1);
});

test("runCorrectUnitDependency rejects (exit 1, no write) a cyclic correction", async () => {
  const store = make441Store();
  const cComment = store.comments.find((c) => c.body.includes("## Worker Unit: 441-C"));
  cComment.body = workerUnitBody("441-C", { state: "PLANNED", dependsOnField: "Depends on 441-B." });
  const io = storeIo(store);
  const result = await runCorrectUnitDependency(
    { repo: REPO, executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-C"] },
    { ...io },
  );
  assert.equal(result.exitCode, 1);
  assert.ok(result.errors.some((e) => e.includes("cycle")));
});

// --- runCorrectUnitDependency: stale/concurrent-change TOCTOU (Required check 6) -----------

test("runCorrectUnitDependency fails closed (exit 3) when the target unit is dispatched between initial validation and the mutation", async () => {
  const store = make441Store();
  const io = storeIo(store);
  let callCount = 0;
  const wrappedParse = async (args) => {
    callCount += 1;
    if (callCount === 2) {
      // Simulate a concurrent dispatch: 441-B flips to IN_PROGRESS right before the commit
      // checkpoint's own re-read.
      const bComment = store.comments.find((c) => c.body.includes("## Worker Unit: 441-B"));
      bComment.body = workerUnitBody("441-B", { state: "IN_PROGRESS", dependsOnField: "Depends on 441-A." });
    }
    return io.parseExecutionPlanImpl(args);
  };
  const result = await runCorrectUnitDependency(
    { repo: REPO, executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-C"] },
    { ...io, parseExecutionPlanImpl: wrappedParse },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "STALE_START_TOCTOU");
});

test("runCorrectUnitDependency fails closed (exit 3) when the plan's dependency topology changes concurrently", async () => {
  const store = make441Store();
  const io = storeIo(store);
  let callCount = 0;
  const wrappedParse = async (args) => {
    callCount += 1;
    if (callCount === 2) {
      // Another planning correction lands concurrently, introducing a cycle the second check
      // must catch even though the first check passed.
      const cComment = store.comments.find((c) => c.body.includes("## Worker Unit: 441-C"));
      cComment.body = workerUnitBody("441-C", { state: "PLANNED", dependsOnField: "Depends on 441-B." });
    }
    return io.parseExecutionPlanImpl(args);
  };
  const result = await runCorrectUnitDependency(
    { repo: REPO, executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-C"] },
    { ...io, parseExecutionPlanImpl: wrappedParse },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "STALE_START_TOCTOU");
});

// --- runCorrectUnitDependency: operational failures ------------------------------------------

test("runCorrectUnitDependency reports exit 2 when the execution plan cannot be parsed", async () => {
  const result = await runCorrectUnitDependency(
    { repo: REPO, executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: [] },
    { parseExecutionPlanImpl: async () => ({ exitCode: 2, ok: false, errors: ["no Plan Index comment found"] }) },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.ok, false);
});

test("runCorrectUnitDependency reports exit 1 (operational) when repository identity cannot be resolved and no repo is given", async () => {
  const result = await runCorrectUnitDependency(
    { executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: [] },
    { resolveRepoIdentityImpl: () => ({ ok: false, reason: "no origin remote" }) },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.operationalError, true);
});

test("runCorrectUnitDependency reports exit 4 when the read-back body does not match what was written", async () => {
  const store = make441Store();
  const io = storeIo(store);
  const result = await runCorrectUnitDependency(
    { repo: REPO, executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-C"] },
    {
      ...io,
      patchCommentImpl: async (args) => {
        await io.patchCommentImpl(args);
        return { ok: true };
      },
      getCommentImpl: (() => {
        let calls = 0;
        return async (args) => {
          calls += 1;
          const real = await io.getCommentImpl(args);
          // Corrupt only the read-back after the write (4th getCommentImpl call: initial
          // validation doesn't call getCommentImpl at all; pre-write fetch is call 1; the
          // pre-commit staleness re-check (Stage 1 finding on PR #620) is call 2 and must stay
          // clean so this test still reaches the PATCH; the post-write read-back is call 3).
          if (calls >= 3) return { ...real, body: `${real.body}\ncorrupted` };
          return real;
        };
      })(),
    },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "CORRECTION_UNVERIFIED");
});

// Stage 1 review finding on PR #620 (P1): a unit worker's own concurrent State/completion edit
// landing between the pre-write fetch and the PATCH must fail closed rather than being silently
// overwritten by the stale `rawBody`-derived replacement.
test("runCorrectUnitDependency fails closed (exit 3, no write) when the target comment's own body changes concurrently between the pre-write fetch and the commit", async () => {
  const store = make441Store();
  const io = storeIo(store);
  const bComment = store.comments.find((c) => c.body.includes("## Worker Unit: 441-B"));
  let calls = 0;
  const wrappedGetComment = async (args) => {
    calls += 1;
    // Call 1 is the pre-write fetch this correction computes its replacement from. Simulate the
    // unit's own dispatched worker landing a State edit immediately after that, before this
    // script's own pre-commit re-check (call 2).
    if (calls === 1) {
      const real = await io.getCommentImpl(args);
      bComment.body = workerUnitBody("441-B", { state: "IN_PROGRESS", dependsOnField: "Depends on 441-A." });
      return real;
    }
    return io.getCommentImpl(args);
  };
  const result = await runCorrectUnitDependency(
    { repo: REPO, executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-C"] },
    { ...io, getCommentImpl: wrappedGetComment },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(result.state, "STALE_START_TOCTOU");
  // The worker's own concurrent edit must survive untouched -- this is the exact overwrite the
  // finding described (a stale "replaced.body" clobbering it, e.g. reverting DONE to PLANNED).
  assert.match(bComment.body, /State:\*\* IN_PROGRESS/);
});

// --- runCorrectUnitDependency: existing Dispatch Manifest regeneration (Stage 1 P1 finding) --

function withExistingManifest(store, { manifestCommentId = 105 } = {}) {
  const planIndexComment = store.comments.find((c) => c.body.includes("## Execution Plan Index"));
  const updated = planIndexComment.body.replace("- **Dispatch manifest:** none", `- **Dispatch manifest:** ${commentUrl(manifestCommentId)}`);
  assert.notEqual(updated, planIndexComment.body, "test fixture bug: no '- **Dispatch manifest:** none' bullet found to replace");
  planIndexComment.body = updated;
  return manifestCommentId;
}

test("runCorrectUnitDependency regenerates an already-persisted Dispatch Manifest so a stale dispatch_ready=true entry cannot outlive the correction", async () => {
  const store = make441Store();
  const manifestCommentId = withExistingManifest(store);
  const io = storeIo(store);
  const regenerationCalls = [];
  const result = await runCorrectUnitDependency(
    { repo: REPO, executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-C"] },
    {
      ...io,
      prepareDispatchManifestImpl: async (args) => {
        regenerationCalls.push(args);
        return { exitCode: 0, ok: true, state: "DISPATCH_MANIFEST_VERIFIED" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, true);
  assert.equal(result.manifestRegenerated, true);
  assert.equal(regenerationCalls.length, 1);
  assert.deepEqual(regenerationCalls[0], { repo: REPO, executionIssue: EXECUTION_ISSUE, commentId: manifestCommentId });
});

test("runCorrectUnitDependency does not attempt manifest regeneration when no Dispatch Manifest is persisted yet", async () => {
  const store = make441Store();
  const io = storeIo(store);
  const result = await runCorrectUnitDependency(
    { repo: REPO, executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-C"] },
    {
      ...io,
      prepareDispatchManifestImpl: async () => {
        throw new Error('must not be called when the Plan Index\'s own "Dispatch manifest" field is still "none"');
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.manifestRegenerated, false);
});

test("runCorrectUnitDependency reports exit 4 (CORRECTION_UNVERIFIED) when an existing Dispatch Manifest cannot be regenerated after the dependency field write already succeeded", async () => {
  const store = make441Store();
  const manifestCommentId = withExistingManifest(store);
  const io = storeIo(store);
  const result = await runCorrectUnitDependency(
    { repo: REPO, executionIssue: EXECUTION_ISSUE, unitId: "441-B", dependsOn: ["441-A", "441-C"] },
    {
      ...io,
      prepareDispatchManifestImpl: async () => ({ exitCode: 1, ok: false, message: "simulated regeneration failure" }),
    },
  );
  assert.equal(result.exitCode, 4);
  assert.equal(result.state, "CORRECTION_UNVERIFIED");
  // The dependency field itself was already durably written even though the overall result is
  // reported unverified -- the caller must re-run prepare-dispatch-manifest.mjs manually.
  const bComment = store.comments.find((c) => c.body.includes("## Worker Unit: 441-B"));
  assert.match(bComment.body, /Depends on 441-A, 441-C\./);
  assert.match(result.errors[0], new RegExp(`#${manifestCommentId}`));
});
