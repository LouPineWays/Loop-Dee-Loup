---
name: spend
description: Diagnose where a Loop-Dee-Loup session spent tokens and whether that spend produced validated progress.
---

# Spend

Optimize validated progress per token, not minimum tokens. A session can be expensive and
appropriate, or cheap and wasteful — token count alone never decides which.

This skill is the judgment layer on top of deterministic telemetry (`tools/telemetry/`, see
its README). It must not spend model reasoning reconstructing facts that mechanism already
measured or derived. It also must not treat that mechanism's output as proof of quality:
telemetry establishes what happened, never whether it was good.

## Evidence order

1. **Reduce the current session's telemetry first**, if not already reduced:
   `node tools/telemetry/reduce.mjs <session_id>` (the running session's id is available from
   the statusLine payload's `session_id`, or from `.claude/telemetry/sessions/` if only one
   session is present). This is a deterministic script — running it costs no model tokens
   beyond issuing the command.
2. Read the printed record's three sections — `measured`, `derived`, `unknown` — and keep that
   separation in the final report. Do not present a `judged` conclusion as if the record itself
   proved it.
3. Only when the record is missing, empty, or missing a field this analysis actually needs,
   fall back to the platform's own `/usage` or `/context` report for that specific gap — never
   as a routine replacement for the record, and never by parsing the transcript to recompute a
   total the record (or `/usage`/`/context`) already gives you. `tools/telemetry/` not existing
   in this repository at all (e.g. a consumer repository this hasn't been installed into yet,
   per `docs/consumer-contract.md`) is the same case as an empty record — fall back for
   everything, and say so plainly rather than treating it as an error to work around.
   If `measured.statusline_sample_count` is `0`, treat `cost_usd_total`, `context_window_size`,
   `last_context_used_percentage`, and `last_token_usage` as unavailable immediately and go
   straight to the `/usage`/`/context` fallback for them — do not spend a step probing session
   logs to rediscover this; see `tools/telemetry/README.md`'s "Observed gap: statusLine has not
   been seen to fire" for why this is a known, evidenced condition rather than a one-off.
4. Separately, inspect the smallest necessary durable repository state — the active issue's
   acceptance criteria, PR state, review/audit verdicts — to determine what outcome the session
   actually validated. Telemetry never establishes this; do not infer it from commit count,
   diff size, issue closure, or token consumption.

Never copy sensitive prompts, reasoning transcripts, or repository content into the report —
neither the telemetry record nor `/usage`/`/context` output should contain any, but check
before including anything verbatim.

## What telemetry can and cannot tell you

It can: session-total cost and duration, context-window usage over the session (including the
peak before a compaction, not just the last sample), lines added/removed, structural
subagent/compaction events (that one happened, its type/trigger, when).

It cannot: attribute tokens or cost to a specific subagent or skill invocation, break tokens
down per turn, or measure rate-limit consumption — `tools/telemetry/reduce.mjs`'s `unknown`
list names these explicitly each time, and no other command in this workflow closes that gap.
If a conclusion needs that granularity, report it as unavailable rather than approximating it
from something else.

## Judgment

Using the record plus the outcome evidence from step 4 above, classify spend into: fixed
startup/instruction payload; issue and repository authority; tool input/output; repeated reads
or rediscovery; chat narration and status repetition; founder decision dialogue;
implementation/reasoning; verification and review; rework; handoff and durable-state
maintenance. Attribute what the evidence actually supports — a large subagent total from
`derived.subagent_invocation_count`/`subagent_type_counts` is not by itself evidence of waste,
and a high-token session that safely closed a difficult validated outcome is not either.

Do not produce a composite efficiency score, grade, ranking, target token count, or a
"good/bad" threshold for commits, reviews, sessions, subagents, founder interactions, or lines
changed. None of those quantities has an inherently desirable direction — more review spend may
have prevented a defect; more sessions may have preserved cleaner context boundaries; a founder
interruption may have been a mandatory decision, not overhead.

Report:

1. validated outcome (from repository/issue/PR state, not from telemetry);
2. compact measured session economics (from the record's `measured` section);
3. material deterministic observations (from `derived`);
4. spend that appears necessary for correctness or verification;
5. avoidable waste, only with exact evidence — evidenced, not merely hypothesized from a large
   number;
6. confidence/evidence limitations, including anything in the record's `unknown` list that
   would have mattered;
7. zero to three smallest justified corrections — it is a legitimate result to recommend none;
8. what, if anything, should be measured in a subsequent fresh session.

Do not pad the report to fill every category — a clean session can produce a very short one.
Never recommend weakening a safety, verification, review, audit, or founder-authority gate
merely to improve a measured token number.
