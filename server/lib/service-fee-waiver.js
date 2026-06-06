// Service-call fee waiver — shared constants + pure helpers.
//
// Patrick (2026-06-06): "When I create a work order for a service call is
// there any way I can bypass charging the service call fee?" — yes, via an
// explicit, auditable waiver captured at WO creation. This module is the
// single source of truth for the reason vocabulary, validation, and the
// customer-facing friendly label so the persistence layer
// (lib/work-orders.js), the pricing rollup (lib/issue-rollup.js), and the
// admin/tech UIs never drift on what a valid waiver looks like.
//
// Scope note: the waiver only takes effect where a service_call ($95
// mobilization) fee is actually charged — i.e. service_visit WOs. Spring
// opening / fall closing are flat-rate, all-in services that never carry a
// separate service_call on top (pricing.json spring_fall_no_service_call),
// so a waiver on a seasonal WO is a harmless no-op. The UI only offers it
// on Service Visit WOs.
//
// Persisted shape on wo.serviceFeeWaiver (null when not waived):
//   { waived: true, reason, notes, waivedBy, waivedAt }

// Valid reason keys. "other" requires a write-in note.
const WAIVER_REASONS = ["warranty", "contract", "courtesy", "other"];

// Customer-facing friendly label per reason. Deliberately NOT the raw key —
// the customer PDF shows "Service call fee — WAIVED (Warranty visit)", never
// "Reason: warranty".
const WAIVER_REASON_LABELS = {
  warranty: "Warranty visit",
  contract: "Contract member",
  courtesy: "Courtesy",
  other: "No charge"
};

// Validate + normalize a raw waiver payload from the client. Returns
//   { waiver: object|null, error: string|null }
// - waiver=null, error=null  → nothing to waive (off, the default)
// - waiver=null, error="..." → invalid; caller should 422 with the message
// - waiver={...}, error=null → valid, ready to persist
//
// `by`  — current user (e.g. "admin" / "patrick") stamped as waivedBy
// `at`  — ISO timestamp override (server passes Date.now()-based ISO;
//          keeps the function itself free of ambient time for testability)
function normalizeServiceFeeWaiver(input, { by = "admin", at = null } = {}) {
  if (!input || typeof input !== "object" || input.waived !== true) {
    return { waiver: null, error: null };
  }
  const reason = String(input.reason || "").trim().toLowerCase();
  if (!WAIVER_REASONS.includes(reason)) {
    return { waiver: null, error: "Select a waiver reason (warranty, contract, courtesy, or other)." };
  }
  const notes = String(input.notes || "").trim().slice(0, 300);
  if (reason === "other" && !notes) {
    return { waiver: null, error: "Add a note explaining the waiver when the reason is 'Other'." };
  }
  return {
    waiver: {
      waived: true,
      reason,
      notes,
      waivedBy: String(by || "admin"),
      waivedAt: at || new Date().toISOString()
    },
    error: null
  };
}

// Customer-facing reason phrase for a stored waiver. For "other" the
// write-in note IS the reason, so we surface it; everything else uses the
// canonical friendly label.
function friendlyWaiverReason(waiver) {
  if (!waiver || waiver.waived !== true) return "";
  if (waiver.reason === "other") {
    return waiver.notes ? waiver.notes : "No charge";
  }
  return WAIVER_REASON_LABELS[waiver.reason] || "No charge";
}

module.exports = {
  WAIVER_REASONS,
  WAIVER_REASON_LABELS,
  normalizeServiceFeeWaiver,
  friendlyWaiverReason
};
