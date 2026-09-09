#!/usr/bin/env node
// scripts/test-distance-fail-open.mjs
//
// "We cannot have this fail." (Patrick, 2026-09-02)
//
// lib/geocode.js was hardened for that: a 4-second timeout, one retry, a
// town-centroid fallback, and approximate coordinates that never persist.
// lib/distance.js — the other half of the same Google dependency, and the
// one the availability engine calls once per candidate slot — was not. It
// had two defects:
//
//   1. `fetch(url)` with no AbortSignal. Google decides how long the
//      customer waits. The engine awaits these in sequence, so one hung
//      request holds the whole availability response open.
//
//   2. Every failure path CACHED ITS GUESS. No key configured, over quota,
//      network down — the Haversine estimate went into distance-cache.json
//      under the same shape as a real answer, and nothing ever re-checked
//      it. Setting GOOGLE_MAPS_SERVER_KEY in Render therefore changed
//      nothing for any pair already guessed: the geography filter went on
//      measuring Patrick's corridor with straight lines. On this machine
//      that file held 58 entries and every one of them was a guess.
//
// WHAT IS PINNED. Six properties, all deterministic, driving the real
// module with `fetch` replaced — no network, no key, no billing:
//   1. A Google that never answers is abandoned, and a number still comes
//      back. On the old code this call never returns at all.
//   2. …and the abandoned pair is not cached, so it is retried later.
//   3. A definitive Google error yields an estimate that is NOT cached —
//      the next call, with Google healthy, returns Google's number.
//   4. Unprovenanced entries already on disk are dropped on load, not
//      served, and the file is rewritten without them.
//   5. A real answer IS cached, with provenance, and served without a
//      second call.
//   6. The unfloored path (used by the re-sequencer) obeys all of it too.
//
// Run: node scripts/test-distance-fail-open.mjs  (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const CACHE = path.join(DATA, "distance-cache.json");
const RAW_CACHE = path.join(DATA, "distance-cache-raw.json");
const MODULE = path.join(ROOT, "server", "lib", "distance.js");

let passed = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(DATA, { recursive: true });
const backups = new Map();
for (const p of [CACHE, RAW_CACHE]) backups.set(p, fs.existsSync(p) ? fs.readFileSync(p) : null);
const realFetch = globalThis.fetch;
const realKey = process.env.GOOGLE_MAPS_SERVER_KEY;

// Newmarket -> Thornhill, the pair the whole corridor argument is about.
const NEWMARKET = { lat: 44.0592, lng: -79.4613 };
const THORNHILL = { lat: 43.8100, lng: -79.4200 };
const PAIR_KEY = "44.0592,-79.4613|43.8100,-79.4200";

// A fresh module instance — distance.js memoizes both caches for the life
// of the process, which is right in production and useless in a test that
// needs to see a cold load.
function freshDistance() {
  delete require.cache[require.resolve(MODULE)];
  return require(MODULE);
}

const abortError = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

// Google that never answers. With no signal (the old code) this promise
// never settles — which is exactly the production symptom.
let calls = 0;
const hangingFetch = (_url, opts = {}) => new Promise((_resolve, reject) => {
  calls += 1;
  const signal = opts.signal;
  if (!signal) return;
  if (signal.aborted) { reject(abortError()); return; }
  signal.addEventListener("abort", () => reject(abortError()));
});

const respondingFetch = (body) => async () => {
  calls += 1;
  return { json: async () => body };
};

const googleSays = (seconds) => ({
  status: "OK",
  rows: [{ elements: [{ status: "OK", duration: { value: seconds } }] }]
});
const googleRefuses = { status: "OVER_QUERY_LIMIT", rows: [] };

const writeCache = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
const readCache = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8") || "{}") : {});
const settle = () => new Promise((r) => setTimeout(r, 150));

