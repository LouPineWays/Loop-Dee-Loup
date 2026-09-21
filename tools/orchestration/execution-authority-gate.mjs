// Deterministic execution-authority classifier for AGENTS.md § Execution authority
// boundary / docs/operating-model.md § Execution authority boundary — issue #630.
//
// PR #628 is the live reproduction this closes: an owner-authored Stage 1 guidance
// comment (https://github.com/LouPineWays/Loop-Dee-Loup/pull/628#issuecomment-5705748185)
// was treated by a Codex Cloud task as write-mode authorization — bootstrapping a
// writable `work` branch, editing files, committing, and reaching `make_pr`
// (https://github.com/LouPineWays/Loop-Dee-Loup/pull/628#issuecomment-5705790753) — even
// though the comment's content was intended only to guide an already-authorized worker,
// never to create new mutation authority. #630's own "Observable outcome" states the
// durable invariant this file enforces mechanically:
//
//   content / guidance / finding / comment  -> may inform an already-authorized worker
//   explicit durable execution authority    -> may authorize bounded repository mutation
//
// and never "comment appears or platform starts a task -> agent infers implementation
// authority from the text -> edit / commit / push / open-or-update PR".
//
// This is deliberately NOT a parallel authorization framework (#630's own non-goal) — it
// is a small pure classifier over the execution-authority envelopes this repository's
// dispatch machinery already produces. Stage 1 review finding on this PR (P1, top-level +
// inline "Recognize the actual pre-PR dispatch envelopes"): these envelopes are not one
// uniform shape. Each authorized origin below validates exactly the fields its own
// deterministic formatter already requires before rendering a prompt — reusing that
// formatter-grade validation rather than re-deriving a weaker one here:
//   - `control_plane_dispatch` — the { controlIssue, executionIssue, route } triple
//     tools/orchestration/ready-dispatch-gate.mjs's READY_TO_DISPATCH verdict returns and
//     tools/orchestration/format-dispatch-prompt.mjs's formatDispatchPrompt threads into
//     the implementation worker's prompt;
//   - `planning_dispatch` / `integration_dispatch` — the narrower { controlIssue,
//     executionIssue } pair formatPlanningWorkerDispatchPrompt / formatIntegrationWorkerDispatchPrompt
//     use; these two pre-PR pipeline stages deliberately carry no `route`;
//   - `worker_unit_dispatch` — the { unitCommentUrl, parentExecutionIssue, sharedContractUrl }
//     shape formatUnitDispatchPrompt (tools/orchestration/format-unit-dispatch-prompt.mjs)
//     uses, carrying neither `controlIssue` nor `route`;
//   - `founder_direct` — an explicit founder chat instruction starting a session (the
//     Version-one runner path, docs/operating-model.md § Version-one runner);
//   - `correction_dispatch` — an authorized bounded-review-cycle correction dispatch,
//     referenced by PR or Audit Issue, with an optional control-Issue reference (Stage 1
//     review finding, inline P2 "Preserve authorized direct-reference corrections":
//     next-review-transition-gate.mjs's STAGE1_CORRECTION_REQUIRED/STAGE2_CORRECTION_REQUIRED
//     verdicts, and both correction prompt formatters, already support a genuine
//     `controlIssue: null` direct-reference/no-thin-control shape — requiring a control
//     Issue here would strand those authorized corrections, not merely reject malformed
//     ones).
//
// No other origin authorizes mutation. In particular:
//   - ordinary Issue/PR comment or task-start-from-comment content never does, no matter
//     how trusted the author — #462/#463's trusted-comment filtering governs whether
//     comment content may enter model context, a separate control from whether it may
//     authorize mutation (#630's own scope boundary);
//   - an actual `@codex review` invocation never does — it stays reviewer-only per
//     AGENTS.md § Code Review Rules (#86/#626) and never inherits implementation
//     authority merely because this boundary exists;
//   - an unrecognized or absent origin never does — this classifier fails closed by
//     default, exactly like tools/orchestration/ready-dispatch-gate.mjs's ERROR/NOT_READY
//     verdicts fail closed rather than defaulting to permission;
//   - a recognized origin with a structurally malformed field never does either — Stage 1
//     review finding on this PR (P1/P2): truthiness alone (`controlIssue: "not-an-issue"`,
//     `executionIssue: {}`, `route: []`, an object-valued `founderInstruction`,
//     `controlIssue: "x"`) previously satisfied every positive branch below. Every field
//     that makes a shape authoritative is now validated at the same strength the
//     deterministic dispatch formatters already enforce: positive integer GitHub
//     references, non-empty trimmed strings for route/instruction text, and GitHub
//     issue-comment permalinks for comment-URL fields.
//
// Established execution authority (a real dispatch, a real founder instruction) is
// unaffected: an authorized implementation/correction worker keeps its normal bounded
// mutation authority inside that dispatch, exactly as before this boundary existed.
//
// Tests: node --test tools/orchestration/execution-authority-gate.test.mjs

