#!/usr/bin/env node
// Generalized start/commit/postcondition invariant for mutable-state-authorized durable
// transitions — issue #601 (control #600), closing the North Star authority #476 names for
// "deterministic transitions" and "independently verifiable autonomous state changes."
//
// Five independent incidents already forced a bespoke fix, each in its own finalize-*-
// breakpoint.mjs script, each rediscovering the same shape by hand:
//   - #492 — evidence-bearing audit context could change between evidence validation and
//     verdict mutation (classic TOCTOU: authorization derived from stale evidence).
//   - #537 — a stale historical Stage 2 pointer could override the live open-PR phase (a
//     cached/remembered witness value, rather than one re-derived fresh, drove the decision).
//   - #576/#586 — correction/ordinary-Stage-1 work could complete while the durable
//     "satisfied"/"correction-satisfied" control state needed by the *next* transition
//     remained stale — merge could outrun the projection that later steps depend on.
//   - #581 — a lifecycle mutation could update one representation (the ad hoc "Lifecycle"
//     bullet) while leaving another (the "### State" heading) contradictory and stale.
//
// `finalize-pr-breakpoint.mjs`, `finalize-correction-breakpoint.mjs`,
// `finalize-audit-breakpoint.mjs`, and `finalize-stage1-satisfied-breakpoint.mjs` each already
// enforce this invariant correctly for their own specific breakpoint (they are the case
// studies, not defects — see #601's own non-goals: "Replacing existing specialized guards that
// already correctly enforce the invariant" and "Reopening or rewriting #492, #537, #576, #581,
// or #586 as failed work" are both explicitly out of scope). Every one of those four scripts
// hand-rolls the identical skeleton: re-read the control body immediately before compose/write
// (closing the window opened by whatever evidence-gathering calls ran in between), compose+
// re-validate authorization against that fresh read, write through
// `write-control-snapshot.mjs`'s validated path, then fresh-read-back and verify before ever
// reporting success.
//
// This module is that skeleton, extracted once as the smallest shared enforcement seam
// (#601 Required layer 2: "prefer extending existing validated writers/finalizers over adding
// another lifecycle engine") so a *future* control-Issue-body transition does not have to
// rediscover it a sixth time. It composes `write-control-snapshot.mjs`'s existing validated
// write — including #581's own `validateLifecycleStateCoherence` guard — rather than
// reimplementing any part of it, and it does not migrate the four existing finalize-*-
// breakpoint.mjs scripts onto it: #601's own Required layer 7 asks only to "prove the
// generalized boundary would prevent or explicitly detect the failure class demonstrated by
// #492, #537, #576/#586, and #581 ... without rewriting those completed implementations merely
// for uniformity" — see this module's own test file for exactly that proof, modeled as
// regression fixtures against this shared primitive rather than a risky behavioral rewrite of
// already-correct, already-tested scripts.
//
// The full pipeline (#601 Required layer 1), exactly as this function performs it:
//
//   fresh current state
//   -> validate authorization/preconditions               (initial `compose(initialBody)` call)
//   -> immediately before the durable effect, revalidate
//      the mutable witness                                (re-read, then `compose(latestBody)`)
//   -> perform the bounded effect                          (the validated write)
//   -> persist/update the resulting control projection     (write-control-snapshot.mjs)
//   -> fresh read-back verifies the postcondition           (re-read, then `verify(freshBody)`)
//   -> only then report success
//
// `compose` is called twice against two independently fresh reads of the same control body —
// once to fail fast on a precondition that was already stale at the start, once more,
// immediately before the effect, to catch a witness that changed in the interim. Calling the
// *same* pure function both times is deliberate: TOCTOU protection is exactly "run the
// authorization check again, against current state, at the last practical moment before the
// effect" — a second, differently-written check could itself drift from the first and
// reintroduce the exact gap this module exists to close.
//
// A material authorization witness is not always the control body alone. `docs/operating-
// model.md` § "Transition-boundary contract" names examples explicitly outside the body itself
// — a PR's live head, a Stage 1 disposition. Stage 1 review on this PR (#602) found that the
// first cut of this module only ever revalidated the body: a caller that fetched such external
// evidence once, closed over it in its own `compose` closure, and invoked this function could
// have that evidence go stale between the initial check and the pre-effect commit check while
// both `compose` calls still passed, because neither ever saw a fresh copy. `fetchWitness` (see
// below) closes that gap the same way the body itself is closed: this module — never the
// caller — re-fetches it fresh at both boundaries and passes it as `compose`'s second argument,
// so cached/caller-supplied external evidence can never satisfy commit-time revalidation merely
// because the control body happened to be unchanged.
//
// Non-atomic external effects (#601 Required layer 3 — e.g. merge-pr plus the control-state
// projection around it, which cannot be one atomic mutation): this module does not attempt to
// wrap an external side effect like a PR merge inside its own `compose`/write step. The
// resumable-sequence pattern layer 3 asks for already exists and is already followed —
// `docs/operating-model.md` § "Deterministic post-PR transition resolution" documents the
// `action-envelope.mjs` ordering issue #561/#586 established: persist any prerequisite
// transition state first (`finalize-stage1-satisfied-breakpoint.mjs`), THEN perform the
// external effect (merge), THEN persist/verify the resulting projection
// (`finalize-audit-breakpoint.mjs`), each step independently re-deriving its own fresh evidence
// rather than trusting the step before it. A caller composing an external effect around this
// module's control-body commit step should follow that same ordering: call this module (or an
// equivalent finalize script) to durably record any state the effect depends on BEFORE
// performing the effect, and again immediately AFTER, to record/verify the postcondition — an
// interruption between those two calls leaves a mechanically detectable partial state (the
// effect's own external state, e.g. `gh pr view --json state`, disagrees with what the control
// body still records), never a silent false success.
//
// Telemetry-visible failure classes (#601 Required layer 6): every non-`ok` result this module
// returns carries a `failureClass` from `TransitionFailureClass` below, distinguishing exactly
// the four classes layer 6 requires. No new telemetry infrastructure is built here — these are
// deterministic result codes a later telemetry surface can consume, per layer 6's own "do not
// build new telemetry infrastructure solely for this slice" instruction.
//
// Tests: node --test tools/orchestration/transition-guard.test.mjs

