# LDL MCP server

`tools/mcp-server/` is a local-first MCP server that lets an MCP-compatible coding agent
working in a consumer repository cheaply and deterministically ask:

- Is this repository running current Loop-Dee-Loup (LDL)?
- What would change if it were updated?
- Can it be safely synchronized right now?
- Please synchronize it.
- I've manually merged a parked bridge template into my own AGENTS.md/CLAUDE.md — please record that.

It exists because that loop was previously only available by hand-inspecting
`.ldl/manifest.json` and running `tools/ldl-init`/`tools/ldl-update` from a shell — workable,
but not something an agent session should reason its way through from raw files every time.
See issue #110 for the full background and acceptance criteria this server implements.

## What this is, and what it deliberately is not

This server is an **interface and coordination layer**, not a second implementation of LDL's
install/update logic and not a runtime dependency consumer repositories need after
synchronizing:

- Every tool below calls straight into the exact same exported functions
  `tools/ldl-init/index.mjs`, `tools/ldl-update/index.mjs`, and `tools/ldl-ack/index.mjs`
  already use for the CLI — `run()`, `buildOps()`, `planUpdate()`, `isValidManifest()`,
  `planAcknowledgeIntegration()`, and friends. There is exactly one implementation of path
  ownership, manifest generation, hashing, conflict detection, and manual-integration
  acknowledgement; this server does not duplicate any of it. See `tools/mcp-server/status.mjs`.
- It is local-first, stdio-transport only. There is no hosted LDL service and this issue does
  not authorize building one.
- A consumer repository that has already been synchronized remains fully usable without this
  server. Once `.ldl/manifest.json` is current, an agent session in that repository gets its
  governing rules from the repository's own installed `AGENTS.md`, `docs/`, `.claude/`, and
  GitHub state — never by depending on a live MCP connection for its own operating model.
- It exposes exactly four bounded operations (`ldl_status`, `ldl_init`, `ldl_update`,
  `ldl_acknowledge_integration`), not arbitrary file-write or shell-execution tools.

## Requirements

