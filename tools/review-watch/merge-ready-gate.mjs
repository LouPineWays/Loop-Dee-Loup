#!/usr/bin/env node
// Single authoritative pre-merge completion gate for docs/bounded-review-cycle.md Stage 1
// steps 8-9. Composes stage1-gate.mjs's Stage 1 evidence check and lifecycle-gate.mjs
// `merge-ready`'s work-issue closing-reference check into one fail-closed result, so a
// review-worthy PR's merge-ready/CLEAN transition depends on one command instead of an
// executor remembering to invoke two independent ones.
//
// Issue #214: YouTubery PR #49 carried `Closes #48`, completed Stage 1, and merged — the
// merging session simply never ran `lifecycle-gate.mjs merge-ready` alongside
// `stage1-gate.mjs`, so GitHub auto-closed issue #48 ahead of its Stage 2 audit. Both gates
// were individually correct (issues #135 and #156); the gap was that nothing made the two
// mandatory invocations one mechanically-required transition. `post-audit --recover true`
// caught and reversed the resulting premature closure (see docs/bounded-review-cycle.md's
// "Premature-closure recovery" section), but only after the invariant had already been
// violated — this script exists to prevent that violation earlier, not to replace recovery
// as defense in depth.
//
// This module does not reimplement either check: it calls stage1-gate.mjs's `run` and
// lifecycle-gate.mjs's `checkMergeReady` and combines their results. A caller cannot obtain
// a successful composed result by running, or by this script accepting, only one of the two
// — both must independently report success.
//
// Composed exit codes (distinct from either component's own exit codes, so a component
// result can never be mistaken for the composed one):
//   0 — PRE_MERGE_READY / PRE_MERGE_READY_NO_WORK_ISSUE: both components succeeded.
//   2 — BLOCKED: at least one component reported a non-error blocking state (Stage 1
//       NOT_REQUESTED/PENDING, or lifecycle BLOCKED_CLOSING_REFERENCE). `blockedBy` names
//       which component(s) and their own state.
//   1 — OPERATIONAL_ERROR / MALFORMED_GATE_OUTPUT: a required argument was missing or
//       malformed, an underlying `gh` call failed, or a component returned output that
//       could not be trusted (missing/invalid exitCode). Never treated as a pass.
//
// Usage:
//   node tools/review-watch/merge-ready-gate.mjs \
//     --repo OWNER/REPO --pr 50 --head <sha> --issue 151
//   node tools/review-watch/merge-ready-gate.mjs \
//     --repo OWNER/REPO --pr 50 --head <sha> --issue none
//
// The two composed checks remain individually invocable (`stage1-gate.mjs`,
// `lifecycle-gate.mjs merge-ready`) for diagnostics or targeted testing of one half only —
// neither one's individual success is, on its own, grounds to merge or report a slice
// complete. Use this script for the actual pre-merge decision.
//
// Tests: node --test tools/review-watch/merge-ready-gate.test.mjs

import { run as runStage1 } from "./stage1-gate.mjs";
import { checkMergeReady } from "./lifecycle-gate.mjs";

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const value = argv[++i];
    args[key] = value;
  }
  return args;
}

function hasTrustworthyExitCode(result) {
  return result !== null && typeof result === "object" && [0, 1, 2].includes(result.exitCode);
}

// `stage1RunImpl`/`checkMergeReadyImpl` are injected so tests can drive `run` end-to-end
// against fakes for both components without touching the real network or `gh` CLI.
export async function run(args, { stage1RunImpl = runStage1, checkMergeReadyImpl = checkMergeReady } = {}) {
  const { repo, pr, head, issue } = args;
  const identifiers = { repo: repo ?? null, pr: pr ?? null, head: head ?? null, issue: issue ?? null };

  let stage1;
  try {
    stage1 = await stage1RunImpl({ repo, number: pr, head, ...(args.bot ? { bot: args.bot } : {}) });
  } catch (err) {
    stage1 = { exitCode: 1, message: `stage1-gate threw: ${err.message}` };
  }

  let lifecycle;
  try {
    lifecycle = await checkMergeReadyImpl({ repo, pr, issue });
  } catch (err) {
    lifecycle = { exitCode: 1, message: `lifecycle-gate merge-ready threw: ${err.message}` };
  }

  // A component that returns output this gate cannot trust (a missing/invalid exitCode —
  // e.g. an injected fake that returns undefined, or a future component bug) must never be
  // silently treated as passing. This is requirement #2's "a required underlying check
  // cannot execute or return a trustworthy result" clause.
  if (!hasTrustworthyExitCode(stage1) || !hasTrustworthyExitCode(lifecycle)) {
    return {
      exitCode: 1,
      state: "MALFORMED_GATE_OUTPUT",
      ...identifiers,
      stage1,
      lifecycle,
      message:
        "One or both underlying gates returned output without a trustworthy exitCode (0, 1, or 2); " +
        "the composed pre-merge gate fails closed rather than assuming success.",
    };
  }

  // Operational failure in either component dominates: the composed result is untrustworthy,
  // not merely blocked, so this is reported distinctly from a normal BLOCKED state.
  if (stage1.exitCode === 1 || lifecycle.exitCode === 1) {
    const messages = [];
    if (stage1.exitCode === 1) messages.push(`stage1-gate: ${stage1.message}`);
    if (lifecycle.exitCode === 1) messages.push(`lifecycle-gate merge-ready: ${lifecycle.message}`);
    return {
      exitCode: 1,
      state: "OPERATIONAL_ERROR",
      ...identifiers,
      stage1,
      lifecycle,
      message: messages.join(" | "),
    };
  }

  if (stage1.exitCode === 2 || lifecycle.exitCode === 2) {
    const blockedBy = [];
    if (stage1.exitCode === 2) blockedBy.push({ component: "stage1", state: stage1.state });
    if (lifecycle.exitCode === 2) blockedBy.push({ component: "lifecycle", state: lifecycle.state });
    return {
      exitCode: 2,
      state: "BLOCKED",
      blockedBy,
      ...identifiers,
      stage1,
      lifecycle,
    };
  }

  return {
    exitCode: 0,
    state: lifecycle.state === "MERGE_READY_NO_WORK_ISSUE" ? "PRE_MERGE_READY_NO_WORK_ISSUE" : "PRE_MERGE_READY",
    ...identifiers,
    stage1,
    lifecycle,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await run(args);
  if (result.exitCode === 1) {
    console.error(result.message ?? JSON.stringify(result));
  } else {
    console.log(JSON.stringify(result));
  }
  process.exit(result.exitCode);
}

// Only run as a CLI when invoked directly, not when the test file imports these functions.
if (process.argv[1] && process.argv[1].endsWith("merge-ready-gate.mjs")) {
  main();
}
