// Detects MCP process/source-checkout incoherence for issue #146.
//
// server.mjs statically imports tools/ldl-init/index.mjs, tools/ldl-update/index.mjs, and
// ./status.mjs once, when this process starts. Node's ES module cache is permanent for a
// given resolved file path within one process: once loaded, that code keeps executing for
// the rest of this process's life no matter what later overwrites those files on disk. But
// every tool call still resolves the Loop-Dee-Loup source revision and reads managed-item
// source files fresh, from whatever is on disk *right now*. A long-lived server process
// whose backing Loop-Dee-Loup checkout is edited or updated after it started can therefore
// execute stale transformation code (loaded at start) against fresh source content and a
// freshly resolved revision, and report that fresh revision as if the stale code's output
// genuinely reflected it — the exact hazard this issue exists to close.
//
// The fix here is deliberately not an attempt to hot-reload the already-imported modules:
// Node has no supported way to evict a module from the import cache, and a cache-busting
// dynamic `import()` on every call would grow the module graph without bound over a
// long-lived process for a benefit (implicit hot reload) nobody asked for. Instead, this
// process fingerprints the on-disk bytes of every file whose content actually determines its
// synchronization/derivation behavior once, when it starts, and re-checks that same
// fingerprint before every tool call. A mismatch means this process's already-loaded code can
// no longer be trusted to match the checkout it would read from — so it fails closed with a
// compact, deterministic message telling the caller to restart the server, rather than
// silently stamping a freshly resolved revision onto output produced by stale code.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every file whose on-disk bytes participate in determining what an ldl_status/ldl_init/
// ldl_update tool call actually does. Kept as repo-relative paths, resolved against whatever
// root implementationFingerprint() is called with, so the same list works against both this
// server's own real checkout and a disposable test fixture.
export const IMPLEMENTATION_FILES = [
  "tools/ldl-init/index.mjs",
  "tools/ldl-update/index.mjs",
  "tools/mcp-server/status.mjs",
  "tools/mcp-server/config.mjs",
  "tools/mcp-server/server.mjs",
];

// Hashes IMPLEMENTATION_FILES' current on-disk content together into one deterministic
// digest. A file that can't be read at all (removed, or `root` doesn't point at a real LDL
// checkout) is folded into the digest as a distinguishable sentinel rather than thrown —
// missing-implementation is itself a fingerprint-changing condition callers should detect as
// staleness, not a crash independent of this mechanism's own purpose.
export function implementationFingerprint(root) {
  const hash = createHash("sha256");
  for (const relPath of IMPLEMENTATION_FILES) {
    hash.update(relPath);
    hash.update("\0");
    try {
      hash.update(readFileSync(join(root, ...relPath.split("/"))));
    } catch (err) {
      hash.update(`MISSING:${err.code ?? err.message}`);
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}
