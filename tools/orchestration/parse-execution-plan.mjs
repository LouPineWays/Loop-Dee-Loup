#!/usr/bin/env node
// Deterministic parser for a #294-shaped multi-unit execution plan — worker unit 294-B
// under control Issue #306. Given an execution-Issue number, this fetches that Issue's own
// comments (one GitHub read: `gh api repos/OWNER/REPO/issues/<N>/comments`), locates the
// latest `## Execution Plan Index (v1)` comment, resolves its referenced
// `## Shared Contract (v1)` comment and every referenced `## Worker Unit: <ID> (v1)`
// comment, and prints one structured JSON object describing the whole plan.
//
// Durable artifact conventions parsed here (authoritative source: this Issue's own
// `## Shared Contract (v1)` comment, id 5550652308 on #294) — heading strings and bullet
// field names must match that comment character-for-character:
//   - Plan Index comment: heading `## Execution Plan Index (v1)`, bullets `- **Plan
//     state:**`, `- **Parent execution issue:**`, `- **Shared contract:**` (URL),
//     `- **Units:**` (one indented sub-line per unit: `- <UnitID>: <state> — <outcome>
//     (<comment URL>)`), `- **Dependencies:**`, `- **Dispatch manifest:**`,
//     `- **Integration/PR route:**`.
//   - Shared Contract comment: heading `## Shared Contract (v1)`.
//   - Worker Unit Contract comment: heading `## Worker Unit: <UnitID> (v1)`, with exactly
//     the bold-label bullets enumerated in WORKER_UNIT_FIELDS below, in that order.
//
// Mirrors tools/orchestration/ready-dispatch-gate.mjs's structural pattern: a single-
// purpose GitHub read, deterministic bullet/heading parsing (no LLM judgment), JSON on
// stdout, and reuse of that file's `resolveRepoIdentity` for repository-identity
// resolution (never a hand-typed --repo on the normal path).
//
// "Latest" Plan Index comment (worker unit 294-B's own escalation condition): the Plan
// Index comment is refreshed in place by a Route/Prepare-stage session or the
// Integration/PR worker (per the Shared Contract's edit-ownership rule), so in the normal
// case at most one comment on the Issue ever carries the `## Execution Plan Index (v1)`
// heading. If more than one comment carries that heading (e.g. a stale duplicate from a
// broken post), GitHub comment `id`s are a reliable, monotonically increasing proxy for
// creation order regardless of later edits, so the comment with the numerically highest
// `id` is treated as "latest" — a deterministic tie-break, not a guess. This is not the
// kind of API ambiguity 294-B's contract's escalation condition (REPLAN_REQUIRED) is
// about: that condition is for a case where the comments API genuinely cannot distinguish
// which comment is current in a way consistent with 294-A's documentation of the
// refresh-in-place model, which `id`-ordering does not run into.
//
// Never silently skips a referenced-but-missing/malformed comment: every such condition is
// collected into an `errors` array and reported with a non-zero exit, rather than omitting
// the affected unit from the output.
//
// Exit codes:
//   0 — success. Full plan JSON on stdout: { ok: true, repo, executionIssue, plan }.
//   1 — operational error: missing --execution-issue, repository identity could not be
//       resolved, or the `gh api` call itself failed (issue not found, network, etc.).
//       Message on stderr; nothing was fetched, so there is no plan JSON to print.
//   2 — the plan itself is missing or malformed: no Plan Index comment found, the Plan
//       Index's Shared Contract reference is missing/unresolvable/mismatched, a Units-list
//       entry's comment can't be found, or a referenced Worker Unit comment's heading is
//       malformed or names the wrong unit. JSON on stdout: { ok: false, repo,
//       executionIssue, errors: [...] } — every problem found, not just the first.
//
// Usage (normal path — repository identity derived from the checkout's own origin remote):
//   node tools/orchestration/parse-execution-plan.mjs --execution-issue 294
//
// Usage (explicit override — tests/exceptional invocation only):
//   node tools/orchestration/parse-execution-plan.mjs --repo OWNER/REPO --execution-issue 294
//
// Tests: node --test tools/orchestration/parse-execution-plan.test.mjs

import { execFileSync } from "node:child_process";
import { resolveRepoIdentity } from "./ready-dispatch-gate.mjs";

