// Tests for tools/local-worker/adapter.mjs. All network access is faked via the injected
// `fetchImpl` option — never touch the real network here. Run with:
//   node --test tools/local-worker/adapter.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { runLocalTask } from "./adapter.mjs";

const VALID_PACKET = {
  task: "Say hello.",
  constraints: ["Be brief."],
  context: "",
  expectedShape: "A single sentence.",
};

function jsonResponse(obj, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

test("successful completion returns ok:true, status:completed, trimmed output", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({
      choices: [{ message: { content: "  Hello there.  " } }],
      usage: { total_tokens: 42 },
    });
  };

  const result = await runLocalTask(VALID_PACKET, { fetchImpl });

  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(result.output, "Hello there.");
});

test("malformed output (empty body object) returns ok:false, status:malformed", async () => {
  const fetchImpl = async () => jsonResponse({});
  const result = await runLocalTask(VALID_PACKET, { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.status, "malformed");
  assert.equal(result.output, null);
});

test("malformed output (empty content string) returns ok:false, status:malformed", async () => {
  const fetchImpl = async () => jsonResponse({ choices: [{ message: { content: "   " } }] });
  const result = await runLocalTask(VALID_PACKET, { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.status, "malformed");
});

test("runtime unavailable (connection failure) returns ok:false, status:unavailable", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };

  const result = await runLocalTask(VALID_PACKET, { fetchImpl, baseUrl: "http://localhost:11434" });

  assert.equal(result.ok, false);
  assert.equal(result.status, "unavailable");
  assert.match(result.detail, /unreachable/);
});

test("timeout (abort signal fires) returns ok:false, status:timeout", async () => {
  const fetchImpl = async (_url, init) => {
    return new Promise((_resolve, reject) => {
      const onAbort = () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (init.signal.aborted) {
        onAbort();
      } else {
        init.signal.addEventListener("abort", onAbort);
      }
    });
  };

  const result = await runLocalTask(VALID_PACKET, { fetchImpl, timeoutMs: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.status, "timeout");
  assert.match(result.detail, /10ms/);
});

test("invalid packet: missing task -> invalid_packet, fetch never called", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("should not be called");
  };

  const result = await runLocalTask(
    { expectedShape: "something" },
    { fetchImpl },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid_packet");
  assert.equal(calls, 0);
});

test("invalid packet: missing expectedShape -> invalid_packet, fetch never called", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("should not be called");
  };

  const result = await runLocalTask({ task: "do something" }, { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid_packet");
  assert.equal(calls, 0);
});

test("HTTP error status returns ok:false, status:error", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    text: async () => "boom",
  });

  const result = await runLocalTask(VALID_PACKET, { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.match(result.detail, /500/);
  assert.match(result.detail, /boom/);
});

test("baseUrl with trailing slash and with trailing /v1 both normalize to the same endpoint", async () => {
  const seenUrls = [];
  const fetchImpl = async (url) => {
    seenUrls.push(url);
    return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  };

  await runLocalTask(VALID_PACKET, { fetchImpl, baseUrl: "http://localhost:11434/" });
  await runLocalTask(VALID_PACKET, { fetchImpl, baseUrl: "http://localhost:11434/v1" });
  await runLocalTask(VALID_PACKET, { fetchImpl, baseUrl: "http://localhost:11434/v1/" });
  await runLocalTask(VALID_PACKET, { fetchImpl, baseUrl: "http://localhost:11434" });

  for (const url of seenUrls) {
    assert.equal(url, "http://localhost:11434/v1/chat/completions");
  }
});

test("stall during body read after headers arrive is classified timeout, not malformed", async () => {
  const fetchImpl = async (_url, init) => {
    return {
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          const onAbort = () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (init.signal.aborted) onAbort();
          else init.signal.addEventListener("abort", onAbort);
        }),
      text: async () => "",
    };
  };

  const result = await runLocalTask(VALID_PACKET, { fetchImpl, timeoutMs: 10 });

  assert.equal(result.ok, false);
  assert.equal(result.status, "timeout");
});

test("CLI: unreadable packet file path produces a structured invalid_packet result, not a crash", () => {
  const adapterPath = join(dirname(fileURLToPath(import.meta.url)), "adapter.mjs");
  const missingPath = join(dirname(fileURLToPath(import.meta.url)), "does-not-exist.json");

  const proc = spawnSync(process.execPath, [adapterPath, missingPath], { encoding: "utf8" });

  assert.equal(proc.status, 1);
  const parsed = JSON.parse(proc.stdout.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, "invalid_packet");
  assert.match(parsed.detail, /could not read packet input/);
});

test("authority boundary: adapter source performs no unauthorized durable action", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "adapter.mjs"), "utf8");

  assert.doesNotMatch(source, /node:child_process/);
  assert.doesNotMatch(source, /\bexec\(/);
  assert.doesNotMatch(source, /\bexecSync\(/);
  assert.doesNotMatch(source, /\bspawn\(/);
  assert.doesNotMatch(source, /writeFile/);
});
