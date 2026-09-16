#!/usr/bin/env node
// Deterministic, field-scoped planning-correction writer for a #294-shaped execution plan's
// Worker Unit dependency topology -- issue #618 (control #619), closing the #441 live
// recurrence: 441-C was introduced by a planning correction after PR #615 review, but 441-B's
// own Worker Unit Contract still only declared "Depends on 441-A", so the corrected blocker
// could only be recorded as a Dispatch Manifest note/override -- exactly the "second semantic
// planning surface" #522/#294 already forbid. This module closes that gap the same way #522
// closed initial-authoring drift: `dependsOn` is a structured, complete replacement unit-ID
// set, never free-form prose or an incremental "add one more" delta, and it is the ONLY
// mechanism (besides the original plan-authoring writer, `format-execution-plan.mjs`) ever
// authorized to mutate a Worker Unit Contract's "Prerequisites/dependencies" field.
//
// Corrected invariant (issue #618's own framing): planning owns dependency topology, unit
// workers own execution state. A planning correction may change ONLY the dependency-topology
// field of an UNDISPATCHED unit, through this one deterministic, fail-closed mutation path.
// Ordinary Dispatch Manifest regeneration (`prepare-dispatch-manifest.mjs`, unchanged) then
// preserves the corrected blocker automatically, because it always re-derives readiness from
// live comment state -- there is nothing here for a plain re-run to "forget".
//
// Field-scoped exception to docs/operating-model.md § Durable plan artifacts' edit-ownership
// rule: normally only a unit's own dispatched worker may edit its Worker Unit Contract
// comment (to update State/completion). This script is the one narrow, deterministic
// exception -- it may touch ONLY the "Prerequisites/dependencies" bullet of an UNDISPATCHED
// unit's comment, and every other bullet (including State) is verified byte-identical
// before success is ever reported. It never rewrites outcome, capability, authority
// pointers, verification, files/surfaces, or any other unit semantics; a correction needing
// those belongs in a replacement unit instead (see AGENTS.md's Vertical-slice rule).
//
// Byte-preserving mutation, not reconstruction: `format-execution-plan.mjs`'s own
// `formatWorkerUnitBody` cannot be reused here -- it expects raw structured input (a bare
// canonical capability token, an array `dependsOn`), while a parsed live comment's fields are
// already fully rendered prose ("bounded coding worker (see Shared Contract).") that would
// not round-trip through that writer's own validation. Instead this module locates and
// replaces exactly the "- **Prerequisites/dependencies:** ..." bullet span (heading label
// line plus any wrapped continuation lines) inside the comment's OWN current raw body text,
// leaving every other line untouched byte-for-byte by construction -- not merely verified
// after the fact.
//
// Fail-closed validation before any write (mirrors #522's own "reject any dangling shape"
// discipline, extended two ways a fresh-plan submission does not need): every replacement
// `dependsOn` entry must already exist as a unit in the CURRENT live parsed plan (never a
// unit merely present in the same submission, since there is no submission here -- only an
// existing plan being corrected), and the replacement graph -- this unit's new edges plus
// every other unit's own currently-declared edges -- must not introduce a dependency cycle.
// Self-dependency, malformed IDs, and duplicate entries reuse `format-execution-plan.mjs`'s
// own exported `validateDependsOn`, the same shared check the original plan-authoring writer
// already applies, rather than a second, independently-drifting copy.
//
// Only-undispatched-units-mutable (Required layer 4): the target unit's own "State" field
// must currently be exactly PLANNED or ROUTED -- the two values in the shared State vocabulary
// (docs/operating-model.md § Durable plan artifacts) that precede a unit actually being
// worked. IN_PROGRESS, BLOCKED, DONE, and REPLAN_REQUIRED are all rejected: a unit's own
// dispatched worker (or its own prior REPLAN_REQUIRED escalation) already owns that comment's
// State/completion narrative, and this script must never race or overwrite it.
//
// Race-safety (Required layer 6): this performs the same fresh-state / pre-effect-revalidate /
// commit / read-back-verify sequence `transition-guard.mjs` codifies for control-Issue-body
// transitions (issue #601), adapted here to a single Worker Unit Contract COMMENT rather than
// a control Issue body -- `transition-guard.mjs` itself is not reused directly because its
// commit step is hard-wired to `write-control-snapshot.mjs`'s control-Issue-body write, not a
// `gh api issues/comments/<id> PATCH`. The plan is re-fetched and fully re-validated
// immediately before the mutation (closing the window opened by the initial fetch/validate),
// and the exact raw comment body the replacement is computed from is itself fetched fresh at
// that same checkpoint -- never a cached copy from the initial read. Any state/topology change
// detected in that window fails closed with exit code 3 (STALE_START_TOCTOU) and requires a
// fresh invocation of this same script, rather than silently overwriting concurrent state or
// proceeding on stale authorization. Once the PATCH lands, `prepare-dispatch-manifest.mjs`
// (unchanged, imported nowhere by this module) re-derives dispatch_ready from the live comment
// on every subsequent invocation -- there is no separate "manifest reversion" window once this
// script's own postcondition is durably verified.
//
// Usage:
//   node tools/orchestration/correct-unit-dependency.mjs \
//     --execution-issue 441 --unit 441-B --depends-on 441-A,441-C
//   node tools/orchestration/correct-unit-dependency.mjs \
//     --execution-issue 441 --unit 441-B --depends-on ""   # corrects to "no dependencies"
//
// Exit codes:
//   0 -- DEPENDENCY_CORRECTION_VERIFIED: durably persisted and read-back-verified.
//   1 -- invalid input or an operational read failure; NOTHING was written. Covers: bad CLI
//        usage, unresolved repository identity, unknown target unit, a target unit whose
//        State is outside the safe pre-dispatch set, unknown/self/malformed/duplicate
//        dependency IDs, a dependency set that would introduce a cycle, or the target
//        comment's raw body having no "Prerequisites/dependencies" bullet to replace.
//   2 -- the execution plan itself could not be parsed (propagates parse-execution-plan.mjs's
//        own malformed-plan errors).
//   3 -- STALE_START_TOCTOU: the target unit's state or the plan's dependency topology changed
//        between the initial validation and the pre-write revalidation. Fail-closed; nothing
//        was written. Re-run this script fresh against current state.
//   4 -- CORRECTION_UNVERIFIED: the PATCH was attempted but its postcondition (byte-identical
//        other fields, exact round-tripped dependsOn) could not be confirmed by a fresh
//        read-back. The write may or may not have taken -- treat as unverified, not as a
//        confirmed failure or a confirmed success.
//
// Tests: node --test tools/orchestration/correct-unit-dependency.test.mjs

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runParseExecutionPlan, parseBulletBlock, WORKER_UNIT_FIELDS, WORKER_UNIT_HEADING } from "./parse-execution-plan.mjs";
import { validateDependsOn } from "./format-execution-plan.mjs";
import { extractDependencyUnitIds, hasUnrecognizedDependencyWording, formatPrerequisitesDependencies } from "./dependency-grammar.mjs";
import { resolveRepoIdentity } from "./ready-dispatch-gate.mjs";

