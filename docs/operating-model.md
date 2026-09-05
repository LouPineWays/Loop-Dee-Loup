# Operating model

## The unit of work

The Loop-Dee-Loup execution issue is a vertical slice: the smallest coherent outcome that one capable subagent can implement and verify end to end.

It does not assume that work naturally arrives as projects, epics, sprints, departments, or formal role handoffs. Those structures are allowed only when an observed coordination problem makes them cheaper than direct execution.

## Startup context budget

LDL's thin-orchestrator architecture depends on a fresh Claude Code session starting with very little context. `CLAUDE.md` imports `AGENTS.md` automatically, so both load into every session before it even knows which Issue it is supervising — that automatic startup surface is a bounded routing contract, not a place for accumulating prose.

Keep `AGENTS.md` limited to invariants needed for nearly every control decision: authority order, the vertical-slice/decomposition boundary determination, founder-interrupt conditions, the fixed chat report formats, and pointers to where the next layer of authority lives. Detailed implementation, review, polling, audit, and recovery mechanics belong in `docs/*.md`, an on-demand skill, or durable GitHub/repository state — loaded only once the current lifecycle stage actually needs them, not preloaded on the chance it might. Shortening prose while leaving the same material's full detail nowhere else is not a fix; the goal is a smaller globally-loaded semantic surface, not a smaller file with the same content moved into denser sentences.

Within the Loop-Dee-Loup source repository itself, `tools/check-startup-budget.mjs` (wired into CI as part of the `control-plane-paths` workflow) enforces a line-count budget on `AGENTS.md` and `CLAUDE.md` as a regression guard against silent re-accumulation. Neither the script nor that workflow is part of `tools/ldl-init`'s consumer-installable manifest — this is Loop-Dee-Loup's own guard on its own source files, not machinery an installed consumer repository also receives. The standard itself still applies wherever this document is read: a consumer repository that wants the same regression guard on its own installed `AGENTS.md`/`CLAUDE.md` can add an equivalent check as its own CI, the same way it owns its other repository-specific gates. The guard cannot judge whether an addition is a genuine universal invariant or a smuggled-back manual — that remains a review judgment — but a PR that legitimately needs more room raises the budget constant explicitly, in the same diff, rather than drifting past an unenforced target unnoticed.

The same "needed almost everywhere" standard applies to any other automatically-loaded material: a session's persistent auto-memory (`AGENTS.md` § Auto-memory boundary), unscoped `.claude/rules` (none currently exist in this repository), and globally-visible skill/persona metadata, which already stays to one-line frontmatter descriptions with full instructions loaded only on invocation.

## What belongs in one slice

A slice may cross UI, application logic, storage, configuration, tests, documentation, deployment, and verification. Layer count does not determine issue count. The outcome does.

A valid slice:

- produces one observable capability, correction, or closure condition;
- gives one session enough bounded authority to finish it;
- owns every internal activity required for completion;
- can be assessed independently against explicit acceptance criteria;
- leaves the repository and product coherent when merged.

These are normally internal steps, not separate issues:

- inspect the current implementation;
- decide a technical approach already bounded by product authority;
- modify different layers;
- add or update tests;
- update directly affected documentation;
- address valid inline-review findings;
- prepare the PR and durable handoff.

## Vertical vs horizontal decomposition

A plan that builds inventories, layers, subsystems, or enabling components across the whole outcome before producing a usable portion of that outcome has failed decomposition, even if every individual ticket looks bounded. Horizontal planning is a process failure, not a lower-priority planning style — it reduces the count of nominally missing pieces without producing anything usable.

**Vertical slice.** Produces a usable, observable portion of the parent outcome end to end — implementation, supporting assets, configuration, tests, documentation, migration, and verification for that bounded outcome, together.

**Horizontal activity.** Produces a layer, inventory, subsystem, or category of inputs without making any portion of the outcome usable — a component library before the first flow that uses it, an asset catalogue before the first shot that consumes it, every endpoint before the first UI that calls one.

**Legitimate enabling slice.** Removes a demonstrated blocker, or is a genuine prerequisite for the vertical slice immediately following it — and, either way, has its own independently verifiable outcome. A step that only prepares for a later slice and produces nothing independently verifiable on its own is speculative enabling work, not a legitimate enabling slice, no matter how small.

**Speculative enabling work.** Prepares broadly for possible future slices without evidence that the current slice needs it. Treat this as horizontal activity even when it is organized as several small tickets.

Horizontal activities can and often do exist inside a vertical slice — a slice may need a schema column, a shared component, or a reusable asset along the way. The rule is about default issue boundaries, not about banning foundations: a horizontal activity stops being a problem the moment it is scoped to, and delivered inside, the vertical slice that actually needs it.

### The decomposition self-check

Before creating or accepting a multi-issue plan, apply this test:

