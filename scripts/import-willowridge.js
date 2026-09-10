#!/usr/bin/env node
//
// One-shot: create the Willowridge Landscaping Group Homes customer and its
// 14 properties, from Patrick's 2024 site list.
//
// Usage:
//   node scripts/import-willowridge.js --geocode-only   (PILOT — live geocode, no records)
//   node scripts/import-willowridge.js                  (DRY RUN — cache only, no network)
//   node scripts/import-willowridge.js --apply          (creates the records)
//
// THREE MODES, in the order you'd use them:
//
// --geocode-only is the PILOT. It runs all 14 addresses through the REAL
// geocoder — the same geocode() the import and the booking form use — and
// prints what comes back for each: the coordinates, the address Google
// resolved them to, and whether the answer was already cached. It creates NO
// customer and NO properties. Its only side effect is the geocode cache
// (geocode-cache.json), which is exactly what you want: every address proved
// here is then free and instant when the real import runs. This is the mode
// that answers "does the geocoder actually work on these addresses".
//
// DRY RUN resolves from the on-disk geocode cache ONLY. No network calls, no
// API quota, no writes of any kind. Run it AFTER the pilot to see the full
// per-property plan — every field that would be written — using the
// coordinates the pilot already proved. Anything not yet cached shows as
// "not cached" rather than being looked up.
//
// --apply backs up customers.json + properties.json + geocode-cache.json to
//   server/data/BACKUP-<UTC stamp>-willowridge/
// before touching anything, then creates the customer and the 14 properties.
//
// WHY A SCRIPT AND NOT THE XLSX IMPORT UI:
// properties.bulkUpsert() matches an incoming row to an existing property by
// (email + address), and when that misses it falls back to "if this email has
// exactly one property, that's the one" (lib/properties.js:1226). Fourteen
// sites under ONE customer defeat that: row 1 creates a property, rows 2-14
// each find exactly one property on the same email and UPDATE it. All fourteen
// collapse into one record carrying the first row's data. The import UI also
// builds at most ONE valve box per row and coerces a missing count to 1
// (properties-import.js:226) — three of these sites have two boxes and six
// have no recorded count. And bulkUpsert never sets customerId, so the records
// would not be linked to the customer at all.
//
// This script uses the create path instead: customers.create() once, then
// properties.create() + properties.update() per site. That sets customerId,
// and update()'s system merge takes the valveBoxes array verbatim.
//
// ⚠️  THE PJL_BASE TRAP — the most important check in this file.
// geocode() NEVER returns null and NEVER throws. On EVERY failure path (no API
// key, ZERO_RESULTS, network error, empty address) it returns
// `{ ok: false, skipped: true, coords: PJL_BASE }` where PJL_BASE is the
// Newmarket depot, 44.0592/-79.4613. Writing geo.coords without checking would
// stamp the depot onto every unresolvable property — and a sanity-box check
// CANNOT catch it, because PJL_BASE is the exact centre of the box. Hence
// isRealResult() below, which demands ok === true AND a source that is not
// "pjl-base". A property that won't resolve is written with coords: null.
// Missing is recoverable; wrong is not.
//
// ZONES ARE DELIBERATELY NOT SET. system.zones stays [] and system.zoneCount
// stays null on all fourteen, per Patrick's instruction: the valve total is
// probably the zone count, but that is to be confirmed on the first visit
// rather than inferred from a two-year-old sheet. See the note at the bottom
// of this file for what that costs on the pricing surfaces.

const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "server", "data");
const CUSTOMERS_PATH = path.join(DATA, "customers.json");
const PROPERTIES_PATH = path.join(DATA, "properties.json");

const customers = require(path.join(ROOT, "server", "lib", "customers"));
const properties = require(path.join(ROOT, "server", "lib", "properties"));
const { geocode, isConfigured, PJL_BASE } = require(path.join(ROOT, "server", "lib", "geocode"));

