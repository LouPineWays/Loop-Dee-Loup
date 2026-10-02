// Launcher supervisor for issue #73 (Stage 2 correction on #825, finding 1).
//
// One Launch Authorization must carry one LDL lifecycle through fresh bounded workers until a
// genuine durable stopping boundary. The prior production path ran exactly one launcher step and
// then settled (consumed) the authorization, so the first open path ended the attempt. This module
// is the thin router around `runLauncherStep` that closes that gap; it adds no lifecycle engine:
//
//   loop:
//     1. founder surface: a pending durable decision surface blocks the step; once every question
//        is answered by a writer and exactly one continuation remains, resume (resolveFounderResume)
//        and persist the cleared decision, otherwise stop WAITING;
//     2. one `runLauncherStep` (the gates still decide everything; fresh read every iteration);
//     3. route the result:
//          ADVANCED            -> next iteration reads a fresh gate verdict. After the terminal
//                                 close transition (STAGE2_CLOSE_READY) project the terminal return
//                                 (projectTerminalReturn) and stop TERMINAL_CLEAN.
//          OPEN_PATH_REQUIRED  -> dispatch the by-reference fresh worker (deps.dispatchWorker); the
//                                 worker's own report is never trusted: the next iteration re-reads
//                                 durable state, and an unchanged open path stops FAIL_CLOSED.
//          WAITING             -> guidance/founder waits stop; a bounded external wait (reviewer
//                                 response) polls within the wait budget, then stops WAITING.
//          FAIL_CLOSED         -> stop.
//   The caller settles the attempt claim once this returns, i.e. only at a genuine terminal,
//   waiting, or fail-closed boundary, never after a single step.
//
// Tests: node --test tools/orchestration/launcher-supervisor.test.mjs

import { runLauncherStep, resolveFounderResume, projectTerminalReturn, Outcome } from "./launcher-step.mjs";

export const SupervisorOutcome = Object.freeze({
  TERMINAL_CLEAN: "TERMINAL_CLEAN",
  WAITING: "WAITING",
  FAIL_CLOSED: "FAIL_CLOSED",
});

const TERMINAL_STATE = "STAGE2_CLOSE_READY";

function refKey(evidence) {
  const d = evidence?.dispatch;
  return JSON.stringify({ state: evidence?.state, refs: d?.byReference ?? null, role: d?.role ?? null });
}

