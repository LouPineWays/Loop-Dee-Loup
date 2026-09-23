#!/usr/bin/env node
// Deterministic reference-only dispatch-prompt formatter for AGENTS.md § Subagent
// dispatch / docs/operating-model.md § Two-plane Issue dispatch — issue #321.
//
// `ready-dispatch-gate.mjs` already returns the exact reference-only triple a READY
// control Issue authorizes dispatching on: { controlIssue, executionIssue, route }. That
// script's own module comment says "nothing else belongs in that prompt" — but nothing
// upstream of the actual Agent/Task tool call enforced that in practice. A live fresh
// proof run for #321 itself (control Issue #322, execution Issue #321,
// docs/diagnostic-traces/615f2b4a-69eb-42f1-bef6-432a4e32f4dc.json) recorded a real
// controller session that correctly skipped every pre-dispatch execution-Issue read and
// all reconnaissance (`pre_dispatch_events: []`,
// `execution_issue_read_by_controller_before_dispatch: false`) and then still composed a
// 2554-character dispatch prompt — well past `diagnostic-trace.mjs`'s 700-char
// reference-only threshold — by restating large parts of AGENTS.md's own general
// contract sections (Session execution, Subagent dispatch, Founder interrupt conditions,
// the Slice handoff field list, the bounded review cycle) into the prompt instead of
// simply pointing at them. `classifyPreDispatch` correctly flagged that as
// `"violation"` ("dispatch prompt exceeded the reference-only size threshold (possible
// requirement retransmission)") even though the dispatched worker never received any
// #321-specific requirements/acceptance-criteria content — the two prior boundary
// failures (#282/#283, #314) and this one are distinct failure modes with the same root
// cause: nothing deterministic stood between "the gate says READY_TO_DISPATCH" and "the
// text actually handed to the Agent/Task tool."
//
// This script is that missing deterministic step. It takes exactly the JSON object
// `ready-dispatch-gate.mjs` already emits on `READY_TO_DISPATCH` and renders one fixed,
// short template from it — no free-form composition, no restated AGENTS.md prose, no
// review-cycle mechanics, no Slice-handoff field list. AGENTS.md instructs the
// orchestrating session to use this script's output verbatim as the dispatched worker's
// prompt: the worker already has AGENTS.md (imported via CLAUDE.md at session start) and
// reads the execution Issue directly, so nothing else belongs in the dispatch prompt
// itself.
//
// Usage (piped from the gate, the normal path — the gate derives repository identity
// deterministically from the checkout's own "origin" remote; issue #344):
//   node tools/orchestration/ready-dispatch-gate.mjs --control-issue 322 \
//     | node tools/orchestration/format-dispatch-prompt.mjs
//
// Usage (explicit fields — only when a READY gate result's fields are already in hand
// outside a pipe, e.g. re-rendering the same dispatch prompt from a recorded gate result,
// or this script's own tests):
//   node tools/orchestration/format-dispatch-prompt.mjs \
//     --control-issue 322 --execution-issue 321 --route "implementation worker"
//
// Stage 1 review finding on this PR: this is NOT the right tool for a legacy-unsplit
// routing worker (docs/operating-model.md § Two-plane Issue dispatch, "Legacy unsplit
// Issues"). This template always says "Implementation worker dispatch" and tells the
// worker to execute the issue and report a Slice handoff — correct only for a worker
// that is actually authorized to execute a full vertical slice. A routing worker's job is
// the opposite: read the full issue and return only a compact projection (outcome shape,
// executor/persona, blocker state, authority conflicts) so the controller can decide
// decomposition, never begin implementation. Using this formatter for that dispatch would
// hand a routing worker an executor's mandate before the decomposition boundary is
// resolved. This script has exactly one template for exactly one role — an implementation
// worker dispatched on a satisfied READY immediate-dispatch gate — and that scope is
// deliberate, not an oversight to be widened with a second mode.
//
// Issue #570 extends this same table-driven selection to `next-review-transition-gate.mjs`'s
// two post-PR correction verdicts, closing the exact #451/PR #569 reproduction where a
// mechanically authorized `STAGE1_CORRECTION_REQUIRED` -> `dispatch-correction-worker`
// transition (per `tools/orchestration/action-envelope.mjs`) had no deterministic prompt path:
//   node tools/orchestration/next-review-transition-gate.mjs --control-issue 451 \
//     | node tools/orchestration/format-dispatch-prompt.mjs
// and the equivalent for `STAGE2_CORRECTION_REQUIRED` from a post-merge NOT CLEAN verdict.
//
// Issue #665 adds `STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT` (the live #639/#638/PR #640
// reproduction: a correction-satisfied PR's merge is mechanically blocked by a real conflict
// against the current target branch), selecting `formatConflictRecoveryWorkerDispatchPrompt`
// the same table-driven way. Stage 1 review finding on PR #719: this template requires the same
// pre-spawn `checkoutBinding` (`pr-head-checkout-preflight.mjs --reserve-from-gate`, pinned to
// the gated `correctedHead`) as the findings-bearing `STAGE1_CORRECTION_REQUIRED` template, since
// its worker mutates source too.
//
// Tests: node --test tools/orchestration/format-dispatch-prompt.test.mjs

import { readFileSync } from "node:fs";

// Pure. True only for a finite, whole, positive number — the shape a real GitHub issue
// number always has. Stage 1 review finding on this PR: `Number("abc")` is `NaN` and
// `Number("-7")`/`Number("12.5")` are finite but not valid issue numbers; none of those
// are caught by a bare `== null` check (`NaN == null` and `-7 == null` are both false), so
// a mistyped or non-integral explicit CLI argument previously reached the template
// unvalidated and produced references like "#NaN" that callers would use verbatim for
// dispatch.
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

// Pure. Renders the fixed reference-only template. Kept deliberately inert — no
// conditionals that grow the text based on route or issue content — so its length is
// bounded by construction rather than by reviewer discipline. A route string picked up
// from a control Issue's "- **Route:** <value>" bullet is inserted verbatim (already
// validated non-empty/non-"none" by `evaluateReadyDispatchGate` upstream), so an unusually
// long route value could in principle push this over the reference-only threshold;
// `assertReferenceOnly` below is the guard against that, not a length cap baked into the
// template itself.
export function formatDispatchPrompt({ controlIssue, executionIssue, route }) {
  if (!isPositiveInteger(controlIssue) || !isPositiveInteger(executionIssue) || typeof route !== "string" || !route.trim()) {
    throw new Error(
      "formatDispatchPrompt requires controlIssue and executionIssue to be positive integers and route to be a non-empty string",
    );
  }
  return (
    `Implementation worker dispatch. Execution Issue: #${executionIssue}. ` +
    `Controlling Issue: #${controlIssue}. Route: ${route}.\n\n` +
    `Read #${executionIssue} directly from GitHub for its full outcome, constraints, and ` +
    `acceptance criteria. Execute it per AGENTS.md and, for review-worthy work, ` +
    `docs/bounded-review-cycle.md. Once the PR exists — Stage 1 review requested, or a ` +
    `recorded Stage 1 exemption for non-review-worthy work — run ` +
    `tools/orchestration/finalize-pr-breakpoint.mjs (report PR_BREAKPOINT_UNVERIFIED, not ` +
    `success, if it fails), then stop: do not wait, poll, merge, or begin Stage 2; those ` +
    `are fresh-worker or deterministic steps per docs/operating-model.md § Watched ` +
    `lifecycle breakpoints.`
  );
}