const APPLY = process.argv.includes("--apply");
// The pilot: exercise the real geocoder, create nothing.
const GEOCODE_ONLY = process.argv.includes("--geocode-only");
// Only these two modes may touch the network. A bare dry run is cache-only,
// so it can be run freely without spending quota or waiting on the API.
const LIVE_GEOCODE = APPLY || GEOCODE_ONLY;

const CUSTOMER_NAME = "Willowridge Landscaping Group Homes";
// Contact details, per Patrick 2026-08-27. The phone is a deliberate
// placeholder — there is no single number for the account — and exists only
// so the record has a phone-shaped value. Nothing will ever dial it: every
// outreach channel is opted out below, and outreach is the only thing that
// auto-sends to these fields.
const CUSTOMER_EMAIL = "willowridgelandscaping@email.com";
const CUSTOMER_PHONE = "123-123-1234";

// Willowridge is not billed per service — the work is covered by their
// arrangement, not quoted per visit. A $0 per-property override is how this
// schema expresses that: resolveSeasonalPrice() returns it with
// source "property_override", so spring/fall WOs seed a $0 baseline line
// instead of a tier price. It also sidesteps the residential-tier defect
// noted at the bottom of this file, which would otherwise have seeded $90.
const SEASONAL_PRICING = { springOpeningPrice: 0, fallClosingPrice: 0 };

// Opt out of every outbound channel. These flags are read ONLY by
// lib/outreach.js (verified: availability.js, schedule-store.js,
// work-orders.js and bookings.js never reference them), so this suppresses
// messaging without touching scheduling or routing in any way.
//
// NOTE the deliberate split with seasonalEligibility, which is left at its
// default of TRUE on both seasons:
//   commPrefs = false          -> the property still appears in the
//                                 /admin/outreach fall list for planning and
//                                 routing, but every send skips it as
//                                 opted_out_sms / opted_out_email.
//   seasonalEligibility = false -> the property would vanish from that list
//                                 entirely (outreach.js:280).
// Patrick asked to navigate fall closings for these AND to stop the
// messages, so they stay visible and get muted. Flip seasonalEligibility to
// false here if they should disappear from the list too.
const COMM_PREFS = {
  seasonalRemindersSMS: false,
  seasonalRemindersEmail: false,
  reviewRequestsEmail: false
};

// 200ms between live API calls — ample for 14 records, avoids burst throttling.
const RATE_LIMIT_MS = 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Flag anything landing within this many metres of the depot pin. A real
// property this close to the Newmarket depot would itself be worth a look,
// so a false positive here is cheap and a miss is not.
const DEPOT_FLAG_METERS = 500;

// ---- The site list ---------------------------------------------------
//
// Addresses are formatted "<street>, <city>, ON <postal>, Canada" per the
// brief. valveCount: null means the 2024 sheet recorded a box location but
// no count — NOT zero. Unknown and none are different things, and a zero
// would quote as free.
//
// Notes are prefixed "2024 site list:" so they cannot later be misread as
// current condition. Drop the prefix here if that reads as clutter.

