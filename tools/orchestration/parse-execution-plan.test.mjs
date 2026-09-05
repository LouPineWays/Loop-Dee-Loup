// Tests for tools/orchestration/parse-execution-plan.mjs — worker unit 294-B's deterministic
// parser for a #294-shaped multi-unit execution plan (Plan Index / Shared Contract / Worker
// Unit Contract comments).
//
// Run with:
//   node --test tools/orchestration/parse-execution-plan.test.mjs
//
// All fixtures below are mocked comment arrays, not live network calls — the one-time
// live spot-check against the real issue #294 (this worker unit's observable completion
// condition) is a manual verification step, not part of this automated suite, since it
// would otherwise depend on live GitHub state that can drift.

import test from "node:test";
import assert from "node:assert/strict";
import {
  findHeadingComments,
  pickLatestComment,
  parseBulletBlock,
  parseUnitsBlock,
  parseUnitListItem,
  extractCommentIdFromUrl,
  findCommentById,
  parseExecutionPlan,
  runParseExecutionPlan,
  WORKER_UNIT_FIELDS,
} from "./parse-execution-plan.mjs";

const REPO = "LouPineWays/Loop-Dee-Loup";
const EXECUTION_ISSUE = 999;

function commentUrl(id) {
  return `https://github.com/${REPO}/issues/${EXECUTION_ISSUE}#issuecomment-${id}`;
}

function sharedContractBody() {
  return [
    "## Shared Contract (v1)",
    "",
    "**Parent execution issue:** #999",
    "",
    "Durable shared contract body text.",
    "",
  ].join("\n");
}

function workerUnitBody(unitId, { state = "PLANNED", heading = null } = {}) {
  const headingLine = heading === null ? `## Worker Unit: ${unitId} (v1)` : heading;
  return [
    headingLine,
    "",
    `- **Unit ID:** ${unitId}`,
    "- **Parent execution issue:** #999",
    "- **Required bounded outcome:** Do the bounded thing, wrapped across",
    "  two lines of prose for realism.",
    "- **Applicable role/capability:** bounded coding worker.",
    "- **Authority/input pointers:** the Shared Contract comment.",
    "- **Relevant shared-contract pointer:** this Issue's Shared Contract comment.",
    "- **Prerequisites/dependencies:** none.",
    "- **Files/surfaces expected to change:** tools/orchestration/example.mjs.",
    "- **Observable completion condition:** the script exists and works.",
    "- **Verification required:** node --test passes.",
    "- **Durable output/state expected:** commits on the shared branch.",
    "- **Interrupt/escalation conditions:** none anticipated.",
    `- **State:** ${state}`,
  ].join("\n");
}

