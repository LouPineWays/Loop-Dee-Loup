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
- **Accepted independent outcome:** create a candidate for the correct Burn Order — a target repository's own prioritized backlog (e.g. Covenant's) when the outcome is a product feature, or Loop-Dee-Loup's own Burn Order (`docs/burn-order.md`) when the outcome is about the Loop itself — with dependencies and proposed position. Never merge the two.
- **Rejected option:** retain only if necessary to prevent the same question recurring; do not create work.
- **Unclear answer:** include with any other newly exposed blockers in the next consolidated form.

A decision is not itself a Burn Order item. Only an accepted outcome requiring independent future work belongs there.

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