const SITES = [
  {
    address: "28 Thickwood Blvd, Stouffville, ON L4A 1K1, Canada",
    blowoutLocation: "Left side with backflow",
    shutoffLocation: "Basement by water meter",
    controllerLocation: "Garage",
    valveBoxes: [{ location: "Right side", valveCount: 2, notes: "" }],
    notes: "2024 site list: Backflow ball valve requires replacement."
  },
  {
    address: "9 Sir Kay Dr, Markham, ON L3P 2Y9, Canada",
    blowoutLocation: "Right side with backflow",
    shutoffLocation: "Above freezer in basement",
    controllerLocation: "Above freezer with shut-off",
    valveBoxes: [
      { location: "Right side front", valveCount: 1, notes: "" },
      { location: "Right side backyard", valveCount: 2, notes: "" }
    ],
    notes: "2024 site list: Copper repair completed June 6. Not tested — system not running."
  },
  {
    address: "24 James Speight Rd, Markham, ON L3P 3G4, Canada",
    blowoutLocation: "Right side",
    shutoffLocation: "Furnace room (¾\") by orange pipe",
    controllerLocation: "Garage",
    valveBoxes: [
      { location: "Right side front", valveCount: 2, notes: "" },
      { location: "Right side rear", valveCount: 2, notes: "" }
    ],
    notes: "2024 site list: Backflow rebuild kit required."
  },
  {
    address: "24 Fanshawe Dr, Richmond Hill, ON L4B 1P6, Canada",
    blowoutLocation: "Left side",
    shutoffLocation: "Basement centre",
    controllerLocation: "Basement",
    valveBoxes: [{ location: "Left side", valveCount: 1, notes: "" }],
    notes: "2024 site list: Backflow rebuild kit required."
  },
  {
    address: "180 Valleymede Dr, Richmond Hill, ON L4B 3J4, Canada",
    blowoutLocation: "North side",
    shutoffLocation: "Existing water meter, north basement",
    controllerLocation: "Garage",
    valveBoxes: [{ location: "North side", valveCount: 2, notes: "" }],
    notes: "2024 site list: Windows being replaced, not opened."
  },
  {
    address: "376 Balkan Rd, Richmond Hill, ON L4C 2P1, Canada",
    blowoutLocation: "Left front",
    shutoffLocation: "Beside furnace",
    controllerLocation: "Beside furnace",
    valveBoxes: [{ location: "Left front", valveCount: null, notes: "Valve count not recorded on the 2024 sheet." }],
    notes: "2024 site list: Backflow rebuild kit required. 2× leaking heads, some not retracting automatically."
  },
  {
    address: "15 Leno Mills Ave, Richmond Hill, ON L4S 1J3, Canada",
    blowoutLocation: "Right side",
    shutoffLocation: "Basement furnace room",
    controllerLocation: "Basement furnace room",
    valveBoxes: [{ location: "Right side", valveCount: null, notes: "Valve count not recorded on the 2024 sheet." }],
    notes: "2024 site list: Bleeder on backflow requires replacing. 2× heads not retracting."
  },
  {
    address: "47 Cooperage Cres, Richmond Hill, ON L4C 9L6, Canada",
    blowoutLocation: "Front walkway",
    shutoffLocation: "Basement under garage",
    controllerLocation: "Garage",
    valveBoxes: [{ location: "Right side", valveCount: 2, notes: "" }],
    notes: "2024 site list: Backflow rebuild kit required."
  },
  {
    address: "93 Oxford St, Richmond Hill, ON L4C 4L6, Canada",
    blowoutLocation: "Left side",
    shutoffLocation: "Lower basement beside window",
    controllerLocation: "Cold room",
    valveBoxes: [{ location: "Left front", valveCount: null, notes: "Valve count not recorded on the 2024 sheet." }],
    notes: "2024 site list: 50 ft mainline installed. Water not turned on, system not tested."
  },
  {
    address: "25 Brillinger St, Richmond Hill, ON L4C 8Y5, Canada",
    blowoutLocation: "Right side",
    shutoffLocation: "Furnace room",
    controllerLocation: "Cold room",
    valveBoxes: [{ location: "Front right", valveCount: 2, notes: "" }],
    notes: "2024 site list: Backflow rebuild kit may be required. 3× heads in backyard with heavy puddling, could use replacement."
  },
  {
    address: "9655 Bathurst St, Richmond Hill, ON L4C 3X4, Canada",
    blowoutLocation: "Left side door",
    shutoffLocation: "Sprinkler room",
    controllerLocation: "Joe's office",
    valveBoxes: [{ location: "Front middle", valveCount: null, notes: "Valve count not recorded on the 2024 sheet." }],
    // The "access through the side door" instruction is site access, not a
    // blow-out location — it belongs in the system notes, not in the field a
    // tech reads as "where is the blow-out point".
    notes: "2024 site list: Access all sprinkler components through the side door. Not yet turned on."
  },
  {
    address: "39 Linda Margaret Cres, Richmond Hill, ON L4S 2B6, Canada",
    blowoutLocation: "Left side",
    shutoffLocation: "Sprinkler room, beside orange pipe",
    controllerLocation: "Garage",
    valveBoxes: [{ location: "Left side front", valveCount: null, notes: "Valve count not recorded on the 2024 sheet." }],
    notes: "2024 site list: June 6 — replaced ¾\" male adapter at backflow, system up and running."
  },
  {
    address: "8 Blackforest Dr, Richmond Hill, ON L4E 2P6, Canada",
    blowoutLocation: "Right side",
    shutoffLocation: "Basement (labeled)",
    controllerLocation: "Basement",
    valveBoxes: [{ location: "Right front lawn", valveCount: null, notes: "Valve count not recorded on the 2024 sheet." }],
    notes: "2024 site list: All good. Front grass running 45 min, drip system 90 min, even calendar days."
  },
  {
    address: "19 Wethersfield Crt, Aurora, ON L4G 5M1, Canada",
    blowoutLocation: "Right side",
    shutoffLocation: "Basement closet — left door, left small door closet",
    controllerLocation: "Garage",
    valveBoxes: [
      { location: "Right side front", valveCount: 2, notes: "" },
      { location: "Right side rear", valveCount: 2, notes: "" }
    ],
    notes: "2024 site list: Couple of leaking heads, could use replacement."
  }
];