function planIndexBody({ unitsLines, sharedContractLine = true } = {}) {
  const lines = [
    "## Execution Plan Index (v1)",
    "",
    "- **Plan state:** ROUTED",
    "- **Parent execution issue:** #999",
  ];
  if (sharedContractLine !== false) {
    lines.push(`- **Shared contract:** ${sharedContractLine}`);
  }
  lines.push("- **Units:**");
  for (const line of unitsLines) {
    lines.push(`  - ${line}`);
  }
  lines.push("- **Dependencies:** none");
  lines.push("- **Dispatch manifest:** none");
  lines.push("- **Integration/PR route:** none");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// Fixture 1: a normal, complete plan — Plan Index, Shared Contract, and two Worker Unit
// comments all present and well-formed, one of which is DONE and one PLANNED.
// ---------------------------------------------------------------------------------------

function normalCompletePlanComments() {
  const sharedContractId = 100;
  const unitAId = 101;
  const unitBId = 102;
  const planIndexId = 103;

  const planIndex = {
    id: planIndexId,
    html_url: commentUrl(planIndexId),
    body: planIndexBody({
      sharedContractLine: commentUrl(sharedContractId),
      unitsLines: [
        `294-A: DONE — first unit outcome (${commentUrl(unitAId)})`,
        `294-B: PLANNED — second unit outcome (${commentUrl(unitBId)})`,
      ],
    }),
  };
  const sharedContract = { id: sharedContractId, html_url: commentUrl(sharedContractId), body: sharedContractBody() };
  const unitA = { id: unitAId, html_url: commentUrl(unitAId), body: workerUnitBody("294-A", { state: "DONE" }) };
  const unitB = { id: unitBId, html_url: commentUrl(unitBId), body: workerUnitBody("294-B", { state: "PLANNED" }) };

  return [sharedContract, unitA, unitB, planIndex];
}

test("parseExecutionPlan: a normal complete plan resolves Plan Index, Shared Contract, and every unit", () => {
  const result = parseExecutionPlan(normalCompletePlanComments(), { executionIssue: EXECUTION_ISSUE });
  assert.equal(result.ok, true);
  assert.equal(result.plan.planIndex.planState, "ROUTED");
  assert.ok(result.plan.sharedContract);
  assert.equal(Object.keys(result.plan.units).length, 2);
  assert.equal(result.plan.units["294-A"].state, "DONE");
  assert.equal(result.plan.units["294-A"].indexState, "DONE");
  assert.equal(result.plan.units["294-B"].state, "PLANNED");
  // Wrapped continuation lines are collapsed into one collected value.
  assert.equal(
    result.plan.units["294-A"].requiredBoundedOutcome,
    "Do the bounded thing, wrapped across two lines of prose for realism.",
  );
});

test("runParseExecutionPlan: a normal complete plan reports exit 0 and ok: true end to end", async () => {
  const comments = normalCompletePlanComments();
  const result = await runParseExecutionPlan(
    { repo: REPO, executionIssue: EXECUTION_ISSUE },
    { ghCommentsImpl: async ({ repo, number }) => {
        assert.equal(repo, REPO);
        assert.equal(number, EXECUTION_ISSUE);
        return comments;
      } },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, true);
  assert.equal(Object.keys(result.plan.units).length, 2);
});

// ---------------------------------------------------------------------------------------
// Fixture 2: missing shared-contract reference — the Plan Index has no
// "- **Shared contract:**" bullet at all.
// ---------------------------------------------------------------------------------------

test("parseExecutionPlan: a Plan Index with no Shared Contract reference fails explicitly, not silently", () => {
  const planIndexId = 200;
  const unitAId = 201;
  const planIndex = {
    id: planIndexId,
    html_url: commentUrl(planIndexId),
    body: planIndexBody({
      sharedContractLine: false,
      unitsLines: [`294-A: PLANNED — an outcome (${commentUrl(unitAId)})`],
    }),
  };
  const unitA = { id: unitAId, html_url: commentUrl(unitAId), body: workerUnitBody("294-A") };

  const result = parseExecutionPlan([planIndex, unitA], { executionIssue: EXECUTION_ISSUE });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("Shared contract")));
});

// ---------------------------------------------------------------------------------------
// Fixture 3: malformed unit heading — the comment the Plan Index points at for a unit does
// not carry a valid "## Worker Unit: <ID> (v1)" heading.
// ---------------------------------------------------------------------------------------

test("parseExecutionPlan: a referenced unit comment with a malformed heading fails explicitly", () => {
  const sharedContractId = 300;
  const unitCId = 301;
  const planIndexId = 302;

  const planIndex = {
    id: planIndexId,
    html_url: commentUrl(planIndexId),
    body: planIndexBody({
      sharedContractLine: commentUrl(sharedContractId),
      unitsLines: [`294-C: PLANNED — a third outcome (${commentUrl(unitCId)})`],
    }),
  };
  const sharedContract = { id: sharedContractId, html_url: commentUrl(sharedContractId), body: sharedContractBody() };
  // Missing "(v1)" and using "Unit 294-C" instead of "Worker Unit: 294-C" — malformed.
  const unitC = {
    id: unitCId,
    html_url: commentUrl(unitCId),
    body: workerUnitBody("294-C", { heading: "## Unit 294-C" }),
  };

  const result = parseExecutionPlan([planIndex, sharedContract, unitC], { executionIssue: EXECUTION_ISSUE });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("294-C") && e.includes("heading")));
});

