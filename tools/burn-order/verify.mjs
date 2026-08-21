#!/usr/bin/env node
// Burn Order verifier — makes "done" a claim git can check rather than prose you have to
// trust. Run it with `node tools/burn-order/verify.mjs`; exits non-zero on any FAIL so CI
// can gate on it.
//
// It exists because the old convention (retire an item by deleting it from every band and
// writing "DONE" into its note) silently reverted itself: the editor adopts any unbanded
// item back into Wishes, so a completed item rejoined the active backlog the next time
// anyone opened the page. That happened twice before this file existed — see
// `report-a-problem` between commits d4259c6 and 9ad4b62. Structure check A below is the
// one that would have caught it.

import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DATA_FILE = join(REPO_ROOT, "docs", "burn-order.json");

const BUCKETS = ["Now", "Soon", "Later", "Wishes", "Blocked", "Done"];
const DONE = "Done";

// A note that opens with one of these is asserting completion in prose. That assertion is
// only trustworthy if the item actually sits in Done with evidence attached, which is what
// check D cross-examines. Anchored to the start on purpose: it matches this file's real
// convention ("DONE, verified 2026-07-25: …") without firing on prose that merely mentions
// the word further in.
const CLAIMS_DONE = /^\s*(DONE|SHIPPED|COMPLETED?)\b/i;

const SHA = /^[0-9a-f]{7,40}$/;
const PR = /^#\d+$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Date.parse silently normalizes impossible calendar dates instead of rejecting them
// (2026-02-31 becomes 2026-03-03), so it can't tell a real date from a rolled-over one.
// Re-derive year/month/day from the parsed UTC instant and compare against what was typed.
function isRealCalendarDate(s) {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const [, y, mo, d] = m.map(Number);
  const t = Date.UTC(y, mo - 1, d);
  if (Number.isNaN(t)) return false;
  const check = new Date(t);
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d;
}

const fails = [];
const warns = [];
const fail = (id, msg) => fails.push({ id, msg });
const warn = (id, msg) => warns.push({ id, msg });

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// A shallow clone holds only the tip of history, so every done-ref older than that slice
// looks unresolvable even though it is fine. Cloud/phone sessions clone shallow, and three
// separate firings of the weekly doc-audit loop each rediscovered the resulting wall of 13
// bogus FAIL lines from scratch, re-ran `git fetch --unshallow origin`, and re-verified
// clean. That is a bug in this file, not in those sessions: an unverifiable ref and a wrong
// ref are different answers and this told you the wrong one.
//
// Detecting it here costs one git call and lets the ref checks say "not checked" instead of
// "broken". CI is unaffected either way, since burn-order.yml checks out with fetch-depth: 0
// specifically so these refs CAN be resolved — a genuinely bad ref still fails there.
const isShallowClone = (() => {
  try {
    return git(["rev-parse", "--is-shallow-repository"]) === "true";
  } catch {
    // Old git, or not a repo at all. Assume full history and let resolveRef report whatever
    // it finds, which is exactly the behaviour this file had before shallow was handled.
    return false;
  }
})();
const unresolvable = [];

// Resolve a done-ref against real history. A bare sha must name a commit that exists; a
// "#123" must name a commit whose subject carries GitHub's squash-merge suffix. Both are
// answered from the local clone, so this needs no network and no gh auth — but it does
// need full history, which is why the workflow checks out with fetch-depth: 0.
function resolveRef(ref) {
  try {
    if (SHA.test(ref)) {
      git(["rev-parse", "--verify", "--quiet", ref + "^{commit}"]);
      return { ok: true, how: "commit " + ref };
    }
    if (PR.test(ref)) {
      const hits = git(["log", "--all", "--fixed-strings", "--grep=(" + ref + ")", "--format=%H %s"]);
      if (!hits) return { ok: false, how: "no commit subject contains (" + ref + ")" };
      return { ok: true, how: hits.split("\n")[0] };
    }
    return { ok: false, how: "not a sha or a #PR reference" };
  } catch (e) {
    return { ok: false, how: "does not resolve in this clone" };
  }
}

