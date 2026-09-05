#!/usr/bin/env node
// Deterministic capability->route table + Dispatch Manifest persistence — worker unit
// 294-C under control Issue #306 / execution Issue #294.
//
// Consumes 294-B's shipped `parse-execution-plan.mjs` output (imported directly, not
// reimplemented) and, for every unit in the plan, resolves a route using a small, fixed,
// deterministic table rather than any per-unit judgment:
//
//   1. If the unit's own "Files/surfaces expected to change" field, once trimmed, consists of
//      EXACTLY one backtick-quoted path to an existing, non-test script file (checked against
//      the real filesystem) immediately followed by the fixed annotation
//      "(invoked, not modified)" and nothing else (`extractSoleInvokedNotModifiedPath`), AND
//      that same script is NOT also named inside this same unit's own "Required bounded
//      outcome" field -- i.e. an existing mechanism this unit merely invokes, not the thing
//      this unit itself is building or changing, and the unit's ENTIRE Files/surfaces field
//      is that one invocation, nothing more -- the route is that script itself: running it,
//      not dispatching a reasoning worker, satisfies the unit. The annotation is required,
//      not merely existence-on-disk plus absence from "Required bounded outcome": that weaker
//      pair of signals is not by itself proof of non-modification -- a valid contract whose
//      outcome describes the same file without literally repeating its exact backtick path (a
//      paraphrase, no filename quoted) would otherwise be silently short-circuited to "just
//      run the pre-change file" when its real job is to modify it (Stage 1 review finding on
//      PR #401, issue #400's correction). "Files/surfaces expected to change" is, by its own
//      field name, a list of files that DO change; a script can only correctly land in this
//      route when the unit's own contract explicitly, truthfully asserts the opposite for
//      that one entry. The whole-field anchor is independently necessary, not merely the
//      annotation: an annotated script sitting alongside a genuinely separate deliverable
//      would otherwise still wrongly satisfy the whole unit by invoking only the safe entry,
//      silently leaving the other named surface's real work undone (Stage 2 audit #402), and
//      that same defect resurfaces if the second surface is unquoted plain text rather than a
//      second backtick span (Stage 1 review finding on PR #403) -- see
//      `extractSoleInvokedNotModifiedPath`'s own comment for the full defect/fix history. A
//      script the unit's own "Required bounded outcome" names as its deliverable is still
//      never routed this way even when the field otherwise matches, as defense in depth; see
//      `isUnitsOwnDeliverable` below.
//   2. Else, if the unit's "Applicable role/capability" field names a skill or persona that
//      actually exists under `.claude/skills/` or `.claude/personas/`, the route is that
//      skill/persona.
//   3. Else, the unit's own recorded capability-class label (parsed from "Applicable
//      role/capability") is looked up in the fixed CAPABILITY_CLASS_ROUTE_TABLE below
//      (mirroring this Issue's "## Shared Contract (v1)" comment's "Route-relevant
//      capability classes" section) and mapped to one of exactly two generic worker
//      labels: "bounded implementation worker" or "stronger/general worker".
//   4. If none of the above resolves — no matching script, no matching skill/persona, and
//      the capability-class label isn't in the fixed table — routing would require real
//      per-unit judgment, which this unit's own contract's escalation condition forbids
//      guessing at. The unit is marked route="REPLAN_REQUIRED" instead.
//
// Priority order (1) before (3) is deliberate and takes precedence over the looser
// "routes per its own recorded capability class" phrasing elsewhere in this plan: a unit
// whose "Files/surfaces expected to change" names an existing, on-disk script that is a
// pre-existing mechanism this unit merely invokes (not its own deliverable) is better
// satisfied by naming that script than by re-deriving a generic worker label from its
// capability class, and the "Required bounded outcome" field's own ordered parenthetical
// (script, then skill/persona, then capability-class fallback) is this unit's authoritative
// spec for the table's shape. A script the unit's own "Required bounded outcome" names as
// what this unit itself must produce/change is excluded from step (1) precisely because
// running its pre-change contents cannot satisfy a unit whose job is to change it -- see
// `isUnitsOwnDeliverable`.
//
// Independently, dispatch_ready is computed from the unit's own "Prerequisites/
// dependencies" field: a DONE unit is always dispatch_ready (moot); an unresolved-route
// (REPLAN_REQUIRED) unit is never dispatch_ready (its route isn't known); otherwise a unit
// is dispatch_ready only when every unit ID named after "depends on" in its prerequisites
// text is itself in state DONE in the parsed plan.
//
// Usage (normal path — repository identity derived from the checkout's own origin remote,
// same as parse-execution-plan.mjs):
//   node tools/orchestration/prepare-dispatch-manifest.mjs --execution-issue 294
// prints the composed "## Dispatch Manifest (v1)" markdown body to stdout.
//
// To actually persist it as a comment (PATCH an existing Dispatch Manifest comment, or
// POST a new one) --comment-id/--create write the body to a temp file first and invoke
// `gh api ... -F body=@<tempfile>` — never `-f body=@<file>`, which does not expand `@file`
// and silently corrupted two comments on issue #294 earlier in this plan's own history:
//   node tools/orchestration/prepare-dispatch-manifest.mjs --execution-issue 294 --comment-id 5550677338
//   node tools/orchestration/prepare-dispatch-manifest.mjs --execution-issue 294 --create
//
// Tests: node --test tools/orchestration/prepare-dispatch-manifest.test.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runParseExecutionPlan } from "./parse-execution-plan.mjs";