test("parseExecutionPlan: a referenced unit comment whose heading names a different unit ID than the Plan Index fails explicitly", () => {
  const sharedContractId = 310;
  const unitId = 311;
  const planIndexId = 312;

  const planIndex = {
    id: planIndexId,
    html_url: commentUrl(planIndexId),
    body: planIndexBody({
      sharedContractLine: commentUrl(sharedContractId),
      unitsLines: [`294-D: PLANNED — outcome (${commentUrl(unitId)})`],
    }),
  };
  const sharedContract = { id: sharedContractId, html_url: commentUrl(sharedContractId), body: sharedContractBody() };
  // Heading says 294-Z, but the Plan Index Units list calls it 294-D.
  const mismatchedUnit = { id: unitId, html_url: commentUrl(unitId), body: workerUnitBody("294-Z") };

  const result = parseExecutionPlan([planIndex, sharedContract, mismatchedUnit], { executionIssue: EXECUTION_ISSUE });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("294-D") && e.includes("294-Z")));
});

// ---------------------------------------------------------------------------------------
// Fixture 4: a unit in BLOCKED state — this is a *valid* plan; the parser must faithfully
// report the BLOCKED state, not treat it as an error.
// ---------------------------------------------------------------------------------------

test("parseExecutionPlan: a unit in BLOCKED state parses successfully and reports that state faithfully", () => {
  const sharedContractId = 400;
  const unitEId = 401;
  const planIndexId = 402;

  const planIndex = {
    id: planIndexId,
    html_url: commentUrl(planIndexId),
    body: planIndexBody({
      sharedContractLine: commentUrl(sharedContractId),
      unitsLines: [`294-E: BLOCKED — an integration outcome (${commentUrl(unitEId)})`],
    }),
  };
  const sharedContract = { id: sharedContractId, html_url: commentUrl(sharedContractId), body: sharedContractBody() };
  const unitE = { id: unitEId, html_url: commentUrl(unitEId), body: workerUnitBody("294-E", { state: "BLOCKED" }) };

  const result = parseExecutionPlan([planIndex, sharedContract, unitE], { executionIssue: EXECUTION_ISSUE });
  assert.equal(result.ok, true);
  assert.equal(result.plan.units["294-E"].state, "BLOCKED");
  assert.equal(result.plan.units["294-E"].indexState, "BLOCKED");
});

// ---------------------------------------------------------------------------------------
// Fixture 5: a unit listed in the index whose comment cannot be found at all.
// ---------------------------------------------------------------------------------------

test("parseExecutionPlan: a unit referenced by the Plan Index whose comment does not exist fails explicitly, never silently skipped", () => {
  const sharedContractId = 500;
  const planIndexId = 501;
  const missingUnitUrl = commentUrl(999999); // no comment with this id exists in the fixture

  const planIndex = {
    id: planIndexId,
    html_url: commentUrl(planIndexId),
    body: planIndexBody({
      sharedContractLine: commentUrl(sharedContractId),
      unitsLines: [`294-F: PLANNED — a missing-comment outcome (${missingUnitUrl})`],
    }),
  };
  const sharedContract = { id: sharedContractId, html_url: commentUrl(sharedContractId), body: sharedContractBody() };

  const result = parseExecutionPlan([planIndex, sharedContract], { executionIssue: EXECUTION_ISSUE });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("294-F") && e.includes("could not be found")));
});

// ---------------------------------------------------------------------------------------
// Fixture 6: a Worker Unit Contract comment missing one or several required bullets — this
// must fail explicitly (ok: false) rather than silently producing a unit with null fields
// that later code (e.g. prepare-dispatch-manifest.mjs) could treat as "ready".
// ---------------------------------------------------------------------------------------

function workerUnitBodyMissingLabels(unitId, labelsToOmit, { state = "PLANNED" } = {}) {
  const full = workerUnitBody(unitId, { state });
  return full
    .split("\n")
    .filter((line) => !labelsToOmit.some((label) => line.startsWith(`- **${label}:**`)))
    .join("\n");
}

