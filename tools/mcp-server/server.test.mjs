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
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MANAGED_ITEMS, run as ldlInit } from "../ldl-init/index.mjs";
import { createServer } from "./server.mjs";
import { IMPLEMENTATION_FILES } from "./staleness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(HERE, "server.mjs");
const REPO_ROOT = join(HERE, "..", "..");

// Copies the real, current implementation files staleness.mjs fingerprints into a fixture
// root, so a test can spawn/construct a server pointed at that fixture (a normal, coherent
// "process just started" state) and then mutate one of those copies to simulate the backing
// checkout advancing to a new revision with different synchronization behavior, without ever
// touching this repository's own real files. See issue #146's process-coherence tests below.
function copyImplementationFiles(fixtureRoot) {
  for (const relPath of IMPLEMENTATION_FILES) {
    const dest = join(fixtureRoot, ...relPath.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(REPO_ROOT, ...relPath.split("/")), dest);
  }
}

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
  writeFileSync(join(root, "CLAUDE.md"), `# Claude Code instructions\n\n@AGENTS.md\n\n(${revisionTag})\n`);
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
  assert.equal(updatePayload.status, "updated");
  assert.equal(updatePayload.noop, false);
  assert.equal(updatePayload.previousRevision, statusOutdated[0].installedRevision);
  assert.equal(updatePayload.resultingRevision, statusOutdated[0].sourceRevision);
  assert.ok(updatePayload.changedPaths.length > 0);
  assert.deepEqual(updatePayload.conflicts, []);

  const statusAfterUpdate = toolJson(await client.callTool({ name: "ldl_status", arguments: { repos: [dest], root: rootV2 } }));
  assert.equal(statusAfterUpdate[0].status, "current");

  // Re-running the update against an already-current repo is a protocol-visible no-op, not
  // an error — matches tools/ldl-update's own CLI no-op semantics.
  const noopResult = await client.callTool({ name: "ldl_update", arguments: { dest, root: rootV2 } });
  assert.equal(noopResult.isError, false);
  const noopPayload = JSON.parse(noopResult.content[0].text);
  assert.equal(noopPayload.status, "current");
  assert.equal(noopPayload.noop, true);
  assert.deepEqual(noopPayload.changedPaths, []);
});

test("ldl_update reports a superseded AGENTS.template.md in changedPaths, through the protocol", async (t) => {
  // Regression guard for a Stage 1 review finding on PR #118: a consumer's own AGENTS.md
  // being removed causes ldl-update to delete a previously-parked .ldl/AGENTS.template.md
  // while installing AGENTS.md directly — a real change not covered by planUpdate()'s own
  // toInstall list, so it must be added to changedPaths explicitly.
  const client = await connectedClient(t);
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "AGENTS.md"), "MY PROJECT'S OWN AGENTS.md\n");
  await ldlInit({ dest, root: rootV1 });
  assert.ok(existsSync(join(dest, ".ldl", "AGENTS.template.md")));

  rmSync(join(dest, "AGENTS.md"));

  const updateResult = await client.callTool({ name: "ldl_update", arguments: { dest, root: rootV1 } });
  assert.equal(updateResult.isError, false);
  const updatePayload = JSON.parse(updateResult.content[0].text);
  assert.ok(updatePayload.changedPaths.includes(".ldl/AGENTS.template.md"));
  assert.ok(updatePayload.changedPaths.includes("AGENTS.md"));
  assert.equal(existsSync(join(dest, ".ldl", "AGENTS.template.md")), false);
});

test("ldl_update reports manualIntegrationNeeded, matching pendingManualIntegration.length, through the protocol", async (t) => {
  // Stage 2 audit finding (P2) on PR #131: docs/consumer-contract.md promises this count on
  // every CLI/MCP run's result, but the ldl_update MCP handler previously dropped it entirely
  // when building its bespoke response object.
  const client = await connectedClient(t);
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md\n");
  await ldlInit({ dest, root: rootV1 });

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const updateResult = await client.callTool({ name: "ldl_update", arguments: { dest, root: rootV2 } });
  assert.equal(updateResult.isError, false);
  const payload = JSON.parse(updateResult.content[0].text);
  assert.equal(payload.manualIntegrationNeeded, 1);
  assert.equal(payload.manualIntegrationNeeded, payload.pendingManualIntegration.length);
});

