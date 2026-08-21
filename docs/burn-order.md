# Loop-Dee-Loup Burn Order

## Purpose

Loop-Dee-Loup improves itself over time — new templates, tighter operating rules, tooling fixes. Those items need a backlog of their own, separate from any target repository's Burn Order (e.g. Covenant's). This document defines that backlog and how items reach it without the founder hand-entering them.

**Never conflate the two.** A target repository's Burn Order is that repository's own prioritized product backlog and stays out of Loop-Dee-Loup entirely. The Loop-Dee-Loup Burn Order below holds only items about the Loop's own process, tooling, and repository — never product features for a target repository.

## The artifact

The Loop-Dee-Loup Burn Order is a single pinned tracking issue, [#6](https://github.com/LouPineWays/Loop-Dee-Loup/issues/6), edited in place the same way a parent-execution issue is: its body is a compressed, current-priority list, not an append-only thread. Each candidate is one line: a short outcome statement, its priority position, and a link back to the intake issue it came from.

## Intake

The founder logs a raw idea with the `idea-intake` issue template (`.github/ISSUE_TEMPLATE/idea-intake.yml`) — a couple of short fields, fast to fill from a phone, no free-form issue writing required.

## Conversion

When a session is dispatched on (or resumes chat about) an open `idea-intake` issue:

1. Read the raw idea. If it is genuinely ambiguous, ask one direct concise question in chat per the founder interrupt conditions — do not open a full decision form for a single-item backlog entry unless it exposes a real multi-option founder decision.
2. Once clear, write it as one ironed-out outcome line (not an activity, not raw founder wording).
3. Edit issue #6's body directly to append that line at the bottom of `## Candidates` (or at the founder-requested position). Do not ask the founder to copy it in themselves.
4. Close the intake issue with `state_reason: completed`, labeled `converted`, linking to issue #6.
5. Report the fixed `CLEAN` chat line per `AGENTS.md` § Fixed chat report formats.

## Prioritization

The founder may reorder issue #6's body directly at any time. A session converting a new item appends it at the bottom by default and preserves existing order unless the founder asks for reprioritization.

## Turning a candidate into work

A Burn Order candidate is not yet an execution issue. When the founder picks one to run, derive a `parent-execution` (or directly a `work-packet`) issue from it in the normal way, and note in issue #6 that the candidate is now tracked by that issue number instead of sitting idle in the Burn Order.