// Pure. True only for a finite, whole, positive number — the shape a real GitHub issue
// number always has. Mirrors format-dispatch-prompt.mjs's own isPositiveInteger so this
// classifier enforces exactly the same structural bar the deterministic dispatch
// formatters already enforce before ever rendering a prompt.
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

// Pure. A non-empty string once whitespace is trimmed — the shape a real route or founder
// instruction value must have to carry any authority at all. An object, array, or
// whitespace-only string is rejected even though each is truthy.
function isNonEmptyTrimmedString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Pure. A GitHub issue-comment permalink, mirroring format-unit-dispatch-prompt.mjs's own
// isCommentUrl — required for the worker-unit dispatch envelope below.
function isCommentUrl(value) {
  if (!isNonEmptyTrimmedString(value)) return false;
  if (!/^https?:\/\//i.test(value)) return false;
  return /#issuecomment-\d+$/.test(value);
}

// Pure. `trigger` describes how an agent session/task came to be running and what
// durable reference (if any) it carries. Returns { authorized, reason } — never throws,
// never defaults to authorized for an unrecognized or malformed shape.
export function classifyExecutionAuthority(trigger) {
  if (trigger === null || typeof trigger !== "object" || Array.isArray(trigger)) {
    return {
      authorized: false,
      reason: "no execution-authority trigger supplied (or it was not an object) — fails closed by default",
    };
  }

  const { origin } = trigger;

  if (origin === "comment" || origin === "task_start_from_comment") {
    return {
      authorized: false,
      reason:
        "comment/message content is semantic input only and can never itself authorize repository mutation, " +
        "regardless of author identity or trust — #462/#463's trusted-comment filtering governs context " +
        "admission, not execution authority; see PR #628's reproduction",
    };
  }

  if (origin === "codex_review") {
    return {
      authorized: false,
      reason:
        '"@codex review" is reviewer-only (AGENTS.md § Code Review Rules, #86/#626) and never inherits ' +
        "implementation authority, regardless of this boundary's existence",
    };
  }

  if (origin === "founder_direct") {
    if (isNonEmptyTrimmedString(trigger.founderInstruction)) {
      return { authorized: true, reason: "explicit founder chat instruction started this session" };
    }
    return {
      authorized: false,
      reason:
        'origin "founder_direct" requires founderInstruction to be a non-empty string — none was supplied, ' +
        "or the value was not a genuine instruction reference",
    };
  }

  if (origin === "control_plane_dispatch") {
    const invalid = [];
    if (!isPositiveInteger(trigger.controlIssue)) invalid.push("controlIssue");
    if (!isPositiveInteger(trigger.executionIssue)) invalid.push("executionIssue");
    if (!isNonEmptyTrimmedString(trigger.route)) invalid.push("route");
    if (invalid.length > 0) {
      return {
        authorized: false,
        reason:
          `control-plane dispatch is missing or has a malformed execution-envelope field(s): ${invalid.join(", ")} ` +
          "— controlIssue/executionIssue must be positive integers and route a non-empty string",
      };
    }
    return {
      authorized: true,
      reason: `authorized control-plane dispatch (control #${trigger.controlIssue}, execution #${trigger.executionIssue}, route "${trigger.route}")`,
    };
  }

  if (origin === "planning_dispatch" || origin === "integration_dispatch") {
    // Mirrors formatPlanningWorkerDispatchPrompt / formatIntegrationWorkerDispatchPrompt
    // (tools/orchestration/format-dispatch-prompt.mjs): both pre-PR pipeline stages
    // deliberately carry only { controlIssue, executionIssue } — no route — per #397's
    // Shared Contract. Requiring the full three-field triple here would fail closed on
    // every genuine planning/integration dispatch a controller can actually issue.
    if (!isPositiveInteger(trigger.controlIssue) || !isPositiveInteger(trigger.executionIssue)) {
      return {
        authorized: false,
        reason: `${origin} requires controlIssue and executionIssue to be positive integers`,
      };
    }
    const label = origin === "planning_dispatch" ? "planning" : "integration";
    return {
      authorized: true,
      reason: `authorized ${label} worker dispatch (control #${trigger.controlIssue}, execution #${trigger.executionIssue})`,
    };
  }

  if (origin === "worker_unit_dispatch") {
    // Mirrors formatUnitDispatchPrompt (tools/orchestration/format-unit-dispatch-prompt.mjs):
    // a worker-unit dispatch carries only the Worker Unit Contract comment URL, the parent
    // execution Issue, and the Shared Contract comment URL — never controlIssue or route.
    if (
      !isCommentUrl(trigger.unitCommentUrl) ||
      !isPositiveInteger(trigger.parentExecutionIssue) ||
      !isCommentUrl(trigger.sharedContractUrl)
    ) {
      return {
        authorized: false,
        reason:
          "worker_unit_dispatch requires unitCommentUrl and sharedContractUrl to be GitHub issue-comment URLs " +
          "and parentExecutionIssue to be a positive integer",
      };
    }
    return {
      authorized: true,
      reason: `authorized worker-unit dispatch (parent execution #${trigger.parentExecutionIssue})`,
    };
  }

  if (origin === "correction_dispatch") {
    // controlIssue is optional — a genuine direct-reference correction dispatch (no thin
    // control Issue) is still authorized, matching next-review-transition-gate.mjs's
    // STAGE1_CORRECTION_REQUIRED/STAGE2_CORRECTION_REQUIRED verdicts and both correction
    // prompt formatters, which already accept controlIssue: null for exactly this shape.
    // When controlIssue is present, though, it must be a valid positive integer, not
    // merely truthy.
    const controlIssueSupplied = trigger.controlIssue !== null && trigger.controlIssue !== undefined;
    const controlIssueValid = !controlIssueSupplied || isPositiveInteger(trigger.controlIssue);
    const hasValidPr = isPositiveInteger(trigger.pr);
    const hasValidAuditIssue = isPositiveInteger(trigger.auditIssue);
    if (controlIssueValid && (hasValidPr || hasValidAuditIssue)) {
      const ref = hasValidPr ? `PR #${trigger.pr}` : `Audit Issue #${trigger.auditIssue}`;
      const controlNote = controlIssueSupplied ? `control #${trigger.controlIssue}, ` : "direct-reference (no thin control), ";
      return {
        authorized: true,
        reason: `authorized bounded-review-cycle correction dispatch (${controlNote}referenced by ${ref})`,
      };
    }
    return {
      authorized: false,
      reason:
        "correction dispatch requires a valid PR or Audit Issue positive-integer reference, and controlIssue, " +
        "when present, must itself be a positive integer",
    };
  }

  return { authorized: false, reason: `unrecognized origin "${origin}" — fails closed by default` };
}