const raw = await readFile(DATA_FILE, "utf8");
const state = JSON.parse(raw);

/* ---------- A. Structure: every item in exactly one band ---------- */
// The check that matters most. An item in no band is not "retired", it is invisible to the
// server's own validate() and gets silently re-adopted into Wishes by the editor.
const placed = new Map();
for (const b of BUCKETS) {
  const arr = state.order[b];
  if (!Array.isArray(arr)) {
    fail(b, `order.${b} is missing or not an array`);
    continue;
  }
  for (const id of arr) {
    if (!state.items[id]) fail(id, `order.${b} references an item that does not exist`);
    else if (placed.has(id)) fail(id, `appears in both ${placed.get(id)} and ${b}`);
    else placed.set(id, b);
  }
}
for (const b of Object.keys(state.order)) {
  if (!BUCKETS.includes(b)) fail(b, `order.${b} is not a known band`);
}
for (const id of Object.keys(state.items)) {
  if (!placed.has(id)) {
    fail(id, "is in no band — it will be silently adopted into Wishes the next time the editor opens");
  }
}

/* ---------- B + C. Done items carry checkable evidence ---------- */
for (const id of state.order[DONE] || []) {
  const it = state.items[id];
  if (!it) continue;
  const d = it.done;
  if (!d || typeof d !== "object") {
    fail(id, "is in Done but has no done:{} block saying when, and on what evidence");
    continue;
  }
  if (!isRealCalendarDate(d.on || "")) {
    fail(id, `done.on is "${d.on ?? ""}", which is not a real YYYY-MM-DD date`);
  }
  const ref = (d.ref || "").trim();
  const evidence = (d.evidence || "").trim();
  if (!ref && !evidence) {
    fail(id, "done has neither a git ref nor an evidence line — nothing here can be checked");
  }
  if (ref) {
    if (isShallowClone) {
      // Deliberately not a warn(): a warning still reads as "something is off with this
      // item", and nothing is. The single grouped line at the end says it once instead.
      unresolvable.push(id);
    } else {
      const r = resolveRef(ref);
      if (!r.ok) fail(id, `done.ref "${ref}" ${r.how}`);
    }
  } else {
    // Legitimate: a Community post or a Play Console submission leaves no commit behind.
    // Evidence is then the honest answer, so this is a note rather than a complaint.
    warn(id, `has no git ref, resting on evidence alone: "${evidence}"`);
  }
}

/* ---------- D. Prose claiming completion outside the Done band ---------- */
for (const [id, band] of placed) {
  const it = state.items[id];
  if (band === DONE) continue;
  if (CLAIMS_DONE.test(it.note || "")) {
    fail(id, `sits in ${band} but its note opens by declaring completion — move it to Done with a ref, or reword the note`);
  }
  if (it.done) {
    fail(id, `sits in ${band} but carries a done:{} block — one of the two is wrong`);
  }
}

/* ---------- Report ---------- */
const counts = BUCKETS.map((b) => `${b} ${(state.order[b] || []).length}`).join("  ·  ");
console.log(`Burn Order  ${Object.keys(state.items).length} items   ${counts}\n`);

for (const w of warns) console.log(`  note  ${w.id}: ${w.msg}`);
if (warns.length) console.log("");

if (unresolvable.length) {
  console.log(
    `  note  this clone is shallow, so ${unresolvable.length} done-ref${unresolvable.length === 1 ? " was" : "s were"} not checked ` +
      `against history. Everything else below still ran. To check them here:\n` +
      `          git fetch --unshallow origin\n` +
      `        CI already checks them: burn-order.yml checks out with fetch-depth: 0.\n`,
  );
}

if (!fails.length) {
  const refs = unresolvable.length ? "every done item that could be checked here resolves" : "every done item resolves";
  console.log(`OK — ${refs}, and nothing claims completion from an active band.`);
  process.exit(0);
}

for (const f of fails) console.log(`  FAIL  ${f.id}: ${f.msg}`);
console.log(`\n${fails.length} problem${fails.length === 1 ? "" : "s"} in docs/burn-order.json.`);
process.exit(1);