- Node.js 20+. (`tools/ldl-init`/`tools/ldl-update` themselves only need Node 18, but this
  server's committed lockfile resolves `@modelcontextprotocol/sdk`'s optional
  `@hono/node-server` dependency to a version whose declared `engines` require Node 20; on
  Node 18 with npm's engine-strict behavior, `npm install` fails.)
- A local clone of Loop-Dee-Loup, checked out at whatever revision you want consumer
  repositories compared against and synchronized to.

## Setup

From a Loop-Dee-Loup clone's root — every command below is root-relative, so there's no `cd`
to remember to undo before the next one:

```bash
npm install --prefix tools/mcp-server
```

Run it directly to confirm it starts (it will sit waiting for an MCP client on stdio; exit
with Ctrl-C):

```bash
node tools/mcp-server/server.mjs
```

Normally, though, an MCP-compatible client spawns this process for you — see below.

## Tools

### `ldl_status`

Read-only. Given `repos` (an array of consumer-repository paths) and an optional `root`
(defaults to this server's own Loop-Dee-Loup checkout), returns one compact status object per
repository:

```json
{
  "dest": "/path/to/consumer-repo",
  "status": "outdated",
  "installedRevision": "fcd53c3...",
  "sourceRevision": "6cda77c...",
  "updateAvailable": true,
  "managedFileCount": 17,
  "skippedFileCount": 0,
  "conflicts": [],
  "pendingManualIntegration": [],
  "next": "ldl_update"
}
```

`status` is one of `not_initialized`, `current`, `outdated`, or `conflict`, plus `error` for a
malformed or unreadable repository path (a bad path never fails the whole batch — other
repositories in the same call still resolve). If `repos` is omitted, the server falls back to
the `LDL_CONSUMER_REPOS` environment variable: a `path.delimiter`-separated list (`;` on
Windows, `:` elsewhere), read fresh on every call.

`pendingManualIntegration` lists every bridge file (`AGENTS.md` and/or `CLAUDE.md` — see
`docs/consumer-contract.md`, "The AGENTS.md and CLAUDE.md special case") this repository owns
that is currently parked at its `.ldl/*.template.md` path awaiting a manual merge into a
pre-existing consumer-owned file, each entry carrying `dest`, `template`, and `reason`. It is
independent of `status`: a repository can be `current` while a bridge sits at its template
indefinitely — that is expected steady state for a repository that already had its own
`AGENTS.md`/`CLAUDE.md`, not a defect. Do not treat a non-empty `pendingManualIntegration` as
"not yet installed"; treat it as "installed, but not yet active until merged by hand."

`warnings` (issue #217) lists reminders that don't affect `status` itself but still need a
human's attention. Today the only warning is the one `tools/ldl-sync` (LDL-managed automated
consumer synchronization — see `docs/consumer-contract.md`, "Automated consumer sync") reports
on every `ldl_status` call for as long as `tools/ldl-sync/**` is in this repository's managed
set, reminding the operator that the repository-level "Allow GitHub Actions to create and
approve pull requests" GitHub setting has not been verified by this tool. It never disappears
on its own — this server has no GitHub API access and cannot check that setting itself — so
treat its presence as "confirm the prerequisite manually," not as an error to fix in-repo.

### `ldl_init`

Bootstraps a consumer repository that has no valid `.ldl/manifest.json` yet. Takes `dest`
(required) and optional `root`. Identical behavior to running
`node tools/ldl-init/index.mjs --dest <dest>` directly, including never overwriting a
pre-existing unmanaged path.

### `ldl_update`

Conflict-safe update of an already-initialized `dest` to `root`'s current revision. Applies
the exact same synchronization `node tools/ldl-update/index.mjs --dest <dest>` does — writes
nothing if any LDL-managed file was locally modified or deleted since install, refusing the
entire update instead of guessing — and additionally reports compact structured evidence of
what changed:

```json
{
  "status": "updated",
  "previousRevision": "fcd53c3...",
  "resultingRevision": "6cda77c...",
  "changedPaths": ["docs/operating-model.md", "tools/local-worker/adapter.mjs"],
  "skippedPaths": [],
  "conflicts": [],
  "pendingManualIntegration": [],
  "manualIntegrationNeeded": 0,
  "noop": false
}
```

`status` is `"updated"`, `"current"` (a no-op — already up to date, nothing written), or
`"error"` (refused; `conflicts` lists exactly which managed paths could not be safely
reconciled, matching the CLI's own refusal). `changedPaths`/`skippedPaths` reflect a read-only
plan captured immediately before the real update runs; if that pre-check itself fails for any
reason, the update still proceeds using `tools/ldl-update`'s own logic — only the evidence
degrades, never the safety guarantee.

### `ldl_acknowledge_integration`

Records a durable, ownership-preserving attestation (issue #153) that the **current** LDL
bridge target for `AGENTS.md` or `CLAUDE.md` has been manually merged into the consumer-owned
root file it was parked next to — see `docs/consumer-contract.md`, "Two reconciliation modes for
a parked bridge". Takes `dest` (required), `bridge` (required — exactly `"AGENTS.md"` or
`"CLAUDE.md"`), and optional `root`. Identical behavior to running
`node tools/ldl-ack/index.mjs --dest <dest> --bridge <bridge>` directly.

```json
{
  "acknowledged": "AGENTS.md",
  "template": ".ldl/AGENTS.template.md",
  "manualIntegrationNeeded": 0,
  "manifestPath": ".ldl/manifest.json"
}
```

Refuses (writes nothing) when there is no current pending manual integration for the named
bridge — already installed, already content-match-graduated, or never actually parked — when the
bridge name is invalid, or when the parked template or the consumer-owned destination is missing
or unsafe (symlinked, or blocked by a non-directory). Never adds the acknowledged destination to
the managed `files[]` set: the file remains fully consumer-owned, never conflict-checked by a
later `ldl_update`. The acknowledgement is bound to the sha256 of the bridge's current target
content, not a timeless boolean — the next `ldl_status`/`ldl_update` call against this repository
reports the bridge pending again automatically the moment a later Loop-Dee-Loup revision actually
changes that bridge's content, without this tool needing to be called again for an unrelated
revision bump.

## Connecting a consumer-repository agent session

```text
Loop-Dee-Loup checkout
        |
start/configure LDL MCP  (this server, via stdio)
        |
consumer repo agent session
        |
     ldl_status
        |
  optional ldl_update / ldl_init
```

The one piece of configuration every setup needs is the absolute path to your local
Loop-Dee-Loup checkout — and that path is inherently machine-specific. Keep that distinction
explicit:

- **Portable, safe to commit to a consumer repository:** nothing. Do not commit an absolute
  path to your Loop-Dee-Loup checkout into a shared project file. If your coding-agent tooling
  supports environment-variable expansion in a committed MCP config (for example Claude Code's
  `.mcp.json` supports `${VAR}` expansion), you may commit a config that references a variable
  like `LDL_ROOT` — but not a config with the literal path baked in.
- **Local machine configuration, must not be committed:** the actual path. For Claude Code,
  register the server at **user** scope (applies across all your repositories, never written
  into any repository's own files) rather than project scope:

  ```bash
  claude mcp add ldl --scope user -- node /absolute/path/to/loop-dee-loup/tools/mcp-server/server.mjs
  ```

  Check `claude mcp --help` for the exact flags your installed version supports; the important
  part is choosing user (or another non-committed) scope, not project scope, for this entry.

Once connected, a session in your consumer repository can call `ldl_status` (optionally
passing `repos` explicitly, or relying on a pre-set `LDL_CONSUMER_REPOS`) to see whether it is
current, and `ldl_update` when it is not — without leaving the session or hand-reading
`.ldl/manifest.json`.

## Checking multiple known consumer repositories cheaply

Set `LDL_CONSUMER_REPOS` (in your own shell profile or MCP server env config — not committed
anywhere) to a `path.delimiter`-separated list of the repositories you maintain, and call
`ldl_status` with no `repos` argument to get a compact status summary across all of them in one
call, instead of loading each repository's full manifest or documentation into context.

## Process coherence

This server is a normal long-lived process: once started, its imported
`tools/ldl-init`/`tools/ldl-update`/`status.mjs` code stays exactly what was on disk at
startup, in memory, for the rest of its life — Node does not hot-reload an already-imported
module when its file changes later. But every tool call still re-reads managed-item source
content and re-resolves the current Loop-Dee-Loup revision fresh, from whatever is on disk
right now. If the backing Loop-Dee-Loup checkout is edited or updated (e.g. `git pull`, or a
founder session landing a fix) while this process keeps running, a naive implementation could
apply stale, already-loaded transformation logic to fresh source content and still report the
fresh revision as if the two were coherent (issue #146).

To prevent that, this server fingerprints the on-disk bytes of every file that determines its
own synchronization/derivation behavior — see `tools/mcp-server/staleness.mjs`, which includes
itself in that list, so a fix to this very guard is covered by the guard. A root is trusted
the first time this process ever operates against it (there is no earlier signal to compare
against), and every later call against that same root is checked against that baseline —
covering both the server's own default backing checkout and any different checkout a caller
explicitly selects via the per-call `root` argument, since either can drift while this process
keeps running. The check runs once per tool call and, for the three consumer-mutating tools
(`ldl_init`/`ldl_update`/`ldl_acknowledge_integration`), a second time immediately before the actual write — narrowing the
window in which the checkout could change between the read-heavy planning phase and the
mutation itself. Once the fingerprint has changed, every tool (including the read-only
`ldl_status`) refuses with a compact error explaining that the server process is stale and
must be restarted, rather than silently producing output that mixes old code with new
provenance. This is automatic: nothing about it requires remembering to restart the server
after every LDL change, only noticing the one time an operation is actually attempted against
a checkout that moved underneath it.

`LDL_MCP_ROOT` (an environment variable, not a tool argument) overrides which checkout this
server treats as its own backing checkout for this fingerprint — real deployments never need
to set it, since the default is simply this file's own location. It exists for tests that
need to spawn a real `node server.mjs` process pointed at a disposable fixture directory they
can mutate after the process has started; see `tools/mcp-server/server.test.mjs`'s "process
coherence" tests.

## Security boundary

- `ldl_status` never writes anything.
- `ldl_init`/`ldl_update`/`ldl_acknowledge_integration` only ever act on the `dest` path they're
  given, using the same existence, non-directory, and symlink-write-through guards already
  enforced inside `tools/ldl-init`/`tools/ldl-update`/`tools/ldl-ack` (`findUnsafeDestReason`,
  `findUnsafeLdlDirReason`) — this server does not add, remove, or weaken those checks.
  `ldl_acknowledge_integration` additionally never adds its acknowledged destination to the
  managed `files[]` set, so it can never turn a consumer-owned file into one a later `ldl_update`
  would conflict-check or overwrite.
- There is no tool here that executes an arbitrary shell command or writes an arbitrary file;
  the tool surface is exactly the four operations documented above.

## Tests

```bash
npm install --prefix tools/mcp-server   # once
node --test tools/mcp-server/*.test.mjs
```

`status.test.mjs` covers the read-only status computation directly (fixture-based, matching
`tools/ldl-init/index.test.mjs` and `tools/ldl-update/index.test.mjs`'s conventions).
`server.test.mjs` drives the actual MCP protocol surface (`tools/list`, `tools/call`) — mostly
over an in-process transport, plus one smoke test that spawns the real
`node tools/mcp-server/server.mjs` process over real stdio.
