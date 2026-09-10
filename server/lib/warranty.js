// Warranty policy — the single authoritative source (JOB-002 Part A).
//
// Policy (recorded in docs/FLOW_REGISTER.md):
//   build (installation)  → 3 years
//   service_visit         → 1 year
//   spring_opening        → 1 year
//   fall_closing          → 1 year
//
// Hydrawise controller retrofits are SERVICE, not installation — they are
// typed service_visit and carry the 1-year service warranty. Parts replaced
// during a service call inherit the service warranty; warranty attaches to
// the work order, not to individual components.
//
// Warranty expiry is computed from the work order's completedAt + type.
// completedAt is the server-stamped completion timestamp (work-orders.js
// update()); departedAt is NOT used — it means "tech left the site" and is
// only populated on tech-UI completions.
//
// The months table is shared with completion-cascade.js (which snapshots
// warranty onto property service records at completion time) so the two
// can never drift. `install` is the project-final-cascade key — projects
// complete as a unit, outside the WO type enum — and equals `build`.

const WARRANTY_MONTHS = {
  build: 36,
  install: 36,
  service_visit: 12,
  spring_opening: 12,
  fall_closing: 12
};
const DEFAULT_WARRANTY_MONTHS = 12;

// UTC month arithmetic, same as completion-cascade.js addMonths — the two
// must agree so a helper-computed expiry matches a cascade-snapshotted one.
function addMonths(iso, months) {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

// Warranty expiry for a work order. Never silently returns a date:
//
//   { ok: true,  months, completedAt, expiresAt, active }  — computable
//   { ok: false, reason: "not_completed" }        — WO isn't completed
//   { ok: false, reason: "no_completion_date" }   — completed but
//       completedAt is null (pre-backfill record, or unrecoverable)
//
// `active` is a convenience: expiresAt is still in the future at call time.
function warrantyForWorkOrder(wo) {
  if (!wo || wo.status !== "completed") {
    return { ok: false, reason: "not_completed" };
  }
  if (typeof wo.completedAt !== "string" || !wo.completedAt) {
    return { ok: false, reason: "no_completion_date" };
  }
  const months = WARRANTY_MONTHS[wo.type] || DEFAULT_WARRANTY_MONTHS;
  const expiresAt = addMonths(wo.completedAt, months);
  return {
    ok: true,
    months,
    completedAt: wo.completedAt,
    expiresAt,
    active: Date.parse(expiresAt) > Date.now()
  };
}

module.exports = { WARRANTY_MONTHS, DEFAULT_WARRANTY_MONTHS, addMonths, warrantyForWorkOrder };
