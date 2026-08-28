# Telemetry battery log

Durable, append-only record of each `telemetry-battery` skill run (issue #199), so
coverage, verdicts, and findings can be compared across runs without re-deriving them from
session logs each time. Add one row per run; do not edit or delete prior rows. Full command
output stays local/transient (`.claude/telemetry/`, gitignored) — this log keeps only the
compact, comparable result.

| Date | Sample | Fields | Captured | Partial | Unavailable | Telemetry verdict | Spend verdict | Maker analysis | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-28 | 15 sessions | 8 | 4 | 2 | 2 | INSUFFICIENT | INCONCLUSIVE | NO NEW EVIDENCE SINCE #174 (2026-08-27, CLEAN) | Initial proving run for issue #199. Gaps are `measured.cost_usd_total`/`measured.cost_usd_by_model` (statusLine's confirmed non-interactive gap) and `measured.token_usage_main_total`/`measured.token_usage_subagent_total` present in only 5/15 sessions (post-#178 `SessionEnd`-not-always-invoked gap) — both already-documented structural limitations, not new discoveries. The battery correctly forced `Spend verdict: INCONCLUSIVE` instead of rounding an absence of new findings up to CLEAN, which is this run's actual success criterion per #199. No follow-up issue: first run, no prior row to compare against, and both gaps are already root-caused in `tools/telemetry/README.md`. |
