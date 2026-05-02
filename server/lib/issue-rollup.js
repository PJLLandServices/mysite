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
//   - ai_intake_labour_locked: when wo.intakeGuarantee.applies is true,
//     the original AI quote's service_call is locked-in. New on-site
//     scope adds a $0 service_call line tagged "on intake guarantee" so
//     the customer sees what's covered without double-billing.
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

// Walk one zone's issues and produce 0+ line items.
function rollupZone(pricing, zone) {
  const lines = [];
  const issues = Array.isArray(zone && zone.issues) ? zone.issues : [];
  if (!issues.length) return lines;

  const zoneNumber = Number(zone.number) || 0;
  const byType = { broken_head: [], leak: [], valve: [], wire: [], pipe: [], other: [] };
  for (const issue of issues) {
    const type = issue && byType[issue.type] ? issue.type : "other";
    if (!byType[type]) continue;
    byType[type].push(issue);
  }

  // broken_head — single line, qty = sum across issues in this zone.
  if (byType.broken_head.length) {
    const qty = byType.broken_head.reduce((sum, i) => sum + (Number(i.qty) || 1), 0);
    const ids = byType.broken_head.map((i) => i.id).filter(Boolean);
    const notes = byType.broken_head.map((i) => i.notes).filter(Boolean).join("; ");
    lines.push(buildLine({
      key: "head_replacement",
      label: labelOf(pricing, "head_replacement"),
      qty,
      price: priceOf(pricing, "head_replacement"),
      source: { zoneNumbers: [zoneNumber], issueIds: ids },
      note: notes
    }));
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
// returns lineItems + totals. Service call line is special:
//   - On a normal find_and_fix WO: full $95 charged (one trip out).
//   - On a WO with intakeGuarantee.applies (came from an AI repair
//     quote): service_call added at $0 with note "on AI intake guarantee"
//     so the customer can see it's covered. Hard rule from pricing.json
//     ai_intake_labour_locked.
function rollupIssuesToLineItems(wo, pricing) {
  const zoneLines = [];
  const zones = Array.isArray(wo && wo.zones) ? wo.zones : [];
  for (const zone of zones) {
    zoneLines.push(...rollupZone(pricing, zone));
  }

  const lines = [];
  // Only prepend service_call if there's anything to bill at all. An
  // empty rollup → no quote to build.
  if (zoneLines.length) {
    const intakeActive = !!(wo && wo.intakeGuarantee && wo.intakeGuarantee.applies);
    const allZoneNums = Array.from(new Set(zoneLines.flatMap((l) => l.source.zoneNumbers)));
    if (intakeActive) {
      lines.push(buildLine({
        key: "service_call",
        label: labelOf(pricing, "service_call"),
        qty: 1,
        price: 0,
        source: { zoneNumbers: allZoneNums, issueIds: [] },
        note: "On AI intake guarantee — covered by original quote"
      }));
    } else {
      lines.push(buildLine({
        key: "service_call",
        label: labelOf(pricing, "service_call"),
        qty: 1,
        price: priceOf(pricing, "service_call"),
        source: { zoneNumbers: allZoneNums, issueIds: [] }
      }));
    }
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

module.exports = {
  HST_RATE,
  rollupIssuesToLineItems,
  recomputeTotals,
  effectivePrice,
  totalsFor
};
