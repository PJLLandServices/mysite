// server/lib/wo-findings.js
//
// Copying a visit's findings to the property's deferred recommendations —
// ONE rule, used by every path that does it (PJL-100 #4 + #5):
//   - POST /api/work-orders/:id/issues/defer          (bulk, the app's Finish)
//   - POST /api/work-orders/:id/zones/:n/issues/:i/defer   (per issue)
//   - POST /api/work-orders/:id/zones/:n/issues/:i/emergency
//   - the fall-closing completion cascade (retries whatever is unstamped)
//
// Fix #5 made the copy "copy, don't move": a finding stays on the visit,
// stamped with the deferred entry it became (`deferredId`). Two things were
// left open, both reproduced 10/10 on main:
//   1. Two overlapping copies (a retried Finish, the web button and the
//      phone at once) both saw the finding unstamped and both wrote it to
//      the property — next spring shows it twice.
//   2. The routes wrote back the WHOLE zones array from the copy read
//      before the property writes, so a zone edit saved meanwhile (the
//      office's note, the phone's last zone) was erased.
// And a copy that failed was reported (`notTransferred`) but never retried.
//
// So: copies for one work order run one at a time (serialize, in process —
// the server is a single Node process, PRD D5), and the stamp is applied by
// workOrders.stampDeferredIds(), under the WO store lock, to the FRESH
// record, touching nothing but `deferredId` on the findings it names.

const fs = require("node:fs");
const path = require("node:path");
const { serialize } = require("./atomic-json");
const workOrders = require("./work-orders");
const properties = require("./properties");
const issueRollup = require("./issue-rollup");

let PRICING = null;
function pricing() {
  if (!PRICING) {
    try { PRICING = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "pricing.json"), "utf8")); }
    catch (err) { console.error("[wo-findings] could not load pricing.json:", err?.message); PRICING = { items: {} }; }
  }
  return PRICING;
}

// The deferred entry for one finding (moved here unchanged from server.js
// so the completion cascade builds exactly the same entry).
function deferredPayloadFromIssue(wo, zoneNumber, issue, reason, pricingJson = pricing()) {
  const photoIds = (wo.photos || [])
    .filter((p) => p.issueId === issue.id)
    .map((p) => Number(p.n))
    .filter(Number.isFinite);
  let priceSnapshot = null;
  try {
    priceSnapshot = issueRollup.rollupSingleIssueToLineItems(issue, Number(zoneNumber) || 0, pricingJson);
  } catch (err) {
    console.warn("[defer] price snapshot failed:", err?.message);
  }
  return {
    fromWoId: wo.id,
    fromZone: Number(zoneNumber) || null,
    type: issue.type,
    qty: Number(issue.qty) || 1,
    notes: issue.notes || "",
    reason: reason || "customer_declined",
    photoIds,
    suggestedPriceSnapshot: priceSnapshot
  };
}

// Copy the unstamped findings on `woId` to its property.
//   only:     [{ zone, issueId }] to limit to specific findings (per-issue
//             and emergency routes); default every finding.
//   reason:   the deferred entry's reason.
//   extra:    merged into each deferred entry (e.g. { severity: "emergency" }).
//   pricingJson: the server's loaded pricing (defaults to pricing.json).
// Resolves { deferred: [{ zone, issueId, deferredId, entry }],
//            notTransferred: [{ zone, issueId, error }],
//            alreadyDeferred: [{ zone, issueId, deferredId }],
//            workOrder }  — workOrder is the fresh, stamped record.
function copyFindingsForward(woId, { only = null, reason = "fall_visit_no_repairs_policy", extra = null, pricingJson } = {}) {
  return serialize(`wo-findings:${woId}`, async () => {
    const wo = await workOrders.get(woId);
    if (!wo) return { deferred: [], notTransferred: [], alreadyDeferred: [], workOrder: null };
    const wanted = only ? new Set(only.map((o) => `${Number(o.zone)}|${o.issueId}`)) : null;
    const deferred = [];
    const notTransferred = [];
    const alreadyDeferred = [];
    for (const z of wo.zones || []) {
      for (const issue of z.issues || []) {
        if (wanted && !wanted.has(`${Number(z.number)}|${issue.id}`)) continue;
        if (issue.deferredId) { alreadyDeferred.push({ zone: z.number, issueId: issue.id, deferredId: issue.deferredId }); continue; }
        try {
          if (!wo.propertyId) throw new Error("work order has no linked property");
          const entry = await properties.addDeferredIssue(wo.propertyId, {
            ...deferredPayloadFromIssue(wo, z.number, issue, reason, pricingJson),
            ...(extra || {})
          });
          if (!entry?.id) throw new Error("no deferred entry was written");
          deferred.push({ zone: z.number, issueId: issue.id, deferredId: entry.id, entry });
        } catch (err) {
          console.warn(`[defer] zone ${z.number} issue ${issue.id} not transferred:`, err?.message);
          notTransferred.push({ zone: z.number, issueId: issue.id, error: String(err?.message || err).slice(0, 200) });
        }
      }
    }
    const workOrder = deferred.length
      ? await workOrders.stampDeferredIds(woId, deferred.map((d) => ({ zone: d.zone, issueId: d.issueId, deferredId: d.deferredId })))
      : wo;
    return { deferred, notTransferred, alreadyDeferred, workOrder: workOrder || wo };
  });
}

module.exports = { copyFindingsForward, deferredPayloadFromIssue };