const PREREQUISITES_LABEL = "Prerequisites/dependencies";

// The only unit "State" values a dependency correction may target -- see module comment's
// "Only-undispatched-units-mutable" section. Order is not semantic; this is a set.
export const SAFE_PRE_DISPATCH_STATES = ["PLANNED", "ROUTED"];

// Pure. A unit's "State" field may carry a trailing completion note (e.g. "DONE -- verified;
// commits ..."), mirroring prepare-dispatch-manifest.mjs's own `isDoneState` convention --
// this extracts just the leading state word for comparison against SAFE_PRE_DISPATCH_STATES.
export function extractStateWord(state) {
  if (typeof state !== "string") return null;
  const m = state.trim().match(/^([A-Z_]+)/);
  return m ? m[1] : null;
}

// Pure.
export function isSafePreDispatchState(state) {
  const word = extractStateWord(state);
  return word !== null && SAFE_PRE_DISPATCH_STATES.includes(word);
}

// Pure. Builds the whole plan's dependency graph (unitId -> array of dependency unit IDs) from
// each unit's own currently-declared "Prerequisites/dependencies" field, EXCEPT `unitId`, whose
// edges are overridden with the proposed replacement `dependsOn` -- this is the graph the
// correction would actually produce if committed, used for the pre-write cycle check.
export function buildDependencyGraph(plan, { unitId, dependsOn }) {
  const graph = {};
  for (const [id, unit] of Object.entries(plan?.units ?? {})) {
    graph[id] = id === unitId ? [...dependsOn] : extractDependencyUnitIds(unit.prerequisitesDependencies);
  }
  if (!(unitId in graph)) graph[unitId] = [...dependsOn];
  return graph;
}