// ---- Helpers ---------------------------------------------------------

// The PJL_BASE guard. Mirrors server.js's geocodeForRecordDetailed: a result
// counts only when the geocoder says ok AND the coords did not come from the
// depot fallback AND both axes are present.
function isRealResult(geo) {
  if (!geo || geo.ok !== true || geo.skipped === true) return false;
  const c = geo.coords;
  if (!c || c.source === "pjl-base") return false;
  if (c.lat == null || c.lng == null) return false;
  return true;
}

function metersBetween(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nearDepot(coords) {
  if (!coords || coords.lat == null || coords.lng == null) return false;
  return metersBetween(coords, PJL_BASE) <= DEPOT_FLAG_METERS;
}

function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Cache-only lookup for the dry run. geocode() consults its cache first but
// falls through to a live API call on a miss, so calling it would make the
// "no network" promise false the moment an address isn't cached. Reading the
// cache file directly keeps the dry run genuinely offline. Returns a
// geocode()-shaped object so the caller's handling is identical, or null.
// The cache key is geocode.js's normalizeKey — the same transform as above.
function cacheLookup(address) {
  let cache;
  try {
    cache = JSON.parse(fsSync.readFileSync(path.join(DATA, "geocode-cache.json"), "utf8") || "{}");
  } catch {
    return null;
  }
  const hit = cache[normalizeAddress(address)];
  return hit ? { ok: true, fromCache: true, coords: hit } : null;
}

function totalValves(boxes) {
  // null counts are UNKNOWN, not zero — a total that silently treats them as
  // zero would understate the site. Report the known sum and the unknown
  // count separately.
  const known = boxes.filter((b) => Number.isFinite(b.valveCount));
  const unknown = boxes.length - known.length;
  return { sum: known.reduce((n, b) => n + b.valveCount, 0), unknown };
}

// Backups go INSIDE server/data/ deliberately. On Render only that path is a
// persistent disk mount — a sibling directory lives on the container
// filesystem and is destroyed by the next deploy, which is worthless as an
// undo for a write to live customer data.
async function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(DATA, `BACKUP-${stamp}-willowridge`);
  await fs.mkdir(dir, { recursive: true });
  for (const file of ["customers.json", "properties.json", "geocode-cache.json"]) {
    try {
      await fs.copyFile(path.join(DATA, file), path.join(dir, file));
    } catch {
      /* absent file — nothing to back up */
    }
  }
  return dir;
}

// ---- Main ------------------------------------------------------------

