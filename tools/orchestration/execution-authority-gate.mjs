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
// is a small pure classifier over the execution-authority envelope this repository's
// dispatch machinery already produces:
//   - the { controlIssue, executionIssue, route } triple
//     tools/orchestration/ready-dispatch-gate.mjs's READY_TO_DISPATCH verdict returns and
//     tools/orchestration/format-dispatch-prompt.mjs threads into the worker prompt
//     (docs/operating-model.md § Two-plane Issue dispatch);
//   - an explicit founder chat instruction starting a session (the Version-one runner
//     path, docs/operating-model.md § Version-one runner);
//   - an authorized bounded-review-cycle correction dispatch, referenced by PR or Audit
//     Issue only (docs/operating-model.md § Watched lifecycle breakpoints,
//     "Deterministic post-PR transition resolution" — STAGE1_CORRECTION_REQUIRED /
//     STAGE2_CORRECTION_REQUIRED).
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
//     verdicts fail closed rather than defaulting to permission.
//
// Established execution authority (a real dispatch, a real founder instruction) is
// unaffected: an authorized implementation/correction worker keeps its normal bounded
// mutation authority inside that dispatch, exactly as before this boundary existed.
//
// Tests: node --test tools/orchestration/execution-authority-gate.test.mjs

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
    if (trigger.founderInstruction) {
      return { authorized: true, reason: "explicit founder chat instruction started this session" };
    }
    return {
      authorized: false,
      reason: 'origin "founder_direct" requires an explicit founderInstruction reference — none was supplied',
    };
  }

  if (origin === "control_plane_dispatch") {
    const missing = ["controlIssue", "executionIssue", "route"].filter((field) => !trigger[field]);
    if (missing.length > 0) {
      return {
        authorized: false,
        reason: `control-plane dispatch is missing required execution-envelope field(s): ${missing.join(", ")}`,
      };
    }
    return {
      authorized: true,
      reason: `authorized control-plane dispatch (control #${trigger.controlIssue}, execution #${trigger.executionIssue}, route "${trigger.route}")`,
    };
  }

  if (origin === "correction_dispatch") {
    if (trigger.controlIssue && (trigger.pr || trigger.auditIssue)) {
      const ref = trigger.pr ? `PR #${trigger.pr}` : `Audit Issue #${trigger.auditIssue}`;
      return {
        authorized: true,
        reason: `authorized bounded-review-cycle correction dispatch (control #${trigger.controlIssue}, referenced by ${ref})`,
      };
    }
    return {
      authorized: false,
      reason: "correction dispatch requires a controlIssue plus a PR or Audit Issue reference",
    };
  }

  return { authorized: false, reason: `unrecognized origin "${origin}" — fails closed by default` };
}
