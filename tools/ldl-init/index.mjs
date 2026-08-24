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
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  { kind: "dir", src: ".github/ISSUE_TEMPLATE", dest: ".github/ISSUE_TEMPLATE" },
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

// Exported so tools/ldl-update can hash on-disk content against recorded/target hashes
// using the exact same digest this script's own manifest entries are computed with.
export function sha256(content) {
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

// Walks destRoot down to destRel one path segment at a time and returns a reason string
// the moment it finds something that makes writing there unsafe, or null if the path is
// clear. Two distinct hazards, checked together because both are "don't trust what's
// already sitting at or above this destination":
//   - an existing symlink anywhere on the path (including the leaf) could redirect the
//     write outside destRoot entirely, e.g. a pre-existing `.claude/skills/sift` symlinked
//     to somewhere unrelated;
//   - an existing plain file where a directory needs to be (e.g. a file literally named
//     `tools`) would otherwise make mkdirSync throw mid-run, leaving a partially applied,
//     unmanifested install instead of a clean skip.
// Every existence check here uses lstatOrNull, not existsSync: existsSync follows symlinks
// and reports false for a dangling one (Node's own documented behavior), which would let a
// dangling symlink at or above the destination slip through as "absent" — and
// fs.writeFileSync itself follows symlinks by default, so a dangling leaf symlink left
// undetected here would have applyInstall() create its write through the link, materializing
// the write at whatever path the symlink names, possibly outside destRoot entirely.
// Exported so tools/ldl-update can apply the exact same write-through-symlink /
// write-through-non-directory guard when re-planning an update.
export function findUnsafeDestReason(destRoot, destRel) {
  const segments = destRel.split("/");
  const leaf = segments.pop();
  let current = destRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const st = lstatOrNull(current);
    if (!st) continue; // will be created by mkdirSync later — fine
    if (st.isSymbolicLink()) {
      return `existing symlink at ${relative(destRoot, current).split("\\").join("/")} in the destination path — refusing to write through it`;
    }
    if (!st.isDirectory()) {
      return `existing non-directory at ${relative(destRoot, current).split("\\").join("/")} blocks this destination path`;
    }
  }
  const absLeaf = join(current, leaf);
  const leafSt = lstatOrNull(absLeaf);
  if (leafSt && leafSt.isSymbolicLink()) {
    return `existing symlink at ${destRel} — refusing to write through it`;
  }
  return null;
}

