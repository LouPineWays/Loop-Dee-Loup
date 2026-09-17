# 441-D diagnostic trace: exact-directory path-lock reconciliation

- **Unit:** 441-D (parent execution issue #441, controlling issue #442)
- **Performed by:** worker session dispatched 2026-09-17 against Worker Unit Contract
  https://github.com/LouPineWays/Loop-Dee-Loup/issues/441#issuecomment-5711473956
- **Binding diagnostic input:** founder live reproduction,
  https://github.com/LouPineWays/Loop-Dee-Loup/issues/441#issuecomment-5711469493
- **Environment:** repository checkout `C:\Loop-Dee-Loup`

## Corrected invariant under reconciliation

The founder's live reproduction (superseding 441-A's/PR #615's provisional "external
substrate, cause unproven" framing) established: exactly one live Claude Code session or
process may own an exact directory path at a time; a second launch at that same exact path
fails closed with `Another Claude Code session is already active in this directory`,
regardless of whether the owner is idle or has done real work; a different directory path
(including a different worktree of the same repository) is unaffected; and archiving the
owning session releases the path for immediate reuse. `list_sessions` is not a complete
occupancy inventory, because a directly-opened session invisible to that list can still hold
a path lock.

## Verification performed this unit

1. **Re-confirmed 441-A's direct source finding.** `grep -rliE
   "concurren|capacity|semaphore|max.?session|session.?limit|active.?slot"
   tools/orchestration/*.mjs tools/review-watch/*.mjs tools/ldl-init` still finds zero
   session/capacity/slot implementation in this repository's own code. No file under
   `tools/orchestration/` or `tools/review-watch/` reads session lists, session state, or a
   concurrency counter, or launches a top-level Code/Dispatch session — `list_sessions`,
   `start_session`, `hand_off_to_session`, and equivalents are absent from every script in
   this repository.
2. **Confirmed LDL has no worktree-management code of its own.** `grep -ril worktree` across
   the repository (excluding this diagnostic-traces directory and generated proof-run
   artifacts) returns no orchestration/review-watch script — the only executable reference is
   `tools/ldl-sync/verify-scope.mjs`, unrelated to session/path ownership.
3. **Confirmed AGENTS.md and docs/operating-model.md contain no capacity-misclassification
   language.** Neither file mentions "capacity" at all; there is no prose anywhere in this
   repository's authoritative docs that could cause a controller to read a same-path
   rejection as global/repo-wide Dispatch-capacity exhaustion. The acceptance criterion "a
   second launch at an already-owned exact path... is not misclassified as global capacity
   exhaustion" is therefore already satisfied by omission — there is nothing to correct here.
4. **Confirmed LDL never launches a top-level Code/Dispatch session itself.** Per 441-C's
   independently re-verified access-boundary finding, no session-creation tool
   (`start_session`/`hand_off_to_session`/equivalent) is exposed to any LDL-dispatched worker,
   and this repository's own scripts never attempt one. Every top-level session that could hit
   the substrate's exact-path lock is opened directly by the founder through the CCD app, a
   surface entirely outside this repository's code — already proven, by the founder's own
   reproduction, to enforce the corrected invariant correctly (distinct paths coexist; same
   path fails closed; archiving releases it). LDL has no top-level-session-launch surface to
   fix.
5. **Identified the one real, LDL-authored surface capable of violating the invariant:**
   concurrent subagent (Agent-tool) dispatch. `docs/operating-model.md` § Execution-stage
   session boundaries authorizes dispatching every currently `dispatch_ready=true` plan unit
   "together as one wave" whenever they are genuinely independent — i.e. more than one
   subagent running concurrently, each free to write, commit, and open work in the
   repository. Neither that section nor `AGENTS.md` § Subagent dispatch said anything about
   directory isolation for that concurrency. Left as written, a compliant controller could
   dispatch two independent unit workers in the same message with no `isolation` argument,
   and — per the Agent tool's own documented default — both would share the orchestrating
   session's own working directory rather than each owning a distinct path, reproducing the
   same "independent concurrent work colliding on one path" failure shape the founder
   observed at the top-level-session layer, one level down at the subagent layer. This is a
   gap in LDL's own authored dispatch instructions, not in the external substrate, and squarely
   inside "dispatch... surfaces" that 441-D's own contract authorized changing.

## Disposition

- **No code change.** No LDL script implements, tracks, or claims session/path capacity, so
  none needed correction; the corrected invariant's top-level-session behavior is entirely and
  correctly owned by the external substrate, exactly as the founder's reproduction showed.
- **One narrow documentation correction**, closing the concurrent-subagent gap identified in
  finding 5: `AGENTS.md` § Subagent dispatch and `docs/operating-model.md` § Execution-stage
  session boundaries now require `isolation: "worktree"` for each concurrently-dispatched
  subagent that writes or commits repository state, so genuinely concurrent independent
  dispatch work always uses distinct directory paths rather than defaulting to a shared one.
  A single, non-concurrent dispatch is unaffected — there is no sibling to collide with.
  Worktree cleanup on release is already handled by the Agent tool's own `isolation:
  "worktree"` mechanism (automatic removal when a dispatched worker makes no changes;
  otherwise the path/branch are returned for the controller to track), so no new LDL-side
  cleanup machinery was added, consistent with this unit's non-goals.
- This closes 441-D per its own stopping condition: the invariant is satisfied by a verified
  no-change result for the top-level-session boundary (b) plus the smallest merged correction
  for the one real gap found in LDL's own dispatch surfaces (a).
