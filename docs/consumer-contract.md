# LDL consumer-repository contract

This document defines the ownership boundary between Loop-Dee-Loup-managed
machinery and consumer-repository-owned material, and describes the bootstrap
mechanism (`tools/ldl-init`) and the update mechanism (`tools/ldl-update`)
that install and refresh that machinery in an arbitrary existing repository.
It is itself one of the files those mechanisms install, so an installed copy
is available in the consumer repository without depending on this repository
being reachable at runtime.

See `docs/operating-model.md`, `docs/bounded-review-cycle.md`, and
`docs/decision-forms.md` for how the Loop itself works once installed.

## Two ownership domains

### LDL-managed (installed by `tools/ldl-init`, update-eligible)

Reusable engine/runtime material distributed from this repository:

- `.claude/skills/context-clearing/`, `local-worker/`, `model-check/`,
  `persona-maker/`, `retro/`, `script-maker/`, `sift/`, `skill-maker/`,
  `spend/` — the operational skills the Loop dispatches;
- `.claude/personas/audit-verdict-extractor.md` — the reusable Stage 2
  verdict-extraction persona;
- `tools/local-worker/` — the local-LLM delegation adapter;
- `tools/review-watch/` — the early-exit-on-match review-polling script;
- `docs/operating-model.md`, `docs/bounded-review-cycle.md`,
  `docs/decision-forms.md`, `docs/consumer-contract.md` — the operating
  model documentation those skills and the bounded review cycle depend on;
- `.github/ISSUE_TEMPLATE/` — the issue templates the installed docs
  reference by name (e.g. `docs/bounded-review-cycle.md` Stage 2 names the
  `audit-control-issue` template directly), so a consumer repository can
  actually follow what its own installed documentation instructs it to do;
- `AGENTS.md` — installed only as described under "The AGENTS.md and
  CLAUDE.md special case" below, since a consumer repository may already
  have its own;
- `CLAUDE.md` — the Claude Code project-instruction entry point that
  imports `AGENTS.md` via `@AGENTS.md`, so a fresh Claude Code session has
  the installed operating contract active from session start without a
  manual `Read`. Installed only as described under "The AGENTS.md and
  CLAUDE.md special case" below, for the same reason as `AGENTS.md`: a
  consumer repository may already have its own `CLAUDE.md`.

Nothing else in this repository is installed. In particular, `tools/burn-order/`,
`docs/burn-order.md`, `docs/burn-order.json`, `docs/experiment-brief.md`,
`tools/check-control-plane-paths.mjs`, this repository's own `README.md`, and
its GitHub issue/PR history are Loop-Dee-Loup's own development state, not
reusable machinery, and are never installed into a consumer repository.

`tools/telemetry/` (the deterministic session-telemetry collector/reducer the installed
`spend` skill can use, see `tools/telemetry/README.md`) and the `statusLine`/`hooks` wiring
in this repository's own `.claude/settings.json` are, unlike the paths above, reusable
machinery in principle — but issue #45 scoped their delivery to this repository only.
`tools/ldl-init` does not currently install either one. A consumer repository's installed
`spend` skill degrades to its `/usage`/`/context` fallback when `tools/telemetry/` is
absent, so this gap does not break an installed consumer repository; it only means that
repository is not yet collecting the deterministic evidence `spend` prefers. Extending
`tools/ldl-init`'s manifest to install `tools/telemetry/` and a merge-safe
`.claude/settings.json` is unstarted follow-on work, not part of issue #45.

### Consumer-owned (never overwritten)

Everything else in the consumer repository: project source, project issues
and PRs, project-specific instructions and configuration, project-specific
skills or personas under other names, CI, build/test/verification commands,
and any pre-existing `AGENTS.md` or `CLAUDE.md`. `tools/ldl-init` never
touches a path outside the LDL-managed list above, and never overwrites a
destination path that already exists and was not itself installed by a
prior `tools/ldl-init` run (see "Safety and idempotency" below).

## How to bootstrap

