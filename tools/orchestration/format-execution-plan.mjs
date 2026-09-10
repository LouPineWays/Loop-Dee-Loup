#!/usr/bin/env node
// Deterministic writer/formatter for a #294-shaped multi-unit execution plan's durable
// artifacts (Plan Index / Shared Contract / Worker Unit Contract comments) — worker unit
// 497-A under execution issue #497 / controlling issue #499.
//
// Pairs with the existing reader `parse-execution-plan.mjs`: this module owns 100% of the
// parser-sensitive Markdown syntax (exact headings, bold-label field order, the
// one-physical-line Plan Index Units record shape) so a planning worker supplies only
// semantic/structured values — unit outcomes, dependencies, a canonical capability
// selection, Shared Contract prose — and never hand-authors raw Markdown for these three
// artifact types. This closes three live regressions #497 was decomposed from #433 to fix:
//   - #407/#408, #439 (capability half)/#440, #454/#455: a Worker Unit Contract's
//     "Applicable role/capability" field carried free-form descriptive prose instead of a
//     canonical route-table token, so `prepare-dispatch-manifest.mjs` correctly rejected the
//     unit with route=REPLAN_REQUIRED only after the plan had already been durably (and
//     wrongly) persisted as though it were ready.
//   - #439 (line-wrap half): a long one-line unit outcome was hand-wrapped across two
//     physical Markdown source lines in the Plan Index's Units list, so
//     `parse-execution-plan.mjs` rejected the whole plan as structurally malformed before
//     the capability field was ever reached.
//
// Canonical capability vocabulary: imported directly from `prepare-dispatch-manifest.mjs`'s
// exported `CAPABILITY_CLASS_ROUTE_TABLE` — never hand-duplicated here (#497 Required
// behavior item 3 / Constraints). A structured `applicableRoleCapability` input value must
// be exactly one of that table's five keys, matched case-insensitively (the same way
// `resolveUnitRoute`/`extractCapabilityClassLabel` already match a parsed field against this
// table). This writer then deterministically appends the fixed "(see Shared Contract)."
// reference itself, so a planning worker never hand-types the full sentence and can never
// accidentally decorate it with the descriptive prose #407/#439/#454 hit — that prose
// belongs in "Authority/input pointers" or "Required bounded outcome" instead.
//
// Validate-before-publish: `validatePlanInput` is a pure function that checks every
// structured value across all three artifact types present in the input — required and
// non-empty, no embedded literal newline in anything destined for a single-physical-line
// record, a canonical capability token per unit, a recognized Plan state / unit State value
// — and returns every problem found, never just the first. Nothing is serialized, and the
// CLI performs no GitHub write, when validation fails.
//
// Round-trip self-check: `buildPlanArtifacts` additionally feeds its own freshly serialized
// Plan Index Units-list entries back through the real `parse-execution-plan.mjs` functions
// (`parseUnitListItem`, and — once a Shared Contract and every Worker Unit are also present
// — the full `parseExecutionPlan`) against a synthesized in-memory comment array, before
// ever returning success. This uses the actual reader a later `gh`-backed session will use,
// not a re-implementation of its grammar, so a structurally-invalid serialization is caught
// here rather than surfacing later as a live parse failure on GitHub.
//
// Usage (compose only — validates and prints the requested artifact bodies as JSON; no
// GitHub write; every URL the Plan Index needs — `sharedContractUrl`, each unit's
// `commentUrl` — must already be known and supplied in the input):
//   node tools/orchestration/format-execution-plan.mjs --input plan.json
//
// Usage (compose + persist — posts the real comments via `gh api` (always creating fresh
// comments; no in-place refresh/PATCH support — see `publishPlanArtifacts`), in Shared
// Contract -> Worker Units -> Plan Index order so the Plan Index's own Units list can
// reference the just-created real comment URLs; re-reads and re-parses via
// `parse-execution-plan.mjs` after writing to verify the live round trip):
//   node tools/orchestration/format-execution-plan.mjs --input plan.json --publish
//
// Structured input shape (see `validatePlanInput`'s field-by-field checks for the
// authoritative contract; `sharedContract`/`workerUnits`/`planIndex` may each be omitted to
// compose only a subset — e.g. posting Worker Unit comments first to learn their URLs before
// composing the Plan Index that references them):
//   {
//     "executionIssue": 497,
//     "sharedContract": { "body": "free-form markdown beneath the heading" },
//     "workerUnits": [{
//       "unitId": "497-A",
//       "requiredBoundedOutcome": "...", "applicableRoleCapability": "bounded coding worker",
//       "authorityInputPointers": "...", "relevantSharedContractPointer": "...",
//       "prerequisitesDependencies": "...", "filesSurfacesExpectedToChange": "...",
//       "observableCompletionCondition": "...", "verificationRequired": "...",
//       "durableOutputStateExpected": "...", "interruptEscalationConditions": "...",
//       "state": "PLANNED"
//     }],
//     "planIndex": {
//       "planState": "PLANNED", "dependencies": "none", "dispatchManifest": "none",
//       "integrationRoute": "none", "sharedContractUrl": "<real comment URL>",
//       "units": [{ "unitId": "497-A", "state": "PLANNED", "outcome": "one-line outcome",
//                    "commentUrl": "<real comment URL>" }]
//     }
//   }
// `Unit ID` and `Parent execution issue` are never accepted as separate free-form fields —
// this writer derives both itself (from a worker unit's key in `workerUnits`/`units`, and
// from the top-level `executionIssue`), closing off a whole mismatch class (a heading naming
// one unit while its own "Unit ID" bullet names another) by construction.
//
// Exit codes: 0 = success (artifacts composed, and persisted if `--publish`); 1 = invalid
// input, rejected before anything is written (compact JSON `{ ok: false, errors }` on
// stderr — no partial/misleading output); 2 = operational error (bad CLI usage, or a `gh`
// failure during `--publish`).
//
// Tests: node --test tools/orchestration/format-execution-plan.test.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseExecutionPlan,
  parseUnitListItem,
  runParseExecutionPlan,
  WORKER_UNIT_FIELDS,
  extractCommentIdFromUrl,
} from "./parse-execution-plan.mjs";
import { CAPABILITY_CLASS_ROUTE_TABLE } from "./prepare-dispatch-manifest.mjs";
import { resolveRepoIdentity } from "./ready-dispatch-gate.mjs";