// Pure. Renders the fixed reference-only "Planning worker dispatch" template for #397's new
// READY_FOR_PLAN pre-PR Lifecycle value (tools/orchestration/ready-dispatch-gate.mjs's
// READY_TO_DISPATCH_PLANNING verdict). Deliberately carries no `route` parameter, unlike
// formatDispatchPrompt above: #397's Shared Contract fixes this template to "control Issue +
// execution Issue references only" — READY_FOR_PLAN's Route is always the fixed literal
// "planning worker" (already enforced by the gate itself), so restating it in the prompt
// would add nothing a fresh planning worker doesn't already know from the word "Planning" in
// this template's own first line.
export function formatPlanningWorkerDispatchPrompt({ controlIssue, executionIssue }) {
  if (!isPositiveInteger(controlIssue) || !isPositiveInteger(executionIssue)) {
    throw new Error("formatPlanningWorkerDispatchPrompt requires controlIssue and executionIssue to be positive integers");
  }
  return (
    `Planning worker dispatch. Execution Issue: #${executionIssue}. Controlling Issue: #${controlIssue}.\n\n` +
    `Read #${executionIssue} from GitHub for its full outcome, constraints, and acceptance criteria — ` +
    `it was not restated here on purpose. Determine whether it is one bounded vertical slice or requires ` +
    `decomposition per AGENTS.md. If decomposition is required, follow ` +
    `AGENTS.md's Decomposition boundary (create slice Issues, record dependencies, close the source Issue) ` +
    `and stop — do not create plan artifacts on this same Issue. If it is one bounded slice, produce this ` +
    `Issue's Execution Plan Index, Shared Contract, and Worker Unit Contract comments per docs/operating-model.md, ` +
    `do not begin implementing units yourself, and stop.`
  );
}

// Pure. Renders the fixed reference-only "Planning-correction worker dispatch" template for
// issue #498 unit 498-B's new REPLAN_REQUIRED verdict (`ready-dispatch-gate.mjs`'s
// `probeReplanRequired`). Modeled on `formatPlanningWorkerDispatchPrompt` above — a
// planning-correction is the same planning capability revisiting its own prior output, not a
// new worker role.
//
// Stage 1 review finding on this PR (P1): the first version of this template interpolated
// every `replanRequiredUnitIds` entry verbatim into the prompt text. That makes the prompt's
// length a function of how many units a given plan has failing at once — unbounded by
// construction, not merely by a route string's length the way `assertReferenceOnly`'s own doc
// comment above describes. A plan with enough failing units (or a longer realistic repository
// permalink) pushes the rendered prompt past the 700-char reference-only threshold,
// `assertReferenceOnly` throws, and the mandatory planning-correction dispatch cannot happen at
// all — exactly the liveness failure REPLAN_REQUIRED exists to avoid. Rather than raise the
// threshold (which only postpones the same failure at a larger plan size), this template no
// longer carries the failing unit set as prose at all: it points the dispatched worker at
// `ready-dispatch-gate.mjs` itself, re-run with the same `controlIssue`, to recover the current
// failing unit(s) and reason from durable authority. That is the exact same deterministic
// computation `probeReplanRequired` already performed to produce this verdict, so the worker
// gets identical information without the controller ever having to fit an open-ended list into
// a fixed-size template.
//
// Deliberately omits the verdict's own `reason` text from the prompt itself — that string is
// for the controller's compact chat/handoff record, not the worker prompt; the dispatched
// worker reads the authoritative routing failure directly off the Plan Index/unit contracts
// (and, now, the gate's own re-run output) it is pointed at, exactly as every other dispatch
// template in this file hands over references rather than restated content.
//
// Stage 2 audit finding on issue #526 (audited merge commit 442d19de03cd94769bac0ebaf5f8ddae0
// cbbd515): removing the unit-list interpolation above was not by itself a structural bound —
// `controlIssue` and `executionIssue` are only validated by `isPositiveInteger` (no digit-count
// ceiling), a real GitHub comment permalink can carry a 39-char username, a 100-char repository
// name (GitHub's own structural maximums), and a comment/issue id already around 10 digits and
// growing, and the fix still rendered `controlIssue` twice and the full `planIndexUrl` once.
// That fix's own verification test also only exercised 3-digit control/execution issue numbers,
// so it never measured the shape this finding reproduced.
//
// Stage 1 review finding on the follow-up correction PR #527: even after bounding
// `controlIssue`/`executionIssue` to a single rendering each, `planIndexUrl` embeds the
// checkout's own git host, not merely "github.com" — `resolveRepoIdentity`/
// `parseOwnerRepoFromRemoteUrl` in `ready-dispatch-gate.mjs` accept GitHub Enterprise remotes
// with an arbitrarily longer hostname, and that host is not bounded by any GitHub API
// limit the way username/repo-name length is. A 60-char Enterprise hostname alone pushed the
// then-current worst case from 677 to 727 chars. There is no way to bound an arbitrary
// hostname's length by construction, so the fix is not another round of prose-trimming
// arithmetic against a slightly-wider worst case: `planIndexUrl` is no longer rendered into the
// prompt text at all. The worker is instead told to recover the Plan Index the same way it
// already recovers the failing unit set — by re-running `ready-dispatch-gate.mjs` against the
// Controlling Issue above, which returns `planIndexUrl` from the exact same deterministic
// `probeReplanRequired` computation this verdict itself used. `planIndexUrl` and
// `replanRequiredUnitIds` remain required inputs (the caller must hold a genuine
// REPLAN_REQUIRED result, not merely `controlIssue`/`executionIssue`), but neither is rendered
// any more — the prompt's length is now a function of two bounded integers and fixed prose
// only, independent of plan/unit-set size, repository name, and git host length alike: 618
// chars even at `Number.MAX_SAFE_INTEGER` (2^53-1, 16 digits, the true upper bound
// `isPositiveInteger` can ever accept) for both `controlIssue` and `executionIssue` (Stage 1
// review finding on PR #620: the fixed prose grew to name `correct-unit-dependency.mjs` as the
// only mechanism that can patch an existing unit's dependency field in place, since
// `format-execution-plan.mjs` alone cannot and a worker following it verbatim could not perform
// the field-scoped correction issue #618 established).
export function formatPlanningCorrectionWorkerDispatchPrompt({ controlIssue, executionIssue, planIndexUrl, replanRequiredUnitIds }) {
  if (
    !isPositiveInteger(controlIssue) ||
    !isPositiveInteger(executionIssue) ||
    typeof planIndexUrl !== "string" ||
    !planIndexUrl.trim() ||
    !Array.isArray(replanRequiredUnitIds) ||
    replanRequiredUnitIds.length === 0
  ) {
    throw new Error(
      "formatPlanningCorrectionWorkerDispatchPrompt requires controlIssue and executionIssue to be positive integers, " +
        "planIndexUrl to be a non-empty string, and replanRequiredUnitIds to be a non-empty array",
    );
  }
  return (
    `Planning-correction worker dispatch. Execution Issue: #${executionIssue}. Controlling Issue: ` +
    `#${controlIssue}.\n\n` +
    `Re-run ready-dispatch-gate.mjs against the Controlling Issue above to recover the Plan Index and ` +
    `failing unit(s). Read the Plan Index and each unit's contract, then correct per ` +
    `AGENTS.md/docs/operating-model.md — use correct-unit-dependency.mjs for an existing unit's ` +
    `dependency field (format-execution-plan.mjs cannot patch one in place), or format-execution-plan.mjs ` +
    `only for a new unit. Return a compact confirmation and stop — do not prepare the Dispatch Manifest, ` +
    `advance Lifecycle, or dispatch units.`
  );
}

