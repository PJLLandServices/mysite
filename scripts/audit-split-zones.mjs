#!/usr/bin/env node
// scripts/audit-split-zones.mjs
//
// Which saved projects contain a split zone, what each split's
// shared-station status rests on, and what separating it would cost.
//
//   node scripts/audit-split-zones.mjs [--data server/data] [--json]
//
// READ-ONLY, AND MEANT TO BE PROVABLE
//
// This is run against production data, so "it doesn't write anything"
// cannot be a claim in a comment. The script opens files with
// readFileSync and nothing else: there is no writeFile, no mkdir, no
// rename, no unlink, no fetch, no child process, and it never touches the
// projects it reads. `scripts/test-audit-split-zones.mjs` asserts that by
// scanning this file for every write-shaped call, so the guarantee fails
// loudly if somebody adds one later.
//
// WHAT IT REPORTS, AND WHAT IT DELIBERATELY DOES NOT
//
//   project id · project name · design version
//   every split area, by name
//   whether its shared-station status is EXPLICIT or LEGACY-ASSUMED
//   controller stations now
//   controller stations if every legacy-assumed split were separated
//   whether an accepted proposal exists
//
// It does NOT emit customer names, emails, telephone numbers, addresses,
// invoice or payment information, quote totals, or internal notes — none
// of which the question needs. The project NAME is included because it is
// how Patrick identifies a job; if that is too much for a given use, pipe
// through --json and drop the field.
//
// WHY A SPLIT'S STATUS MATTERS
//
// Before design version 9 the builder could not record whether a split
// zone's two valves shared one controller station — every split behaved as
// one. Those designs still load that way, so nothing about them has moved;
// but "unchanged" there means "still carrying an assumption nobody made".
// LEGACY-ASSUMED marks exactly those.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const E = require(path.join(ROOT, "server", "sitebuilder-engine.js"));

const argv = process.argv.slice(2);
const dataDir = argv.includes("--data") ? argv[argv.indexOf("--data") + 1] : path.join(ROOT, "server", "data");
const asJson = argv.includes("--json");
const projectsFile = path.join(dataDir, "projects.json");
const quotesFile = path.join(dataDir, "quotes.json");

if (!fs.existsSync(projectsFile)) {
  console.error(`\nNo projects file at ${projectsFile}`);
  console.error(`Run this where the data lives, or pass --data <dir>.`);
  console.error(`(server/data is gitignored, so it is never present in a fresh checkout.)\n`);
  process.exit(2);
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const asList = (raw, key) => (Array.isArray(raw) ? raw : ((raw && raw[key]) || []));

const projects = asList(readJson(projectsFile), "projects");
const quotes = asList(readJson(quotesFile), "quotes");
const quoteStatus = new Map(quotes.map((q) => [q && q.id, q && q.status]));

/** Run the engine over a saved design. Returns null if it cannot be read. */
function analyse(design) {
  try {
    const areas = JSON.parse(JSON.stringify(design.areas));
    // Migrate the stored splits the SAME way opening the project does.
    // Without this the audit hands raw version-8 routing to an engine that
    // honours `shareStation`, reads every flagless split as separate, and
    // reports a station count nobody would ever see on screen. The rule is
    // the engine's, not a second copy of it.
    const routing = E.migrateRoutingSplits(design.routing || {}, design.version);
    const valveGroupModes = JSON.parse(JSON.stringify(design.valveGroupModes || {}));
    const ceiling = parseFloat((design.inputs || {}).ceiling) || 0;
    const spacingFactor = (design.inputs || {}).spacingFactor;
    const plans = areas.map((a) => ({ area: a, plan: E.computePlan(a, { ceiling, spacingFactor }) }));
    const zones = E.computeZonePlan({ plans, areas, routing, valveGroupModes, ceiling });
    const stations = E.stationCount(zones);

    // Which splits ACTUALLY produced two halves. A line drawn past every
    // head on one side leaves the zone whole, and that split costs nothing
    // to separate because there is nothing to separate. Counting stored
    // split lines instead of realised halves would overstate the work.
    const halves = new Map();
    for (const z of zones) {
      if (!z.half) continue;
      const k = E.baseKey(z.key);
      if (!halves.has(k)) halves.set(k, []);
      halves.get(k).push(z);
    }
    const sharedSplits = [...halves.entries()]
      .filter(([, hs]) => hs.length === 2 && hs[0].station === hs[1].station)
      .map(([k]) => k);
    return { stations, valves: zones.length, applied: new Set(halves.keys()), sharedSplits };
  } catch { return null; }
}

const rows = [];
for (const p of projects) {
  const d = p && p.systemDesign;
  if (!d || !Array.isArray(d.areas)) continue;

  const splitEntries = [];
  for (const [, r] of Object.entries(d.routing || {})) {
    for (const [key, sp] of Object.entries((r && r.splits) || {})) {
      if (sp) splitEntries.push([key, sp]);
    }
  }
  if (!splitEntries.length) continue;

  const version = Number(d.version) || 0;
  const byAid = new Map(d.areas.map((a) => [a.aid, a]));
  const info = analyse(d);

  // An accepted proposal is the frozen snapshot on the project, or a
  // linked quote the quote store says is accepted. Only the state word
  // leaves this script — no totals, no line items, no customer.
  const snapshotAccepted = !!(p.proposalSnapshot && p.proposalSnapshot.acceptedAt);
  const linkedState = quoteStatus.get(d.linkedQuoteId) || null;
  const proposal = snapshotAccepted || linkedState === "accepted" ? "ACCEPTED"
    : linkedState === "sent" || linkedState === "pending_admin_attestation" ? "sent"
    : linkedState ? linkedState : "none";

  for (const [key, sp] of splitEntries) {
    const aid = String(key).split(":")[1] || "";
    const area = byAid.get(aid);
    const explicit = typeof sp.shareStation === "boolean" && version >= 9;
    const legacy = !explicit;
    rows.push({
      project: p.id,
      name: p.name || "",
      version,
      area: area ? (area.name || aid) : `(area ${aid} no longer in the design)`,
      family: area ? area.family : "",
      status: explicit ? (sp.shareStation ? "explicit: shared" : "explicit: separate") : "LEGACY-ASSUMED shared",
      legacy,
      applies: info ? info.applied.has(key) : null,
      stationsNow: info ? info.stations : null,
      stationsIfSeparated: info ? info.stations + info.sharedSplits.length : null,
      valves: info ? info.valves : null,
      proposal
    });
  }
}

// ── Refuse to print anything that looks personal ─────────────────────
const text = JSON.stringify(rows);
const SNIFF = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "an email address"],
  [/(\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}/, "a phone number"],
  [/\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/, "a postal code"],
  [/\bI-\d{4}-\d{4}\b/, "an invoice number"]
];
const hits = SNIFF.filter(([re]) => re.test(text));
if (hits.length) {
  console.error(`\nSTOPPED — the report would contain ${hits.map((h) => h[1]).join(" and ")}.`);
  console.error(`Almost certainly a project or area NAME carries it. Nothing has been printed.\n`);
  process.exit(3);
}

