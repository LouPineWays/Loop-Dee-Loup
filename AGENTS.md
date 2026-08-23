# Agent operating contract

Read this file before acting in this repository.

## Purpose

Loop-Dee-Loup is a hyper-lean, issue-dispatched execution loop. Durable state belongs in concise, authoritative artifacts. Conversation history and issue comments are not the source of truth.

Version one has no persistent controller daemon. The founder starts or resumes a Claude Code session with a terse issue reference. The session autonomously executes one vertical slice, verifies it, updates durable state, prepares the next slice, and stops at a clean boundary.

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

A founder decision, external manual action, post-merge audit, or genuinely independent correction may create a separate control boundary. Label it by its actual purpose rather than pretending it is a product slice.

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
- convert only founder-accepted independent outcomes into Burn Order candidates. A target repository's Burn Order (e.g. Covenant's) is that repository's own prioritized backlog; Loop-Dee-Loup does not create or own it. Loop-Dee-Loup separately maintains its own Burn Order for items about the Loop itself — see `docs/burn-order.md`. Never merge the two;
- record dependencies and proposed priority without duplicating the parent snapshot;
- discard rejected options and unaccepted suggestions.

A subsequent form is allowed only when the completed answers expose a new founder-level blocker that could not reasonably have been batched earlier. If two consecutive form rounds still produce no implementable vertical slice, diagnose a defective proposal, missing authority, or bad decomposition before generating the next consolidated form. Do not repeat questions already answered.

If exactly one unforeseeable founder question blocks an in-progress slice, a direct concise question is allowed. Do not artificially hold it for a future batch.

## Lean operating rules

- Decompose only enough to identify the next safe vertical slice.
- Do not manufacture epics, sprints, ceremonies, departments, personas, or role handoffs unless they solve an observed control problem.
- Do not create an issue merely because another conversation turn is needed.
- Read only the files and issue bodies needed for the active slice.
- Do not recursively retrieve comments, closed issues, old PR discussions, or logs by default.
- Do not expand scope merely because adjacent work is visible.
- Preserve the target repository's IP boundary, branching, testing, review, merge, release, and destructive-action rules.

## Session execution

After dispatch, the session must:

1. load the parent snapshot and active slice;
2. complete all internal steps required by the slice without routine founder confirmation;
3. independently verify the claimed outcome;
4. update the parent snapshot with durable facts only;
5. create or designate exactly one next vertical slice when product work remains;
6. stop at the slice boundary with a concise handoff.

Do not ask whether to proceed with mechanically determined implementation, checks, verified review corrections, or handoff preparation. A new session start may be required to continue, but that is scheduling rather than approval.

Once the founder has responded in an active session (e.g. answering review questions, completing a decision form, or clarifying an issue), continue mechanically through the resulting work — implementation, checks, fixes, PR — without pausing for routine confirmation. Stop only at a genuine completion, a founder interrupt condition, or a real blocker, and say which.

## Subagent dispatch

Within a session the founder has already started, delegating work to subagents is the default way to keep the primary session's context lean — not merely approved for read-heavy or exploratory work (issue/PR reads, research, the Stage 2 audit trigger/wait/extract), but expected for implementation work between issues and PRs too: writing or editing files, running commands, committing, and opening PRs. It is a context-isolation technique, not a control boundary, and does not require separate founder approval.

The reason is chat discipline: top-level session chat should stay limited to the fixed one-line formats in "Fixed chat report formats" below, with step-by-step mechanics happening inside subagent dispatches rather than being narrated in the top-level chat.

It becomes the automatic session launcher the Prototype guardrail defers only if a session uses subagent dispatch to originate work on new issues or PRs on its own initiative, without the founder having started that session in the first place. The gate that must never be bypassed is *who starts the session*, not *what the session delegates internally once running*.

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
- Clean completion: `CLEAN — <what merged/closed>. Next: #<slice>` (or `Next: None`).
- Blocked: `BLOCKED — <one clause>. Next: <manual action>` (or `Next: None`).

An ad-hoc issue — one not created from a structured template (`parent-execution`, `work-packet`, `founder-decision-form`, `audit-control-issue`, `idea-intake`) — gets a single terse line for a body, not prose paragraphs. Templates keep their required fields.

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
- next slice.

History may remain in comments for auditability, but executors must not normally read it.

## Loop-Dee-Loup Burn Order

Loop-Dee-Loup maintains its own Burn Order — a prioritized backlog of process/tooling items about the Loop itself, distinct from and never merged with any target repository's own Burn Order. Full spec, artifact location, and the idea-intake-to-Burn-Order conversion procedure are in `docs/burn-order.md`.

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
- `skill-observer` captures proven defects in skills and operating rules;
- `retro` converts completed-cycle evidence into at most three process corrections;
- `spend` attributes token cost to validated progress and identifies avoidable waste;
- `context-clearing` verifies that a PR or issue is a self-sufficient durable handoff before a session clears or yields;
- `persona-maker` creates a durable, reusable expertise profile (`.claude/personas/*.md`) for a recurring class of subagent work;
- `script-maker` converts a demonstrated, repeated deterministic repository operation into a checked, documented script;
- `skill-maker` creates a new narrowly-triggered skill when a recurring judgment-dependent workflow has become stable enough to encode.
- `local-worker` invokes a configured local LLM for bounded, cheaply-verifiable subtasks that `model-check` routes to local execution; its output is candidate work requiring independent Claude verification before acceptance.

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

## Prototype guardrail

The first trial is Covenant's remaining `wolfscairn-list-and-privacy` work after PR #94. The execution slice ships the complete Buttondown signup surface, including form, CSP, presentation, tests, documentation, and integration. Do not split those layers into separate issues. Do not build an automatic session launcher or generalize the controller until evidence from this trial justifies it.