> If every planned issue were completed in order, when would the first independently usable, observable, and verified portion of the parent outcome exist?

If the answer is "only after several horizontal issues are all complete," the decomposition is presumptively invalid and must be reframed around vertical outcomes. Work through these questions to locate the failure:

- What usable outcome does each issue leave behind?
- Does the first issue materially exercise the real product or deliverable path?
- Are assets, schemas, services, libraries, docs, tests, or infrastructure being produced in bulk before their first concrete consumer?
- Could the plan instead build the first end-to-end path and create its dependencies just in time?
- Is enabling work justified by a demonstrated blocker, a safety boundary, an external dependency, or repeated reuse — or only by anticipated future need?
- Does acceptance verify the resulting capability in context, rather than merely the existence of components?

A decomposition session runs this check before finalizing its slice list (see Decomposition boundary below). An execution session runs it before treating "build the supporting layer first" as the shape of its own slice.

### Correcting a horizontal plan

The correction available depends on who finds the problem.

**A decomposition/planning session** that finds its own not-yet-dispatched plan is horizontal has full authority to fix it before any issue is dispatched:

1. preserve already-completed useful infrastructure as completed background work — do not discard it because the plan that produced it was flawed;
2. identify the next smallest usable portion of the actual parent outcome;
3. reframe a draft or existing open issue around that outcome where practical, rather than opening a parallel one;
4. move required assets and enabling tasks inside that slice as just-in-time work;
5. close or supersede redundant shopping-list or component issues rather than duplicating them;
6. create every currently foreseeable follow-on vertical slice, per the Decomposition boundary contract;
7. make dependencies express outcome order, not organizational layer order.

**An execution session** that discovers mid-slice that its own dispatched issue was itself scoped horizontally does not get the same authority. The active issue's explicit outcome and acceptance criteria are the highest authority (`AGENTS.md` § Authority), so the session may narrow or clarify its remaining work inside that outcome, but must not unilaterally rewrite the issue to a broader end-to-end outcome. If the smallest usable portion the session can identify would exceed what the dispatched issue already authorizes, that is a scope question, not a technical one: apply the founder interrupt conditions, and stay within the standing one-next-slice limit for genuinely new follow-on work (`AGENTS.md` § Session execution) rather than materializing a full follow-on slice list mid-slice.

### Before / after examples

**Software feature.** Before: separate issues for the backend endpoints, the frontend screens, and the test suite for one feature. After: one issue (or one small vertical sequence) that ships the first real user flow end to end, including the endpoint, screen, and tests it actually needs; later flows through the same feature become their own vertical slices, not the remaining layers of the first one.

**Media/content deliverable.** Before: an issue to inventory and generate every reusable asset a piece of content might need, followed by an assembly issue once the inventory is "complete." After: an issue that roughs in, sources the assets for, assembles, and verifies one contiguous segment; assets a later segment needs are produced just in time for that segment, and genuinely reusable by-products are kept rather than rebuilt.

**Legitimate infrastructure.** A migration that must run once, cannot be safely split per-feature, and blocks every subsequent slice (e.g. a schema change every later vertical slice depends on) is a valid independent enabling slice — it has demonstrated, immediate consumers rather than speculative ones, and it is itself independently verifiable (the migration runs cleanly and existing behavior still works).

### Issue acceptance criteria

Acceptance criteria such as "files exist," "assets are catalogued," "endpoints are implemented," "components are created," or "tests are written" are insufficient on their own. An execution issue must also demonstrate its bounded capability or deliverable working in its real context. The canonical issue-format contract (tracked in issue #202) governs issue-body structure; this section governs decomposition validity for execution issues, regardless of which execution-issue template is used. Founder-decision-form, audit-control, and idea-intake issues are control boundaries, not product slices — they are judged by the decision, verdict, or intake outcome they exist to produce, not by a working capability in context.

## When to create another issue

Create another execution issue only when there is a new independent outcome or a materially different context or authority boundary.

Separate control issues are allowed for:

- a founder decision;
- an external manual action;
- the repository's required post-merge acceptance audit;
- a distinct correction exposed after merge.

Do not describe those control boundaries as product slices when they are not.

## Critical-path decision forms

The Loop resolves product uncertainty in batches, not through a serial dialogue.

Before interrupting the founder, the session maps the currently visible path from the accepted outcome to the next implementable vertical slice. It gathers all founder-level choices on that path into one decision form. Technical choices already settled by repository authority remain with the agent.

A generated form contains:

- feature outcome and current verified state;
- the critical-path consequence of leaving the questions unanswered;
- all currently knowable blocking questions;
- mutually exclusive options;
- a recommendation and explicit tradeoffs for each question;
- a prefilled suggested answer the founder can accept or replace;
- per-question comments;
- one unrestricted final comments field.

The founder completes and returns the form as one unit. The session must not respond to each answer with another question that was already foreseeable.

### Form results

Completed answers are routed by meaning:

- **Settled decision:** compress into the parent snapshot.
- **Current vertical slice:** place in the slice contract and acceptance criteria.
- **Accepted independent outcome:** create the correct backlog candidate — a target repository's own prioritized backlog (e.g. Covenant's Burn Order) when the outcome is a product feature, or a `priority:*`-labeled GitHub Issue on Loop-Dee-Loup's own repository (`docs/priority-horizons.md`) when the outcome is about the Loop itself — with dependencies noted and, for Loop-Dee-Loup's own Issues, native `blocked by`/`blocking` relationships rather than an ordinal position. Never merge the two.
- **Rejected option:** retain only if necessary to prevent the same question recurring; do not create work.
- **Unclear answer:** include with any other newly exposed blockers in the next consolidated form.

