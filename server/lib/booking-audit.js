// Booking reconciliation audit — READ-ONLY (P-PJL-39, PJL-137, TRD §11).
//
// One real appointment = one canonical Booking. This module reads every
// store that can say "there is an appointment" and reports where they
// disagree, as categories with counts and ids. It never writes: the CLI
// (scripts/audit-bookings.mjs) reads a data directory and prints; the admin
// route (GET /api/admin/booking-audit) runs it over the live stores and
// answers JSON. Repair is a separate, later mode (TRD §11 "Repair mode") —
// dry-run by default, backup first, never built here.
//
// Pure: takes arrays, returns a report. Deterministic: ids sorted, no
// clock reads except `now`, so two runs over the same data match exactly
// (scripts/test-ubst-audit-fixtures.mjs pins that).
//
// Severity. CRITICAL = two readers can answer differently about whether an
// appointment exists today; ADVISORY = history that is wrong but no reader
// is misled yet, or data hygiene. The exit code follows CRITICAL.

const bookingsLib = require("./bookings");

const WO_TERMINAL = new Set(["completed", "cancelled", "no_show"]);
const TEST_EMAIL = /@example\.com$|^pjltest/i;
const TEST_NAME = /^\s*pjl\s*-?\s*test/i;
const TEST_MARK = /PJLTEST-/i;

const CATEGORIES = Object.freeze({
  duplicate_active:          { severity: "critical", title: "Two or more live Bookings for one property on one day" },
  merged_visits:             { severity: "critical", title: "One Booking holding work orders from different visits" },
  stale_confirmed:           { severity: "advisory", title: "A live Booking whose day is already past" },
  terminal_wo_on_live:       { severity: "critical", title: "A live Booking whose own work order is already finished" },
  plan_stop_no_booking:      { severity: "advisory", title: "A planned stop with no live Booking on its day" },
  plan_stop_deleted_booking: { severity: "critical", title: "A planned stop whose customer was messaged but has no Booking (the record was deleted)" },
  wo_missing_booking_link:   { severity: "advisory", title: "A dated work order with no bookingId where its Booking can be inferred" },
  wo_without_booking:        { severity: "advisory", title: "A dated, open work order with no Booking anywhere" },
  dangling_wo_id:            { severity: "advisory", title: "A Booking naming a work order id that does not exist" },
  id_collision:              { severity: "critical", title: "Two records sharing one id" },
  envelope_disagrees:        { severity: "critical", title: "A lead's booking envelope disagreeing with its canonical record" },
  lead_without_record:       { severity: "advisory", title: "A lead with a dated envelope and no canonical record at all" },
  patch_flip:                { severity: "advisory", title: "A terminal Booking with no cancelledAt (status set by a plain field edit)" },
  test_record:               { severity: "advisory", title: "A test record in the store" }
});