// The Plan Index's "Plan state" bullet and every unit's "State" field share this fixed
// vocabulary (docs/operating-model.md § Durable plan artifacts).
export const STATE_VOCABULARY = ["PLANNED", "ROUTED", "IN_PROGRESS", "BLOCKED", "DONE", "REPLAN_REQUIRED"];

// The canonical `Applicable role/capability` tokens this writer accepts — exactly
// `prepare-dispatch-manifest.mjs`'s own route-table keys, never hand-duplicated.
export const CANONICAL_CAPABILITY_TOKENS = Object.keys(CAPABILITY_CLASS_ROUTE_TABLE);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasEmbeddedNewline(value) {
  return typeof value === "string" && /[\r\n]/.test(value);
}

function hasWhitespace(value) {
  return typeof value === "string" && /\s/.test(value);
}

// Pure. `docs/operating-model.md` § Durable plan artifacts fixes the Unit-ID convention as
// `<execution-issue-number>-<Letter>` (a plan's units are always scoped to the execution
// Issue that owns them). This is not cosmetic: `prepare-dispatch-manifest.mjs` recognizes a
// "depends on" dependency token only via its own `UNIT_ID_TOKEN = /\d+-[A-Za-z]+/`, so a
// unit ID that does not carry the current execution Issue's own number is silently
// unrecognizable to that downstream matcher (a prerequisite naming it would be read as no
// dependency at all). Returns true when `executionIssue` itself is not a valid positive
// integer — that condition is already reported separately by the caller, and this check
// must not produce a second, confusing error about it.
function isExecutionScopedUnitId(unitId, executionIssue) {
  if (!Number.isInteger(executionIssue) || executionIssue <= 0) return true;
  return new RegExp(`^${executionIssue}-[A-Za-z]+$`).test(unitId);
}

// Pure. A Plan Index `sharedContractUrl` / unit `commentUrl` must be an actual GitHub issue
// comment permalink (`...#issuecomment-<numeric id>`) — the exact shape
// `parse-execution-plan.mjs`'s own `extractCommentIdFromUrl` requires to resolve the
// referenced comment. A merely whitespace-free string (e.g. "not-a-comment-url") is not
// sufficient: it would pass this writer's own compose-only validation yet fail to parse
// once read back for real, since nothing here re-derives the comment ID a live `gh` read
// would need.
function isCommentPermalink(value) {
  return typeof value === "string" && extractCommentIdFromUrl(value) !== null;
}

