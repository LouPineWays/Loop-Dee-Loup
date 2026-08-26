#!/usr/bin/env node
// Deterministic, ownership-preserving manual-integration acknowledgement mechanism for issue
// #153: records a durable attestation that the *current* LDL bridge target for `AGENTS.md` or
// `CLAUDE.md` has been merged by hand into a consumer-owned root file, without requiring that
// file to become byte-for-byte identical to LDL's template and without claiming it as an
// LDL-managed path. See docs/consumer-contract.md, "Two reconciliation modes for a parked
// bridge", and tools/ldl-init/index.mjs's planAcknowledgeIntegration (the shared primitive this
// script and tools/mcp-server both call into) for the full ownership-boundary rationale.
//
// Usage (run from a local clone of Loop-Dee-Loup, against an already-`tools/ldl-init`-
// bootstrapped consumer repository):
//   node tools/ldl-ack/index.mjs --dest <path-to-consumer-repo> --bridge <AGENTS.md|CLAUDE.md>
//
// --dest must already have a valid .ldl/manifest.json — this mechanism has nothing to
// acknowledge against otherwise. --bridge must name exactly one BRIDGE_FILES destination
// ("AGENTS.md" or "CLAUDE.md"); acknowledging one bridge never affects the other. --root
// overrides the Loop-Dee-Loup source root (defaults to this script's own repository) and
// exists mainly so tests can point at a disposable fixture instead of this repository's real,
// changing content.
//
// What it does:
//   1. Refuses (fails closed, writes nothing) unless the named bridge is *currently* parked at
//      its template path given --root's present bridge content and --dest's present state —
//      i.e. there is a genuine pending manual integration to acknowledge right now. See
//      planAcknowledgeIntegration's own comment for the complete list of refusal conditions
//      (unknown bridge name, no manifest, already resolved, missing/unsafe template or
//      destination).
//   2. Records the acknowledgement in `.ldl/manifest.json`'s `manualIntegrationAcknowledgements`
//      array, bound to the sha256 of the bridge's *current* target content — never a timeless
//      boolean — so a later change to that bridge's target content (a newer Loop-Dee-Loup
//      revision that actually edits AGENTS.md/CLAUDE.md) makes the bridge pending again on the
//      next `tools/ldl-init`/`tools/ldl-update`/`ldl_status` run, automatically.
//   3. Recomputes and rewrites `pendingManualIntegration` in the same manifest write, using the
//      exact same derivePendingManualIntegration() tools/ldl-update and
//      tools/mcp-server/status.mjs use, so every surface agrees immediately — not only after the
//      next update run.
//   4. Never adds the acknowledged bridge's destination (`AGENTS.md` or `CLAUDE.md`) to the
//      manifest's `files[]` set: the destination remains fully consumer-owned. Every other
//      manifest field (`files`, `skipped`, `ldlSourceRevision`, `installedAt`) is left exactly
//      as it was — this mechanism only ever touches `pendingManualIntegration` and
//      `manualIntegrationAcknowledgements`.
//
// Tests: node --test tools/ldl-ack/index.test.mjs

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildOps,
  derivePendingManualIntegration,
  findUnsafeLdlDirReason,
  isValidManifest,
  parseArgs,
  planAcknowledgeIntegration,
  planBridges,
  withResolvedBridgesManaged,
} from "../ldl-init/index.mjs";
import { planUpdate } from "../ldl-update/index.mjs";

export { parseArgs };

