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
//   1. Rebuilds the exact same target ops tools/ldl-init would (MANAGED_ITEMS content plus
//      the two BRIDGE_FILES entries — derived AGENTS.md and copied CLAUDE.md), from --root.
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
//      A managed path replaced locally by a symlink or a blocking non-directory is also a
//      conflict, not a silent skip — the same as a content edit or a deletion.
//      A previously LDL-managed bridge template (.ldl/AGENTS.template.md or
//      .ldl/CLAUDE.template.md) that this run's bridge-relocation logic would supersede gets
//      the same hash check before removal, so a locally edited template is refused rather
//      than silently discarded.
//   3. If any conflict is found, the whole run refuses to write anything and reports every
//      conflicting path and reason — fails safely rather than discarding either version,
//      partially applying only the safe subset, or guessing which side wins.
//   4. Otherwise, if there is nothing to install, no template to supersede, no change to the
//      recorded `skipped` set, and no change to the recorded `pendingManualIntegration` set,
//      the run is a no-op: it does not touch .ldl/manifest.json or any managed file at all.
//   5. Otherwise, it writes every changed/newly-added managed path and rewrites
//      .ldl/manifest.json with the new source revision, a fresh install timestamp, and the
//      full resulting set of managed paths (including ones that already matched and so
//      needed no write, and any previously recorded managed path this revision's ops no
//      longer cover, left untouched and still recorded) and the current `skipped` set.
//
// Tests: node --test tools/ldl-update/index.test.mjs

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildOps,
  contentMatchesHash,
  defaultResolveRevision,
  derivePendingManualIntegration,
  findUnsafeDestReason,
  findUnsafeLdlDirReason,
  isValidManifest,
  parseArgs,
  planBridges,
  sha256,
  withResolvedBridgesManaged,
} from "../ldl-init/index.mjs";

export { contentMatchesHash };

export { parseArgs };

const LDL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Order-independent comparison of two `skipped` entry lists by dest+reason, used to decide
// whether a newly computed skip set differs from what the existing manifest already
// recorded — a run that finds nothing new to skip is still a true no-op. Compares each entry
// as a [dest, reason] pair via JSON.stringify rather than joining into one delimited string,
// so no delimiter choice can ever be ambiguous against arbitrary dest/reason text.
// Exported so tools/mcp-server/status.mjs can replicate this exact no-op determination in a
// read-only status check, instead of re-implementing its own skip-set comparison.
export function skipListsEqual(a, b) {
  const normalize = (list) =>
    JSON.stringify(
      list
        .map((s) => [s.dest, s.reason])
        .sort((x, y) => (x[0] === y[0] ? x[1].localeCompare(y[1]) : x[0].localeCompare(y[0]))),
    );
  return normalize(a) === normalize(b);
}

