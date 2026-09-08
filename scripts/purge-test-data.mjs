#!/usr/bin/env node
// scripts/purge-test-data.mjs — the delete bot.
//
// Patrick, 2026-09-08: "can you build a delete bot that deletes all these
// booked appointments, and everything that they have created? (Properties,
// Customers, Work orders and Invoices.)"
//
// TWO WAYS TO RUN IT, and the first one is the one to reach for.
//
//   1. ON THE SERVER (Render shell), straight at the data — no login:
//        node scripts/purge-test-data.mjs
//        node scripts/purge-test-data.mjs --confirm
//
//   2. OVER HTTP from anywhere else, as an admin:
//        PJL_ADMIN_EMAIL=... PJL_ADMIN_PASSWORD=... \
//          node scripts/purge-test-data.mjs --base=https://pjllandservices.com
//
// It picks mode 1 whenever server/data/leads.json is beside it and no
// --base is given. The first cut of this script only had mode 2, and a
// cleanup that has to survive a login round-trip through a proxy is a
// cleanup that fails at the worst moment — it did, with "CRM login
// required," and that is why mode 1 exists.
//
// Neither mode carries delete logic of its own. Both go through
// server/lib/purge-test-data.js, which is where the rule lives: a lead is
// the bot's if it carries the marker, and a customer or property only comes
// out when EVERY lead naming it is in the purge. A bot booking made against
// somebody real takes the booking and leaves the person.
//
//   --marker=PJLTEST-   what marks a bot record (4 characters minimum)
//   --base=https://...  force HTTP mode against this server
//   --confirm           actually delete; without it this is a dry run

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const require2 = createRequire(path.join(ROOT, "package.json"));

const args = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const MARKER = flag("marker", "PJLTEST-");
const LIVE = args.includes("--confirm");
const BASE = flag("base", process.env.PJL_BASE_URL || "").replace(/\/+$/, "");
const LOCAL = !BASE && fs.existsSync(path.join(DATA, "leads.json"));

const LABELS = {
  leads: "appointments / leads", bookings: "bookings", "work-orders": "work orders",
  invoices: "invoices", quotes: "quotes", projects: "projects",
  customers: "customers", properties: "properties"
};

// Say what is about to be touched BEFORE touching it. A count with no
// address on it is ambiguous three ways — same rule as find-test-leads.js.
console.log(`source : ${LOCAL ? DATA : BASE || "(no server given)"}`);
console.log(`marker : ${MARKER}`);
console.log(`mode   : ${LIVE ? "LIVE — records will be deleted" : "dry run — nothing will be deleted"}`);
console.log("");

function report({ dryRun, counts, sample }) {
  const total = Object.values(counts || {}).reduce((a, b) => a + b, 0);
  if (!total) {
    console.log("Nothing matches the marker. There is nothing to delete.");
    return;
  }
  console.log(dryRun ? "Would remove:" : "Removed:");
  for (const [key, n] of Object.entries(counts)) {
    if (n) console.log(`  ${String(n).padStart(4)}  ${LABELS[key] || key}`);
  }
  if (!dryRun) {
    console.log("\nDone. Reload the season plan — those days should be clear.");
    return;
  }
  if (Array.isArray(sample) && sample.length) {
    console.log("\nFirst few, to check they are the bot's and not yours:");
    for (const s of sample) {
      console.log(`  ${s.name || "(no name)"} — ${s.address || "no address"}${s.when ? ` — ${s.when}` : ""}`);
    }
  }
  console.log("\nNothing was deleted. If that list is right, run it again with --confirm:");
  console.log(`  node scripts/purge-test-data.mjs${BASE ? ` --base=${BASE}` : ""} --confirm`);
}

