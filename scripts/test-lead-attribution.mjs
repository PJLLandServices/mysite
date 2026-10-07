#!/usr/bin/env node
// scripts/test-lead-attribution.mjs
//
// 2026-10-07. Patrick launched a Facebook/Instagram ad pointing at
// book.html and asked: "will my site know the booking came from the ad?"
// It didn't — the lead kept the raw pageUrl but nothing read it, and a
// visitor who clicked around before booking lost the ad tags entirely.
//
// This pins the three pieces that answer the question:
//   1. the analytics partial (on every page) remembers the source,
//   2. js/booking.js sends it with the booking,
//   3. the server cleans it ONCE (normalizeAttribution) and stores a
//      human label on lead.context.attribution, which the CRM shows.
//
// Run: node scripts/test-lead-attribution.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- 1. Server: lift the pure functions out of server.js ----------------
const server = read("server/server.js");
const grab = (re) => (server.match(re) || [""])[0];
const src = [
  grab(/function normalizeString\([\s\S]*?\n}\n/),
  grab(/const ATTRIBUTION_FIELDS = [^\n]*\n/),
  grab(/function leadSourceLabel\([\s\S]*?\n}\n/),
  grab(/function normalizeAttribution\([\s\S]*?\n}\n/),
].join("\n");
const ctx = {};
vm.runInNewContext(`${src}\nthis.normalizeAttribution = normalizeAttribution;`, ctx);
const norm = ctx.normalizeAttribution;
ok("normalizeAttribution exists in server.js", typeof norm === "function");

if (typeof norm === "function") {
  const fbAd = norm({ utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "fall_closing_oct2026", fbclid: "abc", ts: 1791300000000 });
  ok("facebook paid → 'Facebook ad'", fbAd?.label === "Facebook ad", JSON.stringify(fbAd));
  ok("campaign kept", fbAd?.utm_campaign === "fall_closing_oct2026");
  ok("firstSeenAt from ts", typeof fbAd?.firstSeenAt === "string");

  const igAd = norm({ utm_source: "instagram", utm_medium: "paid_social" });
  ok("instagram paid → 'Instagram ad'", igAd?.label === "Instagram ad", JSON.stringify(igAd));

  const google = norm({ referrer: "https://www.google.com/" });
  ok("google referrer → 'Google search'", google?.label === "Google search", JSON.stringify(google));

  const gads = norm({ gclid: "xyz" });
  ok("gclid → 'Google ad'", gads?.label === "Google ad", JSON.stringify(gads));

  ok("nothing → null", norm({}) === null);
  ok("landing page only → null", norm({ landingPage: "/book.html" }) === null);
  ok("non-object → null", norm("facebook") === null && norm(null) === null && norm([1]) === null);

  const long = norm({ utm_source: "x".repeat(5000) });
  ok("long values capped", long && long.utm_source.length <= 200);
  const junk = norm({ utm_source: "facebook", evil: "<script>" });
  ok("unknown keys dropped", junk && !("evil" in junk));
}

ok("validateLead stores attribution on context",
  /attribution: normalizeAttribution\(payload && payload\.attribution\)/.test(server));
ok("reserve passes payload.attribution into validateLead",
  /attribution: payload\.attribution,\s*\n\s*mode: "booking"/.test(server));

// ---- 2. Browser: booking.js sends it -------------------------------------
const booking = read("js/booking.js");
ok("booking.js sends attribution", /attribution:\s*\(function/.test(booking));
ok("booking.js fires Meta Schedule on success", (booking.match(/fbq\("track", "Schedule"/g) || []).length === 2);

// ---- 3. Partial: remembers the source; every page has it -----------------
const partial = read("_partials/analytics.html");
ok("partial defines window.pjlAttribution", /window\.pjlAttribution = read/.test(partial));
ok("partial loads Meta Pixel", /fbq\('init', '1523620959798270'\)/.test(partial));
const bookHtml = read("book.html");
ok("book.html carries the built partial", bookHtml.includes("window.pjlAttribution = read"));

// Run the partial's capture script in a fake browser: an ad click stores,
// a later plain visit keeps the ad.
const captureJs = (partial.match(/<script>\s*\(function \(\) \{\s*var KEY[\s\S]*?<\/script>/) || [""])[0]
  .replace(/^<script>/, "").replace(/<\/script>$/, "");
function visit(store, url, referrer) {
  const u = new URL(url);
  const win = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
  };
  const sandbox = { window: win, localStorage: win.localStorage, location: u, document: { referrer }, URLSearchParams, JSON, Date };
  vm.runInNewContext(captureJs, sandbox);
  return win.pjlAttribution ? win.pjlAttribution() : undefined;
}
const store = {};
const a1 = visit(store, "https://www.pjllandservices.com/book.html?service=fall_close_4z&utm_source=facebook&utm_medium=paid_social&utm_campaign=fall_closing_oct2026&fbclid=1", "https://l.facebook.com/");
ok("ad click is stored", a1?.utm_source === "facebook", JSON.stringify(a1));
const a2 = visit(store, "https://www.pjllandservices.com/pricing.html", "https://www.google.com/");
ok("later organic visit keeps the ad", a2?.utm_source === "facebook", JSON.stringify(a2));
const a3 = visit(store, "https://www.pjllandservices.com/book.html?utm_source=instagram&utm_medium=paid_social", "");
ok("a newer ad click replaces it", a3?.utm_source === "instagram", JSON.stringify(a3));
const fresh = {};
const a4 = visit(fresh, "https://www.pjllandservices.com/", "https://www.pjllandservices.com/about.html");
ok("internal navigation stores nothing", a4 === null, JSON.stringify(a4));

// ---- CRM shows it --------------------------------------------------------
ok("CRM lead drawer shows 'Came from'", /Came from: \$\{cameFrom\}/.test(read("server/admin.js")));

if (failures.length) {
  console.error(`test-lead-attribution: ${failures.length} FAILED, ${pass} passed`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`test-lead-attribution: all ${pass} checks passed`);
