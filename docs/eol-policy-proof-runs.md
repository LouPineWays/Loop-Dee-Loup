# EOL policy proof runs (issue #470, unit 470-A)

Narrative verification record for the `.gitattributes` deterministic line-ending policy.
Mirrors the `docs/execution-boundary-experiment.md` / `docs/execution-planning-proof-runs.md`
proof-run convention: this file records what was run and what resulted; the raw
command output lives alongside it under `docs/eol-policy-proof-runs/`.

## Environment

- Node: v20.19.4
- Platform: win32 (Windows 11)
- Implementation commit: `498a2bb61967dac30924e001491c0a8f2e5c57a8` (branch `fix/470-eol-policy`)
- Local repository's own `core.autocrlf`: `true` (the exact developer-machine condition
  that originally reproduced issue #470's demonstrated defect — see `docs/
  stage1-correction-satisfaction-proof-runs/454-scenario-08-regression.json`).

## Pre-existing state confirmed before implementing

Every currently tracked file in this repository is text (192 files: `.mjs`, `.json`,
`.md`, `.txt`, `.jsonl`, `.yml`, `.log`, `.gitignore`, `.gitkeep`, `LICENSE` — no
extension-less binaries, no images, fonts, or archives). A full scan of every tracked
file's **committed blob** (`git cat-file -p HEAD:<path>`, not the working-tree copy) found
zero files containing a CR byte. This means a repository-wide LF checkout policy has
nothing to normalize: it changes checkout behavior only, not any committed content.

## Verification item 1 — LF-control checkout

Created an isolated, detached worktree with LF-preserving Git behavior:

```
git -c core.autocrlf=false worktree add --detach C:/Temp/ldl-470-verify/lf-checkout fix/470-eol-policy
```

Ran the Stage 2 contract fixture/test file in that worktree:

```
node --test tools/review-watch/stage2-report.test.mjs
```

Result: **139/139 pass, 0 fail.** Full output:
`docs/eol-policy-proof-runs/01-lf-checkout-stage2-report.log`.

## Verification item 2 — `core.autocrlf=true` checkout

Created an equivalent isolated, detached worktree with the exact Windows-default setting
that produced the original defect:

```
git -c core.autocrlf=true worktree add --detach C:/Temp/ldl-470-verify/crlf-checkout fix/470-eol-policy
```

Ran the identical command in that worktree:

```
node --test tools/review-watch/stage2-report.test.mjs
```

Result: **139/139 pass, 0 fail** — identical to the LF-control checkout. Before this
fix, this exact worktree/environment shape reproduced a module-load failure that
collapsed all 139 tests in this file into a single false failure (per issue #470's
"Demonstrated impact" and the `454-scenario-08-regression.json` root-cause record). Full
output: `docs/eol-policy-proof-runs/02-crlf-checkout-stage2-report.log`.

A direct byte-level check of the checked-out file confirms why: both worktrees produce
byte-identical LF-only content for the file the failing regex depends on, despite one
worktree being configured with `core.autocrlf=true`.

```
docs/stage2-audit-contract.md — CRLF pairs: 0, bare LF: 216   (lf-checkout worktree)
docs/stage2-audit-contract.md — CRLF pairs: 0, bare LF: 216   (crlf-checkout worktree)
```

Full output: `docs/eol-policy-proof-runs/05-byte-level-eol-check.json`. The 216 LF count
matches the same figure independently recorded in `454-scenario-08-regression.json`'s
`git cat-file` blob check.

`git check-attr` confirms the effective policy directly rather than only the checked-out
bytes, run with `-c core.autocrlf=true` to simulate the exact prior-failing developer
setting:

```
docs/stage2-audit-contract.md: text: auto
docs/stage2-audit-contract.md: eol: lf
tools/review-watch/stage2-report.test.mjs: text: auto
tools/review-watch/stage2-report.test.mjs: eol: lf
AGENTS.md: text: auto
AGENTS.md: eol: lf
.gitattributes: text: auto
.gitattributes: eol: lf
```

Full output: `docs/eol-policy-proof-runs/06-git-check-attr.log`.

## Verification item 3 — behavioral equivalence

Ran the broader in-scope suite in both isolated worktrees with explicit file
enumeration (avoids the separate, unrelated PowerShell-glob-expansion gap noted in
`454-scenario-08-regression.json`):

```
node --test tools/review-watch/*.test.mjs tools/orchestration/*.test.mjs
```

| Worktree | tests | pass | fail |
|---|---|---|---|
| LF-preserving (`core.autocrlf=false`) | 857 | 857 | 0 |
| `core.autocrlf=true` | 857 | 857 | 0 |

Identical substantive result in both environments. Full output:
`docs/eol-policy-proof-runs/03-lf-checkout-full-suite.log` and
`docs/eol-policy-proof-runs/04-crlf-checkout-full-suite.log`. (857 matches the current
main-tip baseline recorded in `454-scenario-08-regression.json`'s `afterCorrection`
entry; per issue #470 this count is not frozen as a permanent acceptance value, only
required to match between the two checkouts of the same commit, which it does.)

## Verification item 4 — diff hygiene

`git diff main...fix/470-eol-policy --stat` at the point `.gitattributes` was added:

```
 .gitattributes | 33 +++++++++++++++++++++++++++++++++
 1 file changed, 33 insertions(+)
```

Full output: `docs/eol-policy-proof-runs/08-diff-hygiene-stat.log`. A diff scoped to
every file *other than* `.gitattributes`, this proof-run doc/directory, and the new
regression test is empty — confirming no unrelated line-ending-only churn or binary-file
normalization anywhere else in the tree. Full output:
`docs/eol-policy-proof-runs/08b-diff-hygiene-unrelated-files.log` (0 lines).

No binary files are tracked in this repository today (see "Pre-existing state" above),
so the explicit `-text` binary safety-net rules in `.gitattributes` currently apply to
zero tracked files — they exist only to protect files that may be added later.

## Verification item 5 — policy regression

Added `tools/check-eol-policy.test.mjs`, a `node --test` fixture that asserts (a)
`.gitattributes` exists and declares `* text=auto eol=lf`, (b) `git check-attr` (run with
`-c core.autocrlf=true`, the exact failing setting) resolves representative tracked files
— including the two files central to the demonstrated defect — to `text: auto` /
`eol: lf`, and (c) the committed blobs for those same files stay LF-only.

Proved this is a genuine regression guard, not just a plausible-looking assertion: with
`.gitattributes` temporarily removed, the same test run fails (2 of 7 subtests fail —
the existence check and that file's own `check-attr` resolution). Restoring
`.gitattributes` returns it to 7/7 pass. Full output:
`docs/eol-policy-proof-runs/07-regression-proof-gitattributes-removed.log`.

## Verification item 6 — regression suite

In addition to items 1-3 above (857/857/0 in both environments), also ran the repository's
other deterministic control checks on the implementation branch:

- `node tools/check-startup-budget.mjs` → `OK: AGENTS.md and CLAUDE.md are within their startup-context line budgets.`
- `node tools/check-control-plane-paths.mjs` → `OK: the control-plane path list in docs/bounded-review-cycle.md matches the repository.`
- `node --test tools/check-eol-policy.test.mjs` → 7/7 pass (see item 5).

Normal Stage 1 (`@codex review` on the implementation PR) and a fresh exact-merge Stage 2
audit are the remaining steps of the "Regression suite" verification item and are carried
out by unit 470-B (the Integration/PR worker) per the Shared Contract's branch/PR
convention — 470-A does not open its own PR.

## Scope note (Required behavior #4 exception check)

No exception was invoked. The repository-level `.gitattributes` policy alone establishes
the required invariant for the demonstrated path (verification items 1-3 above); neither
`tools/review-watch/stage2-report.mjs`'s `extractCanonicalSkeletonFence` nor any other
parser was modified.

## Stage 1 correction (unit 470-B, PR #473)

Codex's Stage 1 review of PR #473 (head `bd67220`) found the above proof-run record
incomplete in one respect: items 1-3 only exercise **fresh** worktrees created after
`.gitattributes` already existed. An **existing** `core.autocrlf=true` clone that
already had `docs/stage2-audit-contract.md` checked out with CRLF bytes before this
policy landed does not get those bytes rewritten merely because `.gitattributes` was
added — Git only reapplies text attributes when a file is actually re-checked-out, not
when the policy changes underneath an unchanged blob. This is real, unfixable-at-`.gitattributes`-level Git
behavior, not a proof-run gap.

**Live reproduction (no synthetic worktree needed):** this repository's own working
copy on `fix/470-eol-policy` is itself such an existing clone (`core.autocrlf=true`,
confirmed via `git config core.autocrlf`). Byte-level check of the actual working-tree
file: `docs/stage2-audit-contract.md` — CRLF pairs: 216, bare LF: 216 (i.e. entirely
CRLF, matching the pre-policy defect exactly). Running
`node --test tools/review-watch/stage2-report.test.mjs` against this real state
reproduced the exact `0 !== 2` module-load failure the finding describes (`extractCanonicalSkeletonFence`
found 0 fenced blocks instead of 2, because its regex required a literal `\n`
immediately around the fence markers).

**Fix:** rather than a migration mechanism that rewrites already-materialized
working-tree files (disproportionate churn, and unenforceable for clones this
repository does not control), narrowly hardened the exact demonstrated
fixture-extraction boundary: `tools/review-watch/stage2-report.test.mjs` now reads
`docs/stage2-audit-contract.md` and immediately normalizes `\r\n` to `\n` before the
fence-matching regex runs. This is scoped to the one read site the reproduction
implicates; `tools/review-watch/stage2-report.mjs` (production parsing of GitHub API
comment bodies, which are always LF-normalized by GitHub) was not touched, and no
general newline-normalization framework was introduced.

**Verification:** re-ran `node --test tools/review-watch/stage2-report.test.mjs`
against this same real CRLF working tree after the fix: **139/139 pass, 0 fail**
(confirmed causally, not coincidentally, by stashing the fix and reproducing the
failure again, then restoring it). Re-ran the broader suite
(`tools/review-watch/*.test.mjs tools/orchestration/*.test.mjs`): **857/857 pass, 0
fail** — unchanged from the pre-correction baseline. Re-ran
`node --test tools/check-eol-policy.test.mjs`: 7/7 pass. Re-ran
`node tools/check-control-plane-paths.mjs` and `node tools/check-startup-budget.mjs`:
both OK.

**CI-wiring finding:** `tools/check-eol-policy.test.mjs` existed but was not invoked
by any checked-in workflow, and `.github/workflows/control-plane-paths.yml`'s `paths:`
trigger did not cover `.gitattributes` or the guard file itself — a future PR
narrowing or removing the EOL policy would trigger no CI check. Fixed by adding
`.gitattributes` and `tools/check-eol-policy.test.mjs` to that workflow's `paths:`
list and adding an `EOL policy regression guard` step
(`node --test tools/check-eol-policy.test.mjs`) to its existing job, alongside the
other cheap deterministic control-plane checks it already runs — no new CI
subsystem.
