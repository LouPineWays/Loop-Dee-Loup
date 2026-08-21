# Operating model

## The unit of work

Loop-Dee-Loup is designed for vibecoding-sized increments: the smallest change that can be implemented, verified, integrated, and used to update the next decision.

It does not assume that work naturally arrives as projects, epics, sprints, departments, or formal role handoffs. Those structures are allowed only when an observed coordination problem makes them cheaper than direct execution.

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

The session reads the issue body and minimum repository authority, executes the current packet, records verified state and the next packet, then stops. A later session resumes from GitHub rather than from conversation history.

Version one deliberately does not include a daemon, queue worker, webhook dispatcher, or automatic session launcher. Those are infrastructure hypotheses to test only after the manual-dispatch loop proves useful.

## Session role

One Claude Code session owns one bounded transaction:

- load the parent snapshot and active packet;
- produce the required outcome;
- run specified checks;
- independently verify completion claims;
- route the change through available repository gates;
- refresh durable state;
- prepare exactly one next packet;
- stop.

The session may complete several tightly coupled technical actions inside one packet. It must not absorb a distinct context boundary merely to avoid ending.

## Just-in-time decomposition

Decompose only until one safe next packet exists. Later packets remain hypotheses until current work produces evidence.

Create a new packet when there is a meaningful boundary, such as:

- an independently testable change;
- a different repository or authority boundary;
- a founder decision;
- an external/manual action;
- a merged PR boundary;
- a distinct verified audit correction.

Do not create packets to mimic conversational turns or organizational roles.

## Verification and autonomy

Autonomy begins after the founder dispatches the issue. It means completing the packet without routine questions or approvals. It does not mean bypassing controls.

A session may advance its packet only when:

- acceptance criteria are satisfied;
- required checks pass;
- independent verification supports the handoff;
- the target repository's review and merge rules are satisfied;
- no interrupt condition applies.

A failed gate changes the state. It does not justify silently lowering the gate.

## Communication discipline

Claude Code chat is ephemeral and expensive. Use it only for control:

- acknowledge the issue briefly;
- ask one concise question when blocked on founder input;
- report completion or the stopping state briefly.

GitHub holds detailed evidence, decisions, links, and the next packet. Avoid progress narration that duplicates durable state.

## Durable state

The parent issue contains current truth. The source queue contains priority and a link. Code and git contain shipped reality. Comments retain history but are excluded from normal retrieval.

This separation prevents the loop from turning either GitHub or an agent session into an ever-growing transcript.
