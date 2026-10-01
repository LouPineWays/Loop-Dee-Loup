// Test-only hermeticity guard (issue #794 Stage 2 correction). Import this module FIRST in a
// unit-test file: it replaces the `gh` entry points of node:child_process with stubs that throw,
// so any production default implementation (defaultGhIssueList, defaultGhApi, ...) reached by an
// unstubbed test path fails that test deterministically instead of silently contacting GitHub.
// Non-`gh` commands pass through unchanged. Production code never imports this module.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const attempts = [];
export function ghSpawnAttempts() {
  return attempts.slice();
}

function isGh(command) {
  return typeof command === "string" && /(^|[\/])gh(\.exe|\.cmd)?$/i.test(command);
}

for (const name of ["execFileSync", "spawnSync", "execFile", "spawn"]) {
  const original = childProcess[name];
  childProcess[name] = function guarded(command, ...rest) {
    if (isGh(command)) {
      const args = Array.isArray(rest[0]) ? rest[0].join(" ") : "";
      attempts.push(`${name}: gh ${args}`);
      throw new Error(`Unexpected real gh invocation in hermetic unit test (${name}): gh ${args}`);
    }
    return original.call(this, command, ...rest);
  };
}
syncBuiltinESMExports();
