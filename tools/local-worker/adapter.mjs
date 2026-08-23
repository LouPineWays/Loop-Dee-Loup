#!/usr/bin/env node
// Local-worker adapter — lets a Claude subagent delegate a narrow, bounded work packet to a
// configured local LLM over the OpenAI-compatible chat-completions shape (Ollama, LM Studio,
// llama.cpp's llama-server all implement it), instead of doing the work with hosted Claude
// tokens. Performs exactly one HTTP call and returns structured data: no repository or GitHub
// action of any kind. See .claude/skills/local-worker/SKILL.md for the delegation and
// mandatory independent-verification policy that governs how this is supposed to be used.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL = "gpt-oss:20b";
const DEFAULT_TIMEOUT_MS = 30000;

const SYSTEM_PREAMBLE =
  "You are a bounded local worker for Loop-Dee-Loup. Follow the constraints exactly. " +
  "Return only the requested output — no commentary, no preamble, no markdown fences unless " +
  "the expected shape asks for them.";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function buildMessages(packet) {
  const constraints = Array.isArray(packet.constraints) ? packet.constraints : [];
  let systemContent = SYSTEM_PREAMBLE;
  if (constraints.length > 0) {
    systemContent += "\n\nConstraints:\n" + constraints.map((c) => `- ${c}`).join("\n");
  }

  let userContent = packet.task;
  const context = typeof packet.context === "string" ? packet.context : "";
  if (context.trim().length > 0) {
    userContent += `\n\nContext:\n${context}`;
  }
  userContent += `\n\nExpected output shape:\n${packet.expectedShape}`;

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];
}

/**
 * Dispatch one bounded work packet to a configured local LLM and return a structured result.
 * Never throws — every failure mode is classified into a `status` value instead.
 *
 * @param {object} packet - { task, constraints?, context?, expectedShape?, timeoutMs? }
 * @param {object} [options] - { baseUrl?, model?, timeoutMs?, fetchImpl? }
 * @returns {Promise<{ ok: boolean, status: string, output: string|null, detail: string }>}
 */
export async function runLocalTask(packet, options = {}) {
  packet = packet && typeof packet === "object" ? packet : {};

  const missing = [];
  if (!isNonEmptyString(packet.task)) missing.push("task");
  if (!isNonEmptyString(packet.expectedShape)) missing.push("expectedShape");
  if (missing.length > 0) {
    return {
      ok: false,
      status: "invalid_packet",
      output: null,
      detail: `missing required field(s): ${missing.join(", ")}`,
    };
  }

  const baseUrl = options.baseUrl || process.env.LDL_LOCAL_BASE_URL || DEFAULT_BASE_URL;
  const model = options.model || process.env.LDL_LOCAL_MODEL || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? packet.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || fetch;

  const body = {
    model,
    messages: buildMessages(packet),
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && (err.name === "AbortError" || controller.signal.aborted)) {
      return {
        ok: false,
        status: "timeout",
        output: null,
        detail: `local worker did not respond within ${timeoutMs}ms (baseUrl: ${baseUrl})`,
      };
    }
    return {
      ok: false,
      status: "unavailable",
      output: null,
      detail: `local runtime appears unreachable at ${baseUrl}: ${err && err.message ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "";
    }
    const truncated = bodyText.length > 500 ? `${bodyText.slice(0, 500)}...` : bodyText;
    return {
      ok: false,
      status: "error",
      output: null,
      detail: `local runtime returned HTTP ${res.status}: ${truncated}`,
    };
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    return {
      ok: false,
      status: "malformed",
      output: null,
      detail: `response body was not parseable JSON: ${err && err.message ? err.message : String(err)}`,
    };
  }

  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    return {
      ok: false,
      status: "malformed",
      output: null,
      detail: "response JSON lacked a non-empty choices[0].message.content",
    };
  }

  let detail = "completed";
  if (json.usage) {
    detail = `completed (usage: ${JSON.stringify(json.usage)})`;
  }

  return {
    ok: true,
    status: "completed",
    output: content.trim(),
    detail,
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const path = process.argv[2];
  const raw = path ? readFileSync(path, "utf8") : await readStdin();

  let packet;
  try {
    packet = JSON.parse(raw);
  } catch (err) {
    console.log(
      JSON.stringify({
        ok: false,
        status: "invalid_packet",
        output: null,
        detail: `packet input was not valid JSON: ${err.message}`,
      }),
    );
    process.exit(1);
  }

  const result = await runLocalTask(packet);
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
