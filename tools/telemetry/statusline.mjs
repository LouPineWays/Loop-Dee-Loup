#!/usr/bin/env node
// Claude Code statusLine entry point for Loop-Dee-Loup's deterministic session telemetry
// collector. Wired in .claude/settings.json's "statusLine" block.
//
// In an interactive `claude` terminal session, statusLine is re-invoked on session start, on
// each new assistant message, on /compact completion, and on a few other local render events —
// never on a model turn itself, so sampling it spends no API tokens. Its JSON payload carries
// the running session's cost, context-window, and identity snapshot (see
// tools/telemetry/README.md for the fields this script relies on and how it degrades when one
// is missing). This command has not been observed to fire at all in this repository's actual
// (non-interactive) execution mode — see "statusLine's confirmed non-interactive gap" in
// tools/telemetry/README.md before assuming this script runs in your environment.
//
// This script has two jobs, both required by the statusLine contract: append a compact,
// privacy-minimal sample to the firing session's raw telemetry log, AND print a short
// human-readable line to stdout — Claude Code renders whatever this prints as the actual
// status line, so output is never optional here (unlike hook.mjs).
//
// Usage (wired automatically by .claude/settings.json, not normally run by hand):
//   node tools/telemetry/statusline.mjs   # reads one statusLine payload from stdin
//
// Tests: node --test tools/telemetry/statusline.test.mjs

import { pathToFileURL } from "node:url";
import { readStdinJson, appendEvent, extractIdentity, numOrNull } from "./collect.mjs";

export function buildEvent(payload) {
  if (!payload || typeof payload !== "object") return null;
  const identity = extractIdentity(payload);
  const cost = payload.cost && typeof payload.cost === "object"
    ? {
        total_cost_usd: numOrNull(payload.cost.total_cost_usd),
        total_duration_ms: numOrNull(payload.cost.total_duration_ms),
        total_api_duration_ms: numOrNull(payload.cost.total_api_duration_ms),
        total_lines_added: numOrNull(payload.cost.total_lines_added),
        total_lines_removed: numOrNull(payload.cost.total_lines_removed),
      }
    : null;
  const currentUsage = payload.context_window?.current_usage;
  const contextWindow = payload.context_window && typeof payload.context_window === "object"
    ? {
        total_input_tokens: numOrNull(payload.context_window.total_input_tokens),
        total_output_tokens: numOrNull(payload.context_window.total_output_tokens),
        context_window_size: numOrNull(payload.context_window.context_window_size),
        used_percentage: numOrNull(payload.context_window.used_percentage),
        current_usage: currentUsage && typeof currentUsage === "object"
          ? {
              input_tokens: numOrNull(currentUsage.input_tokens),
              output_tokens: numOrNull(currentUsage.output_tokens),
              cache_creation_input_tokens: numOrNull(currentUsage.cache_creation_input_tokens),
              cache_read_input_tokens: numOrNull(currentUsage.cache_read_input_tokens),
            }
          : null,
      }
    : null;
  return {
    kind: "statusline_sample",
    ts: new Date().toISOString(),
    ...identity,
    model_id: typeof payload.model?.id === "string" ? payload.model.id : null,
    model_display_name: typeof payload.model?.display_name === "string" ? payload.model.display_name : null,
    cost,
    context_window: contextWindow,
    exceeds_200k_tokens: typeof payload.exceeds_200k_tokens === "boolean" ? payload.exceeds_200k_tokens : null,
  };
}

export function formatStatusLine(payload) {
  if (!payload) return "";
  const model = payload.model?.display_name || payload.model?.id || "claude";
  const parts = [model];
  const costUsd = payload.cost?.total_cost_usd;
  if (typeof costUsd === "number" && Number.isFinite(costUsd)) parts.push(`$${costUsd.toFixed(2)}`);
  const usedPct = payload.context_window?.used_percentage;
  if (typeof usedPct === "number" && Number.isFinite(usedPct)) parts.push(`ctx ${Math.round(usedPct)}%`);
  return parts.join(" · ");
}

function main() {
  let payload = null;
  try {
    payload = readStdinJson();
    const event = buildEvent(payload);
    if (event) appendEvent(event.session_id, event);
  } catch {
    // Deliberately swallowed: a telemetry write failure must never break the status line
    // the user actually sees. Fall through and print the best available output below.
  }
  process.stdout.write(formatStatusLine(payload));
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
