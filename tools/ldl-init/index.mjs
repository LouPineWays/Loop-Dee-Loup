#!/usr/bin/env node
// Deterministic bootstrap mechanism for issue #66: installs the reusable Loop-Dee-Loup
// machinery (skills, personas, scripts, and the operating-model documentation they need)
// into an arbitrary existing consumer repository, without a human hand-selecting files
// from this repository. See docs/consumer-contract.md for the full ownership-boundary
// contract this script implements.
//
// Usage (run from a local clone of Loop-Dee-Loup):
//   node tools/ldl-init/index.mjs --dest <path-to-consumer-repo>
//
// --dest must already exist; it does not need to be empty and does not need to be a git
// repository. --root overrides the Loop-Dee-Loup source root (defaults to this script's
// own repository) and exists mainly so tests can point at a disposable fixture instead of
// this repository's real, changing content.
//
// What it does, each run:
//   1. Copies every path in MANAGED_ITEMS from --root into --dest, plus a derived
//      AGENTS.md template (see deriveConsumerAgents) whose destination depends on
//      whether --dest already has its own AGENTS.md.
//   2. Never overwrites a destination path that already exists and is not recorded as
//      LDL-managed in --dest's existing .ldl/manifest.json — that item is skipped
//      instead, so the bootstrap is safe against a non-empty, pre-existing repository.
//   3. Writes .ldl/manifest.json recording the source revision, install time, every
//      installed path with a content hash, and every skipped path with a reason.
//
// Running this again against an already-initialized --dest at the same source revision
// reinstalls the same managed paths with identical content: a predictable no-op, not a
// duplicate or corrupting write. Conflict-safe updates to a *locally modified* managed
// file, and updates to a *newer* Loop-Dee-Loup revision, are out of scope here — see
// docs/consumer-contract.md and issue #67.
//
// Tests: node --test tools/ldl-init/index.test.mjs

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LDL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SOURCE_ONLY_START = "<!-- ldl:source-only:start -->";
const SOURCE_ONLY_END = "<!-- ldl:source-only:end -->";

// The reusable engine/runtime material this repository distributes. Everything else in
// Loop-Dee-Loup (its own docs, its own Burn Order, its own dogfooding history) is
// development state, not consumer-installable machinery — see docs/consumer-contract.md.
// AGENTS.md is handled separately in run(), since its destination depends on consumer
// repository state, not source repository state.
export const MANAGED_ITEMS = [
  { kind: "dir", src: ".claude/skills/context-clearing", dest: ".claude/skills/context-clearing" },
  { kind: "dir", src: ".claude/skills/local-worker", dest: ".claude/skills/local-worker" },
  { kind: "dir", src: ".claude/skills/model-check", dest: ".claude/skills/model-check" },
  { kind: "dir", src: ".claude/skills/persona-maker", dest: ".claude/skills/persona-maker" },
  { kind: "dir", src: ".claude/skills/retro", dest: ".claude/skills/retro" },
  { kind: "dir", src: ".claude/skills/script-maker", dest: ".claude/skills/script-maker" },
  { kind: "dir", src: ".claude/skills/sift", dest: ".claude/skills/sift" },
  { kind: "dir", src: ".claude/skills/skill-maker", dest: ".claude/skills/skill-maker" },
  { kind: "dir", src: ".claude/skills/spend", dest: ".claude/skills/spend" },
  { kind: "file", src: ".claude/personas/audit-verdict-extractor.md", dest: ".claude/personas/audit-verdict-extractor.md" },
  { kind: "dir", src: "tools/local-worker", dest: "tools/local-worker" },
  { kind: "dir", src: "tools/review-watch", dest: "tools/review-watch" },
  { kind: "file", src: "docs/operating-model.md", dest: "docs/operating-model.md" },
  { kind: "file", src: "docs/bounded-review-cycle.md", dest: "docs/bounded-review-cycle.md" },
  { kind: "file", src: "docs/decision-forms.md", dest: "docs/decision-forms.md" },
  { kind: "file", src: "docs/consumer-contract.md", dest: "docs/consumer-contract.md" },
];

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    args[key] = argv[++i];
  }
  return args;
}

