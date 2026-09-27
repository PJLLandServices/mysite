#!/usr/bin/env node
// scripts/test-project-materials.mjs
//
// MATERIALS: WHAT A LIST ASKS FOR IS NOT WHAT ARRIVED, AND NEITHER IS
// WHAT WENT INTO THE GROUND.
//
// Patrick's rulings, 2026-09-27:
//
//   1. "Remaining = received quantity − consumed quantity. Not
//      have − consumed, because 'have' is only a status. Call it
//      Project balance, not 'on the truck,' because material may be at
//      the shop, site or in your truck."
//   2. "Flag mismatches, but never block the crew. A technician must
//      still be able to record what was actually used... Do not
//      silently add mismatched usage to the BOM or material list."
//   3. Read-only first, and close the destructive server hole.
//   4. "Show every material list; do not invent a 'current' one."
//
//   Aggregation rule: "do not add required quantities or dollar totals
//   across multiple lists, because a later design list may repeat the
//   earlier BOM. Show those totals per list. Physical stock can be
//   shown project-wide by aggregating actual PO receipts by SKU and
//   subtracting onsite consumption once."
//
// THAT LAST RULE IS THE ONE WITH TEETH, and it is why this file exists
// rather than a simpler one. There are two kinds of number here:
//
//   PLANNING (required qty, dollars) belongs to ONE list. Re-syncing
//   the System Builder after purchasing creates a SECOND list that
//   repeats the same bill of materials, so adding them double-counts a
//   job that was only ever quoted once.
//
//   PHYSICAL (received, used, balance) are facts about atoms. A fitting
//   arrived once and was used once however many documents mention it,
//   so those DO aggregate — and consumption is subtracted exactly once.
//
// Run: node scripts/test-project-materials.mjs   (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4851;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.error("  FAIL " + name + (detail ? ` — ${detail}` : "")); }
};

