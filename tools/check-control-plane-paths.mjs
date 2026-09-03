#!/usr/bin/env node
// Verifies the control-plane path list in docs/bounded-review-cycle.md still resolves
// against the real repository. Regression guard for issues #37, #39, and #41, where
// three consecutive Stage 2 audits in a row each found a real control-plane path
// (CLAUDE.md, .claude/launch.json, README.md) missing from that list.
//
// This only catches drift in paths ALREADY listed (a stale glob, a renamed or deleted
// directory). It cannot detect a brand-new top-level location that should be ADDED to
// the list — deciding whether a new path is control-relevant is a judgment call, not a
// deterministic check. See .claude/skills/script-maker/SKILL.md.
//
// Usage: node tools/check-control-plane-paths.mjs
// Exits 0 and prints OK on success; exits 1 and lists every failure otherwise.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATH = join(ROOT, "docs", "bounded-review-cycle.md");
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "control-plane-paths.yml");

function dirHasFiles(relPath, predicate = () => true) {
  const abs = join(ROOT, relPath);
  return existsSync(abs) && readdirSync(abs).some(predicate);
}

const pathChecks = [
  { label: "AGENTS.md", ok: () => existsSync(join(ROOT, "AGENTS.md")) },
  { label: "CLAUDE.md", ok: () => existsSync(join(ROOT, "CLAUDE.md")) },
  { label: "README.md", ok: () => existsSync(join(ROOT, "README.md")) },
  { label: "docs/*.md", ok: () => dirHasFiles("docs", (f) => f.endsWith(".md")) },
  { label: ".github/ISSUE_TEMPLATE/*", ok: () => dirHasFiles(".github/ISSUE_TEMPLATE") },
  { label: ".github/workflows/*.yml", ok: () => dirHasFiles(".github/workflows", (f) => f.endsWith(".yml")) },
  { label: ".claude/**", ok: () => dirHasFiles(".claude") },
  { label: "tools/check-priority-labels.mjs", ok: () => existsSync(join(ROOT, "tools", "check-priority-labels.mjs")) },
  { label: "tools/check-startup-budget.mjs", ok: () => existsSync(join(ROOT, "tools", "check-startup-budget.mjs")) },
  { label: "tools/local-worker/**", ok: () => dirHasFiles("tools/local-worker") },
  { label: "tools/review-watch/**", ok: () => dirHasFiles("tools/review-watch") },
  { label: "tools/telemetry/**", ok: () => dirHasFiles("tools/telemetry") },
  { label: "tools/orchestration/**", ok: () => dirHasFiles("tools/orchestration") },
  { label: "tools/ldl-init/**", ok: () => dirHasFiles("tools/ldl-init") },
  { label: "tools/ldl-update/**", ok: () => dirHasFiles("tools/ldl-update") },
  { label: "tools/ldl-ack/**", ok: () => dirHasFiles("tools/ldl-ack") },
  { label: "tools/ldl-activate/**", ok: () => dirHasFiles("tools/ldl-activate") },
  { label: "tools/mcp-server/**", ok: () => dirHasFiles("tools/mcp-server") },
  { label: "tools/ldl-sync/**", ok: () => dirHasFiles("tools/ldl-sync") },
];

// Cross-check: every literal path token this script relies on must still appear
// verbatim in the governing prose, so the script and the doc cannot silently drift
// apart from each other.
const requiredLiterals = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "docs/*.md",
  ".github/ISSUE_TEMPLATE/*",
  ".github/workflows/*.yml",
  ".claude/**",
  "tools/check-priority-labels.mjs",
  "tools/check-startup-budget.mjs",
  "tools/local-worker/**",
  "tools/review-watch/**",
  "tools/telemetry/**",
  "tools/orchestration/**",
  "tools/ldl-init/**",
  "tools/ldl-update/**",
  "tools/ldl-ack/**",
  "tools/ldl-activate/**",
  "tools/mcp-server/**",
  "tools/ldl-sync/**",
];

const failures = [];

// Anchors bound the specific enumeration sentence, not the whole document — a docs-wide
// substring search would still find e.g. "AGENTS.md" mentioned elsewhere in the file even
// after it was removed from the actual control-plane list, missing the exact drift this
// check exists to catch.
const ENUM_START = "a control-plane path";
const ENUM_END = "is never trivial";

if (!existsSync(DOC_PATH)) {
  failures.push(`missing governing doc: docs/bounded-review-cycle.md`);
} else {
  const docText = readFileSync(DOC_PATH, "utf8");
  const startIdx = docText.indexOf(ENUM_START);
  const endIdx = docText.indexOf(ENUM_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    failures.push(
      "docs/bounded-review-cycle.md: could not locate the control-plane path enumeration (anchor phrasing changed)",
    );
  } else {
    const enumeration = docText.slice(startIdx, endIdx);
    for (const literal of requiredLiterals) {
      if (!enumeration.includes(literal)) {
        failures.push(`docs/bounded-review-cycle.md control-plane enumeration no longer mentions: ${literal}`);
      }
    }
  }
}

for (const { label, ok } of pathChecks) {
  if (!ok()) failures.push(`control-plane path missing or empty: ${label}`);
}

// Regression guard for issue #93: a leading-slash glob like "/*.md" silently never matches
// (GitHub Actions path filters don't support a leading "/"), so the CI trigger can carry a
// root-level control-plane pattern without it ever actually firing the workflow. The safe
// root-only pattern is "*.md" with no leading slash — "*" doesn't cross "/", so it can't
// accidentally reach into docs/ or elsewhere. Root files have no per-file literal here on
// purpose: docs/bounded-review-cycle.md classifies control-plane root-level *.md as an open
// pattern ("currently AGENTS.md, CLAUDE.md, README.md"), not a closed list, so a future root
// file must trigger this workflow without a matching edit here too.
if (!existsSync(WORKFLOW_PATH)) {
  failures.push("missing control-plane-paths workflow: .github/workflows/control-plane-paths.yml");
} else {
  const workflowText = readFileSync(WORKFLOW_PATH, "utf8");
  if (!workflowText.includes(`"*.md"`)) {
    failures.push(
      '.github/workflows/control-plane-paths.yml pull_request.paths no longer lists the root-level ' +
        '"*.md" pattern (a leading-slash variant like "/*.md" silently never matches anything)',
    );
  }
}

if (failures.length > 0) {
  console.error("Control-plane path check FAILED:");
  for (const failure of failures) console.error(` - ${failure}`);
  console.error("");
  console.error(
    "This check only catches drift in paths already listed in docs/bounded-review-cycle.md.",
  );
  console.error(
    "A new top-level location that should become control-plane still needs a human or agent",
  );
  console.error("judgment call, not this script.");
  process.exit(1);
}

console.log("OK: the control-plane path list in docs/bounded-review-cycle.md matches the repository.");
