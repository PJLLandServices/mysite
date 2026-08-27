#!/usr/bin/env node
// scripts/test-crm-sorting.mjs
//
// CRM index sorting (Aug 2026) — the customers and properties lists gained
// a sort control: alphabetical, by town, and (customers) by recent
// activity. Two pieces are worth pinning:
//
//   1. lib/format.js townFromAddress() — properties store one free-text
//      address with no city field, so the town shown on a card and sorted
//      on is derived. If this drifts, the customers index and the
//      properties index start disagreeing about what town someone is in.
//   2. crm-sort.js comparators — blank-last ordering, case/accent-blind
//      names, numeric-aware addresses, and the tiebreak that keeps a
//      single-town screen alphabetical instead of file-ordered.
//
// Run: node scripts/test-crm-sorting.mjs   (also in `npm run build:check`)

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const { townFromAddress } = require(path.join(ROOT, "server", "lib", "format.js"));
const PJLSort = require(path.join(ROOT, "server", "crm-sort.js"));

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// ---- 1. townFromAddress ----------------------------------------------
{
  eq(townFromAddress("123 Main St, Newmarket, ON L3X 0A5"), "Newmarket", "street, town, province, postal");
  eq(townFromAddress("1118 Cenotaph Blvd., Newmarket, ON  L3X 0A5"), "Newmarket", "double space before postal");
  eq(townFromAddress("12 Bathurst St, East Gwillimbury, ON L9N 0M4"), "East Gwillimbury", "two-word town");
  eq(townFromAddress("17 Elm St, Unit 4, King City, Ontario"), "King City", "unit line + spelled-out province");
  eq(townFromAddress("8 Rue Principale, Montréal, Québec"), "Montréal", "accented town + accented province");
  eq(townFromAddress("45 Yonge Street, RICHMOND HILL, ON"), "Richmond Hill", "SHOUTED import is title-cased");
  eq(townFromAddress("45 Yonge Street, king city, ON"), "king city", "lower-case is left alone — only all-caps is normalized");
  eq(townFromAddress("Newmarket, ON, Canada"), "Newmarket", "geocoder formattedAddress with no street");
  eq(townFromAddress("Newmarket, ON"), "Newmarket", "town + province only");

  // No town to find — these must come back blank so they sort under
  // "(no town)" rather than inventing one from a street or a fragment.
  eq(townFromAddress(""), "", "empty address");
  eq(townFromAddress(null), "", "null address");
  eq(townFromAddress(undefined), "", "undefined address");
  eq(townFromAddress("12 Main St"), "", "street with no town is not a town");
  eq(townFromAddress("ON"), "", "bare province is not a town");
  eq(townFromAddress("L3X 0A5"), "", "bare postal code is not a town");

  // Province must never leak through as the town.
  for (const addr of [
    "123 Main St, Newmarket, ON",
    "123 Main St, Newmarket, Ontario",
    "123 Main St, Newmarket, ontario"
  ]) {
    eq(townFromAddress(addr), "Newmarket", `province stripped from "${addr}"`);
  }
}

// ---- 2. compareText: blank-last, case- and accent-blind ---------------
{
  const { compareText } = PJLSort;
  ok(compareText("Aurora", "Bolton") < 0, "A before B");
  ok(compareText("Bolton", "Aurora") > 0, "B after A");
  eq(compareText("Aurora", "aurora"), 0, "case-blind");
  eq(compareText("Montreal", "Montréal"), 0, "accent-blind");
  eq(compareText("  Aurora  ", "Aurora"), 0, "whitespace trimmed");
  // Blanks sort last in BOTH directions — a record with no name is a data
  // gap, and floating it to the top of Z-A would put it in the way.
  ok(compareText("", "Aurora") > 0, "blank sorts after a value");
  ok(compareText("Aurora", "") < 0, "value sorts before a blank");
  eq(compareText("", ""), 0, "two blanks tie");
  eq(compareText(null, undefined), 0, "null and undefined both count as blank");
}

