# Agent operating contract

Read this file before acting in this repository. It is a router, not a manual: it holds only the invariants needed for nearly every control decision. Stage-specific mechanics live in `docs/*.md`, operational skills, and durable GitHub state, loaded when the current lifecycle stage actually needs them — see `docs/operating-model.md` for the full startup-contract rationale.

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

Every execution issue must be the kind of bounded assignment one capable subagent could implement and verify end to end: one coherent capability, correction, or closure outcome, crossing whatever layers that outcome needs (including its own tests, documentation, and configuration), independently assessable and mergeable, and leaving the repository valid if no later slice follows. Do not create separate execution issues for exploration, implementation layer, tests, documentation, review response, or session continuation when they serve the same outcome — those are steps inside the slice.

A slice must also be vertical, not horizontal: a usable, observable portion of the parent outcome, not merely a layer, inventory, subsystem, or category of inputs toward it — except a legitimate enabling slice, authorized instead to remove a demonstrated blocker or serve as a genuine prerequisite for the very next vertical slice, provided it has its own independently verifiable outcome. See `docs/operating-model.md` § Vertical vs horizontal decomposition for the full definitions, the decomposition self-check, the correction procedure, and worked examples.

A founder decision, external manual action, post-merge audit, or genuinely independent correction may create a separate control boundary. Label it by its actual purpose rather than pretending it is a product slice.

## Decomposition boundary

Decomposition and execution are separate control boundaries. An issue completable as one bounded vertical slice under the rule above executes normally under Session execution below. This boundary governs the execution work itself — inline slice execution, or a legacy unsplit issue whose shape has not yet been determined — not a READY thin control Issue whose linked execution pointer Session execution's immediate-dispatch gate already authorizes to dispatch by reference: that gate runs first and, when it applies, is not itself a decomposition determination.

An issue that genuinely requires multiple independently executable vertical slices instead triggers a decomposition session. The session must not begin implementing any resulting slice — not even the first one, and not "to save a session." Before it ends, it must: apply the decomposition self-check (`docs/operating-model.md` § Vertical vs horizontal decomposition); determine every currently foreseeable, implementation-ready slice; create one self-sufficient execution issue per slice, with enough outcome, constraints, acceptance criteria, and dependencies that a fresh session can execute it without reconstructing this conversation; record genuine dependencies using GitHub's native issue relationships, not free-text cross-references; close the source issue as a durable decomposition record retaining its objective, settled decisions, scope/non-goals, resulting slice list, and dependencies; and stop. See `docs/operating-model.md` § Decomposition boundary for the full six-step contract and worked examples — this paragraph is self-sufficient without it.

A resulting slice begins only when the founder explicitly dispatches it in a fresh session; creating a slice does not authorize beginning it. Once dispatched, a slice runs autonomously through Session execution and the bounded review cycle until CLEAN completion, a genuine founder interrupt, or an unrecoverable blocker. Completing one slice never authorizes starting a sibling from the same decomposition — the founder chooses what runs next.

## Founder decision-form rule

Serial founder interrogation is prohibited. Before requesting product input, distinguish founder decisions from technical choices the session should make autonomously, collect every currently knowable founder question that blocks forming or completing vertical slices, and generate one self-contained decision form rather than asking sequentially. Every form question must state the blocking consequence, offer two or three mutually exclusive options where appropriate, recommend one option with tradeoffs, and provide a suggested default; the form ends with a general comments field. Route completed answers by meaning: settled decisions into the parent snapshot, the current slice's details into its contract, and any accepted independent outcome into the correct backlog (a target repository's own backlog mechanism, or a `priority:*`-labeled Loop-Dee-Loup Issue — never merged). See `docs/decision-forms.md` for the full generation procedure and worked structure — this paragraph is self-sufficient without it.

A subsequent form is allowed only when the completed answers expose a new founder-level blocker that could not reasonably have been batched earlier; two consecutive forms producing no implementable slice means diagnose before generating a third. If exactly one unforeseeable founder question blocks an in-progress slice, ask it directly instead — do not hold it for a future batch.

## Lean operating rules

- When an issue is one bounded vertical slice, decompose no further than that slice. When it genuinely requires multiple slices, materialize every currently foreseeable one in the same decomposition session — see Decomposition boundary — rather than creating only the next and deferring the rest.
- Do not manufacture epics, sprints, ceremonies, departments, personas, or role handoffs unless they solve an observed control problem.
- Do not create an issue merely because another conversation turn is needed.
- Read only the files and issue bodies needed for the active slice.
- Do not recursively retrieve comments, closed issues, old PR discussions, or logs by default.
- Do not expand scope merely because adjacent work is visible.
- Preserve the target repository's IP boundary, branching, testing, review, merge, release, and destructive-action rules.

## Auto-memory boundary

