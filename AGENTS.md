# Agent operating contract

Read this file before acting in this repository.

## Purpose

Loop-Dee-Loup is a hyper-lean autonomous execution loop. Durable state belongs in concise, authoritative artifacts. Conversation history and issue comments are not the source of truth.

The controller and executor have different lifetimes:

- An executor handles one bounded packet, records evidence, and stops.
- The controller refreshes durable state, selects the next transition, and starts a fresh executor automatically.

An executor stopping is not the loop stopping.

## Authority

Use this order when claims conflict:

1. The active work packet's explicit scope and acceptance criteria.
2. The current parent issue snapshot.
3. The target repository's governing instructions and source of truth.
4. Loop-Dee-Loup documentation.
5. Issue comments and historical discussion.

Escalate unresolved contradictions. Do not silently reconcile them.

## Lean operating rules

- Use the smallest independently verifiable increment that advances the accepted feature.
- Decompose only enough to identify the next safe packet.
- Do not manufacture epics, sprints, ceremonies, departments, personas, or role handoffs unless they solve an observed control problem.
- Do not create a child issue merely because another conversation turn or agent session is needed.
- Read only the files and issue bodies needed for the active packet.
- Do not recursively retrieve comments, closed children, old PR discussions, or logs by default.
- Do not expand scope merely because adjacent work is visible.
- Preserve the target repository's IP boundary, branching, testing, review, merge, release, and destructive-action rules.

## Autonomous continuation

After a packet completes, the controller must:

1. independently verify the claimed result;
2. update the parent snapshot with durable facts only;
3. determine the next state transition from current evidence;
4. create or designate exactly one next packet when work remains;
5. dispatch a fresh executor without founder confirmation when no interrupt condition applies.

Routine implementation choices, test fixes, verified review corrections, packet handoffs, and merges after all repository gates pass do not require founder approval.

## Founder interrupt conditions

Stop the loop and ask a concise question only when existing authority cannot resolve:

- product intent or the desired user/business outcome;
- a material scope, UX, monetization, legal, privacy, security, or irreversible tradeoff;
- required credentials or an external action that only the founder can perform;
- a failed safety/correctness gate with no authorized recovery path;
- whether a newly discovered opportunity belongs inside the approved feature;
- a direct contradiction between controlling sources.

Record the decision in the parent snapshot, then resume autonomously.

## Parent snapshots

A parent issue body is a mutable current-state snapshot, not an append-only diary. It must keep:

- objective;
- current state;
- settled decisions;
- scope and non-goals;
- authoritative files;
- acceptance criteria;
- completed packets;
- current blocker;
- next packet.

History may remain in comments for auditability, but executors must not normally read it.

## Work packets

A packet must have one required outcome, bounded scope, explicit checks, and a stopping condition. A completed packet reports:

- STATUS
- CHANGED
- VERIFIED
- DECISIONS
- NEW RISKS
- NEXT
- PR

Target at most 1,000–1,500 tokens for the complete handoff unless the packet demonstrates why more is necessary.

## Prototype guardrail

The first trial is Covenant's remaining `wolfscairn-list-and-privacy` work after PR #94: build the Buttondown signup surface, pass Covenant's existing gates, then verify the live flow end to end. Do not generalize the controller or change production-repository process rules until evidence from this trial justifies it.