// Pure. Returns the canonical token (in the table's own casing) matching `value`
// case-insensitively, or null when `value` is not exactly one of the five tokens — never a
// fuzzy/partial match.
export function findCanonicalCapabilityToken(value) {
  if (!isNonEmptyString(value)) return null;
  const trimmed = value.trim().toLowerCase();
  return CANONICAL_CAPABILITY_TOKENS.find((token) => token.toLowerCase() === trimmed) ?? null;
}

// The 11 Worker Unit Contract fields a caller supplies as free-form input — the full
// `WORKER_UNIT_FIELDS` list (imported, not duplicated) minus "Unit ID" and "Parent execution
// issue", both of which this writer derives itself (see module comment).
const WORKER_UNIT_INPUT_KEYS = WORKER_UNIT_FIELDS.map(([, key]) => key).filter(
  (key) => key !== "unitId" && key !== "parentExecutionIssue",
);

// Pure. Validates one Worker Unit Contract's structured input. Returns an array of every
// problem found (empty when valid) — never stops at the first.
export function validateWorkerUnitInput(unit, { unitId, executionIssue } = {}) {
  const errors = [];
  const label = isNonEmptyString(unitId) ? `worker unit "${unitId}"` : "a worker unit";

  if (!isNonEmptyString(unitId)) {
    errors.push("a worker unit is missing its unitId");
  } else if (/[\s:]/.test(unitId)) {
    errors.push(`${label}: unitId must not contain whitespace or ":"`);
  } else if (!isExecutionScopedUnitId(unitId, executionIssue)) {
    errors.push(
      `${label}: unitId ${JSON.stringify(unitId)} must match the execution-scoped convention ` +
        `"<executionIssue>-<Letter>" (e.g. "${executionIssue}-A") for execution issue #${executionIssue} ` +
        `(docs/operating-model.md § Durable plan artifacts, Unit-ID convention)`,
    );
  }

  for (const key of WORKER_UNIT_INPUT_KEYS) {
    if (key === "applicableRoleCapability" || key === "state") continue;
    if (!isNonEmptyString(unit?.[key])) {
      errors.push(`${label}: missing required field "${key}"`);
    } else if (hasEmbeddedNewline(unit[key])) {
      errors.push(`${label}: field "${key}" must not contain an embedded newline`);
    }
  }

  if (!isNonEmptyString(unit?.state)) {
    errors.push(`${label}: missing required field "state"`);
  } else if (!STATE_VOCABULARY.includes(unit.state.trim())) {
    errors.push(
      `${label}: state ${JSON.stringify(unit.state)} is not one of the recognized values (${STATE_VOCABULARY.join(", ")})`,
    );
  }

  if (!isNonEmptyString(unit?.applicableRoleCapability)) {
    errors.push(`${label}: missing required field "applicableRoleCapability"`);
  } else if (!findCanonicalCapabilityToken(unit.applicableRoleCapability)) {
    errors.push(
      `${label}: "Applicable role/capability" value ${JSON.stringify(unit.applicableRoleCapability)} is not a ` +
        `canonical token (must be exactly one of: ${CANONICAL_CAPABILITY_TOKENS.join(", ")}) — descriptive ` +
        `role/expertise/access prose belongs in "Authority/input pointers" or "Required bounded outcome" instead`,
    );
  }

  return errors;
}

// Pure.
export function validateSharedContractInput(sharedContract) {
  const errors = [];
  if (!isNonEmptyString(sharedContract?.body)) {
    errors.push('Shared Contract: missing required field "body"');
  }
  return errors;
}

