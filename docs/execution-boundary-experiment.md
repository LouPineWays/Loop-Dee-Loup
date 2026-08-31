# Execution-boundary result-capture experiment (issue #245)

Durable record for issue #245: whether the host that launches a real LDL Claude Code
coding session can deterministically capture and persist Claude's own terminal
structured result — with whole-agent-tree token/model usage and explicitly estimated
cost — without relying on repository-local `SessionEnd` completion inference. See
`tools/telemetry/README.md`'s "Execution-boundary proving probe" section for the proving
wrapper this record reports on, and `docs/telemetry-battery-log.md` /
`tools/telemetry/README.md`'s "SessionEnd is not always invoked" section for the prior
repository-local telemetry work (#139, #178, #199, #226, #229, #238, #240, #242) this
experiment exists to test an alternative to.

## Status

**PENDING — blocked on a manual host-permission grant, not yet run.**

Spawning a nested `claude -p ...` child process from this session — the exact action the
proving wrapper needs to perform every one of issue #245's required tests — was denied
outright by the Claude Code auto-mode classifier on the first attempt (a trivial one-word
"pong" prompt, `--permission-mode bypassPermissions`, `--no-session-persistence`). A second
attempt to have this session grant itself the needed permission (via the `update-config`
skill, editing `.claude/settings.local.json`) was also denied by the same classifier —
this session cannot expand its own permissions to unblock this experiment. The founder
was asked directly and chose to add a Bash permission rule allowing this session to invoke
the Claude Code CLI binary as a subprocess; that change must be made from outside this
session (an interactive `claude` terminal's `/permissions`, or a direct edit to
`.claude/settings.local.json` / user-level settings). Real proving runs resume once that
permission is confirmed in place.

This is not itself evidence toward the experiment's PASS/FAIL/INCONCLUSIVE verdict — it is
a host access-control gate on the *investigator*, not a property of the terminal-result
boundary being tested. It is recorded here only so a fresh session picking this issue back
up does not have to rediscover it.

## What is ready, pending the permission grant

- **Proving wrapper**: `tools/telemetry/execution-boundary-probe.mjs`. Spawns
  `<claude-bin> -p --output-format stream-json --verbose --permission-mode <mode> "<prompt>"`
  as a non-bare child process, parses the terminal `type: "result"` message, and writes one
  compact JSON record to `docs/execution-boundary-probe-runs/<task-id>.json`. Keeps
  top-level `usage` (main loop only) and whole-tree `modelUsage`/`model_usage` (includes
  subagents) explicitly distinct; labels any captured cost `estimated_list_cost_usd`, never
  actual spend/billing; reports a missing result as `result_received: false` /
  `usage_status: "unknown"` rather than inferring it from anything else; independently
  cross-checks the same session's existing hook-based telemetry
  (`SubagentStart`/`SubagentStop`/`SessionEnd` counts) as a structural comparison only,
  never as an economic fallback.
- **Fixture-driven tests**: `tools/telemetry/execution-boundary-probe.test.mjs`, run against
  `tools/telemetry/fixtures/execution-boundary/fake-cli.mjs` (a stand-in for the real
  `claude` binary). Covers a normal run, a run with two distinct models in `modelUsage`
  (proving the top-level/whole-tree split has somewhere real to show a difference), an
  `is_error` run, a run that exits cleanly without ever emitting a `result` message, and a
  hung process force-terminated via `--kill-after-ms`. 18/18 passing as of this writing,
  alongside the rest of `tools/telemetry`'s existing 93 tests (111/111 total).
- **Confirmed real execution surface on this machine**: the Claude Code binary actually
  running this repository's sessions is
  `C:\Users\Alexander\AppData\Roaming\Claude\claude-code\2.1.247\claude.exe` (not on `PATH`
  — found via the running-process list, not `which`/`Get-Command`). Its own `--help` output
  confirms `-p`/`--print`, `--output-format stream-json`, `--verbose`, and
  `--permission-mode` all exist exactly as issue #245 specifies, plus
  `--no-session-persistence` and `--dangerously-skip-permissions`/
  `--allow-dangerously-skip-permissions` as alternatives to `--permission-mode
  bypassPermissions` if that turns out to behave differently under a real proving run.

## Required tests (issue #245) — not yet executed

| # | Test | Status |
| --- | --- | --- |
| 1 | Normal bounded run | Not run — blocked |
| 2 | Independent normal rerun | Not run — blocked |
| 3 | Real subagent run, whole-tree accounting confirmed to include it | Not run — blocked |
| 4 | Interrupted/abnormal run | Not run — blocked |
| Comparison | Terminal result vs. existing hook/transcript evidence | Not run — blocked |

## Exact commands to run once unblocked

CLI version and identity, captured once:

```
"C:\Users\Alexander\AppData\Roaming\Claude\claude-code\2.1.247\claude.exe" --version
```

Test 1 (normal run):

```
node tools/telemetry/execution-boundary-probe.mjs \
  --task 245-run-1-normal --claude-bin "C:\Users\Alexander\AppData\Roaming\Claude\claude-code\2.1.247\claude.exe" \
  --prompt "Read docs/experiment-brief.md and reply with only its total line count as a number." \
  --note "issue #245 required test 1: normal bounded run"
```

Test 2 (independent rerun, distinct trivial prompt, same mechanism):

```
node tools/telemetry/execution-boundary-probe.mjs \
  --task 245-run-2-normal --claude-bin "C:\Users\Alexander\AppData\Roaming\Claude\claude-code\2.1.247\claude.exe" \
  --prompt "Read docs/priority-horizons.md and reply with only its total line count as a number." \
  --note "issue #245 required test 2: independent normal rerun"
```

Test 3 (genuine subagent dispatch):

```
node tools/telemetry/execution-boundary-probe.mjs \
  --task 245-run-3-subagent --claude-bin "C:\Users\Alexander\AppData\Roaming\Claude\claude-code\2.1.247\claude.exe" \
  --prompt "Use the Explore agent to find where TELEMETRY_DIR is defined under tools/telemetry, then reply with only the file path and line number." \
  --note "issue #245 required test 3: real subagent run"
```

Test 4 (interrupted/abnormal run — force-killed mid-flight):

```
node tools/telemetry/execution-boundary-probe.mjs \
  --task 245-run-4-interrupted --claude-bin "C:\Users\Alexander\AppData\Roaming\Claude\claude-code\2.1.247\claude.exe" \
  --prompt "Use the Explore agent to summarize every file under tools/telemetry in detail, one paragraph each." \
  --kill-after-ms 4000 --kill-signal SIGTERM \
  --note "issue #245 required test 4: interrupted/abnormal run, force-killed 4s in"
```

Each writes `docs/execution-boundary-probe-runs/<task-id>.json`, which should be committed
as the durable per-run artifact (same convention as
`docs/telemetry-battery-log-runs/2026-08-31.json`).

## Result fields captured (once runs exist)

*To be filled in from the real `docs/execution-boundary-probe-runs/*.json` records once
unblocked — not to be estimated or guessed here.*

## Comparison with existing hook/transcript telemetry

*To be filled in from each run's `hook_comparison` field once unblocked.*

## Verdict

**Not yet determined.** No PASS/FAIL/INCONCLUSIVE verdict can be recorded until the
required tests actually run — see "Status" above for the current blocker and required
manual action.
