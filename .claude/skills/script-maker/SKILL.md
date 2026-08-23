---
name: script-maker
description: Convert a demonstrated, repeated deterministic repository operation into a script, replacing model reasoning with a checked, verifiable tool.
---

# Script maker

Only for operations a computer can already judge correctly — parsing, validation, formatting, state extraction, consistency checks, mechanical repository edits.

Before writing anything:

1. Confirm the operation is deterministic — no founder decision, ambiguous product judgment, or safety/correctness call embedded in it. If judgment is required, this belongs to `skill-maker`, not here. If the recurring need is actually a fixed expertise/decision profile for a role — not an operation to execute — this belongs to `persona-maker` instead.
2. Confirm it has actually recurred — point to at least two real prior instances, not a hypothesis. One occurrence is not a pattern.
3. Search existing repository tooling (e.g. `tools/**`, CI workflows) for something that already does this or is trivially extended to. Prefer extending over duplicating.

If all three hold, define:

- **Inputs/outputs:** exact arguments, files read, and what success prints or returns.
- **Failure behavior:** what makes it exit non-zero, and what message a human or agent sees.
- **Verification:** a test or deterministic self-check proving the script behaves correctly, not just that it runs.
- **Invocation:** the exact command a fresh session with zero conversation history would run, documented in a README or the script's own header comment.

Keep the script's scope to the deterministic slice only. If part of the operation still needs judgment (e.g. deciding *whether* a newly added path belongs in scope, not just checking already-listed paths), say so explicitly and leave that part to a skill or ordinary instructions — do not silently drop it to make the script look complete.

Do not build a script for an operation that occurred once, or to pre-empt work that hasn't happened yet.
