// server/lib/purge-test-data.js
//
// The one definition of "this is a load-test record, and here is what it is
// safe to remove." Patrick's booking bot made 123 appointments to pilot the
// system; each one left a lead, a booking, a customer and a property behind,
// and some grew work orders and invoices on top.
//
// TWO callers, ONE rule: POST /api/admin/purge-test-data (server.js) and
// scripts/purge-test-data.mjs running straight against the data directory on
// the Render shell. The script used to reach the endpoint over HTTP, which
// made a cleanup depend on a login round-trip through a proxy — that is how
// it first failed in Patrick's hands. Neither caller carries a copy of this
// logic. Two copies would drift, and the copy that drifts deletes a real
// customer.
//
// THE GUARD THAT MATTERS: a customer or property is removed ONLY when every
// lead naming it is itself in the purge. The bot booked addresses that
// matched people who already existed — those bookings go and the people
// stay. A record anchored to no marked lead is left standing; nothing marks
// it as the bot's, and guessing is how a real appointment disappears.
//
// Covered by scripts/test-purge-test-data.mjs.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

// Everything a booking can spawn, in the order a person would name them.
const SWEPT_STORES = ["bookings", "work-orders", "invoices", "quotes", "projects"];

// "P" would match every record in the database. Four characters is the
// shortest marker that can plausibly be deliberate.
const MIN_MARKER_LENGTH = 4;
const DEFAULT_MARKER = "PJLTEST-";

class PurgeRefused extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function readStore(dataDir, name) {
  const file = path.join(dataDir, `${name}.json`);
  if (!fsSync.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fsSync.readFileSync(file, "utf8") || "[]");
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    // A store we cannot parse is a store we must not rewrite.
    console.warn(`[purge-test-data] couldn't read ${name}:`, err?.message);
    return null;
  }
}

async function writeStore(dataDir, name, rows) {
  await fs.writeFile(path.join(dataDir, `${name}.json`), JSON.stringify(rows, null, 2) + "\n", "utf8");
}

// What the marker matches: the bot writes it into the lead's notes, and it
// shows up in the name fields of records made by hand from those leads.
function leadIsMarked(lead, marker) {
  if (!lead) return false;
  const hit = (v) => typeof v === "string" && v.includes(marker);
  return hit(lead.contact?.notes) || hit(lead.contact?.firstName)
    || hit(lead.contact?.lastName) || hit(lead.notes);
}

// Read-only. Returns what a purge WOULD take, so the same answer can be
// shown as a dry run and then used to carry it out.
function planPurge({ dataDir, marker = DEFAULT_MARKER, leads = null }) {
  const mark = String(marker || "").trim();
  if (mark.length < MIN_MARKER_LENGTH) {
    throw new PurgeRefused(
      `Marker is too short to be safe — use at least ${MIN_MARKER_LENGTH} characters.`,
      "marker_too_short"
    );
  }

  const allLeads = leads || readStore(dataDir, "leads") || [];
  const marked = allLeads.filter((l) => leadIsMarked(l, mark));
  const leadIds = new Set(marked.map((l) => l.id).filter(Boolean));
  const customerIds = new Set(marked.map((l) => l.customerId).filter(Boolean));
  const propertyIds = new Set(marked.map((l) => l.propertyId).filter(Boolean));

  // The survival guard. Run BEFORE anything is matched against these sets,
  // so a customer kept here also keeps their invoices and work orders.
  for (const lead of allLeads) {
    if (leadIds.has(lead?.id)) continue;
    if (lead?.customerId) customerIds.delete(lead.customerId);
    if (lead?.propertyId) propertyIds.delete(lead.propertyId);
  }

  const linked = (row) => Boolean(row && (
    (row.leadId && leadIds.has(row.leadId))
    || (row.customerId && customerIds.has(row.customerId))
    || (row.propertyId && propertyIds.has(row.propertyId))
  ));

  const plan = { marker: mark, leadIds, customerIds, propertyIds, linked, stores: {} };
  for (const store of SWEPT_STORES) {
    const rows = readStore(dataDir, store);
    if (!rows) continue;
    const going = rows.filter(linked);
    if (going.length) plan.stores[store] = { rows, going };
  }

  plan.counts = { leads: marked.length };
  for (const [store, { going }] of Object.entries(plan.stores)) plan.counts[store] = going.length;
  if (customerIds.size) plan.counts.customers = customerIds.size;
  if (propertyIds.size) plan.counts.properties = propertyIds.size;

  plan.sample = marked.slice(0, 5).map((l) => ({
    id: l.id,
    name: [l.contact?.firstName, l.contact?.lastName].filter(Boolean).join(" "),
    address: l.contact?.address || "",
    when: l.booking?.start || null
  }));
  plan.allLeads = allLeads;
  plan.marked = marked;
  return plan;
}

// Carries out a plan. `writeLeads` is passed in because the leads store has
// its own writer in server.js (indexes, backups) that a raw file write
// would skip; the CLI hands in a plain writer.
async function applyPurge({ dataDir, plan, writeLeads }) {
  for (const [store, { rows }] of Object.entries(plan.stores)) {
    await writeStore(dataDir, store, rows.filter((r) => !plan.linked(r)));
  }
  for (const [store, ids] of [["customers", plan.customerIds], ["properties", plan.propertyIds]]) {
    if (!ids.size) continue;
    const rows = readStore(dataDir, store);
    if (!rows) continue;
    await writeStore(dataDir, store, rows.filter((r) => !(r && ids.has(r.id))));
  }
  await writeLeads(plan.allLeads.filter((l) => !plan.leadIds.has(l?.id)));
  return plan.counts;
}

module.exports = {
  DEFAULT_MARKER,
  MIN_MARKER_LENGTH,
  SWEPT_STORES,
  PurgeRefused,
  leadIsMarked,
  planPurge,
  applyPurge
};