async function main() {
  const mode = GEOCODE_ONLY
    ? "GEOCODE PILOT (live lookups, creates nothing)"
    : APPLY ? "APPLY (writes)" : "DRY RUN (cache only, no network, no writes)";
  console.log(`\n  Willowridge import — ${mode}\n`);

  // ---- Preflight ------------------------------------------------------
  // The pilot reads no customer data, so it doesn't need the store to exist.
  if (!GEOCODE_ONLY && (!fsSync.existsSync(PROPERTIES_PATH) || !fsSync.existsSync(CUSTOMERS_PATH))) {
    console.error(`  ABORT — customers.json / properties.json not found in ${DATA}`);
    console.error("  server/data/* is gitignored; run this where the live data lives.\n");
    process.exit(1);
  }

  const keyPresent = isConfigured();
  if (!keyPresent) {
    console.warn("  ⚠️  GOOGLE_MAPS_SERVER_KEY is NOT set.");
    if (GEOCODE_ONLY) {
      // Without a key geocode() answers PJL_BASE for everything, which would
      // make the pilot look like a total failure for an environmental reason.
      // Say so plainly instead of printing 14 misleading rows.
      console.warn("     The pilot cannot test anything without it — geocode() short-circuits");
      console.warn("     to the depot fallback for every address. Run this where the key is set.\n");
      process.exit(1);
    }
    console.warn("     Nothing resolves except from the existing cache; uncached addresses");
    console.warn("     are written with coords: null rather than the depot pin.\n");
  }

  // ---- Pilot: prove the geocoder, write nothing ------------------------
  if (GEOCODE_ONLY) {
    console.log(`  Running ${SITES.length} addresses through geocode() — no records created.\n`);
    let good = 0, depot = 0, failed = 0, cached = 0;
    for (const site of SITES) {
      let geo = null;
      try {
        geo = await geocode(site.address);
      } catch (err) {
        console.log(`  ✗  ${site.address}`);
        console.log(`     threw: ${err?.message || err}\n`);
        failed += 1;
        continue;
      }
      const fromCache = geo?.fromCache === true;
      if (fromCache) cached += 1;
      if (isRealResult(geo)) {
        const c = geo.coords;
        const onDepot = nearDepot(c);
        // A real API answer that still lands on the depot is the dangerous
        // case — it passes isRealResult but is almost certainly wrong.
        console.log(`  ${onDepot ? "⚠️ " : "✓ "} ${site.address}`);
        console.log(`     ${c.lat}, ${c.lng}${fromCache ? "   (from cache)" : ""}`);
        console.log(`     Google says: ${c.formattedAddress}`);
        if (onDepot) console.log("     ⚠️  WITHIN 500m OF THE DEPOT PIN — treat as a failed geocode");
        console.log("");
        if (onDepot) depot += 1; else good += 1;
      } else {
        console.log(`  ✗  ${site.address}`);
        console.log(`     no usable result (${geo?.reason || "depot fallback"}) — would be written as coords: null\n`);
        failed += 1;
      }
      if (!fromCache) await sleep(RATE_LIMIT_MS);
    }
    console.log(`  ${good} resolved · ${depot} on the depot pin · ${failed} failed`);
    console.log(`  (${cached} of ${SITES.length} were already cached)\n`);
    if (good === SITES.length) {
      console.log("  Geocoder is working on all 14. Those answers are now cached, so the");
      console.log("  real import will reuse them — no second round of API calls.\n");
      console.log("  Next:  node scripts/import-willowridge.js          (see the full plan)");
      console.log("         node scripts/import-willowridge.js --apply  (create the records)\n");
    } else {
      console.log("  Not all addresses resolved. Nothing was created — paste this output");
      console.log("  and we can look at the ones that failed before importing anything.\n");
    }
    return;
  }

  // Existing customer? Reuse rather than creating a second Willowridge.
  const allCustomers = await customers.list();
  const existingCustomer = allCustomers.find(
    (c) => String(c.name || "").trim().toLowerCase() === CUSTOMER_NAME.toLowerCase()
  );

  // Existing properties at any of these addresses? Skip those rows — this
  // script creates, it does not reconcile. A re-run after a partial failure
  // picks up only what is missing.
  const allProperties = await properties.list();
  const byNormalizedAddress = new Map(
    allProperties.map((p) => [p.addressNormalized || normalizeAddress(p.address), p])
  );

  const planned = [];
  const skipped = [];
  for (const site of SITES) {
    const existing = byNormalizedAddress.get(normalizeAddress(site.address));
    if (existing) skipped.push({ site, existing });
    else planned.push(site);
  }

  console.log(`  Customer: ${existingCustomer ? `EXISTS — ${existingCustomer.id}` : "will be created"}`);
  console.log(`  Sites:    ${planned.length} to create, ${skipped.length} already present\n`);
  for (const { site, existing } of skipped) {
    console.log(`    SKIP  ${site.address}`);
    console.log(`          already exists as ${existing.code || existing.id}`);
  }
  if (skipped.length) console.log("");

  if (!planned.length) {
    console.log("  Nothing to do.\n");
    return;
  }

  // ---- Geocode --------------------------------------------------------
  // Resolved BEFORE any write so a geocoder problem surfaces while the store
  // is still untouched.
  const resolved = [];
  for (const site of planned) {
    let geo = null;
    if (LIVE_GEOCODE) {
      try {
        geo = await geocode(site.address);
      } catch (err) {
        console.warn(`  geocode threw for ${site.address}: ${err?.message || err}`);
      }
    } else {
      geo = cacheLookup(site.address);
    }
    const ok = isRealResult(geo);
    const coords = ok
      ? { lat: geo.coords.lat, lng: geo.coords.lng, formattedAddress: geo.coords.formattedAddress || site.address }
      : null;
    resolved.push({ site, coords, fromCache: geo?.fromCache === true, reason: ok ? "" : (geo?.reason || "not cached") });
    // Only real API calls need spacing; cache hits and dry-run skips do not.
    if (APPLY && ok && geo?.fromCache !== true) await sleep(RATE_LIMIT_MS);
  }

  if (!APPLY) {
    console.log("  DRY RUN — planned writes:\n");
    for (const { site, coords, reason } of resolved) {
      const { sum, unknown } = totalValves(site.valveBoxes);
      const valveLabel = unknown
        ? `${sum} known + ${unknown} box${unknown === 1 ? "" : "es"} unrecorded`
        : `${sum}`;
      console.log(`    ${site.address}`);
      console.log(`      blow-out : ${site.blowoutLocation}`);
      console.log(`      shut-off : ${site.shutoffLocation}`);
      console.log(`      timer    : ${site.controllerLocation}`);
      console.log(`      boxes    : ${site.valveBoxes.length} — valves: ${valveLabel}`);
      console.log(`      coords   : ${coords ? `${coords.lat}, ${coords.lng}` : `— (${reason})`}`);
      console.log("");
    }
    console.log("  No writes made. Re-run with --apply.\n");
    return;
  }

  // ---- Apply ----------------------------------------------------------
  const backupDir = await backup();
  console.log(`  backup: ${backupDir}\n`);

  let customer = existingCustomer;
  if (!customer) {
    customer = await customers.create(
      {
        name: CUSTOMER_NAME,
        email: CUSTOMER_EMAIL,
        phone: CUSTOMER_PHONE,
        // Commercial drives the 1-4 / 5-8 / 9+ tier table wherever the
        // caller passes the account type through (see the note at the
        // bottom of this file for where it currently does not).
        accountType: "commercial",
        // STATUSES is ["lead","active","inactive","lost"] (customers.js:67) —
        // anything else silently falls back to "lead".
        status: "active",
        source: "2024 site list"
      },
      { by: "import-willowridge", note: "Created with the 14-site 2024 list." }
    );
    console.log(`  customer created: ${customer.id}\n`);
  }

  const report = [];
  for (const { site, coords, reason } of resolved) {
    try {
      const created = await properties.create({
        customerId: customer.id,
        address: site.address,
        customerName: customer.name,
        customerEmail: customer.email || "",
        customerPhone: customer.phone || "",
        coords
      });
      // create() takes no system block — the profile lands on this patch.
      // update() merges `system` one level deep and takes valveBoxes verbatim,
      // so null counts and multi-box sites both survive.
      const updated = await properties.update(created.id, {
        system: {
          controllerLocation: site.controllerLocation,
          shutoffLocation: site.shutoffLocation,
          blowoutLocation: site.blowoutLocation,
          valveBoxes: site.valveBoxes,
          notes: site.notes
          // zones and zoneCount deliberately untouched — see header.
        },
        // update() deep-merges commPrefs and preserves optOutTokens, so
        // muting the channels here can't clobber the unsubscribe secrets.
        commPrefs: COMM_PREFS,
        seasonalPricing: SEASONAL_PRICING
      });
      report.push({ site, property: updated, coords, reason });
    } catch (err) {
      report.push({ site, property: null, coords, reason, error: err?.message || String(err) });
    }
  }

  // ---- Report ---------------------------------------------------------
  console.log("  Resolved addresses:\n");
  const flagged = [];
  for (const row of report) {
    if (row.error) {
      console.log(`    FAILED  ${row.site.address}`);
      console.log(`            ${row.error}`);
      continue;
    }
    const c = row.property.coords;
    const code = row.property.code || row.property.id;
    if (!c) {
      console.log(`    ${code}  ${row.property.address}`);
      console.log(`            coords: NONE (${row.reason}) — needs a geocode backfill`);
      flagged.push({ code, address: row.property.address, why: `no coords (${row.reason})` });
      continue;
    }
    const depot = nearDepot(c);
    console.log(`    ${code}  ${row.property.address}`);
    console.log(`            ${c.lat}, ${c.lng}${depot ? "   ⚠️  AT/NEAR DEPOT PIN" : ""}`);
    console.log(`            resolved as: ${c.formattedAddress}`);
    if (depot) flagged.push({ code, address: row.property.address, why: "landed on the depot pin" });
  }

  const failures = report.filter((r) => r.error);
  console.log("");
  console.log(`  Created: ${report.length - failures.length} of ${report.length}`);
  if (failures.length) console.log(`  Failed:  ${failures.length}`);
  if (flagged.length) {
    console.log(`\n  ⚠️  ${flagged.length} need attention:`);
    for (const f of flagged) console.log(`     ${f.code} — ${f.address}: ${f.why}`);
    console.log(`\n  If this looks wrong, restore from ${backupDir}`);
    console.log("  rather than patching records one at a time.");
  }
  console.log("");
}

