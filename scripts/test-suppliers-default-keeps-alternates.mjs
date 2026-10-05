#!/usr/bin/env node
// scripts/test-suppliers-default-keeps-alternates.mjs
//
// CHOOSING THE DEFAULT SUPPLIER MUST NOT DROP THE OTHERS (Patrick,
// 2026-10-05 — Step A of the duplicate-fittings work).
//
// A part can be one fitting with two suppliers' offers: supplierIds
// ["SUP-001", "SUP-002"], first = default. The Suppliers page had three
// writers — the row dropdown, bulk "Reassign", and the leave-page flush —
// and each sent a ONE-element list, which the server stored as-is. Touching
// the dropdown on a two-supplier part silently removed the second supplier.
//
// The rule now lives once, on the server: part-suppliers.withPrimary(current,
// supplierId) reorders and keeps every alternate; clearing the default on a
// part that has alternates is refused. All three writers send
// { primary: { sku: supplierId } }.
//
// Against the pre-fix code: withPrimary / setPrimaryBulk do not exist, and
// the page still sends { updates: { sku: [id] } } — every section fails.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");

let passed = 0, failed = 0;
function ok(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const attempt = async (fn) => { try { return { value: await fn() }; } catch (err) { return { err }; } };

const CP = "SUP-001", SO = "SUP-002", X = "SUP-003";
fs.mkdirSync(DATA, { recursive: true });
const store = path.join(DATA, "part-suppliers.json");
const backup = fs.existsSync(store) ? fs.readFileSync(store) : null;
try {
  const ps = require(path.join(ROOT, "server", "lib", "part-suppliers.js"));
  const has = typeof ps.withPrimary === "function" && typeof ps.setPrimaryBulk === "function";
  ok("the rule exists once on the server: withPrimary + setPrimaryBulk", has);

  // ---- 1. the rule, as a table ---------------------------------------
  console.log("1. withPrimary");
  if (has) {
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    ok("choosing the current default changes nothing", eq(ps.withPrimary([CP, SO], CP), [CP, SO]));
    ok("choosing the alternate makes it default and KEEPS the old default", eq(ps.withPrimary([CP, SO], SO), [SO, CP]));
    ok("choosing a supplier the part didn't have puts it first, keeps both others in order", eq(ps.withPrimary([CP, SO], X), [X, CP, SO]));
    ok("first assignment on an unassigned part", eq(ps.withPrimary([], CP), [CP]));
    ok("clearing a single-supplier part unassigns it", eq(ps.withPrimary([CP], ""), []));
    const r = await attempt(() => ps.withPrimary([CP, SO], ""));
    ok("clearing the default on a part WITH alternates is refused", r.err && r.err.code === "alternates_present" && /Pick which one is the default/.test(r.err.message), r.err && r.err.message);
    ok("duplicates and blanks in stored data are tolerated", eq(ps.withPrimary([CP, "", CP, SO], SO), [SO, CP]));
  }

  // ---- 2. the store ----------------------------------------------------
  console.log("2. setPrimaryBulk on the store");
  if (has) {
    fs.writeFileSync(store, JSON.stringify({ TWO: [CP, SO], ONE: [CP], THREE: [CP, SO, X] }, null, 2));
    let map = await ps.setPrimaryBulk({ TWO: SO });
    ok("row dropdown: default → SiteOne, Central is still a supplier", JSON.stringify(map.TWO) === JSON.stringify([SO, CP]), JSON.stringify(map.TWO));
    map = await ps.setPrimaryBulk({ TWO: CP });
    ok("...and back: both suppliers still there, original order", JSON.stringify(map.TWO) === JSON.stringify([CP, SO]));
    map = await ps.setPrimaryBulk({ TWO: X, ONE: X, THREE: X });
    ok("bulk reassign to a third supplier keeps every part's alternates", JSON.stringify(map.TWO) === JSON.stringify([X, CP, SO]) && JSON.stringify(map.ONE) === JSON.stringify([X, CP]) && JSON.stringify(map.THREE) === JSON.stringify([X, CP, SO]), JSON.stringify(map));
    const before = fs.readFileSync(store, "utf8");
    const r = await attempt(() => ps.setPrimaryBulk({ ONE: CP, TWO: "" }));
    ok("one refused part in a batch writes NOTHING (all or nothing), and the error names the part", r.err && r.err.code === "alternates_present" && r.err.sku === "TWO" && fs.readFileSync(store, "utf8") === before, r.err && r.err.message);
    fs.writeFileSync(store, JSON.stringify({ ONE: [CP] }, null, 2));
    map = await ps.setPrimaryBulk({ ONE: "" });
    ok("clearing a single-supplier part removes its entry", !("ONE" in map));
    map = await ps.setPrimaryBulk({ BASE: SO }, { currentFor: (sku) => (sku === "BASE" ? [CP] : []) });
    ok("a part whose suppliers come from the catalog (no stored entry) keeps them too", JSON.stringify(map.BASE) === JSON.stringify([SO, CP]), JSON.stringify(map.BASE));
    // The explicit whole-list write still means what it says.
    map = await ps.bulkSet({ BASE: [CP] });
    ok("bulkSet (explicit whole-list replace, API only) is unchanged", JSON.stringify(map.BASE) === JSON.stringify([CP]));
  }

  // ---- 3. the route and the three page writers -------------------------
  console.log("3. wiring");
  const SRC = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  ok("PATCH /api/part-suppliers routes { primary } through setPrimaryBulk, with the catalog as fallback",
    /payload\.primary && typeof payload\.primary === "object"/.test(SRC) && /partSuppliers\.setPrimaryBulk\(payload\.primary, \{\s*currentFor:/.test(SRC));
  const PAGE = fs.readFileSync(path.join(ROOT, "server", "parts-suppliers.js"), "utf8");
  const sends = PAGE.match(/fetch\("\/api\/part-suppliers"[\s\S]{0,260}?body: JSON\.stringify\(([^\n]+)\)/g) || [];
  ok("the page has exactly three writers of supplier assignments", sends.length === 3, String(sends.length));
  ok("writer 1 (row dropdown autosave) sends { primary }", sends.some((s) => /primary: primaryPayload\(sent\)/.test(s)));
  ok("writer 2 (bulk Reassign) sends { primary }", sends.some((s) => /JSON\.stringify\(\{ primary \}\)/.test(s)));
  ok("writer 3 (leave-page flush) sends { primary }", sends.some((s) => /primary: primaryPayload\(state\.pending\.entries\(\)\)/.test(s)));
  ok("no writer on the page sends a whole-list { updates } any more", !/JSON\.stringify\(\{ updates/.test(PAGE));
  ok("no writer builds a one-element supplier list", !/\? \[value\] : \[\]/.test(PAGE) && !/updates\[sku\] = \[supId\]/.test(PAGE));
  ok("after a save the page takes the SERVER's list (which kept the alternates)", (PAGE.match(/data\.partSuppliers \|\| \{\}\)\[sku\]/g) || []).length >= 2);
  ok("clearing the default on a two-supplier part is stopped on the page with a reason, the dropdown put back", /next === null/.test(PAGE) && /Pick which one is the default instead of clearing it/.test(PAGE) && /sel\.value = before\[0\]/.test(PAGE));
} finally {
  if (backup === null) { if (fs.existsSync(store)) fs.rmSync(store); }
  else fs.writeFileSync(store, backup);
}

console.log(`\nsuppliers default keeps alternates: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
