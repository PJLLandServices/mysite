#!/usr/bin/env node
// scripts/test-unverified-address.mjs
//
// A booking nobody could verify must not look like every other booking.
//
// There are TWO different failures behind "we couldn't check this
// address", and the system has always treated them as one:
//
//   GOOGLE SAYS THE ADDRESS IS BAD — no such place, or it resolved only
//     to a town rather than a street. Refused at the gate, with our phone
//     number in the message. That is Patrick's "verified addresses are a
//     requirement", and it already worked. Asserted here so it stays.
//
//   OUR OWN LOOKUP FAILED — no Maps key, a timeout, quota. The booking is
//     TAKEN (Patrick's first rule: never turn a customer down, least of
//     all over our own outage) — and until now the only trace was a line
//     in the server log. Nobody was told. The address sat on the calendar
//     looking exactly like a good one, and the first person to find out
//     was the tech, in the driveway, at 8am.
//
// Patrick, 2026-09-09: "If there needs to be a notification round due to
// an address not being verified, yes that should be a notice made by text
// message."
//
// HOW IT IS TOLD, and why no new alert channel. He already gets one
// message per booking. The flag rides on the front of that message's
// label — "UNVERIFIED · BOOKED · …" — so the text that lands on his phone
// for this booking says so. That matters most in the case a separate
// alert would handle worst: if the Maps key ever falls out of Render,
// EVERY address starts failing at once, and one-message-per-booking is
// still exactly one message per booking.
//
// The flag is also stamped on the booking envelope and mirrored onto the
// canonical record, so the flag survives the message being missed.
//
// NO NETWORK. GOOGLE_MAPS_SERVER_KEY is cleared, which is itself the
// "our own lookup failed" condition. The verified control comes from a
// seeded geocode cache — with no key configured, geocode() serves a
// cached hit as a real answer, which is the same path a normally
// geocoded address takes.
//
// Run: node scripts/test-unverified-address.mjs  (also in build:check)

process.env.TZ = "America/Toronto";
delete process.env.GOOGLE_MAPS_SERVER_KEY;

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4804;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["leads.json", "bookings.json", "geocode-cache.json", "users.json", "auth.json", "work-orders.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}

// The control address, pre-resolved. geocode() serves a cached entry as a
// real answer when no key is configured, so this is a booking whose
// address WAS verified.
const VERIFIED = "10 Verified Way, Newmarket, ON L3Y 1A1";
const UNVERIFIED = "77 Nobody Checked Rd, Newmarket, ON L3Y 9Z9";
const TOWN_ONLY = "Newmarket, ON";
const NEWMARKET = { lat: 44.0592, lng: -79.4613 };

fs.writeFileSync(path.join(DATA, "leads.json"), "[]\n");
fs.writeFileSync(path.join(DATA, "bookings.json"), "[]\n");
fs.writeFileSync(path.join(DATA, "geocode-cache.json"), JSON.stringify({
  [VERIFIED.toLowerCase()]: {
    lat: NEWMARKET.lat, lng: NEWMARKET.lng,
    formattedAddress: VERIFIED, source: "google", streetLevel: true
  },
  // Resolved, but to a town centre — exactly what Google returns for a
  // bare municipality, and not somewhere a truck can be sent.
  [TOWN_ONLY.toLowerCase()]: {
    lat: NEWMARKET.lat, lng: NEWMARKET.lng,
    formattedAddress: TOWN_ONLY, source: "google", streetLevel: false
  }
}, null, 2));

const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  // Twilio deliberately unconfigured: lib/notify-sms.js then logs the
  // lead's sourceLabel instead of sending, which is how this suite reads
  // the message Patrick would have received.
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });

