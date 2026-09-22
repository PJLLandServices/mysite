/* ═══════════ PJL — export a System Builder design, and nothing else ═══════════

   Paste this into the browser console with the System Builder open on the
   project you want compared. It downloads ONE file containing only the
   numbers the calculation engine reads, and refuses to download at all if
   it finds anything that looks like personal information.

   HOW TO USE IT
     1. Open the project in the System Builder and wait for it to finish
        loading (the areas are drawn).
     2. Press F12, click "Console".
     3. Paste this whole file, press Enter.
     4. It prints exactly what it kept and what it dropped, then downloads
        pjl-design-fixture.json to your Downloads folder.

   Nothing is saved, changed or sent anywhere. It only reads what the page
   already has in memory and hands you a file.

   To also replace your area names with "Area 1, Area 2 …", run this first:
       PJL_REDACT_NAMES = true

   There is a short form of this in scripts/export-design-fixture-short.js —
   same allowlist and the same two guards, small enough to paste out of a
   message instead of opening a file.

   WHY AN ALLOWLIST

   This does NOT take the saved design and delete the sensitive parts. It
   starts from nothing and copies across only the fields named below —
   the ones the engine provably reads. A field nobody thought about, or
   one added to the builder next year, is excluded because it was never
   named, rather than included because nobody remembered to remove it.
   Deny-lists fail silently in the dangerous direction; allow-lists fail
   in the safe one.                                                        */
