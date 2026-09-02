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
  `spend/`, `stage1-classifier-hardening/` — the operational skills the
  Loop dispatches;
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

Nothing else in this repository is installed. In particular, `docs/priority-horizons.md`,
`docs/experiment-brief.md`, `tools/check-control-plane-paths.mjs`,
`tools/check-priority-labels.mjs`, this repository's own `README.md`, and
its GitHub issue/PR history are Loop-Dee-Loup's own development state, not
reusable machinery, and are never installed into a consumer repository.

`tools/telemetry/` (the deterministic session-telemetry collector/reducer the installed
`spend` skill can use, see `tools/telemetry/README.md`) and the `statusLine`/`hooks` wiring
in this repository's own `.claude/settings.json` are, unlike the paths above, reusable
machinery in principle — but issue #45 scoped their delivery to this repository only.
`tools/ldl-init` does not currently install either one. A consumer repository's installed
`spend` skill degrades to its `/usage`/`/context` fallback when `tools/telemetry/` is
absent, so this gap does not break an installed consumer repository; it only means that
repository is not yet collecting the deterministic evidence `spend` prefers. This covers
both individual measured fields (the skill's evidence-order step 3) and the
evidence-sufficiency verdict gate itself: when `tools/telemetry/sufficiency.mjs` is absent,
the skill's "Evidence-sufficiency verdicts" section applies a fixed fallback mapping per claim
type instead of skipping the verdict or promoting it to CLEAN (see issue #152). Extending
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

## Defects found in LDL-managed content

A consumer session working a slice can discover, while reading, testing, or
getting a change reviewed, that some *installed* file — one on the
LDL-managed list above — is itself defective: wrong logic, a bad regex, a
gap a reviewer flags. The default disposition below governs that case. It
was established after issue #268: a Codex review of a YouTubery consumer-
sync PR found two real defects in vendored `tools/review-watch/**`;
YouTubery neither patched the vendored file nor blocked its otherwise-valid
sync PR on the finding — it merged the PR unchanged and filed the defect
upstream as Loop-Dee-Loup issue #268 for correction there.

**Distinguish upstream-owned from consumer-owned before deciding disposition.**
A defect is upstream-owned only when both hold:

- the defective path is recorded as LDL-managed in `.ldl/manifest.json`'s
  `files[]` — either because it is on the LDL-managed list above (or is
  bridge content derived from it, e.g. the installed `AGENTS.md`/
  `CLAUDE.md`), or because it was LDL-managed in an earlier revision and
  `tools/ldl-update` carried its provenance forward after a later upstream
  revision dropped it from the current list (see "How to update" below —
  a retired managed path is left on disk and kept recorded, never silently
  deleted). Manifest membership, not current-list membership alone, is the
  authority; and
- the on-disk content matches what `tools/ldl-init`/`tools/ldl-update`
  actually installed — i.e. it has not been hand-edited since install.
  Compare using the same line-ending-tolerant check `tools/ldl-update`'s
  conflict-safe update itself uses (`contentMatchesHash`: an LF/CRLF-only
  difference from the recorded hash still counts as a match), not a raw
  byte-for-byte hash comparison — otherwise a plain Windows/`core.autocrlf`
  checkout of an untouched file reads as locally modified. Only a content
  difference that survives that tolerant comparison means a local edit
  already happened; that edit, and any defect it introduced or left
  uncorrected, is consumer-owned, not upstream-owned.

Anything else — project source, project-specific configuration, an
LDL-managed file already diverged from its recorded provenance under that
tolerant comparison, or a defect in how the installed machinery is *used*
rather than in the machinery itself — is consumer-owned. Normal
target-repository blocking rules apply
to it without exception.

**Default disposition for an upstream-owned defect:**

1. Do not edit the LDL-managed file in the consumer repository to fix it,
   even as a "temporary" or "obviously correct" local patch. A local edit
   makes the file's on-disk hash diverge from the recorded provenance, and
   the next `tools/ldl-update` then refuses the entire run — writing
   nothing — until the divergence is manually reconciled (see "Conflict-safe
   updates" below); it also duplicates a fix that belongs in Loop-Dee-Loup.
2. Preserve the finding durably. If the session has GitHub access to create
   issues in the Loop-Dee-Loup repository this installation was derived
   from, file an upstream issue there with enough evidence to reproduce and
   fix the problem — the exact file, the defective logic, and a concrete
   failing case, the same evidence shape issue #268 recorded. If that access
   is unavailable or the source repository is unclear, record the same
   evidence durably in the consumer repository's own work/review record (the
   PR thread and/or its work issue) instead of only in transient session
   output, so the founder can file it upstream later.
3. Do not hold open, rewrite, or otherwise block the consumer change solely
   because it carries this inherited defect. If the change otherwise
   satisfies its own merge requirements and its LDL-managed content
   accurately reflects current upstream, let it merge unchanged — an
   upstream-owned finding is not one of the "valid findings" a bounded
   review cycle's correction pass fixes locally (see
   `docs/bounded-review-cycle.md`). An independent defect in the consumer's
   own change is still a normal blocker regardless of this rule.
4. Let the eventual upstream fix reach this repository the ordinary way,
   through the next `tools/ldl-update` run — do not build a parallel
   tracking or sync mechanism for it.

This is a default disposition, not license to suppress a finding, weaken any
consumer-local correctness/safety/review/CI gate, or wave through a change
that is independently invalid, unsafe, or incomplete for reasons separate
from merely inheriting the upstream defect.

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
Loop-Dee-Loup's own development (its own priority horizons, its own prototype
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

### Two reconciliation modes for a parked bridge

A bridge parked at its template clears `pendingManualIntegration` through
exactly one of two distinct mechanisms. Which one applies depends on what the
consumer repository's root file actually looks like afterward — this is not
a choice a human makes explicitly beforehand:

1. **Content-equivalent graduation.** If the consumer's root `AGENTS.md` or
   `CLAUDE.md` becomes byte-for-byte equivalent to LDL's current target
   content (under the same checkout-line-ending tolerance described in
   "Conflict-safe updates" below), the next `tools/ldl-init`/`tools/ldl-update`
   run recognizes the match (`planBridgeOp`'s `resolvedByContentMatch`) and
   lets that root file graduate into the normal LDL-managed `files[]` set,
   exactly like any other managed path from then on — including being
   eligible for future conflict detection if it's edited again. This is the
   narrow case where the "merge" was really a full replacement.

2. **Ownership-preserving manual integration.** The ordinary case: a
   consumer merges the parked template's content into their own
   `AGENTS.md`/`CLAUDE.md` by hand, alongside unrelated instructions they
   already had —

   ```text
   consumer-owned instructions
   + LDL bridge/template content
   = one combined consumer-owned AGENTS.md / CLAUDE.md
   ```

   The combined file is intentionally *not* identical to LDL's target
   content, so it never satisfies graduation mode 1, and `tools/ldl-init`/
   `tools/ldl-update` have no safe way to infer from arbitrary file bytes
   alone that the required merge actually happened — `pendingManualIntegration`
   would otherwise stay set indefinitely even after a real, correct merge.
   `tools/ldl-ack` closes that gap with an explicit, durable acknowledgement
   instead: a human or an authorized controlling session attests that the
   *current* bridge target was integrated, without the destination ever
   being added to `files[]` or otherwise becoming LDL-managed. The consumer
   file remains entirely consumer-owned — LDL never overwrites it, never
   conflict-checks it, and never claims ownership over the unrelated
   instructions merged alongside its own content.

   ```bash
   node <path-to-loop-dee-loup-clone>/tools/ldl-ack/index.mjs \
     --dest <path-to-your-project> --bridge AGENTS.md
   ```

   (or `--bridge CLAUDE.md`, independently — acknowledging one bridge never
   affects the other). The equivalent MCP tool is `ldl_acknowledge_integration`
   (see `docs/mcp-server.md`). The acknowledgement is refused, and nothing is
   written, unless the named bridge is currently genuinely parked at its
   template given the Loop-Dee-Loup checkout's present content and the
   consumer repository's present state — see `tools/ldl-ack/index.mjs`'s
   header comment for the complete list of refusal conditions.

   The acknowledgement records the sha256 of the bridge's *current* target
   content in `.ldl/manifest.json`'s `manualIntegrationAcknowledgements`
   array (see "Provenance manifest" below), not a timeless boolean. This is
   what lets a later Loop-Dee-Loup revision that doesn't change that
   specific bridge's content leave the acknowledgement valid, while a
   revision that does change it makes the bridge report pending again on
   the very next `tools/ldl-init`/`tools/ldl-update`/`ldl_status` run,
   automatically — a stale acknowledgement against a superseded target is
   never mistaken for coverage of the new one.

Editing the consumer file after mode 1 graduation is a normal LDL-managed
conflict, exactly like editing any other managed path. Editing it after mode
2 acknowledgement is not: the file was never added to `files[]`, so LDL has
no ownership claim over it to conflict-check in the first place — it simply
remains consumer-owned, as it was before the merge.

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
  ],
  "manualIntegrationAcknowledgements": [
    {
      "dest": "<AGENTS.md or CLAUDE.md>",
      "template": "<its .ldl/*.template.md path>",
      "acknowledgedTargetSha256": "<sha256 of the exact bridge content this acknowledgement covers>",
      "acknowledgedAt": "<ISO-8601 timestamp of the tools/ldl-ack run that recorded it>"
    }
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

A `files[].sha256` recorded by a version of `tools/ldl-init`/`tools/ldl-update` that
predates the checkout-line-ending tolerance described under "Conflict-safe updates" below
needs no migration: the comparison itself, not the stored hash, is what changed, so an
existing consumer moves through the corrected status/update path exactly as before —
no manual line-ending conversion, manifest hash editing, or reinitialization required. This
holds even for a hash that was itself recorded from unnormalized CRLF source bytes by a
pre-fix run (e.g. one run from a Windows Loop-Dee-Loup checkout before this tolerance
existed): the comparison checks a managed file's content under both line-ending
representations against a recorded or target hash either way, so that legacy provenance is
still recognized rather than becoming an unresolvable false conflict.

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
already installed at its own root destination or has been resolved by one of
the two reconciliation modes described above. `manualIntegrationAcknowledgements`
records every `tools/ldl-ack`/`ldl_acknowledge_integration` attestation
currently in force — see "Ownership-preserving manual integration" above —
each entry bound to the exact target content hash it covers, not a timeless
boolean, so a subsequent Loop-Dee-Loup revision that changes that bridge's
content is never mistaken for still being covered by an older acknowledgement.
It is read, but never written, by `tools/ldl-init` and `tools/ldl-update` —
both carry it forward unchanged; only `tools/ldl-ack`/`ldl_acknowledge_integration`
ever modifies it.

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
- Content is compared with checkout line-ending differences treated as
  equivalent, never as a local modification: a text managed file that a
  consumer's own Git checkout renders as CRLF (e.g. a Windows checkout with
  `core.autocrlf=true`) compares equal to the LF content LDL actually
  installs and hashes, so a fresh checkout of an untouched managed file never
  reports a conflict, and a genuine synchronization run against unchanged
  upstream content stays a true no-op. A real content edit — including one
  made under a CRLF checkout — still fails this comparison and is still a
  conflict; only the line-ending representation itself is treated as
  insignificant. Content that isn't confidently text (detected by the
  presence of a NUL byte) is compared byte-for-byte with no normalization.
  Every LDL-installed managed file is always written with canonical LF line
  endings, regardless of the line-ending convention on either side of the
  comparison — see `tools/ldl-init/index.mjs`'s `normalizeLineEndings` and
  `contentMatchesHash`.
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

