// Issue → quote line-item rollup. Pure function (no I/O) that walks
// wo.zones[].issues[] and returns priced line items + totals using
// pricing.json as the catalog. Drives the on-site Issues → Draft Quote
// flow per spec §4.3.2.
//
// Hard rules from pricing.json that this module enforces:
//   - whole_manifold_rule: ANY valve in a box fails → replace the entire
//     manifold AND every valve in that box. Single-valve repair never
//     happens. Implemented per-zone: leak + valve issues collapse into
//     ONE manifold line + N valve_hunter_pgv lines.
//   - spring_fall_no_service_call: spring opening / fall closing prices
//     are all-in. service_call is NOT charged on top. Doesn't apply
//     here — this module only runs on find_and_fix mode (service visits
//     + spring openings that found discoverable repairs). Spring repairs
//     ARE billed separately from the spring-opening fee, so service_call
//     does prepend in this flow.
//   - ai_intake_correct_diagnosis_bonus: when wo.intakeGuarantee.applies is
//     true, the original AI quote's $95 service_call (mobilization + on-site
//     assessment) was already paid as part of the original visit. New on-site
//     finds during that same visit add a $0 service_call line tagged "trip
//     already paid on AI-quoted visit" so the customer doesn't pay a second
//     mobilization fee. NOTE: the labour line for new finds bills normally
//     at $95/hr — the bonus's 1-hour free credit applies ONLY to the
//     diagnosed scope, NOT to anything found beyond it. (See pricing.json
//     ai_intake_correct_diagnosis_bonus rule.)
//
// Output shape — each line item:
//   {
//     key:           "head_replacement",   // pricing.json key, or null for custom
//     label:         "Sprinkler head replacement (any size, any type)",
//     qty:           2,
//     originalPrice: 68,                   // from pricing.json at rollup time
//     overridePrice: null,                 // tech can override later, null = no override
//     custom:        false,                // true for free-form lines (other type, manual adds)
//     source: {
//       zoneNumbers: [3, 4],               // zones this line aggregates from (multi for service_call)
//       issueIds:    ["iss_abc", "iss_def"]
//     },
//     note:          "concatenated issue notes (optional)"
//   }
//
// Totals follow the same rounding rules as quotes.js (HST 13%, 2 decimal).

const HST_RATE = 0.13;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function priceOf(pricing, key) {
  const item = pricing && pricing.items && pricing.items[key];
  return item ? Number(item.price) || 0 : 0;
}

function labelOf(pricing, key, fallback = "") {
  const item = pricing && pricing.items && pricing.items[key];
  return (item && item.label) || fallback;
}

// Build a line item shaped for both the in-flight builder UI and the
// downstream Quote record. Source zone/issue info gets passed in so the
// final Quote can trace each line back to the issue that spawned it.
function buildLine({ key, label, qty, price, custom, source, note }) {
  const safeQty = Math.max(1, Math.floor(Number(qty) || 1));
  const safePrice = Number.isFinite(Number(price)) ? Number(price) : 0;
  return {
    key: key || null,
    label: label || (key ? key : "Custom line"),
    qty: safeQty,
    originalPrice: round2(safePrice),
    overridePrice: null,
    custom: !!custom,
    source: source || { zoneNumbers: [], issueIds: [] },
    note: note || ""
  };
}

// Compute the effective unit price for a line, accounting for any tech
// override. Used both during rollup totalling and at customer-accept
// time when prices snapshot into the Quote.
function effectivePrice(line) {
  if (line.custom && line.overridePrice == null) {
    return Number(line.originalPrice) || 0;
  }
  if (line.overridePrice != null && Number.isFinite(Number(line.overridePrice))) {
    return Number(line.overridePrice);
  }
  return Number(line.originalPrice) || 0;
}

function totalsFor(lines) {
  let subtotal = 0;
  for (const line of lines) {
    subtotal += effectivePrice(line) * (Number(line.qty) || 0);
  }
  subtotal = round2(subtotal);
  const hst = round2(subtotal * HST_RATE);
  const total = round2(subtotal + hst);
  return { subtotal, hst, total };
}

