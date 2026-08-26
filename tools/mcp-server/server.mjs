#!/usr/bin/env node
// Local-first LDL MCP server for issue #110: lets an MCP-compatible coding agent working in
// a consumer repository determine whether its installed LDL machinery is current and safely
// bring it into alignment with this Loop-Dee-Loup checkout, without reasoning over
// .ldl/manifest.json by hand.
//
// This file is an interface/coordination layer only. It does not reimplement bootstrap,
// update, or conflict-detection logic — every tool below calls straight into
// tools/ldl-init/index.mjs, tools/ldl-update/index.mjs, and ./status.mjs, which themselves
// call into ldl-init/ldl-update's exported primitives. See docs/mcp-server.md.
//
// Usage: node tools/mcp-server/server.mjs   (stdio transport; run from an LDL checkout)
// Tests: node --test tools/mcp-server/*.test.mjs

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run as ldlInitRun } from "../ldl-init/index.mjs";
import { run as ldlUpdateRun } from "../ldl-update/index.mjs";
import { run as ldlAckRun } from "../ldl-ack/index.mjs";
import { computeStatusAll, computeUpdatePlan } from "./status.mjs";
import { resolvePathArg, resolveRepos } from "./config.mjs";
import { implementationFingerprint } from "./staleness.mjs";

// LDL_MCP_ROOT overrides which Loop-Dee-Loup checkout this server treats as its own backing
// checkout — the one its static imports above actually came from. Real deployments never set
// it (DEFAULT_ROOT is this file's own location, which is what it should be); it exists so a
// test can point a real, unmodified `node server.mjs` process at a disposable fixture
// directory it controls, including mutating that fixture's files after the process has
// already started — see server.test.mjs's process-coherence test and issue #146.
export const DEFAULT_ROOT = process.env.LDL_MCP_ROOT
  ? resolve(process.env.LDL_MCP_ROOT)
  : join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const TOOLS = [
  {
    name: "ldl_status",
    description:
      "Report deterministic LDL synchronization status for one or more consumer repositories: " +
      "initialized/current/outdated/conflict, installed vs. canonical revision, managed/skipped " +
      "file counts, any conflicts, and a recommended next action (ldl_init, ldl_update, or none). " +
      "Read-only — never writes anything. Cheap enough to call for a whole known repository set " +
      "in one call.",
    inputSchema: {
      type: "object",
      properties: {
        repos: {
          type: "array",
          items: { type: "string" },
          description:
            "Absolute (or cwd-relative) paths to consumer repositories to check. If omitted, " +
            "falls back to the LDL_CONSUMER_REPOS environment variable (a path.delimiter-separated " +
            "list — ';' on Windows, ':' elsewhere).",
        },
        root: {
          type: "string",
          description: "Path to a Loop-Dee-Loup source checkout. Defaults to this server's own checkout.",
        },
      },
    },
  },
  {
    name: "ldl_init",
    description:
      "Bootstrap Loop-Dee-Loup machinery into a consumer repository that has no valid " +
      ".ldl/manifest.json yet. Safe against a non-empty repository: never overwrites a path that " +
      "already exists and isn't LDL-managed; such paths are skipped and reported, not silently " +
      "clobbered. Identical to running tools/ldl-init/index.mjs directly.",
    inputSchema: {
      type: "object",
      properties: {
        dest: { type: "string", description: "Path to the consumer repository to initialize. Must already exist." },
        root: {
          type: "string",
          description: "Path to a Loop-Dee-Loup source checkout. Defaults to this server's own checkout.",
        },
      },
      required: ["dest"],
    },
  },
  {
    name: "ldl_update",
    description:
      "Conflict-safe update of an already-initialized consumer repository to this Loop-Dee-Loup " +
      "checkout's current revision. Refuses the entire update (fails closed, writes nothing) if any " +
      "LDL-managed file was locally modified or deleted since install. A no-op when the repository " +
      "is already current. Applies the exact same synchronization tools/ldl-update/index.mjs's CLI " +
      "uses, and additionally reports compact structured evidence of what changed: previous " +
      "revision, resulting revision, the changed and skipped path lists, and any conflicts.",
    inputSchema: {
      type: "object",
      properties: {
        dest: { type: "string", description: "Path to the already-initialized consumer repository to update." },
        root: {
          type: "string",
          description: "Path to a Loop-Dee-Loup source checkout. Defaults to this server's own checkout.",
        },
      },
      required: ["dest"],
    },
  },
  {
    name: "ldl_acknowledge_integration",
    description:
      "Record a durable, ownership-preserving attestation that the CURRENT LDL bridge target " +
      "for AGENTS.md or CLAUDE.md has been manually merged into the consumer-owned root file it " +
      "was parked next to, without requiring that file to become byte-for-byte identical to " +
      "LDL's template and without adding it to LDL's managed files[] set — the destination " +
      "remains fully consumer-owned. Clears pendingManualIntegration for that bridge only while " +
      "its target content stays what was acknowledged; the moment a later Loop-Dee-Loup revision " +
      "actually changes that bridge's content, the bridge reports pending again automatically. " +
      "Refuses (writes nothing) when there is no current pending manual integration for the " +
      "named bridge, the bridge name is invalid, or the destination/template state is missing " +
      "or unsafe. Does not touch AGENTS.md/CLAUDE.md or any other managed file — this is a " +
      "manifest-only attestation, not an install or update.",
    inputSchema: {
      type: "object",
      properties: {
        dest: { type: "string", description: "Path to the already-initialized consumer repository." },
        bridge: {
          type: "string",
          enum: ["AGENTS.md", "CLAUDE.md"],
          description: "Which bridge file's current manual integration to acknowledge.",
        },
        root: {
          type: "string",
          description: "Path to a Loop-Dee-Loup source checkout. Defaults to this server's own checkout.",
        },
      },
      required: ["dest", "bridge"],
    },
  },
];

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError };
}

