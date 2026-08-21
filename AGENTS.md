# Agent operating contract

Read this file before acting in this repository.

## Purpose

Loop-Dee-Loup is a control plane for disposable agent sessions. Durable state belongs in concise, authoritative artifacts. Conversation history and issue comments are not the source of truth.

## Authority

Use this order when claims conflict:

1. The active work packet's explicit scope and acceptance criteria.
2. The current parent issue snapshot.
3. Repository documentation.
4. Issue comments and historical discussion.

Escalate unresolved contradictions. Do not silently reconcile them.

## Required execution behavior

- Execute one bounded work packet per session.
- Read only the repository files and issue bodies needed for that packet.
- Do not read issue comments, closed child issues, old PR discussions, or logs by default.
- Do not recursively retrieve context. A packet must contain or link to a compact current snapshot.
- Do not expand scope merely because adjacent work is visible.
- Stop for a genuine founder decision, authority conflict, safety risk, or failed required check.
- Otherwise finish the packet, record its result, and stop. Do not continue into the next packet.
- Preserve the target repository's own branching, testing, review, and merge rules.

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

Create a child only at a meaningful context boundary: an independently completable unit, a founder decision, a different repository area, a merged PR boundary, or a distinct audit correction. Do not create children as substitutes for conversational turns.

A completed packet must report, concisely:

- STATUS
- CHANGED
- VERIFIED
- DECISIONS
- NEW RISKS
- NEXT
- PR

Target at most 1,000–1,500 tokens for the complete handoff unless the packet demonstrates why more is necessary.

## Prototype guardrail

Do not integrate Loop-Dee-Loup into a production repository until the experiment contract explicitly authorizes it. The first trial is Covenant's remaining `wolfscairn-list-and-privacy` work after PR #94: build the Buttondown signup surface, then verify the live flow end to end.