const REPO_ROOT = path.resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SCRIPT_EXTENSIONS = [".mjs", ".js", ".cjs", ".py", ".sh", ".ps1"];

// The fixed capability-class -> generic-worker-label table, mirroring this plan's
// "## Shared Contract (v1)" comment's "Route-relevant capability classes" section
// character-for-character on the class labels. The two generic labels also map to
// themselves so a capability field that already states the final label verbatim (as
// worker unit 294-D's does: "stronger/general worker - judgment-heavy (...)") resolves
// without needing a synonym lookup.
export const CAPABILITY_CLASS_ROUTE_TABLE = {
  "bounded coding worker": "bounded implementation worker",
  "doc-authority worker": "stronger/general worker",
  "integration worker": "stronger/general worker",
  "bounded implementation worker": "bounded implementation worker",
  "stronger/general worker": "stronger/general worker",
};

// Pure. Every backtick code span in `text`, in order.
export function extractCodeSpans(text) {
  const spans = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(text ?? "")) !== null) spans.push(m[1]);
  return spans;
}

// Pure (given an injected `fileExists`). The first code span in `filesSurfacesField` that
// looks like a path to an existing, non-test script file — i.e. contains "/", ends with a
// known script extension, is not itself a "*.test.<ext>" companion (a test file is
// verification, not the unit's own deliverable route), and actually exists on disk per
// `fileExists`. Returns null when no such span is found — never guesses at a partial or
// near-miss path.
export function findExistingScriptPath(filesSurfacesField, { fileExists }) {
  for (const span of extractCodeSpans(filesSurfacesField)) {
    if (!span.includes("/")) continue;
    if (!SCRIPT_EXTENSIONS.some((ext) => span.endsWith(ext))) continue;
    if (/\.test\.[a-zA-Z0-9]+$/.test(span)) continue;
    if (fileExists(span)) return span;
  }
  return null;
}