if (asJson) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }

const bar = (c = "─") => c.repeat(104);
const w = (s, n) => String(s == null ? "" : s).slice(0, n).padEnd(n);

console.log(`\n${bar("═")}`);
console.log("SAVED PROJECTS CONTAINING SPLIT ZONES — read-only audit");
console.log(bar("═"));
console.log(`  ${projects.length} project(s) read from ${projectsFile}`);
if (!rows.length) { console.log(`\n  No split zones in any saved design. Nothing to review.\n`); process.exit(0); }

const needs = rows.filter((r) => r.legacy);
console.log(`  ${rows.length} split zone(s) across ${new Set(rows.map((r) => r.project)).size} project(s)`);
console.log(`  ${needs.length} legacy-assumed, needing confirmation\n`);
console.log(bar());
console.log(`  ${w("project", 17)}${w("job", 22)}${w("v", 3)}${w("split area", 22)}${w("status", 23)}${w("now", 5)}${w("sep", 5)}proposal`);
console.log(bar());
let last = null;
for (const r of rows.sort((a, b) => String(a.project).localeCompare(String(b.project)) || a.area.localeCompare(b.area))) {
  const first = r.project !== last; last = r.project;
  console.log(`  ${w(first ? r.project : "", 17)}${w(first ? r.name : "", 22)}${w(first ? r.version : "", 3)}` +
              `${w(r.area, 22)}${w(r.status, 23)}${w(r.stationsNow, 5)}${w(r.stationsIfSeparated, 5)}` +
              `${first ? r.proposal : ""}` +
              `${r.applies === false ? "   (line misses the zone — no halves)" : ""}`);
}
console.log(bar());
console.log(`  now = controller stations as the builder computes them today`);
console.log(`  sep = controller stations if every legacy-assumed split on that job were separated`);
if (needs.length) {
  console.log(`\n  A LEGACY-ASSUMED split loads as ONE controller station, exactly as it always`);
  console.log(`  has, so none of these jobs has changed. But that was the only behaviour the`);
  console.log(`  builder had, not a decision anybody recorded. Confirm each one.`);
  console.log(`  Jobs marked ACCEPTED have a signed proposal — decide those deliberately.\n`);
}