A decision is not itself a backlog item. Only an accepted outcome requiring independent future work belongs there.

### Multiple forms

Another form is permitted only when an answer exposes a genuinely new blocker or dependency that was not reasonably visible earlier. Forms follow the critical path until at least one vertical slice is implementable.

Two consecutive completed forms without an implementable slice trigger diagnosis before another form. The session must identify whether the proposal is incoherent, authority is missing, or decomposition is too horizontal, then use that result to redirect the next critical-path form.

## Founder role

The founder owns:

- the desired product or business outcome;
- acceptance of initial feature proposals when intent is not already settled;
- answers to material product questions;
- decisions involving meaningful scope, UX, monetization, legal, privacy, security, reputation, cost, or irreversibility;
- credentials and manual actions that cannot be delegated;
- starting or resuming a Claude Code session with a short issue reference.

The final item is lightweight scheduling. The founder is not a status relay, prompt router, test runner, or routine approval gate.

## Version-one runner

GitHub is the persistent controller state. Claude Code is a disposable runner.

A normal invocation is:

> Run Loop-Dee-Loup issue #X.

The session reads the issue body and minimum repository authority, executes the vertical slice, records verified state and the next slice, then stops. A later session resumes from GitHub rather than from conversation history.

Version one deliberately does not include a daemon, queue worker, webhook dispatcher, or automatic session launcher. Those are infrastructure hypotheses to test only after the manual-dispatch loop proves useful.

## Session role

One Claude Code session owns one vertical slice:

- load the parent snapshot and identify the active slice — read that slice's own body directly only when implementing it inline rather than dispatching a fresh subagent worker per Two-plane Issue dispatch below;
- produce its complete outcome across all necessary layers;
- run specified checks;
- independently verify completion claims;
- route the change through available repository gates;
- refresh durable state;
- when this slice's completion exposes new follow-on work not already foreseeable at dispatch, prepare at most one next slice — see Decomposition boundary for issues that require multiple slices;
- stop.

## Two-plane Issue dispatch

A dispatched Issue can carry two distinct kinds of authority, and a session must not collapse them into one read.

**Control-plane authority** is lifecycle truth: accepted outcome, current state, the pointer to whichever execution Issue is currently authoritative, PR/review/audit status, blocker and founder-decision state. The `parent-execution` template is this plane. **Execution-plane authority** is the actual requirements, acceptance criteria, verification, and constraints a worker needs to produce the outcome. The `work-packet` (vertical-slice) template is this plane. Neither plane duplicates the other: updating lifecycle state does not require rewriting the execution spec into the control Issue, and updating execution requirements does not create a second detailed spec there.