// Anchors the ENTIRE "Files/surfaces expected to change" field (once trimmed) to be exactly
// one backtick-quoted path followed by the fixed "(invoked, not modified)" phrase and nothing
// else (an optional trailing period is the only thing allowed after it). See
// `extractSoleInvokedNotModifiedPath` below for why the whole field must be anchored rather
// than merely checking the phrase appears somewhere near the path.
const SOLE_INVOKED_NOT_MODIFIED_FIELD = /^`([^`]+)`\s*\(invoked, not modified\)\.?$/;

// Pure. Returns the quoted path when `filesSurfacesField` (once trimmed) consists of EXACTLY
// one backtick-quoted path immediately followed by the fixed "(invoked, not modified)"
// phrase and nothing else -- null for anything else at all: a second surface (quoted or
// plain text), the script mentioned twice, surrounding prose, an unrelated inline code span,
// or the annotation missing/misplaced. This single whole-field anchor replaces two earlier,
// narrower checks (an annotation-adjacency regex, and a separate code-span count) that each
// had their own real gap found on independent review:
//   - Checking only that the annotation sits next to ITS OWN script (the original PR #401
//     fix) said nothing about whether the field ALSO named a second, genuine surface
//     elsewhere -- a unit whose Files/surfaces listed an annotated pre-existing script
//     alongside a separate real deliverable (e.g. "`gate.mjs` (invoked, not modified),
//     `new-feature.mjs` (new)") was still wrongly routed to "just run the gate script",
//     silently leaving the deliverable unimplemented (Stage 2 audit #402).
//   - Counting backtick code spans (`isOnlySurfaceNamed`, this correction's own first
//     attempt) undercounted a second surface named in PLAIN, unquoted text (Codex's own
//     `docs/new-guide.md` example) -- the parser does not require backtick-quoting for this
//     field, so an unquoted second surface was invisible to a spans.length check entirely --
//     and separately OVERcounted a genuinely single-surface field that happened to mention
//     the same path twice, or an unrelated inline code span (e.g. a CLI flag name) in its own
//     explanatory prose, needlessly declining a safe deterministic route (Stage 1 review
//     finding on PR #403).
// Anchoring the WHOLE field to this one minimal, exact shape closes both gaps at once and
// admits no further per-token heuristic to get wrong: anything beyond the bare minimal
// assertion -- correct or not, quoted or not, duplicate or not -- simply does not match, and
// the unit falls through to a reasoning-worker route instead of being guessed at. This is a
// deliberate precision trade-off, not an oversight: a unit whose contract explains itself in
// extra prose around the annotation, or explains it twice, no longer gets the deterministic
// route even when a human reader would consider it obviously safe -- accepted because the
// cost of a needless reasoning-worker dispatch is far smaller than the cost of another
// per-token exception this file's own history shows is easy to get wrong again.
export function extractSoleInvokedNotModifiedPath(filesSurfacesField) {
  const text = (filesSurfacesField ?? "").trim();
  const m = SOLE_INVOKED_NOT_MODIFIED_FIELD.exec(text);
  return m ? m[1] : null;
}

// Pure. True when `scriptPath` also appears as a code span inside `requiredBoundedOutcomeField`
// -- i.e. this unit's own "Required bounded outcome" names that same file as part of what this
// unit itself must produce/change, not merely invoke. A unit that is building or modifying a
// script is not satisfied by running that script's pre-change (or not-yet-existing) contents.
export function isUnitsOwnDeliverable(scriptPath, requiredBoundedOutcomeField) {
  return extractCodeSpans(requiredBoundedOutcomeField).includes(scriptPath);
}

// Pure. True when `haystack` (already lower-cased) contains `name` as a whole lowercase
// token/substring match — a simple, deterministic containment check, not fuzzy matching.
function containsName(haystackLower, name) {
  return haystackLower.includes(name.toLowerCase());
}

// Pure (given injected `skillNames`/`personaNames`). The first skill or persona name that
// appears in `capabilityField`'s text, checked skills-first then personas, in the order
// each list is given. Returns null when none match.
export function findSkillOrPersonaMatch(capabilityField, { skillNames = [], personaNames = [] } = {}) {
  const haystack = (capabilityField ?? "").toLowerCase();
  for (const name of skillNames) {
    if (containsName(haystack, name)) return { type: "skill", name };
  }
  for (const name of personaNames) {
    if (containsName(haystack, name)) return { type: "persona", name };
  }
  return null;
}

// Pure. Extracts the recorded capability-class label from an "Applicable role/capability"
// field, e.g. "bounded coding worker (see Shared Contract)." -> "bounded coding worker", or
// "stronger/general worker — judgment-heavy (...)." -> "stronger/general worker". Strips a
// trailing "(see Shared Contract)" parenthetical -- WITHOUT also consuming a following
// period, so that period (when present) survives as a genuine sentence-boundary marker.
//
// Sentence-boundary truncation (a period followed by whitespace) is applied BEFORE the
// dash-truncation step, but ONLY when the "(see Shared Contract)" marker was actually
// present in the field -- that marker's own recovered trailing period is the one genuine,
// reliably-positioned class-label boundary this step exists to restore (e.g. 294-C's real
// field: "bounded coding worker (see Shared Contract). Kept as one unit deliberately — a
// parallel-negative-control decision: ...", whose own explanatory prose carries an unrelated
// dash that must never be mistaken for the label/trailing-detail separator the dash-match
// step is meant to catch). Gating on the marker's presence -- rather than truncating at the
// first "X. " found anywhere, unconditionally -- matters because a marker-less field's first
// period+space is not reliably a class-label boundary at all: a Stage 1 review finding on
// this correction (issue #396's own correction PR) showed a field like "stronger/general
// worker (e.g. architecture review) — judgment-heavy." has its first ". " inside an "e.g."
// abbreviation that precedes the field's real dash separator, so an unconditional
// sentence-truncation step would cut the label short before ever reaching that dash. Fields
// without the marker fall through to the pre-existing dash-only truncation unchanged, exactly
// as before this fix.
//
// Finally truncates at the first " — " / " - " em/en-dash-style separator, then trims a
// trailing period. Returns null for an empty/absent field.
export function extractCapabilityClassLabel(capabilityField) {
  const text = (capabilityField ?? "").trim();
  if (!text) return null;
  const hasSharedContractMarker = /\(see Shared Contract\)/i.test(text);
  let stripped = text.replace(/\(see Shared Contract\)/i, "").trim();
  if (hasSharedContractMarker) {
    const sentenceMatch = stripped.match(/\.\s/);
    if (sentenceMatch) stripped = stripped.slice(0, sentenceMatch.index).trim();
  }
  const dashMatch = stripped.match(/\s[—-]\s/);
  if (dashMatch) stripped = stripped.slice(0, dashMatch.index).trim();
  stripped = stripped.replace(/\.$/, "").trim();
  return stripped || null;
}

// Pure. Resolves one unit's route per the three-step table + REPLAN_REQUIRED fallback
// described in the module comment above. Returns
// { route, isReplanRequired, reason } — `reason` is populated only for the
// REPLAN_REQUIRED case (why routing could not resolve deterministically).
export function resolveUnitRoute(unit, { fileExists, skillNames = [], personaNames = [] } = {}) {
  const scriptPath = findExistingScriptPath(unit?.filesSurfacesExpectedToChange, { fileExists });
  if (
    scriptPath &&
    extractSoleInvokedNotModifiedPath(unit?.filesSurfacesExpectedToChange) === scriptPath &&
    !isUnitsOwnDeliverable(scriptPath, unit?.requiredBoundedOutcome)
  ) {
    return { route: `deterministic script: ${scriptPath}`, isReplanRequired: false, reason: null };
  }

  const skillOrPersona = findSkillOrPersonaMatch(unit?.applicableRoleCapability, { skillNames, personaNames });
  if (skillOrPersona) {
    return { route: `${skillOrPersona.type}: ${skillOrPersona.name}`, isReplanRequired: false, reason: null };
  }

  const classLabel = extractCapabilityClassLabel(unit?.applicableRoleCapability);
  const mapped = classLabel ? CAPABILITY_CLASS_ROUTE_TABLE[classLabel.toLowerCase()] : undefined;
  if (mapped) {
    return { route: mapped, isReplanRequired: false, reason: null };
  }

  return {
    route: "REPLAN_REQUIRED",
    isReplanRequired: true,
    reason: `capability class ${JSON.stringify(classLabel)} parsed from "Applicable role/capability" ` +
      `does not resolve via the fixed script/skill/persona/capability-class table -- routing this ` +
      `unit would require real per-unit judgment rather than a deterministic lookup`,
  };
}

const DEPENDS_ON_CLAUSE = /depends on\s+(.*?)(?:\.\s|\.$|\bindependent\b|$)/is;
const UNIT_ID_TOKEN = /\d+-[A-Za-z]+/g;
const UNIT_ID_TOKEN_EXISTS = /\d+-[A-Za-z]+/;
// A unit-ID mention inside one of these clauses is an explicit non-dependency mention this
// plan's own established prose vocabulary already uses (every real "no dependency" Worker
// Unit Contract field in this plan reads "none. Parallel with <ID>." and a genuine
// dependency field excludes a sibling with "Independent of <ID>.") -- neither is
// "unrecognized" wording.
const EXCLUDED_MENTION_CLAUSE = /\b(?:independent of|parallel with)\s+[^.]*\.?/gi;

// Pure. A unit's own "State" field is DONE when it *starts with* the literal word "DONE"
// -- real Worker Unit Contract comments append a one-line completion note and commit range
// after the state word (e.g. "DONE -- implemented and verified; commits 192af18..."), per
// AGENTS.md's own "update this comment's own State field to DONE with a one-line note"
// convention, so an exact `state === "DONE"` equality check would wrongly treat every real
// completed unit as not-done. Any other State value (PLANNED, ROUTED, IN_PROGRESS, BLOCKED,
// REPLAN_REQUIRED, or a state carrying one of those as its own prefix) is not DONE.
export function isDoneState(state) {
  return typeof state === "string" && /^DONE\b/.test(state.trim());
}

// Pure. Extracts the list of unit IDs a unit's own "Prerequisites/dependencies" field
// names as genuine dependencies -- only unit IDs appearing inside a "depends on ..."
// clause, stopping at the first following period or the word "independent" (so a trailing
// "Independent of 294-X" clause in the same field is correctly excluded, per real fields
// like 294-C's "depends on 294-B (imports its parser). Independent of 294-A."). Returns an
// empty array when no "depends on" clause is present at all (e.g. "none. Parallel with
// 294-B.") -- a mention elsewhere in the field is never treated as a dependency.
export function extractDependencyUnitIds(prerequisitesField) {
  const text = prerequisitesField ?? "";
  const match = DEPENDS_ON_CLAUSE.exec(text);
  if (!match) return [];
  return [...match[1].matchAll(UNIT_ID_TOKEN)].map((m) => m[0]);
}

// Pure. True when `prerequisitesField` names a unit-ID-shaped token that this file's own
// "depends on ..." grammar does not capture and that is not explicitly excluded by an
// "independent of ..." clause -- i.e. prose this parser cannot deterministically resolve
// into a dependency list. Recognized-but-empty fields (e.g. "none.", "Parallel with 294-B.")
// return false here; only a field naming a unit ID this parser fails to recognize as a
// dependency clause is unrecognized.
export function hasUnrecognizedDependencyWording(prerequisitesField) {
  const text = prerequisitesField ?? "";
  if (!text.trim()) return false;

  let remaining = text;
  const dependsMatch = DEPENDS_ON_CLAUSE.exec(text);
  if (dependsMatch) {
    remaining = remaining.slice(0, dependsMatch.index) + remaining.slice(dependsMatch.index + dependsMatch[0].length);
  }
  remaining = remaining.replace(EXCLUDED_MENTION_CLAUSE, "");

  return UNIT_ID_TOKEN_EXISTS.test(remaining);
}

// Pure. Computes whether `unit` is currently dispatch-ready: always true (trivially) once
// the unit's own State is DONE; otherwise true only when every unit ID its own
// "Prerequisites/dependencies" field names after "depends on" is itself in state DONE in
// `unitsById`. A referenced dependency unit ID that is not present in `unitsById` at all is
// treated as not-ready (an unresolved reference is not evidence of readiness). A field with
// no recognized "depends on" clause but that still names an unrecognized unit-ID-shaped
// token (e.g. "Blocked by 294-A", "Requires 294-A") fails closed -- it is never silently
// treated as "no dependencies" -- and is reported with `unrecognized: true`.
export function computeDispatchReady(unit, unitsById) {
  if (isDoneState(unit.state)) {
    return { ready: true, dependencies: [], notDone: [] };
  }
  const dependencies = extractDependencyUnitIds(unit.prerequisitesDependencies);
  if (dependencies.length === 0) {
    if (hasUnrecognizedDependencyWording(unit.prerequisitesDependencies)) {
      return { ready: false, dependencies: [], notDone: [], unrecognized: true };
    }
    return { ready: true, dependencies, notDone: [] };
  }
  const notDone = dependencies.filter((depId) => !isDoneState(unitsById[depId]?.state));
  return { ready: notDone.length === 0, dependencies, notDone };
}

// Pure. The note field for one manifest line: an escalation reason when routing failed,
// otherwise a short deterministic description of why the unit is (or isn't) dispatch-ready.
export function buildNote({ unit, routeResult, readiness }) {
  if (routeResult.isReplanRequired) return routeResult.reason;
  if (isDoneState(unit.state)) return "DONE";
  if (readiness.unrecognized) {
    return `unrecognized prerequisites wording: ${JSON.stringify(unit.prerequisitesDependencies ?? "")} -- needs a recognized "depends on" clause or replan`;
  }
  if (readiness.ready) {
    return readiness.dependencies.length === 0
      ? "no prerequisites"
      : `prerequisites satisfied: ${readiness.dependencies.join(", ")}`;
  }
  return `blocked on: ${readiness.notDone.join(", ")} (not yet DONE)`;
}

// Pure. Builds one manifest entry (route/dispatch_ready/note) per unit in `plan.units`, in
// the same order the Plan Index's own Units list lists them (insertion order of
// `plan.units`, which parse-execution-plan.mjs builds while walking that list). Never
// silently drops a unit.
export function buildManifestEntries(plan, { fileExists, skillNames = [], personaNames = [] } = {}) {
  const unitsById = plan.units;
  const entries = [];
  for (const [unitId, unit] of Object.entries(unitsById)) {
    const routeResult = resolveUnitRoute(unit, { fileExists, skillNames, personaNames });
    const readiness = computeDispatchReady(unit, unitsById);
    const dispatchReady = routeResult.isReplanRequired ? false : readiness.ready;
    const note = buildNote({ unit, routeResult, readiness });
    entries.push({ unitId, route: routeResult.route, dispatchReady, note });
  }
  return entries;
}

// Pure. Renders the fixed "## Dispatch Manifest (v1)" comment body from `plan` and its
// resolved `entries`, matching this Issue's "## Shared Contract (v1)" comment's Dispatch
// Manifest heading/field spec character-for-character: heading, one "- **Plan index:**"
// bullet (URL), then one "- <UnitID>: route=<route> dispatch_ready=<bool> note=<note>" line
// per unit in `entries`' own order.
export function formatDispatchManifestBody(plan, entries) {
  const lines = ["## Dispatch Manifest (v1)", ""];
  lines.push(`- **Plan index:** ${plan.planIndex.url}`);
  for (const entry of entries) {
    lines.push(`- ${entry.unitId}: route=${entry.route} dispatch_ready=${entry.dispatchReady} note=${entry.note}`);
  }
  return `${lines.join("\n")}\n`;
}

function defaultFileExists(relPath) {
  return existsSync(path.join(REPO_ROOT, relPath));
}

function defaultDirNames(relDir) {
  try {
    return readdirSync(path.join(REPO_ROOT, relDir))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3));
  } catch {
    return [];
  }
}

function defaultPost({ repo, executionIssue, commentId, body }) {
  const tmpFile = path.join(tmpdir(), `dispatch-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(tmpFile, body, "utf8");
  try {
    if (commentId) {
      execFileSync("gh", ["api", `repos/${repo}/issues/comments/${commentId}`, "-X", "PATCH", "-F", `body=@${tmpFile}`], {
        encoding: "utf8",
      });
    } else {
      execFileSync("gh", ["api", `repos/${repo}/issues/${executionIssue}/comments`, "-X", "POST", "-F", `body=@${tmpFile}`], {
        encoding: "utf8",
      });
    }
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup only
    }
  }
}