// Pure. Renders the fixed reference-only "Integration/PR worker dispatch" template for
// #397's new EXECUTION_COMPLETE pre-PR Lifecycle value (ready-dispatch-gate.mjs's
// READY_TO_DISPATCH_INTEGRATION verdict). Also carries no `route` parameter, for the same
// reason as the planning template above — the Integration/PR worker's job is fixed by
// docs/bounded-review-cycle.md § Integration/PR worker, not by a route string.
export function formatIntegrationWorkerDispatchPrompt({ controlIssue, executionIssue }) {
  if (!isPositiveInteger(controlIssue) || !isPositiveInteger(executionIssue)) {
    throw new Error("formatIntegrationWorkerDispatchPrompt requires controlIssue and executionIssue to be positive integers");
  }
  return (
    `Integration/PR worker dispatch. Execution Issue: #${executionIssue}. Controlling Issue: ` +
    `#${controlIssue}.\n\n` +
    `Read #${executionIssue}'s own Execution Plan Index, Shared Contract, and Worker Unit Contract ` +
    `comments directly from GitHub — they were not restated here on purpose. Integrate the completed ` +
    `units and open the one PR per docs/bounded-review-cycle.md § Integration/PR worker. Once the PR ` +
    `exists — Stage 1 review requested, or a recorded Stage 1 exemption for non-review-worthy work — ` +
    `run tools/orchestration/finalize-pr-breakpoint.mjs before reporting; on PR_BREAKPOINT_UNVERIFIED ` +
    `report that reference, never ordinary success. Then stop, per docs/operating-model.md § Watched ` +
    `lifecycle breakpoints.`
  );
}

// Pure. Renders the fixed reference-only "Stage 1 correction worker dispatch" template for
// issue #570 — `next-review-transition-gate.mjs`'s `STAGE1_CORRECTION_REQUIRED` verdict.
// `action-envelope.mjs` already authorizes exactly `dispatch-correction-worker` for this state
// (docs/operating-model.md § Watched lifecycle breakpoints, "Deterministic post-PR transition
// resolution"), but until this issue nothing rendered that authorization into a deterministic
// prompt — the live #451/PR #569 reproduction reached this exact verdict and then failed at
// `format-dispatch-prompt.mjs`, which recognized no such state.
//
// `controlIssue` is optional (`null` when absent) because `next-review-transition-gate.mjs`'s
// own direct-reference mode (`--pr`/`--head`/`--issue`, no `--control-issue`) can also reach
// this verdict without a thin control Issue to name — the template renders the "Controlling
// Issue" line only when one is actually present, never a fabricated placeholder.
//
// Stage 1 review finding on this PR (P1): direct-reference mode's `--issue` also accepts the
// explicit "none" sentinel for the documented no-work-issue path (next-review-transition-gate.mjs
// requires "--issue none" alongside "--pr"/"--head" precisely so a review-worthy PR with no
// separate work Issue — e.g. a consumer-sync update — can still resolve). That sentinel string
// flows straight through the gate's own `context` spread into the verdict's `issue` field
// unmodified. Coercing it with `Number("none")` produces `NaN`, which `isPositiveInteger` rejects,
// so this formatter previously threw for exactly that genuine, authorized verdict shape — the
// only case `STAGE1_CORRECTION_REQUIRED` can validly carry a non-issue `issue` value. `issue` is
// therefore accepted as either a positive integer or the literal string "none"; the Execution
// Issue reference is rendered only when a real issue is present.
//
// Deliberately carries no finding text, review comment excerpts, or acceptance-criteria
// restatement: the dispatched correction worker reads PR #<pr>'s own current Stage 1 review (and,
// when present, Execution Issue #<issue>) directly from GitHub, exactly as every other template
// in this file hands over durable references instead of restated content.
//
// Issue #611 (the post-#576 #438/PR #610 regression): this template previously stopped at "push
// it, and stop" with no instruction to run `finalize-correction-breakpoint.mjs` at all — the
// mandatory step lived only in `docs/bounded-review-cycle.md`'s Correction-satisfied disposition
// prose, exactly the "prose-only worker obligation" #611 exists to close, and exactly the seam a
// Stage 1 review finding on PR #579 already flagged (`docs/operating-model.md`'s
// `STAGE1_CORRECTION_REQUIRED` entry) without this formatter ever being updated to carry it. This
// mirrors `formatIntegrationWorkerDispatchPrompt`'s own established `finalize-pr-breakpoint.mjs`
// clause immediately above: name the mandatory finalize step and its fail-closed reporting
// contract, without restating its flags — the worker already has `controlIssue`/`issue`/`pr` from
// this same prompt, and derives `--reviewed-head`/`--corrected-head` itself from the PR it just
// read and corrected, the same "read it directly, don't restate it" convention this whole file
// uses. `finalize-correction-breakpoint.mjs` itself refuses `--control-issue` without a paired
// `--execution-issue` (or vice versa), so a worker dispatched with a Controlling Issue but the
// "none" no-work-issue sentinel (a real, separately-tested combination below) supplies only the
// identity it actually has and the script's own direct-reference form applies -- no partial or
// invented identity is ever passed.
//
// Stage 1 review finding on PR #613 (P1): the unconditional finalizer mandate above conflated two
// distinct `STAGE1_CORRECTION_REQUIRED` classes that `next-review-transition-gate.mjs` emits
// through this same verdict. A CLEAN/EXEMPT Stage 1 result blocked only by
// `BLOCKED_CLOSING_REFERENCE` has neither findings provenance nor necessarily a newer PR head, so
// `finalize-correction-breakpoint.mjs`'s own findings-bearing/strict-descendant requirements
// correctly reject it -- mandating the finalizer for that class turned a valid closing-reference
// repair into `CORRECTION_BREAKPOINT_UNVERIFIED`. `correctionReason` (the gate's own new
// discriminant field, "findings" or "closing-reference" -- see next-review-transition-gate.mjs's
// four `STAGE1_CORRECTION_REQUIRED` return sites) carries the distinction the dispatched worker
// needs rather than making it infer workflow class from reviewer prose. Only "findings" mandates
// the finalizer and #611's fail-closed contract; "closing-reference" routes the worker through the
// ordinary repair-and-stop instruction and explicitly tells it not to manufacture a
// correction-satisfied disposition. Defaults to "findings" when absent (every pre-#613 caller,
// including this file's own explicit-fields CLI mode, already assumed the findings-bearing shape).
//
// Issue #703 (control #691, the `work on #514` / execution #689 / PR #700 recurrence): the
// findings template below previously told the *spawned* worker to run the preflight and then
// `EnterWorktree` the returned path. Repository selection succeeded, but the spawned worker could
// not rebind itself afterwards (agent-tool isolation had already pinned it to another sandbox;
// a retry without isolation still hit the spawned-subagent `EnterWorktree` restriction), which
// forced a parent-session correction fallback. The execution surface is now settled BEFORE
// spawn: the controller pipes the gate verdict through `pr-head-checkout-preflight.mjs
// --reserve-from-gate`, which reserves one exact PR-head checkout and adds `checkoutBinding`
// ({ path, token, ... }) to the verdict. The findings template requires that binding (fails
// closed without it -- no worker is ever spawned onto an unsettled surface) and tells the worker
// only to *verify* it from the reserved path; no post-spawn workspace transition is required.
const BINDING_TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