const leadsNow = () => JSON.parse(fs.readFileSync(path.join(DATA, "leads.json"), "utf8"));
const bookingsNow = () => JSON.parse(fs.readFileSync(path.join(DATA, "bookings.json"), "utf8"));
const settle = () => new Promise((r) => setTimeout(r, 400));

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`http://127.0.0.1:${PORT}/api/booking/services`); up = true; } catch {}
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-1500));

  // An admin session, only to stand down Turnstile. It is NOT a
  // "deliberate admin act" (no admin_custom, no leadId), so the address
  // gate runs exactly as it does for a member of the public.
  const users = require(path.join(ROOT, "server", "lib", "users.js"));
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  await users.create({ email: "verify-probe@local.test", name: "Verify Probe", role: "admin", password: "verify-probe-123" });
  const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "verify-probe@local.test", password: "verify-probe-123" })
  });
  const cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0])
    .find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("a throwaway admin can log in", login.ok && Boolean(cookie), `${login.status}`);

  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const firstSlot = async (address) => {
    // The fall window opens weeks out, past the default 14-day scan, so
    // ask across a horizon wide enough to reach whatever is actually open.
    const now = new Date();
    const to = new Date(now.getTime() + 120 * 86400000);
    const url = `http://127.0.0.1:${PORT}/api/booking/availability`
      + `?service=fall_close_4z&address=${encodeURIComponent(address)}`
      + `&from=${key(now)}&to=${key(to)}`;
    const data = await (await fetch(url, { headers: { cookie }, cache: "no-store" })).json();
    for (const day of data.days || []) {
      if ((day.slots || []).length) return day.slots[0].start;
    }
    return null;
  };

  const book = async (address, who) => {
    const slotStart = await firstSlot(address);
    if (!slotStart) return { skipped: true, status: 0, data: {} };
    // The ten-minute hold, exactly as the booking page takes it. This
    // suite is deliberately none of the paths exempt from it — no
    // standby, no admin-custom, no load-test key — because the whole
    // point is to walk the route a member of the public walks.
    const held = await fetch(`http://127.0.0.1:${PORT}/api/booking/hold`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ serviceKey: "fall_close_4z", slotStart, address })
    });
    const holdData = await held.json().catch(() => ({}));
    const r = await fetch(`http://127.0.0.1:${PORT}/api/booking/reserve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        serviceKey: "fall_close_4z", slotStart, zoneCount: 4,
        holdToken: holdData.holdToken || "",
        contact: {
          name: who, firstName: who, lastName: "Probe",
          email: `${who.toLowerCase()}@example.com`, phone: "9055550199",
          address
        }
      })
    });
    const data = await r.json().catch(() => ({}));
    await settle();
    return { status: r.status, data };
  };

  // ---- 1. Google says the address is bad → still refused --------------
  // The half that already worked. A town rather than a street is what
  // Google returns for "Toronto" — a real point on the map and not a
  // bookable address. If this ever stops refusing, "verified addresses
  // are a requirement" has quietly stopped being true.
  {
    const slotStart = await firstSlot(VERIFIED);
    const r = await fetch(`http://127.0.0.1:${PORT}/api/booking/reserve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        serviceKey: "fall_close_4z", slotStart, zoneCount: 4,
        contact: { name: "Town Only", email: "town@example.com", phone: "9055550100", address: TOWN_ONLY }
      })
    });
    const data = await r.json().catch(() => ({}));
    ok("an address that resolves only to a town is refused, not booked",
      r.status === 422 && /unverified|incomplete/.test(String(data.code)),
      `${r.status} ${JSON.stringify(data).slice(0, 160)}`);
    ok("…and the refusal tells the customer what to do instead",
      /full address|exact street address|suggestions/i.test(String(data.message || data.errors?.[0] || "")),
      String(data.message || data.errors?.[0] || "").slice(0, 160));
    ok("…and nothing was written",
      leadsNow().every((l) => l.contact?.address !== TOWN_ONLY), "a lead was created anyway");
  }

  // ---- 2. A verified address books clean ------------------------------
  {
    const res = await book(VERIFIED, "Verified");
    ok("the engine offered a slot to book at all — otherwise this suite proves nothing",
      !res.skipped, "no slot in the scan window");
    ok("a verified address books", res.skipped || res.status === 201 || res.data?.ok === true,
      `${res.status} ${JSON.stringify(res.data).slice(0, 160)}`);
    if (!res.skipped) {
      const lead = leadsNow().find((l) => l.contact?.address === VERIFIED);
      ok("…and carries no unverified flag", lead && !lead.booking?.verification,
        JSON.stringify(lead?.booking?.verification));
      const rec = bookingsNow().find((b) => b.address === VERIFIED);
      ok("…nor does its canonical record", rec && !rec.verification, JSON.stringify(rec?.verification));
      ok("…and Patrick's message is the ordinary one",
        /\[sms\] Lead:.*BOOKED/.test(logs) && !/\[sms\] Lead:.*UNVERIFIED/.test(logs),
        (logs.match(/\[sms\] Lead:.*/g) || []).join(" | ").slice(0, 200));
    }
  }

  const beforeSecond = logs.length;

  // ---- 3. Our own lookup failed → booked, flagged, and SAID ------------
  {
    const res = await book(UNVERIFIED, "Unverified");
    ok("the engine offered a slot for the unverified address too",
      !res.skipped, "no slot in the scan window");
    ok("an address we could not verify STILL books — never turn a customer down",
      res.skipped || res.status === 201 || res.data?.ok === true,
      `${res.status} ${JSON.stringify(res.data).slice(0, 160)}`);
    if (!res.skipped) {
      const lead = leadsNow().find((l) => l.contact?.address === UNVERIFIED);
      ok("…the booking is stamped unverified",
        lead?.booking?.verification?.state === "unverified",
        JSON.stringify(lead?.booking?.verification));
      ok("…naming why, so a fixable outage is distinguishable from a bad address",
        typeof lead?.booking?.verification?.reason === "string" && lead.booking.verification.reason.length > 0,
        JSON.stringify(lead?.booking?.verification?.reason));
      ok("…and when",
        typeof lead?.booking?.verification?.at === "string" && !Number.isNaN(Date.parse(lead.booking.verification.at)));

      const rec = bookingsNow().find((b) => b.address === UNVERIFIED);
      ok("…the canonical record carries it too, so the flag outlives the lead cache",
        rec?.verification?.state === "unverified", JSON.stringify(rec?.verification));

      const since = logs.slice(beforeSecond);
      ok("…and the message that would reach Patrick's phone says UNVERIFIED",
        /\[sms\] Lead:.*UNVERIFIED/.test(since),
        (since.match(/\[sms\] Lead:.*/g) || []).join(" | ").slice(0, 200));
      ok("…without losing what the booking actually is",
        /\[sms\] Lead:.*UNVERIFIED · BOOKED/.test(since),
        (since.match(/\[sms\] Lead:.*/g) || []).join(" | ").slice(0, 200));
    }
  }

  // ---- 4. The flag is not sticky across records ------------------------
  // A blanket "everything is unverified" would be useless in exactly the
  // way the old silence was: indistinguishable bookings.
  {
    const flagged = leadsNow().filter((l) => l.booking?.verification);
    ok("only the unverified booking is flagged",
      flagged.length === 1 && flagged[0].contact?.address === UNVERIFIED,
      flagged.map((l) => l.contact?.address).join(", ") || "none");
  }
} finally {
  child.kill("SIGKILL");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, buf);
  }
}

if (failures.length) {
  console.error(`\n✗ test-unverified-address: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-unverified-address: ${pass} assertions passed`);
