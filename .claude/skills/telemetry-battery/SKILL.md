---
name: telemetry-battery
description: Run the approximately-weekly /spend + maker telemetry validation battery, gating optimization conclusions on telemetry coverage rather than assuming instrumentation is sufficient.
---

# Telemetry battery

For issue #199: validate the telemetry system itself, on a cadence, separately from
optimizing LDL. Invoke roughly weekly, after real LDL/consumer activity has accumulated —
never per issue, per merged PR, or per methodology tweak. If the last recorded row in
`docs/telemetry-battery-log.md` is under a week old and no unusual volume of work has
happened since, say so and stop rather than running again.

## Step 1 — telemetry coverage, before any optimization claim

If `docs/telemetry-battery-log.md` has a prior row, read its **As of** cutoff and run:

```
node tools/telemetry/coverage.mjs --since <prior As of cutoff> [--exclude-session <this session's id, if known>]
```

so this run's sample is genuinely new evidence, not the same sessions the prior row already
counted. If the resulting sample is empty, there is not yet enough new activity — say so and
stop without recording a zero-evidence row. On the very first run (no prior row), use
`--sample 15` instead. Pass `--exclude-session` with this invoking session's own session id
when it is knowable (e.g. from the running session's own telemetry log); a still-running
session has no `SessionEnd`/whole-session measurement yet and, left in the sample, would
inject a guaranteed partial/unavailable result purely from still being open. If the id can't
be determined, note that limitation in the run's log row rather than silently accepting a
skewed sample.

This aggregates `sufficiency.mjs`'s existing per-claim evidence requirements —
`CLAIM_REQUIREMENTS`, the real `/spend` evidence contract — across the sample, applying the
exact predicate each field needs (present / positive / exactly true), so the
"decision-critical fields" list and their pass/fail rule are never a second, hand-maintained
checklist. Do not eyeball `.claude/telemetry/records/*.json` by hand or invent a different
completeness rule.

Read the printed verdict plainly:

- **SUFFICIENT** — every decision-critical field was captured in every sampled session.
- **INSUFFICIENT** — one or more fields are `partial` or `unavailable` (the report names
  them). Do not round this up to CLEAN for the overall run (see Step 3).

A gap that matches an already-documented structural limitation (see
`tools/telemetry/README.md`: statusLine never firing outside an interactive terminal,
`SessionEnd` not always invoked) is not new evidence needing a new issue — it is confirming
prior findings still hold. Only a **newly appeared** gap, a **regressed** previously-captured
field, or the **same** gap persisting across two or more consecutive battery runs *that each
sampled genuinely new sessions* (see Step 4) is worth escalating.

## Step 2 — maker telemetry (repository evidence, not session tokens)

No Claude Code interface exposes a skill-invocation boundary the way it does a
subagent/Task boundary, so `persona-maker` / `script-maker` / `skill-maker` execution can
never be measured from session token telemetry — `coverage.mjs` already reports
`per_skill_token_or_cost_attribution` as structurally not applicable, not silently omitted.
Maker activity is instead evaluated from durable repository evidence: issues/PRs the maker
skills produced since the last battery (new scripts under `tools/`, new skills under
`.claude/skills/`, new personas under `.claude/personas/`, and any issue created by a maker
sweep such as #174). Note counts and whether any produced mechanism has since reduced
recurring reasoning cost — do not re-run the full `/spend → script-maker → skill-maker →
persona-maker` sweep order from issue #174 unless real new evidence since the last sweep
justifies it; a battery run is a validation check, not an automatic excuse to re-open a
maker sweep.

## Step 3 — render the combined verdict

```
Telemetry verdict: SUFFICIENT | INSUFFICIENT
Spend verdict:     CLEAN | NOT CLEAN | INCONCLUSIVE (per material claim)
Maker analysis:    NO ACTIONABLE FINDINGS | <finding>
```

Apply `.claude/skills/spend/SKILL.md`'s own per-claim evidence-sufficiency rules — this
skill does not duplicate or override that judgment, and does not collapse it into one
blended verdict. `Telemetry verdict: INSUFFICIENT` here means at least one decision-critical
field is not reliably captured across the sample; it prohibits reporting the run's *overall*
economic picture as `CLEAN` (an unqualified "expenditure was fine" claim resting on gapped
evidence), but it does **not** by itself force every individual claim to `INCONCLUSIVE`.
`monetary_cost_by_model` is always `INSUFFICIENT` today (no local pricing table) — if that
were treated as a global gate, `Spend verdict` could never be anything but `INCONCLUSIVE`,
permanently masking a real `NOT CLEAN` finding on a claim (e.g. `compaction_frequency`,
`subagent_invocation_pattern`) whose own evidence is actually `SUFFICIENT`. Render each
material claim's verdict on its own evidence, exactly as `/spend` already does; use the
overall `Telemetry verdict` only to decide whether an *overall* CLEAN summary is permitted.

A `SUFFICIENT` / `CLEAN` / `NO ACTIONABLE FINDINGS` run is a successful result, not a
prompt to keep searching for a finding. Stop there.

## Step 4 — record the run and check for a trend

Append one row to `docs/telemetry-battery-log.md`: date, sample size, the sample's **As of**
cutoff (`coverage.mjs`'s printed value — pass this as the next run's `--since`), coverage
counts, the three verdicts, and a one-line note.

Before opening a new issue over a gap or regression, check the log's immediately preceding
row. Because Step 1 requires `--since <prior As of>`, a repeated gap across two consecutive
rows is already guaranteed to reflect two disjoint sets of sessions, not the same stale
evidence counted twice — treat that repetition (or a field that regressed from `captured` to
`partial`/`unavailable`) as a persistent trend worth a follow-up issue. A gap appearing only
in the first-ever run (no prior row to compare against), or one that already has an open
tracking issue, is not new escalation-worthy evidence.