// deps: {
//   step() -> runLauncherStep result (production binds buildDeps),
//   dispatchWorker(dispatch) -> { launched: boolean, reason? },
//   readFounderSurface() -> null | { noSurface: true } | { surfaceId, questionIds, comments, continuations },
//   resumeFounder(resolution) -> persists the cleared founder decision (throws when unprovable),
//   terminalInput() -> input for projectTerminalReturn, writeControl/readControl -> terminal deps,
//   waitForReviewer(wait, budgetMs) -> { matched }, now() }
export async function runLauncherSupervisor({ deps, maxSteps = 25, waitBudgetMs = 0, } = {}) {
  const trail = [];
  const done = (outcome, extra = {}) => ({ outcome, trail, ...extra });
  if (!deps) return done(SupervisorOutcome.FAIL_CLOSED, { reason: "missing deps" });
  let lastDispatchKey = null;
  let lastAdvancedState = null;
  const startedAt = deps.now ? deps.now() : Date.now();

  for (let i = 0; i < maxSteps; i += 1) {
    // 1. founder decision gate
    let surface;
    try {
      surface = deps.readFounderSurface ? await deps.readFounderSurface() : null;
    } catch (e) {
      return done(SupervisorOutcome.FAIL_CLOSED, { reason: `founder surface unreadable: ${e?.message ?? e}` });
    }
    if (surface) {
      if (surface.noSurface) return done(SupervisorOutcome.WAITING, { reason: "founder decision pending with no durable decision surface" });
      const r = resolveFounderResume(surface);
      trail.push({ founder: r.outcome, resume: r.resume });
      if (!r.resume) return done(SupervisorOutcome.WAITING, { reason: r.reason ?? "founder decision pending", founderDecision: r.founderDecision, missing: r.missing });
      try {
        await deps.resumeFounder({ ...r, surfaceId: surface.surfaceId });
      } catch (e) {
        return done(SupervisorOutcome.FAIL_CLOSED, { reason: `founder resume not durable: ${e?.message ?? e}` });
      }
      continue; // re-read: the cleared decision must be visible before any step
    }

    // 2. one gate-driven step
    const r = await deps.step();
    trail.push({ outcome: r.outcome, state: r.evidence?.state ?? null });

    switch (r.outcome) {
      case Outcome.ADVANCED: {
        lastDispatchKey = null;
        // An advanced transition must expose a different successor next time; the same state
        // advancing twice in a row is a loop, never progress.
        if (r.evidence?.state && r.evidence.state === lastAdvancedState && r.evidence.state !== TERMINAL_STATE) {
          return done(SupervisorOutcome.FAIL_CLOSED, { reason: "same transition advanced twice without exposing a successor", state: r.evidence.state });
        }
        lastAdvancedState = r.evidence?.state ?? null;
        if (r.evidence?.state === TERMINAL_STATE) {
          let input;
          try {
            input = await deps.terminalInput(r);
          } catch (e) {
            return done(SupervisorOutcome.FAIL_CLOSED, { reason: `terminal return input unavailable: ${e?.message ?? e}` });
          }
          const t = await projectTerminalReturn(input, { writeControl: deps.writeControl, readControl: deps.readControl });
          if (t.outcome !== Outcome.ADVANCED) return done(SupervisorOutcome.FAIL_CLOSED, { reason: t.evidence?.reason ?? "terminal return not proved" });
          return done(SupervisorOutcome.TERMINAL_CLEAN, { terminal: t.evidence });
        }
        break;
      }
      case Outcome.OPEN_PATH_REQUIRED: {
        lastAdvancedState = null;
        const dispatch = r.evidence?.dispatch;
        if (!dispatch) return done(SupervisorOutcome.FAIL_CLOSED, { reason: "open path resolved without a dispatch description" });
        const key = refKey(r.evidence);
        if (key === lastDispatchKey) {
          return done(SupervisorOutcome.FAIL_CLOSED, { reason: "dispatched worker produced no durable progress (same open path re-read)", state: r.evidence.state });
        }
        let d;
        try {
          d = await deps.dispatchWorker(dispatch);
        } catch (e) {
          return done(SupervisorOutcome.FAIL_CLOSED, { reason: `worker dispatch failed: ${e?.message ?? e}` });
        }
        if (!d?.launched) {
          return done(SupervisorOutcome.WAITING, { reason: d?.reason ?? "no fresh-worker runner available; resume with a fresh `work on #<control>`", state: r.evidence.state, dispatch });
        }
        lastDispatchKey = key;
        trail.push({ dispatched: dispatch.role, route: dispatch.route });
        break;
      }
      case Outcome.WAITING: {
        const needsExternal = r.evidence?.state === "NO_ACTION_YET" && !r.evidence?.chatGuidanceRequired && r.evidence?.wait;
        const now = deps.now ? deps.now() : Date.now();
        const remaining = waitBudgetMs - (now - startedAt);
        // The external wait uses the canonical review poller (deps.waitForReviewer binds
        // tools/review-watch/poll.mjs), never a hand-rolled sleep-and-rerun loop; after it
        // returns matched the gate is simply re-read on the next iteration.
        if (needsExternal && deps.waitForReviewer && remaining >= 1000) {
          let w;
          try {
            w = await deps.waitForReviewer(r.evidence.wait, remaining);
          } catch (e) {
            return done(SupervisorOutcome.FAIL_CLOSED, { reason: `reviewer wait failed: ${e?.message ?? e}`, state: r.evidence.state });
          }
          trail.push({ waited: r.evidence.wait.kind, matched: w?.matched === true });
          if (w?.matched === true) break;
        }
        return done(SupervisorOutcome.WAITING, { reason: r.evidence?.reason ?? r.evidence?.handoff ?? "waiting on an external durable event", state: r.evidence?.state });
      }
      default:
        return done(SupervisorOutcome.FAIL_CLOSED, { reason: r.evidence?.reason ?? "launcher step failed closed", state: r.evidence?.state });
    }
  }
  return done(SupervisorOutcome.WAITING, { reason: `step budget (${maxSteps}) exhausted at a resumable durable boundary` });
}

// Re-export so the production runner imports one module.
export { runLauncherStep };