test("parseExecutionPlan: a Worker Unit Contract comment missing one required bullet fails explicitly, naming the unit and field", () => {
  const sharedContractId = 600;
  const unitGId = 601;
  const planIndexId = 602;

  const planIndex = {
    id: planIndexId,
    html_url: commentUrl(planIndexId),
    body: planIndexBody({
      sharedContractLine: commentUrl(sharedContractId),
      unitsLines: [`294-G: PLANNED — an outcome (${commentUrl(unitGId)})`],
    }),
  };
  const sharedContract = { id: sharedContractId, html_url: commentUrl(sharedContractId), body: sharedContractBody() };
  const unitG = {
    id: unitGId,
    html_url: commentUrl(unitGId),
    body: workerUnitBodyMissingLabels("294-G", ["Verification required"]),
  };

  const result = parseExecutionPlan([planIndex, sharedContract, unitG], { executionIssue: EXECUTION_ISSUE });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("294-G") && e.includes("Verification required")));
});

test("parseExecutionPlan: a Worker Unit Contract comment missing several required bullets names all of them in one error", () => {
  const sharedContractId = 610;
  const unitHId = 611;
  const planIndexId = 612;

  const planIndex = {
    id: planIndexId,
    html_url: commentUrl(planIndexId),
    body: planIndexBody({
      sharedContractLine: commentUrl(sharedContractId),
      unitsLines: [`294-H: PLANNED — an outcome (${commentUrl(unitHId)})`],
    }),
  };
  const sharedContract = { id: sharedContractId, html_url: commentUrl(sharedContractId), body: sharedContractBody() };
  const unitH = {
    id: unitHId,
    html_url: commentUrl(unitHId),
    body: workerUnitBodyMissingLabels("294-H", ["Observable completion condition", "Verification required", "Prerequisites/dependencies"]),
  };

  const result = parseExecutionPlan([planIndex, sharedContract, unitH], { executionIssue: EXECUTION_ISSUE });
  assert.equal(result.ok, false);
  const missingFieldsError = result.errors.find((e) => e.includes("294-H"));
  assert.ok(missingFieldsError);
  assert.match(missingFieldsError, /Observable completion condition/);
  assert.match(missingFieldsError, /Verification required/);
  assert.match(missingFieldsError, /Prerequisites\/dependencies/);
});

test("parseExecutionPlan: existing fully-populated fixtures still pass unchanged (no regression)", () => {
  const result = parseExecutionPlan(normalCompletePlanComments(), { executionIssue: EXECUTION_ISSUE });
  assert.equal(result.ok, true);
  assert.equal(Object.keys(result.plan.units).length, 2);
});

// ---------------------------------------------------------------------------------------
// Fixture 7 (Finding 4): a "Shared contract:"/Units-list URL field whose text has the
// correct #issuecomment-<id> suffix but a mistyped owner/repo/issue path. The comment still
// resolves correctly by ID, but the stored `.url` must be that comment's own canonical
// `html_url`, never the mistyped field text.
// ---------------------------------------------------------------------------------------

test("parseExecutionPlan: sharedContract.url uses the resolved comment's own html_url, not a mistyped Shared-contract field URL", () => {
  const sharedContractId = 700;
  const unitIId = 701;
  const planIndexId = 702;
  const mistypedSharedContractUrl = `https://github.com/WRONG-OWNER/wrong-repo/issues/9999#issuecomment-${sharedContractId}`;

  const planIndex = {
    id: planIndexId,
    html_url: commentUrl(planIndexId),
    body: planIndexBody({
      sharedContractLine: mistypedSharedContractUrl,
      unitsLines: [`294-I: PLANNED — an outcome (${commentUrl(unitIId)})`],
    }),
  };
  const sharedContract = { id: sharedContractId, html_url: commentUrl(sharedContractId), body: sharedContractBody() };
  const unitI = { id: unitIId, html_url: commentUrl(unitIId), body: workerUnitBody("294-I") };

  const result = parseExecutionPlan([planIndex, sharedContract, unitI], { executionIssue: EXECUTION_ISSUE });
  assert.equal(result.ok, true);
  assert.equal(result.plan.sharedContract.url, commentUrl(sharedContractId));
  assert.notEqual(result.plan.sharedContract.url, mistypedSharedContractUrl);
});