try {
  process.env.GOOGLE_MAPS_SERVER_KEY = "test-key-not-a-real-key";

  // ---- 1 + 2. A Google that never answers ---------------------------
  {
    writeCache(CACHE, {});
    globalThis.fetch = hangingFetch;
    calls = 0;
    const distance = freshDistance();
    const started = Date.now();
    const answer = await Promise.race([
      distance.travelMinutes(NEWMARKET, THORNHILL),
      new Promise((r) => setTimeout(() => r("HUNG"), 20000))
    ]);
    const elapsed = Date.now() - started;
    ok("a Google that never answers is abandoned, and a number still comes back",
      answer !== "HUNG" && Number.isFinite(answer), `got ${answer} after ${elapsed}ms`);
    ok("…within the 4s-per-attempt budget, not whenever Google feels like it",
      elapsed < 12000, `${elapsed}ms`);
    ok("…having tried twice before giving up", calls === 2, `${calls} calls`);
    await settle();
    ok("…and the abandoned pair is NOT cached, so it is asked again later",
      readCache(CACHE)[PAIR_KEY] === undefined, JSON.stringify(readCache(CACHE)).slice(0, 120));
  }

  // ---- 3. A definitive refusal is not cached either -------------------
  {
    writeCache(CACHE, {});
    globalThis.fetch = respondingFetch(googleRefuses);
    calls = 0;
    const distance = freshDistance();
    const guess = await distance.travelMinutes(NEWMARKET, THORNHILL);
    ok("an over-quota Google still yields a usable estimate", Number.isFinite(guess) && guess > 0, `${guess}`);
    ok("…asked once, not retried — a definitive answer does not improve on a second ask",
      calls === 1, `${calls} calls`);
    await settle();
    ok("…and the estimate is not written to the cache",
      readCache(CACHE)[PAIR_KEY] === undefined);

    // The point of not caching it: the very next call, with Google
    // healthy, must return GOOGLE'S number rather than the guess.
    globalThis.fetch = respondingFetch(googleSays(88 * 60));
    const real = await distance.travelMinutes(NEWMARKET, THORNHILL);
    ok("…so the next call returns Google's real number, not yesterday's guess",
      real === 88, `${real}`);
  }

  // ---- 4. The poisoned entries already on disk ------------------------
  {
    // A bare number is what every entry written under the old rule looks
    // like. It carries no provenance, so it cannot be trusted and cannot
    // be repaired — only dropped.
    writeCache(CACHE, { [PAIR_KEY]: 999, "0.0000,0.0000|1.0000,1.0000": 5 });
    globalThis.fetch = respondingFetch(googleSays(88 * 60));
    calls = 0;
    const distance = freshDistance();
    const answer = await distance.travelMinutes(NEWMARKET, THORNHILL);
    ok("an unprovenanced cache entry is not served", answer === 88, `${answer}`);
    ok("…Google was actually asked", calls === 1, `${calls} calls`);
    await settle();
    const onDisk = readCache(CACHE);
    ok("…and the whole unprovenanced file is purged from disk, not just the pair read",
      onDisk["0.0000,0.0000|1.0000,1.0000"] === undefined, JSON.stringify(onDisk).slice(0, 160));
  }

  // ---- 5. A real answer is cached, with provenance --------------------
  {
    writeCache(CACHE, {});
    globalThis.fetch = respondingFetch(googleSays(88 * 60));
    calls = 0;
    const distance = freshDistance();
    await distance.travelMinutes(NEWMARKET, THORNHILL);
    await settle();
    const entry = readCache(CACHE)[PAIR_KEY];
    ok("a real Google answer is cached", entry != null, JSON.stringify(readCache(CACHE)).slice(0, 120));
    ok("…as an answer, not a bare number: it says where it came from",
      entry && typeof entry === "object" && entry.source === "google" && entry.minutes === 88,
      JSON.stringify(entry));
    ok("…and is served from cache without asking Google twice",
      (await distance.travelMinutes(NEWMARKET, THORNHILL)) === 88 && calls === 1, `${calls} calls`);
  }

  // ---- 6. The unfloored path obeys the same rules ---------------------
  // travelMinutesRaw is what the re-sequencer orders the day on. A cached
  // straight-line guess there reorders the whole route.
  {
    writeCache(RAW_CACHE, { [PAIR_KEY]: 999 });
    globalThis.fetch = respondingFetch(googleSays(90));
    calls = 0;
    const distance = freshDistance();
    const raw = await distance.travelMinutesRaw(NEWMARKET, THORNHILL);
    ok("the unfloored path ignores an unprovenanced entry too", raw === 1.5, `${raw}`);
    ok("…and keeps its fraction rather than flooring it", raw < 5);
    await settle();
    const entry = readCache(RAW_CACHE)[PAIR_KEY];
    ok("…caching the real answer with provenance",
      entry && entry.source === "google" && entry.minutes === 1.5, JSON.stringify(entry));

    globalThis.fetch = respondingFetch(googleRefuses);
    writeCache(RAW_CACHE, {});
    const distance2 = freshDistance();
    const guess = await distance2.travelMinutesRaw(NEWMARKET, THORNHILL);
    ok("…and a refused lookup is estimated, never stored", Number.isFinite(guess) && guess > 0, `${guess}`);
    await settle();
    ok("…leaving the unfloored cache clean", readCache(RAW_CACHE)[PAIR_KEY] === undefined);
  }

  // ---- 7. No key: pure arithmetic, no call, no cache ------------------
  {
    delete process.env.GOOGLE_MAPS_SERVER_KEY;
    writeCache(CACHE, {});
    globalThis.fetch = respondingFetch(googleSays(60));
    calls = 0;
    const distance = freshDistance();
    const guess = await distance.travelMinutes(NEWMARKET, THORNHILL);
    ok("with no key configured Google is not called at all", calls === 0, `${calls} calls`);
    ok("…an estimate is still returned", Number.isFinite(guess) && guess >= 5, `${guess}`);
    await settle();
    ok("…and nothing is written to the cache for a later run to trust",
      readCache(CACHE)[PAIR_KEY] === undefined);
  }
} finally {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.GOOGLE_MAPS_SERVER_KEY;
  else process.env.GOOGLE_MAPS_SERVER_KEY = realKey;
  for (const [p, buf] of backups) {
    if (buf === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, buf);
  }
}

if (failures.length) {
  console.error(`\n✗ test-distance-fail-open: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-distance-fail-open: ${passed} assertions passed`);