function errorResult(message) {
  return textResult({ error: message }, true);
}

// Wraps a CLI-style {exitCode, message} result (what tools/ldl-init and tools/ldl-update's
// run() both return) as an MCP tool result without altering their message text — the model
// sees the exact same compact JSON a CLI caller would.
function cliResult({ exitCode, message }) {
  return textResult(message, exitCode !== 0);
}

export function createServer({ root: rootOverride } = {}) {
  const server = new Server(
    { name: "ldl-mcp-server", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // The checkout this server's own code was actually loaded from — not `args.root`, which a
  // caller may point at an entirely different LDL checkout per-call and which has never
  // determined which *code* executes, only which source content that code reads. Pre-seeded
  // once, here, at server-construction time (main() constructs exactly one server per
  // process), so it reflects the checkout state at the moment the static imports above
  // resolved. See ./staleness.mjs and issue #146.
  const backingRoot = rootOverride || DEFAULT_ROOT;

  // Per-root coherence baselines (Codex P1 finding on PR #147): a caller may legitimately
  // point ldl_status/ldl_init/ldl_update at a *different* checkout than backingRoot via
  // `args.root` — the tool schemas document exactly this. A single backingRoot-only baseline
  // left that path uncovered: a non-default root's own implementation files could drift
  // mid-process-lifetime with no check catching it at all. The first call this process ever
  // makes against a given root establishes that root's baseline (mirroring how backingRoot's
  // own baseline is simply "whatever was on disk when this process started" — there is no
  // earlier signal to compare against for either); every later call against that same root is
  // then checked against it, so a root's implementation drifting while this process keeps
  // running and using it is always caught, regardless of which root that is.
  const implementationBaselines = new Map([[backingRoot, implementationFingerprint(backingRoot)]]);

  // True the moment `effectiveRoot`'s implementation files no longer match the baseline this
  // process already trusted them at (establishing that baseline on the first-ever check against
  // a given root), false when coherent. Split out from checkCoherence() below (issue #153) so
  // ldl_acknowledge_integration's own write-boundary recheck (see its dispatch below — Stage 1
  // review finding on PR #159) can get a plain boolean to fold into tools/ldl-ack's own
  // {exitCode, message} result, instead of an MCP-shaped error result it would have to unwrap.
  function isStale(effectiveRoot) {
    const current = implementationFingerprint(effectiveRoot);
    const baseline = implementationBaselines.get(effectiveRoot);
    if (baseline === undefined) {
      implementationBaselines.set(effectiveRoot, current);
      return false;
    }
    return current !== baseline;
  }

  function stalenessMessage(effectiveRoot) {
    return (
      `MCP server process is stale: its Loop-Dee-Loup synchronization implementation at ${effectiveRoot} ` +
      "changed on disk since this process started trusting it, so this process can no longer be trusted " +
      "to apply coherent synchronization semantics against it. Restart the MCP server process, then retry."
    );
  }

  // Returns a stale-server error result the moment `effectiveRoot`'s implementation files no
  // longer match the baseline this process already trusted them at, or null when coherent.
  // Called both once per tool call (covers the common case) and again immediately before any
  // consumer-mutating call (ldl_init/ldl_update/ldl_acknowledge_integration — Codex P2 finding on
  // PR #147: the checkout can still change mid-call, between the read-heavy planning phase and
  // the write, and a single entry-time check does not catch that narrower race).
  function checkCoherence(effectiveRoot) {
    return isStale(effectiveRoot) ? errorResult(stalenessMessage(effectiveRoot)) : null;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const root = resolvePathArg(args.root) || rootOverride || DEFAULT_ROOT;

    const entryStaleness = checkCoherence(root);
    if (entryStaleness) return entryStaleness;

    try {
      if (name === "ldl_status") {
        const repos = resolveRepos(args.repos).map((p) => resolvePathArg(p));
        if (repos.length === 0) {
          return errorResult(
            "No repositories to check: pass `repos`, or set the LDL_CONSUMER_REPOS environment variable.",
          );
        }
        const results = await computeStatusAll({ repos, root });
        return textResult(results, results.some((r) => r.status === "error"));
      }

      if (name === "ldl_init") {
        if (!args.dest) return errorResult("Missing required argument: dest");
        const preMutationStaleness = checkCoherence(root);
        if (preMutationStaleness) return preMutationStaleness;
        const result = await ldlInitRun({ dest: resolvePathArg(args.dest), root });
        return cliResult(result);
      }

      if (name === "ldl_update") {
        if (!args.dest) return errorResult("Missing required argument: dest");
        const dest = resolvePathArg(args.dest);

        // Read-only "before" plan, captured immediately ahead of the real update so its
        // toInstall/toSkip/conflicts reflect the same on-disk state run() is about to act on.
        // Never lets a failure here block the real update — worst case, the tool result below
        // just carries less evidence than usual, degrading gracefully rather than refusing an
        // update the CLI itself would still perform.
        let before;
        try {
          before = computeUpdatePlan({ dest, root });
        } catch (err) {
          before = { kind: "error", error: err.message };
        }

        // Revalidated again here, immediately before the mutating run() call and after the
        // read-heavy `before` plan above: the backing checkout can still have changed between
        // the entry-time check and this point, and this is the last moment before this
        // process would actually write into the consumer repository and stamp a revision.
        const preMutationStaleness = checkCoherence(root);
        if (preMutationStaleness) return preMutationStaleness;

        // ldl-update's run() does not itself catch every exception its internal planUpdate()
        // can raise (e.g. EISDIR when a managed file was replaced by a directory) — it can
        // reject rather than resolve with a non-zero exitCode. Caught here, not left to the
        // handler-wide catch below, so a thrown update failure still gets the same structured
        // {status, error, conflicts} shape as every other update failure, not a bare {error}.
        let result;
        try {
          result = await ldlUpdateRun({ dest, root });
        } catch (err) {
          const conflicts = before.kind === "plan" ? before.conflicts.map((c) => ({ dest: c.dest, reason: c.reason })) : [];
          return textResult({ status: "error", error: err.message, conflicts }, true);
        }

        if (result.exitCode !== 0) {
          const conflicts = before.kind === "plan" ? before.conflicts.map((c) => ({ dest: c.dest, reason: c.reason })) : [];
          return textResult({ status: "error", error: result.message, conflicts }, true);
        }

        const payload = JSON.parse(result.message);
        // A previously LDL-managed bridge template (.ldl/AGENTS.template.md or
        // .ldl/CLAUDE.template.md) that this update superseded (see tools/ldl-update/index.mjs's
        // own supersededTemplates handling) is a real deletion, not covered by `toInstall` —
        // include it explicitly so changedPaths reflects every path the update actually
        // touched, not just the ones planUpdate() itself installs.
        const changedPaths =
          before.kind === "plan" ? [...before.toInstall.map((op) => op.destRel), ...before.supersededTemplates] : [];
        return textResult(
          {
            status: payload.noop ? "current" : "updated",
            previousRevision: before.kind === "plan" ? before.parsedManifest.ldlSourceRevision : null,
            resultingRevision: payload.revision,
            changedPaths,
            skippedPaths: before.kind === "plan" ? before.toSkip.map((s) => ({ dest: s.dest, reason: s.reason })) : [],
            conflicts: [],
            pendingManualIntegration: before.kind === "plan" ? before.pendingManualIntegration : [],
            // Sourced from the real run's own payload (not the pre-update `before` snapshot) so
            // it reflects the actual outcome even in the degraded case where `before` itself
            // failed to compute — see docs/consumer-contract.md, "Unresolved manual integration
            // is never presented as full activation" (Stage 2 audit finding on PR #131: this
            // count was previously dropped from the MCP ldl_update response entirely).
            manualIntegrationNeeded: payload.manualIntegrationNeeded,
            noop: Boolean(payload.noop),
          },
          false,
        );
      }

      if (name === "ldl_acknowledge_integration") {
        if (!args.dest) return errorResult("Missing required argument: dest");
        if (!args.bridge) return errorResult("Missing required argument: bridge");
        const preMutationStaleness = checkCoherence(root);
        if (preMutationStaleness) return preMutationStaleness;
        // tools/ldl-ack's own run() does real reading (buildOps over every MANAGED_ITEMS entry,
        // planBridges, planUpdate) between this point and its actual manifest write — the same
        // read-heavy gap ldl_update's own `before` plan sits in front of. `beforeWrite` (issue
        // #153, Stage 1 review finding on PR #159) lets run() recheck coherence at its own final
        // write boundary, immediately before writeFileSync, rather than only here at call entry.
        const result = await ldlAckRun(
          { dest: resolvePathArg(args.dest), bridge: args.bridge, root },
          { beforeWrite: () => (isStale(root) ? stalenessMessage(root) : null) },
        );
        return cliResult(result);
      }

      return errorResult(`Unknown tool: ${name}`);
    } catch (err) {
      return errorResult(err.message);
    }
  });

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run as a CLI entrypoint when this exact file is the process entrypoint — same guard
// tools/ldl-init and tools/ldl-update use, so importing this module for tests never starts a
// live stdio server as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