// Splits ops into what is safe to (re)install versus what must be left alone. A
// destination is left alone, and recorded under skipped with a reason, when either:
//   - some part of its path is unsafe to write through (see findUnsafeDestReason), or
//   - it already exists and is not recorded as LDL-managed in an existing manifest, i.e.
//     it is a pre-existing, unrelated consumer file this bootstrap is not allowed to touch.
export function planInstall({ ops, destRoot, existingManifest }) {
  const managedDestSet = new Set((existingManifest?.files || []).map((f) => f.dest));
  const toInstall = [];
  const toSkip = [];
  for (const op of ops) {
    const unsafeReason = findUnsafeDestReason(destRoot, op.destRel);
    if (unsafeReason) {
      toSkip.push({ dest: op.destRel, reason: unsafeReason });
      continue;
    }
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

// buildOps() copies working-tree bytes, not the committed blob at HEAD, so a dirty
// Loop-Dee-Loup clone can install content that doesn't match the recorded commit. A
// "-dirty" suffix (the same convention `git describe --dirty` uses) keeps the recorded
// revision an honest description of what was actually installed instead of a silently
// misleading provenance claim.
export function defaultResolveRevision(root) {
  let sha;
  try {
    sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
  try {
    const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
    if (status.trim().length > 0) {
      return `${sha}-dirty`;
    }
  } catch {
    // HEAD resolved but status didn't — still report the sha we do have.
  }
  return sha;
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;

// A pre-existing .ldl/manifest.json that isn't in the shape this script writes (absent,
// truncated, or from something else entirely) must not be trusted as a record of what is
// LDL-managed — treating it as absent falls back to safe fresh-install semantics instead
// of either crashing on an unexpected shape or silently trusting arbitrary JSON. Every
// `files` entry must carry a complete, plausible record (a non-empty `dest` and a real
// sha256 hex digest), not just pass a loose type check: an incomplete entry like
// `{"dest":"AGENTS.md"}` would otherwise be accepted as an LDL ownership claim over
// AGENTS.md, and this script would then treat a consumer's own untouched AGENTS.md as
// safe to overwrite — the exact thing the AGENTS.md special case exists to prevent.
// Exported so tools/ldl-update applies this exact same shape check to the manifest it
// reads, rather than trusting or re-implementing a slightly different validation.
export function isValidManifest(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1 || !Array.isArray(value.files)) {
    return false;
  }
  const filesValid = value.files.every(
    (f) =>
      f &&
      typeof f === "object" &&
      typeof f.dest === "string" &&
      f.dest.length > 0 &&
      typeof f.sha256 === "string" &&
      SHA256_HEX.test(f.sha256),
  );
  if (!filesValid) return false;
  // `skipped` is optional (an older or hand-authored manifest may omit it entirely), but
  // when present every entry must carry a real dest/reason pair. tools/ldl-update sorts
  // this list by comparing `.reason` with String.prototype.localeCompare — an entry with a
  // missing or non-string reason would pass through undetected here and only surface later
  // as an uncaught crash mid-comparison, instead of the intended "reinitialize" error.
  if (value.skipped !== undefined) {
    if (!Array.isArray(value.skipped)) return false;
    const skippedValid = value.skipped.every(
      (s) =>
        s &&
        typeof s === "object" &&
        typeof s.dest === "string" &&
        s.dest.length > 0 &&
        typeof s.reason === "string" &&
        s.reason.length > 0,
    );
    if (!skippedValid) return false;
  }
  return true;
}

// lstatSync wrapped to distinguish "genuinely nothing there" (ENOENT) from every other
// outcome, including a dangling symlink: lstatSync succeeds on a dangling symlink (it
// stats the link itself, not its missing target), so using existsSync — which follows
// symlinks and reports false for a dangling one — to decide whether to lstat at all would
// let a dangling symlink slip through as "absent" and be silently written through anyway.
function lstatOrNull(absPath) {
  try {
    return lstatSync(absPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

// .ldl/ is LDL's own managed namespace (the manifest, and sometimes the derived AGENTS.md
// template) — findUnsafeDestReason() above only guards the MANAGED_ITEMS-derived ops, so
// without this separate check a pre-existing .ldl symlink (dangling or not) or a symlinked
// manifest.json leaf could redirect the manifest write or the stale-template delete
// outside --dest, and a pre-existing .ldl *file* would only be discovered when the final
// mkdirSync() throws, after every other managed file had already been written — a
// partial, unmanifested install. Checking this once, before anything else runs, fails the
// whole run closed instead of partially.
// Exported so tools/ldl-update guards its own .ldl/manifest.json read+rewrite against the
// same symlink/non-directory hazards, before reading any existing provenance.
export function findUnsafeLdlDirReason(destRoot) {
  const dirAbs = join(destRoot, ".ldl");
  const dirSt = lstatOrNull(dirAbs);
  if (dirSt) {
    if (dirSt.isSymbolicLink()) {
      return "existing symlink at .ldl — refusing to write LDL's own managed state through it";
    }
    if (!dirSt.isDirectory()) {
      return "existing non-directory at .ldl — cannot use it as LDL's managed directory";
    }
  }
  const manifestSt = lstatOrNull(join(dirAbs, "manifest.json"));
  if (manifestSt && manifestSt.isSymbolicLink()) {
    return "existing symlink at .ldl/manifest.json — refusing to write LDL's own manifest through it";
  }
  return null;
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

  const unsafeLdlReason = findUnsafeLdlDirReason(destRoot);
  if (unsafeLdlReason) {
    return { exitCode: 1, message: `Refusing to run: ${unsafeLdlReason}` };
  }

  const manifestPath = join(destRoot, ".ldl", "manifest.json");
  let existingManifest = null;
  if (existsSync(manifestPath)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      return { exitCode: 1, message: `existing .ldl/manifest.json is not valid JSON: ${err.message}` };
    }
    existingManifest = isValidManifest(parsed) ? parsed : null;
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

  // If a prior run parked the derived template at .ldl/AGENTS.template.md (because the
  // consumer had its own AGENTS.md at the time) and this run is now installing straight to
  // AGENTS.md instead (the consumer's own file is gone), the old template is superseded —
  // remove it so it doesn't linger on disk unrecorded by the new manifest.
  const previousTemplateFile = existingManifest?.files?.some((f) => f.dest === ".ldl/AGENTS.template.md");
  if (agentsDestRel === "AGENTS.md" && previousTemplateFile) {
    const staleTemplatePath = join(destRoot, ".ldl", "AGENTS.template.md");
    if (existsSync(staleTemplatePath)) {
      rmSync(staleTemplatePath);
    }
  }

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

// Only run as a CLI when this exact file is the process entrypoint, not merely when some
// other script's argv[1] happens to end in "index.mjs" — tools/ldl-update/index.mjs is
// itself invoked as `node .../index.mjs`, so a suffix check here would run this module's
// own main() (installing/overwriting managed files, then calling process.exit()) as a side
// effect of tools/ldl-update simply importing this module's helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
