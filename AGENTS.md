# Agent operating contract

Read this file before acting in this repository.

If you are reading this file inside a consumer repository rather than Loop-Dee-Loup itself, it was installed by `tools/ldl-init` — see that consumer repository's `docs/consumer-contract.md` for the installed ownership boundary and update path. Sections wrapped in `<!-- ldl:source-only:start/end -->` markers in Loop-Dee-Loup's own copy of this file are Loop-Dee-Loup's own instance state and are stripped before installation; they will not appear here.

## Purpose

Loop-Dee-Loup is a hyper-lean, issue-dispatched execution loop. Durable state belongs in concise, authoritative artifacts. Conversation history and issue comments are not the source of truth.

Version one has no persistent controller daemon. The founder starts or resumes a Claude Code session with a terse issue reference. When the issue is one bounded vertical slice, the session autonomously executes it, verifies it, updates durable state, and stops at a clean boundary. When the issue instead requires multiple independently executable slices, the session performs decomposition — materializing every currently foreseeable slice as its own durable issue — and stops without executing any of them; see Decomposition boundary.

## Authority

Use this order when claims conflict:

1. The active slice issue's explicit outcome and acceptance criteria.
2. The current parent issue snapshot.
3. The target repository's governing instructions and source of truth.
4. Loop-Dee-Loup documentation.
5. Issue comments and historical discussion.

Escalate unresolved contradictions. Do not silently reconcile them.

## Vertical-slice rule

Every execution issue must be the kind of bounded assignment that could be dispatched to one capable subagent.

It must:

- deliver one coherent capability, correction, or closure outcome;
- cross every technical layer necessary for that outcome;
- include its own tests, documentation, configuration, and verification where applicable;
- be independently assessable and mergeable;
- leave the product and repository valid if no later slice is executed.

Do not create separate execution issues for exploration, implementation layer, tests, documentation, review response, or session continuation when they serve the same outcome. Those are steps inside the slice.

A slice must also be vertical, not horizontal: it must produce a usable, observable portion of the parent outcome, not merely a layer, inventory, subsystem, or category of inputs toward it — except a legitimate enabling slice, which is authorized instead to remove a demonstrated blocker or serve as a genuine prerequisite for the very next vertical slice, provided it has its own independently verifiable outcome (see `docs/operating-model.md` § Vertical vs horizontal decomposition for the exact bar; a step with no independently verifiable outcome of its own is speculative work, not a legitimate exception). A plan whose first usable portion of the outcome would appear only after every layer or every item in a category is built is a decomposition failure, even when each resulting ticket looks individually bounded and the plan would eventually produce something usable. See `docs/operating-model.md` § Vertical vs horizontal decomposition for the full definitions, the decomposition self-check, the correction procedure, and worked examples.

A founder decision, external manual action, post-merge audit, or genuinely independent correction may create a separate control boundary. Label it by its actual purpose rather than pretending it is a product slice.

## Decomposition boundary

Decomposition and execution are separate control boundaries.

If an issue is completable as one bounded vertical slice under the rule above, execute it normally under Session execution.

If it genuinely requires multiple independently executable vertical slices, the current session becomes a decomposition session. Once that determination is made, the session must not begin implementing any resulting slice — not even the first one, and not "to save a session."

Before a decomposition session ends, it must:

1. apply the decomposition self-check (`docs/operating-model.md` § Vertical vs horizontal decomposition): ask when, if every planned issue completed in order, the first independently usable, observable, verified portion of the parent outcome would exist — if the answer is only after several horizontal issues are all complete, the plan is horizontal and must be reframed around vertical outcomes before proceeding, even though the finished plan would eventually be usable;
2. determine every currently foreseeable, implementation-ready vertical slice — not speculative work whose need depends on discoveries not yet made by an earlier slice;
3. create one self-sufficient execution issue for each slice (the vertical-slice template), containing enough of the outcome, constraints, acceptance criteria, and dependencies that a fresh session can execute it without reconstructing this conversation;
4. record genuine dependencies between those slices using GitHub's native issue relationships (Blocked by / Blocking), not free-text cross-references alone;
5. close the source issue as a durable decomposition record — retaining its objective, settled decisions, scope and non-goals, the resulting slice list, dependencies, and any unresolved external dependency — rather than leaving it open to sequentially point from one child to the next;
6. stop.

Do not manufacture speculative future slices merely to complete a project tree: create only slices that are currently foreseeable and implementation-ready, not branches whose shape depends on an outcome not yet known.

A resulting slice begins only when the founder explicitly dispatches it in a fresh session (e.g. "Work on #123"). Creating a slice — including during the same decomposition session that just created it — does not authorize beginning it. Do not infer dispatch from having just created the issue.

