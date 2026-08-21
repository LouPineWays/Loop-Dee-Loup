---
name: context-clearing
description: Verify that a Loop-Dee-Loup PR, issue, or parent snapshot is a self-sufficient durable handoff before clearing, compacting, yielding, or replacing a session.
---

# Context clearing

Session context is a running cost. Clear or hand off when the needed state has been compressed into GitHub and the next step no longer benefits from the investigation or implementation history.

## Safe order

1. Open or update the PR, issue, or parent snapshot first.
2. Verify it by direct read.
3. Resolve any genuine founder decision before handing off.
4. Run `spend` now if the completed session is worth measuring.
5. Clear, compact, end, or create a disposable successor. Do not keep both sessions working.

Never clear first and hope the next session can reconstruct the work from comments or chat.

## Durable-record test

A successor with zero conversation memory must be able to recover:

- the intended outcome and non-goals;
- controlling authority and exact repository refs;
- what changed and why;
- acceptance and verification evidence;
- the current review stage and invocation count;
- accepted and rejected findings with root-cause disposition;
- unresolved blockers or founder decisions;
- the next authorized action.

A PR body also names the issue it closes. An audit issue names the exact merge commit and contains the complete read-only specification. A parent snapshot carries current truth rather than a transcript.

## Review-cycle boundaries

The Stage 1 review request and CLEAN Stage 2 close are natural context boundaries. After requesting Stage 1, use PR event delivery where available and let a fresh session handle the response. For a Stage 2 issue audit, delegate the trigger, bounded wait, and compact verdict extraction to one disposable context when possible; issue responses may not have PR event delivery.

Do not pull a full Codex audit report into a context-heavy orchestrator merely to learn CLEAN/NOT CLEAN. Return only the verdict, severity counts, and finding text needed to act.

## Autonomous handoff

When the environment can create a successor session and no human is present to clear manually, create exactly one successor only after the durable-record test passes. Its prompt names the repository, exact PR or issue URL, current stage, and governing files. It must read the durable record itself; do not paste a conversation summary. End the old session immediately after the handoff.

This is not a way to defer an unresolved decision, avoid required verification, or run concurrent duplicate controllers.
