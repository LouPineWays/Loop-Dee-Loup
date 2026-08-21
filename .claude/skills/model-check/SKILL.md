---
name: model-check
description: Recommend the cheapest safe model, effort, and execution shape for a Loop-Dee-Loup slice before dispatch. Advisory only.
---

# Model check

Use at intake or when the task shape materially changes. The output is a routing decision, not permission to begin the underlying work.

Score 0–2 on:

1. reasoning depth;
2. ambiguity;
3. novelty;
4. blast radius if wrong;
5. benefit from extended thinking.

Choose model capability from ambiguity + novelty + blast radius. Choose effort from reasoning depth + extended-thinking benefit + whether the work requires sustained multi-file iteration. Favor the cheaper option on a genuine tie, but never trade away a required correctness, privacy, security, migration, or production-safety capability.

Prefer one capable runner for a coherent vertical slice. Use worker subagents only for genuinely independent subtasks with self-contained briefs; cold-start context duplicated across workers is token waste. A separate agent is valuable for a capability the primary runner lacks or for the one independent review required by repository policy, not as a simulated department.

Return only:

- recommended model and effort;
- one-line reason;
- whether the slice should stay with one runner, use independent workers, or use a separate reviewer;
- any quota or tool-access constraint.

Stop after the recommendation. The founder selects the model when dispatching a fresh session.
