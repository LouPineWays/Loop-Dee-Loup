#!/usr/bin/env node
// Claude Code hook entry point for Loop-Dee-Loup's deterministic session telemetry
// collector. Wired in .claude/settings.json for SessionStart, SessionEnd, PreCompact,
// PostCompact, SubagentStart, and SubagentStop.
//
// Reads the hook's JSON payload from stdin, appends one compact, privacy-minimal event
// line to the firing session's raw telemetry log (see collect.mjs), and exits 0.
//
// On SessionEnd, PreCompact, and SubagentStop, additionally reads the session's own
// transcript (via the payload's transcript_path — never persisted) to recover deterministic
// token-economic evidence statusLine cannot supply in this repository's normal execution
// mode. See transcript.mjs and "statusLine's confirmed non-interactive gap" in
// tools/telemetry/README.md. PreCompact and SubagentStop are included, not just SessionEnd,
// so a session that never reaches a normal SessionEnd still leaves its last-known token
// totals behind, the same incremental-sample philosophy statusLine's own hook already uses
// — see "SessionEnd is not always invoked" in tools/telemetry/README.md (issue #178).
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
import { collectTranscriptUsage } from "./transcript.mjs";

// SubagentStop is included alongside SessionEnd/PreCompact for issue #178: a session that
// dispatches at least one subagent to completion leaves a last-known-totals checkpoint even
// if the session's own process is later torn down (by the harness superseding it with a new
// session_id, a crash, or any other path) without ever invoking SessionEnd or triggering a
// compaction — see "SessionEnd is not always invoked" in tools/telemetry/README.md. Verified
// against a real SubagentStop hook payload that its transcript_path points at the same main
// session transcript SessionEnd/PreCompact receive, so collectTranscriptUsage's main+subagent
// aggregation works unmodified from this trigger.
const TRANSCRIPT_USAGE_EVENTS = new Set(["SessionEnd", "PreCompact", "SubagentStop"]);

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

// Builds the companion transcript_usage event for a SessionEnd/PreCompact/SubagentStop firing, or null
// when the event type doesn't warrant one, no transcript_path was supplied, or the
// transcript couldn't be read (nothing measured). transcript_path itself is read here and
// then discarded — it is never copied onto the returned event. Pure and side-effect-free
// (aside from the filesystem read inside collectTranscriptUsage) so it's directly testable.
export function buildTranscriptUsageEvent(payload, baseEvent) {
  if (!baseEvent || !TRANSCRIPT_USAGE_EVENTS.has(baseEvent.event)) return null;
  if (typeof payload?.transcript_path !== "string" || !payload.transcript_path) return null;
  const usage = collectTranscriptUsage(payload.transcript_path);
  if (!usage) return null;
  return {
    kind: "transcript_usage",
    event: baseEvent.event,
    ts: new Date().toISOString(),
    session_id: baseEvent.session_id,
    repo: baseEvent.repo,
    cwd_basename: baseEvent.cwd_basename,
    main: usage.main,
    subagents: usage.subagents,
  };
}

function main() {
  try {
    const payload = readStdinJson();
    const event = buildEvent(payload);
    if (event) {
      appendEvent(event.session_id, event);
      const usageEvent = buildTranscriptUsageEvent(payload, event);
      if (usageEvent) appendEvent(usageEvent.session_id, usageEvent);
    }
  } catch {
    // Deliberately swallowed — see header comment.
  }
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
