// The booking gate — who the public booking flow will take.
//
//   node scripts/test-booking-gate.mjs
//
// WHAT THIS PROTECTS. Patrick, piloting before the blast: junk
// addresses could book ("a ton of potential spam"), and nothing locked
// booking to the service area. The gate refuses (1) addresses that do
// not geocode to STREET level — a town name is a point on a map, not a
// property — and (2) street addresses farther than 90 driving minutes
// from the Newmarket base (coverage-checker.js's outermost "confirmed
// coverage" tier). The one deliberate exception is pinned hardest of
// all: when the geocode failure is OURS (no key, REQUEST_DENIED,
// network), the gate stands aside so our outage never blocks a real
// customer — invariant 5 — while ZERO_RESULTS, a DEFINITIVE "no such
// address", still refuses.
process.env.TZ = "America/Toronto";

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { gate, MAX_DRIVE_MINUTES } = require(path.join(ROOT, "server/lib/booking-gate.js"));
const { streetLevelFrom } = require(path.join(ROOT, "server/lib/geocode.js"));

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const BASE = { lat: 44.0592, lng: -79.4613 };
const NEAR = { lat: 44.05, lng: -79.45 };
const minutesStub = (m) => async () => m;

// ---- 1. Full addresses only -----------------------------------------
{
  const town = { ok: true, coords: { lat: 43.65, lng: -79.38, streetLevel: false } };
  const v = await gate(town, { travelMinutes: minutesStub(45), base: BASE });
  ok("a town-level result is refused as incomplete",
    v.ok === false && v.code === "address_incomplete", JSON.stringify(v));
  ok("the refusal tells the customer what to do",
    /pick your exact street address/i.test(v.message));
}
{
  const street = { ok: true, coords: { ...NEAR, streetLevel: true } };
  const v = await gate(street, { travelMinutes: minutesStub(12), base: BASE });
  ok("a street-level address inside the area books", v.ok === true && v.minutes === 12);
}
{
  // Cached entries from before streetLevel existed: real, served
  // addresses. Absent must PASS — only explicit false refuses.
  const legacy = { ok: true, coords: { ...NEAR } };
  const v = await gate(legacy, { travelMinutes: minutesStub(12), base: BASE });
  ok("a legacy cache entry without the flag still books", v.ok === true);
}

// ---- 2. The service-area lock ---------------------------------------
{
  const far = { ok: true, coords: { lat: 45.42, lng: -75.69, streetLevel: true } };
  const v = await gate(far, { travelMinutes: minutesStub(MAX_DRIVE_MINUTES + 30), base: BASE });
  ok("a street address past the 90-minute tier is refused",
    v.ok === false && v.code === "outside_service_area", JSON.stringify(v));
  ok("the refusal names the drive and offers the phone",
    /minutes/.test(v.message) && /905/.test(v.message));
}
{
  const edge = { ok: true, coords: { ...NEAR, streetLevel: true } };
  const v = await gate(edge, { travelMinutes: minutesStub(MAX_DRIVE_MINUTES), base: BASE });
  ok("exactly the boundary still books — the tier is inclusive", v.ok === true);
}
{
  const v = await gate({ ok: true, coords: { ...NEAR, streetLevel: true } }, {
    travelMinutes: async () => { throw new Error("matrix down"); }, base: BASE
  });
  ok("a drive-time measurement failure is ours — it never refuses", v.ok === true);
}

// ---- 3. Our faults stand aside; definitive answers refuse -----------
for (const reason of ["REQUEST_DENIED", "no key", "network", "OVER_QUERY_LIMIT"]) {
  const v = await gate({ ok: false, reason, coords: BASE }, { travelMinutes: minutesStub(10), base: BASE });
  ok(`a ${reason} failure is OURS — allowed and flagged`,
    v.ok === true && v.degraded === true && v.reason === reason, JSON.stringify(v));
}
{
  const v = await gate({ ok: false, reason: "ZERO_RESULTS" }, { travelMinutes: minutesStub(10), base: BASE });
  ok("ZERO_RESULTS is definitive — refused as unverified",
    v.ok === false && v.code === "address_unverified");
}
{
  const v = await gate(null, {});
  ok("no geocode result at all does not crash the gate", typeof v.ok === "boolean");
}

// ---- 4. streetLevelFrom reads Google's shape ------------------------
ok("a street_number component is street level",
  streetLevelFrom({ address_components: [{ types: ["street_number"], long_name: "45" }], types: ["street_address"] }) === true);
ok("a premise type is street level (rural/commercial lots)",
  streetLevelFrom({ address_components: [], types: ["premise"] }) === true);
ok("a locality is NOT street level",
  streetLevelFrom({ address_components: [{ types: ["locality"], long_name: "Toronto" }], types: ["locality", "political"] }) === false);
ok("a bare route is NOT street level",
  streetLevelFrom({ address_components: [{ types: ["route"], long_name: "Yonge St" }], types: ["route"] }) === false);
ok("garbage input answers false, not a throw", streetLevelFrom(null) === false);

// ---- 5. The cache cannot grandfather junk ---------------------------
// "toronto" typed during a PRE-gate test sits in the geocode cache
// without the streetLevel flag. Serving it as-is would wave the same
// junk through forever; a flag-less hit is re-verified once and the
// entry rewritten with its true nature.
{
  const fsMod = await import("node:fs");
  const osMod = await import("node:os");
  const SANDBOX = fsMod.mkdtempSync(path.join(osMod.default.tmpdir(), "pjl-gate-"));
  fsMod.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
  fsMod.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
  fsMod.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });
  fsMod.writeFileSync(path.join(SANDBOX, "server/data/geocode-cache.json"), JSON.stringify({
    "toronto": { lat: 43.65, lng: -79.38, formattedAddress: "Toronto, ON, Canada", source: "google" }
  }));
  process.env.GOOGLE_MAPS_SERVER_KEY = "test-key";
  const realFetch = global.fetch;
  global.fetch = async () => ({
    json: async () => ({
      status: "OK",
      results: [{
        geometry: { location: { lat: 43.6532, lng: -79.3832 } },
        formatted_address: "Toronto, ON, Canada",
        types: ["locality", "political"],
        address_components: [{ types: ["locality", "political"], long_name: "Toronto" }]
      }]
    })
  });
  try {
    const sandboxGeo = require(path.join(SANDBOX, "server/lib/geocode.js"));
    const first = await sandboxGeo.geocode("Toronto");
    ok("a flag-less cached entry is re-verified, not grandfathered",
      first.ok === true && first.coords.streetLevel === false && first.fromCache !== true,
      JSON.stringify(first));
    const second = await sandboxGeo.geocode("Toronto");
    ok("the rewritten entry carries its flag and serves from cache",
      second.fromCache === true && second.coords.streetLevel === false);
    const verdict = await gate(second, { travelMinutes: minutesStub(30), base: BASE });
    ok("the re-verified town entry is refused by the gate",
      verdict.ok === false && verdict.code === "address_incomplete");
  } finally {
    global.fetch = realFetch;
    delete process.env.GOOGLE_MAPS_SERVER_KEY;
  }
}

// ---- Report ----------------------------------------------------------
if (failures.length) {
  console.error(`\n✗ test-booking-gate: ${failures.length} failed, ${pass} passed`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`✓ test-booking-gate: ${pass} assertions passed`);
