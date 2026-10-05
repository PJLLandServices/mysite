// Parts picker rows — one row per real fitting (P-PJL-35 M2a).
//
// Shared by the Material List page (browser: window.PickerRows) and its
// test (Node: require). Pure functions over the /api/parts catalog and the
// /api/suppliers list; nothing here writes anything.
//
// The rules Patrick set:
//   - Part numbers linked as the SAME fitting (a verified photo group) are
//     ONE row. Only verified members are merged; a member waiting for
//     review, or hidden after an edit, stays its own row.
//   - The row shows the fitting's DEFAULT part (chosen on the Part photos
//     page, else the canonical part — decided server-side, fittingDefaultSku):
//     its description, part #, price and supplier chip, and main Add adds it.
//   - The price is what that Add will use (the part's catalog price, i.e.
//     its default supplier's). Never the cheapest.
//   - Every supplier offer behind the row is listed. An offer can be added
//     only when adding its part number reaches that supplier today — i.e.
//     it is that part's default supplier. Choosing a different supplier for
//     the same part number isn't possible yet ("Supplier selection coming
//     next"); material-list lines and PO routing are unchanged.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PickerRows = api;
})(typeof self !== "undefined" ? self : this, function () {
  const COMING_NEXT = "Supplier selection coming next";
  const ARCHIVED = "Supplier archived";

  function isFittingMember(part) {
    return !!(part && part.photoState === "verified" && part.photo && part.photo.groupId && part.photo.fittingDefaultSku);
  }

  // parts: array of catalog parts. Returns rows in the input order of each
  // row's first-seen member: { key, groupId, defaultPart, members }.
  function buildRows(parts) {
    const rows = [];
    const byGroup = new Map();
    for (const part of parts || []) {
      if (!part || !part.sku) continue;
      if (!isFittingMember(part)) {
        rows.push({ key: "sku:" + part.sku, groupId: null, defaultPart: part, members: [part] });
        continue;
      }
      const gid = part.photo.groupId;
      let row = byGroup.get(gid);
      if (!row) {
        row = { key: "fit:" + gid, groupId: gid, defaultPart: null, members: [] };
        byGroup.set(gid, row);
        rows.push(row);
      }
      row.members.push(part);
    }
    for (const row of byGroup.values()) {
      const wanted = row.members[0].photo.fittingDefaultSku;
      row.defaultPart = row.members.find((p) => p.sku === wanted) || row.members[0];
      // Default first, the rest by part number — a stable panel order.
      row.members.sort((a, b) => (a === row.defaultPart ? -1 : b === row.defaultPart ? 1 : a.sku.localeCompare(b.sku)));
    }
    return rows;
  }

  // suppliersById: { id: { id, name, shortName, archived, logo } }.
  // Returns one offer per (member part × supplier), default part first.
  function offersFor(row, suppliersById) {
    const offers = [];
    const sup = (id) => (suppliersById && suppliersById[id]) || null;
    for (const part of row.members) {
      const isDefaultPart = part === row.defaultPart;
      const ids = Array.isArray(part.supplierIds) ? part.supplierIds.filter(Boolean) : [];
      const prices = part.supplierPrices || {};
      if (!ids.length) {
        offers.push({
          sku: part.sku, supplierId: null, supplier: null, supplierSku: null,
          priceCents: part.priceCents, isDefault: isDefaultPart, isPartDefault: true,
          canAdd: true, reason: "No supplier set"
        });
      }
      ids.forEach((sid, i) => {
        const s = sup(sid);
        const primary = i === 0;
        const archived = !!(s && s.archived);
        offers.push({
          sku: part.sku,
          supplierId: sid,
          supplier: s,
          supplierSku: (prices[sid] && prices[sid].supplierSku) || null,
          // The default supplier's price is exactly what Add will use.
          priceCents: primary ? part.priceCents : (prices[sid] ? prices[sid].priceCents : null),
          isDefault: isDefaultPart && primary,
          isPartDefault: primary,
          canAdd: primary && !archived,
          reason: archived ? ARCHIVED : primary ? null : COMING_NEXT
        });
      });
      // A quote from a supplier not (yet) assigned to this part.
      for (const sid of Object.keys(prices)) {
        if (ids.includes(sid)) continue;
        const s = sup(sid);
        offers.push({
          sku: part.sku, supplierId: sid, supplier: s,
          supplierSku: prices[sid].supplierSku || null, priceCents: prices[sid].priceCents,
          isDefault: false, isPartDefault: false, canAdd: false,
          reason: s && s.archived ? ARCHIVED : COMING_NEXT
        });
      }
    }
    return offers;
  }

  // The chip: the default part's default supplier, and how many OTHER
  // suppliers sit behind the row.
  function chipFor(row, suppliersById) {
    const d = row.defaultPart;
    const primaryId = (d.supplierIds && d.supplierIds[0]) || null;
    const others = new Set();
    for (const o of offersFor(row, suppliersById)) {
      if (o.supplierId && o.supplierId !== primaryId) others.add(o.supplierId);
    }
    return { supplierId: primaryId, supplier: primaryId ? (suppliersById && suppliersById[primaryId]) || null : null, more: others.size };
  }

  function norm(s) {
    return String(s == null ? "" : s).toLowerCase().replace(/["″]/g, "");
  }
  // Every word must appear somewhere in the row: any member's part #,
  // description, size or category, or any supplier's own part #.
  function rowMatches(row, query) {
    const q = norm(query).trim();
    if (!q) return true;
    const hay = [];
    for (const p of row.members) {
      hay.push(p.sku, p.partNumber, p.description, p.category, p.subcategory, p.size, p.manufacturer);
      // Numbers that were merged into this part (lib/parts.js "merged").
      for (const a of Array.isArray(p.aliases) ? p.aliases : []) hay.push(a);
      for (const v of Object.values(p.supplierPrices || {})) hay.push(v && v.supplierSku);
    }
    const text = norm(hay.filter(Boolean).join(" "));
    return q.split(/\s+/).every((t) => text.includes(t));
  }

  // How many of this row's parts are already in the list (qty), so the
  // "in list" state covers the whole fitting.
  function qtyInList(row, lineItems) {
    const skus = new Set(row.members.map((p) => p.sku));
    let n = 0;
    for (const l of lineItems || []) if (skus.has(l.sku)) n += Number(l.qty) || 0;
    return n;
  }

  function monogram(supplier) {
    const name = (supplier && (supplier.shortName || supplier.name)) || "?";
    const words = name.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
    return ((words[0] || "?")[0] + (words[1] ? words[1][0] : "")).toUpperCase();
  }

  return { buildRows, offersFor, chipFor, rowMatches, qtyInList, monogram, COMING_NEXT, ARCHIVED };
});