// Pure. Validates the Plan Index's structured input, including every Units-list entry.
// `sharedContractUrl` and each unit's `commentUrl` are always required here: this function
// only ever sees the values that will actually be serialized into the Plan Index this
// invocation composes, and a Plan Index bullet/entry with no URL is not a valid artifact —
// the `--publish` CLI path resolves real URLs from what it just posted before ever calling
// this validator, rather than this function itself growing a "URLs optional" mode.
export function validatePlanIndexInput(planIndex, { executionIssue } = {}) {
  const errors = [];
  if (!planIndex) return errors;

  if (!isNonEmptyString(planIndex.planState)) {
    errors.push('Plan Index: missing required field "planState"');
  } else if (!STATE_VOCABULARY.includes(planIndex.planState.trim())) {
    errors.push(
      `Plan Index: planState ${JSON.stringify(planIndex.planState)} is not one of the recognized values ` +
        `(${STATE_VOCABULARY.join(", ")})`,
    );
  }

  for (const key of ["dependencies", "dispatchManifest", "integrationRoute"]) {
    if (!isNonEmptyString(planIndex[key])) {
      errors.push(`Plan Index: missing required field "${key}"`);
    } else if (hasEmbeddedNewline(planIndex[key])) {
      errors.push(`Plan Index: field "${key}" must not contain an embedded newline`);
    }
  }

  if (!isNonEmptyString(planIndex.sharedContractUrl)) {
    errors.push('Plan Index: missing required field "sharedContractUrl"');
  } else if (hasWhitespace(planIndex.sharedContractUrl.trim())) {
    errors.push('Plan Index: "sharedContractUrl" must not contain whitespace');
  } else if (!isCommentPermalink(planIndex.sharedContractUrl.trim())) {
    errors.push(
      'Plan Index: "sharedContractUrl" must be a real GitHub issue comment permalink ' +
        '(".../issues/<N>#issuecomment-<id>"), not merely a whitespace-free string',
    );
  }

  if (!Array.isArray(planIndex.units) || planIndex.units.length === 0) {
    errors.push('Plan Index: "units" must be a non-empty array');
    return errors;
  }

  const seenUnitIds = new Set();
  planIndex.units.forEach((unit, index) => {
    const where = `Plan Index unit[${index}]`;
    if (!isNonEmptyString(unit?.unitId)) {
      errors.push(`${where}: missing required field "unitId"`);
    } else if (/[\s:]/.test(unit.unitId)) {
      errors.push(`${where}: unitId must not contain whitespace or ":"`);
    } else if (seenUnitIds.has(unit.unitId)) {
      errors.push(`${where}: duplicate unitId "${unit.unitId}"`);
    } else {
      seenUnitIds.add(unit.unitId);
      if (!isExecutionScopedUnitId(unit.unitId, executionIssue)) {
        errors.push(
          `${where}: unitId ${JSON.stringify(unit.unitId)} must match the execution-scoped convention ` +
            `"<executionIssue>-<Letter>" (e.g. "${executionIssue}-A") for execution issue #${executionIssue} ` +
            `(docs/operating-model.md § Durable plan artifacts, Unit-ID convention)`,
        );
      }
    }

    if (!isNonEmptyString(unit?.state)) {
      errors.push(`${where}: missing required field "state"`);
    } else if (!STATE_VOCABULARY.includes(unit.state.trim())) {
      errors.push(
        `${where}: state ${JSON.stringify(unit.state)} is not one of the recognized values (${STATE_VOCABULARY.join(", ")})`,
      );
    }

    if (!isNonEmptyString(unit?.outcome)) {
      errors.push(`${where}: missing required field "outcome"`);
    } else if (hasEmbeddedNewline(unit.outcome)) {
      errors.push(
        `${where}: "outcome" must not contain an embedded newline — a Plan Index Units entry must remain exactly ` +
          `one physical source line regardless of prose length (the #439 regression)`,
      );
    }

    if (!isNonEmptyString(unit?.commentUrl)) {
      errors.push(`${where}: missing required field "commentUrl"`);
    } else if (hasWhitespace(unit.commentUrl.trim())) {
      errors.push(`${where}: "commentUrl" must not contain whitespace`);
    } else if (!isCommentPermalink(unit.commentUrl.trim())) {
      errors.push(
        `${where}: "commentUrl" must be a real GitHub issue comment permalink ` +
          `(".../issues/<N>#issuecomment-<id>"), not merely a whitespace-free string`,
      );
    }
  });

  return errors;
}