test("parseExecutionPlan: units[id].url uses the resolved unit comment's own html_url, not a mistyped Units-list entry URL", () => {
  const sharedContractId = 710;
  const unitJId = 711;
  const planIndexId = 712;
  const mistypedUnitUrl = `https://github.com/WRONG-OWNER/wrong-repo/issues/9999#issuecomment-${unitJId}`;

  const planIndex = {
    id: planIndexId,
    html_url: commentUrl(planIndexId),
    body: planIndexBody({
      sharedContractLine: commentUrl(sharedContractId),
      unitsLines: [`294-J: PLANNED — an outcome (${mistypedUnitUrl})`],
    }),
  };
  const sharedContract = { id: sharedContractId, html_url: commentUrl(sharedContractId), body: sharedContractBody() };
  const unitJ = { id: unitJId, html_url: commentUrl(unitJId), body: workerUnitBody("294-J") };

  const result = parseExecutionPlan([planIndex, sharedContract, unitJ], { executionIssue: EXECUTION_ISSUE });
  assert.equal(result.ok, true);
  assert.equal(result.plan.units["294-J"].url, commentUrl(unitJId));
  assert.notEqual(result.plan.units["294-J"].url, mistypedUnitUrl);
});

test("parseExecutionPlan: when a resolved comment's html_url matches the field text exactly, behavior is unchanged", () => {
  const result = parseExecutionPlan(normalCompletePlanComments(), { executionIssue: EXECUTION_ISSUE });
  assert.equal(result.ok, true);
  assert.equal(result.plan.sharedContract.url, commentUrl(100));
  assert.equal(result.plan.units["294-A"].url, commentUrl(101));
});

// ---------------------------------------------------------------------------------------
// Additional coverage: no Plan Index comment at all, and end-to-end error-path plumbing.
// ---------------------------------------------------------------------------------------

test("parseExecutionPlan: no Plan Index comment at all fails explicitly rather than returning an empty plan", () => {
  const result = parseExecutionPlan([{ id: 1, html_url: commentUrl(1), body: sharedContractBody() }], {
    executionIssue: EXECUTION_ISSUE,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("Execution Plan Index")));
});

test("runParseExecutionPlan: a malformed plan reports exit 2 and ok: false with the full errors array", async () => {
  const result = await runParseExecutionPlan(
    { repo: REPO, executionIssue: EXECUTION_ISSUE },
    { ghCommentsImpl: async () => [] },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.length > 0);
});

test("runParseExecutionPlan: missing --execution-issue fails closed with exit 1", async () => {
  const result = await runParseExecutionPlan({ repo: REPO, executionIssue: undefined });
  assert.equal(result.exitCode, 1);
});

