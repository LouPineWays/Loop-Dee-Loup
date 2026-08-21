---
name: retro
description: Run an evidence-based process retrospective after a completed Loop-Dee-Loup trial, stopping audit, or repeated workflow failure.
---

# Retro

Use git, PR, issue, audit, and token evidence. Do not reconstruct the process from chat memory.

Look for:

- repeated edits to the same area or root cause;
- extra inline review invocations;
- audit findings that should have been caught before merge;
- unreviewed or incorrectly based work;
- serial founder questions that could have been batched;
- parent snapshots that forced history retrieval;
- horizontal issue multiplication;
- token categories dominated by narration, startup payload, rereading, or mechanical execution;
- claims of completion without commit, check, or acceptance evidence.

Separate observed waste from hypotheses. Compare against a relevant baseline when available.

Propose at most three corrections, ranked by expected validated progress per token. Each correction must name the evidence, root cause, smallest governing artifact to change, enforcement rung (advice, checklist, script, CI/gate), verification, and rollback condition.

Prefer moving one proven rule up one enforcement rung over adding broad instructions. Apply an approved low-risk correction at the earliest safe boundary; otherwise return it as one founder-accepted independent outcome. Do not manufacture a process backlog.