From a local clone of Loop-Dee-Loup, run:

```bash
node <path-to-loop-dee-loup-clone>/tools/ldl-init/index.mjs --dest <path-to-your-project>
```

`--dest` must already exist; it does not need to be empty. There is
currently no package registry, hosted service, or daemon — a local clone is
the documented source. See `tools/ldl-init/index.mjs`'s header comment for
full usage.

## How to update

From a local clone of Loop-Dee-Loup checked out at whatever revision you want
to move the consumer repository to, run:

```bash
node <path-to-loop-dee-loup-clone>/tools/ldl-update/index.mjs --dest <path-to-your-project>
```

`--dest` must already have a valid `.ldl/manifest.json` from a prior
`tools/ldl-init` run — `tools/ldl-update` has nothing to update from
otherwise and errors out instructing the caller to bootstrap first. Like
`tools/ldl-init`, `tools/ldl-update` is not itself installed into a consumer
repository; it is run from a local Loop-Dee-Loup clone against `--dest`. See
`tools/ldl-update/index.mjs`'s header comment for full usage.

Each run:

- rebuilds the same target content `tools/ldl-init` would install from the
  clone's current revision (the same `MANAGED_ITEMS` list and derived
  `AGENTS.md` logic — see below);
- for every LDL-managed destination, compares its current on-disk content
  against both the hash recorded in the existing manifest and the new target
  content, and updates only the paths that are unmodified since install and
  whose target content actually changed;
- refuses the entire run, writing nothing, if any LDL-managed file's on-disk
  content matches neither the recorded provenance nor the new target content
  (a local edit), or if an LDL-managed file recorded in the manifest is
  missing from disk (a local deletion) — see "Conflict-safe updates" below;
- is a no-op — it does not touch `.ldl/manifest.json` or any managed file at
  all — when nothing needs to change;
- otherwise writes the changed/newly-added managed files and rewrites
  `.ldl/manifest.json` with the new source revision, a fresh install
  timestamp, and the complete resulting set of managed paths.

A destination not yet recorded as managed (a newly added `MANAGED_ITEMS`
entry in the newer revision) follows the same pre-existing-file rule as
`tools/ldl-init`: it installs if the path is free, and is left alone and
recorded under `skipped` if something unmanaged already occupies it.

## The AGENTS.md and CLAUDE.md special case

Loop-Dee-Loup's own `AGENTS.md` contains a few sections specific to
Loop-Dee-Loup's own development (its own Burn Order, its own prototype
trial). Those sections are wrapped in `<!-- ldl:source-only:start -->` /
`<!-- ldl:source-only:end -->` markers and are stripped before installation,
so what a consumer repository receives is the generic operating contract —
vertical-slice rule, decomposition boundary, decision-form rule, session
execution, bounded review cycle, and the operational-skills index — without
Loop-Dee-Loup's own instance-specific state.

`AGENTS.md` alone is not enough to make that contract active in a fresh
Claude Code session: Claude Code loads project instructions from `CLAUDE.md`,
not `AGENTS.md`, so a consumer repository with an installed `AGENTS.md` but
no `CLAUDE.md` has no durable, automatic bridge into a fresh session's
context — a session only picks up the operating contract if something in
the conversation happens to tell it to read `AGENTS.md` by hand. Loop-Dee-
Loup's own root `CLAUDE.md` is therefore itself the source of the second
managed bridge file: a few lines that import `AGENTS.md` with `@AGENTS.md`
(a Claude Code memory-import: the referenced file's content is expanded into
context at session start, without a tool-driven `Read`) plus the same
skills-location note this repository's own copy carries. Copying that exact
file into a consumer repository is what makes the installed operating
contract active there from session start, not merely present on disk.

`AGENTS.md` and `CLAUDE.md` share one ownership rule, applied independently
to each file:

- If the consumer repository has no file of that name yet, the derived
  (`AGENTS.md`) or copied (`CLAUDE.md`) content is installed at the
  repository root under that name.