A session's persistent auto-memory (where the execution environment provides one — session-level, keyed by working directory, outside this repository's git history) must not become a second project manual. It may hold founder preferences and process feedback under that memory system's own type definitions, but never backlog, issue/PR history, workflow procedure, or a duplicate of `AGENTS.md`/`docs/*.md` content — that state belongs in GitHub and this repository's docs, where every session and repository can read it, not in memory local to one environment. If a session notices memory drifting toward manual-duplication, prune it back rather than adding to it.

## Upstream-owned defects in LDL-managed content

If this repository has installed LDL-managed content (per `docs/consumer-contract.md`) and a session discovers a defect inside it — not in this repository's own project code — the default disposition is: do not edit the LDL-managed file locally; file the finding as an issue in the Loop-Dee-Loup repository this installation was derived from when the session has access to do so, otherwise record it durably in the consumer PR/issue record for the founder to file; and do not hold open or rewrite an otherwise-valid change solely because it inherits that defect. See `docs/consumer-contract.md` § Defects found in LDL-managed content for the upstream-vs-consumer-owned test and the full disposition. This does not excuse an independent, consumer-owned blocker in the same change.

## Session execution

After dispatch, first evaluate the READY immediate-dispatch gate, before the Decomposition boundary below and before any other tool call: when the dispatched issue could plausibly be a control-plane issue (its number was given directly, or a parent snapshot points at it as the current control issue), the session's first action is `node tools/orchestration/ready-dispatch-gate.mjs --control-issue <N>` — never a freeform `gh issue view` on that same issue first, and never with a hand-typed `--repo <owner>/<repo>`: the gate derives current repository identity deterministically from the checkout's own configured remote (issue #344), so the normal path never asks the controller to remember, infer, or type it; issue #321 is the record of two independent live sessions that read the control issue by hand and, in that same investigative step, also read the linked thick execution issue and queried unrelated PRs before dispatching, exactly the failure this script exists to make structurally impossible (it makes exactly one read: the control issue itself). On `READY_TO_DISPATCH`, dispatch the linked execution worker immediately by reference (issue number, controlling issue, route, all taken from the script's own output) and stop, with no other tool call in between — without reading that execution issue's body, judging its decomposition shape, or doing implementation reconnaissance first. Build the dispatch prompt by piping the gate's JSON output into `node tools/orchestration/format-dispatch-prompt.mjs` and using its stdout verbatim as the worker's prompt — do not compose the prompt by hand. A live #321 proof (`docs/diagnostic-traces/615f2b4a-69eb-42f1-bef6-432a4e32f4dc.json`) recorded a controller that correctly skipped every pre-dispatch read and still hand-composed a 2554-character prompt by restating AGENTS.md's own general contract sections into it — a distinct reference-only-size violation from the #283/#314 read-before-dispatch defect, closed the same way: by removing the composition step's freedom to grow, not by adding another prose reminder to compose carefully. That linked issue's own decomposition shape is the dispatched worker's concern, not a prerequisite the controller must resolve before handing off; see Subagent dispatch below for the two-plane read this gate protects, and `docs/operating-model.md` § Two-plane Issue dispatch for the closed exceptions (malformed/conflicting control state, an unresolved escalation, or similar) that still permit direct inspection. On `NOT_READY` (or when the gate script itself errors, or the issue is plainly not control-plane-shaped, e.g. a legacy unsplit issue with no "Current state" bullet block), the gate simply does not apply — fall through to the Decomposition boundary below and reason normally, including reading the issue's own body directly.

Only when that gate does not apply — the active issue is not a READY control issue with settled routing, or it is itself the execution/legacy-unsplit work to perform — apply the Decomposition boundary: determine whether the active issue is one bounded vertical slice or genuinely requires decomposition into multiple. A multi-slice determination ends the session there, per that section.

For a single bounded vertical slice, the session must:

1. load the parent snapshot and identify the active slice — read that slice's own body directly only when implementing it inline rather than dispatching a fresh subagent worker per Subagent dispatch's two-plane rule below;
2. complete all internal steps required by the slice without routine founder confirmation;
3. independently verify the claimed outcome;
4. update the parent snapshot with durable facts only;
5. create or designate at most one next vertical slice, and only when completing this slice exposes genuinely new follow-on work that was not already foreseeable at dispatch;
6. stop at the slice boundary with a concise handoff.

Do not ask whether to proceed with mechanically determined implementation, checks, verified review corrections, or handoff preparation — a new session start may be required to continue, but that is scheduling rather than approval. Once the founder has responded in an active session, continue mechanically through the resulting work without pausing for routine confirmation. Stop only at a genuine completion, a founder interrupt condition, or a real blocker, and say which.

## Subagent dispatch

Within a session the founder has already started, delegating work to subagents is the default way to keep the primary session's context lean — not merely approved for read-heavy or exploratory work, but expected for implementation work between issues and PRs too: writing or editing files, running commands, committing, and opening PRs. It is a context-isolation technique, not a control boundary, and does not require separate founder approval.

The reason is chat discipline: top-level session chat should stay limited to the fixed one-line formats in "Fixed chat report formats" below, with step-by-step mechanics happening inside subagent dispatches rather than being narrated in the top-level chat.

It becomes an automatic session launcher — the thing this repository defers building until evidence justifies it — only if a session uses subagent dispatch to originate work on new issues or PRs on its own initiative, without the founder having started that session in the first place. The gate that must never be bypassed is *who starts the session*, not *what the session delegates internally once running*.

When a worker's task is already backed by a self-sufficient durable execution Issue, dispatch by reference — Issue number, controlling Issue, and route if already settled — and let the worker read that Issue directly. Do not load the full execution Issue into the orchestrating session first, and do not reconstruct its requirements, acceptance criteria, or test plan into the subagent prompt: that pays for the same specification twice and was the demonstrated failure in issue #282. When the reference triple came from the READY immediate-dispatch gate, use `tools/orchestration/format-dispatch-prompt.mjs`'s output verbatim (see Session execution above) rather than composing the prompt by hand — issue #321 found that even a controller that made no forbidden read still padded a hand-composed prompt with restated AGENTS.md sections until it exceeded the reference-only size threshold, retransmitting general contract prose instead of Issue-specific content but retransmitting all the same. See `docs/operating-model.md` § Two-plane Issue dispatch for the full control/execution split and its fallbacks. This narrows only the re-explanation of a spec that already exists durably — a subagent facing genuinely ambiguous or undocumented work still needs full situational framing.

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
- Clean completion: `CLEAN — <what merged/closed>. Next: #<slice>` (or `Next: None`). For a review-worthy PR, never emit this line — and never treat the slice as done in any other way — until `docs/bounded-review-cycle.md`'s composed pre-merge gate reports success from durable GitHub evidence for that PR's frozen head. Completing implementation, tests, commit, push, and PR creation is not itself evidence review happened.
- Blocked: `BLOCKED — <one clause>. Next: <manual action>` (or `Next: None`). Use this exact line when every merge prerequisite is satisfied but the execution environment itself refuses the merge operation — a manual execution handoff, not a re-opened founder decision about whether to merge.

An ad-hoc issue — one not created from a structured template (`parent-execution`, `work-packet`, `founder-decision-form`, `audit-control-issue`, `idea-intake`) — gets a single terse line for a body, not prose paragraphs. Templates keep their required fields.

Always use `tools/review-watch/trigger.mjs` to request a Codex review. Prefer PR event delivery for Stage 1 when the harness supports it; `tools/review-watch/poll.mjs` is the required mechanism whenever polling is actually needed (always, for Stage 2, which has no event delivery) — never a hand-rolled polling loop against a guessed endpoint or bot login, which has already silently missed genuine responses (issue #113). See `docs/bounded-review-cycle.md` for the exact trigger/poll mechanics and the wakeup-cadence rules while waiting on a response.

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

"One inline round" limits reviewer invocations; it never authorizes merging a known defect. The post-merge audit is a control issue and the stopping review for that cycle.

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

The reviewer-only boundary above governs what Codex may *do* once triggered. It equally governs what the controlling session may *tell Codex to do* before it responds: once `@codex review` has been posted, the controlling session must never suggest, specify, or coach the expected reply format, heading, wording, or structure in a follow-up comment on that thread — not even by quoting the issue or PR template's own required-structure text back at it. Issue #259 (the #253/#255 incident): Codex's first Stage 2 reply was substantively complete but used a reply shape `tools/review-watch/stage2-report.mjs`'s mechanical parser did not recognize; instead of treating that mismatch as a real finding, the controlling session posted a comment telling Codex the exact literal headings to reply with, then re-triggered — compromising Stage 2's independence regardless of intent, since the whole point of an independent review or audit is that its content and shape are not shaped by the party being reviewed. A response that does not match the mechanical completed-report contract is itself a finding to report and stop on (a parser gap, or a template that does not reliably steer Codex's actual output), never an invitation to coach the next reply toward conformance. `tools/review-watch/trigger.mjs` additionally refuses (exit 2) to force a second Stage 2 trigger on a thread that already drew a genuine response, complete or not, with no automated override — see that script's module comment and `docs/bounded-review-cycle.md` Stage 2 step 10.

<!-- ldl:source-only:start -->
## Prototype guardrail

The first trial is Covenant's remaining `wolfscairn-list-and-privacy` work after PR #94. The execution slice ships the complete Buttondown signup surface, including form, CSP, presentation, tests, documentation, and integration. Do not split those layers into separate issues. Do not build an automatic session launcher or generalize the controller until evidence from this trial justifies it.
<!-- ldl:source-only:end -->