const LDL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// `now` is injected so tests get deterministic manifest output without depending on this
// process's own wall-clock time, matching the pattern tools/ldl-init and tools/ldl-update use
// for `now`/`resolveRevisionImpl`. `beforeWrite` is injected by tools/mcp-server (issue #153,
// Stage 1 review finding on PR #159) so its own process-coherence guard (see
// docs/mcp-server.md's "Process coherence") can be rechecked immediately before the manifest
// write below, after this function's own read-heavy planning (buildOps, planBridges,
// planUpdate) has run — not only once at MCP tool-call entry. Must return a non-empty message
// string to abort the write, or a falsy value to proceed; defaults to a no-op for the plain CLI,
// which has no such long-lived-process staleness hazard to guard against.
export async function run(args, deps = {}) {
  const { now = () => new Date().toISOString(), beforeWrite = () => null } = deps;

  if (!args.dest) {
    return { exitCode: 1, message: "Missing required arg: --dest <path-to-consumer-repo>" };
  }
  if (!args.bridge) {
    return { exitCode: 1, message: "Missing required arg: --bridge <AGENTS.md|CLAUDE.md>" };
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
      message: "No .ldl/manifest.json found in --dest — run tools/ldl-init first; there is nothing to acknowledge.",
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
      message: "existing .ldl/manifest.json is not in the expected shape — run tools/ldl-init to reinitialize before acknowledging.",
    };
  }

  const plan = planAcknowledgeIntegration({ bridgeDestRel: args.bridge, root, destRoot, existingManifest: parsedManifest });
  if (!plan.ok) {
    return { exitCode: 1, message: `Refusing to acknowledge: ${plan.reason}` };
  }

  // Upsert: replace any prior acknowledgement for this exact bridge, leave every other
  // bridge's own acknowledgement (or lack of one) untouched — issue #153 requirement "one
  // bridge is acknowledged while the other remains pending".
  const manualIntegrationAcknowledgements = [
    ...(parsedManifest.manualIntegrationAcknowledgements || []).filter((a) => a.dest !== plan.dest),
    { dest: plan.dest, template: plan.template, acknowledgedTargetSha256: plan.acknowledgedTargetSha256, acknowledgedAt: now() },
  ];

  // Recompute pendingManualIntegration the exact same way tools/ldl-update and
  // tools/mcp-server/status.mjs would, so the manifest's own stored field is never stale —
  // issue #153 requirement 5 (every surface must agree). This never installs or writes any
  // managed file; it only reads current --root/--dest state to feed the same shared planning
  // functions those other tools already use.
  let ops;
  try {
    ops = buildOps(root);
  } catch (err) {
    return { exitCode: 1, message: `failed reading managed items from --root ${root}: ${err.message}` };
  }
  const { bridgePlans, bridgeOps, resolvedManifestPatch } = planBridges({ root, destRoot, existingManifest: parsedManifest });
  ops.push(...bridgeOps);
  const { toSkip } = planUpdate({
    ops,
    destRoot,
    existingManifest: withResolvedBridgesManaged(parsedManifest, resolvedManifestPatch),
  });
  const pendingManualIntegration = derivePendingManualIntegration(bridgePlans, toSkip, manualIntegrationAcknowledgements);

  // Every other field — files, skipped, ldlSourceRevision, installedAt — is carried forward
  // completely unchanged: acknowledging a manual integration is not an install or an update,
  // and must not touch anything this mechanism doesn't own (issue #153 requirement 3).
  const manifest = {
    ...parsedManifest,
    pendingManualIntegration,
    manualIntegrationAcknowledgements,
  };

  // Rechecked here, immediately before the actual write and after every read-heavy planning
  // step above — mirrors tools/mcp-server/server.mjs's own ldl_update pre-mutation recheck, so
  // this newly exposed mutating tool gets the same narrowed-race guarantee (issue #153, Stage 1
  // review finding on PR #159).
  const staleness = beforeWrite();
  if (staleness) {
    return { exitCode: 1, message: staleness };
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  return {
    exitCode: 0,
    message: JSON.stringify({
      acknowledged: plan.dest,
      template: plan.template,
      manualIntegrationNeeded: pendingManualIntegration.length,
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

// Only run as a CLI when this exact file is the process entrypoint — see the matching guard in
// tools/ldl-init/index.mjs for why a suffix check on argv[1] is unsafe here too.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
