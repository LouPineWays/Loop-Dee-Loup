# Agent operating contract

Read this file before acting in this repository.

## Purpose

Loop-Dee-Loup is a hyper-lean, issue-dispatched execution loop. Durable state belongs in concise, authoritative artifacts. Conversation history and issue comments are not the source of truth.

Version one has no persistent controller daemon. The founder starts or resumes a Claude Code session with a terse issue reference. The session autonomously executes the current packet, verifies it, updates durable state, prepares the next packet, and stops at a clean boundary.

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
- Do not create a child issue merely because another conversation turn is needed.
- Read only the files and issue bodies needed for the active packet.
- Do not recursively retrieve comments, closed children, old PR discussions, or logs by default.
- Do not expand scope merely because adjacent work is visible.
- Preserve the target repository's IP boundary, branching, testing, review, merge, release, and destructive-action rules.

## Session execution

After dispatch, the session must:

1. load the parent snapshot and active packet;
2. complete the packet without routine founder confirmation;
3. independently verify the claimed result;
4. update the parent snapshot with durable facts only;
5. create or designate exactly one next packet when work remains;
6. stop at the packet boundary with a concise handoff.

Do not ask whether to proceed with mechanically determined implementation, checks, verified review corrections, or handoff preparation. A new session start may be required to continue, but that is scheduling rather than approval.

## Session communication budget

Keep Claude Code messages deliberately terse. Normally send only:

- a brief kickoff acknowledgement;
- a concise founder question or manual-action request when blocked;
- a bounded completion or blocked handoff.

Do not narrate repository exploration, repeat issue contents, provide speculative plans already settled by the packet, or use chat as the durable log. Put evidence and current state in GitHub.

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

Target at most 1,000–1,500 tokens for the complete durable handoff. The chat summary should be much shorter and link to that record.

## Prototype guardrail

The first trial is Covenant's remaining `wolfscairn-list-and-privacy` work after PR #94: build the Buttondown signup surface, pass Covenant's existing gates, then verify the live flow end to end. Do not build an automatic session launcher or generalize the controller until evidence from this trial justifies it.