main().catch((err) => {
  console.error("\n  UNCAUGHT:", err?.stack || err);
  process.exit(1);
});

// ---- Known gap, deliberately not addressed here ----------------------
//
// With system.zones empty, the seasonal price these properties display and
// seed onto work orders is $90 — "Spring opening / Fall closing, 1-4 zones
// RESIDENTIAL" — not the $145 commercial 1-4 rate, for two independent
// reasons in lib/pricing.js:
//
//   1. resolveSeasonalPrice() calls deriveSeasonalKey(serviceType, zoneCount,
//      false) — the `commercial` flag is hardcoded false, so it reads the
//      residential tier table regardless of customer.accountType.
//   2. deriveSeasonalKey() buckets a zero zone count into the lowest bracket
//      on purpose (`effective = n === 0 ? lo : n`).
//
// Filling zones from the valve counts would NOT fix this: every recorded
// count here is 1-4 valves, so these sites land in the 1-4 bracket either
// way, and (1) makes that bracket residential either way.
//
// What zones WOULD change is the seasonal-outreach booking handoff
// (server.js:5470), which is gated on `zoneCount > 0` and IS commercial-aware
// — it looks up accountType and would suggest spring_open_commercial. With
// zones empty it emits no suggestion and the customer lands on the unfiltered
// service catalog.
//
// Both are pre-existing and out of scope for this import. Flagged so the $90
// is not later mistaken for something this script did.