// Strips every <!-- ldl:source-only:start/end --> block (Loop-Dee-Loup's own instance
// state — its own Burn Order, its own prototype trial) out of Loop-Dee-Loup's own
// AGENTS.md, leaving the generic operating contract a consumer repository actually needs.
// Pure string transform so it is trivially unit-testable without touching the filesystem.
export function deriveConsumerAgents(sourceText) {
  let result = "";
  let cursor = 0;
  for (;;) {
    const startIdx = sourceText.indexOf(SOURCE_ONLY_START, cursor);
    if (startIdx === -1) {
      result += sourceText.slice(cursor);
      break;
    }
    const endIdx = sourceText.indexOf(SOURCE_ONLY_END, startIdx);
    if (endIdx === -1) {
      throw new Error(`unterminated ${SOURCE_ONLY_START} block in source AGENTS.md`);
    }
    result += sourceText.slice(cursor, startIdx);
    cursor = endIdx + SOURCE_ONLY_END.length;
  }
  // Collapse the run of blank lines a removed block leaves behind down to a single one.
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trimEnd() + "\n";
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

// Recursively lists files under absDir as "/"-joined paths relative to absDir, regardless
// of host OS path separator, so manifest dest paths stay stable across platforms.
function walkFiles(absDir, relPrefix = "") {
  let files = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const absPath = join(absDir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(walkFiles(absPath, relPath));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
  return files;
}

// Reads every MANAGED_ITEMS path out of root and returns one install op per file, each
// already carrying its bytes — so planning/writing downstream never needs to know whether
// an op originated from a "file" or "dir" item.
export function buildOps(root) {
  const ops = [];
  for (const item of MANAGED_ITEMS) {
    const absSrc = join(root, item.src);
    if (item.kind === "file") {
      ops.push({ destRel: item.dest, content: readFileSync(absSrc) });
    } else {
      for (const relFile of walkFiles(absSrc)) {
        ops.push({ destRel: `${item.dest}/${relFile}`, content: readFileSync(join(absSrc, relFile)) });
      }
    }
  }
  return ops;
}

// Splits ops into what is safe to (re)install versus what must be left alone: a
// destination path that already exists and is not recorded as LDL-managed in an existing
// manifest is a pre-existing, unrelated consumer file, not something this bootstrap is
// allowed to touch.
export function planInstall({ ops, destRoot, existingManifest }) {
  const managedDestSet = new Set((existingManifest?.files || []).map((f) => f.dest));
  const toInstall = [];
  const toSkip = [];
  for (const op of ops) {
    const absDest = join(destRoot, op.destRel);
    const exists = existsSync(absDest);
    if (exists && !managedDestSet.has(op.destRel)) {
      toSkip.push({ dest: op.destRel, reason: "destination already exists and is not LDL-managed" });
      continue;
    }
    toInstall.push(op);
  }
  return { toInstall, toSkip };
}

function applyInstall(ops, destRoot) {
  const installed = [];
  for (const op of ops) {
    const absDest = join(destRoot, op.destRel);
    mkdirSync(dirname(absDest), { recursive: true });
    writeFileSync(absDest, op.content);
    installed.push({ dest: op.destRel, sha256: sha256(op.content) });
  }
  return installed;
}

export function defaultResolveRevision(root) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// `resolveRevisionImpl` and `now` are injected so tests get deterministic manifest output
// without depending on this process's own git state or wall-clock time.
export async function run(args, deps = {}) {
  const { resolveRevisionImpl = defaultResolveRevision, now = () => new Date().toISOString() } = deps;

  if (!args.dest) {
    return { exitCode: 1, message: "Missing required arg: --dest <path-to-consumer-repo>" };
  }

  const root = args.root || LDL_ROOT;
  const destRoot = args.dest;

  if (!existsSync(destRoot) || !statSync(destRoot).isDirectory()) {
    return { exitCode: 1, message: `--dest does not exist or is not a directory: ${destRoot}` };
  }

  const manifestPath = join(destRoot, ".ldl", "manifest.json");
  let existingManifest = null;
  if (existsSync(manifestPath)) {
    try {
      existingManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      return { exitCode: 1, message: `existing .ldl/manifest.json is not valid JSON: ${err.message}` };
    }
  }

  let ops;
  try {
    ops = buildOps(root);
  } catch (err) {
    return { exitCode: 1, message: `failed reading managed items from --root ${root}: ${err.message}` };
  }

  // AGENTS.md is derived from source content but its destination depends on consumer
  // repository state (does it already have one, and if so, did we install it?) — see
  // docs/consumer-contract.md, "The AGENTS.md special case".
  let derivedAgents;
  try {
    derivedAgents = deriveConsumerAgents(readFileSync(join(root, "AGENTS.md"), "utf8"));
  } catch (err) {
    return { exitCode: 1, message: `failed deriving consumer AGENTS.md: ${err.message}` };
  }
  const agentsAlreadyManaged = Boolean(existingManifest?.files?.some((f) => f.dest === "AGENTS.md"));
  const destAgentsExists = existsSync(join(destRoot, "AGENTS.md"));
  const agentsDestRel = !destAgentsExists || agentsAlreadyManaged ? "AGENTS.md" : ".ldl/AGENTS.template.md";
  ops.push({ destRel: agentsDestRel, content: Buffer.from(derivedAgents, "utf8") });

  const { toInstall, toSkip } = planInstall({ ops, destRoot, existingManifest });
  const installedFiles = applyInstall(toInstall, destRoot).sort((a, b) => a.dest.localeCompare(b.dest));

  const manifest = {
    schemaVersion: 1,
    ldlSourceRevision: resolveRevisionImpl(root),
    installedAt: now(),
    files: installedFiles,
    skipped: toSkip,
  };

  mkdirSync(join(destRoot, ".ldl"), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  return {
    exitCode: 0,
    message: JSON.stringify({
      installed: manifest.files.length,
      skipped: manifest.skipped.length,
      revision: manifest.ldlSourceRevision,
      manifestPath: ".ldl/manifest.json",
    }),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await run(args);
  if (result.exitCode === 0) {
    console.log(result.message);
  } else {
    console.error(result.message);
  }
  process.exit(result.exitCode);
}

// Only run as a CLI when invoked directly, not when the test file imports these functions.
if (process.argv[1] && process.argv[1].endsWith("index.mjs")) {
  main();
}