**Immediate-dispatch gate.** This is the normal path and governs the sequence before any fallback or direct-inspection reasoning below is even considered. `tools/orchestration/ready-dispatch-gate.mjs` (issue #321) mechanically evaluates whether the control Issue already supplies all of the following, read directly off its recorded fields:

- state READY specifically — not EXECUTING, VERIFYING, REVIEW, AUDIT, CORRECTION, or any other lifecycle state; those mean the control Issue is already mid-cycle and should continue its own current step, never receive a fresh immediate dispatch;
- one current execution pointer;
- a settled route (executor/persona, if routing applies);
- blocker: none;
- founder decision: none;

On `READY_TO_DISPATCH`, the orchestrating session dispatches the worker immediately by reference — Issue number, controlling Issue, and route, taken from the gate script's own output — without first performing execution-Issue inspection, repository reconnaissance for implementation planning, decomposition analysis, related-Issue mechanism comparison, sizing/complexity analysis, or implementation planning. Those steps belong to the execution worker once dispatched, under the thick execution contract, not to the controller deciding whether to dispatch. Wanting to become more confident before handing off is not, on its own, a reason to perform any of them — a control Issue carrying a blocker or an unresolved founder decision is not dispatch-ready merely because it also carries an execution pointer and a settled route; blocker and founder-decision state are separate, explicitly-checked fields, never inferred from the presence of the others.

Issue #368 split the gate's non-ready outcome into two disjoint verdicts, because collapsing them into one broad `NOT_READY` produced a live regression: control #301 carried `Lifecycle: BLOCKED` and an active Blocker — authoritative control state that had already answered the control question ("do not advance this work now") — and the old gate's `NOT_READY` result read, under this section's own prior fallback prose, as license to fall through into ordinary execution reasoning. The controller did exactly that, investigating and working around linked execution Issue #297 instead of stopping. `BLOCKED` (exit code 4) is now the gate's verdict whenever the control Issue's own parsed fields positively assert a stop — a blocking lifecycle value specifically (the ad hoc bullet convention's `Lifecycle: BLOCKED`, or the shipped `parent-execution.yml` template's `State: BLOCKED_FAILURE`/`State: BLOCKED_EXTERNAL`, since that template's own dropdown never offers the bare word `BLOCKED` — issue #370), a Blocker field that was found and is not the "none" sentinel, or a Founder-decision field that was found and is not "none" — and it carries only that reason, sufficient for a concise blocked/founder-interrupt handoff with no second read. On `BLOCKED`, the orchestrating session stops immediately: it must not read the linked execution Issue, perform repository reconnaissance, attempt to resolve or work around the blocker, or reinterpret the blocker as authorization for different work, regardless of how confident-looking the rest of the control Issue's fields are. `NOT_READY` (exit code 3, unchanged) now means only that the immediate-dispatch shortcut genuinely does not apply and nothing read asserts a stop — a mid-cycle lifecycle state other than `BLOCKED` (EXECUTING, VERIFYING, REVIEW, AUDIT, CORRECTION; these retain whatever continuation their own lifecycle stage already authorizes, per Watched lifecycle breakpoints below, and are not converted into a blocker merely by this split), an unsettled Route, a malformed/self-referential/multi-valued Execution pointer, or a control Issue shape the gate cannot classify at all (a legacy unsplit Issue) — for all of these, fall through to the Decomposition boundary/Direct-inspection fallback below exactly as before.

Dispatch by reference stays by reference: do not read the execution Issue into the orchestrating session first, and do not reconstruct its requirements, acceptance criteria, or test plan into the subagent prompt — the worker reads the execution Issue and governing repository authority directly. Issue #283 (the #282 incident) is the record of this failure: a controller reconstructed most of a self-sufficient execution Issue into a bespoke subagent prompt and then also told the worker to read the same Issue, paying for one specification twice and loading implementation detail into the orchestrating session for no benefit. Pipe the gate script's JSON output into `tools/orchestration/format-dispatch-prompt.mjs` and use its stdout verbatim as the dispatch prompt, rather than composing one by hand: a live #321 proof (`docs/diagnostic-traces/615f2b4a-69eb-42f1-bef6-432a4e32f4dc.json`) recorded a controller with zero forbidden reads and zero reconnaissance that still hand-composed a 2554-character prompt by restating whole AGENTS.md sections into it, exceeding the diagnostic's 700-char reference-only threshold — a distinct failure mode from #283/#282's read-before-dispatch defect, since no execution-Issue-specific content ever left the control plane, but "possible requirement retransmission" all the same by the same size proxy. The fixed formatter removes the composition step's freedom to grow rather than relying on the orchestrating session to remember to stay terse.

Prose alone did not hold this boundary: issue #321 found two independent fresh controller sessions — one captured in `docs/diagnostic-traces/4dea0981-616a-4cea-96e2-fdd1183b1d29.json`, one recorded directly in control Issue #322's body — that each read a complete, gate-satisfying control Issue and then still read the linked thick execution Issue (and, in the first case, queried unrelated PRs) before ever dispatching, despite this section's prose already stating the required sequence unambiguously. `ready-dispatch-gate.mjs` is the smallest reliable guard raised in response: it makes exactly one read (the control Issue itself, via `gh issue view`) and returns a verdict, so the reconnaissance-bundling that produced both regressions has no code path left to occur inside the gate check itself. It is a check the orchestrating session runs and then acts on, not a dispatcher, task router, or persistent controller — it never calls the Agent/Task tool itself, and a session that ignores its verdict is still a prose-level failure this script cannot force-correct on its own. Live dispatch behavior is still verified by a fresh-session proof (per #283 and #321), not only by this script's own unit tests.

This does not change how subagents should be briefed for genuinely ambiguous or undocumented work — situational framing, prior findings, and specific file/line context still belong in the prompt when no durable spec covers them. It narrows only the case where a complete, self-sufficient execution Issue already exists: there, the Issue is the spec, and re-explaining it into the prompt is waste, not diligence.

**Legacy unsplit Issues.** Not every Issue is split into control/execution planes. If routing/control state (outcome, state, route, blocker) can be extracted from an unsplit Issue deterministically, do that instead of a full orchestrator read. If judgment is required, dispatch a fresh routing worker that reads the full Issue and returns only a compact projection — outcome shape, executor/persona, blocker state, authority conflicts — never a prose implementation summary — for the orchestrating session to act on. This fallback is not license to make a full orchestrator read routine for newly created or migrated watched work; prefer the split.

**Direct-inspection fallback.** An orchestrating session may read execution-plane authority directly to resolve a genuine exception: conflicting authority between the two planes, corrupt or missing control-Issue state, an Issue whose shape routing analysis failed to resolve, a worker escalation whose consequence cannot be judged from compact control state, or a founder decision whose exact wording matters to the next control action. This is an explicit exception path, not a routine one.

This list is closed, not illustrative. An orchestrating session must be able to name which listed condition applies before reading execution-plane authority; a diagnostic-sounding reason that is not one of the five — wanting to sanity-check a route the control Issue already records, gauge how large or complex the work is, judge decomposition shape, or compare mechanisms across related Issues — does not qualify, no matter how cautious it sounds. When the control Issue already satisfies the immediate-dispatch gate above, the orchestrator dispatches on those fields directly; it does not open the execution Issue to double-check them. Issue #283 is the durable record of a live regression against this boundary; its full incident detail belongs there, not in this reusable rule.

A session that read execution-plane authority without recording which of the five conditions it was invoking cannot be cited as proof that this boundary held for that dispatch — the read is indistinguishable from a rationalized one after the fact. A session invoking a genuine exception should name it at the point of reading, and that recorded rationale is what stands as its evidence, not the mere fact that the read happened. Separately, downstream lifecycle progress on the dispatched work — its worker completing, its PR reaching review or merging, its audit closing — is evidence for that work's own outcome, not evidence that the dispatching read observed this boundary; the two are independent and must not be substituted for each other.

**No message bus.** A worker's return to the orchestrating session stays compact and control-oriented — complete, blocked, founder decision required, or the next authorized transition — not a narrative of implementation detail for the orchestrator to relay into a later worker's prompt. When one worker's output is needed by another, put it in durable repository/GitHub state and reference it there, rather than routing it through orchestrator chat.

## Watched lifecycle breakpoints

Two-plane Issue dispatch above splits control-plane and execution-plane authority for a single dispatch. The same split holds across an entire watched outcome's lifecycle, not merely across one worker's reading of it:

> **Durable lifecycle/control state persists across the Issue lifecycle. No reasoning context — orchestrating controller or execution worker — persists across a genuine lifecycle breakpoint.**

> **The thin control Issue is the continuity surface a fresh controller resumes from. Workers read the thick execution Issue for their own stage. Lifecycle truth and execution truth remain separate.**

Issue #374 corrected this invariant on live evidence from the #368/#369 → PR #370 → audit #371 → correction PR #372 → re-audit #373 lifecycle: one controller context remained the reasoning owner across Stage 1 polling, finding verification, correction dispatch, merge, Stage 2, a NOT CLEAN correction PR, another Stage 1, another merge, re-audit, and closure, while only substantive workers underneath it were fresh. That was a faithful reading of the prior wording below this paragraph — "the orchestrator persists across the Issue lifecycle" — but the live run showed that wording is too weak a context-isolation boundary: it let "the orchestrator" mean the conversational/model context rather than the durable control state recorded on the thin control Issue. Persistence now means durable control responsibility on that Issue, never a retained reasoning context. This preserves everything #286/#299 got right — the two-plane split, reference-only dispatch, fresh substantive workers, the compact worker-return protocol, deterministic polling/state detection, fresh Stage 2 independence, and durable GitHub/repository state over conversational handoffs — while correcting only the persistent-orchestrator-context assumption.

The `parent-execution` (thin) / `work-packet` (thick) template pair established above for a single dispatch is the concrete mechanism this section operates over across time: the thin control Issue is the durable object a founder "watches" (functionally, `watch #12345`) and each fresh controller reads for the whole lifecycle; the thick execution Issue is what each substantive worker reads to perform its stage. Legacy unsplit Issues use the same compact-projection fallback already described above under Two-plane Issue dispatch — this section adds no second fallback.

Treat each of the following as a fresh-context boundary: both the controller observing/routing the transition and any worker performing it reconstruct their stage only from durable state, never from a prior controller's or worker's conversational context.

1. **Initial implementation → first PR.** The implementation worker's job ends once the PR and its required durable evidence exist (`docs/bounded-review-cycle.md`'s Entry check and Stage 1 steps 1-2). Do not preserve that worker merely because the PR may later draw review feedback. The controller that dispatched the worker ends here too, once the PR/control reference is durable, rather than remaining to watch Stage 1 in the same reasoning context — `AGENTS.md`'s Context-cost boundaries already treats the Stage 1 review request as a natural fresh-session boundary for the orchestrating session; this extends the same boundary to the worker that produced the PR. This breakpoint is not left to prose alone: issue #286 found a reproduction (`watch #311` → execution #310 → PR #317 → Stage 2 Issue #318) where an implementation worker correctly followed AGENTS.md's Session-execution "continue mechanically ... until CLEAN completion" instruction (since narrowed by issue #374) straight through Stage 1 wait, merge, and Stage 2 initiation, because nothing in its dispatch prompt scoped that instruction back down to this boundary. `tools/orchestration/format-dispatch-prompt.mjs`'s fixed template now includes an explicit stop-at-PR clause for exactly this reason — the enforcement point is the dispatch prompt itself, not a reviewer's memory of this section.
2. **PR review/fix.** A fresh worker handles review feedback or another actionable PR state, reconstructing only from the thick execution Issue, the PR, current review comments/findings, current repository state, and governing review authority (`docs/bounded-review-cycle.md` Stage 1) — never from the implementation worker's conversational state. One coherent response to one review round stays with one worker; do not rotate workers per individual comment (`docs/bounded-review-cycle.md` Stage 1 step 6; `AGENTS.md`'s Subagent dispatch). The controller observing this round does not remain the reasoning owner while waiting on a response either: a bounded deterministic check (`poll.mjs`) may run inside a fresh invocation, but once the round's durable outcome — a fix applied, or Stage 1 satisfied — is recorded, that controller ends.
3. **Merge → Stage 2 audit.** Stage 2 already "start[s] the audit from a fresh independent context" (`docs/bounded-review-cycle.md` Stage 2 step 2). The thin control Issue records only the merged identity and the Stage 2 Audit Issue reference; it does not accumulate Stage 1 repair narrative. The controller that observed Stage 1 satisfied, merged, and triggered Stage 2 ends once that reference is durable — it does not carry the pre-merge/Stage-1 context through the audit wait or result.
4. **Stage 2 NOT CLEAN → correction → re-audit.** A fresh correction worker performs the authorized correction (`docs/bounded-review-cycle.md`'s NOT CLEAN handling under Verdict handling). The subsequent re-audit must be performed by a *different* fresh audit worker, again starting from Stage 2 step 2's fresh-independent-context requirement — the correction worker must never become its own re-auditor. This is the same independence boundary Stage 2 already exists to enforce: a correction worker auditing its own fix would collapse execution and independent-assurance authority into one context, which is exactly what Stage 2's fresh-context requirement exists to prevent. The controller that observed and routed the NOT CLEAN verdict does not persist into the correction PR lifecycle either; a fresh controller resumes from the audit issue's recorded verdict to dispatch the correction, then ends at breakpoint 1 above for that correction PR, recursively through breakpoints 2-4 as needed.
5. **CLEAN / terminal blocked / founder interrupt.** Once `docs/bounded-review-cycle.md`'s Verdict handling records a CLEAN disposition, or a terminal blocked/founder-interrupt state applies, the controller persists that terminal state to the thin control Issue and ends. No further reasoning context is required to close out this outcome.

Across all five breakpoints, the orchestrator's normal retained state stays the compact fields already named for a `parent-execution` Issue — control Issue, execution Issue, lifecycle state, route, PR, Stage 1/2 status, blocker/founder-decision flags — never copied execution requirements, diffs, test logs, review narratives, or audit reasoning; those stay in the thick execution Issue, the PR, and durable review/audit evidence, per Two-plane Issue dispatch's no-message-bus rule above.

Until issue #73 or another separately authorized launcher can start the next fresh controller automatically, founder-issued terse `work on #<control>` re-invocation is the scheduling mechanism between these breakpoints — a little manual scheduling, not a reason to keep the current controller alive. Waiting or polling for a response does not by itself justify an exception: a bounded deterministic observation may run inside a fresh invocation, but reaching the next durable breakpoint still ends that reasoning context, per `AGENTS.md`'s Context-cost boundaries.

## Execution-stage session boundaries

Watched lifecycle breakpoints above governs a watched outcome from its first PR through Stage 2 closure. Issue #294 and its founder clarification comment refine what happens *before* that section's breakpoint 1 — the interval between dispatching a thick execution Issue and the PR that enters `docs/bounded-review-cycle.md`. That interval is not one long implementation session. It is a short sequence of bounded sessions, each producing exactly one durable progress product and then ending:

1. **Plan.** The thin control Issue's controller dispatches exactly one planning worker by reference. That worker reads the thick execution Issue in full, determines the complete currently-foreseeable implementation decomposition, establishes any values or interfaces more than one unit depends on, persists the durable plan artifacts below, and returns only a compact `PLAN_READY <ref>`. The controller does not ingest or retransmit the plan body; it records the reference and ends.
2. **Route/Prepare.** A fresh controller applies the cheapest-reliable deterministic tree — deterministic script or operation → reusable skill or procedure → specialized bounded worker → stronger/general bounded worker → orchestrator judgment only for genuine control ambiguity → founder only for genuine founder decisions — to the units the plan already defined, and persists a durable dispatch manifest. It ends.
3. **Execute.** A fresh controller dispatches bounded implementation workers by reference off that manifest. Each worker reads its own unit contract plus the durable authority that contract points at, writes durable repository state, records a compact completion/blocker state, and ends. Sequential units chain through that durable state rather than through prose handoffs; parallel units are used only when genuinely independent with an explicit, cheap integration boundary. When dependencies force materially separate execution waves, each wave may be its own session rather than keeping one controller alive to span them.
4. **Integrate/PR.** A fresh integration worker compares the plan against the actual repository result, repairs only authorized seams, verifies the integrated vertical outcome, opens the PR, and persists the PR/control reference. See `docs/bounded-review-cycle.md`, "Integration/PR worker", for that role and for why it is never the independent reviewer.
5. **Review/Audit.** From the PR onward, Watched lifecycle breakpoints above already governs everything — Stage 1, merge, Stage 2, correction cycles, closure. This section adds no second lifecycle model there and no second set of breakpoints.

Session count is not a success metric, and neither is unit count: a plan naming one implementation unit executed by one capable worker is a valid plan whenever decomposition would not earn its coordination cost. The invariant is one bounded durable progress product per reasoning session, with deterministic work pushed below reasoning wherever it is reliable. Sessions and subagents are orthogonal: a fresh session is not a substitute for isolating how-to context in a subagent, and a subagent is not a substitute for ending a session at a durable boundary.

### Single planning owner

Planning must not be fragmented across implementation workers. Exactly one planning context per execution Issue reads the thick Issue in full and owns the whole currently-foreseeable decomposition. Every later session operates from thin control state plus the durable plan, unit, and shared-contract references — not from rereading the thick Issue. A unit worker falls back to the thick Issue only when its own contract requires it or a concrete authority ambiguity must be resolved, never routinely "for context."

Deterministic routing is a separate stage precisely so it cannot become a second planning pass. It applies a mechanical tree to units the planner already defined; it does not redefine them, resize them, or invent new ones. When a unit cannot be routed without substantively reinterpreting the plan, that ambiguity is escalated explicitly on the plan (`REPLAN_REQUIRED` below) rather than silently resolved by the routing session — silent resolution is exactly how planning ends up distributed across several agents.

Shared decisions travel through durable state, never through the controller. The planner persists a shared contract once and each affected worker reads it; a worker never tells the orchestrator a value for the orchestrator to relay into another worker's prompt. Two-plane Issue dispatch's no-message-bus rule above applies to plan artifacts exactly as it applies to worker returns.

Each implementation worker's instruction surface is separate and need-to-know: the minimum authoritative information required to perform its own responsibility correctly, expanding only when a concrete dependency requires it. Do not include another unit's role or instructions for completeness, and do not copy the thick execution Issue wholesale into every contract to make each prompt look self-contained. If unit A genuinely needs unit B's detailed reasoning to proceed, that is evidence the decomposition boundary is wrong — recombine or replan rather than widening both contracts.

### Durable plan artifacts

These artifacts are comments on the thick execution Issue itself. They are durable execution state under one coherent Issue — not GitHub backlog micro-Issues, a task database, a queue, or a second tracker — and one execution Issue remains one backlog item no matter how many units its plan contains. Their headings and field names are fixed, because deterministic tooling parses them and several sessions write them at different times:

- **Plan Index comment** — heading line exactly `## Execution Plan Index (v1)`. Bullet fields: `- **Plan state:**`, `- **Parent execution issue:**`, `- **Shared contract:**` (URL), `- **Units:**` (one line per unit: `- <UnitID>: <state> — <one-line outcome> (<comment URL>)`), `- **Dependencies:**`, `- **Dispatch manifest:**` (URL or `none`), `- **Integration/PR route:**` (issue/PR ref or `none`). This is the compact projection a controller reads to identify the next authorized worker reference.
- **Shared Contract comment** — heading exactly `## Shared Contract (v1)`. Holds the constants, names, schemas, paths, interfaces, and compatibility assumptions more than one unit depends on, established once by the planner. Each unit contract points here instead of restating them.
- **Worker Unit Contract comment** — heading exactly `## Worker Unit: <UnitID> (v1)`, containing exactly these bold-label bullets, in this order: Unit ID, Parent execution issue, Required bounded outcome, Applicable role/capability, Authority/input pointers, Relevant shared-contract pointer, Prerequisites/dependencies, Files/surfaces expected to change, Observable completion condition, Verification required, Durable output/state expected, Interrupt/escalation conditions, State.
- **Dispatch Manifest comment** — produced by the Route/Prepare stage, not by the planner. Heading exactly `## Dispatch Manifest (v1)`, with `- **Plan index:**` (URL) and one line per unit: `- <UnitID>: route=<resolved route> dispatch_ready=<true|false> note=<escalation note or none>`.

**Unit-ID convention:** `<execution-issue-number>-<Letter>` — #294's own plan used `294-<Letter>` — stable for the life of that plan.

**State vocabulary** (the Plan Index's Plan state and every unit's State field use this fixed set): `PLANNED | ROUTED | IN_PROGRESS | BLOCKED | DONE | REPLAN_REQUIRED`.

**Edit-ownership rule** (avoids concurrent-edit races): a unit's own dispatched worker is the only writer allowed to edit that unit's own Worker Unit Contract comment, to update its State field and append a short completion/blocker note. No unit worker edits the Plan Index or Shared Contract comments, or another unit's comment. Only a Route/Prepare-stage session or the Integration/PR worker recomputes or refreshes the Plan Index comment, by re-reading current unit states — never from cached or remembered state.

A unit that discovers it is incorrectly bounded records `REPLAN_REQUIRED` on its own contract with the reason and stops; recombining units, escalating one to a stronger executor, or otherwise revising the plan preserves current durable state and the parent execution Issue's scope, and does not require creating another backlog Issue solely for execution granularity. Escalate to the founder only when the new information creates a genuine founder-level decision under `AGENTS.md`'s Founder interrupt conditions.

## Decomposition boundary

Decomposition and execution are separate control boundaries. An issue completable as one bounded vertical slice executes normally under Session role above. For a control-plane issue, the Immediate-dispatch gate above runs first (this ordering is stated directly in `AGENTS.md` § Session execution, not only here, since that file is the automatically loaded startup contract): decomposition analysis applies only when that gate does not apply — to the execution work itself (inline slice execution or a legacy unsplit issue), never as a reassessment of a linked execution issue a satisfied gate already authorizes to dispatch by reference.

An issue that genuinely requires multiple independently executable slices triggers a decomposition session instead. Once that determination is made, the session must not begin implementing any resulting slice — not even the first one, and not "to save a session." Before it ends, it must:

1. apply the decomposition self-check above: ask when, if every planned issue completed in order, the first independently usable, observable, verified portion of the parent outcome would exist — if the answer is only after several horizontal issues are all complete, the plan is horizontal and must be reframed around vertical outcomes before proceeding, even though the finished plan would eventually be usable;
2. determine every currently foreseeable, implementation-ready vertical slice — not speculative work whose need depends on discoveries not yet made by an earlier slice;
3. create one self-sufficient execution issue for each slice (the vertical-slice template), containing enough of the outcome, constraints, acceptance criteria, and dependencies that a fresh session can execute it without reconstructing this conversation;
4. record genuine dependencies between those slices using GitHub's native issue relationships (Blocked by / Blocking), not free-text cross-references alone;
5. close the source issue as a durable decomposition record — retaining its objective, settled decisions, scope and non-goals, the resulting slice list, dependencies, and any unresolved external dependency — rather than leaving it open to sequentially point from one child to the next;
6. stop.

Do not create issues to mimic implementation steps, conversational turns, or organizational roles. Do not manufacture speculative future slices whose shape depends on an outcome not yet known — "every currently foreseeable slice" is not "every slice that might eventually exist."

A resulting slice begins only when the founder explicitly dispatches it in a fresh session (e.g. "Work on #123"). Creating a slice — including during the same decomposition session that just created it — does not authorize beginning it. Do not infer dispatch from having just created the issue.

Once dispatched, a slice runs autonomously per `AGENTS.md` § Session execution and the bounded review cycle until it reaches CLEAN completion or a genuine founder interrupt or unrecoverable blocker applies. CLEAN completion of one slice does not authorize beginning a sibling slice created in the same decomposition, even one that is now unblocked, obviously next, or has no remaining founder decision. The founder chooses which executable issue to dispatch next.

## Verification and autonomy

Autonomy begins after the founder dispatches the issue. It means completing the slice without routine questions or approvals. It does not mean bypassing controls.

A session may complete its slice only when:

- the whole slice outcome is present;
- acceptance criteria are satisfied;
- required checks pass;
- independent verification supports the handoff;
- the target repository's review and merge rules are satisfied;
- no interrupt condition applies.

A failed gate changes the state. It does not justify silently lowering the gate.

## Communication discipline

Claude Code chat is ephemeral and expensive. Use it only for control:

- acknowledge the issue briefly;
- link one consolidated decision form when founder input is required;
- ask a direct concise question only for a single unforeseeable blocker discovered mid-slice;
- report completion or the stopping state briefly.

GitHub holds detailed evidence, decisions, links, and the next slice. Avoid progress narration that duplicates durable state.

## Durable state

The parent issue contains current feature truth. The source queue contains priority and a link. Slice issues contain bounded execution contracts. Code and git contain shipped reality. Comments retain history but are excluded from normal retrieval.

This separation prevents the loop from turning either GitHub or an agent session into an ever-growing transcript.