// The whole prepare-dispatch-manifest core, wired for tests: every I/O dependency
// (plan-fetch, filesystem, comment-posting) is injectable, defaulting to the real `gh`
// CLI / real filesystem / real `.claude/skills`+`.claude/personas` listing in main().
export async function runPrepareDispatchManifest(
  { repo, executionIssue, commentId, create },
  {
    parseExecutionPlanImpl = runParseExecutionPlan,
    fileExists = defaultFileExists,
    skillNames = defaultDirNames(".claude/skills"),
    personaNames = defaultDirNames(".claude/personas"),
    postImpl = defaultPost,
  } = {},
) {
  const parsed = await parseExecutionPlanImpl({ repo, executionIssue });
  if (parsed.exitCode !== 0) {
    return parsed;
  }

  const entries = buildManifestEntries(parsed.plan, { fileExists, skillNames, personaNames });
  const body = formatDispatchManifestBody(parsed.plan, entries);

  if (commentId || create) {
    postImpl({ repo: parsed.repo, executionIssue: parsed.executionIssue, commentId, body });
  }

  return { exitCode: 0, ok: true, repo: parsed.repo, executionIssue: parsed.executionIssue, entries, body };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    if (a === "--create") {
      args.create = true;
      continue;
    }
    args[a.slice(2)] = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["execution-issue"]) {
    process.stderr.write("prepare-dispatch-manifest.mjs: --execution-issue is required.\n");
    process.exit(1);
    return;
  }
  const result = await runPrepareDispatchManifest({
    repo: args.repo,
    executionIssue: args["execution-issue"],
    commentId: args["comment-id"],
    create: Boolean(args.create),
  });
  if (result.exitCode === 1) {
    process.stderr.write(`${result.message}\n`);
    process.exit(1);
    return;
  }
  if (result.exitCode === 2) {
    process.stderr.write(`prepare-dispatch-manifest.mjs: plan could not be parsed:\n${result.errors.join("\n")}\n`);
    process.exit(2);
    return;
  }
  process.stdout.write(result.body);
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("prepare-dispatch-manifest.mjs")) {
  main();
}
