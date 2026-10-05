// server/lib/project-materials.js
//
// One read model for the Materials tab.
//
// Patrick's rulings, 2026-09-27:
//
//   "Remaining = received quantity − consumed quantity. Not have −
//    consumed, because 'have' is only a status. Call it Project
//    balance, not 'on the truck,' because material may be at the shop,
//    site or in your truck."
//
//   "Do not add required quantities or dollar totals across multiple
//    lists, because a later design list may repeat the earlier BOM.
//    Show those totals per list. Physical stock can be shown
//    project-wide by aggregating actual PO receipts by SKU and
//    subtracting onsite consumption once."
//
// That second rule is the whole shape of this file. There are two
// different kinds of number here and they must not be mixed:
//
//   PLANNING numbers (required qty, dollar totals) belong to ONE list.
//   Re-syncing the System Builder after purchasing creates a SECOND
//   list that repeats the same BOM, so summing them double-counts a
//   job that was only ever quoted once.
//
//   PHYSICAL numbers (received, used, balance) are facts about atoms.
//   A given fitting was received once and used once no matter how many
//   planning documents mention it, so these DO aggregate project-wide —
//   and consumption is subtracted exactly once.
//
// Everything below is computed here so the page renders text. No second
// totals calculation in React: that is the rule that came out of the
// progress bar (#306), the person-hours (#315) and computeTotals, which
// still exists twice — once on the server and once in
// server/material-list.js, with different field names.

const materialLists = require("./material-lists");
const partAlias = require("./part-alias");

// ---- Physical stock ------------------------------------------------

// What actually arrived, by SKU.
//
// Counted from PO line `receivedQty`, which is the record of goods
// through the door — NOT from a material line's "have" status, which is
// a planning state a human can set by hand.
//
// Cancelled POs still count: "already-received lines stay have — can't
// undo a delivery" (purchase-orders.js). The goods arrived; cancelling
// the paperwork afterwards does not send them back.
function receivedBySku(purchaseOrders) {
  const out = new Map();
  for (const po of purchaseOrders || []) {
    if (po?.deletedAt) continue;
    for (const line of po?.lineItems || []) {
      const sku = partAlias.canonical(String(line?.sku || "").trim());
      if (!sku) continue;
      const got = Math.max(0, Math.floor(Number(line?.receivedQty) || 0));
      if (!got) continue;
      const prev = out.get(sku) || { qty: 0, poIds: [] };
      prev.qty += got;
      if (!prev.poIds.includes(po.id)) prev.poIds.push(po.id);
      out.set(sku, prev);
    }
  }
  return out;
}

// What the crew recorded using, by SKU.
//
// Each build work order's daily log holds
// `materialsConsumed: [{ partSku, qty, addedAt, note }]`. Summed ONCE
// across the job: a work order appears in this list once, so a fitting
// cannot be subtracted twice.
function consumedBySku(buildWos) {
  const out = new Map();
  for (const wo of buildWos || []) {
    const dl = wo?.dailyLog || {};
    for (const used of dl.materialsConsumed || []) {
      const sku = partAlias.canonical(String(used?.partSku || "").trim());
      if (!sku) continue;
      const qty = Number(used?.qty) || 0;
      if (qty <= 0) continue;
      const prev = out.get(sku) || { qty: 0, entries: [] };
      prev.qty += qty;
      prev.entries.push({
        woId: wo.id,
        workDate: dl.workDate || null,
        qty,
        note: used?.note || "",
        addedAt: used?.addedAt || null
      });
      out.set(sku, prev);
    }
  }
  return out;
}

// What each list ASKS for, kept per list rather than summed.
//
// The map is sku -> [{ listId, listName, qty, status }], deliberately a
// list and not a total. A SKU on two lists is one requirement stated
// twice, and there is no safe way to tell that apart from two genuine
// requirements without a field the project does not yet have.
function requiredBySku(lists) {
  const out = new Map();
  for (const list of lists || []) {
    if (list?.status === "archived") continue;
    for (const line of list?.lineItems || []) {
      const sku = partAlias.canonical(String(line?.sku || "").trim());
      if (!sku) continue;
      const prev = out.get(sku) || [];
      prev.push({
        listId: list.id,
        listName: list.name || list.id,
        qty: Number(line.qty) || 0,
        status: line.status || "need",
        poId: line.poId || null
      });
      out.set(sku, prev);
    }
  }
  return out;
}

// ---- The stock table -----------------------------------------------