// ---- Part 1: the read model, in isolation --------------------------
{
  const pm = require(path.join(ROOT, "server", "lib", "project-materials.js"));

  // Two lists for one job — the exact case the aggregation rule is
  // about. v2 is a re-synced design repeating v1's PVC line.
  const lists = [
    { id: "ML-1", name: "Design v1", status: "complete", createdAt: "2026-09-01",
      lineItems: [{ sku: "PVC100", qty: 10, status: "have", poId: "PO-1" },
                  { sku: "HEAD5", qty: 4, status: "have", poId: "PO-1" }] },
    { id: "ML-2", name: "Design v2", status: "draft", createdAt: "2026-09-10",
      lineItems: [{ sku: "PVC100", qty: 12, status: "need" }] }
  ];
  const pos = [{ id: "PO-1", sourceMaterialListIds: ["ML-1"],
    lineItems: [{ sku: "PVC100", qty: 10, receivedQty: 10 }, { sku: "HEAD5", qty: 4, receivedQty: 2 }] }];
  const wos = [
    { id: "WO-A", dailyLog: { workDate: "2026-09-20", materialsConsumed: [
      { partSku: "PVC100", qty: 6, note: "front run" }, { partSku: "MYSTERY", qty: 1, note: "off the truck" }] } },
    { id: "WO-B", dailyLog: { workDate: "2026-09-21", materialsConsumed: [{ partSku: "HEAD5", qty: 3 }] } }
  ];
  const parts = { PVC100: { name: "1in PVC 10ft", priceCents: 1250 }, HEAD5: { name: "5in spray head", priceCents: 640 } };
  const m = pm.describeProject({ lists, purchaseOrders: pos, buildWos: wos, partsMap: parts });
  const row = (sku) => m.stock.find((r) => r.sku === sku);

  // ── RULE 1 · balance is received − consumed ──────────────────────
  ok("balance is received minus used, not have minus used",
    row("PVC100").received === 10 && row("PVC100").usedOnsite === 6 && row("PVC100").projectBalance === 4,
    JSON.stringify(row("PVC100")));
  // HEAD5: the LIST says "have 4", but only 2 actually arrived. Using
  // the status would say 4 − 3 = 1 left. The truth is −1.
  ok("...so a line marked \"have\" does not invent stock that never arrived",
    row("HEAD5").received === 2 && row("HEAD5").projectBalance === -1,
    `list says have 4; received ${row("HEAD5").received}, balance ${row("HEAD5").projectBalance}`);
  ok("a negative balance is shown, not clamped to zero", row("HEAD5").projectBalance < 0);

  // ── THE AGGREGATION RULE · required is never summed ──────────────
  ok("a SKU on TWO lists gets no required total",
    row("PVC100").required === null && row("PVC100").requiredAmbiguous === true,
    JSON.stringify({ required: row("PVC100").required, ambiguous: row("PVC100").requiredAmbiguous }));
  ok("...and 10 + 12 = 22 appears nowhere",
    !m.stock.some((r) => r.required === 22) && JSON.stringify(m).indexOf('"required":22') === -1);
  ok("...the per-list figures are carried instead",
    row("PVC100").requiredByList.length === 2 &&
    row("PVC100").requiredByList.map((r) => r.qty).join(",") === "10,12",
    JSON.stringify(row("PVC100").requiredByList));
  ok("a SKU on ONE list does get its figure", row("HEAD5").required === 4);
  ok("a SKU on NO list is zero, not null — that is what makes it unplanned",
    row("MYSTERY").required === 0 && row("MYSTERY").requiredAmbiguous === false);

  // Dollars stay per list too.
  ok("dollar totals are per list, never project-wide",
    m.planning.length === 2 &&
    m.planning.every((p) => typeof p.totals.grandSubtotalCents === "number") &&
    !("grandSubtotalCents" in m.summary) && !("requiredUnits" in m.summary),
    JSON.stringify(m.summary));

  // ── Physical figures DO aggregate, and only once ─────────────────
  ok("received aggregates across POs", m.summary.receivedUnits === 12, String(m.summary.receivedUnits));
  ok("used aggregates across days", m.summary.usedUnits === 10, String(m.summary.usedUnits));
  ok("...and consumption is subtracted exactly once",
    m.summary.balanceUnits === 12 - 10, String(m.summary.balanceUnits));

  // ── RULE 2 · every mismatch flagged, with its evidence ───────────
  const kinds = (sku) => m.exceptions.filter((e) => e.sku === sku).map((e) => e.kind);
  ok("unplanned material is flagged", kinds("MYSTERY").includes("unplanned"));
  ok("more used than received is flagged", kinds("HEAD5").includes("over_consumed"));
  ok("an unknown SKU is flagged", kinds("MYSTERY").includes("unknown_sku"));
  const myst = m.exceptions.find((e) => e.sku === "MYSTERY" && e.kind === "unplanned");
  ok("...carrying the work order, date, quantity and note",
    myst.entries[0].woId === "WO-A" && myst.entries[0].workDate === "2026-09-20" &&
    myst.entries[0].qty === 1 && /off the truck/.test(myst.entries[0].note),
    JSON.stringify(myst.entries));
  // The crew's record is never folded back into planning.
  ok("mismatched usage is NOT added to any list",
    !m.planning.some((p) => JSON.stringify(p).includes("MYSTERY")),
    "MYSTERY must not appear in a material list");

  // ── RULE 4 · every list, newest first, no invented "current" ─────
  ok("every list is shown, newest first",
    m.planning.map((p) => p.id).join(",") === "ML-2,ML-1", m.planning.map((p) => p.id).join(","));
  ok("...with status, and PO links where they exist",
    m.planning[1].status === "complete" && m.planning[1].poIds.includes("PO-1"),
    JSON.stringify(m.planning[1].poIds));
  ok("...and nothing is marked \"current\"",
    !JSON.stringify(m.planning).match(/"(current|isCurrent|primary)"\s*:\s*true/),
    "no list may be inferred as current until the project stores its id");

  // ── Receipts come from POs, not from list status ─────────────────
  // A cancelled PO's delivered goods still arrived.
  const cancelled = pm.receivedBySku([{ id: "PO-X", status: "cancelled",
    lineItems: [{ sku: "PVC100", qty: 5, receivedQty: 5 }] }]);
  ok("a cancelled PO's already-received goods still count",
    cancelled.get("PVC100").qty === 5, JSON.stringify([...cancelled]));
  const deleted = pm.receivedBySku([{ id: "PO-Y", deletedAt: "2026-09-01",
    lineItems: [{ sku: "PVC100", qty: 5, receivedQty: 5 }] }]);
  ok("...but a deleted PO does not", !deleted.has("PVC100"));
}