Once dispatched, a slice runs autonomously per Session execution and the bounded review cycle until it reaches CLEAN completion or a genuine founder interrupt or unrecoverable blocker applies. CLEAN completion of one slice does not authorize beginning a sibling slice created in the same decomposition, even one that is now unblocked, obviously next, or has no remaining founder decision. The founder chooses which executable issue to dispatch next.

## Founder decision-form rule

Serial founder interrogation is prohibited.

Before requesting product input:

1. inspect the proposal, parent snapshot, target repository authority, and currently visible critical path;
2. distinguish founder decisions from technical choices the session should make autonomously;
3. collect every currently knowable founder question that blocks forming or completing vertical slices;
4. generate one self-contained decision form rather than asking those questions sequentially.

Every form question must state the blocking consequence, offer two or three mutually exclusive options where appropriate, recommend one option with tradeoffs, provide a suggested default, and include free-comment space. The form must end with a general comments field.

Do not use a decision form for technical choices already governed by repository authority. Do not ask speculative downstream questions that do not affect a currently visible slice.

After the founder returns the whole form:

- normalize the answers into settled parent-snapshot decisions;
- derive implementable vertical slices from the critical path;
- convert only founder-accepted independent outcomes into backlog items. A target repository's Burn Order (e.g. Covenant's) is that repository's own prioritized backlog; Loop-Dee-Loup does not create or own it. An outcome about the Loop itself instead becomes a GitHub Issue on Loop-Dee-Loup's own repository, carrying one `priority:now`/`priority:soon`/`priority:later`/`priority:wishes` label — see `docs/priority-horizons.md`. Never merge the two;
- record dependencies and proposed priority without duplicating the parent snapshot;
- discard rejected options and unaccepted suggestions.

A subsequent form is allowed only when the completed answers expose a new founder-level blocker that could not reasonably have been batched earlier. If two consecutive form rounds still produce no implementable vertical slice, diagnose a defective proposal, missing authority, or bad decomposition before generating the next consolidated form. Do not repeat questions already answered.

If exactly one unforeseeable founder question blocks an in-progress slice, a direct concise question is allowed. Do not artificially hold it for a future batch.

## Lean operating rules

- When an issue is one bounded vertical slice, decompose no further than that slice. When it genuinely requires multiple slices, materialize every currently foreseeable one in the same decomposition session — see Decomposition boundary — rather than creating only the next and deferring the rest.
- Do not manufacture epics, sprints, ceremonies, departments, personas, or role handoffs unless they solve an observed control problem.
- Do not create an issue merely because another conversation turn is needed.
- Read only the files and issue bodies needed for the active slice.
- Do not recursively retrieve comments, closed issues, old PR discussions, or logs by default.
- Do not expand scope merely because adjacent work is visible.
- Preserve the target repository's IP boundary, branching, testing, review, merge, release, and destructive-action rules.

## Session execution

After dispatch, first apply the Decomposition boundary: determine whether the active issue is one bounded vertical slice or genuinely requires decomposition into multiple. A multi-slice determination ends the session there, per that section.

For a single bounded vertical slice, the session must:

1. load the parent snapshot and active slice;
2. complete all internal steps required by the slice without routine founder confirmation;
3. independently verify the claimed outcome;
4. update the parent snapshot with durable facts only;
5. create or designate at most one next vertical slice, and only when completing this slice exposes genuinely new follow-on work that was not already foreseeable at dispatch;
6. stop at the slice boundary with a concise handoff.

Do not ask whether to proceed with mechanically determined implementation, checks, verified review corrections, or handoff preparation. A new session start may be required to continue, but that is scheduling rather than approval.

Once the founder has responded in an active session (e.g. answering review questions, completing a decision form, or clarifying an issue), continue mechanically through the resulting work — implementation, checks, fixes, PR — without pausing for routine confirmation. Stop only at a genuine completion, a founder interrupt condition, or a real blocker, and say which.

## Subagent dispatch

Within a session the founder has already started, delegating work to subagents is the default way to keep the primary session's context lean — not merely approved for read-heavy or exploratory work (issue/PR reads, research, the Stage 2 audit trigger/wait/extract), but expected for implementation work between issues and PRs too: writing or editing files, running commands, committing, and opening PRs. It is a context-isolation technique, not a control boundary, and does not require separate founder approval.

The reason is chat discipline: top-level session chat should stay limited to the fixed one-line formats in "Fixed chat report formats" below, with step-by-step mechanics happening inside subagent dispatches rather than being narrated in the top-level chat.