// Per-zone collapse for leak + valve issues. The whole_manifold_rule
// says: the ENTIRE manifold gets rebuilt + every valve in the box gets
// replaced. We don't know how many valves are physically in the box
// from the issue data alone, but we have the issue qty (count of failing
// valves the tech logged). For pricing purposes we use the failing count
// as the box size — tech can edit qty on-site if more valves exist than
// they initially logged. Manifold tier picks 3-valve ($135) for ≤3
// failing/expected, else 6-valve ($285).
function manifoldLineFor(pricing, zoneNumber, valveQty, sourceIssueIds, notes) {
  const tierKey = valveQty <= 3 ? "manifold_3valve" : "manifold_6valve";
  return [
    buildLine({
      key: tierKey,
      label: labelOf(pricing, tierKey),
      qty: 1,
      price: priceOf(pricing, tierKey),
      source: { zoneNumbers: [zoneNumber], issueIds: sourceIssueIds.slice() },
      note: notes
    }),
    buildLine({
      key: "valve_hunter_pgv",
      label: labelOf(pricing, "valve_hunter_pgv"),
      qty: valveQty,
      price: priceOf(pricing, "valve_hunter_pgv"),
      source: { zoneNumbers: [zoneNumber], issueIds: sourceIssueIds.slice() }
    })
  ];
}

// Subtype label dictionary — mirrors ZONE_ISSUE_SUBTYPE_OPTIONS in
// work-order-tech.js. Server-side use only (this module has no UI),
// but the rollup needs the labels so the line item carries the
// specific item the tech chose ("Hunter PGP (4\")") rather than the
// generic catalog label ("Sprinkler head replacement").
const SUBTYPE_LABELS = {
  broken_head: {
    pgp_4:       "Hunter PGP (4\")",
    pgp_6:       "Hunter PGP (6\")",
    pgp_12:      "Hunter PGP (12\")",
    prospray_4:  "Hunter Pro-Spray (4\")",
    prospray_6:  "Hunter Pro-Spray (6\")",
    prospray_12: "Hunter Pro-Spray (12\" mulch)",
    i20:         "Hunter I-20 rotor",
    mp_rotator:  "MP Rotator",
    drip:        "Drip emitter",
    other:       "Other head"
  },
  valve: {
    pgv_full:  "Hunter PGV valve replacement + manifold rebuild",
    solenoid:  "Solenoid only",
    diaphragm: "Diaphragm rebuild",
    other:     "Other valve fix"
  },
  wire: {
    cut:      "Control wire cut",
    removed:  "Control wire removed",
    no_comms: "Control wire not communicating with controller",
    splice:   "Splice failure / waterlogged connector",
    other:    "Other wire issue"
  },
  pipe: {
    poly_1:   "1\" HDPE poly pipe break",
    poly_3_4: "3/4\" HDPE poly pipe break",
    funny:    "1/2\" funny pipe break",
    other:    "Other pipe break"
  },
  controller: {
    hpc_4:       "4-zone Hydrawise controller replaced",
    hpc_8:       "8-zone Hydrawise controller replaced",
    hpc_16:      "16-zone Hydrawise controller replaced",
    module:      "Zone-expansion module added",
    rain_sensor: "Rain sensor added",
    other:       "Other controller fix"
  }
};
function subtypeLabel(type, subtype) {
  if (!type || !subtype) return null;
  const dict = SUBTYPE_LABELS[type] || {};
  return dict[subtype] || null;
}