import { execFileSync } from "node:child_process";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";
import { resolveRepoIdentity } from "./ready-dispatch-gate.mjs";

// The four failure classes #601 Required layer 6 names. `null` on a successful result.
export const TransitionFailureClass = Object.freeze({
  // Authorization/preconditions did not hold even at the initial fresh read — the transition
  // was never authorized to begin with (a stale caller assumption, not a race).
  STALE_START_PRECONDITION: "STALE_START_PRECONDITION",
  // Authorization held at the initial read but the mutable witness the effect depends on had
  // changed by the time it was revalidated immediately before the effect — classic TOCTOU.
  WITNESS_CHANGED_TOCTOU: "WITNESS_CHANGED_TOCTOU",
  // The effect's own durable projection could not be established or confirmed written — the
  // effect may or may not have taken hold, but its required postcondition is not yet durable.
  POSTCONDITION_PROJECTION_FAILED: "POSTCONDITION_PROJECTION_FAILED",
  // The effect's projection was written, but a fresh read-back does not match what the effect
  // was supposed to produce — the write silently no-op'd, a concurrent edit landed after it, or
  // the postcondition is otherwise not what was intended.
  POSTCONDITION_READBACK_MISMATCH: "POSTCONDITION_READBACK_MISMATCH",
});

function operationalError(message) {
  return { exitCode: 1, ok: false, failureClass: null, message };
}

function failure(controlIssue, failureClass, reason) {
  return {
    exitCode: 2,
    ok: false,
    state: "TRANSITION_UNVERIFIED",
    controlIssue,
    failureClass,
    reason,
    message: `TRANSITION_UNVERIFIED ${controlIssue} ${failureClass}`,
  };
}

function defaultGhIssueView({ repo, controlIssue }) {
  const args = ["issue", "view", String(controlIssue), "--json", "body"];
  if (repo) args.push("--repo", repo);
  const raw = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(raw).body ?? "";
}

// No external witness declared: a purely body-authorized transition. Returns a stable constant
// so `compose(body, witness)` sees the same `undefined` at both boundaries rather than this
// module manufacturing a spurious "change".
async function defaultFetchWitness() {
  return undefined;
}