It becomes an automatic session launcher — the thing this repository defers building until evidence justifies it — only if a session uses subagent dispatch to originate work on new issues or PRs on its own initiative, without the founder having started that session in the first place. The gate that must never be bypassed is *who starts the session*, not *what the session delegates internally once running*.

## Session communication budget

Keep Claude Code messages deliberately terse. Normally send only:

- a brief kickoff acknowledgement;
- a link to one complete decision form, or one concise unforeseeable question/manual-action request when blocked;
- a bounded completion or blocked handoff.

Do not narrate repository exploration, repeat issue contents, provide speculative plans already settled by the slice, or use chat as the durable log. Put evidence and current state in GitHub.

### Fixed chat report formats

Use these exact one-line formats for the terminal chat message of each communication type above; do not expand them into prose. Full evidence stays in the linked issue or PR, not in chat.

- Kickoff: `Starting #<issue>.`
- Decision needed: `Decision needed: #<form-issue>.`
- Direct question: `Question: <one clause>?` — for the single unforeseeable founder question the decision-form rule allows mid-slice; do not open a decision-form issue for it.
- Clean completion: `CLEAN — <what merged/closed>. Next: #<slice>` (or `Next: None`). For a review-worthy PR, never emit this line — and never treat the slice as done in any other way — until `docs/bounded-review-cycle.md` Stage 1 step 8's composed `tools/review-watch/merge-ready-gate.mjs` returns exit 0 (`PRE_MERGE_READY` or `PRE_MERGE_READY_NO_WORK_ISSUE`) from durable GitHub evidence for that PR's frozen head. Completing implementation, tests, commit, push, and PR creation is not itself evidence Stage 1 happened, or that the PR carries no closing reference to its gated work issue; it is exactly the state in which the omission that produced LDL issue #32 and YouTubery issue #12 (Stage 1 alone) and LDL issue #214 (the closing-reference check alone, on YouTubery PR #49/#48) occurred, and the composed gate exists because prose reminders and two independently-invoked checks alike did not stop any of them.
- Blocked: `BLOCKED — <one clause>. Next: <manual action>` (or `Next: None`). Use this exact line, per `docs/bounded-review-cycle.md` Stage 1, when every merge prerequisite is satisfied but the execution environment itself refuses the merge operation — that is a manual execution handoff, not a re-opened founder decision about whether to merge.

An ad-hoc issue — one not created from a structured template (`parent-execution`, `work-packet`, `founder-decision-form`, `audit-control-issue`, `idea-intake`) — gets a single terse line for a body, not prose paragraphs. Templates keep their required fields.

Waiting on a Codex review or audit response (Stage 1 or Stage 2 of the bounded review cycle) is never a case for a hand-rolled polling loop — not via `Monitor`, `Bash`, or any other ad hoc `gh api` script against a guessed endpoint and bot login. Always use `tools/review-watch/trigger.mjs` to post the trigger. For the wait itself, use `tools/review-watch/poll.mjs`: it is the required mechanism for Stage 2, which has no event delivery; for Stage 1, prefer PR event delivery when the harness supports it and use `poll.mjs` as the no-subscription fallback, per `docs/bounded-review-cycle.md` Stage 1 step 3 and the paragraph after step 9, and Stage 2 steps 4-6. `poll.mjs` already checks every endpoint Codex can respond on for the given `--kind` (`pulls/.../comments`, `pulls/.../reviews`, and `issues/.../comments` for `--kind pr`; `issues/.../comments` for `--kind issue`) and the correct bot login including its `[bot]` suffix (`chatgpt-codex-connector[bot]`), and it exits the instant a post-trigger bot response appears instead of running for a fixed window — matching by login and timestamp only, so a match still requires the same classification (genuine vs. BLOCKED vs. a blocked mutation attempt) that Stage 1 step 3 and Stage 2 step 10 already require before it counts as a review result. A hand-rolled loop re-implementing this — even one that looks equivalent — has already been observed to silently miss the response by checking the wrong endpoint or an unsuffixed login string (issue #113); do not re-derive this logic from memory.

Before placing any self-check-in wakeup call (`ScheduleWakeup`, `send_later`, or a self-bound trigger) while babysitting a PR or issue between events, work through this checklist and do not place the call until every item holds:

1. An event subscription already covers this PR/issue, so the check-in is a fallback, not the primary signal.
2. Unless item 3 applies, the delay is 10–15 minutes — not a round default (30 minutes, an hour) reached for out of habit or because generic scheduling guidance elsewhere suggests it. This repo's bound is stricter and controls per the Authority order above, even over a tool's own generic "check in about an hour" suggestion.
3. A delay beyond 15 minutes is allowed only when the call's reason/name states the specific external wait it is bounded by (e.g. a stated CI duration). "Fewer interruptions" or "save tokens" are not valid reasons: a long gap does not save tokens here — a stale wake forces a full state reload of the PR/issue instead of a cheap incremental check.

Defaulting to an hour, or skipping this checklist, is the exact failure this rule exists to prevent.

## Founder interrupt conditions

Stop and ask one concise question only when existing authority cannot resolve:

- product intent or the desired user/business outcome;
- a material scope, UX, monetization, legal, privacy, security, or irreversible tradeoff;
- required credentials or an external action that only the founder can perform;
- a failed safety/correctness gate with no authorized recovery path;
- whether a newly discovered opportunity belongs inside the approved feature;
- a direct contradiction between controlling sources.

Record the answer in the parent snapshot so later sessions do not ask again.

## Parent snapshots

A parent issue body is a mutable current-state snapshot, not an append-only diary. It must keep:

- objective;
- current state;
- settled decisions;
- scope and non-goals;
- authoritative files;
- acceptance criteria;
- completed slices;
- current blocker;
- next slice, or, once decomposed, the resulting slice list and their dependencies.

History may remain in comments for auditability, but executors must not normally read it.

<!-- ldl:source-only:start -->
## Loop-Dee-Loup priority horizons

Loop-Dee-Loup prioritizes its own process/tooling backlog directly on GitHub Issues — `priority:now`, `priority:soon`, `priority:later`, `priority:wishes` labels, plus native GitHub `blocked by`/`blocking` relationships — distinct from and never merged with any target repository's own backlog mechanism (e.g. Covenant's Burn Order). Full spec, label semantics, and the idea-intake-to-priority-horizon conversion procedure are in `docs/priority-horizons.md`.
<!-- ldl:source-only:end -->