function localDayKey(iso) {
  const d = new Date(iso || "");
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function seasonOf(serviceKey) {
  const k = String(serviceKey || "");
  if (k.startsWith("spring_open")) return "spring";
  if (k.startsWith("fall_close")) return "fall";
  return null;
}

function uniqSorted(arr) {
  return [...new Set(arr.filter(Boolean).map(String))].sort();
}

// `stores`: { bookings, leads, workOrders, properties, seasonPlans }, each
// as read from disk (seasonPlans is the keyed object: { "fall-2026": {...} }).
// `now`: the clock to judge "past" by (a Date or ISO string).
function runAudit(stores = {}, { now = new Date() } = {}) {
  const bookings = (Array.isArray(stores.bookings) ? stores.bookings : []).filter(Boolean);
  const leads = (Array.isArray(stores.leads) ? stores.leads : []).filter(Boolean);
  const workOrders = (Array.isArray(stores.workOrders) ? stores.workOrders : []).filter(Boolean);
  const properties = (Array.isArray(stores.properties) ? stores.properties : []).filter(Boolean);
  const plans = stores.seasonPlans && typeof stores.seasonPlans === "object" ? stores.seasonPlans : {};
  const todayKey = localDayKey(new Date(now).toISOString());

  const live = (b) => bookingsLib.holdsItsSlot(b.status);
  const woById = new Map();
  const woIdCounts = new Map();
  for (const w of workOrders) {
    if (!w.id) continue;
    woIdCounts.set(w.id, (woIdCounts.get(w.id) || 0) + 1);
    if (!woById.has(w.id)) woById.set(w.id, w);
  }
  const propById = new Map(properties.filter((p) => p.id).map((p) => [p.id, p]));
  const propByCode = new Map(properties.filter((p) => p.code).map((p) => [p.code, p]));
  const leadById = new Map(leads.filter((l) => l.id).map((l) => [l.id, l]));
  const bookingsByLead = new Map();
  for (const b of bookings) {
    if (!b.leadId) continue;
    if (!bookingsByLead.has(b.leadId)) bookingsByLead.set(b.leadId, []);
    bookingsByLead.get(b.leadId).push(b);
  }
  // Bookings per property, by every link the records carry (the Season
  // Plan board's rule, bookings.belongsToProperty).
  const bookingsForProperty = (property) => bookings.filter((b) => bookingsLib.belongsToProperty(b, property));

  const found = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, new Map()]));   // id -> detail
  const add = (cat, id, detail = {}) => { if (id && !found[cat].has(String(id))) found[cat].set(String(id), detail); };

  // ---- Bookings ---------------------------------------------------------
  const bookingIdCounts = new Map();
  for (const b of bookings) {
    if (b.id) bookingIdCounts.set(b.id, (bookingIdCounts.get(b.id) || 0) + 1);
  }
  for (const [id, n] of bookingIdCounts) if (n > 1) add("id_collision", id, { store: "bookings", count: n });
  for (const [id, n] of woIdCounts) if (n > 1) add("id_collision", id, { store: "work-orders", count: n });

  // duplicate_active: same property (or same lead), same local day, both live
  const liveByPropDay = new Map();
  for (const b of bookings) {
    if (!live(b) || !b.scheduledFor) continue;
    const day = localDayKey(b.scheduledFor);
    const keys = [];
    if (b.propertyId) keys.push(`p:${b.propertyId}|${day}`);
    if (b.leadId) keys.push(`l:${b.leadId}|${day}`);
    for (const k of keys) {
      if (!liveByPropDay.has(k)) liveByPropDay.set(k, []);
      liveByPropDay.get(k).push(b);
    }
  }
  for (const [key, list] of liveByPropDay) {
    const ids = uniqSorted(list.map((b) => b.id));
    if (ids.length > 1) for (const id of ids) add("duplicate_active", id, { key, with: ids.filter((x) => x !== id) });
  }

  for (const b of bookings) {
    const linkedIds = Array.isArray(b.workOrderIds) ? b.workOrderIds : [];
    const linked = linkedIds.map((id) => woById.get(id)).filter(Boolean);
    const missing = linkedIds.filter((id) => !woById.has(id));
    if (missing.length) add("dangling_wo_id", b.id, { missing });

    // merged_visits: a linked WO that is a PREVIOUS visit's by the PJL-97 rule
    const previous = linked.filter((w) => bookingsLib.isPreviousVisitWo(w, b.scheduledFor));
    if (previous.length && linked.length > previous.length) {
      add("merged_visits", b.id, { previousVisit: uniqSorted(previous.map((w) => w.id)), thisVisit: uniqSorted(linked.filter((w) => !previous.includes(w)).map((w) => w.id)) });
    } else if (previous.length && linkedIds.length > linked.length) {
      // a previous visit's WO plus an id we can't see: still two visits on one record
      add("merged_visits", b.id, { previousVisit: uniqSorted(previous.map((w) => w.id)), thisVisit: missing });
    }

    if (live(b)) {
      const day = localDayKey(b.scheduledFor);
      if (day && todayKey && day < todayKey) add("stale_confirmed", b.id, { day, status: b.status });
      const thisVisit = bookingsLib.workOrdersForVisit(b, linked);
      const finished = thisVisit.filter((w) => WO_TERMINAL.has(w.status));
      if (finished.length) add("terminal_wo_on_live", b.id, { workOrders: uniqSorted(finished.map((w) => `${w.id}:${w.status}`)) });
    } else {
      const flipped = !b.cancelledAt && !b.completedAt;
      const byPatch = (b.history || []).some((h) => /^status:(cancelled|no_show|completed)$/.test(String(h.action || "")));
      if (flipped || byPatch) add("patch_flip", b.id, { status: b.status, cancelledAt: b.cancelledAt || null, byPatch });
    }

    // test records: the booking's own fields or its property's
    const prop = b.propertyId ? propById.get(b.propertyId) : null;
    const emails = [b.customerEmail, prop?.customerEmail].filter(Boolean);
    const names = [b.customerName, prop?.customerName].filter(Boolean);
    const marks = [b.prepNotes, b.address, prop?.address].filter(Boolean);
    if (emails.some((e) => TEST_EMAIL.test(String(e))) || names.some((n) => TEST_NAME.test(String(n))) || marks.some((m) => TEST_MARK.test(String(m)))) {
      add("test_record", b.id, { email: emails[0] || null, name: names[0] || null });
    }
  }

  // ---- Leads: the envelope vs the record --------------------------------
  for (const lead of leads) {
    if (lead.archived || lead.deletedAt) continue;
    const env = lead.booking;
    if (!env || !env.start) continue;
    const recs = bookingsByLead.get(lead.id) || [];
    if (!recs.length) { add("lead_without_record", lead.id, { start: env.start }); continue; }
    const envLive = bookingsLib.holdsItsSlot(env.status);
    const current = bookingsLib.currentRecordForLead(recs, lead) || null;
    const anyLive = recs.some(live);
    if (envLive && !anyLive) add("envelope_disagrees", lead.id, { envelope: env.status || "live", records: uniqSorted(recs.map((r) => `${r.id}:${r.status}`)) });
    else if (!envLive && current && live(current)) add("envelope_disagrees", lead.id, { envelope: env.status, record: `${current.id}:${current.status}` });
  }

  // ---- Work orders: the link ---------------------------------------------
  const namedBy = new Map();   // woId -> booking ids that name it
  for (const b of bookings) for (const id of (b.workOrderIds || [])) {
    if (!namedBy.has(id)) namedBy.set(id, []);
    namedBy.get(id).push(b.id);
  }
  for (const w of workOrders) {
    if (!w.id || w.deletedAt || WO_TERMINAL.has(w.status) || !w.scheduledFor) continue;
    if (w.bookingId) continue;
    const names = namedBy.get(w.id) || [];
    const day = localDayKey(w.scheduledFor);
    const sameDay = (w.propertyId ? bookings.filter((b) => live(b) && b.propertyId === w.propertyId && localDayKey(b.scheduledFor) === day) : [])
      .concat(w.leadId ? bookings.filter((b) => live(b) && b.leadId === w.leadId && localDayKey(b.scheduledFor) === day) : []);
    const inferred = uniqSorted([...names, ...sameDay.map((b) => b.id)]);
    if (inferred.length) add("wo_missing_booking_link", w.id, { inferred });
    else add("wo_without_booking", w.id, { propertyId: w.propertyId || null, leadId: w.leadId || null, day });
  }

  // ---- Season plans: every stop needs a Booking --------------------------
  for (const [key, plan] of Object.entries(plans)) {
    const m = /^(spring|fall)-(\d{4})$/.exec(key);
    if (!m || !plan || !plan.days) continue;
    const [, season, year] = m;
    const seasonKey = `${year}:${season}`;
    for (const [date, day] of Object.entries(plan.days)) {
      for (const bucket of ["morning", "afternoon"]) {
        for (const code of day?.[bucket] || []) {
          const property = propByCode.get(code);
          if (!property) { add("plan_stop_no_booking", code, { date, bucket, reason: "no such property" }); continue; }
          const mine = bookingsForProperty(property);
          const onDay = mine.find((b) => live(b) && localDayKey(b.scheduledFor) === date);
          if (onDay) continue;
          const doneOnDay = mine.find((b) => !live(b) && b.status === "completed" && localDayKey(b.scheduledFor) === date);
          if (doneOnDay) continue;
          const dead = mine.filter((b) => !live(b) && seasonOf(b.serviceKey) === season && localDayKey(b.scheduledFor)?.startsWith(String(year)));
          const movedLive = mine.find((b) => live(b) && b.source === "assignment" && b.assignment?.season === season && Number(b.assignment?.year) === Number(year));
          if (movedLive) continue;   // the plan's own state says "moved"
          if (dead.length) continue; // a recorded no — the board drops it
          const skipped = property.seasonalOutreach?.[seasonKey]?.optOutThisSeason === true;
          if (skipped) continue;     // #398's recorded no
          add("plan_stop_no_booking", code, { date, bucket, propertyId: property.id });
          const touches = property.seasonalOutreach?.[seasonKey]?.touches || [];
          if (touches.some((t) => t && t.type === "assignment")) {
            add("plan_stop_deleted_booking", code, { date, bucket, propertyId: property.id, messagedAt: touches.find((t) => t.type === "assignment")?.ts || null });
          }
        }
      }
    }
  }

  // ---- Report ------------------------------------------------------------
  const categories = {};
  let critical = 0, advisory = 0;
  for (const [name, def] of Object.entries(CATEGORIES)) {
    const ids = uniqSorted([...found[name].keys()]);
    const details = Object.fromEntries(ids.map((id) => [id, found[name].get(id)]));
    categories[name] = { severity: def.severity, title: def.title, count: ids.length, ids, details };
    if (def.severity === "critical") critical += ids.length; else advisory += ids.length;
  }
  return {
    generatedAt: new Date(now).toISOString(),
    today: todayKey,
    totals: { bookings: bookings.length, leads: leads.length, workOrders: workOrders.length, properties: properties.length, seasonPlans: Object.keys(plans).length },
    critical,
    advisory,
    categories
  };
}

function formatReport(report) {
  const lines = [];
  lines.push(`Booking reconciliation audit — ${report.today} (read-only)`);
  lines.push(`records: ${report.totals.bookings} bookings, ${report.totals.leads} leads, ${report.totals.workOrders} work orders, ${report.totals.properties} properties, ${report.totals.seasonPlans} season plan(s)`);
  lines.push(`conflicts: ${report.critical} critical, ${report.advisory} advisory`);
  lines.push("");
  for (const [name, c] of Object.entries(report.categories)) {
    lines.push(`${c.severity === "critical" ? "!!" : "  "} ${String(c.count).padStart(4)}  ${name} — ${c.title}`);
    for (const id of c.ids.slice(0, 50)) {
      const d = c.details[id] || {};
      const extra = Object.entries(d).filter(([k]) => k !== "key").map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : JSON.stringify(v)}`).join("  ");
      lines.push(`         ${id}${extra ? `   ${extra}` : ""}`);
    }
    if (c.ids.length > 50) lines.push(`         … and ${c.ids.length - 50} more`);
  }
  return lines.join("\n");
}

module.exports = { runAudit, formatReport, CATEGORIES, localDayKey };