// Required / Received / Used onsite / Project balance, per SKU.
//
// `required` is null — not zero, and never a sum — when the SKU appears
// on more than one list. Printing a total there would be inventing one
// of exactly the numbers Patrick ruled out. The per-list figures are
// carried alongside so the screen can show them instead.
function stockBySku({ lists, purchaseOrders, buildWos, partsMap = {} }) {
  const required = requiredBySku(lists);
  const received = receivedBySku(purchaseOrders);
  const consumed = consumedBySku(buildWos);

  const skus = new Set([...required.keys(), ...received.keys(), ...consumed.keys()]);
  const rows = [];
  for (const sku of skus) {
    const reqRows = required.get(sku) || [];
    const got = received.get(sku) || { qty: 0, poIds: [] };
    const used = consumed.get(sku) || { qty: 0, entries: [] };
    const part = partsMap[sku] || null;

    rows.push({
      sku,
      name: part?.name || part?.description || null,
      known: Boolean(part),
      // Three distinct cases, kept distinct. No list asking for it is
      // ZERO — a real answer, and the thing that makes it unplanned.
      // One list is that list's figure. Several is NOT a sum and not a
      // zero: it is null, with requiredAmbiguous saying why, so the
      // screen shows the per-list figures instead of inventing a total.
      required: reqRows.length === 0 ? 0 : (reqRows.length === 1 ? reqRows[0].qty : null),
      requiredAmbiguous: reqRows.length > 1,
      requiredByList: reqRows,
      received: got.qty,
      receivedFromPoIds: got.poIds,
      usedOnsite: used.qty,
      usedEntries: used.entries,
      // THE number: what the job still holds, wherever it physically is.
      projectBalance: got.qty - used.qty
    });
  }
  rows.sort((a, b) => a.sku.localeCompare(b.sku));
  return rows;
}

// ---- Exceptions ------------------------------------------------------
//
// "Flag mismatches, but never block the crew. A technician must still be
// able to record what was actually used."
//
// So nothing here refuses anything. These are things for the office to
// look at, each carrying the work order, date, quantity and note that
// created it — and mismatched usage is NEVER folded back into a list.
function exceptionsFor(rows, lists, partsMap = {}) {
  const out = [];

  for (const row of rows) {
    // Used on site, but on no list for this project.
    if (row.usedOnsite > 0 && row.requiredByList.length === 0) {
      out.push({
        kind: "unplanned",
        sku: row.sku,
        name: row.name,
        detail: `Used on site but not on any material list for this job.`,
        qty: row.usedOnsite,
        entries: row.usedEntries
      });
    }
    // More went out than ever came in.
    if (row.usedOnsite > row.received) {
      out.push({
        kind: "over_consumed",
        sku: row.sku,
        name: row.name,
        detail: `${row.usedOnsite} used against ${row.received} received — ${row.usedOnsite - row.received} more than arrived.`,
        qty: row.usedOnsite - row.received,
        entries: row.usedEntries
      });
    }
    // A SKU nothing in the catalog recognises.
    if (!row.known) {
      out.push({
        kind: "unknown_sku",
        sku: row.sku,
        name: null,
        detail: `Not in the parts catalog, so it has no name and no price.`,
        qty: row.usedOnsite || row.received || 0,
        entries: row.usedEntries
      });
    }
  }

  // Priced-unavailable lines, which the list totals already count but
  // which are easy to miss inside a long list.
  for (const list of lists || []) {
    if (list?.status === "archived") continue;
    for (const line of list?.lineItems || []) {
      const unit = materialLists.resolveLineUnitPriceCents(line, partsMap);
      if (unit == null) {
        out.push({
          kind: "price_unavailable",
          sku: line.sku,
          name: (partsMap[line.sku] || {}).name || null,
          detail: `No price available on ${list.id}, so it counts as $0 in that list's total.`,
          qty: Number(line.qty) || 0,
          entries: []
        });
      }
    }
  }

  return out;
}

// ---- The whole tab ---------------------------------------------------

function describeProject({ lists = [], purchaseOrders = [], buildWos = [], partsMap = {} } = {}) {
  // Planning: each list on its own, newest first, with its OWN totals.
  // No cross-list arithmetic anywhere in here.
  const planning = [...lists]
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map((list) => ({
      id: list.id,
      name: list.name || list.id,
      status: list.status,
      createdAt: list.createdAt || null,
      updatedAt: list.updatedAt || null,
      notes: list.notes || "",
      // Straight from the server's own computeTotals — the page never
      // re-adds these.
      totals: materialLists.computeTotals(list, partsMap),
      lineCount: (list.lineItems || []).length,
      // The POs this list produced, so the screen can link them.
      poIds: [...new Set((list.lineItems || []).map((l) => l.poId).filter(Boolean))],
      href: `/admin/material-list/${encodeURIComponent(list.id)}`
    }));

  const stock = stockBySku({ lists, purchaseOrders, buildWos, partsMap });
  const exceptions = exceptionsFor(stock, lists, partsMap);

  return {
    planning,
    // Deliberately NOT a project-wide required total or dollar figure.
    // Those live per list, above.
    stock,
    exceptions,
    summary: {
      listCount: planning.length,
      // Physical, so safe to aggregate.
      skuCount: stock.length,
      receivedUnits: stock.reduce((s, r) => s + r.received, 0),
      usedUnits: stock.reduce((s, r) => s + r.usedOnsite, 0),
      balanceUnits: stock.reduce((s, r) => s + r.projectBalance, 0),
      exceptionCount: exceptions.length
    }
  };
}

module.exports = {
  receivedBySku,
  consumedBySku,
  requiredBySku,
  stockBySku,
  exceptionsFor,
  describeProject
};