test("ldl_update returns the structured error shape even when the underlying run throws", async (t) => {
  // Regression guard for a Stage 1 review finding on PR #118: ldl-update's run() does not
  // itself catch every exception planUpdate() can raise (e.g. EISDIR for a managed path
  // replaced by a directory) — it can reject instead of resolving with a non-zero exitCode.
  // The MCP tool must still return the documented {status, error, conflicts} shape, not the
  // generic handler-wide {error} fallback.
  const client = await connectedClient(t);
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await ldlInit({ dest, root: rootV1 });

  rmSync(join(dest, "docs", "operating-model.md"), { force: true });
  mkdirSync(join(dest, "docs", "operating-model.md"), { recursive: true });

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const updateResult = await client.callTool({ name: "ldl_update", arguments: { dest, root: rootV2 } });
  assert.equal(updateResult.isError, true);
  const updatePayload = JSON.parse(updateResult.content[0].text);
  assert.equal(updatePayload.status, "error");
  assert.ok(typeof updatePayload.error === "string" && updatePayload.error.length > 0);
  assert.ok(Array.isArray(updatePayload.conflicts));
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
  const updatePayload = JSON.parse(updateResult.content[0].text);
  assert.equal(updatePayload.status, "error");
  assert.match(updatePayload.error, /Refusing to update/);
  assert.ok(updatePayload.conflicts.some((c) => c.dest === "docs/operating-model.md"));

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

test("process coherence: an in-process server refuses every tool once its backing checkout's implementation changes (issue #146)", async (t) => {
  const fixtureRoot = makeFixtureRoot(t, "rev-1");
  copyImplementationFiles(fixtureRoot);

  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const server = createServer({ root: fixtureRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(() => client.close());

  const dest = tempDir(t);

  // Coherent baseline: the fixture's implementation copies are untouched since createServer()
  // captured its fingerprint, so every tool still runs normally.
  const before = await client.callTool({ name: "ldl_status", arguments: { repos: [dest], root: fixtureRoot } });
  assert.equal(before.isError, false);
  assert.equal(toolJson(before)[0].status, "not_initialized");

  // The backing checkout changes on disk — e.g. a founder session editing/updating this LDL
  // clone — while this same createServer() instance (and its already-imported code) keeps
  // running, exactly the Failure 2 scenario from issue #146.
  appendFileSync(join(fixtureRoot, "tools", "ldl-init", "index.mjs"), "\n// simulated upstream change\n");

  for (const call of [
    { name: "ldl_status", arguments: { repos: [dest], root: fixtureRoot } },
    { name: "ldl_init", arguments: { dest, root: fixtureRoot } },
    { name: "ldl_update", arguments: { dest, root: fixtureRoot } },
  ]) {
    const after = await client.callTool(call);
    assert.equal(after.isError, true, `${call.name} must refuse once the backing checkout changed`);
    assert.match(after.content[0].text, /stale/i);
    assert.match(after.content[0].text, /[Rr]estart/);
  }

  // The refusal itself, above, is the proof: nothing in this test observes a successful
  // response computed from the pre-change fixture copy while claiming coherence with the
  // post-change one — a hybrid response is exactly what these assertions rule out.
});

test("process coherence: a per-call `root` override pointed at a different checkout is tracked independently, not just the server's own backing checkout (Codex P1 finding on PR #147)", async (t) => {
  const backingRoot = makeFixtureRoot(t, "backing");
  copyImplementationFiles(backingRoot);
  const otherRoot = makeFixtureRoot(t, "other");
  copyImplementationFiles(otherRoot);

  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const server = createServer({ root: backingRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(() => client.close());

  const dest = tempDir(t);

  // First call against otherRoot establishes its own baseline; it must succeed even though
  // otherRoot differs from the server's own backingRoot.
  const first = await client.callTool({ name: "ldl_status", arguments: { repos: [dest], root: otherRoot } });
  assert.equal(first.isError, false);

  // otherRoot's own implementation drifts while this same process keeps running — the exact
  // scenario the single backingRoot-only check previously missed entirely, since backingRoot
  // itself never changed.
  appendFileSync(join(otherRoot, "tools", "ldl-init", "index.mjs"), "\n// simulated upstream change\n");

  const second = await client.callTool({ name: "ldl_status", arguments: { repos: [dest], root: otherRoot } });
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /stale/i);

  // The server's own backing checkout was never touched, so calls against it keep working —
  // proving the refusal above is scoped to otherRoot specifically, not a global lockout.
  const backingStillWorks = await client.callTool({ name: "ldl_status", arguments: { repos: [dest], root: backingRoot } });
  assert.equal(backingStillWorks.isError, false);
});

test("process coherence: ldl_update revalidates immediately before mutating, not only at tool-call entry (Codex P2 finding on PR #147)", async (t) => {
  const fixtureRoot = makeFixtureRoot(t, "rev-1");
  copyImplementationFiles(fixtureRoot);

  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const server = createServer({ root: fixtureRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  t.after(() => client.close());

  const dest = tempDir(t);
  await ldlInit({ dest, root: fixtureRoot });

  // The entry-time check above already refuses once the fingerprint has changed; this test
  // proves the *specific* pre-mutation call site exists and independently refuses ldl_update
  // right before it would otherwise write into `dest` — not merely that some earlier check in
  // the handler happened to already catch it.
  appendFileSync(join(fixtureRoot, "tools", "ldl-update", "index.mjs"), "\n// simulated upstream change\n");

  const before = readFileSync(join(dest, ".ldl", "manifest.json"), "utf8");
  const result = await client.callTool({ name: "ldl_update", arguments: { dest, root: fixtureRoot } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /stale/i);
  assert.equal(readFileSync(join(dest, ".ldl", "manifest.json"), "utf8"), before, "a stale process must never write into the consumer repository");
});

test("process coherence: a real long-lived `node server.mjs` process refuses stale synchronization once its backing checkout changes (issue #146)", async (t) => {
  const fixtureRoot = makeFixtureRoot(t, "rev-1");
  copyImplementationFiles(fixtureRoot);

  const client = new Client({ name: "coherence-smoke-client", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: { LDL_MCP_ROOT: fixtureRoot },
  });
  await client.connect(transport);
  t.after(() => client.close());

  const dest = tempDir(t);

  const before = await client.callTool({ name: "ldl_status", arguments: { repos: [dest] } });
  assert.equal(before.isError, false);
  assert.equal(toolJson(before)[0].status, "not_initialized");

  // The real spawned process's backing checkout (what it loaded tools/ldl-update/index.mjs's
  // code from at startup) advances to a new revision with different synchronization behavior
  // while the process keeps running and serving requests over the same stdio connection.
  appendFileSync(join(fixtureRoot, "tools", "ldl-update", "index.mjs"), "\n// simulated upstream change\n");

  const after = await client.callTool({ name: "ldl_status", arguments: { repos: [dest] } });
  assert.equal(after.isError, true);
  assert.match(after.content[0].text, /stale/i);
  assert.match(after.content[0].text, /[Rr]estart/);
});