(() => {
  "use strict";

  // ── Exactly what the calculation engine reads ──────────────────────
  const INPUT_KEYS = ["availGPM", "psi", "supply", "ceiling", "spacingFactor"];
  const AREA_KEYS = [
    "aid", "name", "mode", "L", "W", "sqft", "avgW",
    "family", "head",                                  // `head` = legacy v1 designs
    "rotorNoz", "mpNoz", "sprayBody", "spraySeries", "stripNoz", "stripBody",
    "dripProduct", "overagePct", "dripRowIn", "dripDir",
    "valveGroup", "shapeKind", "layout"
  ];
  const HEAD_KEYS = ["x", "y", "arc", "dir", "noz", "zone", "rPct"];
  const TREE_KEYS = ["x", "y", "type", "dia"];
  const pick = (o, keys) => {
    const out = {};
    for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k];
    return out;
  };
  const pt = (p) => ({ x: p.x, y: p.y });

  if (typeof serializeState !== "function") {
    console.error("%cThis isn't the System Builder page.", "color:#b00;font-weight:700");
    console.error("Open the project in the System Builder first, then paste this again.");
    return;
  }
  const live = serializeState();
  if (!live || !Array.isArray(live.areas) || !live.areas.length) {
    console.error("%cNo design is loaded.", "color:#b00;font-weight:700");
    console.error("Open the project and wait for the areas to draw, then paste this again.");
    return;
  }

  const redact = typeof PJL_REDACT_NAMES !== "undefined" && PJL_REDACT_NAMES === true;
  const groupAlias = new Map();

  const fixture = {
    _what: "PJL System Builder design — calculation inputs only. No customer, financial or account data.",
    _exportedAt: new Date().toISOString(),
    version: live.version,
    // The two figures the engine reads off the form, plus the supply
    // context. Water-cost fields (town, run times, rates) are NOT here:
    // they are a separate document and the town is a location.
    inputs: pick(live.inputs || {}, INPUT_KEYS),
    // Four checkboxes and a 0-10 slider. No text.
    waterSupply: pick(live.waterSupply || {}, ["hosebibTested", "newSupplyRequired", "flowSensorRequired", "installDifficulty"]),
    // Hand edits to the parts list: SKU codes and quantities only.
    bomOverrides: {
      edits: Object.fromEntries(Object.entries((live.bomOverrides || {}).edits || {})
        .map(([sku, e]) => [sku, pick(e, ["sku", "qty"])])),
      removed: Object.fromEntries(Object.keys((live.bomOverrides || {}).removed || {}).map((k) => [k, true])),
      custom: (((live.bomOverrides || {}).custom) || []).map((c) => pick(c, ["sku", "qty"]))
    },
    valveGroupModes: Object.fromEntries(Object.entries(live.valveGroupModes || {})
      .map(([g, m]) => [redact ? alias(g) : g, m])),
    areas: live.areas.map((a, i) => {
      const o = pick(a, AREA_KEYS);
      if (redact) {
        o.name = "Area " + (i + 1);
        if (o.valveGroup) o.valveGroup = alias(o.valveGroup);
      }
      if (Array.isArray(a.poly)) o.poly = a.poly.map(pt);
      if (a.arc) o.arc = pick(a.arc, ["cx", "cy", "r", "a0", "sweep"]);
      if (a.circle) o.circle = pick(a.circle, ["cx", "cy", "r"]);
      if (Array.isArray(a.manualHeads)) o.manualHeads = a.manualHeads.map((h) => pick(h, HEAD_KEYS));
      if (Array.isArray(a.trees)) o.trees = a.trees.map((t) => pick(t, TREE_KEYS));
      // Which traced sheet the area sits on — an opaque page id, never the
      // drawing itself. The site plan is on the project, not in here.
      if (a.planRef && a.planRef.pageId) o.planRef = { pageId: a.planRef.pageId };
      return o;
    }),
    // Valve boxes, the point of connection and any split lines, in sheet
    // feet. Coordinates on a drawing, with no address attached to them.
    routing: Object.fromEntries(Object.entries(live.routing || {}).map(([pageId, r]) => [pageId, {
      poc: r.poc ? pt(r.poc) : null,
      main: (r.main || []).map((p) => ({ x: p.x, y: p.y, p: p.p })),
      manifolds: (r.manifolds || []).map((m) => ({ x: m.x, y: m.y, id: m.id })),
      pins: { ...(r.pins || {}) },
      splits: Object.fromEntries(Object.entries(r.splits || {})
        .map(([k, s]) => [k, pick(s, ["ax", "ay", "bx", "by"])])),
      latSize: { ...(r.latSize || {}) },
      laterals: Object.fromEntries(Object.entries(r.laterals || {})
        .map(([k, v]) => [k, (v || []).map(pt)]))
    }])),
    _excluded: [
      "linkedQuoteId — the quote this design is attached to",
      "water-cost fields (town, run times, cycles, weeks, rates, per-zone overrides)",
      "savedAt — replaced by _exportedAt",
      "everything on the project record: customer, address, email, phone, notes,",
      "  quotes, invoices, payments, tasks, journal, attachments, site-plan images",
      "  — none of which is in the design blob to begin with"
    ]
  };

  function alias(g) {
    if (!groupAlias.has(g)) groupAlias.set(g, "Group " + String.fromCharCode(65 + groupAlias.size));
    return groupAlias.get(g);
  }

  // ── Refuse to hand over a file that is missing a calculation input ──
  //
  // A blank GPM ceiling or spacing factor does not fail loudly downstream:
  // the engine's own `|| 1` and `Math.max(…, 0.1)` fallbacks quietly stand
  // in for it, and the comparison then runs against a design that is not
  // the one on screen. Better to stop here and say which field is empty.
  const REQUIRED = [["ceiling", "Zone GPM ceiling"], ["spacingFactor", "Head spacing"], ["availGPM", "Available flow"]];
  const missing = REQUIRED.filter(([k]) => {
    const v = fixture.inputs[k];
    return v === undefined || v === null || String(v).trim() === "";
  });
  if (missing.length) {
    console.error("%cSTOPPED — nothing was downloaded.", "color:#b00;font-size:14px;font-weight:700");
    console.error("These boxes in section 1 · Water Supply are empty: " + missing.map((m) => m[1]).join(", "));
    console.error("The comparison would silently substitute a default for them, so it would not be");
    console.error("comparing the design you are looking at. Fill them in and paste this again.");
    return;
  }

  // ── Refuse to hand over a file that looks like it has PII in it ─────
  const text = JSON.stringify(fixture);
  const SNIFF = [
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "an email address"],
    [/(\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}/, "a phone number"],
    [/\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/, "a postal code"],
    [/\b\d{1,5}\s+[A-Z][a-z]+\s+(St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Ct|Court|Cres|Blvd|Way|Lane|Ln|Hwy|Highway)\b/, "a street address"],
    [/\b(Q|I)-\d{4}-\d{4}\b/, "a quote or invoice number"],
    [/data:[a-z]+\/[a-z0-9.+-]+;base64,/i, "an embedded file"]
  ];
  const hits = SNIFF.filter(([re]) => re.test(text));
  if (hits.length) {
    console.error("%cSTOPPED — nothing was downloaded.", "color:#b00;font-size:14px;font-weight:700");
    console.error("The export looks like it contains " + hits.map((h) => h[1]).join(" and ") + ".");
    console.error("Most likely one of your AREA NAMES has it in. Run this and paste again:");
    console.error("    PJL_REDACT_NAMES = true");
    return;
  }

  // ── Tell Patrick exactly what is in the file ────────────────────────
  const heads = fixture.areas.reduce((t, a) => t + ((a.manualHeads || []).length), 0);
  const trees = fixture.areas.reduce((t, a) => t + ((a.trees || []).length), 0);
  console.log("%cPJL design export — calculation inputs only", "color:#1b4d2e;font-size:14px;font-weight:700");
  console.table({
    "areas": fixture.areas.length,
    "hand-placed heads": heads,
    "trees": trees,
    "traced sheets (routing)": Object.keys(fixture.routing).length,
    "GPM ceiling": fixture.inputs.ceiling,
    "spacing factor": fixture.inputs.spacingFactor,
    "available GPM": fixture.inputs.availGPM,
    "area names": redact ? "REDACTED to Area 1, Area 2 …" : "kept (your own labels)",
    "size": (text.length / 1024).toFixed(0) + " KB"
  });
  console.log("%cKept:", "font-weight:700", Object.keys(fixture).filter((k) => !k.startsWith("_")).join(", "));
  console.log("%cExcluded:", "font-weight:700");
  fixture._excluded.forEach((x) => console.log("   · " + x));
  console.log("%cChecked for emails, phone numbers, postal codes, street addresses,\nquote/invoice numbers and embedded files — none found.", "color:#1b4d2e");

  const blob = new Blob([JSON.stringify(fixture, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "pjl-design-fixture.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  console.log("%cDownloaded: pjl-design-fixture.json", "color:#1b4d2e;font-weight:700");
})();
