# Burn Order

A local tool for maintaining Loop-Dee-Loup's own single cross-domain backlog order: process,
tooling, templates and docs all in **one ranked list**, lane-tagged rather than split into
separate lists. This is Loop-Dee-Loup's own backlog about the Loop itself — never a target
repository's product backlog (e.g. Covenant's), which stays entirely out of this file. See
`docs/burn-order.md` for the full spec and the idea-intake-to-Burn-Order conversion procedure.

This tool itself was copied from Covenant/Word_Burner, where the same server, verifier and
launcher are kept byte-identical across repos. Loop-Dee-Loup is not part of that cross-repo
parity manifest, so nothing here is required to stay in sync with those repos going forward —
this is a one-time copy, not an ongoing shared entry.

## Running it

Double-click **`Run Burn Order.bat`**, which starts the server and opens the page for you.
Keep its window open while you work; Ctrl+C or closing it stops the server.

Or from a terminal:

```
node tools/burn-order/server.mjs
```

Then open <http://localhost:4137>. There is no build step and no dependencies. Inside a Claude
Code session it is also registered in `.claude/launch.json` as `burn-order`.

## Where the data lives

Everything is in **`docs/burn-order.json`**, tracked in git. That is deliberate:

- a Claude Code session can read the current order directly, so nothing ever needs copying
- `git log -p docs/burn-order.json` is a real history of how priorities moved
- you can hand-edit the file, and a running page picks the change up within ~2 seconds

Writes go through a temp file and an atomic rename, so an interrupted write can't truncate the
backlog. The server refuses a write whose base mtime no longer matches the file on disk, so a
hand-edit or another session's change is never silently clobbered: the page reloads the newer
version and tells you the edit was dropped.

## Finishing something

Move it to the **Done** band. Do not retire an item by deleting it from the bands: the
editor treats an unbanded item as an accident and adopts it back into Wishes, so that move
silently undoes itself on the next page load. It happened twice to real items in Covenant
before Done existed, which is why the adoption now announces itself in red rather than
happening quietly.

A Done item carries a `done` block instead of a "DONE" note, so its status is something you
can check rather than something you have to trust:

```json
"done": { "on": "2026-07-27", "ref": "9ad4b62", "evidence": "" }
```

`ref` is a commit sha or a `#123` PR number. Process and docs-only work often has no commit
behind it, so `ref` may be empty as long as `evidence` says how you know instead. The date is
stamped for you when you move the item; the ref is yours to fill in.

## Checking it

```
node tools/burn-order/verify.mjs
```

Exits non-zero, and fails the Burn Order CI workflow on any PR touching the backlog, when:

- an item is in no band, or in two
- a Done item has no date, or has neither a resolvable ref nor an evidence line
- a `ref` names a commit or PR that does not exist in this clone
- an item still sitting in an active band opens its note by declaring itself done

That last one is the drift check running in the other direction: prose that claims completion
from inside the running order is the exact shape of the problem this is here to prevent.
Needs full git history, so CI checks out with `fetch-depth: 0`.

## How ranking works

Priority is expressed **ordinally**, never as a score. Items sit in five heat bands
(Now / Soon / Later / Wishes, plus Blocked outside the running order), and rank numbers run
continuously across bands so the list reads as one global order.

- **Now**: what you're actually spending effort on right now, including any perpetual item.
- **Soon**: what's needed next, grouped by synergy.
- **Later**: the next group of work after that, grouped by synergy.
- **Wishes**: everything else mentioned as it comes up.

Two ways to move something:

- **Grip handle** — drag a row anywhere, including into another band. Fast, good for obvious
  nudges. Switched off while a search or lane filter is active, because position relative to
  hidden rows would be ambiguous.
- **⟲ re-rank** — the deliberate path. Runs a short series of head-to-head matchups against
  items already in the band, as a binary search, so placing one item costs about log₂(n)
  choices rather than a full re-sort. The prompts are "90 days out, which would you most
  regret *not* having done?" and "which one makes the most *other* work easier, safer, or
  unnecessary?", which favour durable value and option value over whatever feels urgent.

**Undo** (or Ctrl+Z) steps back through the current session's changes and writes each step
straight to the file.

When a filter is active, rank numbers keep their true global position, so the numbering shows
gaps. That is honest, not a bug.
