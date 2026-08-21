# Loop-Dee-Loup

A GitHub-native control plane for reducing expensive conversational context in token-limited agent workflows.

## Core model

Loop-Dee-Loup treats the work packet, not the agent session, as the unit of work:

1. A source queue identifies the active work item.
2. A parent issue holds a compressed, current-state snapshot.
3. Bounded child issues define independently completable work packets.
4. Fresh agent sessions execute one packet and stop.
5. Code flows through the repository's normal PR, review, merge, and acceptance-audit process.
6. The parent snapshot advances only from verified results.

Issues are external state machines, not replacement chat transcripts.

## Prototype

The first experiment will run against one medium-sized WordBurner Burn Order item. It will measure validated progress per token, including total tokens, message/context tokens, user interventions, rereading, and rework.

See `docs/experiment-brief.md` after the initial setup PR for the governing experiment contract.