// ---- Part 2: the destructive hole, closed on the SERVER ------------
//
// `update()` did `next.lineItems = patch.lineItems.map(hydrateLine)` —
// wholesale replacement, discarding every line's status, poId and
// frozenPriceCents. The only thing stopping a design re-sync wiping a
// purchased list was the BROWSER choosing to create a new list instead.
// A convention in one caller is not a guarantee.
{
  fs.mkdirSync(DATA, { recursive: true });
  const store = path.join(DATA, "material-lists.json");
  const backup = fs.existsSync(store) ? fs.readFileSync(store) : null;
  try {
    const ml = require(path.join(ROOT, "server", "lib", "material-lists.js"));
    const mk = async (lineItems, status) => {
      const rec = await ml.create({ name: "guard probe", parentType: "project", parentId: "PROJ-X", lineItems });
      if (status && status !== rec.status) {
        const all = JSON.parse(fs.readFileSync(store, "utf8"));
        const i = all.findIndex((r) => r.id === rec.id);
        all[i].status = status;
        fs.writeFileSync(store, JSON.stringify(all, null, 2));
      }
      return rec.id;
    };
    const replace = async (id) => {
      try { await ml.update(id, { lineItems: [{ sku: "NEW1", qty: 1 }] }); return null; }
      catch (err) { return err; }
    };

    // A clean draft may still be replaced — the System Builder's normal path.
    const draftId = await mk([{ sku: "PVC100", qty: 10 }], "draft");
    ok("a clean draft can still have its lines replaced", (await replace(draftId)) === null);

    // Past draft → refused.
    const doneId = await mk([{ sku: "PVC100", qty: 10 }], "complete");
    const e1 = await replace(doneId);
    ok("replacing the lines of a non-draft list is REFUSED",
      e1 && e1.code === "line_items_locked", String(e1 && e1.message).slice(0, 120));

    // Status says draft but a line is on a PO → still refused. The
    // status can be stale or hand-set; the lines are the evidence.
    const sneaky = await mk([{ sku: "PVC100", qty: 10, status: "ordered", poId: "PO-9" }], "draft");
    const e2 = await replace(sneaky);
    ok("...and refused even when the status still says draft, if a line is on a PO",
      e2 && e2.code === "line_items_locked", String(e2 && e2.message).slice(0, 120));

    // A price-locked line still marked "need".
    //
    // This shape cannot survive the store: hydrateLine() nulls a frozen
    // price on a "need" line on the way IN, so `update()` can never see
    // it. The rule is therefore asked of the named function directly —
    // which is the answer for any caller holding a record that has not
    // been through hydrate().
    const lockedBy = ml.lineItemsLockedBy({
      id: "ML-RAW", status: "draft",
      lineItems: [{ sku: "PVC100", qty: 10, status: "need", frozenPriceCents: 1250 }]
    });
    ok("...or price-locked, on a record that never went through hydrate",
      lockedBy && lockedBy.blockingSkus.includes("PVC100"), JSON.stringify(lockedBy));
    ok("one named rule, asked by update and by any other caller",
      typeof ml.lineItemsLockedBy === "function" &&
      ml.lineItemsLockedBy({ status: "draft", lineItems: [{ sku: "A", qty: 1, status: "need" }] }) === null);

    const received = await mk([{ sku: "PVC100", qty: 10, status: "have" }], "draft");
    const e4 = await replace(received);
    ok("...or already received", e4 && e4.code === "line_items_locked", String(e4 && e4.message).slice(0, 120));

    ok("the refusal names the parts that blocked it",
      Array.isArray(e2.blockingSkus) && e2.blockingSkus.includes("PVC100"), JSON.stringify(e2.blockingSkus));

    // And the purchasing state actually survived.
    const after = await ml.get(sneaky);
    ok("the purchased line is untouched after the refusal",
      after.lineItems[0].sku === "PVC100" && after.lineItems[0].poId === "PO-9" &&
      after.lineItems[0].status === "ordered",
      JSON.stringify(after.lineItems));

    // Other fields still editable on a locked list — the guard is about
    // lines, not a freeze on the whole record.
    const renamed = await ml.update(doneId, { notes: "picked up Tuesday" });
    ok("a locked list can still take notes and other fields", renamed.notes === "picked up Tuesday");
  } finally {
    if (backup === null) { if (fs.existsSync(store)) fs.rmSync(store); }
    else fs.writeFileSync(store, backup);
  }
}