- If the consumer repository already has a same-named file that a prior
  `tools/ldl-init`/`tools/ldl-update` run did not itself install, that file
  is left completely untouched, and the derived/copied content is written
  instead to `.ldl/AGENTS.template.md` / `.ldl/CLAUDE.template.md` for the
  project to review and merge in by hand.

This is the smallest explicit configuration surface consistent with the
non-goal against rewriting a project's own `AGENTS.md` or `CLAUDE.md` merely
to fit LDL. It is also why `AGENTS.md` and `CLAUDE.md` are resolved
separately from every other managed path in `tools/ldl-init/index.mjs`'s
`BRIDGE_FILES` list rather than `MANAGED_ITEMS`: their destination depends on
consumer repository state, not source repository state alone. Each of the
two files resolves its own destination independently — a consumer that
already owns `AGENTS.md` but not `CLAUDE.md` gets `AGENTS.md` parked at its
template while `CLAUDE.md` installs straight to the root, and vice versa.

### Unresolved manual integration is never presented as full activation

Whenever a bridge file lands at its template path instead of its own root
destination, that is a required manual step, not a completed install: a
prior run genuinely could not make the operating contract active without a
human merging the template in by hand. Every `tools/ldl-init` and
`tools/ldl-update` run reports this explicitly rather than only leaving the
template file on disk for someone to notice later:

- `.ldl/manifest.json`'s `pendingManualIntegration` array (see "Provenance
  manifest" below) records every bridge file currently parked at a template,
  with the exact template path and a human-readable reason;
- the CLI/MCP JSON result of every run reports a `manualIntegrationNeeded`
  count alongside `installed`/`updated` and `skipped`;
- `tools/mcp-server`'s `ldl_status` tool (see `docs/mcp-server.md`) surfaces
  the same array as `pendingManualIntegration` per repository, independent of
  whether that repository's sync status is `current`, `outdated`, or
  `conflict` — a repository can be fully synchronized while a bridge sits at
  its template indefinitely; that is expected steady state, not a defect.

A repository with a non-empty `pendingManualIntegration` must not be treated
as fully activated: activation is not complete until the corresponding
template has been merged into the consumer-owned file it was parked next to.

## Provenance manifest

Every `tools/ldl-init` bootstrap run writes `.ldl/manifest.json` in the
consumer repository. A `tools/ldl-update` run writes it only when it
actually applies a change — see "Conflict-safe updates" below for when an
update run is a no-op that leaves the manifest untouched, or refuses
entirely and writes nothing:

```json
{
  "schemaVersion": 1,
  "ldlSourceRevision": "<git commit sha of the Loop-Dee-Loup clone used, or \"unknown\">",
  "installedAt": "<ISO-8601 timestamp of this run>",
  "files": [{ "dest": "<repo-relative path>", "sha256": "<hex digest>" }],
  "skipped": [{ "dest": "<repo-relative path>", "reason": "<why it was left alone>" }],
  "pendingManualIntegration": [
    { "dest": "<AGENTS.md or CLAUDE.md>", "template": "<its .ldl/*.template.md path>", "reason": "<why a human must merge it by hand>" }
  ]
}
```

`ldlSourceRevision` carries a `-dirty` suffix (the `git describe --dirty` convention) when
the Loop-Dee-Loup clone used to install had uncommitted changes at install time, since
`tools/ldl-init` copies working-tree bytes rather than committed blobs — the recorded
revision must describe what was actually installed, not merely what commit was checked
out. A `.ldl/manifest.json` that exists but is not in this shape (missing, truncated, or
written by something else entirely) is treated as absent rather than trusted or used to
crash the run.