## Optional integration activation

Installing LDL core (`tools/ldl-init`) never turns on any optional
repository integration — core install and optional activation are two
separate steps. `tools/ldl-init`/`tools/ldl-update` only ever install and
keep current the LDL-managed material listed above; whether a consumer also
wants an optional capability like automated consumer sync is a separate,
explicit choice (issue #282).

`tools/ldl-activate/index.mjs` is the deterministic activation mechanism for
that choice. Like `tools/ldl-init`/`tools/ldl-update`/`tools/ldl-ack`, it is
run from a local Loop-Dee-Loup clone against `--dest <consumer-repo>`, not
distributed into the consumer repository itself:

```bash
node <path-to-loop-dee-loup-clone>/tools/ldl-activate/index.mjs --dest <path-to-your-project> --list
node <path-to-loop-dee-loup-clone>/tools/ldl-activate/index.mjs --dest <path-to-your-project> --capability <id>
```

`--list` enumerates every capability this script knows how to activate
(today, only `consumer-sync` — see below); `--capability <id>` activates
one. It requires an already-`tools/ldl-init`-bootstrapped `--dest`, exactly
like `tools/ldl-update`.

Activation is idempotent and conflict-safe using the same 3-way hash
comparison `tools/ldl-update` already applies to `MANAGED_ITEMS` content
(current on-disk content vs. the recorded activation hash vs. the new
target content) — see "Conflict-safe updates" above for the mechanism;
`tools/ldl-activate` applies it per activated file instead of per
`MANAGED_ITEMS` entry. A pre-existing consumer-owned file already sitting at
a capability's target path is never overwritten: it is parked at
`.ldl/templates/<id>/<file>` for manual review, exactly the same disposition
a pre-existing `AGENTS.md`/`CLAUDE.md` gets (see "The AGENTS.md and CLAUDE.md
special case" above), and recorded in `.ldl/manifest.json`'s
`pendingManualIntegration` array alongside any pending bridge file.

An already-activated capability is **not** kept current automatically by
`tools/ldl-update` — that mechanism only ever touches `MANAGED_ITEMS`
content and the AGENTS.md/CLAUDE.md bridge. Re-run `tools/ldl-activate` with
the same `--capability` to pick up an upstream correction to that
capability's canonical content; it detects local divergence the same way
and refuses an unsafe overwrite the same way. `tools/ldl-init` and
`tools/ldl-update` both surface a reminder of this in their own `warnings`
result whenever a consumer repository has any capability activated, so this
does not depend on a human remembering it.

The one capability proven today is `consumer-sync` (`.ldl/manifest.json`'s
`activatedCapabilities` array records its id, activation time, and the
per-file provenance hashes tools/ldl-activate compares against on every
later run) — it installs the two workflows documented next, "Automated
consumer sync" and "Automated Stage 1 and merge-ready bookkeeping".

## Automated consumer sync

`tools/ldl-sync/` (LDL-managed, distributed via `MANAGED_ITEMS` like
`tools/review-watch/` and `tools/local-worker/`) is a pair of scripts a
consumer repository's own scheduled CI wires together to keep itself current
against this repository without a human running `tools/ldl-update` by hand:

- `tools/ldl-sync/verify-scope.mjs` — a defense-in-depth, after-the-fact
  check that the diff `tools/ldl-update` just produced touches only paths the
  resulting `.ldl/manifest.json` itself claims as managed (plus the manifest
  file itself). Exits non-zero and refuses to proceed if anything else
  changed, so an unattended run never opens a PR carrying an unexpected
  change.
- `tools/ldl-sync/pr-permission.mjs` — detects and classifies the specific
  failure mode where the LDL update and scope verification both succeed but
  the repository cannot open the resulting pull request. See "The
  PR-creation prerequisite" below.

Like every other GitHub Actions workflow, the actual scheduled workflow file
(conventionally `.github/workflows/ldl-sync.yml`) is **consumer-owned CI**,
not an LDL-managed destination — it is never installed or overwritten by
`tools/ldl-init`/`tools/ldl-update`, exactly like this repository's own CI
workflows are never installed into a consumer repository (see "LDL-managed"
above). `tools/ldl-activate/index.mjs --dest <consumer-repo> --capability
consumer-sync` (see "Optional integration activation" above) is now the
supported deterministic way to install this file. Copying the example
workflow below by hand and adjusting it yourself remains equally valid for a
consumer who wants full manual control from the start — activation is not
mandatory, and either path leaves the consumer owning and free to modify
that file from then on.

### The PR-creation prerequisite

A workflow's own

```yaml
permissions:
  contents: write
  pull-requests: write
```

grants that specific workflow *run* permission to create pull requests, but
it does not override a separate, repository-level GitHub setting: **Settings
→ Actions → General → Workflow permissions → "Allow GitHub Actions to create
and approve pull requests."** When that repository setting is disabled (it
is disabled by default on repositories created under an organization with a
conservative default), `gh pr create`/`gh pr edit` fails with:

```text
pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)
```

— even though the workflow's own token has `pull-requests: write`, and even
after the LDL update and `verify-scope.mjs` have both already succeeded and
the sync branch has already been pushed. This is a real, reproduced failure
mode (issue #217, YouTubery scheduled run `33310402496`), not a hypothetical
one: it leaves the consumer looking auto-sync-configured while `main` stays
stale and no reviewable PR ever appears.

GitHub does not reliably expose a read of this repository setting to the
default `GITHUB_TOKEN` — reading it via `GET
/repos/{owner}/{repo}/actions/permissions/workflow` requires
`administration: read`, a permission the default token does not carry unless
a workflow explicitly requests it. `tools/ldl-sync/pr-permission.mjs`
therefore offers two independent checks rather than one guaranteed
preflight:

- `preflight --repo <owner/repo>` — a best-effort read of that same API. If
  the calling token happens to have read access and the setting is
  disabled, this fails fast (exit `3`) *before* the workflow ever pushes the
  shared sync branch. If the token lacks access (the common case) or the
  read fails for any other reason, it reports `status: "unknown"` and exits
  `0` — deliberately not treated as either "allowed" or "denied", since
  guessing wrong in either direction would be worse than admitting the
  preflight can't answer.
- `classify` — reads a failed `gh pr create`/`gh pr edit` invocation's
  captured stderr from stdin and reliably recognizes the exact GraphQL error
  text above, independent of token scope. This is the fallback that always
  works, because it inspects the actual denial GitHub already returned
  rather than trying to predict it.

Together these give an `ldl-sync.yml` workflow a fourth, distinct failure
state instead of collapsing everything into one generic "sync failed":

| State | How it's detected | Meaning |
| --- | --- | --- |
| Fully operational | `tools/ldl-update` reports `noop` or opens/updates the PR without error | Nothing to do, or synchronized normally |
| Managed-file conflict | `tools/ldl-update` exits non-zero | A managed file was edited locally since install — needs manual reconciliation, per "Conflict-safe updates" above |
| PR creation not permitted | `pr-permission.mjs preflight` exits `3`, or `pr-permission.mjs classify` reports `pr_creation_denied` (exit `4`) | The repository-level setting above is disabled — this section's remediation applies |
| Unexpected operational failure | Any other non-zero exit | Something else went wrong and needs investigation |

A sync branch that was pushed but has no open pull request is **not**
synchronization having succeeded — never treat `git push` reaching
`ldl-sync/auto-update` as equivalent to a consumer being up to date. The
workflow's job must still report failure, with the exact remediation text
above in its step summary, whenever the PR-creation-not-permitted state is
reached.

`tools/ldl-init` and `tools/ldl-update` each report a `warnings` array in
their JSON result whenever a run installs or changes anything under
`tools/ldl-sync/`, reminding the operator that this prerequisite has not
been verified by the tool itself. `tools/mcp-server`'s `ldl_status` (see
`docs/mcp-server.md`) reports the same warning on every call for as long as
a repository has `tools/ldl-sync/**` in its managed set, independent of
`status` — a repository is never reported as fully auto-sync-capable by
these tools alone; confirming the repository setting itself is a manual
step outside what a local, GitHub-API-free file-copy tool can check.

### Sync failures must be loud, not merely non-fatal

`tools/ldl-update`, `tools/ldl-sync/verify-scope.mjs`, and
`tools/ldl-sync/pr-permission.mjs` each already fail with a non-zero exit
and a specific message when their own required work doesn't complete (see
their own test suites) — a locally modified managed file makes the whole
update refuse to write anything, and a diff that strays outside the
declared managed set refuses to let the workflow proceed. That guarantee
only reaches a real consumer repository if the CI orchestration wrapping
these scripts propagates their exit codes faithfully, rather than masking
a failure behind a broader `set +e` block whose later commands happen to
look like a legitimate no-op (issue #232).

The example workflow below applies that rule at every step: `set +e` is
only ever used narrowly around a single command whose stderr the step
needs to inspect itself (a push, a `gh pr create`/`gh pr edit` attempt, a
preflight check), immediately followed by `set -e` again — never left
covering the ordinary git plumbing (`checkout`, `add`, `commit`) a real
failure could hide behind. Every step that can fail also writes what
failed to `$GITHUB_STEP_SUMMARY`, the durable, easily-surfaced record a
fresh session can read without reconstructing the run from conversation
history or raw job logs. A genuine no-op (nothing changed) is still
reported distinctly from a failure — see the state table above — by
checking `git diff --cached --quiet` explicitly rather than treating any
early exit from that line as proof nothing needed to happen.

### Example workflow

````yaml
name: LDL Sync

on:
  schedule:
    - cron: "22 6 * * *"
  workflow_dispatch:

concurrency:
  group: ldl-sync
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write

env:
  SYNC_BRANCH: ldl-sync/auto-update

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout this repository
        uses: actions/checkout@v4
        with:
          ref: main
          path: self
          persist-credentials: false

      - name: Checkout Loop-Dee-Loup source
        uses: actions/checkout@v4
        with:
          repository: LouPineWays/Loop-Dee-Loup
          ref: main
          path: ldl-src
          persist-credentials: false

      - name: Preflight PR-creation permission
        id: preflight
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set +e
          node self/tools/ldl-sync/pr-permission.mjs preflight --repo "$GITHUB_REPOSITORY" > preflight-result.json
          CODE=$?
          cat preflight-result.json
          if [ "$CODE" -eq 3 ]; then
            {
              echo "### LDL Sync: PR creation blocked by repository policy"
              echo
              echo 'Fix: Settings -> Actions -> General -> Workflow permissions -> "Allow GitHub Actions to create and approve pull requests"'
            } >> "$GITHUB_STEP_SUMMARY"
            exit 1
          elif [ "$CODE" -ne 0 ]; then
            # Any other nonzero exit (a crash, a missing dependency, an unhandled error) is not
            # a known "denied" verdict — it must still fail the run rather than fall through
            # unnoticed (issue #232: a preflight check that only reacts to exit 3 silently
            # treats every other failure as if the check had passed).
            {
              echo "### LDL Sync: preflight check failed unexpectedly (exit $CODE)"
              echo
              echo '```'
              cat preflight-result.json
              echo '```'
            } >> "$GITHUB_STEP_SUMMARY"
            exit 1
          fi

      - name: Record prior revision
        id: prior
        working-directory: self
        run: |
          REV=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.ldl/manifest.json','utf8')).ldlSourceRevision)")
          echo "revision=$REV" >> "$GITHUB_OUTPUT"

      - name: Run conflict-safe LDL update
        run: |
          set +e
          node ldl-src/tools/ldl-update/index.mjs --dest "$GITHUB_WORKSPACE/self" >update-result.json 2>update-error.log
          CODE=$?
          set -e
          if [ "$CODE" -ne 0 ]; then
            echo "::error::LDL update refused — a managed file has diverged since install, or the run failed."
            cat update-error.log
            {
              echo "### LDL Sync: update refused"
              echo
              echo '```'
              cat update-error.log
              echo '```'
            } >> "$GITHUB_STEP_SUMMARY"
            exit 1
          fi
          cat update-result.json

      - name: Determine outcome
        id: outcome
        run: |
          NOOP=$(node -e "console.log(JSON.parse(require('fs').readFileSync('update-result.json','utf8')).noop === true)")
          echo "noop=$NOOP" >> "$GITHUB_OUTPUT"

      - name: Verify diff stays within the LDL-managed set
        if: steps.outcome.outputs.noop == 'false'
        working-directory: self
        run: |
          set +e
          node tools/ldl-sync/verify-scope.mjs > verify-scope-result.json 2>verify-scope-error.log
          CODE=$?
          set -e
          if [ "$CODE" -ne 0 ]; then
            cat verify-scope-error.log
            {
              echo "### LDL Sync: scope verification failed"
              echo
              echo "The LDL update touched a path outside its own declared managed set — refusing to open a PR."
              echo
              echo '```'
              cat verify-scope-error.log
              echo '```'
            } >> "$GITHUB_STEP_SUMMARY"
            exit 1
          fi
          cat verify-scope-result.json

      - name: Record target revision
        id: target
        if: steps.outcome.outputs.noop == 'false'
        working-directory: self
        run: |
          REV=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.ldl/manifest.json','utf8')).ldlSourceRevision)")
          echo "revision=$REV" >> "$GITHUB_OUTPUT"

      - name: Open or update sync PR
        id: open_pr
        if: steps.outcome.outputs.noop == 'false'
        working-directory: self
        env:
          GH_TOKEN: ${{ github.token }}
          PRIOR_REV: ${{ steps.prior.outputs.revision }}
          TARGET_REV: ${{ steps.target.outputs.revision }}
        run: |
          # Deliberately no blanket `set +e` here (issue #232): the default GitHub Actions bash
          # shell already runs with `-e -o pipefail`, so `git config`/`remote set-url`/`fetch`
          # (explicitly tolerated below)/`checkout -B`/`add` each abort the step loudly on their
          # own failure. A blanket `set +e` covering this plumbing previously let a failed
          # `checkout -B` (or any earlier command) fall through into `git diff --cached --quiet`
          # reporting "nothing staged" and the step exiting 0 as if there were genuinely nothing
          # to sync — the exact silent-drift shape this issue exists to close, independent of
          # the specific PR-creation-permission failure issue #217 already covers. `set +e` is
          # re-enabled only narrowly below, around the two commands whose stderr this step
          # inspects itself (push, gh pr create/edit).
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

          # Fetch any existing remote sync branch first: --force-with-lease's implicit (no
          # =<expect>) form checks the push against this checkout's own remote-tracking ref for
          # SYNC_BRANCH, and this job only ever fetched "main" above — without this, a push to an
          # already-existing sync branch is rejected as stale info before ever reaching gh pr edit.
          git fetch -q origin "refs/heads/${SYNC_BRANCH}:refs/remotes/origin/${SYNC_BRANCH}" 2>/dev/null || true

          git checkout -B "$SYNC_BRANCH"
          git add -A

          if git diff --cached --quiet; then
            echo "Nothing to commit — sync branch already matches the LDL update content-for-content."
            exit 0
          fi

          git commit -q -m "chore: sync LDL-managed files to ${TARGET_REV}"

          set +e
          git push --force-with-lease origin "HEAD:refs/heads/${SYNC_BRANCH}" 2>push-error.log
          CODE=$?
          set -e
          if [ "$CODE" -ne 0 ]; then
            cat push-error.log
            {
              echo "### LDL Sync: failed to push the sync branch"
              echo
              echo '```'
              cat push-error.log
              echo '```'
            } >> "$GITHUB_STEP_SUMMARY"
            exit 1
          fi

          BODY_FILE="$(mktemp)"
          {
            echo "Automated Loop-Dee-Loup consumer synchronization — see docs/consumer-contract.md, \"Automated consumer sync\"."
            echo
            echo "- Prior LDL revision: \`${PRIOR_REV}\`"
            echo "- Target LDL revision: \`${TARGET_REV}\`"
          } > "$BODY_FILE"

          EXISTING_PR="$(gh pr list --head "$SYNC_BRANCH" --base main --state open --json number --jq '.[0].number // empty')"

          set +e
          if [ -n "$EXISTING_PR" ]; then
            gh pr edit "$EXISTING_PR" --title "chore: automated Loop-Dee-Loup sync to ${TARGET_REV}" --body-file "$BODY_FILE" 2>pr-error.log
          else
            gh pr create --head "$SYNC_BRANCH" --base main --title "chore: automated Loop-Dee-Loup sync to ${TARGET_REV}" --body-file "$BODY_FILE" 2>pr-error.log
          fi
          CODE=$?
          set -e
          if [ "$CODE" -ne 0 ]; then
            # classify itself exits non-zero by design (4 for a recognized denial, 1 otherwise —
            # see tools/ldl-sync/pr-permission.mjs) as its own caller-facing signal, not a shell
            # error, so it must run with `set +e` too or its own exit here would abort the script
            # before the summary below is ever written (the exact quiet-failure shape issue #232
            # exists to close, caught by tools/ldl-sync/workflow-example.test.mjs).
            set +e
            node tools/ldl-sync/pr-permission.mjs classify < pr-error.log > classify-result.json
            set -e
            node -e "console.log(JSON.parse(require('fs').readFileSync('classify-result.json','utf8')).summary)" >> "$GITHUB_STEP_SUMMARY"
            exit 1
          fi
````

This is a starting point, not a distributed artifact — copy it into your own
`.github/workflows/ldl-sync.yml`, and adapt scheduling, branch names, and
error handling to your project's own CI conventions from then on. LDL never
overwrites it once it exists.

## Automated Stage 1 and merge-ready bookkeeping

Getting a sync PR opened is only half of "no reasoning session needed" —
issue #274 closes the other half: taking that PR from open to an obvious
"ready for manual merge" state without the founder discovering a PR head
SHA, authoring the hidden `ldl-trigger-head` marker, remembering
`--issue none`, or running `tools/review-watch/merge-ready-gate.mjs` by
hand.

### The empirical finding: a bot-authored trigger cannot get a real review

Before building this, issue #274 asked a concrete question: can a
`GITHUB_TOKEN`-authenticated (`github-actions[bot]`-authored) `@codex
review` comment draw a genuine Codex response, the same way a human-typed
one does? This was tested for real rather than assumed — on this
repository's own LDL PR #275, a Stage 1 trigger comment posted as
`github-actions[bot]` drew:

```text
To use Codex here, [create a Codex account and connect to github](https://chatgpt.com/codex/cloud/settings/connectors).
```

Codex's connector does receive the webhook for a bot-authored comment — it
is not silently dropped — but it replies with a fixed Codex Cloud
connector-setup prompt instead of a review, because the commenting identity
(a repository's default Actions bot) has no Codex account connected to it.
This is a structural limitation of a bot identity, not a flaky or
improvable one: no repository setting or workflow change makes a bot
account "connect a Codex account." Automating the trigger post itself would
therefore only add a dead-end exchange to every consumer-sync PR, never a
real review — so `tools/review-watch/consumer-sync-gate.mjs` (below)
deliberately never posts `@codex review` on the founder's behalf.

(That reply also exposed a real gap in
`tools/review-watch/genuine-response.mjs`'s `isCodexCloudSetupPrompt`,
which only recognized the sibling "create an environment for this repo"
phrasing — fixed alongside this mechanism so a connector-setup reply is
never misclassified as a genuine response.)

### The supported path: one fixed founder action, everything else automated

Given that finding, the founder's one remaining action for a routine sync
PR is exactly what they already do for any other PR: comment `@codex
review`. Nothing about that action is volatile — no SHA, no marker, no
issue number, no command syntax. Everything downstream of that comment is
automated by `tools/review-watch/consumer-sync-gate.mjs`, composing
`trigger.mjs` and `merge-ready-gate.mjs` (unchanged) plus one new
primitive:

1. it derives the PR's current head automatically (`gh pr view`) when not
   given one directly by the calling workflow;
2. if the founder's `@codex review` comment has no head marker yet (the
   normal case — a human typing it by hand, per above, never adds one) and
   no marked trigger for the current head already exists, it repairs that
   comment in place by appending the current head's `ldl-trigger-head`
   marker — mechanically automating the exact hand-edit
   docs/bounded-review-cycle.md Stage 1 step 3 currently documents as a
   manual recovery, and the exact step YouTubery PR #98 needed a founder
   to do by hand. It refuses to repair a bare comment posted *before* the
   current head's own commit (a Stage 1 review finding on this mechanism's
   own PR, #275): a trigger from an earlier head must never be relabeled
   onto a later one the PR has since advanced to, or a stale, unbound
   response could wrongly satisfy a head it never actually reviewed;
3. it runs `merge-ready-gate.mjs --issue none` (issue #190's explicit
   no-work-issue sentinel — every recurring sync PR has no dedicated
   implementation issue to check a closing reference against), and
   additionally requires the genuine response to be recognizably *clean* —
   `merge-ready-gate.mjs` only proves a genuine response arrived, never
   that it is finding-free (another Stage 1 review finding on this PR,
   reproduced live by that very review's own 7 findings). It recognizes
   Codex's fixed clean-pass phrasing ("`Codex Review: Didn't find any
   major issues.`", observed unchanged on this repository's own merged
   PRs) and reports `blocked` for anything else genuine, including a real
   finding-bearing review;
4. it reports one of `ready` / `not_requested` / `pending` / `blocked` /
   `error`.

`--set-status true` turns that result into a GitHub commit status on the
PR's head, under the context `ldl-sync/merge-ready` — a conspicuous
success/pending/failure state on the PR itself, with no terminal required
to see it:

| `consumer-sync-gate.mjs` status | Commit status state | Meaning |
| --- | --- | --- |
| `ready` | success | Clean genuine Codex review + composed gate pass. Founder just clicks Merge. |
| `not_requested` | pending | No trigger yet. Founder's one action: comment `@codex review` on the PR. |
| `pending` | pending | Trigger exists; waiting on a genuine Codex response. Nothing to do yet. |
| `blocked` | failure | A closing-reference violation, a genuine response not recognized as clean (may carry findings), or other non-pending block. See PR comments / Actions log. |
| `error` | error | An operational failure (a `gh` call failed, malformed gate output). See Actions log. |

`blocked`/`error` never produce the `ready` state, `not_requested` and
`pending` never do either — only a real `merge-ready-gate.mjs` exit 0 does,
the same fail-closed authority docs/bounded-review-cycle.md already
requires for every other merge-ready decision. A genuine review finding
still needs a founder or coding-agent session to evaluate, per issue #269's
upstream-vs-consumer disposition rule; this mechanism only removes the
bookkeeping around a clean pass, never the judgment a real finding needs.

### Example workflow

`tools/ldl-activate/index.mjs --dest <consumer-repo> --capability
consumer-sync` (see "Optional integration activation" above) installs this
workflow alongside `ldl-sync.yml` in one deterministic step. Copying it by
hand as `.github/workflows/ldl-sync-review.yml` and adjusting it yourself
remains equally valid — activation is not mandatory. Either way it watches
the same fixed sync branch, so it only ever acts on LDL's own recurring sync
PR, never an arbitrary one:

````yaml
name: LDL Sync Review

on:
  pull_request:
    types: [opened, synchronize]
    branches: [main]
  pull_request_review:
    types: [submitted]
  pull_request_review_comment:
    types: [created]
  issue_comment:
    types: [created]
  schedule:
    - cron: "*/20 * * * *"
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write
  issues: write
  statuses: write

env:
  SYNC_BRANCH: ldl-sync/auto-update

jobs:
  gate:
    runs-on: ubuntu-latest
    if: github.event_name != 'issue_comment' || github.event.issue.pull_request != null
    steps:
      - uses: actions/checkout@v4

      - name: Determine the sync PR number and branch
        id: find_pr
        env:
          GH_TOKEN: ${{ github.token }}
          EVENT_NAME: ${{ github.event_name }}
          # A fork PR's branch name is attacker-controlled and can contain shell
          # metacharacters (e.g. "$(...)") -- passed through env, never interpolated
          # directly into the script body below, so it is only ever used as inert data.
          PR_HEAD_REF: ${{ github.event.pull_request.head.ref }}
          PR_NUMBER_FROM_EVENT: ${{ github.event.pull_request.number || github.event.issue.number }}
        run: |
          case "$EVENT_NAME" in
            pull_request|pull_request_review|pull_request_review_comment)
              PR="$PR_NUMBER_FROM_EVENT"
              REF="$PR_HEAD_REF"
              ;;
            issue_comment)
              PR="$PR_NUMBER_FROM_EVENT"
              REF="$(gh pr view "$PR" --repo "$GITHUB_REPOSITORY" --json headRefName -q .headRefName)"
              ;;
            *)
              PR="$(gh pr list --repo "$GITHUB_REPOSITORY" --head "$SYNC_BRANCH" --state open --json number --jq '.[0].number // empty')"
              REF="$SYNC_BRANCH"
              ;;
          esac
          if [ -z "$PR" ] || [ "$REF" != "$SYNC_BRANCH" ]; then
            echo "pr=" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          echo "pr=$PR" >> "$GITHUB_OUTPUT"

      - name: Run consumer-sync-gate.mjs
        if: steps.find_pr.outputs.pr != ''
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          # `bash -e -o pipefail` (GitHub Actions' default shell) would otherwise abort this
          # step the instant consumer-sync-gate.mjs exits 2 for its own normal not_requested/
          # pending states, before the summary below ever runs -- narrowly disabled around
          # just this invocation, matching every other step in this file that inspects a
          # command's own documented non-zero exit rather than treating it as a shell failure.
          set +e
          node tools/review-watch/consumer-sync-gate.mjs \
            --repo "$GITHUB_REPOSITORY" --pr "${{ steps.find_pr.outputs.pr }}" --set-status true \
            > gate-result.json
          set -e
          cat gate-result.json
          STATUS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('gate-result.json','utf8')).status)")
          {
            echo "### LDL Sync Review: $STATUS"
            echo
            cat gate-result.json
          } >> "$GITHUB_STEP_SUMMARY"
          # not_requested/pending are normal waiting states, already visible via the
          # ldl-sync/merge-ready commit status above -- only blocked/error fail this Actions
          # run itself, so the Actions tab stays quiet while nothing actually needs attention.
          if [ "$STATUS" = "blocked" ] || [ "$STATUS" = "error" ]; then
            exit 1
          fi
````

This is a starting point, not a distributed artifact — copy it into your
own `.github/workflows/ldl-sync-review.yml` and adapt the schedule and
branch filtering to your project's own CI conventions from then on, the
same as `ldl-sync.yml` above. LDL never overwrites it once it exists.

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
