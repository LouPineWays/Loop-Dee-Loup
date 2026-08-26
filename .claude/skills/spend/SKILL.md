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
   as a routine replacement for the record, and never by parsing the transcript yourself to
   recompute a total `reduce.mjs` (or `/usage`/`/context`) already gives you deterministically.
   `tools/telemetry/` not existing in this repository at all (e.g. a consumer repository this
   hasn't been installed into yet, per `docs/consumer-contract.md`) is the same case as an
   empty record — fall back for everything, and say so plainly rather than treating it as an
   error to work around.
   If `measured.statusline_sample_count` is `0`, treat `cost_usd_total`, `context_window_size`,
   `last_context_used_percentage`, and `last_token_usage` as unavailable immediately and go
   straight to the `/usage`/`/context` fallback for them — do not spend a step probing session
   logs to rediscover this; see `tools/telemetry/README.md`'s "statusLine's confirmed
   non-interactive gap" for why this is a known, evidenced condition rather than a one-off.
   `measured.token_usage_main_total` / `measured.token_usage_subagent_by_agent_type` are a
   *separate* mechanism (recovered from the session's own transcript at SessionEnd/PreCompact,
   see `tools/telemetry/transcript.mjs`) and follow their own gate:
   `measured.transcript_usage_sample_count === 0` means they're unavailable this session —
   most commonly because the session hasn't reached SessionEnd or a compaction yet, or ran on
   a Claude Code build too old to supply `transcript_path` in hook payloads — there is no
   `/usage`/`/context` fallback for per-model/per-subagent-type token attribution specifically;
   report it as unavailable rather than reconstructing it from the transcript by hand.
4. Separately, inspect the smallest necessary durable repository state — the active issue's
   acceptance criteria, PR state, review/audit verdicts — to determine what outcome the session
   actually validated. Telemetry never establishes this; do not infer it from commit count,
   diff size, issue closure, or token consumption.

Never copy sensitive prompts, reasoning transcripts, or repository content into the report —
neither the telemetry record nor `/usage`/`/context` output should contain any, but check
before including anything verbatim.

## What telemetry can and cannot tell you

It can: session-total cost and duration (where statusLine fired); context-window usage over
the session, including the peak before a compaction, not just the last sample (where statusLine
fired); lines added/removed; structural subagent/compaction events (that one happened, its
type/trigger, when); and — from the session's own transcript, which works in this repository's
normal non-interactive execution mode where statusLine does not — total input/output/cache-read/
cache-creation tokens, broken down by model (`measured.token_usage_main_by_model`) and,
separately, by subagent type (`measured.token_usage_subagent_by_agent_type`), plus the
deterministic main-vs-subagent share of the session's token total (`derived.token_usage_grand_total`,
`derived.token_usage_main_share_of_total`).

It cannot: attribute tokens or cost to a specific *skill* invocation (no Claude Code interface
this collector uses exposes a skill-invocation boundary the way it does for subagents), break
tokens down per individual turn rather than per model/agent-type aggregate, compute monetary
cost from token counts (no pricing table — cost remains available only where statusLine's
`cost_usd_total` fired), or measure rate-limit consumption. `tools/telemetry/reduce.mjs`'s
`unknown` list names each of these explicitly every run, and no other command in this workflow
closes that gap. If a conclusion needs that granularity, report it as unavailable rather than
approximating it from something else.

## Evidence-sufficiency verdicts (CLEAN / NOT CLEAN / INCONCLUSIVE)

Every `/spend` report renders one verdict per material claim it makes, not just one verdict for
the whole session. A claim is any conclusion of the form "X was/wasn't a problem" or "X was/
wasn't appropriately allocated" — narrower structural observations ("no repeated compaction was
observed") are claims too, just claims with a lower evidence bar.

Before rendering a verdict for a claim that concerns token/cost allocation specifically, run
the deterministic gate instead of eyeballing the record:

```
node tools/telemetry/sufficiency.mjs <session_id> <claim_type>
```

`tools/telemetry/sufficiency.mjs`'s `CLAIM_REQUIREMENTS` names the claim types this gate covers
(`token_allocation`, `monetary_cost`, `context_utilization`, `compaction_frequency`,
`subagent_invocation_pattern`) and the exact record fields each one requires. It returns
`SUFFICIENT` or `INSUFFICIENT` plus the specific fields that are missing — never estimate this
by hand, and never add a new ad hoc completeness rule inside this skill; extend
`CLAIM_REQUIREMENTS` instead when a new class of claim needs its own evidence bar.

- **CLEAN** — the evidence needed for this claim is `SUFFICIENT`, and nothing in it supports a
  material defect or recurring inefficiency.
- **NOT CLEAN** — the evidence needed for this claim is `SUFFICIENT`, and it supports one or
  more material defects or recurring inefficiencies requiring correction.
- **INCONCLUSIVE / INSUFFICIENT EVIDENCE** — `assessSufficiency` (or the equivalent reasoning
  for a claim type it doesn't cover) returns `INSUFFICIENT`: material evidence this specific
  claim needs is unavailable. Never round this up to CLEAN. Say plainly which fields are
  missing (from `missingFields`) and why (usually `measured.transcript_usage_sample_count === 0`
  or `measured.statusline_sample_count === 0` — see the evidence order above).

**Missing evidence for one claim does not make every claim in the report inconclusive.** A
session with zero `transcript_usage` events can still render a CLEAN or NOT CLEAN verdict on
`compaction_frequency` or `subagent_invocation_pattern` — those claims' required fields
(`measured.compaction_events`, `measured.subagent_start_events`) come from hooks that fire
regardless — while its `token_allocation` claim must render INCONCLUSIVE. Keep each claim's
verdict scoped to the evidence that specific claim actually needed; do not let a strong
structural finding ("no review churn, no repeated founder interruption") get silently promoted
into a broader economic claim ("expenditure was appropriately scoped") that the same evidence
never supported. State the evidence boundary explicitly in the report instead.

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
7. **the CLEAN / NOT CLEAN / INCONCLUSIVE verdict for each material claim made**, per the
   Evidence-sufficiency section above — not one blended verdict for the whole report;
8. zero to three smallest justified corrections — it is a legitimate result to recommend none;
9. what, if anything, should be measured in a subsequent fresh session.

Do not pad the report to fill every category — a clean session can produce a very short one.
Never recommend weakening a safety, verification, review, audit, or founder-authority gate
merely to improve a measured token number.