// Stage 1 finding P1 on PR #710: the findings template below used to tell the worker to invoke
// `pr-head-checkout-preflight.mjs` by a path relative to the reserved/candidate checkout it had
// just been told to `cd` into -- exactly the untrusted PR content this reservation exists to
// evaluate. A PR that predates `--verify-binding` support, or one that edits this tool itself,
// would then supply the verifier, letting the candidate being corrected certify its own binding
// contract. `checkoutBinding.scriptPath` (added by `pr-head-checkout-preflight.mjs`'s `reserve`,
// the controller's own absolute path to itself, captured before the worker even exists) is now
// required alongside `path`/`token` and is what the template actually invokes, so verification
// code always comes from the controller's authoritative checkout while still evaluating the
// reserved checkout's own live state as its cwd. Same validation/length budget as `path` above.
//
// Stage 1 review finding on PR #719 (issue #665, P1): the conflict-recovery template below now
// requires the identical pre-spawn binding for the identical reason (its worker mutates source
// too), so this check is shared rather than duplicated; `callerName`/`purpose` let each caller's
// error message stay self-identifying without forking the validation logic itself.
function assertCheckoutBinding(checkoutBinding, callerName = "formatStage1CorrectionWorkerDispatchPrompt", purpose = "a findings correction") {
  if (
    !checkoutBinding ||
    typeof checkoutBinding.path !== "string" ||
    !checkoutBinding.path ||
    /[\r\n]/.test(checkoutBinding.path) ||
    checkoutBinding.path.length > 200 ||
    typeof checkoutBinding.token !== "string" ||
    !BINDING_TOKEN_PATTERN.test(checkoutBinding.token) ||
    typeof checkoutBinding.scriptPath !== "string" ||
    !checkoutBinding.scriptPath ||
    /[\r\n]/.test(checkoutBinding.scriptPath) ||
    checkoutBinding.scriptPath.length > 200 ||
    // Stage 2 audit finding on PR #710 (issue #711, P2): `scriptPath` is rendered below as a
    // double-quoted shell word so a controller installation path containing a space (a valid
    // Windows/POSIX path segment -- the whole reason this check exists) still parses as one
    // argument.
    //
    // Stage 1 review finding on PR #712 (P2): a literal double quote is not the only character
    // that stays shell-active inside POSIX double quotes -- `$` still triggers variable
    // expansion / `$(command)` substitution, and a backtick still triggers command substitution,
    // even when the whole argument is wrapped in `"..."`. A valid controller installation path
    // containing either (e.g. a `$HOME`-derived mount point) would previously pass this check
    // and then have its substitution executed by the worker's shell. Reject all three
    // shell-active characters up front -- fail-closed, consistent with the CRLF/length checks
    // above -- rather than attempting cross-shell escaping for them. A bare backslash is not
    // included: `SELF_SCRIPT_PATH` is a native path (backslash-separated on Windows) and a lone
    // backslash not immediately preceding one of these three characters is inert inside POSIX
    // double quotes.
    /["$`]/.test(checkoutBinding.scriptPath)
  ) {
    throw new Error(
      `${callerName} requires a pre-spawn checkoutBinding { path, token, scriptPath } for ${purpose} -- ` +
        "pipe the gate verdict through pr-head-checkout-preflight.mjs --reserve-from-gate first",
    );
  }
}

// Pure. Shared "pre-bound checkout" preamble -- Stage 1 review finding on PR #719 (issue #665,
// P1) extends the same pre-spawn-reservation invariant from the findings-bearing Stage 1
// correction template to the conflict-recovery template below, so this text (and its
// budget-exclusion treatment in main()'s `bindingAllowance`) is shared rather than duplicated.
function renderPreBoundCheckoutClause({ path, token, scriptPath, pr }) {
  return (
    `Pre-bound checkout: ${path}. From it, first run node "${scriptPath}" ` +
    `--verify-binding ${token} --pr ${pr} (nonzero: CHECKOUT_BINDING_UNVERIFIED ${pr}, stop); work only ` +
    `there, push via its pushRefspec.\n\n`
  );
}

export function formatStage1CorrectionWorkerDispatchPrompt({ controlIssue = null, issue, pr, correctionReason, checkoutBinding = null }) {
  if (!isPositiveInteger(pr)) {
    throw new Error("formatStage1CorrectionWorkerDispatchPrompt requires pr to be a positive integer");
  }
  const hasExecutionIssue = issue !== "none";
  if (hasExecutionIssue && !isPositiveInteger(issue)) {
    throw new Error(
      'formatStage1CorrectionWorkerDispatchPrompt requires issue to be a positive integer or the literal "none" sentinel',
    );
  }
  if (controlIssue !== null && controlIssue !== undefined && !isPositiveInteger(controlIssue)) {
    throw new Error("formatStage1CorrectionWorkerDispatchPrompt requires controlIssue to be a positive integer when present");
  }
  const reason = correctionReason ?? "findings";
  if (reason !== "findings" && reason !== "closing-reference") {
    throw new Error(
      'formatStage1CorrectionWorkerDispatchPrompt requires correctionReason to be "findings", "closing-reference", or absent',
    );
  }
  const executionLine = hasExecutionIssue ? ` Execution Issue: #${issue}.` : "";
  const controlLine = controlIssue != null ? ` Controlling Issue: #${controlIssue}.` : "";
  const executionReadClause = hasExecutionIssue ? ` / Execution Issue #${issue}` : "";
  // Issue #692 (control #691), closing the live PR #690 / execution #685 / control #442
  // reproduction: a correction worker recovered this exact PR's head metadata but never
  // verified its own checkout represented that head, then failed reading a PR-only source
  // file from an unrelated `main` checkout. This mandatory first step -- before any GitHub
  // read or source work below -- binds the checkout deterministically via
  // `pr-head-checkout-preflight.mjs` rather than assuming the dispatched session's own
  // working directory already is the PR head; that script's own header names the exact
  // recovery step for each of its verdicts, so it is deliberately not restated here -- this
  // file's 700-char reference-only threshold (`assertReferenceOnly` below) leaves no room to.
  // A non-zero exit is a fail-closed checkout/head-binding failure, never a downstream "file
  // does not exist" symptom to work around.
  //
  // Stage 1 review finding on PR #694: a successful exit alone does not put the worker in the
  // returned checkout -- the script only reports a `path`; nothing upstream of the worker's own
  // next action changes its working directory. This clause now mandates `EnterWorktree` itself
  // (never restated as optional or inferred), and its own failure -- e.g. the path is still
  // live-owned by another session, this repository's own one-session-per-exact-path invariant,
  // `docs/operating-model.md` § Concurrent subagent directory isolation -- is the same
  // fail-closed `CHECKOUT_BINDING_UNVERIFIED` outcome, never a path to work around.
  //
  // Issue #703: superseded by the pre-spawn binding described above `assertCheckoutBinding` --
  // the worker now verifies an already-reserved checkout instead of rebinding itself.
  if (reason === "closing-reference") {
    // Stage 1 review finding on PR #694: a closing-reference repair is normally a remote
    // metadata-only edit (the PR body or GitHub Development-sidebar link) needing no local
    // checkout at all -- mandating the binding preflight unconditionally turned every dirty,
    // occupied, or otherwise unavailable local candidate into an unrelated blocker for a repair
    // that never touches source. Only a genuinely source/commit-changing closing-reference
    // repair still needs the same binding invariant as the findings path above.
    return (
      `Stage 1 correction worker dispatch.${executionLine} PR: #${pr}.${controlLine}\n\n` +
      `Read PR #${pr}'s Stage 1 review${executionReadClause} from GitHub for the closing-reference finding ` +
      `and authority (not restated). Closing-reference-only (no findings): metadata-only needs no checkout; ` +
      `a source/commit change first needs pr-head-checkout-preflight.mjs --reserve --pr ${pr}, then ` +
      `--verify-binding from its path, else CHECKOUT_BINDING_UNVERIFIED ${pr}. Fix per ` +
      `docs/bounded-review-cycle.md, push it, and stop. Do not run finalize-correction-breakpoint.mjs or ` +
      `record a correction-satisfied disposition. Do not re-trigger review, merge, or begin Stage 2 here.`
    );
  }
  assertCheckoutBinding(checkoutBinding);
  const { path, token, scriptPath } = checkoutBinding;
  // Stage 2 audit finding on PR #710 (issue #711, P2): this used to interpolate `scriptPath`
  // unquoted into the rendered `node <scriptPath> ...` invocation, so a controller installation
  // path containing a space split into multiple shell words and the worker's mandatory first
  // step failed to parse. Quote it as a single argument; `assertCheckoutBinding` above already
  // rejects the double quote, `$`, and backtick characters that would otherwise break out of, or
  // expand/substitute inside, this quoting (Stage 1 review finding on PR #712, P2).
  return (
    `Stage 1 correction worker dispatch.${executionLine} PR: #${pr}.${controlLine}\n\n` +
    renderPreBoundCheckoutClause({ path, token, scriptPath, pr }) +
    `Read PR #${pr}'s Stage 1 review${executionReadClause} for findings (not restated). Apply one ` +
    `consolidated correction per docs/bounded-review-cycle.md, push, run ` +
    `tools/orchestration/finalize-correction-breakpoint.mjs (on CORRECTION_BREAKPOINT_UNVERIFIED report ` +
    `that, not success), then --release-binding ${token}. No re-review, merge, or Stage 2.`
  );
}

// Pure. Renders the fixed reference-only "Stage 2 correction worker dispatch" template for
// issue #570 — `next-review-transition-gate.mjs`'s `STAGE2_CORRECTION_REQUIRED` verdict. Same
// missing-formatter gap as the Stage 1 sibling above, for the post-merge NOT CLEAN path
// (`action-envelope.mjs` authorizes the identical `dispatch-correction-worker` action here).
//
// Carries only the Audit Issue reference (plus an optional Controlling Issue reference, same
// rule as the Stage 1 template above) — never the audit narrative or verdict text. The
// dispatched correction worker reads Audit Issue #<auditIssue>'s completed Stage 2 report
// directly, which itself names the work/execution Issue needing correction, so no second
// reference is required here.
//
// Issue #646 (the #487/#643/#644/#645 live reproduction): the prior template mandated only
// "apply one consolidated correction ... push it, and stop" — a bare push, with no PR creation/
// linkage, Stage 1 trigger, or PR-breakpoint finalization required. That left a genuinely
// successful correction indistinguishable, from a fresh controller's own durable-state read, from
// one that never happened: control #487 stayed on PR #642/Stage 2 #643 after correction PR #644
// existed, so a later fresh dispatch produced a duplicate PR #645 against the same finding. This
// template now mandates the same PR/Stage-1 breakpoint the direct implementation-worker and
// Integration/PR-worker routes already require (`docs/bounded-review-cycle.md`'s Integration/PR
// worker step 6, and `finalize-pr-breakpoint.mjs`'s own #456 contract, extended by this same issue
// to accept a `Lifecycle: AUDIT` source state): open or identify exactly one correction PR linked
// to the work Issue, request Stage 1 at its live head via `trigger.mjs`, then run
// `finalize-pr-breakpoint.mjs` before ever reporting success — on `PR_BREAKPOINT_UNVERIFIED`,
// report that reference verbatim, never ordinary success, mirroring the Stage 1 sibling's own
// `CORRECTION_BREAKPOINT_UNVERIFIED` contract above.
// Stage 1 review finding on PR #647 (issue #646, P1): the unconditional finalizer mandate below
// used to apply verbatim in direct-reference mode too (`controlIssue` absent), but
// `finalize-pr-breakpoint.mjs` hard-requires positive-integer `--control-issue` AND
// `--execution-issue` values and exits 1 (a plain operational failure, never the documented
// `PR_BREAKPOINT_UNVERIFIED`) without them — an impossible instruction a direct-reference worker
// could never satisfy. `composeStage2CorrectionFinalizeCommand` above already gets this right
// (it omits the `finalize-pr-breakpoint.mjs` segment entirely when `controlIssue` is absent); this
// template now mirrors that same branch in its prose. Direct-reference mode has no thin control
// Issue to project a breakpoint onto in the first place, so its worker only requests Stage 1 at
// the correction PR's head and reports the PR/head/work-Issue identity — a fresh invocation
// continues via `next-review-transition-gate.mjs`'s own `--pr`/`--head`/`--issue` direct-reference
// path, which re-derives live state without needing any control write.
export function formatStage2CorrectionWorkerDispatchPrompt({ controlIssue = null, auditIssue }) {
  if (!isPositiveInteger(auditIssue)) {
    throw new Error("formatStage2CorrectionWorkerDispatchPrompt requires auditIssue to be a positive integer");
  }
  if (controlIssue !== null && controlIssue !== undefined && !isPositiveInteger(controlIssue)) {
    throw new Error("formatStage2CorrectionWorkerDispatchPrompt requires controlIssue to be a positive integer when present");
  }
  const hasControlIssue = controlIssue != null;
  const controlLine = hasControlIssue ? ` Controlling Issue: #${controlIssue}.` : "";
  const breakpointClause = hasControlIssue
    ? `request Stage 1 at its head via tools/review-watch/trigger.mjs, then run ` +
      `tools/orchestration/finalize-pr-breakpoint.mjs before reporting; on PR_BREAKPOINT_UNVERIFIED report ` +
      `that reference, never success.`
    : `request Stage 1 at its head via trigger.mjs; verify it succeeded. No control Issue exists to ` +
      `finalize onto — skip finalize-pr-breakpoint.mjs. Report the PR number, head, and work Issue for ` +
      `a fresh invocation's direct-reference resume.`;
  return (
    `Stage 2 correction worker dispatch. Audit Issue: #${auditIssue}.${controlLine}\n\n` +
    `Read Audit Issue #${auditIssue}'s completed Stage 2 report directly from GitHub to recover the audit ` +
    `findings, the work Issue it names, and correction authority — not restated here on purpose. Apply one ` +
    `consolidated correction per docs/bounded-review-cycle.md, open/identify one correction PR linked to the ` +
    `work Issue, ${breakpointClause} Then stop: do not re-trigger the audit or terminalize this cycle here.`
  );
}

// Pure. Renders the fixed reference-only "Conflict-recovery worker dispatch" template for
// issue #665 — `next-review-transition-gate.mjs`'s `STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT`
// verdict (live #639/#638/PR #640 reproduction: a correction-satisfied PR reached
// `STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2` but GitHub's own live mergeable state
// reported a real conflict against the current target branch, and the merge action could not
// mechanically execute). `action-envelope.mjs` authorizes `reserve-correction-checkout` then
// `dispatch-conflict-recovery-worker` for this state.
//
// Stage 1 review finding on PR #719 (issue #665's own correction — both findings accepted and
// addressed together as one dispatch-boundary invariant, not two unrelated patches):
//
//   P1 (PR-head checkout reservation): this recovery worker mutates source exactly like a
//   findings-bearing Stage 1 correction worker does, so it must not be dispatched onto an
//   unsettled surface either. `checkoutBinding` (the same `{ path, token, scriptPath }` shape
//   `pr-head-checkout-preflight.mjs --reserve-from-gate` adds to a findings correction) is now
//   required here too — `assertCheckoutBinding` fails closed without it — and the template opens
//   with the identical pre-bound-checkout preamble via `renderPreBoundCheckoutClause`.
//
//   P2 (pin the gated corrected head): the worker no longer starts from "whatever the PR's live
//   head happens to be" — that was a TOCTOU gap, since a post-gate commit could become the
//   worker's starting point without ever having passed the transition that authorized recovery.
//   `pr-head-checkout-preflight.mjs`'s `reserve`/`reserveFromGate` now pin the reservation itself
//   to `correctedHead` (the exact head this verdict gated) and fail closed
//   (`STALE_HEAD_MISMATCH`) if the PR's live head has already moved past it; the worker's
//   mandatory `--verify-binding` first step (named by the shared preamble) then re-proves both
//   the reserved checkout and that head identity still hold before any source mutation. Nothing
//   further needs restating in the prompt text itself — the pin already happened before this
//   template was ever rendered.
//
// `reviewedHead` keeps its pre-existing, separate role and exception: when a Controlling Issue
// is present, the reviewed head is already durably recorded there (the exact
// `- **Stage 1:** correction-satisfied at <corrected-head> (reviewed <reviewed-head>)` bullet
// `finalize-correction-breakpoint.mjs` persisted), so the worker reads it from that bullet
// instead of it being restated in the prompt — keeping this template immune to SHA length
// regardless of how long a real commit SHA is. Only `next-review-transition-gate.mjs`'s rare
// no-control-Issue direct-reference path (a `--stage1-disposition` supplied ad hoc, with no
// durable bullet anywhere) has nowhere else for the worker to recover it, so `reviewedHead` is
// required only in that one case.
//
// The worker's job: integrate the current target branch into the PR branch with a real merge
// commit (never rebase/force-push — `stage1-correction-gate.mjs`'s own ancestry check requires
// the final head to remain a strict, non-diverged descendant of the reviewed head), resolve
// only the conflicts needed for current target-branch authority plus this execution's
// already-accepted outcome, rerun verification, push via the reservation's own `pushRefspec`,
// and re-run `finalize-correction-breakpoint.mjs` (same reviewed head, the new pushed head) to
// re-establish correction-satisfied evidence at the new live head before releasing the binding
// and stopping. A conflict that instead requires a new semantic/product/architecture/security/
// privacy decision fails closed as a founder interrupt rather than being auto-resolved — this
// template says so explicitly rather than leaving it to be inferred.
export function formatConflictRecoveryWorkerDispatchPrompt({ controlIssue = null, issue, pr, reviewedHead = null, checkoutBinding = null }) {
  if (!isPositiveInteger(pr)) {
    throw new Error("formatConflictRecoveryWorkerDispatchPrompt requires pr to be a positive integer");
  }
  const hasExecutionIssue = issue !== "none";
  if (hasExecutionIssue && !isPositiveInteger(issue)) {
    throw new Error(
      'formatConflictRecoveryWorkerDispatchPrompt requires issue to be a positive integer or the literal "none" sentinel',
    );
  }
  const hasControlIssue = controlIssue !== null && controlIssue !== undefined;
  if (hasControlIssue && !isPositiveInteger(controlIssue)) {
    throw new Error("formatConflictRecoveryWorkerDispatchPrompt requires controlIssue to be a positive integer when present");
  }
  if (!hasControlIssue && (typeof reviewedHead !== "string" || !reviewedHead.trim())) {
    throw new Error(
      "formatConflictRecoveryWorkerDispatchPrompt requires a non-empty reviewedHead when controlIssue is absent " +
        "(no durable Stage 1 bullet exists for the worker to recover it from otherwise)",
    );
  }
  assertCheckoutBinding(checkoutBinding, "formatConflictRecoveryWorkerDispatchPrompt", "a conflict-recovery dispatch");
  const { path, token, scriptPath } = checkoutBinding;
  const executionLine = hasExecutionIssue ? ` Execution Issue: #${issue}.` : "";
  const controlLine = hasControlIssue ? ` Controlling Issue: #${controlIssue}.` : "";
  const reviewedHeadClause = hasControlIssue
    ? "reviewed head: Controlling Issue's Stage 1 bullet"
    : `reviewed head: ${reviewedHead}`;
  return (
    `Conflict-recovery worker dispatch.${executionLine} PR: #${pr}.${controlLine}\n\n` +
    renderPreBoundCheckoutClause({ path, token, scriptPath, pr }) +
    `Correction-satisfied reserved head (${reviewedHeadClause}) conflicts with target. Merge target in ` +
    `(never rebase/force-push); a semantic/security conflict is a founder interrupt, not auto-resolved. ` +
    `Verify, push, run tools/orchestration/finalize-correction-breakpoint.mjs (nonzero: ` +
    `CORRECTION_BREAKPOINT_UNVERIFIED), --release-binding ${token}; no re-review, merge, or Stage 2.`
  );
}

// Pure. Same reference-only size proxy diagnostic-trace.mjs's classifyPreDispatch uses
// (DEFAULT_REFERENCE_THRESHOLD_CHARS = 700), duplicated rather than imported: this
// directory and tools/telemetry are separate consumer-distributed units that should not
// depend on each other's internals (the same reasoning ready-dispatch-gate.mjs's module
// comment already gives for its own small parseHeadingField copy).
const REFERENCE_ONLY_THRESHOLD_CHARS = 700;

export function assertReferenceOnly(promptText, thresholdChars = REFERENCE_ONLY_THRESHOLD_CHARS) {
  if (promptText.length > thresholdChars) {
    throw new Error(
      `formatDispatchPrompt produced a ${promptText.length}-char prompt, over the ${thresholdChars}-char reference-only threshold — this should be structurally impossible from the fixed template; check for an unusually long route value`,
    );
  }
  return promptText;
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

function readStdinIfPiped() {
  try {
    if (process.stdin.isTTY) return null;
    const raw = readFileSync(0, "utf8").trim();
    return raw ? raw : null;
  } catch {
    return null;
  }
}

// #397's two new templates are selected by the piped gate result's own `state` field —
// ready-dispatch-gate.mjs's READY_TO_DISPATCH_PLANNING/READY_TO_DISPATCH_INTEGRATION verdicts
// — never by a caller re-deciding which template applies. READY_TO_DISPATCH keeps using the
// original "Implementation worker dispatch" template unchanged. Issue #498 unit 498-B adds
// REPLAN_REQUIRED, selecting formatPlanningCorrectionWorkerDispatchPrompt the same way. Every
// non-implementation template takes its own fixed field set (see each formatter's own comment
// for why), so the fields piped through differ by kind. Issue #570 adds `STAGE1_CORRECTION_
// REQUIRED`/`STAGE2_CORRECTION_REQUIRED` — `next-review-transition-gate.mjs`'s own verdict
// field names (`issue`, `pr`, `auditIssue`, `controlIssue`) are used verbatim as the field keys
// here rather than translated to `executionIssue`, so piped-JSON mode reads them straight off
// the verdict object exactly like every other row in this table.
const TEMPLATES_BY_STATE = {
  READY_TO_DISPATCH: { formatter: formatDispatchPrompt, fields: ["controlIssue", "executionIssue", "route"] },
  READY_TO_DISPATCH_PLANNING: { formatter: formatPlanningWorkerDispatchPrompt, fields: ["controlIssue", "executionIssue"] },
  READY_TO_DISPATCH_INTEGRATION: { formatter: formatIntegrationWorkerDispatchPrompt, fields: ["controlIssue", "executionIssue"] },
  REPLAN_REQUIRED: {
    formatter: formatPlanningCorrectionWorkerDispatchPrompt,
    fields: ["controlIssue", "executionIssue", "planIndexUrl", "replanRequiredUnitIds"],
  },
  STAGE1_CORRECTION_REQUIRED: {
    formatter: formatStage1CorrectionWorkerDispatchPrompt,
    fields: ["controlIssue", "issue", "pr", "correctionReason", "checkoutBinding"],
  },
  STAGE2_CORRECTION_REQUIRED: { formatter: formatStage2CorrectionWorkerDispatchPrompt, fields: ["controlIssue", "auditIssue"] },
  STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT: {
    formatter: formatConflictRecoveryWorkerDispatchPrompt,
    fields: ["controlIssue", "issue", "pr", "reviewedHead", "checkoutBinding"],
  },
};

// Explicit-fields mode's equivalent of the state-based selection above, for a caller
// re-rendering a prompt outside a live pipe (e.g. this script's own tests). Defaults to
// "implementation" so every pre-existing explicit-fields invocation keeps working unchanged.
// "planning-correction" accepts --plan-index-url and comma-separated --replan-unit-ids in
// place of --route, matching formatPlanningCorrectionWorkerDispatchPrompt's own field set.
// CLI flag names differ from the in-memory field names for the two multi-word fields
// (planIndexUrl -> --plan-index-url, replanRequiredUnitIds -> --replan-unit-ids, parsed as a
// comma-separated list); every other field's flag is its own camelCase name kebab-cased.
// Issue #570: "stage1-correction" and "stage2-correction" mirror the piped-mode field names
// above (`issue`/`pr`/`auditIssue`), each with their own CLI flag per CLI_FLAG_BY_FIELD below.
const FORMATTERS_BY_KIND = {
  implementation: { formatter: formatDispatchPrompt, fields: ["controlIssue", "executionIssue", "route"] },
  planning: { formatter: formatPlanningWorkerDispatchPrompt, fields: ["controlIssue", "executionIssue"] },
  integration: { formatter: formatIntegrationWorkerDispatchPrompt, fields: ["controlIssue", "executionIssue"] },
  "planning-correction": {
    formatter: formatPlanningCorrectionWorkerDispatchPrompt,
    fields: ["controlIssue", "executionIssue", "planIndexUrl", "replanRequiredUnitIds"],
  },
  "stage1-correction": {
    formatter: formatStage1CorrectionWorkerDispatchPrompt,
    fields: ["controlIssue", "issue", "pr", "correctionReason", "checkoutBinding"],
  },
  "stage2-correction": { formatter: formatStage2CorrectionWorkerDispatchPrompt, fields: ["controlIssue", "auditIssue"] },
  "conflict-recovery": {
    formatter: formatConflictRecoveryWorkerDispatchPrompt,
    fields: ["controlIssue", "issue", "pr", "reviewedHead", "checkoutBinding"],
  },
};

const CLI_FLAG_BY_FIELD = {
  controlIssue: "control-issue",
  executionIssue: "execution-issue",
  route: "route",
  planIndexUrl: "plan-index-url",
  replanRequiredUnitIds: "replan-unit-ids",
  issue: "issue",
  pr: "pr",
  auditIssue: "audit-issue",
  correctionReason: "correction-reason",
  reviewedHead: "reviewed-head",
};

// Pure. Reads one field's value out of an explicit-fields `args` map or a piped gate-result
// JSON object, applying each field's own type coercion (issue numbers to Number,
// replanRequiredUnitIds to an array — comma-split for the CLI flag, passed through as-is from
// piped JSON where the gate already emits a real array).
//
// Stage 1 review finding on this PR (P1): `issue` is the one field of this group that can
// legitimately carry the literal string "none" (next-review-transition-gate.mjs's
// direct-reference no-work-issue path — see formatStage1CorrectionWorkerDispatchPrompt's own
// comment). `Number("none")` is `NaN`, which is not a valid sentinel the formatter recognizes,
// so "none" must pass through unchanged rather than being coerced. `controlIssue`/
// `executionIssue`/`pr`/`auditIssue` have no such sentinel — a real GitHub reference or absent —
// so they keep the plain Number coercion.
function readField(field, source, { isCli }) {
  // Issue #703: piped mode reads the `checkoutBinding` object `pr-head-checkout-preflight.mjs
  // --reserve-from-gate` added to the verdict; explicit-fields mode rebuilds it from
  // --binding-path/--binding-token/--binding-script-path (the Stage 1 finding P1 addition on PR
  // #710 -- any present or none).
  if (field === "checkoutBinding") {
    if (!isCli) return source.checkoutBinding ?? null;
    const path = source["binding-path"];
    const token = source["binding-token"];
    const scriptPath = source["binding-script-path"];
    return path != null || token != null || scriptPath != null
      ? { path: path ?? null, token: token ?? null, scriptPath: scriptPath ?? null }
      : null;
  }
  if (field === "issue") {
    const raw = isCli ? source[CLI_FLAG_BY_FIELD[field]] : source[field];
    if (raw == null) return null;
    return raw === "none" ? "none" : Number(raw);
  }
  if (field === "controlIssue" || field === "executionIssue" || field === "pr" || field === "auditIssue") {
    const raw = isCli ? source[CLI_FLAG_BY_FIELD[field]] : source[field];
    return raw != null ? Number(raw) : null;
  }
  if (field === "replanRequiredUnitIds") {
    if (isCli) {
      const raw = source[CLI_FLAG_BY_FIELD[field]];
      return raw != null ? raw.split(",").map((s) => s.trim()).filter(Boolean) : null;
    }
    return source.replanRequiredUnitIds ?? null;
  }
  return isCli ? (source[CLI_FLAG_BY_FIELD[field]] ?? null) : (source[field] ?? null);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let formatter;
  let fields = null;
  if (args["control-issue"] || args["execution-issue"] || args.route || args.kind) {
    const kind = args.kind ?? "implementation";
    const entry = FORMATTERS_BY_KIND[kind];
    if (!entry) {
      process.stderr.write(
        `format-dispatch-prompt.mjs: unknown --kind ${JSON.stringify(kind)} — use "implementation", "planning", ` +
          `"integration", "planning-correction", "stage1-correction", "stage2-correction", or "conflict-recovery"\n`,
      );
      process.exit(2);
      return;
    }
    formatter = entry.formatter;
    fields = Object.fromEntries(entry.fields.map((f) => [f, readField(f, args, { isCli: true })]));
  } else {
    const stdin = readStdinIfPiped();
    if (!stdin) {
      process.stderr.write(
        "format-dispatch-prompt.mjs: pipe ready-dispatch-gate.mjs's JSON output on stdin, or pass --control-issue/--execution-issue/--route (and optionally --kind) explicitly\n",
      );
      process.exit(2);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(stdin);
    } catch (err) {
      process.stderr.write(`format-dispatch-prompt.mjs: could not parse stdin as JSON: ${err.message}\n`);
      process.exit(2);
      return;
    }
    // Stage 1 review finding on this PR (pre-#397): the original `parsed.state &&
    // parsed.state !== "READY_TO_DISPATCH"` check only rejected an explicit non-ready
    // state — a payload that omitted `state` entirely (a malformed or schema-drifted gate
    // result that still happened to carry controlIssue/executionIssue/route) fell through
    // this check and was formatted into a dispatch prompt anyway. `state` must be exactly
    // one of the recognized ready states above; anything else, including absent, is refused.
    const entry = TEMPLATES_BY_STATE[parsed.state];
    if (!entry) {
      process.stderr.write(
        `format-dispatch-prompt.mjs: input state is ${JSON.stringify(parsed.state ?? null)}, not "READY_TO_DISPATCH" ` +
          `(or "READY_TO_DISPATCH_PLANNING"/"READY_TO_DISPATCH_INTEGRATION"/"REPLAN_REQUIRED"/` +
          `"STAGE1_CORRECTION_REQUIRED"/"STAGE2_CORRECTION_REQUIRED"/"STAGE1_CORRECTION_SATISFIED_MERGE_CONFLICT") — ` +
          "refusing to format a dispatch prompt for a non-ready or malformed gate result\n",
      );
      process.exit(2);
      return;
    }
    formatter = entry.formatter;
    fields = Object.fromEntries(entry.fields.map((f) => [f, readField(f, parsed, { isCli: false })]));
  }

  // Issue #703: a pre-bound checkout path is machine-generated data, not restated prose, and its
  // length depends on where the repository is cloned -- it is excluded from the reference-only
  // budget (it is itself capped at 200 chars by the formatter), so the fixed template text stays
  // held to the same 700-char threshold as every other template. Stage 1 finding P1 on PR #710
  // adds `scriptPath` (the controller's own absolute path to pr-head-checkout-preflight.mjs) to
  // the template, machine-generated the same way and capped the same way, so it gets the same
  // budget exclusion.
  const bindingAllowance =
    (typeof fields?.checkoutBinding?.path === "string" ? fields.checkoutBinding.path.length : 0) +
    (typeof fields?.checkoutBinding?.scriptPath === "string" ? fields.checkoutBinding.scriptPath.length : 0);
  let prompt;
  try {
    prompt = assertReferenceOnly(formatter(fields), REFERENCE_ONLY_THRESHOLD_CHARS + bindingAllowance);
  } catch (err) {
    process.stderr.write(`format-dispatch-prompt.mjs: ${err.message}\n`);
    process.exit(1);
    return;
  }

  process.stdout.write(`${prompt}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("format-dispatch-prompt.mjs")) {
  main();
}
