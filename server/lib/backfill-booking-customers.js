// Shared backfill logic — used by BOTH:
//   - scripts/backfill-booking-customers.js (CLI, --apply flag)
//   - POST /api/admin/backfill-customers   (admin endpoint, body { apply })
//
// The two flows must stay in sync. Lifting the candidate-finding and
// resolution out of the CLI means the endpoint and script can't drift.
//
// Design:
// - This lib is PURE on inputs: it takes an array of leads and operates
//   on it. It does NOT read or write leads.json directly — the caller
//   owns the I/O. That keeps the lib testable and keeps the CLI's
//   atomic-write semantics intact.
// - apply mode MUTATES the input array (stamps customerId on each
//   resolved lead). The caller writes the result back. The lib returns
//   structured create/match/fail records for logging or UI display.
// - dry-run mode is read-only: returns the list of candidates without
//   touching customers.json either.
// - A cap (default 200) guards against runaway operation if data is
//   unexpected — the endpoint surfaces a `truncated: true` flag and the
//   operator can re-run.

const customers = require("./customers");

const DEFAULT_CAP = 200;

// A lead is a backfill candidate if:
//   - it has a booking envelope (lead.booking.start set) — distinguishes
//     a self-booker from a manually-entered or quoted lead
//   - it has NO customerId yet (the bug this fixes)
function isCandidate(lead) {
  if (!lead || typeof lead !== "object") return false;
  if (lead.customerId) return false;
  if (!lead.booking || !lead.booking.start) return false;
  return true;
}

// Shape a candidate for UI / CLI display. Doesn't expose anything
// that's not already on the lead record.
function candidateSummary(lead) {
  const c = lead.contact || {};
  return {
    leadId: lead.id,
    name: c.name || "",
    email: c.email || "",
    phone: c.phone || "",
    bookedAt: lead.booking?.start || lead.createdAt || null,
    address: c.address || ""
  };
}

// Same resolution logic as server.js:973 resolveCustomerForLead, but
// returns a structured result so the caller can distinguish created
// vs matched outcomes for reporting.
async function resolveOne(lead) {
  const contact = lead.contact || {};
  const email = contact.email || "";
  const phone = contact.phone || "";
  let match = null;
  if (email) match = await customers.findByEmail(email);
  if (!match && phone) match = await customers.findByPhone(phone);
  let customerId = match?.id || null;
  let action = match ? "matched" : null;
  if (!customerId) {
    try {
      const created = await customers.create({
        name: contact.name || "",
        email,
        phone,
        source: lead.source || "lead",
        customerSince: lead.createdAt,
        status: "lead"
      }, { by: "backfill-booking-customers", note: `Auto-created from lead ${lead.id} during backfill` });
      customerId = created.id;
      action = "created";
    } catch (err) {
      if (err.code === "DUPLICATE_EMAIL") {
        customerId = err.existingId;
        action = "matched-race";
      } else {
        throw err;
      }
    }
  }
  if (customerId) {
    try {
      await customers.addCommunication(customerId, {
        ts: lead.createdAt,
        source: lead.source || "lead",
        summary: `Backfilled — original ${lead.source || "lead"} intake`,
        notes: contact.notes || "",
        logId: lead.id
      });
    } catch (err) {
      // Best-effort — a failed communication log doesn't invalidate
      // the customerId itself.
    }
  }
  return { customerId, action };
}

// findCandidates — read-only. Returns the list of summary objects for
// every lead that needs backfill. Caller is responsible for loading
// leads from disk.
function findCandidates(leads, { cap = DEFAULT_CAP } = {}) {
  if (!Array.isArray(leads)) return { candidates: [], total: 0, truncated: false };
  const matched = leads.filter(isCandidate);
  const truncated = matched.length > cap;
  const working = matched.slice(0, cap);
  return {
    candidates: working.map(candidateSummary),
    total: matched.length,
    truncated
  };
}

// runBackfill — applies the resolution to every candidate (up to `cap`).
// MUTATES the input `leads` array: each resolved lead gets `customerId`
// stamped on it. Caller is responsible for writing leads.json back.
//
// Returns:
//   {
//     ok: true,
//     applied: true,
//     created: [{ leadId, customerId, name }, …],
//     matched: [{ leadId, customerId, name }, …],
//     failed:  [{ leadId, error }, …],
//     total: number,        // total candidates found (pre-cap)
//     processed: number,    // number actually run (≤ cap)
//     truncated: boolean    // total > cap
//   }
async function runBackfill({ leads, apply = false, cap = DEFAULT_CAP } = {}) {
  if (!Array.isArray(leads)) {
    return { ok: false, error: "leads must be an array" };
  }
  const matchedLeads = leads.filter(isCandidate);
  const truncated = matchedLeads.length > cap;
  const working = matchedLeads.slice(0, cap);

  if (!apply) {
    return {
      ok: true,
      dryRun: true,
      candidates: working.map(candidateSummary),
      total: matchedLeads.length,
      processed: working.length,
      truncated
    };
  }

  const created = [];
  const matched = [];
  const failed = [];
  for (const lead of working) {
    try {
      const result = await resolveOne(lead);
      if (!result.customerId) {
        failed.push({ leadId: lead.id, error: "no customerId returned" });
        continue;
      }
      lead.customerId = result.customerId;
      const summary = {
        leadId: lead.id,
        customerId: result.customerId,
        name: lead.contact?.name || "",
        email: lead.contact?.email || "",
        phone: lead.contact?.phone || ""
      };
      if (result.action === "created") {
        created.push(summary);
      } else {
        matched.push(summary);
      }
    } catch (err) {
      failed.push({ leadId: lead.id, error: err?.message || String(err) });
    }
  }

  return {
    ok: true,
    applied: true,
    created,
    matched,
    failed,
    total: matchedLeads.length,
    processed: working.length,
    truncated
  };
}

module.exports = {
  isCandidate,
  candidateSummary,
  findCandidates,
  runBackfill,
  DEFAULT_CAP
};
