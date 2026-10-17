# Convert one Issue into a runnable pair

You have one accepted GitHub Issue and want to start LDL on it without learning the
thin-control / thick-execution wiring. One command does the representation, binding and
verification. You supply the Issue number and your explicit say-so; nothing else.

## Shortest path

From the repository checkout, with `gh` authenticated:

```bash
# 1. See exactly what would happen. Creates and changes nothing.
node tools/orchestration/convert-issue-pair.mjs --source-issue 123 --founder-authorized --dry-run

# 2. Do it.
node tools/orchestration/convert-issue-pair.mjs --source-issue 123 --founder-authorized
```

`--founder-authorized` is your statement that you chose Issue 123 for conversion. A label
(`priority:now`), the Issue merely existing, a comment, or a model's proposal never authorizes
creating an Issue; the command refuses without the flag and changes nothing.

## Which number to work on

The report ends in exactly one of these states (this table lists every state the command can return). Only the first means you can start.

| State | Meaning | What to do |
| --- | --- | --- |
| `CONVERTED_READY` | Pair bound, activated, and a fresh session-entry gate returned `READY_TO_DISPATCH`. | Start a session with `work on #123` (the number you gave, never the new one). |
| `CONVERTED_PENDING_GRANT` | Pair bound and retained, and activation stopped only because the thick Issue carries a valid, canonical `PROPOSED` executor-substrate grant (checked by the authority validator, matching the control's pending decision) with no `ACTIVE` grant yet. Not executable. | Approve or decline the grant named in `nextAction`, promote it with `write-thick-grant.mjs`, then re-run the same command. |
| `CONVERTED_NOT_READY` | Pair bound, but activation or the fresh gate did not return `READY_TO_DISPATCH` (any other blocker, including a malformed grant section). Not executable; exit code 1. | Read `message`, `activationState` and `gateState`; fix the named cause and re-run. |
| `BOUND_NOT_ACTIVATED` | Only with `--bind-only`: bound and verified, not activated. | Run the `nextAction` activation command. |
| `DRY_RUN` | Only with `--dry-run`: the plan is printed; nothing was created or changed. | Re-run without `--dry-run` to convert. |
| `PARTIAL_THICK_CREATED`, `CREATE_FAILED`, `STALE_SOURCE`, `BIND_READBACK_FAILED`, `BIND_READBACK_MISMATCH`, `READ_FAILED`, `NO_REPO` | An interruption or read failure left a partial state or proved nothing; the report names it. | Re-run the same command. It is idempotent. |
| `NOT_AUTHORIZED`, `BAD_SOURCE`, `BAD_GRANT_PROPOSAL`, `NOT_AN_ISSUE`, `UNSUPPORTED_CLASS`, `UNSUPPORTED_COMPLETED`, `UNSUPPORTED_IN_FLIGHT`, `AMBIGUOUS_CHILDREN`, `WRONG_PARENT`, `ROUTE_CHANGE_UNAUTHORIZED` | Refused with a diagnosis (exit code 2); nothing was changed. | Read `message`; fix the named cause. |

A `priority:*` label never blocks conversion: the structured `### Priority horizon` section is
authoritative and the label is used only when no horizon is written.

## What it creates and changes

Exactly two Issues exist afterwards.

- Your original Issue stays open and keeps its number. It becomes the thin control: its
  original text is preserved verbatim under `### Source item`, and the canonical snapshot writer
  records the sole `Execution: #<new>` pointer, route, lifecycle and decision status.
- One new thick execution Issue (`[Slice] ...`) carries the translated story, minimum success,
  evidence, scope text and the exact `### Parent loop` binding. Nothing is added that the source
  did not say.

Binding goes only through `write-control-snapshot.mjs`; activation only through
`activate-control-pair.mjs` and a fresh `session-entry-gate`. The command never hand-edits a
control field and never reports readiness without the gate.

## When a grant is needed

If the work changes an executor-substrate component, pass the exact proposal you want the
founder to consider:

```bash
node tools/orchestration/convert-issue-pair.mjs --source-issue 123 --founder-authorized \
  --proposed-grant-file grant.json     # {"executorSubstrate":[{component, paths, intendedChange, verification}]}
```

It is recorded only as a `PROPOSED` section on the thick Issue and the control shows one
founder decision. No grant is ever inferred or activated by the conversion.

## What it refuses

- A source that is closed, a pull request, an existing control with no current packet, or already
  a thick packet.
- A source (or its packet) with a linked PR, a Stage 1 / Stage 2 reference, an audit naming it or its execution packet, or a
  mid-cycle or completed lifecycle. Existing PR, review and audit history is never rewritten.
- Any ambiguity about existing children: several candidates, a similarly titled Issue, an unmarked
  or closed child, a marker with a different parent, or a second current packet.

## Re-running

Safe at any point. An already-bound pair is re-verified and re-activated without a second
write. If a run was interrupted after the thick Issue was created, the next run recovers it only
when it is the single OPEN Issue carrying this source's provenance marker and the exact Parent
loop; otherwise it fails closed and tells you which Issues to inspect.