const PLAN_INDEX_HEADING = /^## Execution Plan Index \(v1\)$/;
const SHARED_CONTRACT_HEADING = /^## Shared Contract \(v1\)$/;
const WORKER_UNIT_HEADING = /^## Worker Unit: (\S+) \(v1\)$/;

// The Worker Unit Contract comment's required bold-label bullets, in the order the Shared
// Contract fixes them. `key` is the camelCase field name used in this script's JSON output.
export const WORKER_UNIT_FIELDS = [
  ["Unit ID", "unitId"],
  ["Parent execution issue", "parentExecutionIssue"],
  ["Required bounded outcome", "requiredBoundedOutcome"],
  ["Applicable role/capability", "applicableRoleCapability"],
  ["Authority/input pointers", "authorityInputPointers"],
  ["Relevant shared-contract pointer", "relevantSharedContractPointer"],
  ["Prerequisites/dependencies", "prerequisitesDependencies"],
  ["Files/surfaces expected to change", "filesSurfacesExpectedToChange"],
  ["Observable completion condition", "observableCompletionCondition"],
  ["Verification required", "verificationRequired"],
  ["Durable output/state expected", "durableOutputStateExpected"],
  ["Interrupt/escalation conditions", "interruptEscalationConditions"],
  ["State", "state"],
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pure. Every comment whose body contains a line matching `headingRegex` exactly (after
// trimming). Comments are the unit of authoritative durable state in this plan, so a
// heading is only recognized on its own line — never merely mentioned in prose.
export function findHeadingComments(comments, headingRegex) {
  return (comments ?? []).filter((c) => (c.body ?? "").split("\n").some((line) => headingRegex.test(line.trim())));
}

// Pure. Deterministic "latest" tie-break among same-heading comments — see the module
// comment above for why numerically-highest `id` is the correct, non-guessing choice.
export function pickLatestComment(matchingComments) {
  if (!matchingComments || matchingComments.length === 0) return null;
  return matchingComments.reduce((latest, c) => (Number(c.id) > Number(latest.id) ? c : latest), matchingComments[0]);
}

// Pure. Reads one "- **Label:** value" bullet's full value out of `body`, including any
// wrapped continuation lines that belong to the same list item (real Worker Unit Contract
// comments wrap long prose fields across several lines, each continuation line indented
// under the bullet — see #294 comment 5550652642's "Required bounded outcome" field).
// Continuation collection stops at the next unindented "- " bullet, a "## " heading, or
// end of body. Soft line-wraps are collapsed to single spaces, matching how the wrapped
// text reads as one continuous value. Returns null when the label's bullet is absent. When
// a label appears more than once, the last occurrence wins (mirrors
// ready-dispatch-gate.mjs's parseControlBullet precedent).
export function parseBulletBlock(body, label) {
  const lines = (body ?? "").split("\n");
  const labelPattern = new RegExp(`^-\\s*\\*\\*${escapeRegExp(label)}:\\*\\*\\s*(.*)$`, "i");
  let startIdx = -1;
  let firstRest = "";
  for (let i = 0; i < lines.length; i++) {
    const m = labelPattern.exec(lines[i]);
    if (m) {
      startIdx = i;
      firstRest = m[1];
    }
  }
  if (startIdx === -1) return null;

  const collected = [firstRest];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^-\s/.test(line)) break; // a new unindented top-level bullet
    if (/^##\s/.test(line.trim())) break; // a new comment/section heading
    collected.push(line.trim());
  }
  return collected
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// Pure. Extracts the sub-list of raw text lines following the Plan Index's `- **Units:**`
// bullet, one entry per unit (each an indented `- <UnitID>: <state> — <outcome> (<url>)`
// line). Distinct from parseBulletBlock because these sub-lines must stay separate items,
// not be merged into one collapsed string. Stops at the next unindented top-level bullet,
// a "## " heading, or end of body. Returns null when no `- **Units:**` bullet is found at
// all (distinct from an empty array, which would mean the bullet exists but lists no
// units).
export function parseUnitsBlock(body) {
  const lines = (body ?? "").split("\n");
  const labelPattern = /^-\s*\*\*Units:\*\*\s*(.*)$/i;
  let startIdx = -1;
  let firstRest = "";
  for (let i = 0; i < lines.length; i++) {
    const m = labelPattern.exec(lines[i]);
    if (m) {
      startIdx = i;
      firstRest = m[1];
    }
  }
  if (startIdx === -1) return null;

  const items = [];
  if (firstRest.trim()) items.push(firstRest.trim());
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^-\s/.test(line)) break; // a new unindented top-level bullet ends the Units block
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^##\s/.test(trimmed)) break;
    items.push(trimmed);
  }
  return items;
}

