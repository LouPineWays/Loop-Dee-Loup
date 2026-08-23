---
name: local-worker
description: Invoke a configured local LLM for a bounded, cheaply-verifiable subtask a Claude subagent has already decided is a good local-delegation candidate.
---

# Local worker

The local-worker adapter (`tools/local-worker/adapter.mjs`) lets a Claude subagent delegate a narrow, self-contained subtask to a configured local LLM instead of doing it with hosted Claude tokens. It is a cheaper execution substrate beneath the subagent, not an independent authority: local output is candidate work, never accepted work, until the dispatching Claude subagent independently verifies it.

## When to use it

A local LLM is not another rung in the deterministic-mechanism hierarchy (`script-maker` → `skill-maker` → `persona-maker` → ordinary instructions). If deterministic code can safely perform the operation, use a script instead — see `.claude/skills/script-maker/SKILL.md` — rather than spending any model inference, local or hosted, on it. Local delegation applies only to work that still requires model judgment: deterministic mechanism where possible → local LLM when suitable → hosted Claude when needed.

Only after `model-check` (or the dispatching subagent's own equivalent judgment) has determined the task is a good local-delegation candidate.

Good candidates: localized implementation from settled requirements; boilerplate; straightforward tests; fixture/test-data generation; mundane documentation derived from settled facts; bounded transformations or classifications; first-pass analysis that's cheap for Claude to check.

Reject local delegation when the work depends on: unresolved founder intent; architecture/product-direction decisions; material UX, monetization, legal, privacy, or security judgment; irreversible action; ambiguous repository authority; independent review; acceptance decisions that can't be checked cheaply; or broad repository understanding that would require duplicating a large Claude context into the local model.

## How to invoke it

Work-packet JSON schema:

```
{
  "task": "string, required — the bounded instruction",
  "constraints": ["array of strings, optional"],
  "context": "string, optional — the smallest sufficient excerpt, never a full transcript",
  "expectedShape": "string, required — the exact expected output format",
  "timeoutMs": "number, optional, default 30000"
}
```

Write the packet to a file, then run:

```
node tools/local-worker/adapter.mjs packet.json
```

Parse the printed JSON result (`{ ok, status, output, detail }`) from stdout. `LDL_LOCAL_BASE_URL` and `LDL_LOCAL_MODEL` env vars point the adapter at a different local runtime/model than the default (`http://localhost:11434`, `gpt-oss:20b`).

### Worked examples

Each block below is one complete, independently runnable packet — save either one alone as `packet.json` and run it as shown above. The adapter accepts exactly one packet object per invocation, not an array; delegate a batch of subtasks as separate invocations, not one packet holding several.

**Example A — fixture generation:**

```json
{
  "task": "Generate 5 fixture objects representing Loop-Dee-Loup GitHub issues for a parser test. Each object needs fields: number (integer), title (string), state (\"OPEN\" or \"CLOSED\"), labels (array of strings, may be empty).",
  "constraints": [
    "Output must be a single JSON array of exactly 5 objects.",
    "No markdown fences, no commentary.",
    "Numbers must be distinct integers between 1 and 999.",
    "At least one object must have an empty labels array and at least one must have two or more labels."
  ],
  "context": "",
  "expectedShape": "A JSON array of 5 objects, each with number, title, state, labels fields, parseable by JSON.parse with no surrounding text."
}
```

**Example B — mundane settled-fact documentation:**

```json
{
  "task": "Write one paragraph documenting that Loop-Dee-Loup's control-plane path checker (tools/check-control-plane-paths.mjs) verifies the path list in docs/bounded-review-cycle.md still resolves against the repository, and that it cannot detect a brand-new top-level location that should be added to that list.",
  "constraints": [
    "One paragraph, 3-5 sentences.",
    "No markdown fences, no heading, no commentary before or after.",
    "State only the two facts given; do not invent additional behavior."
  ],
  "context": "tools/check-control-plane-paths.mjs exists and is wired into CI as the control-plane-paths workflow.",
  "expectedShape": "A single plain-text paragraph, 3-5 sentences, no markdown."
}
```

(These two packets were drafted by Claude after a real dogfood attempt against Ollama/gpt-oss:20b hit the timeout-then-fallback path described below — see PR history for the full transcript. They illustrate realistic shapes, not a guarantee any given local runtime will complete them quickly.)

## Verification duty

The dispatching Claude subagent must independently verify output using the smallest sufficient method: tests, lint/type checks, deterministic validators, diff inspection, or comparison against requirements. Never accept a local model's own claim of success.

The local model has no independent authority to: certify its own work, make founder decisions, alter acceptance criteria, bypass repository instructions, declare anything complete, waive failed checks, perform Stage 1/Stage 2 review, or touch GitHub/repository state. A successful local call does not change acceptance criteria, repository authority, or the bounded review cycle.

## Retry and fallback policy

On verification failure, at most one bounded local retry with a corrective addition to the packet is allowed. If that also fails — or the adapter returns `unavailable`, `timeout`, or `error` — fall back to doing the work with the currently selected Claude model. No founder interruption is required for a routine local failure. Do not coach the local model through more than one retry.

## What it never does

The adapter performs no repository or GitHub action of any kind: no git, no `gh`, no file writes, no shell execution. It makes one HTTP call and returns structured data. Creating issues, pushing, merging, or otherwise changing repository state stays under Claude control.
