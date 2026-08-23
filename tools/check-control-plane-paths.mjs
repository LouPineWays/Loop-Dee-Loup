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
  { label: "tools/burn-order/**", ok: () => dirHasFiles("tools/burn-order") },
  { label: "docs/burn-order.json", ok: () => existsSync(join(ROOT, "docs", "burn-order.json")) },
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
  "tools/burn-order/**",
  "docs/burn-order.json",
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
