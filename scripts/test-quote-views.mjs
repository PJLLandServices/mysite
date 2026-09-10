#!/usr/bin/env node
// scripts/test-quote-views.mjs — Quote View Tracker ledger tests (FLOW-21).
//
//   1. logView persists an entry with the right fields
//   2. bad input is a silent no-op (never throws, never writes junk)
//   3. dedupe: same quote+kind+ip inside the window folds into the existing
//      entry; a different ip / kind / an out-of-window repeat appends
//   4. summarize(): counts, first/last, `opened` only for content kinds
//   5. stuckAtGate — the signal the whole feature exists for: challenged
//      and never unlocked. Must be FALSE for a quote nobody ever opened,
//      and FALSE once they get in by any route.
//   6. summaryFor(): events newest-first; summaryMap(): every quote
//   7. pruning: age cutoff + entry-count cap
//
// Isolation: quote-views resolves its store as `<lib>/../data/quote-views
// .json` and requires nothing else, so a temp sandbox with lib/ + data/ is
// the whole fixture.
//
// Run: node scripts/test-quote-views.mjs   (also in `npm run build:check`)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let passed = 0, failed = 0;
const ok = (c, label) => { if (c) passed += 1; else { failed += 1; console.error("  FAIL:", label); } };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-quote-views-"));
fs.mkdirSync(path.join(SB, "lib"), { recursive: true });
fs.mkdirSync(path.join(SB, "data"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "server", "lib", "quote-views.js"), path.join(SB, "lib", "quote-views.js"));

const require = createRequire(import.meta.url);
const views = require(path.join(SB, "lib", "quote-views.js"));
const FILE = path.join(SB, "data", "quote-views.json");

const read = () => JSON.parse(fs.readFileSync(FILE, "utf8"));
const write = (rows) => fs.writeFileSync(FILE, JSON.stringify(rows, null, 2) + "\n", "utf8");
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60 * 1000;

// 1 — persistence
{
  await views.logView({ quoteId: "Q-2026-0075", kind: "gate_challenge", ip: "1.2.3.4", userAgent: "Safari/iPhone" });
  const rows = read();
  ok(rows.length === 1, "one entry persisted");
  ok(rows[0].quoteId === "Q-2026-0075", "quoteId recorded");
  ok(rows[0].kind === "gate_challenge", "kind recorded");
  ok(rows[0].ip === "1.2.3.4" && rows[0].userAgent === "Safari/iPhone", "ip + ua recorded");
  ok(rows[0].repeats === 0 && rows[0].lastTs === rows[0].ts, "fresh entry: repeats 0, lastTs === ts");
}

// 2 — bad input never throws and never writes
{
  await views.logView({ quoteId: "", kind: "document" });
  await views.logView({ quoteId: "Q-1", kind: "not_a_kind" });
  await views.logView({});
  await views.logView();
  ok(read().length === 1, "invalid inputs wrote nothing");
}

// 3 — dedupe
{
  await views.logView({ quoteId: "Q-2026-0075", kind: "gate_challenge", ip: "1.2.3.4", userAgent: "Safari/iPhone" });
  let rows = read();
  ok(rows.length === 1 && rows[0].repeats === 1, "same quote+kind+ip in window folds, bumping repeats");
  const firstTs = rows[0].ts;

  await views.logView({ quoteId: "Q-2026-0075", kind: "gate_challenge", ip: "9.9.9.9" });
  ok(read().length === 2, "different ip appends");

  await views.logView({ quoteId: "Q-2026-0075", kind: "sign_page", ip: "1.2.3.4" });
  ok(read().length === 3, "different kind appends");

  // Age the original entry past the dedupe window — the next identical
  // view is a NEW session, not the same one.
  rows = read();
  rows[0].ts = iso(45 * MIN);
  rows[0].lastTs = iso(45 * MIN);
  write(rows);
  await views.logView({ quoteId: "Q-2026-0075", kind: "gate_challenge", ip: "1.2.3.4" });
  ok(read().length === 4, "out-of-window repeat appends as a new session");
  ok(firstTs !== read()[3].ts, "the new session carries its own timestamp");
}

