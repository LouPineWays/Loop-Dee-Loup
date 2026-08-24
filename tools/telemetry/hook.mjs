#!/usr/bin/env node
// Claude Code hook entry point for Loop-Dee-Loup's deterministic session telemetry
// collector. Wired in .claude/settings.json for SessionStart, SessionEnd, PreCompact,
// PostCompact, SubagentStart, and SubagentStop.
//
// Reads the hook's JSON payload from stdin, appends one compact, privacy-minimal event
// line to the firing session's raw telemetry log (see collect.mjs), and exits 0.
//
// Deliberately never writes to stdout: a SessionStart hook's stdout is injected straight
// into the live session's context, and every other event's stdout is simply discarded —
// so any output here would either spend tokens for no telemetry benefit or do nothing.
// Deliberately never throws or exits non-zero for a data problem: a telemetry failure
// must never be allowed to interrupt or slow down real session use. See
// tools/telemetry/README.md.
//
// Usage (wired automatically by .claude/settings.json, not normally run by hand):
//   node tools/telemetry/hook.mjs   # reads one hook payload from stdin
//
// Tests: node --test tools/telemetry/hook.test.mjs

import { pathToFileURL } from "node:url";
import { readStdinJson, appendEvent, extractIdentity } from "./collect.mjs";

export function buildEvent(payload) {
  if (!payload || typeof payload.hook_event_name !== "string") return null;
  const identity = extractIdentity(payload);
  const event = {
    kind: "hook",
    event: payload.hook_event_name,
    ts: new Date().toISOString(),
    ...identity,
  };
  // PreCompact / PostCompact carry "manual" | "auto".
  if (typeof payload.trigger === "string") event.trigger = payload.trigger;
  // SubagentStart / SubagentStop carry an agent identity.
  if (typeof payload.agent_id === "string") event.agent_id = payload.agent_id;
  if (typeof payload.agent_type === "string") event.agent_type = payload.agent_type;
  // SessionStart carries a start reason ("startup" | "resume" | "clear" | "compact" | "fork");
  // SessionEnd carries an end reason. Different Claude Code versions have used "source" and
  // "reason" for this; capture whichever is present under one normalized field.
  const reason = payload.reason ?? payload.source;
  if (typeof reason === "string") event.reason = reason;
  return event;
}

function main() {
  try {
    const payload = readStdinJson();
    const event = buildEvent(payload);
    if (event) appendEvent(event.session_id, event);
  } catch {
    // Deliberately swallowed — see header comment.
  }
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