// Pure. Standard DFS cycle detection (white/gray/black coloring) over a small adjacency map.
// Returns the cycle as an ordered array of unit IDs (first id repeated at the end, e.g.
// ["441-B", "441-C", "441-B"]) or null when the graph is acyclic. An edge to an id absent from
// `graph` is ignored here -- an unresolved/unknown dependency is reported separately by
// `validateDependencyCorrection`'s own unknown-ID check, never silently treated as a cycle
// participant. This is intentionally the smallest cycle check that closes the demonstrated
// gap (Required layer 5) -- not a general graph-analysis engine.
export function detectCycle(graph) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = {};
  for (const id of Object.keys(graph)) color[id] = WHITE;
  let cyclePath = null;

  function visit(id, stack) {
    color[id] = GRAY;
    stack.push(id);
    for (const dep of graph[id] ?? []) {
      if (cyclePath) return;
      if (!(dep in graph)) continue;
      if (color[dep] === GRAY) {
        const idx = stack.indexOf(dep);
        cyclePath = [...stack.slice(idx), dep];
        return;
      }
      if (color[dep] === WHITE) {
        visit(dep, stack);
        if (cyclePath) return;
      }
    }
    stack.pop();
    color[id] = BLACK;
  }

  for (const id of Object.keys(graph)) {
    if (color[id] === WHITE) visit(id, []);
    if (cyclePath) break;
  }
  return cyclePath;
}

