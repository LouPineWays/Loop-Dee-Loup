# Session telemetry

A repository-local, deterministic collector for the measurable economics of a Claude Code
session — token/cost/context/subagent facts — without spending any model reasoning to
reconstruct them. Built for issue #45, as one concrete application of the deterministic-
mechanism hierarchy in issue #35 (`script → skill requiring judgment`): this script performs
the measurement; `.claude/skills/spend/SKILL.md` performs the judgment on top of it.

## What collects it, and how

Two Claude Code entry points, wired in `.claude/settings.json`:

- **`statusline.mjs`** — Claude Code's statusLine command. It's re-invoked on session start,
  on each new assistant message, on `/compact` completion, and a few other local render
  events — never on a model turn, so sampling it costs no API tokens. Its payload carries the
  session's running cost, context-window usage, and identity. This script appends a compact
  sample to the session's raw log **and** prints the actual status line text Claude Code
  displays — both duties are required, since stdout here is not optional.
- **`hook.mjs`** — a Claude Code hook, wired for `SessionStart`, `SessionEnd`, `PreCompact`,
  `PostCompact`, `SubagentStart`, and `SubagentStop`. Each firing appends one structural event
  (a boundary, a compaction, a subagent's identity and lifetime) to the same raw log. It never
  writes to stdout: a `SessionStart` hook's stdout is injected straight into the live session's
  context, and every other event's stdout is simply discarded, so any output here would either
  waste tokens or do nothing.

Both entry points share `collect.mjs`, which owns the on-disk shape and the privacy rule below,
and never throw — a telemetry failure must never interrupt or slow down real session use.

## What it deliberately cannot measure

Claude Code hooks and the statusLine payload do not expose per-turn or per-subagent token/cost
breakdowns — only OpenTelemetry does, and enabling OTel effectively requires standing up a
collector, which conflicts with this issue's "no hosted infrastructure" constraint. So this
collector can tell you a subagent *ran*, its type, and when it started and stopped, but not how
many tokens or how much cost it consumed. `reduce.mjs` names this explicitly in the record's
`unknown` list rather than estimating it — see "A field that cannot be measured reliably must
remain unknown" in issue #45's requirements. Likewise, per-turn input/output/cache token
breakdown and rate-limit consumption are unavailable from these interfaces.

## Where the data lives

Raw per-session event logs: `.claude/telemetry/sessions/<session_id>.jsonl` (one compact JSON
object per line — see `fixtures/*.jsonl` for real shapes). Reduced records:
`.claude/telemetry/records/<session_id>.json`. Both are git-ignored (`.claude/telemetry/` in
the repository root `.gitignore`) — this is transient local evidence, not durable repository
state. `LDL_TELEMETRY_DIR` overrides the whole tree, mainly so tests never touch a real
session's data.

## Privacy and data minimization

Only coarse identifiers and numeric measurements are ever written: session id, repo
owner/name, the basename (not full path) of the working directory, model id, cost/token/line
counts, context-window percentages, and (for subagent/compaction events) agent id/type and
compaction trigger. Never: prompts, responses, reasoning, tool output, source file contents,
`transcript_path`, or any other full filesystem path. `collect.test.mjs` and `hook.test.mjs`
assert this directly against payloads that include disallowed fields.

## Reducing a session

```
node tools/telemetry/reduce.mjs <session_id> [--out <path>]
```

Reads the session's raw log and prints a normalized record with three sections —
`measured` (straight from collected events), `derived` (deterministic arithmetic/aggregation),
and `unknown` (evidence this mechanism cannot establish, named explicitly). It also writes the
same record to `--out`, or `.claude/telemetry/records/<session_id>.json` by default.
`reduceEvents()` is exported as a pure function for testing and for direct use from another
script without shelling out.

The reducer never classifies anything as good, bad, wasteful, or efficient — see the
Non-goals section of issue #45. `.claude/skills/spend/SKILL.md` is the layer that applies
judgment, using this record as its primary evidence source instead of reconstructing these
facts from `/usage`, `/context`, or the transcript.

## Tests

```
node --test tools/telemetry/*.test.mjs
```

`reduce.test.mjs` exercises the pure reducer against four representative fixtures: a normal
single-agent session, a session with several subagent invocations, incomplete telemetry (a
session that ended before `SessionEnd` fired and before any statusLine sample landed), and a
session containing a compaction. `collect.test.mjs`, `hook.test.mjs`, and `statusline.test.mjs`
cover the shared helpers and both entry points, including end-to-end subprocess runs with
piped stdin. `reduce.cli.test.mjs` covers the reducer's CLI plumbing.