## Slice handoff

A completed slice reports:

- STATUS
- OUTCOME
- CHANGED
- VERIFIED
- DECISIONS
- NEW RISKS
- NEXT
- PR

Target at most 1,000–1,500 tokens for the complete durable handoff. The chat summary should be much shorter and link to that record.


## Operational skills

Repository-local skills support the Loop without replacing the active issue or target-repository authority:

- `model-check` selects the cheapest safe model, effort, and execution shape before dispatch;
- `sift` screens external tools and workflows before adoption;
- `retro` converts completed-cycle evidence into at most three process corrections;
- `spend` attributes token cost to validated progress and identifies avoidable waste;
- `context-clearing` verifies that a PR or issue is a self-sufficient durable handoff before a session clears or yields;
- `persona-maker` creates a durable, reusable expertise profile (`.claude/personas/*.md`) for a recurring class of subagent work;
- `script-maker` converts a demonstrated, repeated deterministic repository operation into a checked, documented script;
- `skill-maker` creates a new narrowly-triggered skill when a recurring judgment-dependent workflow has become stable enough to encode.
- `local-worker` invokes a configured local LLM for bounded, cheaply-verifiable subtasks that `model-check` routes to local execution; its output is candidate work requiring independent Claude verification before acceptance.
- `stage1-classifier-hardening` diagnoses and fixes a reported false-positive/false-negative in the Stage 1 genuine-response classifier (`tools/review-watch/genuine-response.mjs`).
<!-- ldl:source-only:start -->
- `telemetry-battery` runs the approximately-weekly `/spend` + maker telemetry validation battery (`docs/telemetry-battery-log.md`), gating optimization conclusions on telemetry coverage rather than assuming instrumentation is sufficient. Not distributed to consumers (`tools/telemetry/` itself is deliberately not part of `tools/ldl-init`'s manifest, per `docs/consumer-contract.md`), so this line is Loop-Dee-Loup's own instance state, not installed guidance.
<!-- ldl:source-only:end -->

Durable personas live under `.claude/personas/*.md`, one file per recurring subagent role (see `persona-maker`). Dispatch a subagent by pointing it at the matching persona file instead of restating its expertise in the prompt.

Invoke only the skill relevant to the current control problem. A skill run is normally an internal activity, not a separate issue or conversational ceremony. Do not run every skill on every slice.

Treat token use as an observable operating metric. Optimize validated progress per token, not raw token minimization. Preserve correctness and safety gates. Prefer built-in usage/context reports, bounded reads, deterministic checks, compressed current truth, and fresh-session application of process corrections. Distinguish observed waste from hypothesized waste.

When a workflow failure is systemic, make the smallest governing correction at the earliest safe boundary. Do not change rules underneath an in-flight correctness-sensitive step. Prefer updating the authoritative skill, checklist, script, or gate over relying on memory or creating a vague future process backlog.

### Context-cost boundaries

Open or update the self-sufficient PR or issue record before clearing, compacting, ending, or handing off a session. The durable record must state the outcome, scope, evidence, blockers, review stage, exact refs, and next authorized action so a successor with zero conversation memory can continue safely.

Treat the Stage 1 review request and a CLEAN Stage 2 close as natural fresh-session boundaries. Run `spend` before a destructive context clear when the completed session is worth measuring. Do not retain an implementation-heavy session merely to wait for CI, review, or an issue audit.

Use event delivery for PR activity when the available harness supports it. Do not add long timer-driven fallback waits that keep a large context alive when an event subscription already covers the state change. Issue-based audit responses are different: if no event delivery exists, delegate the trigger, bounded wait, and result extraction to one disposable worker or successor context. It must return only CLEAN/NOT CLEAN, severity counts, and the finding text required for action, never the complete audit transcript or command log.

Once a bounded review cycle is authorized and underway, continue through verified findings, consolidated corrections, checks, merge, and the next audit without asking routine permission between those mechanically required steps. Founder interrupt conditions still stop the cycle.

## Bounded review cycle

For review-worthy work, preserve any stricter target-repository policy and follow `docs/bounded-review-cycle.md` otherwise:

1. one inline independent PR review at a frozen head, requested by posting `@codex review` as a PR comment;
2. verify and deduplicate all findings;
3. batch all valid fixes and rerun checks;
4. merge without a second inline invocation only when no known blocker remains;
5. run one holistic, read-only issue audit of the exact merge commit;
6. trigger Codex from a separate issue comment containing `@codex review`, not from the issue body, after checking that no trigger already exists;
7. treat posting the issue trigger and arranging its bounded follow-up as one atomic action;
8. extract only the compact verdict needed by the controlling session;
9. close on CLEAN, or create one consolidated correction outcome on NOT CLEAN.

“One inline round” limits reviewer invocations; it never authorizes merging a known defect. The post-merge audit is a control issue and the stopping review for that cycle.

**Codex, triggered by `@codex review` in a comment, is the only reviewer for both stages.** Never substitute or supplement it with another review-request tool or mechanism (e.g. a native "request Copilot review" action) — if Codex is silent or slow, that is latency to wait out via event subscription and short check-ins, not a reason to reach for a different reviewer.

## Code Review Rules

This section governs any invocation triggered by `@codex review` in this repository — both the Stage 1 PR review and the Stage 2 issue audit defined in `docs/bounded-review-cycle.md`. Codex's GitHub integration reads a `## Code Review Rules` heading in `AGENTS.md` to determine review-invocation behavior; this is that heading.

When invoked through `@codex review`, Codex acts as an **independent reviewer only**. It may:

- inspect the requested PR or audit target;
- inspect applicable repository context needed to evaluate it;
- report actionable review findings;
- post the requested review/audit response.

It must not:

- modify repository files;
- create commits;
- push branches;
- open or update pull requests;
- implement its own findings;
- merge code;
- begin or continue a correction cycle;
- otherwise mutate repository contents as part of the review invocation.

This reviewer-only boundary is separate from — and does not narrow — the broader implementation and correction authority this file grants elsewhere to the controlling LDL execution session (Claude Code) and its implementation subagents under Session execution and Subagent dispatch. That broader authority belongs to the executor. A `@codex review` invocation never inherits it, regardless of what the executor is authorized to do in the same repository.

A Codex finding ends the reviewer's responsibility for that finding. Verifying the finding and performing any authorized correction is the controlling LDL execution session's job, per the bounded review cycle in `docs/bounded-review-cycle.md`.

If a `@codex review` invocation attempts to modify a file, create a commit, push a branch, or open or update a PR, and is blocked because it lacks repository-content or branch write permission, treat that as the reviewer-role boundary working as intended. It is a violated reviewer-role boundary, not evidence that Codex needs more repository authority — do not grant `Contents: write` or equivalent mutation authority to the reviewer invocation in response. A mutating or blocked response is not accepted as a valid review result merely because Codex produced work, and it is not a genuine CLEAN/NOT CLEAN verdict either; the existing retry/PENDING/BLOCKED handling in `docs/bounded-review-cycle.md` applies instead.

<!-- ldl:source-only:start -->
## Prototype guardrail

The first trial is Covenant's remaining `wolfscairn-list-and-privacy` work after PR #94. The execution slice ships the complete Buttondown signup surface, including form, CSP, presentation, tests, documentation, and integration. Do not split those layers into separate issues. Do not build an automatic session launcher or generalize the controller until evidence from this trial justifies it.
<!-- ldl:source-only:end -->
