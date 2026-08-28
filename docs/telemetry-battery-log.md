# Telemetry battery log

Durable, append-only record of each `telemetry-battery` skill run (issue #199), so
coverage, verdicts, and findings can be compared across runs without re-deriving them from
session logs each time. Add one row per run; do not edit or delete prior rows. Full command
output stays local/transient (`.claude/telemetry/`, gitignored) — this log keeps only the
compact, comparable result. Pass a row's **As of** value as the next run's `--since`.

| Date | Sample | As of | Fields | Captured | Partial | Unavailable | Telemetry verdict | Spend verdict | Maker analysis | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-28 | 15 sessions | 2026-08-28T07:31:28.565Z | 8 | 3 | 2 | 3 | INSUFFICIENT | INCONCLUSIVE (token/cost claims); SUFFICIENT for `compaction_frequency` and `subagent_invocation_pattern` (fully captured, no material finding) | NO NEW EVIDENCE SINCE #174 (2026-08-27, CLEAN) | Initial proving run for issue #199 (`node tools/telemetry/coverage.mjs --sample 15 --exclude-session <this run's own session id>`). Gaps: `measured.cost_usd_total`/`measured.cost_usd_by_model` (statusLine's confirmed non-interactive gap), `measured.token_usage_is_session_complete` (0/15 — no genuine `SessionEnd`-sourced sample in the sample), and `measured.token_usage_main_total`/`measured.token_usage_subagent_total` (partial, 5/15 — post-#178 `SessionEnd`-not-always-invoked gap). All three are already-documented structural limitations, not new discoveries. Per-claim rendering (not a single blended verdict) correctly keeps the fully-evidenced structural claims out of the token/cost claims' INCONCLUSIVE result. No follow-up issue: first row, no prior cutoff to diff against, and every gap is already root-caused in `tools/telemetry/README.md`. |