// ---- 3. sortRecords: direction, blank-last, tiebreak ------------------
const names = (list) => list.map((r) => r.name).join("|");
{
  const { sortRecords } = PJLSort;
  const people = [
    { name: "Vivian G", town: "Newmarket" },
    { name: "aaron b", town: "Aurora" },
    { name: "Zoë R", town: "" },
    { name: "Marc D", town: "Newmarket" },
    { name: "", town: "Aurora" }
  ];

  eq(names(sortRecords(people, { keys: ["name"] })),
    "aaron b|Marc D|Vivian G|Zoë R|", "name A-Z, unnamed last");
  eq(names(sortRecords(people, { keys: ["name"], direction: "desc" })),
    "Zoë R|Vivian G|Marc D|aaron b|", "name Z-A, unnamed still last");

  // Town sort: the tiebreak is what makes a screen of one town readable.
  // Within Aurora the tiebreak runs blank-last too, so the named record
  // comes before the unnamed one.
  eq(names(sortRecords(people, { keys: ["town"], tiebreak: "name" })),
    "aaron b||Marc D|Vivian G|Zoë R", "town A-Z, name tiebreak, blank town last");
  eq(names(sortRecords(people, { keys: ["town"], direction: "desc", tiebreak: "name" })),
    "Marc D|Vivian G|aaron b||Zoë R", "town Z-A: towns reverse, tiebreak stays ascending, blank town last");

  // The caller's array is the source of truth for counts — never reordered.
  const original = names(people);
  sortRecords(people, { keys: ["name"] });
  eq(names(people), original, "input array is not mutated");

  eq(sortRecords(null, { keys: ["name"] }).length, 0, "null input yields an empty list");
  eq(names(sortRecords(people, null)), original, "no spec leaves the order alone");
}

// ---- 4. Addresses sort numerically, not lexically ---------------------
{
  const addrs = [
    { address: "10 Main St, Aurora, ON" },
    { address: "2 Main St, Aurora, ON" },
    { address: "9 Main St, Aurora, ON" }
  ];
  const sorted = PJLSort.sortRecords(addrs, { keys: ["address"] }).map((r) => r.address);
  eq(sorted[0], "2 Main St, Aurora, ON", "2 before 9");
  eq(sorted[1], "9 Main St, Aurora, ON", "9 before 10");
  eq(sorted[2], "10 Main St, Aurora, ON", "10 last — numeric, not lexical");
}

// ---- 5. compareRecent: newest first, blanks last ---------------------
{
  const { compareRecent, sortRecords } = PJLSort;
  ok(compareRecent("2026-08-27T10:00:00.000Z", "2026-01-01T10:00:00.000Z") < 0, "newer sorts first");
  ok(compareRecent("", "2026-01-01T10:00:00.000Z") > 0, "no timestamp sorts last");
  const rows = [
    { name: "Older", lastActivityAt: "2026-01-01T00:00:00.000Z" },
    { name: "Never", lastActivityAt: "" },
    { name: "Newest", lastActivityAt: "2026-08-27T00:00:00.000Z" }
  ];
  eq(names(sortRecords(rows, { keys: ["lastActivityAt"], compare: compareRecent, tiebreak: "name" })),
    "Newest|Older|Never", "recent sort: newest, older, then never-touched");
}

// ---- 6. The customers index's own sort table stays wired -------------
// Guards the pairing between the <select> values in customers.html /
// properties.html and the SORTS tables in their scripts: a renamed option
// that isn't renamed in both places silently falls back to the default.
{
  const fs = await import("node:fs/promises");
  const pairs = [
    ["customers.html", "customers.js", "customerSort"],
    ["properties.html", "properties.js", "propertySort"]
  ];
  for (const [htmlFile, jsFile, selectId] of pairs) {
    const html = await fs.readFile(path.join(ROOT, "server", htmlFile), "utf8");
    const js = await fs.readFile(path.join(ROOT, "server", jsFile), "utf8");
    const select = html.slice(html.indexOf(`id="${selectId}"`));
    const optionValues = [...select.slice(0, select.indexOf("</select>")).matchAll(/value="([^"]+)"/g)]
      .map((m) => m[1]);
    ok(optionValues.length >= 3, `${htmlFile}: ${selectId} offers at least three sorts`);
    const sortsBlock = js.slice(js.indexOf("const SORTS = {"), js.indexOf("const SORT_STORAGE_KEY"));
    for (const value of optionValues) {
      ok(sortsBlock.includes(`"${value}"`), `${jsFile}: SORTS handles the "${value}" option`);
    }
    const defaultMatch = js.match(/const DEFAULT_SORT = "([^"]+)"/);
    ok(defaultMatch && optionValues.includes(defaultMatch[1]),
      `${jsFile}: DEFAULT_SORT is one of the offered options`);
    ok(defaultMatch && sortsBlock.includes(`"${defaultMatch[1]}"`),
      `${jsFile}: DEFAULT_SORT exists in SORTS`);
    // The shared helper has to be loaded BEFORE the page script that calls
    // it at module scope, or the page dies on first paint.
    ok(html.indexOf("/crm/crm-sort.js") !== -1 && html.indexOf("/crm/crm-sort.js") < html.indexOf(`/crm/${jsFile}`),
      `${htmlFile}: crm-sort.js loads before ${jsFile}`);
  }
}

console.log(`\ntest-crm-sorting: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