// Pure. Validates a proposed dependency correction against a freshly parsed plan (the output
// shape of parse-execution-plan.mjs's own `parseExecutionPlan`/`runParseExecutionPlan`).
// Accumulates every problem found -- never stops at the first -- matching this repository's
// established validate-before-publish convention (format-execution-plan.mjs's own
// `validatePlanInput`).
export function validateDependencyCorrection(plan, { executionIssue, unitId, dependsOn }) {
  const errors = [];
  const label = `worker unit "${unitId}"`;

  const unit = plan?.units?.[unitId];
  if (!unit) {
    errors.push(`${label}: not found in the current parsed execution plan for issue #${executionIssue}`);
    return { ok: false, errors };
  }

  if (!isSafePreDispatchState(unit.state)) {
    errors.push(
      `${label}: current State ${JSON.stringify(unit.state)} is not one of the safe pre-dispatch states ` +
        `(${SAFE_PRE_DISPATCH_STATES.join(", ")}) -- only an undispatched unit's dependency topology may be ` +
        `corrected through this mechanism; a started, blocked, done, or replan-required unit's contract is ` +
        `owned exclusively by its own dispatched worker (or its own prior escalation)`,
    );
  }

  if (!Array.isArray(dependsOn)) {
    errors.push(`${label}: dependsOn must be an array of sibling unit IDs, or [] to correct to "no dependencies"`);
    return { ok: false, errors };
  }

  errors.push(...validateDependsOn(dependsOn, { unitId, executionIssue, label }));

  const knownUnitIds = new Set(Object.keys(plan.units ?? {}));
  for (const depId of dependsOn) {
    if (typeof depId === "string" && depId.trim() && !knownUnitIds.has(depId)) {
      errors.push(
        `${label}: "dependsOn" entry ${JSON.stringify(depId)} does not match any unit in the current execution ` +
          `plan for issue #${executionIssue} -- a dependency correction may only reference a unit that already exists`,
      );
    }
  }

  if (errors.length === 0) {
    const graph = buildDependencyGraph(plan, { unitId, dependsOn });
    const cycle = detectCycle(graph);
    if (cycle) {
      errors.push(`${label}: dependsOn ${JSON.stringify(dependsOn)} would introduce a dependency cycle: ${cycle.join(" -> ")}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// Pure. Locates the "- **<label>:** ..." bullet span (its own label line plus any wrapped
// continuation lines) inside `lines`, mirroring parse-execution-plan.mjs's own
// `parseBulletBlock` scanning rules exactly (last occurrence wins; stops at the next
// unindented "- " bullet, a "## " heading, or end of body) so the span this replaces is
// provably the same span that parser would read as this field's value. Returns
// { startIdx, endIdx } (endIdx exclusive) or null when the label is not found.
export function findBulletFieldSpan(lines, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const labelPattern = new RegExp(`^-\\s*\\*\\*${escaped}:\\*\\*\\s*(.*)$`, "i");
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (labelPattern.test(lines[i])) startIdx = i;
  }
  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^-\s/.test(line)) {
      endIdx = i;
      break;
    }
    if (/^##\s/.test(line.trim())) {
      endIdx = i;
      break;
    }
  }
  return { startIdx, endIdx };
}

// Pure. Replaces exactly the "Prerequisites/dependencies" bullet span in `rawBody` with the
// one canonical serialization `dependency-grammar.mjs`'s own `formatPrerequisitesDependencies`
// produces -- the same serializer format-execution-plan.mjs uses, so the corrected field is
// guaranteed recognizable by prepare-dispatch-manifest.mjs's router by construction, not by
// convention. Every line outside the located span is copied through unchanged, so preservation
// of every other field is a property of this function's own construction, not merely
// something verified after the fact. Returns { ok: false, reason } when the label bullet is
// not found at all (an unexpected/malformed live comment -- never guessed at).
export function replacePrerequisitesDependenciesField(rawBody, dependsOn) {
  const lines = (rawBody ?? "").split("\n");
  const span = findBulletFieldSpan(lines, PREREQUISITES_LABEL);
  if (!span) {
    return { ok: false, reason: `no "- **${PREREQUISITES_LABEL}:**" bullet was found in the target comment's current body` };
  }
  const newLine = `- **${PREREQUISITES_LABEL}:** ${formatPrerequisitesDependencies(dependsOn)}`;
  const nextLines = [...lines.slice(0, span.startIdx), newLine, ...lines.slice(span.endIdx)];
  return { ok: true, body: nextLines.join("\n") };
}

// Pure. Extracts every WORKER_UNIT_FIELDS bullet value plus the comment's own heading unit ID
// from a raw comment body -- the snapshot this module diffs before/after the mutation to prove
// only "Prerequisites/dependencies" changed.
export function extractAllWorkerUnitFields(body) {
  const fields = {};
  for (const [label, key] of WORKER_UNIT_FIELDS) {
    fields[key] = parseBulletBlock(body, label);
  }
  const headingLine = (body ?? "").split("\n").map((l) => l.trim()).find((l) => l.startsWith("## "));
  const headingMatch = headingLine ? WORKER_UNIT_HEADING.exec(headingLine) : null;
  fields.headingUnitId = headingMatch ? headingMatch[1] : null;
  return fields;
}

// Pure. Compares two `extractAllWorkerUnitFields` snapshots and confirms every field EXCEPT
// "Prerequisites/dependencies" (and the heading, which must still name `unitId`) is identical
// -- the "changes only the dependency-topology field" postcondition, checked mechanically
// rather than merely asserted by construction. Returns every mismatch found, never just the
// first.
export function verifyOnlyDependenciesFieldPreserved(before, after, { unitId }) {
  const errors = [];
  if (after.headingUnitId !== unitId) {
    errors.push(`comment heading no longer names unit "${unitId}" (found ${JSON.stringify(after.headingUnitId)})`);
  }
  for (const [label, key] of WORKER_UNIT_FIELDS) {
    if (key === "prerequisitesDependencies") continue;
    if (before[key] !== after[key]) {
      errors.push(
        `field "${label}" changed unexpectedly during dependency correction (was ${JSON.stringify(before[key])}, ` +
          `now ${JSON.stringify(after[key])})`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

function defaultGetComment({ repo, commentId }) {
  const raw = execFileSync("gh", ["api", `repos/${repo}/issues/comments/${commentId}`], { encoding: "utf8" });
  return JSON.parse(raw);
}

// Mirrors prepare-dispatch-manifest.mjs's own defaultPost PATCH shape exactly, including the
// tmpfile + `-F body=@<file>` convention -- `-f body=@file` posts the literal string instead of
// expanding the file's content and has silently corrupted comments on this repository before.
function defaultPatchComment({ repo, commentId, body }) {
  const tmpFile = path.join(tmpdir(), `correct-unit-dependency-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(tmpFile, body, "utf8");
  try {
    const raw = execFileSync(
      "gh",
      ["api", `repos/${repo}/issues/comments/${commentId}`, "-X", "PATCH", "-F", `body=@${tmpFile}`],
      { encoding: "utf8" },
    );
    return JSON.parse(raw);
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup only
    }
  }
}

// The whole correction core: fresh-read/validate, pre-effect fresh-read/revalidate (TOCTOU
// guard), byte-preserving mutation, PATCH, and read-back verification. Every I/O dependency is
// injectable so tests drive this without touching the network, mirroring every other script in
// this directory's own testability convention.
export async function runCorrectUnitDependency(
  { repo, executionIssue, unitId, dependsOn },
  {
    parseExecutionPlanImpl = runParseExecutionPlan,
    getCommentImpl = defaultGetComment,
    patchCommentImpl = defaultPatchComment,
    resolveRepoIdentityImpl = resolveRepoIdentity,
  } = {},
) {
  if (!Number.isInteger(executionIssue) || executionIssue <= 0) {
    return { exitCode: 1, ok: false, errors: ["missing or invalid required arg: --execution-issue must be a positive integer"] };
  }
  if (typeof unitId !== "string" || !unitId.trim()) {
    return { exitCode: 1, ok: false, errors: ["missing required arg: --unit"] };
  }
  if (!Array.isArray(dependsOn)) {
    return {
      exitCode: 1,
      ok: false,
      errors: ['missing required arg: --depends-on (complete comma-separated dependsOn unit-ID set, or "" for none)'],
    };
  }

  let resolvedRepo = repo;
  if (!resolvedRepo) {
    const identity = resolveRepoIdentityImpl();
    if (!identity.ok) {
      return { exitCode: 1, ok: false, operationalError: true, errors: [`could not determine repository identity: ${identity.reason}`] };
    }
    resolvedRepo = identity.repo;
  }

  // Step 1: fresh current state, and validate authorization/preconditions against it. Fails
  // fast, before any further read or write, if the correction was never authorized to begin
  // with (unknown unit, unsafe state, unknown/self/cyclic dependsOn).
  const initialParsed = await parseExecutionPlanImpl({ repo: resolvedRepo, executionIssue });
  if (initialParsed.exitCode === 1) {
    return { exitCode: 1, ok: false, operationalError: true, errors: [initialParsed.message] };
  }
  if (initialParsed.exitCode !== 0) {
    return { exitCode: 2, ok: false, errors: initialParsed.errors ?? [initialParsed.message ?? "execution plan could not be parsed"] };
  }
  const initialValidation = validateDependencyCorrection(initialParsed.plan, { executionIssue, unitId, dependsOn });
  if (!initialValidation.ok) {
    return { exitCode: 1, ok: false, errors: initialValidation.errors };
  }
  const commentId = initialParsed.plan.units[unitId].commentId;

  // Step 2: immediately before the durable effect, re-fetch and fully revalidate -- closing
  // the window between step 1 and now (another controller could have dispatched this unit, or
  // another planning correction could have already changed its topology, in the interim). Any
  // disagreement fails closed rather than proceeding on stale authorization.
  const freshParsed = await parseExecutionPlanImpl({ repo: resolvedRepo, executionIssue });
  if (freshParsed.exitCode !== 0) {
    return {
      exitCode: 3,
      ok: false,
      state: "STALE_START_TOCTOU",
      errors: [
        "pre-write re-read of the execution plan failed or the plan became unparseable between initial " +
          "validation and the mutation -- fail closed; re-run this planning correction fresh",
        ...(freshParsed.errors ?? [freshParsed.message].filter(Boolean)),
      ],
    };
  }
  const freshValidation = validateDependencyCorrection(freshParsed.plan, { executionIssue, unitId, dependsOn });
  if (!freshValidation.ok) {
    return {
      exitCode: 3,
      ok: false,
      state: "STALE_START_TOCTOU",
      errors: [
        `target unit "${unitId}" or the surrounding plan topology changed concurrently between initial ` +
          `validation and the mutation -- fail closed; re-run this planning correction fresh`,
        ...freshValidation.errors,
      ],
    };
  }
  const freshUnit = freshParsed.plan.units[unitId];
  if (freshUnit.commentId !== commentId) {
    return {
      exitCode: 3,
      ok: false,
      state: "STALE_START_TOCTOU",
      errors: [`target unit "${unitId}"'s own comment identity changed between initial validation and the mutation -- fail closed`],
    };
  }

  // Fetch the raw comment body fresh at this same pre-write checkpoint -- the replacement is
  // computed from a body known-current at mutation time, never a copy cached from step 1.
  let rawComment;
  try {
    rawComment = await getCommentImpl({ repo: resolvedRepo, commentId });
  } catch (err) {
    return { exitCode: 1, ok: false, operationalError: true, errors: [`failed reading target comment #${commentId}: ${err.message}`] };
  }
  const rawBody = rawComment.body ?? "";
  const preWriteFields = extractAllWorkerUnitFields(rawBody);
  if (preWriteFields.headingUnitId !== unitId) {
    return {
      exitCode: 3,
      ok: false,
      state: "STALE_START_TOCTOU",
      errors: [`target comment #${commentId}'s own heading no longer names unit "${unitId}" -- fail closed`],
    };
  }
  if (preWriteFields.prerequisitesDependencies !== freshUnit.prerequisitesDependencies) {
    return {
      exitCode: 3,
      ok: false,
      state: "STALE_START_TOCTOU",
      errors: [
        `target comment #${commentId}'s "Prerequisites/dependencies" field changed between the plan re-read and ` +
          `the raw comment fetch -- fail closed; re-run this planning correction fresh`,
      ],
    };
  }

  const replaced = replacePrerequisitesDependenciesField(rawBody, dependsOn);
  if (!replaced.ok) {
    return { exitCode: 1, ok: false, errors: [replaced.reason] };
  }

  // Step 3: perform the bounded effect.
  try {
    await patchCommentImpl({ repo: resolvedRepo, commentId, body: replaced.body });
  } catch (err) {
    return {
      exitCode: 4,
      ok: false,
      state: "CORRECTION_UNVERIFIED",
      errors: [`PATCH failed for comment #${commentId}: ${err.message}`],
    };
  }

  // Step 4: fresh read-back verifies the postcondition before success is ever reported --
  // never trusting the PATCH call's own return value alone.
  let readBack;
  try {
    readBack = await getCommentImpl({ repo: resolvedRepo, commentId });
  } catch (err) {
    return {
      exitCode: 4,
      ok: false,
      state: "CORRECTION_UNVERIFIED",
      errors: [`post-write read-back failed for comment #${commentId}: ${err.message}`],
    };
  }
  const readBody = readBack.body ?? "";
  if (readBody !== replaced.body) {
    return {
      exitCode: 4,
      ok: false,
      state: "CORRECTION_UNVERIFIED",
      errors: [
        `read-back body for comment #${commentId} does not match the written body -- the write did not take, or ` +
          `a concurrent edit landed immediately after it`,
      ],
    };
  }
  const readBackFields = extractAllWorkerUnitFields(readBody);
  const preservation = verifyOnlyDependenciesFieldPreserved(preWriteFields, readBackFields, { unitId });
  if (!preservation.ok) {
    return { exitCode: 4, ok: false, state: "CORRECTION_UNVERIFIED", errors: preservation.errors };
  }
  const roundTripped = extractDependencyUnitIds(readBackFields.prerequisitesDependencies);
  if (
    hasUnrecognizedDependencyWording(readBackFields.prerequisitesDependencies) ||
    JSON.stringify(roundTripped) !== JSON.stringify(dependsOn)
  ) {
    return {
      exitCode: 4,
      ok: false,
      state: "CORRECTION_UNVERIFIED",
      errors: [
        `persisted "Prerequisites/dependencies" field ${JSON.stringify(readBackFields.prerequisitesDependencies)} ` +
          `did not round-trip to the intended dependsOn set ${JSON.stringify(dependsOn)}`,
      ],
    };
  }

  return {
    exitCode: 0,
    ok: true,
    state: "DEPENDENCY_CORRECTION_VERIFIED",
    repo: resolvedRepo,
    executionIssue,
    unitId,
    commentId,
    commentUrl: readBack.html_url ?? rawComment.html_url ?? null,
    dependsOn,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    args[a.slice(2)] = argv[++i];
  }
  return args;
}

// Pure. `undefined`/absent -> null (the flag was not supplied at all -- an error, distinct
// from an explicit empty declaration). An explicit empty string -> [] (the canonical "no
// dependencies" correction). Otherwise a comma-separated list, trimmed, with empty tokens
// dropped (so a stray trailing comma does not silently manufacture a bogus "" entry).
export function parseDependsOnArg(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const executionIssue = args["execution-issue"] != null ? Number(args["execution-issue"]) : NaN;
  const unitId = args.unit;
  const dependsOn = parseDependsOnArg(args["depends-on"]);

  if (!Number.isInteger(executionIssue) || executionIssue <= 0 || !unitId || dependsOn === null) {
    process.stderr.write(
      "correct-unit-dependency.mjs: usage: --execution-issue <N> --unit <UnitID> " +
        '--depends-on <comma-separated unit IDs, or "" for none> [--repo OWNER/REPO]\n',
    );
    process.exit(2);
    return;
  }

  const result = await runCorrectUnitDependency({ repo: args.repo, executionIssue, unitId, dependsOn });
  if (!result.ok) {
    process.stderr.write(`${JSON.stringify({ ok: false, state: result.state ?? null, errors: result.errors })}\n`);
    process.exit(result.exitCode);
    return;
  }
  process.stdout.write(
    `${JSON.stringify({
      state: result.state,
      executionIssue: result.executionIssue,
      unitId: result.unitId,
      commentId: result.commentId,
      commentUrl: result.commentUrl,
      dependsOn: result.dependsOn,
    })}\n`,
  );
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("correct-unit-dependency.mjs")) {
  main();
}