// The reusable commit-time seam. `compose(body, witness)` is a pure function returning
// `{ ok: true, body: nextBody }` or `{ ok: false, reason }` — it is both the authorization/
// precondition check AND the composer, called twice against two independently fresh reads of
// the control body AND (when a transition declares one) the material external witness (see
// module comment). `verify(freshBodyAfterWrite)` is a pure function returning `{ ok: true }` or
// `{ ok: false, reason }`, checking the postcondition the write was supposed to establish.
//
// `ghIssueViewImpl`/`writeControlSnapshotImpl`/`resolveRepoIdentityImpl` are injected so tests
// can drive this end-to-end without touching the real network, `gh`, or `git` — see this
// module's own test file. `fetchWitness()` is likewise injectable: a transition with a material
// external witness (e.g. a PR's live head or Stage 1 disposition) supplies it; a body-only
// transition can omit it entirely.
export async function commitControlBodyTransition({
  repo,
  controlIssue,
  compose,
  verify,
  fetchWitness = defaultFetchWitness,
  ghIssueViewImpl = defaultGhIssueView,
  writeControlSnapshotImpl = checkWriteControlSnapshot,
  resolveRepoIdentityImpl = resolveRepoIdentity,
}) {
  if (!Number.isInteger(controlIssue) || controlIssue <= 0) {
    return operationalError("Missing/invalid required arg: controlIssue must be a positive integer.");
  }
  if (typeof compose !== "function" || typeof verify !== "function") {
    return operationalError("Missing required arg: compose and verify must both be functions.");
  }
  if (typeof fetchWitness !== "function") {
    return operationalError("Invalid arg: fetchWitness, when supplied, must be a function.");
  }

  // Resolve repository identity exactly once, before any read or write, so every step of this
  // operation targets the same repository. Stage 1 review finding on this PR: when `repo` was
  // left unresolved, the default reads still succeeded because `gh issue view` infers the
  // current repository on its own, but the default write path forwarded the unresolved value
  // straight through to `gh issue edit --repo <unresolved>`, which fails -- every transition
  // that omitted `repo` reported POSTCONDITION_PROJECTION_FAILED regardless of whether the
  // transition itself was otherwise valid. Resolving once here, the same way write-control-
  // snapshot.mjs's own CLI entrypoint already does, makes the reads and the write share one
  // resolved identity instead of two independently-defaulted ones.
  let resolvedRepo = repo;
  if (!resolvedRepo) {
    const identity = resolveRepoIdentityImpl();
    if (!identity.ok) {
      return operationalError(`Could not determine repository identity (repo was not supplied): ${identity.reason}`);
    }
    resolvedRepo = identity.repo;
  }

  // Step 1: fresh current state -- the control body, and any material external witness this
  // transition declares.
  let initialBody;
  try {
    initialBody = await ghIssueViewImpl({ repo: resolvedRepo, controlIssue });
  } catch (err) {
    return operationalError(`gh issue view failed for ${resolvedRepo}#${controlIssue}: ${err.message}`);
  }
  let initialWitness;
  try {
    initialWitness = await fetchWitness();
  } catch (err) {
    return operationalError(`initial witness fetch failed: ${err.message}`);
  }

  // Step 2: validate authorization/preconditions against that fresh current state. Fails fast,
  // before any evidence-gathering or write is even attempted, if the transition was never
  // authorized to begin with.
  const initialCheck = compose(initialBody, initialWitness);
  if (!initialCheck.ok) {
    return failure(controlIssue, TransitionFailureClass.STALE_START_PRECONDITION, initialCheck.reason);
  }

  // Step 3: immediately before the durable effect, revalidate the mutable witness -- both the
  // control body and the external witness. Re-reading/re-fetching here — rather than reusing
  // `initialBody`/`initialWitness` — closes whatever window elapsed between step 1 and this call
  // (e.g. a caller's own external evidence-gathering `gh` calls made between establishing
  // initial authorization and invoking this commit sequence, or simply time passing while other
  // work ran). Re-running the exact same `compose` check against these fresh values is the
  // TOCTOU guard itself; a caller-cached witness value is never accepted here because this
  // module never receives one from the caller in the first place -- it always fetches its own.
  let latestBody;
  try {
    latestBody = await ghIssueViewImpl({ repo: resolvedRepo, controlIssue });
  } catch (err) {
    return operationalError(`pre-effect control re-read failed: ${err.message}`);
  }
  let latestWitness;
  try {
    latestWitness = await fetchWitness();
  } catch (err) {
    return operationalError(`pre-effect witness fetch failed: ${err.message}`);
  }
  const commitCheck = compose(latestBody, latestWitness);
  if (!commitCheck.ok) {
    return failure(controlIssue, TransitionFailureClass.WITNESS_CHANGED_TOCTOU, commitCheck.reason);
  }

  // Step 4: perform the bounded effect — the validated write. Composed against `latestBody`
  // (never `initialBody`), so a concurrent edit to any field `compose` does not itself govern
  // survives into the write instead of being silently clobbered (the same "irrelevant state"
  // tolerance the four existing finalize-*-breakpoint.mjs scripts already rely on).
  let writeResult;
  try {
    writeResult = await writeControlSnapshotImpl({ repo: resolvedRepo, controlIssue, proposedBody: commitCheck.body });
  } catch (err) {
    return failure(controlIssue, TransitionFailureClass.POSTCONDITION_PROJECTION_FAILED, `write threw: ${err.message}`);
  }
  if (!writeResult || writeResult.exitCode !== 0 || writeResult.state !== "WRITTEN") {
    return failure(
      controlIssue,
      TransitionFailureClass.POSTCONDITION_PROJECTION_FAILED,
      `write did not report WRITTEN (${JSON.stringify(writeResult)})`,
    );
  }

  // Step 5: fresh read-back verifies the postcondition before success is ever reported — never
  // trusting the write call's own return value alone.
  let freshBody;
  try {
    freshBody = await ghIssueViewImpl({ repo: resolvedRepo, controlIssue });
  } catch (err) {
    return failure(controlIssue, TransitionFailureClass.POSTCONDITION_PROJECTION_FAILED, `post-write read-back failed: ${err.message}`);
  }
  const verification = verify(freshBody);
  if (!verification.ok) {
    return failure(controlIssue, TransitionFailureClass.POSTCONDITION_READBACK_MISMATCH, verification.reason);
  }

  return { exitCode: 0, ok: true, state: "COMMITTED", controlIssue, failureClass: null, body: freshBody };
}
