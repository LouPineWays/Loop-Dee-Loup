#!/usr/bin/env node
// Deterministic, field-scoped planning-correction writer for a Plan Index's
// "Integration/PR route" bullet -- issue #856 (Stage 1 finding on PR #857). A bare-`none` (or
// otherwise invalid) route makes ready-dispatch-gate.mjs return REPLAN_REQUIRED with
// replanRequiredUnitIds ["PLAN-INDEX"]; neither format-execution-plan.mjs (new plans only) nor
// correct-unit-dependency.mjs (unit dependency field only) can fix that field, so this is the
// one authorized in-place mutation path for it. It touches ONLY that one bullet on the Plan
// Index comment (every other line is copied through byte-for-byte), validates the replacement
// against the live plan (the same planLevelRouteFailure the gate and Route/Prepare use), and
// fails closed on a concurrent edit (exit 3) or an unverifiable write (exit 4).
//
// Usage:
//   node tools/orchestration/correct-plan-index-route.mjs --execution-issue <N> \
//     --route "integration worker" | "unit-owned: <UnitID>" | "no-pr: <reason>" [--repo OWNER/REPO]
//
// Exit codes: 0 ROUTE_CORRECTION_VERIFIED; 1 invalid input / operational failure (nothing
// written); 2 plan unparseable; 3 STALE_START_TOCTOU; 4 CORRECTION_UNVERIFIED.
//
// Tests: node --test tools/orchestration/correct-plan-index-route.test.mjs

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runParseExecutionPlan, parseBulletBlock, classifyIntegrationRoute, planLevelRouteFailure } from "./parse-execution-plan.mjs";
import { findBulletFieldSpan } from "./correct-unit-dependency.mjs";
import { resolveRepoIdentity } from "./ready-dispatch-gate.mjs";

const ROUTE_LABEL = "Integration/PR route";

// Pure. Validates the proposed route against a parsed plan by applying it to a copy and
// reusing the shared plan-level validator; a new route must also be a recognized kind.
export function validateRouteCorrection(plan, route) {
  const kind = classifyIntegrationRoute(route).kind;
  if (!["integration", "unit-owned", "no-pr"].includes(kind)) {
    return [`route ${JSON.stringify(route)} is not one of "integration worker", "unit-owned: <UnitID>", "no-pr: <reason>"`];
  }
  const failure = planLevelRouteFailure({ ...plan, planIndex: { ...plan.planIndex, integrationRoute: route.trim() } });
  return failure ? [failure] : [];
}

// Pure. Replaces exactly the Integration/PR route bullet span; all other lines are untouched.
export function replaceRouteField(rawBody, route) {
  const lines = (rawBody ?? "").split("\n");
  const span = findBulletFieldSpan(lines, ROUTE_LABEL);
  if (!span) return { ok: false, reason: `no "- **${ROUTE_LABEL}:**" bullet was found in the Plan Index comment` };
  const next = [...lines.slice(0, span.startIdx), `- **${ROUTE_LABEL}:** ${route.trim()}`, ...lines.slice(span.endIdx)];
  return { ok: true, body: next.join("\n") };
}

function defaultGetComment({ repo, commentId }) {
  return JSON.parse(execFileSync("gh", ["api", `repos/${repo}/issues/comments/${commentId}`], { encoding: "utf8" }));
}

