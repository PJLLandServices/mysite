#!/usr/bin/env node
// scripts/test-email-dismiss.mjs
//
// Patrick, 2026-09-12, on forty "outreach · send by hand" rows from the
// morning the Gmail password was revoked: "how do we get rid of all this
// garbage."
//
// Two honest ways off that list, and this pins both: the blast emails
// are the cadence's to re-send (one press runs the season's catch-up,
// after which the ledger's later successes drop the rows on their own),
// and anything he has dealt with some other way can be DISMISSED — the
// ledger keeps the record, the list stops nagging.
//
// Run: node scripts/test-email-dismiss.mjs  (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mailerLog = require(path.join(ROOT, "server", "lib", "mailer-log.js"));

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const j = (v, n = 220) => String(JSON.stringify(v) ?? "(nothing)").slice(0, n);
const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; }
};

const LEDGER = path.join(ROOT, "server", "data", "email-log.json");
const DISMISSED = path.join(ROOT, "server", "data", "email-dismissed.json");
const backups = new Map();
for (const f of [LEDGER, DISMISSED]) backups.set(f, fs.existsSync(f) ? fs.readFileSync(f) : null);
const seed = (entries) => { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(entries, null, 2), "utf8"); };
const ts = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();
const outstanding = async (opts) => {
  if (typeof mailerLog.outstandingFailures !== "function") return "(outstandingFailures is missing)";
  try { return await mailerLog.outstandingFailures(opts); } catch (err) { return `(threw: ${err.message})`; }
};
const dismiss = async (...a) => {
  if (typeof mailerLog.dismissFailures !== "function") return { missing: "(dismissFailures is missing)" };
  try { return await mailerLog.dismissFailures(...a); } catch (err) { return { error: err.message }; }
};

try {
  fs.rmSync(DISMISSED, { force: true });
  seed([
    { ts: ts(60), kind: "outreach", to: "a@example.com", ok: false, refId: "BK-1", error: "535 Username and Password not accepted" },
    { ts: ts(59), kind: "outreach", to: "b@example.com", ok: false, refId: "BK-2", error: "535 Username and Password not accepted" },
    { ts: ts(58), kind: "booking_cancel", to: "c@example.com", ok: false, refId: "BK-3", error: "535" }
  ]);

  // ---- 1. Dismissing takes rows off the list, and only those rows ----------
  {
    const before = await outstanding();
    ok("three failures are outstanding to start", Array.isArray(before) && before.length === 3, j(before));
    const target = Array.isArray(before) ? before.find((f) => f.refId === "BK-2") : null;
    const r = await dismiss([target && target.id], { by: "patrick" });
    ok("one can be dismissed", r && r.dismissed === 1, j(r));
    const after = await outstanding();
    ok("…and it leaves the list while the others stay",
      Array.isArray(after) && after.length === 2 && !after.some((f) => f.refId === "BK-2"), j(after));
    const again = await dismiss([target && target.id], { by: "patrick" });
    ok("dismissing it twice is a no-op", again && again.dismissed === 0, j(again));
    const file = fs.existsSync(DISMISSED) ? JSON.parse(fs.readFileSync(DISMISSED, "utf8")) : {};
    ok("the decision is recorded with who and when", target && file[target.id] && file[target.id].by === "patrick" && file[target.id].ts, j(file));
    const ledger = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
    ok("the ledger itself is untouched — the outage is still history", ledger.length === 3 && ledger.every((e) => e.ok === false), j(ledger.length));
  }

  // ---- 2. Dismissal is a Set the caller may hand in ------------------------
  {
    const list = await outstanding({ dismissed: new Set() });
    ok("an empty hand-in shows everything (the file is not consulted)", Array.isArray(list) && list.length === 3, j(list));
    const all = Array.isArray(list) ? new Set(list.map((f) => f.id)) : new Set();
    const none = await outstanding({ dismissed: all });
    ok("…and dismissing all of them shows nothing", Array.isArray(none) && none.length === 0, j(none));
  }

  // ---- 3. Bad input is nobody's dismissal ----------------------------------
  {
    const r = await dismiss([], { by: "x" });
    ok("no ids → nothing dismissed, no crash", r && r.dismissed === 0, j(r));
    const r2 = await dismiss(["not-a-real-id"], { by: "x" });
    ok("an unknown id is recorded harmlessly (it matches nothing)", r2 && r2.dismissed === 1, j(r2));
  }

  // ---- 4. The route and the panel --------------------------------------------
  {
    const src = read("server/server.js");
    const route = src.slice(src.indexOf('pathname === "/api/admin/email-health/dismiss"'), src.indexOf('pathname === "/api/admin/email-health/dismiss"') + 1400);
    ok("there is a dismiss route", route.length > 100 && /req\.method === "POST"/.test(route), "no route");
    ok("…behind the admin gate", /await requireAdmin\(req\)/.test(route), "open to anyone");
    ok("…taking ids or all, and re-reading the worklist server-side",
      /body\.all === true/.test(route) && /await mailerLog\.outstandingFailures\(\)/.test(route) && /mailerLog\.dismissFailures\(targets/.test(route), "trusts the page's list");
    ok("the health read points blast failures at the season's catch-up",
      /catchUp = \{ season, year: Number\(year\), count: top\[1\] \}/.test(src) && /outstanding, catchUp \}\)/.test(src), "no catch-up pointer");
    ok("…counting only outreach rows with an assignment booking behind them",
      /if \(f\.kind !== "outreach" \|\| !f\.refId\) continue;/.test(src) && /const a = b && b\.assignment;/.test(src), "counts the wrong rows");

    const page = read("server/admin.html");
    ok("the panel offers the blast catch-up as one button", /id="emailHealthCatchUp"/.test(page) && /\/api\/assignments\/" \+ catchUpInfo\.season \+ "\/" \+ catchUpInfo\.year \+ "\/catch-up"/.test(page), "no catch-up button");
    ok("…and says so on each blast row instead of 'send by hand'", /blast email; use the button above/.test(page), "rows still say send by hand");
    ok("…with the send window explained when it refuses", /waiting === "send_window"/.test(page), "a closed window would read as a crash");
    ok("every row can be dismissed, and all at once", /class="eh-dismiss"/.test(page) && /id="emailHealthDismissAll"/.test(page) && /\/api\/admin\/email-health\/dismiss/.test(page), "no dismiss controls");
    ok("…dismiss-all asks first and says nothing is sent", /Dismiss every one of these\? Nothing is sent\./.test(page), "no confirmation");
  }
} finally {
  for (const [f, buf] of backups) { if (buf == null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, buf); }
}

if (failures.length) {
  console.error(`\n✗ test-email-dismiss: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-email-dismiss: ${pass} assertions passed`);