const UNIT_LIST_ITEM = /^-\s*([^\s:]+):\s*([A-Z_]+)\s*(?:—|-)\s*(.*?)\s*\((\S+)\)\s*$/;

// Pure. Parses one `- <UnitID>: <state> — <one-line outcome> (<comment URL>)` line from the
// Plan Index's Units list. Returns null for a line that doesn't match this shape at all —
// callers treat that as an explicit parse error, never a silently-skipped unit.
export function parseUnitListItem(line) {
  const m = UNIT_LIST_ITEM.exec((line ?? "").trim());
  if (!m) return null;
  return { unitId: m[1], state: m[2], outcome: m[3].trim(), url: m[4] };
}

// Pure. Extracts the numeric comment id from a GitHub comment permalink
// (".../issues/294#issuecomment-5550652746"). Returns null for anything else, rather than
// guessing.
export function extractCommentIdFromUrl(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/#issuecomment-(\d+)/);
  return m ? Number(m[1]) : null;
}

// Pure.
export function findCommentById(comments, id) {
  if (id == null) return null;
  return (comments ?? []).find((c) => Number(c.id) === Number(id)) ?? null;
}

// Pure. The whole plan-parsing core: given every comment on the execution Issue, locates
// and cross-validates the Plan Index, Shared Contract, and every referenced Worker Unit
// comment. Exported separately from the `gh` call so tests exercise it without touching
// the network (matching this repository's existing gate-script convention). Returns
// { ok: true, plan } or { ok: false, errors } — errors accumulate every problem found
// across the whole plan rather than stopping at the first, since a referenced comment that
// can't be resolved must never be silently dropped from the report.
export function parseExecutionPlan(comments, { executionIssue } = {}) {
  const errors = [];
  const allComments = comments ?? [];

  const planIndexMatches = findHeadingComments(allComments, PLAN_INDEX_HEADING);
  if (planIndexMatches.length === 0) {
    return {
      ok: false,
      errors: [`no comment with heading "## Execution Plan Index (v1)" was found on issue #${executionIssue}`],
    };
  }
  const planIndexComment = pickLatestComment(planIndexMatches);

  const planState = parseBulletBlock(planIndexComment.body, "Plan state");
  const parentExecutionIssue = parseBulletBlock(planIndexComment.body, "Parent execution issue");
  const sharedContractUrl = parseBulletBlock(planIndexComment.body, "Shared contract");
  const dependencies = parseBulletBlock(planIndexComment.body, "Dependencies");
  const dispatchManifest = parseBulletBlock(planIndexComment.body, "Dispatch manifest");
  const integrationRoute = parseBulletBlock(planIndexComment.body, "Integration/PR route");
  const unitLines = parseUnitsBlock(planIndexComment.body);

  if (!sharedContractUrl) {
    errors.push(
      'the Execution Plan Index comment has no "- **Shared contract:**" bullet referencing the Shared Contract comment',
    );
  }

  let sharedContract = null;
  if (sharedContractUrl) {
    const sharedContractId = extractCommentIdFromUrl(sharedContractUrl);
    const sharedContractComment = findCommentById(allComments, sharedContractId);
    if (!sharedContractComment) {
      errors.push(
        `the Shared Contract comment referenced by the Plan Index (${sharedContractUrl}) could not be found among issue #${executionIssue}'s comments`,
      );
    } else {
      const hasHeading = (sharedContractComment.body ?? "")
        .split("\n")
        .some((line) => SHARED_CONTRACT_HEADING.test(line.trim()));
      if (!hasHeading) {
        errors.push(
          `the comment referenced as the Shared Contract (${sharedContractUrl}) does not have the required "## Shared Contract (v1)" heading`,
        );
      } else {
        sharedContract = { commentId: sharedContractComment.id, url: sharedContractUrl };
      }
    }
  }

  if (unitLines === null) {
    errors.push('the Execution Plan Index comment has no "- **Units:**" bullet listing worker units');
  }

  const units = {};
  for (const line of unitLines ?? []) {
    const parsed = parseUnitListItem(line);
    if (!parsed) {
      errors.push(`could not parse a unit entry in the Plan Index "Units" list: "${line}"`);
      continue;
    }
    const { unitId, state: indexState, outcome: indexOutcome, url } = parsed;
    const unitCommentId = extractCommentIdFromUrl(url);
    const unitComment = findCommentById(allComments, unitCommentId);
    if (!unitComment) {
      errors.push(
        `the Worker Unit comment for ${unitId} referenced by the Plan Index (${url}) could not be found among issue #${executionIssue}'s comments`,
      );
      continue;
    }

    const headingLine = (unitComment.body ?? "").split("\n").map((l) => l.trim()).find((l) => l.startsWith("## "));
    const headingMatch = headingLine ? WORKER_UNIT_HEADING.exec(headingLine) : null;
    if (!headingMatch) {
      errors.push(
        `the comment referenced for unit ${unitId} (${url}) does not have a valid "## Worker Unit: <ID> (v1)" heading (found: ${JSON.stringify(headingLine ?? null)})`,
      );
      continue;
    }
    const headingUnitId = headingMatch[1];
    if (headingUnitId !== unitId) {
      errors.push(
        `the Worker Unit comment at ${url} declares unit "${headingUnitId}" in its heading, but the Plan Index Units list names it "${unitId}"`,
      );
      continue;
    }

    const fields = {};
    for (const [label, key] of WORKER_UNIT_FIELDS) {
      fields[key] = parseBulletBlock(unitComment.body, label);
    }

    units[unitId] = {
      commentId: unitComment.id,
      url,
      indexState,
      indexOutcome,
      ...fields,
    };
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    plan: {
      planIndex: {
        commentId: planIndexComment.id,
        url: planIndexComment.html_url ?? null,
        planState,
        parentExecutionIssue,
        sharedContractUrl,
        dependencies,
        dispatchManifest,
        integrationRoute,
      },
      sharedContract,
      units,
    },
  };
}