// Same order-independent comparison as skipListsEqual, applied to `pendingManualIntegration`
// entries instead: lets a run whose set of bridge files awaiting manual merge hasn't changed
// still count as a true no-op, without a bespoke third comparison for a third array shape.
// Exported so tools/mcp-server/status.mjs can replicate this exact determination.
export function pendingIntegrationListsEqual(a, b) {
  const normalize = (list) =>
    JSON.stringify(
      list.map((p) => [p.dest, p.template, p.reason]).sort((x, y) => (x[0] === y[0] ? x[1].localeCompare(y[1]) : x[0].localeCompare(y[0]))),
    );
  return normalize(a) === normalize(b);
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
    const recordedHash = recordedByDest.get(op.destRel);
    const unsafeReason = findUnsafeDestReason(destRoot, op.destRel);
    if (unsafeReason) {
      // A path recorded as LDL-managed that is now unsafe to write through (replaced by a
      // symlink, or blocked by a non-directory) was tampered with locally, not merely left
      // alone by a fresh install — that is a conflict, not a skip, or the whole-run refusal
      // guarantee below could be silently bypassed by turning a managed file into a symlink.
      if (recordedHash !== undefined) {
        conflicts.push({
          dest: op.destRel,
          reason: `${unsafeReason} — this path was previously LDL-managed and is not safe to update`,
        });
      } else {
        toSkip.push({ dest: op.destRel, reason: unsafeReason });
      }
      continue;
    }

    const absDest = join(destRoot, op.destRel);
    const targetHash = sha256(op.content);

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

    // contentMatchesHash tolerates a CRLF/CR-only difference (issue #146) so a checkout-only
    // line-ending change — the consumer's own core.autocrlf converting an LF-installed file
    // to CRLF, or vice versa — is never misreported as either a conflict or a missed update,
    // while a genuine content edit still fails every comparison below.
    const currentRaw = readFileSync(absDest);

    if (contentMatchesHash(currentRaw, targetHash)) {
      unchangedFiles.push({ dest: op.destRel, sha256: targetHash });
    } else if (contentMatchesHash(currentRaw, recordedHash)) {
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

  // AGENTS.md and CLAUDE.md each have a destination that depends on consumer repository
  // state, exactly as in tools/ldl-init — see docs/consumer-contract.md, "The AGENTS.md and
  // CLAUDE.md special case".
  let bridgePlans, bridgeOps, resolvedManifestPatch;
  try {
    ({ bridgePlans, bridgeOps, resolvedManifestPatch } = planBridges({ root, destRoot, existingManifest: parsedManifest }));
  } catch (err) {
    return { exitCode: 1, message: `failed deriving consumer bridge file: ${err.message}` };
  }
  ops.push(...bridgeOps);

  // Bridges planBridgeOp resolved by content match (see its own comment) must be treated as
  // LDL-managed by planUpdate's own ownership check even though parsedManifest doesn't yet
  // record them. Only affects this local copy passed to planUpdate; parsedManifest itself
  // (already consulted above, and read again below for the template-supersession check) is
  // left untouched.
  const { toInstall, toSkip, conflicts, unchangedFiles } = planUpdate({
    ops,
    destRoot,
    existingManifest: withResolvedBridgesManaged(parsedManifest, resolvedManifestPatch),
  });

  // If a prior run parked a bridge's derived/copied content at its templateDestRel (because
  // the consumer had its own same-named file at the time) and this run is now installing
  // straight to the bridge's own destRel instead (the consumer's own file is gone since), the
  // old template is superseded. It isn't part of `ops` (its own destination is now the
  // bridge's root path), so it needs its own checks here, mirroring exactly what planUpdate()
  // does for every other previously-managed destination: a path replaced by a symlink or a
  // blocking non-directory is a conflict regardless of what content it resolves to (Stage 2
  // audit finding on PR #131 — reading a symlinked template's target via existsSync/readFileSync
  // without this check first could hash-match a tampered path and misclassify a locally
  // replaced managed path as safely superseded); otherwise an untouched template is safe to
  // remove, but a locally edited one is a conflict just like any other managed file — deleting
  // it unconditionally would silently discard a local edit the conflict-safe guarantee exists
  // to protect.
  const supersededTemplates = [];
  for (const { bridge, op } of bridgePlans) {
    const previousTemplateEntry = parsedManifest.files.find((f) => f.dest === bridge.templateDestRel);
    if (op.destRel !== bridge.destRel || !previousTemplateEntry) continue;
    const unsafeTemplateReason = findUnsafeDestReason(destRoot, bridge.templateDestRel);
    if (unsafeTemplateReason) {
      conflicts.push({
        dest: bridge.templateDestRel,
        reason: `${unsafeTemplateReason} — this path was previously LDL-managed and is not safe to update`,
      });
      continue;
    }
    const staleTemplatePath = join(destRoot, ...bridge.templateDestRel.split("/"));
    if (!existsSync(staleTemplatePath)) {
      supersededTemplates.push(bridge.templateDestRel); // already gone; just drop the stale manifest record
    } else if (contentMatchesHash(readFileSync(staleTemplatePath), previousTemplateEntry.sha256)) {
      supersededTemplates.push(bridge.templateDestRel);
    } else {
      conflicts.push({
        dest: bridge.templateDestRel,
        reason: `locally modified since install and now superseded by ${bridge.destRel} — refusing to discard the local edit`,
      });
    }
  }

  if (conflicts.length > 0) {
    const detail = conflicts.map((c) => `${c.dest} (${c.reason})`).join("; ");
    return {
      exitCode: 1,
      message: `Refusing to update: ${conflicts.length} LDL-managed file(s) cannot be safely reconciled: ${detail}`,
    };
  }

  // Computed from the actual toInstall/toSkip outcome, not merely from planBridgeOp's
  // destination choice — see derivePendingManualIntegration's own comment for why a
  // destRel-only check would miss an uninstalled bridge.
  const pendingManualIntegration = derivePendingManualIntegration(bridgePlans, toSkip);

  // A skip is worth recording even when no managed file's content changed — e.g. a newer
  // MANAGED_ITEMS destination collides with a pre-existing unmanaged consumer file. Compare
  // against what the existing manifest already recorded so a run that finds nothing new
  // still counts as a true no-op instead of rewriting the manifest every time for no reason.
  const skipSetChanged = !skipListsEqual(toSkip, parsedManifest.skipped || []);
  // Same no-op guard, applied to the set of bridge files still awaiting manual merge: a run
  // that finds the same unresolved set as before must not rewrite the manifest just to say so
  // again, but a genuinely changed set (a new bridge parked, one just resolved, or one that
  // newly failed to install) does need to be recorded, even when no managed file content
  // itself changed.
  const pendingIntegrationChanged = !pendingIntegrationListsEqual(pendingManualIntegration, parsedManifest.pendingManualIntegration || []);

  if (toInstall.length === 0 && supersededTemplates.length === 0 && !skipSetChanged && !pendingIntegrationChanged) {
    // Nothing to write and nothing to reconcile: a predictable no-op. Leave
    // .ldl/manifest.json and every managed file completely untouched.
    return {
      exitCode: 0,
      message: JSON.stringify({
        updated: 0,
        skipped: toSkip.length,
        manualIntegrationNeeded: pendingManualIntegration.length,
        revision: parsedManifest.ldlSourceRevision,
        noop: true,
      }),
    };
  }

  for (const templateDestRel of supersededTemplates) {
    const staleTemplatePath = join(destRoot, ...templateDestRel.split("/"));
    if (existsSync(staleTemplatePath)) {
      rmSync(staleTemplatePath);
    }
  }

  const installedFiles = applyInstall(toInstall, destRoot);

  // A previously recorded managed path this revision's ops no longer cover (e.g. dropped
  // from MANAGED_ITEMS upstream) is left untouched on disk and kept recorded as-is, rather
  // than silently deleted or dropped from provenance — this mechanism only ever installs or
  // safely refuses, never removes. A superseded template is excluded here since it was just
  // deleted above (or was already gone), so it must not be carried over as a stale record.
  const coveredDests = new Set(ops.map((op) => op.destRel));
  for (const templateDestRel of supersededTemplates) coveredDests.add(templateDestRel);
  const carriedOverFiles = parsedManifest.files.filter((f) => !coveredDests.has(f.dest));

  const files = [...installedFiles, ...unchangedFiles, ...carriedOverFiles].sort((a, b) => a.dest.localeCompare(b.dest));

  const manifest = {
    schemaVersion: 1,
    ldlSourceRevision: resolveRevisionImpl(root),
    installedAt: now(),
    files,
    skipped: toSkip,
    pendingManualIntegration,
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  return {
    exitCode: 0,
    message: JSON.stringify({
      updated: installedFiles.length,
      skipped: toSkip.length,
      manualIntegrationNeeded: manifest.pendingManualIntegration.length,
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

// Only run as a CLI when this exact file is the process entrypoint — see the matching
// guard in tools/ldl-init/index.mjs for why a suffix check on argv[1] is unsafe here too.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
