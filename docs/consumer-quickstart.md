# Consumer quickstart

This is the installation quickstart for adopting Loop-Dee-Loup (LDL) in a
project that is not this repository. It answers the six questions a stranger
needs before they can try LDL: how to get it, how to install it, what it
touches, where to start working afterward, how to update it, and what stays
under your own project's control.

This page is intentionally short. For the full ownership boundary, the exact
list of installed paths, and the update/conflict-resolution contract, see
`docs/consumer-contract.md` — this page links to it rather than repeating it.
For how the Loop itself operates once installed (vertical slices,
decomposition, decision forms, the bounded review cycle), see
`docs/operating-model.md`, `docs/decision-forms.md`, and
`docs/bounded-review-cycle.md`.

**Loop-Dee-Loup is the source/distribution repository for this machinery.
Your project repository is, and remains, the authoritative environment for
your own code, issues, and decisions.** Installing LDL does not make this
repository a dependency of yours at runtime — it copies files into your repo
once (or on update), and your repo owns them from then on.

## 1. Obtain Loop-Dee-Loup

Clone this repository locally. There is no package registry or hosted
service — a local clone is the only supported source:

```bash
git clone https://github.com/LouPineWays/Loop-Dee-Loup.git
```

## 2. Initialize your project

From that clone, run the bootstrap tool against your existing project
repository (it does not need to be empty, and does not need to be a fresh
repository):

```bash
node <path-to-loop-dee-loup-clone>/tools/ldl-init/index.mjs --dest <path-to-your-project>
```

This installs LDL's skills, personas, scripts, issue templates,
operating-model docs, and the `AGENTS.md`/`CLAUDE.md` bridge that makes the
operating contract active in a fresh Claude Code session (see step 4) into
your repository, and writes `.ldl/manifest.json` recording exactly what it
installed. It is safe to run against an already-in-progress project, and
safe to run again.

## 3. What gets installed vs. what stays yours

`tools/ldl-init` only ever writes the specific LDL-managed paths listed in
`docs/consumer-contract.md` (skills, personas, scripts, issue templates, and
operating-model documentation) — and it never overwrites a path that already
exists and wasn't itself installed by a prior LDL run. Everything else in
your repository — your source code, your issues and PRs, your own
`AGENTS.md`/`CLAUDE.md` if you already have one, your CI, and your own
build/test/verification commands — is untouched and remains yours. See
`docs/consumer-contract.md` for the full list and the exact safety rules.

## 4. Where to start your coding-agent session

Once installed, work from your own project repository, not from this one.

`tools/ldl-init` installs two files whose destination depends on whether you
already owned a same-named file: `AGENTS.md` (the operating contract) and
`CLAUDE.md` (a few lines that `@AGENTS.md`-import it, so a fresh Claude Code
session loads the contract automatically at session start — Claude Code
reads `CLAUDE.md` for project instructions, not `AGENTS.md`, so this bridge
is what actually activates LDL rather than merely installing it). Each
resolves independently:

- If you had neither file, both installed straight to their own root paths
  and you can dispatch a session now — it will already have the operating
  contract active without you telling it to read anything.
- If you already had your own `AGENTS.md` and/or `CLAUDE.md`, the derived
  content for that file was parked at `.ldl/AGENTS.template.md` and/or
  `.ldl/CLAUDE.template.md` instead of overwriting it. Review and merge the
  relevant template(s) into your own file(s) by hand **before** dispatching
  any session — nothing rewrote your existing file for you, so a session
  started against the unmerged original runs under your prior instructions,
  without LDL's execution rules loaded automatically. `.ldl/manifest.json`'s
  `pendingManualIntegration` array lists exactly which file(s) still need
  this. See `docs/consumer-contract.md`, "The AGENTS.md and CLAUDE.md
  special case", for why these two files are handled differently from LDL's
  other managed paths.

  If your merged file keeps your own unrelated instructions alongside the
  template's content (the normal case), run `tools/ldl-ack` afterward to
  record that the merge happened — otherwise `pendingManualIntegration` stays
  set even though you did the merge, since LDL cannot safely infer that from
  arbitrary file bytes alone:

  ```bash
  node <path-to-loop-dee-loup-clone>/tools/ldl-ack/index.mjs \
    --dest <path-to-your-project> --bridge AGENTS.md
  ```

  (or `--bridge CLAUDE.md`, independently, if that one also needed merging).
  See `docs/consumer-contract.md`, "Two reconciliation modes for a parked
  bridge", for the one case where this step isn't needed — your merged file
  ended up byte-for-byte identical to the template, so LDL recognized the
  match automatically.

Once `pendingManualIntegration` is empty (or was empty from the start), start
a fresh Claude Code session inside your project and dispatch one issue with a
terse reference, for example:

> Run Loop-Dee-Loup issue #12.

The issue and your repository's own durable state — not this conversation or
this repository — are what the session reads to know what to do.

## 5. How to update

To move an already-initialized project to a newer Loop-Dee-Loup revision,
check out that revision in your Loop-Dee-Loup clone and run:

```bash
node <path-to-loop-dee-loup-clone>/tools/ldl-update/index.mjs --dest <path-to-your-project>
```

This updates only unmodified LDL-managed files, is a no-op when your project
is already current, and refuses to write anything if it finds a managed file
you've locally modified — it surfaces the conflict rather than guessing which
version should win. See `docs/consumer-contract.md` for the full conflict-safe
update contract.

## 6. Optional: check status and update through an MCP server instead of the CLI

Steps 2, 4, and 5 above can also be done through a local LDL MCP server your coding-agent
session connects to, instead of running `tools/ldl-init`/`tools/ldl-update`/`tools/ldl-ack` by
hand — useful if you maintain several LDL consumer repositories and want a cheap `ldl_status`
check across all of them without loading each one's manifest into context. See
`docs/mcp-server.md` for setup and the exact tools it exposes (`ldl_status`, `ldl_init`,
`ldl_update`, `ldl_acknowledge_integration`). It calls the same underlying mechanism as the CLI
commands above — nothing about the ownership or conflict-safety rules in this page or
`docs/consumer-contract.md` changes.

## 7. What remains authoritative in your repository

After installation, your project repository — not Loop-Dee-Loup — is the
source of truth for your own project state: your code, your issues and PRs,
your own `AGENTS.md`/`CLAUDE.md`, your CI and checks, and any decisions your
team has made. LDL-managed files are reusable machinery your repository now
owns a copy of; `.ldl/manifest.json` is the durable record of which paths
those are, so a fresh agent session can tell installed-and-managed apart from
project-owned without reconstructing any history from this repository.
