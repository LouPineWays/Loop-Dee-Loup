#!/usr/bin/env node
// Deterministic reference-only dispatch-prompt formatter for one worker-unit contract --
// worker unit 294-C under control Issue #306 / execution Issue #294.
//
// Mirrors `format-dispatch-prompt.mjs`'s fixed-template/verbatim-stdout discipline
// (issue #321), extended one level down: instead of pointing a dispatched worker at a
// whole execution Issue, this points a worker at exactly one Worker Unit Contract comment
// within a multi-unit execution plan. The prompt carries only three references -- the
// Worker Unit Contract comment URL, the parent execution Issue number, and the Shared
// Contract comment URL -- and restates none of that unit's own fields (outcome,
// capability, files, verification, state). The dispatched worker reads the Worker Unit
// Contract and Shared Contract comments directly from GitHub, exactly as an
// AGENTS.md-governed session reads a full execution Issue on a NOT_READY gate result.
//
// Usage (explicit fields):
//   node tools/orchestration/format-unit-dispatch-prompt.mjs \
//     --unit-comment-url "https://github.com/OWNER/REPO/issues/294#issuecomment-123" \
//     --parent-execution-issue 294 \
//     --shared-contract-url "https://github.com/OWNER/REPO/issues/294#issuecomment-456"
//
// Usage (convenience -- looks the unit and Shared Contract URLs up from a live plan via
// 294-B's parse-execution-plan.mjs, repository identity derived from the checkout's own
// origin remote the same way parse-execution-plan.mjs and ready-dispatch-gate.mjs do):
//   node tools/orchestration/format-unit-dispatch-prompt.mjs --execution-issue 294 --unit 294-C
//
// Tests: node --test tools/orchestration/format-unit-dispatch-prompt.test.mjs

import { runParseExecutionPlan } from "./parse-execution-plan.mjs";
import { assertReferenceOnly } from "./format-dispatch-prompt.mjs";

// Pure. True only for a finite, whole, positive number -- the shape a real GitHub issue
// number always has (mirrors format-dispatch-prompt.mjs's isPositiveInteger).
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

// Pure. A GitHub issue-comment permalink: an http(s) URL containing "#issuecomment-".
// Deliberately strict -- a malformed or near-miss URL must fail loudly here rather than
// being handed to a dispatched worker as a broken reference.
function isCommentUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  if (!/^https?:\/\//i.test(value)) return false;
  return /#issuecomment-\d+$/.test(value);
}

// Pure. Renders the fixed reference-only template for one worker-unit dispatch. Kept
// deliberately inert -- no conditionals that grow the text based on unit content -- so its
// length is bounded by construction, mirroring formatDispatchPrompt's own discipline.
export function formatUnitDispatchPrompt({ unitCommentUrl, parentExecutionIssue, sharedContractUrl }) {
  if (
    !isCommentUrl(unitCommentUrl) ||
    !isPositiveInteger(parentExecutionIssue) ||
    !isCommentUrl(sharedContractUrl)
  ) {
    throw new Error(
      "formatUnitDispatchPrompt requires unitCommentUrl and sharedContractUrl to be GitHub issue-comment URLs " +
        "and parentExecutionIssue to be a positive integer",
    );
  }
  return (
    `Worker-unit dispatch. Parent execution Issue: #${parentExecutionIssue}. ` +
    `Worker Unit Contract: ${unitCommentUrl}. Shared Contract: ${sharedContractUrl}.\n\n` +
    `Read both comments directly from GitHub -- outcome, capability, files, verification, ` +
    `and State were not restated here on purpose. Execute per AGENTS.md (and ` +
    `docs/bounded-review-cycle.md if review-worthy), report via AGENTS.md's Slice handoff ` +
    `format, and update only this unit's own State field when done, per the Shared ` +
    `Contract's edit-ownership rule.`
  );
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

async function resolveFieldsFromPlan({ repo, executionIssue, unitId }) {
  const parsed = await runParseExecutionPlan({ repo, executionIssue });
  if (parsed.exitCode !== 0) {
    return { error: parsed };
  }
  const unit = parsed.plan.units[unitId];
  if (!unit) {
    return {
      error: {
        exitCode: 2,
        ok: false,
        errors: [`unit "${unitId}" was not found in the parsed plan for issue #${executionIssue}`],
      },
    };
  }
  const sharedContractUrl = parsed.plan.sharedContract?.url ?? null;
  if (!sharedContractUrl) {
    return {
      error: {
        exitCode: 2,
        ok: false,
        errors: [`the parsed plan for issue #${executionIssue} has no resolved Shared Contract URL`],
      },
    };
  }
  return {
    fields: {
      unitCommentUrl: unit.url,
      parentExecutionIssue: Number(parsed.plan.planIndex.parentExecutionIssue?.replace(/^#/, "")) || Number(executionIssue),
      sharedContractUrl,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let fields = null;
  if (args["unit-comment-url"] || args["shared-contract-url"] || args["parent-execution-issue"]) {
    fields = {
      unitCommentUrl: args["unit-comment-url"] ?? null,
      parentExecutionIssue: args["parent-execution-issue"] != null ? Number(args["parent-execution-issue"]) : null,
      sharedContractUrl: args["shared-contract-url"] ?? null,
    };
  } else if (args["execution-issue"] && args.unit) {
    const resolved = await resolveFieldsFromPlan({ repo: args.repo, executionIssue: args["execution-issue"], unitId: args.unit });
    if (resolved.error) {
      const err = resolved.error;
      if (err.exitCode === 1) {
        process.stderr.write(`${err.message}\n`);
        process.exit(1);
        return;
      }
      process.stderr.write(`format-unit-dispatch-prompt.mjs: ${err.errors.join("\n")}\n`);
      process.exit(2);
      return;
    }
    fields = resolved.fields;
  } else {
    process.stderr.write(
      "format-unit-dispatch-prompt.mjs: pass --unit-comment-url/--parent-execution-issue/--shared-contract-url " +
        "explicitly, or --execution-issue/--unit to resolve them from a live plan\n",
    );
    process.exit(2);
    return;
  }

  let prompt;
  try {
    prompt = assertReferenceOnly(formatUnitDispatchPrompt(fields));
  } catch (err) {
    process.stderr.write(`format-unit-dispatch-prompt.mjs: ${err.message}\n`);
    process.exit(1);
    return;
  }

  process.stdout.write(`${prompt}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("format-unit-dispatch-prompt.mjs")) {
  main();
}
