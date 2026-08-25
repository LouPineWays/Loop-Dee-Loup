# LDL MCP server

`tools/mcp-server/` is a local-first MCP server that lets an MCP-compatible coding agent
working in a consumer repository cheaply and deterministically ask:

- Is this repository running current Loop-Dee-Loup (LDL)?
- What would change if it were updated?
- Can it be safely synchronized right now?
- Please synchronize it.

It exists because that loop was previously only available by hand-inspecting
`.ldl/manifest.json` and running `tools/ldl-init`/`tools/ldl-update` from a shell — workable,
but not something an agent session should reason its way through from raw files every time.
See issue #110 for the full background and acceptance criteria this server implements.

## What this is, and what it deliberately is not

This server is an **interface and coordination layer**, not a second implementation of LDL's
install/update logic and not a runtime dependency consumer repositories need after
synchronizing:

- Every tool below calls straight into the exact same exported functions
  `tools/ldl-init/index.mjs` and `tools/ldl-update/index.mjs` already use for the CLI —
  `run()`, `buildOps()`, `planUpdate()`, `isValidManifest()`, and friends. There is exactly one
  implementation of path ownership, manifest generation, hashing, and conflict detection; this
  server does not duplicate it. See `tools/mcp-server/status.mjs`.
- It is local-first, stdio-transport only. There is no hosted LDL service and this issue does
  not authorize building one.
- A consumer repository that has already been synchronized remains fully usable without this
  server. Once `.ldl/manifest.json` is current, an agent session in that repository gets its
  governing rules from the repository's own installed `AGENTS.md`, `docs/`, `.claude/`, and
  GitHub state — never by depending on a live MCP connection for its own operating model.
- It exposes exactly three bounded operations (`ldl_status`, `ldl_init`, `ldl_update`), not
  arbitrary file-write or shell-execution tools.

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

## Security boundary

- `ldl_status` never writes anything.
- `ldl_init`/`ldl_update` only ever act on the `dest` path they're given, using the same
  existence, non-directory, and symlink-write-through guards already enforced inside
  `tools/ldl-init`/`tools/ldl-update` (`findUnsafeDestReason`, `findUnsafeLdlDirReason`) — this
  server does not add, remove, or weaken those checks.
- There is no tool here that executes an arbitrary shell command or writes an arbitrary file;
  the tool surface is exactly the three operations documented above.

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
