#!/usr/bin/env node
// Deterministic, conflict-safe update mechanism for issue #67: moves an already
// `tools/ldl-init`-bootstrapped consumer repository's installed LDL-managed material to
// whatever revision a --root Loop-Dee-Loup clone is currently at, without touching
// consumer-owned material and without silently overwriting a locally modified managed
// file. See docs/consumer-contract.md for the full ownership-boundary contract this
// script updates within, and tools/ldl-init/index.mjs for the bootstrap mechanism this
// complements.
//
// Usage (run from a local clone of Loop-Dee-Loup, updated to whatever revision you want
// to move the consumer repository to):
//   node tools/ldl-update/index.mjs --dest <path-to-already-initialized-consumer-repo>
//
// --dest must already have a valid .ldl/manifest.json written by a prior `tools/ldl-init`
// run — this mechanism has nothing to update from otherwise, and errors out instructing
// the caller to bootstrap first. --root overrides the Loop-Dee-Loup source root (defaults
// to this script's own repository) and exists mainly so tests can point at a disposable
// fixture instead of this repository's real, changing content.
//
// What it does, each run:
//   1. Rebuilds the exact same target ops tools/ldl-init would (MANAGED_ITEMS content
//      plus the derived AGENTS.md), from --root.
//   2. For every managed destination, compares its current on-disk content hash against
//      both the hash recorded in the existing manifest and the new target hash:
//        - on-disk hash == target hash            -> already current, nothing to write;
//        - on-disk hash == recorded hash (only)   -> unmodified since install, safe to
//                                                     overwrite with the new content;
//        - on-disk hash matches neither            -> local modification the mechanism
//                                                     cannot safely reconcile: a conflict;
//        - path missing entirely though recorded   -> also a conflict (a local deletion is
//                                                     still a local modification the
//                                                     recorded provenance doesn't explain).
//      A destination not previously recorded as managed follows the same pre-existing-file
//      rule tools/ldl-init uses: install if the path is free, skip (never overwrite) if
//      something unmanaged is already sitting there.
//   3. If any conflict is found, the whole run refuses to write anything and reports every
//      conflicting path and reason — fails safely rather than discarding either version,
//      partially applying only the safe subset, or guessing which side wins.
//   4. Otherwise, if there is nothing to install, the run is a no-op: it does not touch
//      .ldl/manifest.json or any managed file at all.
//   5. Otherwise, it writes every changed/newly-added managed path and rewrites
//      .ldl/manifest.json with the new source revision, a fresh install timestamp, and the
//      full resulting set of managed paths (including ones that already matched and so
//      needed no write, and any previously recorded managed path this revision's ops no
//      longer cover, left untouched and still recorded).
//
// Tests: node --test tools/ldl-update/index.test.mjs

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOps,
  defaultResolveRevision,
  deriveConsumerAgents,
  findUnsafeDestReason,
  findUnsafeLdlDirReason,
  isValidManifest,
  parseArgs,
  sha256,
} from "../ldl-init/index.mjs";

export { parseArgs };

const LDL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

