// Integration tests for tools/mcp-server/server.mjs. Exercises the actual MCP protocol
// surface (tools/list, tools/call), not just the underlying status.mjs / ldl-init / ldl-update
// functions status.test.mjs already covers directly.
//
// Most tests drive createServer() over an in-process InMemoryTransport pair (fast, no
// subprocess). One smoke test spawns the real `node server.mjs` entrypoint over its actual
// stdio transport, proving the CLI-facing process the issue asks for actually boots and
// speaks MCP end-to-end (issue #110 verification item 1).
//
// Run with: node --test tools/mcp-server/server.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MANAGED_ITEMS, run as ldlInit } from "../ldl-init/index.mjs";
import { createServer } from "./server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(HERE, "server.mjs");

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ldl-mcp-server-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Same fixture convention as status.test.mjs / tools/ldl-update/index.test.mjs.
function makeFixtureRoot(t, revisionTag) {
  const root = tempDir(t);
  for (const item of MANAGED_ITEMS) {
    const absSrc = join(root, item.src);
    if (item.kind === "file") {
      mkdirSync(dirname(absSrc), { recursive: true });
      writeFileSync(absSrc, `fixture content (${revisionTag}): ${item.src}\n`);
    } else {
      mkdirSync(absSrc, { recursive: true });
      writeFileSync(join(absSrc, "SKILL.md"), `fixture content (${revisionTag}): ${item.src}/SKILL.md\n`);
      writeFileSync(join(absSrc, "extra.md"), `fixture content (${revisionTag}): ${item.src}/extra.md\n`);
    }
  }
  writeFileSync(join(root, "AGENTS.md"), `# Agent operating contract\n\nGeneric rule (${revisionTag}).\n`);
  return root;
}

async function connectedClient(t) {
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(() => client.close());
  return client;
}

function toolJson(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

test("tools/list advertises exactly the three bounded LDL tools", async (t) => {
  const client = await connectedClient(t);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["ldl_init", "ldl_status", "ldl_update"]);
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 0, `${tool.name} must have a description`);
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("ldl_status on an uninitialized repo reports not_initialized via the protocol", async (t) => {
  const client = await connectedClient(t);
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);

  const result = await client.callTool({ name: "ldl_status", arguments: { repos: [dest], root } });
  assert.equal(result.isError, false);
  const [status] = toolJson(result);
  assert.equal(status.status, "not_initialized");
  assert.equal(status.next, "ldl_init");
});

test("ldl_status with no repos and no LDL_CONSUMER_REPOS is a clean protocol error, not a crash", async (t) => {
  const client = await connectedClient(t);
  const previous = process.env.LDL_CONSUMER_REPOS;
  delete process.env.LDL_CONSUMER_REPOS;
  t.after(() => {
    if (previous !== undefined) process.env.LDL_CONSUMER_REPOS = previous;
  });

  const result = await client.callTool({ name: "ldl_status", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /LDL_CONSUMER_REPOS/);
});

test("ldl_init then ldl_status then ldl_update: full lifecycle through the protocol", async (t) => {
  const client = await connectedClient(t);
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);

  const initResult = await client.callTool({ name: "ldl_init", arguments: { dest, root: rootV1 } });
  assert.equal(initResult.isError, false);
  const initPayload = JSON.parse(initResult.content[0].text);
  assert.ok(initPayload.installed > 0);

  const statusAfterInit = toolJson(await client.callTool({ name: "ldl_status", arguments: { repos: [dest], root: rootV1 } }));
  assert.equal(statusAfterInit[0].status, "current");

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const statusOutdated = toolJson(await client.callTool({ name: "ldl_status", arguments: { repos: [dest], root: rootV2 } }));
  assert.equal(statusOutdated[0].status, "outdated");
  assert.equal(statusOutdated[0].next, "ldl_update");

  const updateResult = await client.callTool({ name: "ldl_update", arguments: { dest, root: rootV2 } });
  assert.equal(updateResult.isError, false);
  const updatePayload = JSON.parse(updateResult.content[0].text);
  assert.ok(updatePayload.updated > 0);

  const statusAfterUpdate = toolJson(await client.callTool({ name: "ldl_status", arguments: { repos: [dest], root: rootV2 } }));
  assert.equal(statusAfterUpdate[0].status, "current");

  // Re-running the update against an already-current repo is a protocol-visible no-op, not
  // an error — matches tools/ldl-update's own CLI no-op semantics.
  const noopResult = await client.callTool({ name: "ldl_update", arguments: { dest, root: rootV2 } });
  assert.equal(noopResult.isError, false);
  const noopPayload = JSON.parse(noopResult.content[0].text);
  assert.equal(noopPayload.noop, true);
});

test("ldl_update fails closed through the protocol when a managed file was locally modified", async (t) => {
  const client = await connectedClient(t);
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await ldlInit({ dest, root: rootV1 });

  writeFileSync(join(dest, "docs", "operating-model.md"), "locally hand-edited, must not be overwritten\n");

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const updateResult = await client.callTool({ name: "ldl_update", arguments: { dest, root: rootV2 } });
  assert.equal(updateResult.isError, true);
  assert.match(updateResult.content[0].text, /Refusing to update/);

  const content = readFileSync(join(dest, "docs", "operating-model.md"), "utf8");
  assert.equal(content, "locally hand-edited, must not be overwritten\n");
});

test("ldl_init/ldl_update refuse a dest that does not exist, through the protocol", async (t) => {
  const client = await connectedClient(t);
  const root = makeFixtureRoot(t, "rev-1");
  const missing = join(tempDir(t), "does-not-exist");

  const initResult = await client.callTool({ name: "ldl_init", arguments: { dest: missing, root } });
  assert.equal(initResult.isError, true);
  assert.match(initResult.content[0].text, /does not exist/);

  const updateResult = await client.callTool({ name: "ldl_update", arguments: { dest: missing, root } });
  assert.equal(updateResult.isError, true);
  assert.match(updateResult.content[0].text, /does not exist/);
});

test("ldl_status reports each repository in a mixed batch independently in one call", async (t) => {
  const client = await connectedClient(t);
  const root = makeFixtureRoot(t, "rev-1");
  const current = tempDir(t);
  await ldlInit({ dest: current, root });
  const uninitialized = tempDir(t);
  const missing = join(tempDir(t), "does-not-exist");

  const result = await client.callTool({ name: "ldl_status", arguments: { repos: [current, uninitialized, missing], root } });
  assert.equal(result.isError, true); // one repo in the batch errored
  const statuses = toolJson(result);
  assert.equal(statuses[0].status, "current");
  assert.equal(statuses[1].status, "not_initialized");
  assert.equal(statuses[2].status, "error");
});

test("smoke: the real `node server.mjs` process boots and speaks MCP over real stdio", async (t) => {
  const client = new Client({ name: "smoke-test-client", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH] });
  await client.connect(transport);
  t.after(() => client.close());

  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "ldl_status"));

  // No `root` argument: exercises the real DEFAULT_ROOT (this actual Loop-Dee-Loup checkout),
  // against a disposable dest so nothing here touches the repository's own working tree.
  const root = undefined;
  const dest = mkdtempSync(join(tmpdir(), "ldl-mcp-server-smoke-"));
  t.after(() => rmSync(dest, { recursive: true, force: true }));

  const result = await client.callTool({ name: "ldl_status", arguments: { repos: [dest] } });
  assert.equal(result.isError, false);
  const [status] = JSON.parse(result.content[0].text);
  assert.equal(status.status, "not_initialized");
  assert.ok(status.sourceRevision && status.sourceRevision !== "unknown");
});