// Walk one zone's issues and produce 0+ line items.
function rollupZone(pricing, zone) {
  const lines = [];
  const issues = Array.isArray(zone && zone.issues) ? zone.issues : [];
  if (!issues.length) return lines;

  const zoneNumber = Number(zone.number) || 0;
  const byType = { broken_head: [], leak: [], valve: [], wire: [], pipe: [], controller: [], other: [] };
  for (const issue of issues) {
    const type = issue && byType[issue.type] ? issue.type : "other";
    if (!byType[type]) continue;
    byType[type].push(issue);
  }

  // broken_head — one line per (sub)type so the customer sees "Hunter
  // PGP (4\")" not just "Sprinkler head replacement". Pricing math
  // unchanged — head_replacement is flat per head regardless of model.
  if (byType.broken_head.length) {
    // Group by subtype within broken_head so e.g. 2× PGP-4 + 1× I-20
    // shows two distinct lines.
    const bySubtype = new Map();
    for (const i of byType.broken_head) {
      const sub = i.subtype || "_default";
      if (!bySubtype.has(sub)) bySubtype.set(sub, []);
      bySubtype.get(sub).push(i);
    }
    for (const [sub, group] of bySubtype.entries()) {
      const qty = group.reduce((s, i) => s + (Number(i.qty) || 1), 0);
      const ids = group.map((i) => i.id).filter(Boolean);
      const notes = group.map((i) => i.notes).filter(Boolean).join("; ");
      const subLabel = sub === "_default" ? null : subtypeLabel("broken_head", sub);
      lines.push(buildLine({
        key: "head_replacement",
        label: subLabel || labelOf(pricing, "head_replacement"),
        qty,
        price: priceOf(pricing, "head_replacement"),
        source: { zoneNumbers: [zoneNumber], issueIds: ids },
        note: notes
      }));
    }
  }

  // leak + valve — collapse into manifold rebuild per the whole_manifold_rule.
  const manifoldIssues = [...byType.leak, ...byType.valve];
  if (manifoldIssues.length) {
    const qty = manifoldIssues.reduce((sum, i) => sum + (Number(i.qty) || 1), 0);
    const ids = manifoldIssues.map((i) => i.id).filter(Boolean);
    const notes = manifoldIssues.map((i) => i.notes).filter(Boolean).join("; ");
    lines.push(...manifoldLineFor(pricing, zoneNumber, qty, ids, notes));
  }

  // wire — diagnostic per-zone + a starting estimate of run replacement
  // when qty>1 (tech edits down to 0 if not needed).
  if (byType.wire.length) {
    const qty = byType.wire.reduce((sum, i) => sum + (Number(i.qty) || 1), 0);
    const ids = byType.wire.map((i) => i.id).filter(Boolean);
    const notes = byType.wire.map((i) => i.notes).filter(Boolean).join("; ");
    lines.push(buildLine({
      key: "wire_diagnostic",
      label: labelOf(pricing, "wire_diagnostic"),
      qty: 1,
      price: priceOf(pricing, "wire_diagnostic"),
      source: { zoneNumbers: [zoneNumber], issueIds: ids },
      note: notes
    }));
    if (qty > 1) {
      lines.push(buildLine({
        key: "wire_run_100ft",
        label: labelOf(pricing, "wire_run_100ft"),
        qty: qty - 1,
        price: priceOf(pricing, "wire_run_100ft"),
        source: { zoneNumbers: [zoneNumber], issueIds: ids },
        note: "starting estimate — tech to confirm run length"
      }));
    }
  }

  // pipe — flat rate per 3-ft repair, qty = sum.
  if (byType.pipe.length) {
    const qty = byType.pipe.reduce((sum, i) => sum + (Number(i.qty) || 1), 0);
    const ids = byType.pipe.map((i) => i.id).filter(Boolean);
    const notes = byType.pipe.map((i) => i.notes).filter(Boolean).join("; ");
    lines.push(buildLine({
      key: "pipe_break_3ft",
      label: labelOf(pricing, "pipe_break_3ft"),
      qty,
      price: priceOf(pricing, "pipe_break_3ft"),
      source: { zoneNumbers: [zoneNumber], issueIds: ids },
      note: notes
    }));
  }

  // controller — map subtype to the specific pricing tier.
  // hpc_4 → controller_1_4, hpc_8 → controller_5_7 (closest match in
  // pricing.json — 5-7 zones is the $750 tier; for 8-zone the customer
  // ends up in the same bracket since 8 still falls in 5-7 OR moves to
  // 8-16 depending on Patrick's tier definition. Going with controller_8_16
  // for hpc_8 to be safe — that's $1,195, but Patrick can override.
  for (const issue of byType.controller) {
    const sub = issue.subtype;
    let key = null;
    if (sub === "hpc_4")        key = "controller_1_4";
    else if (sub === "hpc_8")   key = "controller_8_16";   // 8-zone falls in the 8-16 bracket
    else if (sub === "hpc_16")  key = "controller_8_16";
    else if (sub === "module")  key = null;                // no catalog entry yet — custom
    else                        key = null;
    const subLbl = subtypeLabel("controller", sub) || "Controller fix";
    if (key && pricing.items?.[key]) {
      lines.push(buildLine({
        key,
        label: subLbl,
        qty: Number(issue.qty) || 1,
        price: priceOf(pricing, key),
        source: { zoneNumbers: [zoneNumber], issueIds: issue.id ? [issue.id] : [] },
        note: issue.notes || ""
      }));
    } else {
      // No matching catalog entry — emit as custom line at $0 so tech
      // sets the price on-site.
      lines.push(buildLine({
        key: null,
        label: subLbl,
        qty: Number(issue.qty) || 1,
        price: 0,
        custom: true,
        source: { zoneNumbers: [zoneNumber], issueIds: issue.id ? [issue.id] : [] },
        note: issue.notes || "Controller — tech to confirm pricing on-site"
      }));
    }
  }

  // other — one custom $0 line per issue. Tech sets the price on-site.
  for (const issue of byType.other) {
    lines.push(buildLine({
      key: null,
      label: issue.notes ? `Custom: ${issue.notes}`.slice(0, 200) : "Custom line",
      qty: Number(issue.qty) || 1,
      price: 0,
      custom: true,
      source: { zoneNumbers: [zoneNumber], issueIds: issue.id ? [issue.id] : [] },
      note: issue.notes || ""
    }));
  }

  return lines;
}