// Pure. Validates the whole structured plan input across every artifact type present in
// `input`, accumulating every problem found — never stopping at the first — per the Shared
// Contract's "Validation-before-publish contract". Returns `{ ok: true, errors: [] }` or
// `{ ok: false, errors: [...] }`.
export function validatePlanInput(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, errors: ["input must be a JSON object"] };
  }

  const errors = [];
  if (!Number.isInteger(input.executionIssue) || input.executionIssue <= 0) {
    errors.push('missing or invalid required field "executionIssue" (must be a positive integer)');
  }
  if (!input.sharedContract && !input.workerUnits && !input.planIndex) {
    errors.push("input must supply at least one of: sharedContract, workerUnits, planIndex");
  }

  if (input.sharedContract) {
    errors.push(...validateSharedContractInput(input.sharedContract));
  }

  const workerUnitIds = new Set();
  if (input.workerUnits !== undefined) {
    if (!Array.isArray(input.workerUnits) || input.workerUnits.length === 0) {
      errors.push('"workerUnits" must be a non-empty array');
    } else {
      for (const unit of input.workerUnits) {
        if (isNonEmptyString(unit?.unitId)) {
          if (workerUnitIds.has(unit.unitId)) {
            errors.push(`duplicate workerUnits entry for unitId "${unit.unitId}"`);
          }
          workerUnitIds.add(unit.unitId);
        }
        errors.push(...validateWorkerUnitInput(unit, { unitId: unit?.unitId, executionIssue: input.executionIssue }));
      }
    }
  }

  if (input.planIndex) {
    errors.push(...validatePlanIndexInput(input.planIndex, { executionIssue: input.executionIssue }));
    if (input.workerUnits !== undefined && Array.isArray(input.planIndex.units)) {
      const planIndexUnitIds = new Set(
        input.planIndex.units.filter((u) => isNonEmptyString(u?.unitId)).map((u) => u.unitId),
      );
      for (const u of input.planIndex.units) {
        if (isNonEmptyString(u?.unitId) && !workerUnitIds.has(u.unitId)) {
          errors.push(`Plan Index lists unit "${u.unitId}" but no matching entry exists in "workerUnits"`);
        }
      }
      // The reverse direction (#497 Stage 1 review finding): a submitted Worker Unit
      // Contract absent from the Plan Index would still be persisted on --publish, yet the
      // Plan Index and any Dispatch Manifest derived from it would never reference it, so
      // that unit could never be dispatched even though the submitted plan included it.
      for (const unitId of workerUnitIds) {
        if (!planIndexUnitIds.has(unitId)) {
          errors.push(`"workerUnits" includes unit "${unitId}" but the Plan Index "units" list does not list it`);
        }
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [] };
}

// Pure. Renders the exact `## Shared Contract (v1)` comment body. The writer owns only the
// heading and the "Parent execution issue" bullet it derives from `executionIssue` — the
// body beneath is free-form, per docs/operating-model.md § Durable plan artifacts.
export function formatSharedContractBody(sharedContract, { executionIssue }) {
  return [
    "## Shared Contract (v1)",
    "",
    `- **Parent execution issue:** #${executionIssue}`,
    "",
    sharedContract.body.trim(),
    "",
  ].join("\n");
}

// Pure. Renders the exact `## Worker Unit: <UnitID> (v1)` comment body — the 13 bold-label
// bullets from `WORKER_UNIT_FIELDS`, in that exact order. "Unit ID" and "Parent execution
// issue" are derived (see module comment); "Applicable role/capability" is deterministically
// rendered from the validated canonical token plus the fixed "(see Shared Contract)."
// reference — never the caller's raw string — so this field can never carry decorative
// prose even if a caller's validated-away-by-construction input somehow tried to smuggle it.
export function formatWorkerUnitBody(unit, { executionIssue }) {
  const canonicalToken = findCanonicalCapabilityToken(unit.applicableRoleCapability);
  if (!canonicalToken) {
    throw new Error(
      `formatWorkerUnitBody: "${unit.unitId}" has a non-canonical applicableRoleCapability — call validatePlanInput first`,
    );
  }
  const values = {
    unitId: unit.unitId,
    parentExecutionIssue: `#${executionIssue}`,
    requiredBoundedOutcome: unit.requiredBoundedOutcome.trim(),
    applicableRoleCapability: `${canonicalToken} (see Shared Contract).`,
    authorityInputPointers: unit.authorityInputPointers.trim(),
    relevantSharedContractPointer: unit.relevantSharedContractPointer.trim(),
    prerequisitesDependencies: unit.prerequisitesDependencies.trim(),
    filesSurfacesExpectedToChange: unit.filesSurfacesExpectedToChange.trim(),
    observableCompletionCondition: unit.observableCompletionCondition.trim(),
    verificationRequired: unit.verificationRequired.trim(),
    durableOutputStateExpected: unit.durableOutputStateExpected.trim(),
    interruptEscalationConditions: unit.interruptEscalationConditions.trim(),
    state: unit.state.trim(),
  };
  const lines = [`## Worker Unit: ${unit.unitId} (v1)`, ""];
  for (const [label, key] of WORKER_UNIT_FIELDS) {
    lines.push(`- **${label}:** ${values[key]}`);
  }
  lines.push("");
  return lines.join("\n");
}

// Pure. Renders one Plan Index Units-list record — the exact
// `- <UnitID>: <state> — <one-line outcome> (<comment URL>)` shape
// `parse-execution-plan.mjs`'s `parseUnitListItem` parses. No leading indent (the caller
// adds that when assembling the Units block — see `formatPlanIndexBody`); this bare form is
// also what the round-trip self-check below feeds straight back into `parseUnitListItem`.
export function formatUnitListEntry({ unitId, state, outcome, url }) {
  return `- ${unitId}: ${state} — ${outcome} (${url})`;
}

// Pure. Renders the exact `## Execution Plan Index (v1)` comment body. Each Units-list line
// is indented by two spaces — required so `parse-execution-plan.mjs`'s `parseUnitsBlock`
// does not mistake it for a new unindented top-level bullet (which would end the Units block
// after the very first entry); matches the indentation this repository's own plans and
// `parse-execution-plan.test.mjs` fixtures already use.
export function formatPlanIndexBody(planIndex, { executionIssue }) {
  const lines = [
    "## Execution Plan Index (v1)",
    "",
    `- **Plan state:** ${planIndex.planState.trim()}`,
    `- **Parent execution issue:** #${executionIssue}`,
    `- **Shared contract:** ${planIndex.sharedContractUrl.trim()}`,
    "- **Units:**",
  ];
  for (const unit of planIndex.units) {
    lines.push(
      `  ${formatUnitListEntry({
        unitId: unit.unitId,
        state: unit.state.trim(),
        outcome: unit.outcome.trim(),
        url: unit.commentUrl.trim(),
      })}`,
    );
  }
  lines.push(`- **Dependencies:** ${planIndex.dependencies.trim()}`);
  lines.push(`- **Dispatch manifest:** ${planIndex.dispatchManifest.trim()}`);
  lines.push(`- **Integration/PR route:** ${planIndex.integrationRoute.trim()}`);
  lines.push("");
  return lines.join("\n");
}

// Pure. Synthesizes an in-memory comment array from freshly-formatted artifacts (using
// placeholder sequential comment ids/URLs — this check's only job is confirming the
// serialization grammar round-trips through the real reader, not verifying live GitHub
// identity, which the `--publish` path verifies separately after actually posting) and
// confirms `parse-execution-plan.mjs`'s own `parseExecutionPlan` accepts the whole plan.
// Only called once a Shared Contract, every referenced Worker Unit, and a Plan Index are all
// present together. Returns `{ ok: true }` or `{ ok: false, errors }`.
export function verifyFullRoundTrip(input, { executionIssue }) {
  const placeholderRepo = "example/example";
  const commentUrl = (id) => `https://github.com/${placeholderRepo}/issues/${executionIssue}#issuecomment-${id}`;

  let nextId = 1;
  const comments = [];

  const sharedContractId = nextId++;
  comments.push({
    id: sharedContractId,
    html_url: commentUrl(sharedContractId),
    body: formatSharedContractBody(input.sharedContract, { executionIssue }),
  });

  const unitCommentUrlByUnitId = {};
  for (const unit of input.workerUnits) {
    const id = nextId++;
    unitCommentUrlByUnitId[unit.unitId] = commentUrl(id);
    comments.push({ id, html_url: commentUrl(id), body: formatWorkerUnitBody(unit, { executionIssue }) });
  }

  const syntheticPlanIndex = {
    ...input.planIndex,
    sharedContractUrl: commentUrl(sharedContractId),
    units: input.planIndex.units.map((u) => ({ ...u, commentUrl: unitCommentUrlByUnitId[u.unitId] })),
  };
  const planIndexId = nextId++;
  comments.push({
    id: planIndexId,
    html_url: commentUrl(planIndexId),
    body: formatPlanIndexBody(syntheticPlanIndex, { executionIssue }),
  });

  const result = parseExecutionPlan(comments, { executionIssue });
  if (!result.ok) {
    return { ok: false, errors: result.errors.map((e) => `full-plan round-trip check failed: ${e}`) };
  }
  return { ok: true, errors: [] };
}

// The whole writer core: validate, then format whatever artifact types are present in
// `input`, self-checking every Plan Index Units-list entry against the real
// `parseUnitListItem` (and the whole plan against the real `parseExecutionPlan` once enough
// of it is present) before ever returning success. Returns `{ ok: true, artifacts }` or
// `{ ok: false, errors }` — on failure, `artifacts` is never populated, matching the
// "writes nothing on invalid input" contract (the CLI layer performs the actual GitHub write
// only after this returns ok:true).
export function buildPlanArtifacts(input) {
  const validation = validatePlanInput(input);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const { executionIssue } = input;
  const artifacts = {};

  if (input.sharedContract) {
    artifacts.sharedContractBody = formatSharedContractBody(input.sharedContract, { executionIssue });
  }

  if (input.workerUnits) {
    artifacts.workerUnitBodies = {};
    for (const unit of input.workerUnits) {
      artifacts.workerUnitBodies[unit.unitId] = formatWorkerUnitBody(unit, { executionIssue });
    }
  }

  if (input.planIndex) {
    const roundTripErrors = [];
    for (const unit of input.planIndex.units) {
      const entryLine = formatUnitListEntry({
        unitId: unit.unitId,
        state: unit.state.trim(),
        outcome: unit.outcome.trim(),
        url: unit.commentUrl.trim(),
      });
      const reparsed = parseUnitListItem(entryLine);
      if (
        !reparsed ||
        reparsed.unitId !== unit.unitId ||
        reparsed.state !== unit.state.trim() ||
        reparsed.outcome !== unit.outcome.trim() ||
        reparsed.url !== unit.commentUrl.trim()
      ) {
        roundTripErrors.push(
          `Plan Index unit "${unit.unitId}": formatted Units-list entry does not round-trip cleanly through ` +
            `parse-execution-plan.mjs's own parseUnitListItem (${JSON.stringify(entryLine)})`,
        );
      }
    }
    if (roundTripErrors.length > 0) return { ok: false, errors: roundTripErrors };

    artifacts.planIndexBody = formatPlanIndexBody(input.planIndex, { executionIssue });
  }

  if (artifacts.planIndexBody && artifacts.sharedContractBody && artifacts.workerUnitBodies) {
    const fullCheck = verifyFullRoundTrip(input, { executionIssue });
    if (!fullCheck.ok) return { ok: false, errors: fullCheck.errors };
  }

  return { ok: true, artifacts };
}

// ---------------------------------------------------------------------------------------
// CLI / GitHub persistence (--publish). Every I/O dependency is injectable so tests can
// drive this without touching the network, mirroring prepare-dispatch-manifest.mjs's own
// testability convention.
// ---------------------------------------------------------------------------------------

// Always creates a brand-new comment. This tool does not support in-place refresh (PATCH)
// of an existing Plan Index/Shared Contract/Worker Unit comment — `docs/operating-model.md`
// § Durable plan artifacts' "edit-ownership rule" refresh path (Route/Prepare-stage and
// Integration/PR worker refreshing the Plan Index in place) is real, but is not yet wired
// through this CLI. A prior version exposed an `existingCommentIds`/PATCH surface that no
// caller (CLI or otherwise) could actually reach, and that was never verified to preserve
// the "the parser reads back the comment we just wrote" invariant when it was reachable
// (#497 Stage 1 review findings). Removing it here rather than wiring it half-built keeps
// every `--publish` call unambiguous: it always creates fresh, freshly-verifiable comments.
function defaultPost({ repo, executionIssue, body }) {
  const tmpFile = path.join(tmpdir(), `format-execution-plan-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(tmpFile, body, "utf8");
  try {
    const args = ["api", `repos/${repo}/issues/${executionIssue}/comments`, "-X", "POST", "-F", `body=@${tmpFile}`];
    return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup only
    }
  }
}

// Reuses `parse-execution-plan.mjs`'s own real fetch-and-parse implementation directly
// (imported, not shelled out to as a subprocess) so the post-publish live round-trip check
// exercises the exact same code path a later `gh`-backed session's read does.
async function defaultRunParseExecutionPlan({ repo, executionIssue }) {
  return runParseExecutionPlan({ repo, executionIssue });
}

// Publishes whatever artifact types are present in a VALIDATED `input`, in Shared Contract
// -> Worker Units -> Plan Index order, so the Plan Index can reference the just-created real
// comment URLs. `input.planIndex` (if present) must NOT itself carry final `sharedContractUrl`/
// `commentUrl` values yet — this function resolves and fills those in from what it just
// posted, then re-validates/re-formats the completed Plan Index through `buildPlanArtifacts`
// before posting it, so the persisted Plan Index still passes the same validation and
// round-trip self-check as the compose-only path.
export async function publishPlanArtifacts(
  input,
  { repo, postImpl = defaultPost, verifyImpl = defaultRunParseExecutionPlan } = {},
) {
  // Validate the COMPLETE input — every artifact type present, including the Plan Index —
  // before any GitHub write happens. A prior version stripped `planIndex` out of this
  // pre-validation call, so a structurally malformed Plan Index (e.g. an empty "units"
  // array) was only discovered by `buildPlanArtifacts` further below, after the Shared
  // Contract and Worker Unit comments had already been posted — violating the "nothing is
  // written on invalid input" contract (#497 Stage 1 review finding). The Plan Index's
  // `sharedContractUrl`/unit `commentUrl` fields are always required as syntactically valid
  // permalinks even here: when `input.sharedContract`/`input.workerUnits` are also present
  // in this same call, those placeholder values are never actually persisted (they are
  // overwritten below with the freshly-posted real URLs) — they exist only to satisfy this
  // validation contract up front, matching every existing caller/test convention.
  const preValidation = validatePlanInput(input);
  if (!preValidation.ok) return { ok: false, errors: preValidation.errors };

  const { executionIssue } = input;
  const persisted = {};

  if (input.sharedContract) {
    const body = formatSharedContractBody(input.sharedContract, { executionIssue });
    const posted = await postImpl({ repo, executionIssue, body });
    persisted.sharedContractUrl = posted.html_url;
  }

  if (input.workerUnits) {
    persisted.workerUnitUrls = {};
    for (const unit of input.workerUnits) {
      const body = formatWorkerUnitBody(unit, { executionIssue });
      const posted = await postImpl({ repo, executionIssue, body });
      persisted.workerUnitUrls[unit.unitId] = posted.html_url;
    }
  }

  if (input.planIndex) {
    const resolvedPlanIndex = {
      ...input.planIndex,
      sharedContractUrl: persisted.sharedContractUrl ?? input.planIndex.sharedContractUrl,
      units: input.planIndex.units.map((u) => ({
        ...u,
        commentUrl: persisted.workerUnitUrls?.[u.unitId] ?? u.commentUrl,
      })),
    };
    const finalInput = { ...input, planIndex: resolvedPlanIndex };
    const built = buildPlanArtifacts(finalInput);
    if (!built.ok) return { ok: false, errors: built.errors };

    const posted = await postImpl({ repo, executionIssue, body: built.artifacts.planIndexBody });
    persisted.planIndexUrl = posted.html_url;

    const reparsed = await verifyImpl({ repo, executionIssue });
    if (!reparsed.ok) {
      const detail = (reparsed.errors ?? []).join(" | ") || reparsed.message || "unknown verification failure";
      return { ok: false, errors: [`live round-trip verification failed after publish: ${detail}`] };
    }
  }

  return { ok: true, persisted };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    if (a === "--publish") {
      args.publish = true;
      continue;
    }
    args[a.slice(2)] = argv[++i];
  }
  return args;
}

function readStdinIfPiped() {
  try {
    if (process.stdin.isTTY) return null;
    const raw = readFileSync(0, "utf8").trim();
    return raw ? raw : null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let raw;
  if (args.input) {
    try {
      raw = readFileSync(args.input, "utf8");
    } catch (err) {
      // A missing/unreadable --input file is an operational error (exit 2), the same as bad
      // CLI usage or a `gh` failure — never exit 1, which this module's own documented exit
      // codes reserve for validated-but-rejected plan input (#497 Stage 1 review finding: an
      // uncaught readFileSync here previously produced a bare Node stack trace on exit 1,
      // indistinguishable from a genuine invalid-plan rejection to any automation reading
      // the exit code alone).
      process.stderr.write(`format-execution-plan.mjs: could not read --input file "${args.input}": ${err.message}\n`);
      process.exit(2);
      return;
    }
  } else {
    raw = readStdinIfPiped();
    if (!raw) {
      process.stderr.write("format-execution-plan.mjs: pass --input <file.json> or pipe JSON on stdin\n");
      process.exit(2);
      return;
    }
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`format-execution-plan.mjs: could not parse input as JSON: ${err.message}\n`);
    process.exit(2);
    return;
  }

  if (args.publish) {
    let repo = args.repo;
    if (!repo) {
      const identity = resolveRepoIdentity();
      if (!identity.ok) {
        process.stderr.write(`format-execution-plan.mjs: could not determine repository identity: ${identity.reason}\n`);
        process.exit(2);
        return;
      }
      repo = identity.repo;
    }
    const result = await publishPlanArtifacts(input, { repo });
    if (!result.ok) {
      process.stderr.write(`${JSON.stringify({ ok: false, errors: result.errors })}\n`);
      process.exit(1);
      return;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, persisted: result.persisted })}\n`);
    process.exit(0);
    return;
  }

  const result = buildPlanArtifacts(input);
  if (!result.ok) {
    process.stderr.write(`${JSON.stringify({ ok: false, errors: result.errors })}\n`);
    process.exit(1);
    return;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, artifacts: result.artifacts })}\n`);
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("format-execution-plan.mjs")) {
  main();
}