// ---- Mode 1: straight at the data ------------------------------------
if (LOCAL) {
  const purge = require2(path.join(ROOT, "server", "lib", "purge-test-data.js"));
  let plan;
  try {
    plan = purge.planPurge({ dataDir: DATA, marker: MARKER });
  } catch (err) {
    console.error(err instanceof purge.PurgeRefused ? err.message : (err?.message || String(err)));
    process.exit(1);
  }
  if (!LIVE) {
    report({ dryRun: true, counts: plan.counts, sample: plan.sample });
    process.exit(0);
  }
  const leadsFile = path.join(DATA, "leads.json");
  fs.copyFileSync(leadsFile, `${leadsFile}.bak`);
  console.log(`(leads.json backed up to ${path.basename(leadsFile)}.bak)\n`);
  const counts = await purge.applyPurge({
    dataDir: DATA,
    plan,
    writeLeads: async (rows) => fs.writeFileSync(leadsFile, JSON.stringify(rows, null, 2) + "\n")
  });
  report({ dryRun: false, counts });
  process.exit(0);
}

// ---- Mode 2: over HTTP as an admin -----------------------------------
if (!BASE) {
  console.error("No server/data directory here, so this has to run over HTTP.");
  console.error("Give it a server and admin credentials:");
  console.error("  PJL_ADMIN_EMAIL=... PJL_ADMIN_PASSWORD=... \\");
  console.error("    node scripts/purge-test-data.mjs --base=https://pjllandservices.com");
  process.exit(2);
}
const EMAIL = process.env.PJL_ADMIN_EMAIL || "";
const PASSWORD = process.env.PJL_ADMIN_PASSWORD || "";
if (!EMAIL || !PASSWORD) {
  console.error("Set PJL_ADMIN_EMAIL and PJL_ADMIN_PASSWORD before running.");
  process.exit(2);
}

const AUTH_COOKIE = "pjl_crm_session";

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  redirect: "manual"
});

if (login.status >= 300 && login.status < 400) {
  // A redirect turns the POST into a GET and the login silently never
  // happens. Name the destination rather than failing three steps later.
  console.error(`${BASE}/api/login redirected to ${login.headers.get("location") || "(no location)"}.`);
  console.error("Run it again with --base= set to that host.");
  process.exit(1);
}
if (!login.ok) {
  const why = await login.json().catch(() => ({}));
  console.error(`login failed (${login.status})${why.errors ? `: ${why.errors.join("; ")}` : ""}`);
  process.exit(1);
}

// getSetCookie() keeps the cookies apart. headers.get("set-cookie") joins
// them with commas, so anything a proxy sets ahead of the session cookie
// gets picked up instead — which is exactly how this failed the first time.
const setCookies = typeof login.headers.getSetCookie === "function"
  ? login.headers.getSetCookie()
  : [login.headers.get("set-cookie") || ""].filter(Boolean);
const session = setCookies.map((c) => c.split(";")[0].trim()).find((c) => c.startsWith(`${AUTH_COOKIE}=`));
if (!session) {
  console.error(`Logged in, but the server sent no ${AUTH_COOKIE} cookie.`);
  console.error(`Cookies it did send: ${setCookies.map((c) => c.split("=")[0]).join(", ") || "(none)"}`);
  process.exit(1);
}

// Prove the session is accepted BEFORE asking it to delete anything, and
// say who it belongs to. "CRM login required" from the purge itself tells
// you nothing about which half broke.
const who = await fetch(`${BASE}/api/session`, { headers: { cookie: session } });
const me = await who.json().catch(() => ({}));
if (!me.authenticated) {
  console.error("The server would not accept the session cookie it just issued.");
  console.error("Check that --base is the same host the cookie was set on (www vs bare domain).");
  process.exit(1);
}
if (me.role !== "admin") {
  console.error(`Signed in as ${me.user?.email || "?"}, role "${me.role}". This needs an admin.`);
  process.exit(1);
}
console.log(`signed in as ${me.user?.email || me.user?.id || "admin"}\n`);

const res = await fetch(`${BASE}/api/admin/purge-test-data`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: session },
  body: JSON.stringify({ marker: MARKER, ...(LIVE ? { confirm: "PURGE TEST DATA" } : {}) })
});
const body = await res.json().catch(() => ({}));
if (!res.ok || body.ok !== true) {
  console.error(`purge refused (${res.status}): ${(body.errors || ["unknown error"]).join("; ")}`);
  process.exit(1);
}
report(body);