// ---- Part 3: the endpoint, on a booted server ----------------------
{
  const TOUCHED = ["projects.json", "work-orders.json", "users.json", "material-lists.json", "purchase-orders.json"];
  const backups = new Map();
  for (const f of TOUCHED) {
    const p = path.join(DATA, f);
    backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
  }
  const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });

  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { await fetch(`${BASE}/api/booking/services`); up = true; } catch { /* booting */ }
    }
    if (!up) throw new Error("server never came up:\n" + logs.slice(-1500));

    const users = require(path.join(ROOT, "server", "lib", "users.js"));
    fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
    await users.create({ email: "mat@local.test", name: "Marguerite Sowande", role: "admin", password: "mat-probe-12345" });
    const login = await fetch(`${BASE}/api/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "mat@local.test", password: "mat-probe-12345" })
    });
    const cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
      .map((c) => String(c).split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
    ok("the office can sign in", Boolean(cookie));

    const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
    const proj = await projects.create({ name: "Materials — Keswick install", customerName: "Keswick Co" });
    await projects.update(proj.id, { status: "active", buildTracking: true });

    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/materials`, { headers: { cookie } });
    const j = await r.json();
    ok("the materials endpoint answers", r.ok, String(r.status));
    ok("...with the three sections",
      Array.isArray(j.planning) && Array.isArray(j.stock) && Array.isArray(j.exceptions),
      JSON.stringify(Object.keys(j)));
    ok("...and an empty job is empty, not an error",
      j.planning.length === 0 && j.stock.length === 0 && j.exceptions.length === 0);

    const anon = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/materials`);
    ok("signed out, it refuses", anon.status >= 400, String(anon.status));
    const missing = await fetch(`${BASE}/api/projects/PROJ-NOPE/materials`, { headers: { cookie } });
    ok("an unknown project is a 404", missing.status === 404, String(missing.status));
  } finally {
    child.kill("SIGTERM");
    for (const [f, buf] of backups) {
      const p = path.join(DATA, f);
      if (buf === null) { if (fs.existsSync(p)) fs.rmSync(p); }
      else fs.writeFileSync(p, buf);
    }
  }
}

// ---- Part 4: no second totals calculation in React -----------------
{
  const tab = fs.readFileSync(path.join(ROOT, "admin-app", "src", "routes", "Materials.tsx"), "utf8");
  // The page may sum nothing. Every figure comes from the server.
  ok("the Materials tab does no arithmetic on money",
    !/Cents\s*[*+/-]|\*\s*qty|qty\s*\*/.test(tab.replace(/grandSubtotalCents \/ 100/g, "")),
    "found arithmetic on cents or quantities in the tab");
  ok("...and does not re-add across lists",
    !/planning[\s\S]{0,80}\.reduce\(/.test(tab),
    "the tab must not reduce over planning — those totals are per list");
}

console.log(`\nproject materials: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
