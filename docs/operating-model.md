# Operating model

## The unit of work

The Loop-Dee-Loup execution issue is a vertical slice: the smallest coherent outcome that one capable subagent can implement and verify end to end.

It does not assume that work naturally arrives as projects, epics, sprints, departments, or formal role handoffs. Those structures are allowed only when an observed coordination problem makes them cheaper than direct execution.

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

**Legitimate enabling slice.** Removes a demonstrated blocker, has independently verifiable value on its own, or is the smallest safe prerequisite for the vertical slice immediately following it.

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

When horizontal planning is found, mid-plan or mid-execution:

1. preserve already-completed useful infrastructure as completed background work — do not discard it because the plan that produced it was flawed;
2. identify the next smallest usable portion of the actual parent outcome;
3. reframe an existing open issue around that outcome where practical, rather than opening a parallel one;
4. move required assets and enabling tasks inside that slice as just-in-time work;
5. close or supersede redundant shopping-list or component issues rather than duplicating them;
6. create only the currently foreseeable follow-on vertical slices;
7. make dependencies express outcome order, not organizational layer order.

### Before / after examples

**Software feature.** Before: separate issues for the backend endpoints, the frontend screens, and the test suite for one feature. After: one issue (or one small vertical sequence) that ships the first real user flow end to end, including the endpoint, screen, and tests it actually needs; later flows through the same feature become their own vertical slices, not the remaining layers of the first one.

**Media/content deliverable.** Before: an issue to inventory and generate every reusable asset a piece of content might need, followed by an assembly issue once the inventory is "complete." After: an issue that roughs in, sources the assets for, assembles, and verifies one contiguous segment; assets a later segment needs are produced just in time for that segment, and genuinely reusable by-products are kept rather than rebuilt.

**Legitimate infrastructure.** A migration that must run once, cannot be safely split per-feature, and blocks every subsequent slice (e.g. a schema change every later vertical slice depends on) is a valid independent enabling slice — it has demonstrated, immediate consumers rather than speculative ones, and it is itself independently verifiable (the migration runs cleanly and existing behavior still works).

### Issue acceptance criteria

Acceptance criteria such as "files exist," "assets are catalogued," "endpoints are implemented," "components are created," or "tests are written" are insufficient on their own. An issue must also demonstrate its bounded capability or deliverable working in its real context. The canonical issue-format contract (tracked in issue #202) governs issue-body structure; this section governs decomposition validity and applies regardless of which issue template is used.

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

- load the parent snapshot and active slice;
- produce its complete outcome across all necessary layers;
- run specified checks;
- independently verify completion claims;
- route the change through available repository gates;
- refresh durable state;
- when this slice's completion exposes new follow-on work not already foreseeable at dispatch, prepare at most one next slice — see Decomposition boundary for issues that require multiple slices;
- stop.

## Decomposition boundary

Decomposition and execution are separate control boundaries. An issue completable as one bounded vertical slice executes normally under Session role above.

An issue that genuinely requires multiple independently executable slices instead triggers a decomposition session: determine every currently foreseeable, implementation-ready slice, create a durable execution issue for each, record real dependencies between them, close the source issue as a decomposition record, and stop — without beginning any resulting slice. See `AGENTS.md` § Decomposition boundary for the exact contract.

Do not create issues to mimic implementation steps, conversational turns, or organizational roles. Do not manufacture speculative future slices whose shape depends on an outcome not yet known — "every currently foreseeable slice" is not "every slice that might eventually exist."

A resulting slice begins only when the founder explicitly dispatches it in a fresh session. Completing one dispatched slice does not authorize starting a sibling from the same decomposition; the founder chooses what runs next.

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
