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
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run as ldlInitRun } from "../ldl-init/index.mjs";
import { run as ldlUpdateRun } from "../ldl-update/index.mjs";
import { computeStatusAll } from "./status.mjs";
import { resolvePathArg, resolveRepos } from "./config.mjs";

export const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
      "is already current. Identical to running tools/ldl-update/index.mjs directly.",
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const root = resolvePathArg(args.root) || rootOverride || DEFAULT_ROOT;

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
        const result = await ldlInitRun({ dest: resolvePathArg(args.dest), root });
        return cliResult(result);
      }

      if (name === "ldl_update") {
        if (!args.dest) return errorResult("Missing required argument: dest");
        const result = await ldlUpdateRun({ dest: resolvePathArg(args.dest), root });
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