// `gh api --paginate` prints one JSON document per page, not one combined document —
// --slurp wraps them in an outer array, which this flattens into one flat array of raw
// comment objects. Self-contained (not imported from tools/review-watch/poll.mjs, which
// has the same shape) because tools/orchestration and tools/review-watch are separate
// consumer-distributed units that should not depend on each other's internals.
function defaultGhCommentsFetch({ repo, number }) {
  const raw = execFileSync("gh", ["api", `repos/${repo}/issues/${number}/comments`, "--paginate", "--slurp"], {
    encoding: "utf8",
  });
  return JSON.parse(raw).flat();
}

// `ghCommentsImpl` and `resolveRepoIdentityImpl` are injected so tests can drive this
// end-to-end without touching the real network, `gh` CLI, or `git` binary.
export async function runParseExecutionPlan(
  { repo, executionIssue },
  { ghCommentsImpl = defaultGhCommentsFetch, resolveRepoIdentityImpl = resolveRepoIdentity } = {},
) {
  if (!executionIssue) {
    return { exitCode: 1, message: "Missing required arg: --execution-issue is required." };
  }

  let resolvedRepo = repo;
  if (!resolvedRepo) {
    const identity = resolveRepoIdentityImpl();
    if (!identity.ok) {
      return {
        exitCode: 1,
        message: `Could not determine the current repository identity (--repo was not supplied): ${identity.reason}`,
      };
    }
    resolvedRepo = identity.repo;
  }

  let comments;
  try {
    comments = await ghCommentsImpl({ repo: resolvedRepo, number: executionIssue });
  } catch (err) {
    return {
      exitCode: 1,
      message: `gh api call failed for ${resolvedRepo} issue #${executionIssue} comments: ${err.message}`,
    };
  }

  const result = parseExecutionPlan(comments, { executionIssue: Number(executionIssue) });
  if (!result.ok) {
    return {
      exitCode: 2,
      ok: false,
      repo: resolvedRepo,
      executionIssue: Number(executionIssue),
      errors: result.errors,
    };
  }

  return {
    exitCode: 0,
    ok: true,
    repo: resolvedRepo,
    executionIssue: Number(executionIssue),
    plan: result.plan,
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runParseExecutionPlan({ repo: args.repo, executionIssue: args["execution-issue"] });
  if (result.exitCode === 1) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  const { exitCode, ...rest } = result;
  console.log(JSON.stringify(rest));
  process.exit(exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("parse-execution-plan.mjs")) {
  main();
}
