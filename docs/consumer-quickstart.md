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

This installs LDL's skills, personas, scripts, issue templates, and
operating-model docs into your repository, and writes `.ldl/manifest.json`
recording exactly what it installed. It is safe to run against an
already-in-progress project, and safe to run again.

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

If `tools/ldl-init` installed straight to `AGENTS.md` (you had none before),
that file is already your operating contract and you can dispatch a session
now.

If you already had your own `AGENTS.md`, the derived contract was parked at
`.ldl/AGENTS.template.md` instead of overwriting it. Review and merge that
template into your own `AGENTS.md` by hand **before** dispatching any
session — nothing rewrote your existing file for you, so a session started
against the unmerged original runs under your prior instructions without
LDL's execution rules. See `docs/consumer-contract.md` for why this file is
handled differently from LDL's other managed paths.

Once your `AGENTS.md` reflects LDL's operating contract, start a fresh Claude
Code session inside your project and dispatch one issue with a terse
reference, for example:

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

Steps 2 and 5 above can also be done through a local LDL MCP server your coding-agent session
connects to, instead of running `tools/ldl-init`/`tools/ldl-update` by hand — useful if you
maintain several LDL consumer repositories and want a cheap `ldl_status` check across all of
them without loading each one's manifest into context. See `docs/mcp-server.md` for setup and
the exact tools it exposes (`ldl_status`, `ldl_init`, `ldl_update`). It calls the same
underlying mechanism as the CLI commands above — nothing about the ownership or conflict-safety
rules in this page or `docs/consumer-contract.md` changes.

## 7. What remains authoritative in your repository

After installation, your project repository — not Loop-Dee-Loup — is the
source of truth for your own project state: your code, your issues and PRs,
your own `AGENTS.md`/`CLAUDE.md`, your CI and checks, and any decisions your
team has made. LDL-managed files are reusable machinery your repository now
owns a copy of; `.ldl/manifest.json` is the durable record of which paths
those are, so a fresh agent session can tell installed-and-managed apart from
project-owned without reconstructing any history from this repository.