`files` is the durable, machine-readable record of exactly which paths in
the consumer repository are LDL-managed — a fresh coding-agent session can
read it without any conversation history to determine both the installed
LDL revision and the installed-file manifest required by the bootstrap
acceptance criteria. `skipped` records any destination path that already
existed and was not itself LDL-managed, so a human can see what the
bootstrap deliberately left alone. `pendingManualIntegration` records every
bridge file (`AGENTS.md` and/or `CLAUDE.md`) currently parked at its template
path instead of its own root destination — see "The AGENTS.md and CLAUDE.md
special case" above — so a fresh session can tell "installed and active"
apart from "installed but still requires a manual merge" without
reconstructing that history from conversation or from noticing the template
file on disk. An empty array means every bridge file this repository owns is
already installed at its own root destination.

## Safety and idempotency

- A fresh install only ever creates the LDL-managed paths listed above; it
  never reads or writes any other path in the consumer repository.
- If a destination path for an LDL-managed item already exists and is not
  listed in an existing `.ldl/manifest.json`, that one item is left
  untouched and recorded under `skipped` instead of being overwritten. This
  is what keeps the bootstrap safe to run against a non-empty, pre-existing
  project repository.
- If any path component leading to a destination is an existing symlink, or
  an existing plain file where a directory needs to be, that item is left
  alone and recorded under `skipped` instead of following the symlink
  outside the destination repository or crashing mid-install.
- If a consumer's own `AGENTS.md` or `CLAUDE.md` (the reason a prior run
  parked that bridge file's derived/copied content at its template path
  instead of installing to the file itself) is later removed, the next run
  installs straight to that file and deletes the now-superseded template
  rather than leaving it behind as an orphaned, unmanifested file, and drops
  the corresponding entry from `pendingManualIntegration`.
- Re-running the bootstrap against an already-initialized repository at the
  same Loop-Dee-Loup source revision reinstalls the same managed paths with
  identical content — a predictable no-op, not a duplicate or a corrupting
  write. `.ldl/manifest.json` is regenerated each run with a fresh
  `installedAt` timestamp but the same `files` set.

## Conflict-safe updates

`tools/ldl-update` (see "How to update" above) extends this same safety
model to moving an already-initialized repository to a newer Loop-Dee-Loup
revision:

- A managed file whose on-disk content still matches the hash recorded in
  `.ldl/manifest.json` (i.e. untouched since install) is safe to overwrite
  with new content and is updated.
- A managed file whose on-disk content already matches the new target
  content needs no write and is left alone; it is still recorded in the
  rewritten manifest.
- A managed file whose on-disk content matches neither the recorded
  provenance nor the new target content — a local edit — is a conflict. So
  is a managed file recorded in the manifest but missing from disk — a local
  deletion, which is still a local modification the recorded provenance
  doesn't explain.
- If any conflict is found, the entire run refuses to write anything —
  neither the conflicting file(s), any other managed file, nor
  `.ldl/manifest.json` — and reports every conflicting path and the reason,
  rather than guessing which version should win, discarding either version,
  or partially applying only the safe subset.
- Consumer-owned material is never evaluated for conflicts and is never
  touched by an update, exactly as for a fresh bootstrap.
- A bridge file's own superseded template (`.ldl/AGENTS.template.md` or
  `.ldl/CLAUDE.template.md`) gets this exact same treatment: untouched since
  install is safe to delete once superseded, a local edit is a conflict that
  refuses the whole run rather than silently discarding it.
- Running the update against an already-current repository (nothing to
  install, nothing in conflict, and no change to the `skipped` or
  `pendingManualIntegration` sets) is a predictable no-op: it does not touch
  `.ldl/manifest.json` or any managed file at all.

## Explicitly out of scope for this mechanism

- A package-registry, dependency-resolution, or semantic-versioning system
  beyond identifying current vs. newer LDL content.
- Automatic conflict resolution — `tools/ldl-update` surfaces a conflict; it
  never guesses which side should win.
- Removing a managed path that a newer Loop-Dee-Loup revision no longer
  distributes — `tools/ldl-update` only ever installs or safely refuses, and
  leaves such a path (and its manifest record) untouched.
- End-to-end dogfooding inside a real named consumer project — a later
  slice. (Public-facing quickstart documentation aimed at strangers has
  shipped as `docs/consumer-quickstart.md`.)
