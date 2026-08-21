#!/usr/bin/env node
// Burn Order — a tiny local server so the backlog UI can read and write a real file
// (docs/burn-order.json) instead of hiding its state in browser storage. Zero
// dependencies on purpose: `node tools/burn-order/server.mjs` and nothing else.
//
// The point of the file living in the repo is that a Claude Code session can read it
// directly, git tracks every reordering, and no copy-paste is ever needed.

import { createServer } from "node:http";
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DATA_FILE = join(REPO_ROOT, "docs", "burn-order.json");
const INDEX_FILE = join(HERE, "index.html");
const PORT = Number(process.env.PORT || 4137);

// Done is a real band, not the absence of one. Retiring an item by deleting it from every
// band used to look like it worked and then quietly undo itself, because the client adopts
// any unbanded item back into Wishes — see tools/burn-order/verify.mjs for the history.
const BUCKETS = ["Now", "Soon", "Later", "Wishes", "Blocked", "Done"];

function send(res, status, body, type = "application/json") {
  const payload = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "Content-Type": type + "; charset=utf-8",
    // This is a single-user local tool; never cache, so an external edit shows up.
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readState() {
  const [raw, info] = await Promise.all([readFile(DATA_FILE, "utf8"), stat(DATA_FILE)]);
  return { state: JSON.parse(raw), mtimeMs: info.mtimeMs };
}

// Shape check before anything is written, so a bug in the client can't turn the file
// into something the next session cannot read.
function validate(state) {
  if (!state || typeof state !== "object") return "state is not an object";
  if (!state.items || typeof state.items !== "object") return "missing items map";
  if (!state.order || typeof state.order !== "object") return "missing order map";
  // Reject unrecognized band keys outright, not just missing/malformed known ones. A
  // browser tab still running JS from before a band rename (e.g. Next -> Soon) doesn't
  // know the new names and won't strip its own old ones out of the object it submits, so
  // without this check a stale write can silently persist a mixed old+new schema: the
  // known bands still validate fine, the leftover old key just rides along unexamined,
  // and only node tools/burn-order/verify.mjs (which does check every order key against
  // BUCKETS) ever catches it -- after it's already on disk. Reject at write time instead.
  for (const b of Object.keys(state.order)) {
    if (!BUCKETS.includes(b)) return `order.${b} is not a known band`;
  }
  for (const b of BUCKETS) {
    if (!Array.isArray(state.order[b])) return `order.${b} is not an array`;
  }
  const placed = new Set();
  for (const b of BUCKETS) {
    for (const id of state.order[b]) {
      if (!state.items[id]) return `order.${b} references unknown item "${id}"`;
      if (placed.has(id)) return `item "${id}" appears in more than one band`;
      placed.add(id);
    }
  }
  for (const id of Object.keys(state.items)) {
    if (!placed.has(id)) return `item "${id}" is in no band`;
    // Shape only. Whether the ref actually resolves in git, and whether a Done item has
    // any evidence at all, is verify.mjs's job — that needs to shell out to git, which a
    // write path should not do.
    const done = state.items[id].done;
    if (done !== undefined) {
      if (!done || typeof done !== "object" || Array.isArray(done)) return `item "${id}" has a non-object done block`;
      for (const k of ["on", "ref", "evidence"]) {
        if (done[k] !== undefined && typeof done[k] !== "string") return `item "${id}" has a non-string done.${k}`;
      }
    }
  }
  return null;
}

// Write to a sibling temp file then rename: a crash mid-write can't truncate the real
// backlog, since rename is atomic on the same filesystem.
async function writeState(state) {
  const tmp = DATA_FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, DATA_FILE);
  return (await stat(DATA_FILE)).mtimeMs;
}

// Serializes every mtime-check-then-write onto one chain, so two PUTs racing from separate
// tabs/sessions can't both pass the check before either writes (they'd otherwise share one
// .tmp path and one of the two acknowledged writes would be silently overwritten by the
// other). Each task still returns its own {status, body}; only the ordering is shared.
let writeChain = Promise.resolve();
function serialized(task) {
  const result = writeChain.then(task, task);
  writeChain = result.then(() => {}, () => {});
  return result;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(res, 200, await readFile(INDEX_FILE, "utf8"), "text/html");
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      const { state, mtimeMs } = await readState();
      return send(res, 200, { ok: true, state, mtimeMs });
    }

    if (req.method === "PUT" && url.pathname === "/api/state") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8_000_000) {
          req.destroy();
          return;
        }
      }
      const parsed = JSON.parse(body);
      const problem = validate(parsed.state);
      if (problem) return send(res, 400, { ok: false, error: problem });

      // Optimistic concurrency: refuse the write if the file moved underneath us, so a
      // hand-edit or another session's change is never silently overwritten. Serialized
      // (see serialized() above) so two concurrent PUTs can't both pass this check before
      // either has written.
      const outcome = await serialized(async () => {
        const current = await stat(DATA_FILE);
        if (typeof parsed.baseMtimeMs === "number" && parsed.baseMtimeMs !== current.mtimeMs) {
          const { state, mtimeMs } = await readState();
          return { status: 409, body: { ok: false, error: "changed on disk", state, mtimeMs } };
        }
        const mtimeMs = await writeState(parsed.state);
        return { status: 200, body: { ok: true, mtimeMs } };
      });
      return send(res, outcome.status, outcome.body);
    }

    send(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    send(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Burn Order  →  http://localhost:${PORT}`);
  console.log(`Reading/writing ${DATA_FILE}`);
});
