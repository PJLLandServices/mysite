#!/usr/bin/env node
// scripts/audit-po-list-lines.mjs
//
// READ-ONLY. Lists every material-list line that disagrees with the
// purchase order it was ordered on — the lines the PO / list save split
// could leave behind (2026-09-27 → the purchasing.js one-commit fix) — with
// the one deterministic repair each would need. It opens files for reading
// only and never writes, normalises or saves anything.
//
// The rule is server/lib/purchasing-audit.js — the same function, whichever
// way it runs:
//
//   node scripts/audit-po-list-lines.mjs                 server/data on this machine
//   node scripts/audit-po-list-lines.mjs --data <dir>    another data directory
//   node scripts/audit-po-list-lines.mjs --from po.json lists.json
//        saved responses of GET /api/purchase-orders and
//        GET /api/material-lists?includeArchived=1
//   node scripts/audit-po-list-lines.mjs --browser
//        prints a snippet to paste into the browser console while signed in
//        to the admin site: it READS those two endpoints and prints this
//        report. GET requests only.
//   add --json for the raw findings.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { auditPurchasingLines, formatPurchasingAudit } = require(path.join(ROOT, "server", "lib", "purchasing-audit.js"));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const after = (name, n = 1) => { const i = args.indexOf(name); return i === -1 ? null : args.slice(i + 1, i + 1 + n); };

if (flag("--browser")) {
  // Read-only by construction: two same-origin GETs (fetch's default
  // method), no headers, no body. Nothing is stored in the page or sent
  // anywhere; the report is printed to this Console and, if the browser
  // allows it, copied to the clipboard.
  const snippet = `(async () => {
  const auditPurchasingLines = ${auditPurchasingLines.toString()};
  const formatPurchasingAudit = ${formatPurchasingAudit.toString()};
  const get = async (url) => {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error(url + " answered " + r.status);
    return r.json();
  };
  const po = await get("/api/purchase-orders");
  const ml = await get("/api/material-lists?includeArchived=1");
  const result = auditPurchasingLines({ purchaseOrders: po.purchaseOrders || [], materialLists: ml.lists || [] });
  let text = formatPurchasingAudit(result);
  text += "\\nSource: " + location.host + " — " + (po.purchaseOrders || []).length + " purchase orders, " + (ml.lists || []).length + " material lists (Trash not included)";
  if (po.purchasingRecovery) text += "\\nServer recovery status: " + JSON.stringify(po.purchasingRecovery);
  console.log(text);
  try { copy(text); console.log("(The report above is also on your clipboard.)"); } catch (e) {}
})();`;
  process.stdout.write(snippet + "\n");
  process.exit(0);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
let purchaseOrders, materialLists, source;
const from = after("--from", 2);
if (from && from.length === 2) {
  const po = readJson(from[0]);
  const ml = readJson(from[1]);
  purchaseOrders = Array.isArray(po) ? po : po.purchaseOrders || [];
  materialLists = Array.isArray(ml) ? ml : ml.lists || [];
  source = `${from[0]} + ${from[1]}`;
} else {
  const dir = (after("--data") || [path.join(ROOT, "server", "data")])[0];
  const read = (name) => { const p = path.join(dir, name); return fs.existsSync(p) ? readJson(p) : []; };
  purchaseOrders = read("purchase-orders.json");
  materialLists = read("material-lists.json");
  source = dir;
}

const result = auditPurchasingLines({ purchaseOrders, materialLists });
if (flag("--json")) {
  process.stdout.write(JSON.stringify({ source, ...result }, null, 2) + "\n");
} else {
  console.log(`Source: ${source} — ${purchaseOrders.length} purchase orders, ${materialLists.length} material lists`);
  console.log(formatPurchasingAudit(result));
}