function defaultPatchComment({ repo, commentId, body }) {
  const tmpFile = path.join(tmpdir(), `correct-plan-index-route-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(tmpFile, body, "utf8");
  try {
    return JSON.parse(
      execFileSync("gh", ["api", `repos/${repo}/issues/comments/${commentId}`, "-X", "PATCH", "-F", `body=@${tmpFile}`], { encoding: "utf8" }),
    );
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup only
    }
  }
}

export async function runCorrectPlanIndexRoute(
  { repo, executionIssue, route },
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
  if (typeof route !== "string" || !route.trim() || route.includes("\n")) {
    return { exitCode: 1, ok: false, errors: ["missing required arg: --route (single line)"] };
  }
  let resolvedRepo = repo;
  if (!resolvedRepo) {
    const identity = resolveRepoIdentityImpl();
    if (!identity.ok) return { exitCode: 1, ok: false, operationalError: true, errors: [`could not determine repository identity: ${identity.reason}`] };
    resolvedRepo = identity.repo;
  }

  const initial = await parseExecutionPlanImpl({ repo: resolvedRepo, executionIssue });
  if (initial.exitCode === 1) return { exitCode: 1, ok: false, operationalError: true, errors: [initial.message] };
  if (initial.exitCode !== 0) return { exitCode: 2, ok: false, errors: initial.errors ?? [initial.message ?? "execution plan could not be parsed"] };
  const initialErrors = validateRouteCorrection(initial.plan, route);
  if (initialErrors.length > 0) return { exitCode: 1, ok: false, errors: initialErrors };
  const commentId = initial.plan.planIndex.commentId;

  const fresh = await parseExecutionPlanImpl({ repo: resolvedRepo, executionIssue });
  const freshErrors = fresh.exitCode === 0 ? validateRouteCorrection(fresh.plan, route) : ["plan became unreadable or unparseable"];
  if (freshErrors.length > 0 || fresh.plan.planIndex.commentId !== commentId) {
    return { exitCode: 3, ok: false, state: "STALE_START_TOCTOU", errors: ["plan changed concurrently -- fail closed; re-run fresh", ...freshErrors] };
  }

  let raw;
  try {
    raw = await getCommentImpl({ repo: resolvedRepo, commentId });
  } catch (err) {
    return { exitCode: 1, ok: false, operationalError: true, errors: [`failed reading Plan Index comment #${commentId}: ${err.message}`] };
  }
  const rawBody = raw.body ?? "";
  if (parseBulletBlock(rawBody, ROUTE_LABEL) !== fresh.plan.planIndex.integrationRoute) {
    return { exitCode: 3, ok: false, state: "STALE_START_TOCTOU", errors: [`Plan Index #${commentId} route changed between plan re-read and raw fetch -- fail closed`] };
  }
  const replaced = replaceRouteField(rawBody, route);
  if (!replaced.ok) return { exitCode: 1, ok: false, errors: [replaced.reason] };

  let preCommit;
  try {
    preCommit = await getCommentImpl({ repo: resolvedRepo, commentId });
  } catch (err) {
    return { exitCode: 1, ok: false, operationalError: true, errors: [`failed re-reading Plan Index #${commentId} before commit: ${err.message}`] };
  }
  if ((preCommit.body ?? "") !== rawBody) {
    return { exitCode: 3, ok: false, state: "STALE_START_TOCTOU", errors: [`Plan Index #${commentId} changed concurrently before commit -- fail closed`] };
  }

  try {
    await patchCommentImpl({ repo: resolvedRepo, commentId, body: replaced.body });
  } catch (err) {
    return { exitCode: 4, ok: false, state: "CORRECTION_UNVERIFIED", errors: [`PATCH failed for comment #${commentId}: ${err.message}`] };
  }
  let readBack;
  try {
    readBack = await getCommentImpl({ repo: resolvedRepo, commentId });
  } catch (err) {
    return { exitCode: 4, ok: false, state: "CORRECTION_UNVERIFIED", errors: [`post-write read-back failed for comment #${commentId}: ${err.message}`] };
  }
  if ((readBack.body ?? "") !== replaced.body) {
    return { exitCode: 4, ok: false, state: "CORRECTION_UNVERIFIED", errors: [`read-back of comment #${commentId} does not match the written body`] };
  }
  return { exitCode: 0, ok: true, state: "ROUTE_CORRECTION_VERIFIED", executionIssue, commentId, route: route.trim() };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const executionIssue = args["execution-issue"] != null ? Number(args["execution-issue"]) : NaN;
  const result = await runCorrectPlanIndexRoute({ repo: args.repo, executionIssue, route: args.route });
  if (!result.ok) {
    process.stderr.write(`${JSON.stringify({ ok: false, state: result.state ?? null, errors: result.errors })}\n`);
    process.exit(result.exitCode);
  }
  process.stdout.write(`${JSON.stringify({ state: result.state, executionIssue: result.executionIssue, commentId: result.commentId, route: result.route })}\n`);
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("correct-plan-index-route.mjs")) {
  main();
}
