---
name: spend
description: Diagnose where a Loop-Dee-Loup session spent tokens and whether that spend produced validated progress.
---

# Spend

Optimize validated progress per token, not minimum tokens.

First use the platform's own usage and context reports when available. Do not parse a transcript merely to reproduce a built-in answer. If deeper evidence is required, analyze only the current authorized session data and avoid copying sensitive prompts or repository content into the report.

Classify spend into:

- fixed startup/instruction payload;
- issue and repository authority;
- tool input/output;
- repeated reads or rediscovery;
- chat narration and status repetition;
- founder decision dialogue;
- implementation/reasoning;
- verification and review;
- rework;
- handoff and durable-state maintenance.

Report:

1. total and message/context tokens when measurable;
2. largest categories and expensive turns;
3. which spend was necessary for correctness;
4. avoidable waste with exact evidence;
5. validated outcome produced;
6. one to three smallest corrections;
7. what to measure in the next fresh session.

Do not infer precision the evidence cannot support. Flag model switches, large tool outputs, recursively loaded history, and duplicated context because they tax every later turn. Recommend shorter prompts or files only when information is duplicated or non-authoritative; never remove a safety or acceptance gate merely to lower tokens.
