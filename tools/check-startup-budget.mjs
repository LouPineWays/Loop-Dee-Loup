#!/usr/bin/env node
// Regression guard for issue #287: AGENTS.md and CLAUDE.md are imported into every fresh
// Claude Code session's automatic startup context (CLAUDE.md's `@AGENTS.md` import), so they
// must stay a thin routing contract — universal invariants plus pointers to on-demand
// docs/skills — rather than re-accumulating stage-specific procedure inline. This is a line-
// count budget, not a semantic check: it cannot tell whether an addition is a genuine universal
// invariant or a smuggled-back manual, only that the file grew. A PR that legitimately needs to
// raise a budget does so by editing the constant below in the same diff, which is then a visible,
// reviewable decision rather than silent drift — see docs/operating-model.md, "Startup context
// budget", for the standard that change should be held to.
//
// Usage: node tools/check-startup-budget.mjs
// Exits 0 and prints OK on success; exits 1 and lists every failure otherwise.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Budgets carry deliberate slack above current size (AGENTS.md is ~250 lines, CLAUDE.md ~8) so
// ordinary small edits don't trip the guard — it exists to catch re-accumulation, not to forbid
// growth outright.
const BUDGETS = [
  { path: "AGENTS.md", maxLines: 290 },
  { path: "CLAUDE.md", maxLines: 20 },
];

const failures = [];

for (const { path, maxLines } of BUDGETS) {
  const abs = join(ROOT, path);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    failures.push(`missing startup-contract file: ${path}`);
    continue;
  }
  const lineCount = text.split("\n").length;
  if (lineCount > maxLines) {
    failures.push(
      `${path} is ${lineCount} lines, over its ${maxLines}-line startup budget. ` +
        "Move stage-specific procedure to docs/*.md, a skill, or durable GitHub state instead " +
        "of leaving it in the automatically-loaded startup contract — see docs/operating-model.md, " +
        '"Startup context budget". If this growth is a deliberate, reviewed universal invariant, ' +
        "raise the budget constant in tools/check-startup-budget.mjs in the same PR.",
    );
  }
}

if (failures.length > 0) {
  console.error("Startup-context budget check FAILED:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log("OK: AGENTS.md and CLAUDE.md are within their startup-context line budgets.");