// Classifies every target op against the existing manifest and current on-disk state.
// Returns:
//   toInstall  - ops safe to (re)write: new content, either newly managed or unmodified
//                since the last install;
//   toSkip     - destinations left alone because something unmanaged already occupies the
//                path or a path component is unsafe to write through;
//   conflicts  - previously managed destinations whose on-disk content cannot be safely
//                reconciled with the new target content (locally modified or deleted);
//   unchangedFiles - previously managed (or newly matching) destinations already holding
//                the exact target content, recorded in the rewritten manifest as-is.
export function planUpdate({ ops, destRoot, existingManifest }) {
  const recordedByDest = new Map(existingManifest.files.map((f) => [f.dest, f.sha256]));
  const toInstall = [];
  const toSkip = [];
  const conflicts = [];
  const unchangedFiles = [];

  for (const op of ops) {
    const unsafeReason = findUnsafeDestReason(destRoot, op.destRel);
    if (unsafeReason) {
      toSkip.push({ dest: op.destRel, reason: unsafeReason });
      continue;
    }

    const absDest = join(destRoot, op.destRel);
    const targetHash = sha256(op.content);
    const recordedHash = recordedByDest.get(op.destRel);

    if (recordedHash === undefined) {
      if (existsSync(absDest)) {
        toSkip.push({ dest: op.destRel, reason: "destination already exists and is not LDL-managed" });
      } else {
        toInstall.push(op);
      }
      continue;
    }

    if (!existsSync(absDest)) {
      conflicts.push({
        dest: op.destRel,
        reason: "LDL-managed file recorded in provenance is missing locally (deleted since install)",
      });
      continue;
    }

    const currentHash = sha256(readFileSync(absDest));
    if (currentHash === targetHash) {
      unchangedFiles.push({ dest: op.destRel, sha256: targetHash });
    } else if (currentHash === recordedHash) {
      toInstall.push(op);
    } else {
      conflicts.push({
        dest: op.destRel,
        reason: "locally modified since install (current content matches neither the recorded provenance nor the new source content)",
      });
    }
  }

  return { toInstall, toSkip, conflicts, unchangedFiles };
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
  if (!existsSync(manifestPath)) {
    return {
      exitCode: 1,
      message: "No .ldl/manifest.json found in --dest — run tools/ldl-init first; there is nothing installed to update.",
    };
  }

  let parsedManifest;
  try {
    parsedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { exitCode: 1, message: `existing .ldl/manifest.json is not valid JSON: ${err.message}` };
  }
  if (!isValidManifest(parsedManifest)) {
    return {
      exitCode: 1,
      message: "existing .ldl/manifest.json is not in the expected shape — run tools/ldl-init to reinitialize before updating.",
    };
  }

  let ops;
  try {
    ops = buildOps(root);
  } catch (err) {
    return { exitCode: 1, message: `failed reading managed items from --root ${root}: ${err.message}` };
  }

  // AGENTS.md's destination depends on consumer repository state, exactly as in
  // tools/ldl-init — see docs/consumer-contract.md, "The AGENTS.md special case".
  let derivedAgents;
  try {
    derivedAgents = deriveConsumerAgents(readFileSync(join(root, "AGENTS.md"), "utf8"));
  } catch (err) {
    return { exitCode: 1, message: `failed deriving consumer AGENTS.md: ${err.message}` };
  }
  const agentsAlreadyManaged = parsedManifest.files.some((f) => f.dest === "AGENTS.md");
  const destAgentsExists = existsSync(join(destRoot, "AGENTS.md"));
  const agentsDestRel = !destAgentsExists || agentsAlreadyManaged ? "AGENTS.md" : ".ldl/AGENTS.template.md";
  ops.push({ destRel: agentsDestRel, content: Buffer.from(derivedAgents, "utf8") });

  const { toInstall, toSkip, conflicts, unchangedFiles } = planUpdate({ ops, destRoot, existingManifest: parsedManifest });

  if (conflicts.length > 0) {
    const detail = conflicts.map((c) => `${c.dest} (${c.reason})`).join("; ");
    return {
      exitCode: 1,
      message: `Refusing to update: ${conflicts.length} LDL-managed file(s) cannot be safely reconciled: ${detail}`,
    };
  }

  if (toInstall.length === 0) {
    // Nothing to write and nothing to reconcile: a predictable no-op. Leave
    // .ldl/manifest.json and every managed file completely untouched.
    return {
      exitCode: 0,
      message: JSON.stringify({
        updated: 0,
        skipped: toSkip.length,
        revision: parsedManifest.ldlSourceRevision,
        noop: true,
      }),
    };
  }

  // If a prior run parked the derived template at .ldl/AGENTS.template.md (because the
  // consumer had its own AGENTS.md at the time) and this run is now installing straight to
  // AGENTS.md instead (the consumer's own file is gone since), the old template is
  // superseded — remove it so it doesn't linger on disk unrecorded by the new manifest.
  const previousTemplateFile = parsedManifest.files.some((f) => f.dest === ".ldl/AGENTS.template.md");
  if (agentsDestRel === "AGENTS.md" && previousTemplateFile) {
    const staleTemplatePath = join(destRoot, ".ldl", "AGENTS.template.md");
    if (existsSync(staleTemplatePath)) {
      rmSync(staleTemplatePath);
    }
  }

  const installedFiles = applyInstall(toInstall, destRoot);

  // A previously recorded managed path this revision's ops no longer cover (e.g. dropped
  // from MANAGED_ITEMS upstream) is left untouched on disk and kept recorded as-is, rather
  // than silently deleted or dropped from provenance — this mechanism only ever installs or
  // safely refuses, never removes.
  const coveredDests = new Set(ops.map((op) => op.destRel));
  const carriedOverFiles = parsedManifest.files.filter((f) => !coveredDests.has(f.dest));

  const files = [...installedFiles, ...unchangedFiles, ...carriedOverFiles].sort((a, b) => a.dest.localeCompare(b.dest));

  const manifest = {
    schemaVersion: 1,
    ldlSourceRevision: resolveRevisionImpl(root),
    installedAt: now(),
    files,
    skipped: toSkip,
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  return {
    exitCode: 0,
    message: JSON.stringify({
      updated: installedFiles.length,
      skipped: toSkip.length,
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