// 4 + 5 — summarize, and the stuckAtGate signal
{
  // (a) never opened at all
  const none = views.summarize("Q-NOTHING", []);
  ok(none.count === 0 && none.opened === false, "unopened quote: no count, not opened");
  ok(none.stuckAtGate === false, "unopened quote is NOT 'stuck at gate' (nothing was tried)");
  ok(none.firstAt === null && none.lastAt === null, "unopened quote has no timestamps");

  // (b) challenged, never got in — the case the tracker exists for.
  // Timestamps are pinned to consts: iso() reads the clock on every call,
  // so building the fixture and the expectation separately compares two
  // values milliseconds apart.
  const firstChallenge = iso(60 * MIN);
  const stuck = views.summarize("Q-A", [
    { quoteId: "Q-A", kind: "gate_challenge", ts: firstChallenge, lastTs: iso(58 * MIN), ip: "5.5.5.5", repeats: 2 },
    { quoteId: "Q-A", kind: "gate_challenge", ts: iso(20 * MIN), lastTs: iso(20 * MIN), ip: "5.5.5.5", repeats: 0 }
  ]);
  ok(stuck.stuckAtGate === true, "challenged twice, never unlocked → stuckAtGate");
  ok(stuck.opened === false, "gate challenge alone is not 'opened'");
  ok(stuck.count === 2, "counts deduped sessions, not raw repeats");
  ok(stuck.gateChallengedAt === firstChallenge, "gateChallengedAt is the FIRST challenge");
  ok(stuck.lastIp === "5.5.5.5", "lastIp from the newest entry");

  // (c) got through the gate
  const unlockedAt = iso(59 * MIN);
  const openedAt = iso(58 * MIN);
  const readUntil = iso(50 * MIN);
  const through = views.summarize("Q-B", [
    { quoteId: "Q-B", kind: "gate_challenge", ts: iso(60 * MIN), lastTs: iso(60 * MIN), ip: "6.6.6.6", repeats: 0 },
    { quoteId: "Q-B", kind: "gate_unlocked", ts: unlockedAt, lastTs: unlockedAt, ip: "6.6.6.6", repeats: 0 },
    { quoteId: "Q-B", kind: "document", ts: openedAt, lastTs: readUntil, ip: "6.6.6.6", repeats: 3 }
  ]);
  ok(through.stuckAtGate === false, "unlocked → not stuck");
  ok(through.opened === true, "document view counts as opened");
  ok(through.gateUnlockedAt === unlockedAt, "gateUnlockedAt recorded");
  ok(through.firstOpenedAt === openedAt, "firstOpenedAt is the first content view");
  ok(through.lastAt === readUntil, "lastAt tracks lastTs, not ts (a long read session)");
  ok(through.byKind.document.count === 1 && through.byKind.gate_unlocked.count === 1, "byKind counts");

  // (d) a proposal with no phone gate at all: sign_page only, still opened
  const ungated = views.summarize("Q-C", [
    { quoteId: "Q-C", kind: "sign_page", ts: iso(10 * MIN), lastTs: iso(10 * MIN), ip: "7.7.7.7", repeats: 0 }
  ]);
  ok(ungated.opened === true && ungated.stuckAtGate === false, "ungated quote: opened, never stuck");

  // (e) PDF download alone is a real open (the print-to-sign path)
  const pdfOnly = views.summarize("Q-D", [
    { quoteId: "Q-D", kind: "pdf", ts: iso(5 * MIN), lastTs: iso(5 * MIN), ip: "8.8.8.8", repeats: 0 }
  ]);
  ok(pdfOnly.opened === true, "pdf download counts as opened");

  // (f) entries for OTHER quotes never leak into a summary
  const isolated = views.summarize("Q-A", [
    { quoteId: "Q-A", kind: "sign_page", ts: iso(5 * MIN), lastTs: iso(5 * MIN), ip: "1.1.1.1", repeats: 0 },
    { quoteId: "Q-Z", kind: "document", ts: iso(4 * MIN), lastTs: iso(4 * MIN), ip: "2.2.2.2", repeats: 0 }
  ]);
  ok(isolated.count === 1 && isolated.lastIp === "1.1.1.1", "summary is scoped to its own quoteId");
}

// 6 — summaryFor / summaryMap over the real store
{
  write([
    { quoteId: "Q-X", kind: "gate_challenge", ts: iso(30 * MIN), lastTs: iso(30 * MIN), ip: "1.1.1.1", repeats: 0 },
    { quoteId: "Q-X", kind: "document", ts: iso(10 * MIN), lastTs: iso(9 * MIN), ip: "1.1.1.1", repeats: 1 },
    { quoteId: "Q-Y", kind: "sign_page", ts: iso(20 * MIN), lastTs: iso(20 * MIN), ip: "3.3.3.3", repeats: 0 }
  ]);
  const one = await views.summaryFor("Q-X");
  ok(one.count === 2 && one.opened === true, "summaryFor rolls up the right quote");
  ok(one.events.length === 2, "summaryFor returns raw events");
  ok(one.events[0].kind === "document", "events are newest-first");
  ok(one.events[0].repeats === 1, "event repeats surfaced");

  const missing = await views.summaryFor("Q-NOPE");
  ok(missing.count === 0 && missing.events.length === 0, "summaryFor on an unseen quote is empty, not an error");

  const map = await views.summaryMap();
  ok(Object.keys(map).length === 2, "summaryMap covers every quote with views");
  ok(map["Q-X"].opened === true && map["Q-Y"].opened === true, "summaryMap entries are summaries");
  ok(!map["Q-NOPE"], "summaryMap omits quotes with no views");
}

// 7 — pruning
{
  // Age cutoff: an entry older than retention is dropped on the next write.
  write([
    { quoteId: "Q-OLD", kind: "document", ts: iso(500 * 24 * 60 * MIN), lastTs: iso(500 * 24 * 60 * MIN), ip: "1.1.1.1", repeats: 0 },
    { quoteId: "Q-NEW", kind: "document", ts: iso(MIN), lastTs: iso(MIN), ip: "2.2.2.2", repeats: 0 }
  ]);
  await views.logView({ quoteId: "Q-TRIGGER", kind: "sign_page", ip: "3.3.3.3" });
  const rows = read();
  ok(!rows.some((r) => r.quoteId === "Q-OLD"), "entries past retention are pruned");
  ok(rows.some((r) => r.quoteId === "Q-NEW"), "in-retention entries survive");

  // Entry-count cap: oldest go first.
  const many = [];
  for (let i = 0; i < 5200; i += 1) {
    many.push({ quoteId: `Q-${i}`, kind: "sign_page", ts: iso((5200 - i) * 1000), lastTs: iso((5200 - i) * 1000), ip: "4.4.4.4", repeats: 0 });
  }
  write(many);
  await views.logView({ quoteId: "Q-LAST", kind: "sign_page", ip: "5.5.5.5" });
  const capped = read();
  ok(capped.length <= 5000, `entry cap enforced (${capped.length} <= 5000)`);
  ok(capped[capped.length - 1].quoteId === "Q-LAST", "newest entry survives the cap");
  ok(!capped.some((r) => r.quoteId === "Q-0"), "oldest entries dropped first");
}

fs.rmSync(SB, { recursive: true, force: true });

console.log(`\nquote-views: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