// Top-level rollup: walks every zone, prepends a single service_call,
// returns lineItems + totals. Service call line behaviour:
//   - WO with intakeGuarantee.applies (from an AI repair quote) →
//     service_call prepended at $0 with note "trip already paid on
//     AI-quoted visit" so the customer doesn't pay a second mobilization
//     fee for finds discovered during the same visit. (pricing.json hard
//     rule ai_intake_correct_diagnosis_bonus — bonus 1-hr free credit
//     applies only to the diagnosed scope, not to extra finds.)
//   - spring_opening / fall_closing WO → NO service_call prepended.
//     The seasonal fee on the WO baseline (seeded at WO create time)
//     already covers the trip. Adding a $95 service_call on top would
//     double-bill the customer for the visit. (pricing.json hard rule
//     spring_fall_no_service_call.)
//   - Otherwise (service_visit without AI-quoted bonus eligibility) →
//     full $95 service_call (the customer pays for the trip out).
function rollupIssuesToLineItems(wo, pricing) {
  const zoneLines = [];
  const zones = Array.isArray(wo && wo.zones) ? wo.zones : [];
  for (const zone of zones) {
    zoneLines.push(...rollupZone(pricing, zone));
  }

  const lines = [];
  if (zoneLines.length) {
    const intakeActive = !!(wo && wo.intakeGuarantee && wo.intakeGuarantee.applies);
    const isSeasonal = !!(wo && (wo.type === "spring_opening" || wo.type === "fall_closing"));
    const allZoneNums = Array.from(new Set(zoneLines.flatMap((l) => l.source.zoneNumbers)));
    if (intakeActive) {
      lines.push(buildLine({
        key: "service_call",
        label: labelOf(pricing, "service_call"),
        qty: 1,
        price: 0,
        source: { zoneNumbers: allZoneNums, issueIds: [] },
        note: "Trip already paid on the AI-quoted visit — no second mobilization fee for finds during the same visit"
      }));
    } else if (!isSeasonal) {
      // Service visit (or other repair-only WO) — full service call.
      lines.push(buildLine({
        key: "service_call",
        label: labelOf(pricing, "service_call"),
        qty: 1,
        price: priceOf(pricing, "service_call"),
        source: { zoneNumbers: allZoneNums, issueIds: [] }
      }));
    }
    // Seasonal WOs intentionally fall through with no service_call —
    // the seasonal fee seeded at WO create covers the trip.
  }
  lines.push(...zoneLines);

  const totals = totalsFor(lines);
  return { lineItems: lines, ...totals };
}

// Re-totalling helper — used after the tech edits the builder lines, or
// after the customer-accept filter trims the array.
function recomputeTotals(lines) {
  return totalsFor(lines || []);
}

// Single-issue rollup — used by the deferred-issues flow (spec §5) to
// snapshot a price for ONE issue at defer time. Implemented as a thin
// wrapper around `rollupIssuesToLineItems` so we never duplicate the
// whole_manifold_rule, buildLine, or service_call logic. The synthetic
// WO has no intakeGuarantee (deferred items are NOT covered under an
// AI repair quote — that's a different code path).
//
// `includeServiceCall` defaults to false: deferred items are priced
// per-line so the customer/tech can compare them at face value; the
// service_call gets added once on the spring WO when the items are
// pulled into the on-site Quote builder via "Repair now" (the existing
// rollup adds it at that point).
//
// Returns { lineItems, subtotal, hst, total, pricedAt }.
function rollupSingleIssueToLineItems(issue, zoneNumber, pricing, opts = {}) {
  const includeServiceCall = opts.includeServiceCall === true;
  const syntheticWo = {
    intakeGuarantee: { applies: false },
    zones: [{
      number: Number(zoneNumber) || 0,
      issues: issue ? [issue] : []
    }]
  };
  const result = rollupIssuesToLineItems(syntheticWo, pricing);
  let lines = result.lineItems;
  if (!includeServiceCall) {
    lines = lines.filter((l) => l.key !== "service_call");
  }
  const totals = totalsFor(lines);
  return {
    lineItems: lines,
    ...totals,
    pricedAt: new Date().toISOString()
  };
}

module.exports = {
  HST_RATE,
  rollupIssuesToLineItems,
  rollupSingleIssueToLineItems,
  recomputeTotals,
  effectivePrice,
  totalsFor
};