test("runParseExecutionPlan: a gh api failure fails closed with exit 1, not a false empty plan", async () => {
  const result = await runParseExecutionPlan(
    { repo: REPO, executionIssue: EXECUTION_ISSUE },
    {
      ghCommentsImpl: async () => {
        throw new Error("could not resolve to an Issue");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.ok(result.message.includes(String(EXECUTION_ISSUE)));
});

test("runParseExecutionPlan: repository identity is resolved via resolveRepoIdentityImpl when --repo is not supplied", async () => {
  let sawRepo = null;
  const comments = normalCompletePlanComments();
  const result = await runParseExecutionPlan(
    { executionIssue: EXECUTION_ISSUE },
    {
      resolveRepoIdentityImpl: () => ({ ok: true, repo: REPO }),
      ghCommentsImpl: async ({ repo }) => {
        sawRepo = repo;
        return comments;
      },
    },
  );
  assert.equal(sawRepo, REPO);
  assert.equal(result.ok, true);
  assert.equal(result.repo, REPO);
});

test("runParseExecutionPlan: a repository-identity resolution failure is a distinct exit 1, and never calls gh", async () => {
  let ghCalls = 0;
  const result = await runParseExecutionPlan(
    { executionIssue: EXECUTION_ISSUE },
    {
      resolveRepoIdentityImpl: () => ({ ok: false, reason: "no configured origin remote" }),
      ghCommentsImpl: async () => {
        ghCalls++;
        return [];
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(ghCalls, 0);
  assert.ok(result.message.includes("repository identity"));
});

// ---------------------------------------------------------------------------------------
// Unit-level parser tests for the smaller pure helpers.
// ---------------------------------------------------------------------------------------

test("findHeadingComments: matches only an exact heading line, not a mere mention in prose", () => {
  const heading = /^## Shared Contract \(v1\)$/;
  const matches = findHeadingComments(
    [
      { id: 1, body: "See the ## Shared Contract (v1) comment above for details." },
      { id: 2, body: "## Shared Contract (v1)\n\nActual contract body." },
    ],
    heading,
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 2);
});

test("pickLatestComment: picks the numerically highest id among candidates", () => {
  const result = pickLatestComment([{ id: 5 }, { id: 20 }, { id: 11 }]);
  assert.equal(result.id, 20);
  assert.equal(pickLatestComment([]), null);
});

test("parseBulletBlock: collapses wrapped continuation lines and stops at the next bullet", () => {
  const body = [
    "- **Required bounded outcome:** first line of the outcome",
    "  continues here across a soft wrap.",
    "- **Applicable role/capability:** bounded coding worker.",
  ].join("\n");
  assert.equal(
    parseBulletBlock(body, "Required bounded outcome"),
    "first line of the outcome continues here across a soft wrap.",
  );
  assert.equal(parseBulletBlock(body, "Applicable role/capability"), "bounded coding worker.");
  assert.equal(parseBulletBlock(body, "Nonexistent"), null);
});

test("parseBulletBlock: last occurrence wins when a label appears more than once", () => {
  const body = "- **State:** PLANNED (stale mention)\n\n- **State:** DONE\n";
  assert.equal(parseBulletBlock(body, "State"), "DONE");
});

test("parseUnitsBlock: extracts each indented sub-line as a separate item and stops at the next top-level bullet", () => {
  const body = [
    "- **Units:**",
    "  - 294-A: DONE — first (url-a)",
    "  - 294-B: PLANNED — second (url-b)",
    "- **Dependencies:** none",
  ].join("\n");
  const items = parseUnitsBlock(body);
  assert.deepEqual(items, ["- 294-A: DONE — first (url-a)", "- 294-B: PLANNED — second (url-b)"]);
});

test("parseUnitsBlock: returns null when no Units bullet exists at all", () => {
  assert.equal(parseUnitsBlock("- **Dependencies:** none\n"), null);
});

test("parseUnitListItem: parses unit id, state, outcome, and URL; rejects a malformed line", () => {
  const parsed = parseUnitListItem("- 294-A: DONE — Some outcome text (https://example.com/x#issuecomment-1)");
  assert.deepEqual(parsed, {
    unitId: "294-A",
    state: "DONE",
    outcome: "Some outcome text",
    url: "https://example.com/x#issuecomment-1",
  });
  assert.equal(parseUnitListItem("- 294-A missing everything else"), null);
  assert.equal(parseUnitListItem(""), null);
});

test("extractCommentIdFromUrl: extracts the numeric id from a comment permalink, null otherwise", () => {
  assert.equal(
    extractCommentIdFromUrl("https://github.com/LouPineWays/Loop-Dee-Loup/issues/294#issuecomment-5550652746"),
    5550652746,
  );
  assert.equal(extractCommentIdFromUrl("not a url"), null);
  assert.equal(extractCommentIdFromUrl(null), null);
});

test("findCommentById: finds by numeric id regardless of id type, null when absent", () => {
  const comments = [{ id: 5550652746 }, { id: 100 }];
  assert.equal(findCommentById(comments, 100).id, 100);
  assert.equal(findCommentById(comments, "100").id, 100);
  assert.equal(findCommentById(comments, 999), null);
  assert.equal(findCommentById(comments, null), null);
});

test("WORKER_UNIT_FIELDS: covers exactly the thirteen bold-label bullets fixed by the Shared Contract, in order", () => {
  assert.deepEqual(
    WORKER_UNIT_FIELDS.map(([label]) => label),
    [
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
    ],
  );
});
