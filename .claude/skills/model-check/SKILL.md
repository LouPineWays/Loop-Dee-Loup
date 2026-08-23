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

When a task is a good candidate per `.claude/skills/local-worker/SKILL.md`'s bounded-delegation criteria, recommend local execution over hosted Claude only when the combined cost of dispatch + verification + correction is materially lower than doing the work directly with the selected Claude model — not merely because local inference is cheap. Weigh reasoning depth, ambiguity, novelty, blast radius if wrong, local-model capability, amount of context that would need duplicating, cost of verifying the result, and expected cost of repairing a bad local result.

Return only:

- recommended model and effort;
- one-line reason;
- whether the slice should stay with one runner, use independent workers, use a separate reviewer, or delegate to local worker;
- any quota or tool-access constraint.

Stop after the recommendation. The founder selects the model when dispatching a fresh session.
