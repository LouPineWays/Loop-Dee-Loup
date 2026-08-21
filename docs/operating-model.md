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
- credentials and manual actions that cannot be delegated.

The founder is not a dispatcher, status relay, prompt router, test runner, or routine approval gate.

## Controller role

The controller owns continuity:

- maintain the compressed parent snapshot;
- select exactly one next packet;
- dispatch a fresh executor;
- independently verify completion claims;
- route changes through existing repository gates;
- update state from evidence;
- continue automatically;
- interrupt the founder only under the defined conditions.

## Executor role

An executor owns one transaction:

- read the active packet and minimum authoritative context;
- produce its required outcome;
- run specified checks;
- report a bounded evidence handoff;
- stop.

The executor does not need project continuity and must not begin the next packet.

## Just-in-time decomposition

The controller decomposes only until one safe next packet exists. Later packets remain hypotheses until current work produces evidence.

Create a new packet when there is a meaningful boundary, such as:

- an independently testable change;
- a different repository or authority boundary;
- a founder decision;
- an external/manual action;
- a merged PR boundary;
- a distinct verified audit correction.

Do not create packets to mimic conversational turns or organizational roles.

## Verification and autonomy

Autonomy means continuing without routine founder intervention. It does not mean bypassing controls.

The controller may advance automatically only when:

- acceptance criteria are satisfied;
- required checks pass;
- independent verification supports the handoff;
- the target repository's review and merge rules are satisfied;
- no interrupt condition applies.

A failed gate changes the state. It does not justify silently lowering the gate.

## Durable state

The parent issue contains current truth. The source queue contains priority and a link. Code and git contain shipped reality. Comments retain history but are excluded from normal retrieval.

This separation prevents the loop from turning either GitHub or an agent session into an ever-growing transcript.
