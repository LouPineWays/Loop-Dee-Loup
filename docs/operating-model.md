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

The orchestrating session normally reads only control-plane state — the parent snapshot and the fields of the active slice it is about to hand off, not that slice's full body merely because a subagent will eventually need it. When a subagent is doing the actual implementation work and a self-sufficient execution Issue already exists for it, dispatch by reference: Issue number, controlling Issue, and route/persona if already settled. Do not read that execution Issue into the orchestrating session first, and do not reconstruct its requirements, acceptance criteria, or test plan into the subagent prompt — the worker reads the execution Issue and governing repository authority directly. Issue #283 (the #282 incident) is the record of this failure: a controller reconstructed most of a self-sufficient execution Issue into a bespoke subagent prompt and then also told the worker to read the same Issue, paying for one specification twice and loading implementation detail into the orchestrating session for no benefit.

This does not change how subagents should be briefed for genuinely ambiguous or undocumented work — situational framing, prior findings, and specific file/line context still belong in the prompt when no durable spec covers them. It narrows only the case where a complete, self-sufficient execution Issue already exists: there, the Issue is the spec, and re-explaining it into the prompt is waste, not diligence.

**Legacy unsplit Issues.** Not every Issue is split into control/execution planes. If routing/control state (outcome, state, route, blocker) can be extracted from an unsplit Issue deterministically, do that instead of a full orchestrator read. If judgment is required, dispatch a fresh routing worker that reads the full Issue and returns only a compact projection — outcome shape, executor/persona, blocker state, authority conflicts — never a prose implementation summary — for the orchestrating session to act on. This fallback is not license to make a full orchestrator read routine for newly created or migrated watched work; prefer the split.

**Direct-inspection fallback.** An orchestrating session may read execution-plane authority directly to resolve a genuine exception: conflicting authority between the two planes, corrupt or missing control-Issue state, an Issue whose shape routing analysis failed to resolve, a worker escalation whose consequence cannot be judged from compact control state, or a founder decision whose exact wording matters to the next control action. This is an explicit exception path, not a routine one.

This list is closed, not illustrative. An orchestrating session must be able to name which listed condition applies before reading execution-plane authority; a diagnostic-sounding reason that is not one of the five — wanting to sanity-check a route the control Issue already records, gauge how large or complex the work is, judge decomposition shape, or compare mechanisms across related Issues — does not qualify, no matter how cautious it sounds. Issue #283's live regression against control Issue #299 is the record of this failure: #299 already recorded state READY, an execution pointer, and a settled route, yet the orchestrator read execution Issue #286 anyway to count acceptance criteria, judge decomposition shape, and compare lifecycle mechanisms — none of which the five listed conditions cover. When the control Issue already carries state, execution pointer, and route, the orchestrator dispatches on those fields directly; it does not open the execution Issue to double-check them.

A session that read execution-plane authority in a given dispatch cannot itself be cited as proof that this boundary held for that dispatch. Downstream lifecycle progress on the dispatched work — its worker completing, its PR reaching review or merging, its audit closing — is evidence for that work's own outcome, not evidence that the dispatching read observed this boundary; the two are independent and must not be substituted for each other.

**No message bus.** A worker's return to the orchestrating session stays compact and control-oriented — complete, blocked, founder decision required, or the next authorized transition — not a narrative of implementation detail for the orchestrator to relay into a later worker's prompt. When one worker's output is needed by another, put it in durable repository/GitHub state and reference it there, rather than routing it through orchestrator chat.

## Decomposition boundary

Decomposition and execution are separate control boundaries. An issue completable as one bounded vertical slice executes normally under Session role above.

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
