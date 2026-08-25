// Small, deliberately dumb helpers shared by server.mjs. No registry service, no committed
// machine-specific paths — see issue #110 requirement 5 ("prefer the smallest mechanism that
// permits deterministic enumeration without introducing a repository registry service").

import { delimiter, isAbsolute, resolve } from "node:path";

// Resolves the set of consumer repositories a status call should check: explicit `repos`
// wins; otherwise falls back to the LDL_CONSUMER_REPOS environment variable, a
// path.delimiter-separated list (";" on Windows, ":" elsewhere — the same convention the
// PATH environment variable already uses on each platform), read fresh on every call so a
// long-lived server process picks up an updated env var without a restart.
export function resolveRepos(explicitRepos) {
  if (Array.isArray(explicitRepos) && explicitRepos.length > 0) {
    return explicitRepos;
  }
  const envVal = process.env.LDL_CONSUMER_REPOS;
  if (!envVal) return [];
  return envVal
    .split(delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Resolves a possibly-relative path argument against the server process's cwd, so a client
// that passes a relative path behaves predictably instead of depending on where the LDL
// checkout happens to sit. Returns undefined unchanged (callers apply their own default).
export function resolvePathArg(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}
