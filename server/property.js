// Property profile editor. Loads the property by ID from the URL,
// renders the form, lets Patrick edit zones / valve boxes / system info,
// saves via PATCH /api/properties/:id.

// Mobile nav hamburger toggle (shared pattern across all admin pages).
(function setupNavToggle() {
  const toggle = document.getElementById("navToggle");
  const nav = document.querySelector(".pjl-admin-nav");
  if (!toggle || !nav) return;
  toggle.addEventListener("click", () => {
    const open = !nav.classList.contains("is-open");
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  });
  nav.querySelectorAll(".pjl-nav-links a").forEach((a) => {
    a.addEventListener("click", () => {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
})();

const propertyHero = document.getElementById("propertyHero");
const propertyAddress = document.getElementById("propertyAddress");
const propertyCustomer = document.getElementById("propertyCustomer");
const propertyMeta = document.getElementById("propertyMeta");
const leadCount = document.getElementById("leadCount");
const propertyLoading = document.getElementById("propertyLoading");
const propertyError = document.getElementById("propertyError");
const propertyForm = document.getElementById("propertyForm");
const zonesList = document.getElementById("zonesList");
const valveBoxesList = document.getElementById("valveBoxesList");
const addZoneBtn = document.getElementById("addZoneBtn");
const addValveBoxBtn = document.getElementById("addValveBoxBtn");
const saveBtn = document.getElementById("saveBtn");
const saveStatus = document.getElementById("saveStatus");
const deleteBtn = document.getElementById("deleteBtn");
const logoutButton = document.getElementById("logoutButton");
const leadsSection = document.getElementById("leadsSection");
const leadListEl = document.getElementById("leadList");
const fieldWoSection = document.getElementById("fieldWoSection");
const fieldWoList = document.getElementById("fieldWoList");
const fieldWoNoZones = document.getElementById("fieldWoNoZones");
const createWoSpring = document.getElementById("createWoSpring");
const createWoFall = document.getElementById("createWoFall");
const createWoVisit = document.getElementById("createWoVisit");
const woWaiveFee = document.getElementById("woWaiveFee");
const woWaiveDetail = document.getElementById("woWaiveDetail");
const woWaiveReason = document.getElementById("woWaiveReason");
const woWaiveNotes = document.getElementById("woWaiveNotes");
const woWaiveNotesHint = document.getElementById("woWaiveNotesHint");
const woWaiveErr = document.getElementById("woWaiveErr");
const woWaiveFeeAmount = document.getElementById("woWaiveFeeAmount");

const confirmModal = document.getElementById("confirmModal");
const confirmTitle = document.getElementById("confirmTitle");
const confirmBody = document.getElementById("confirmBody");
const confirmTypedRow = document.getElementById("confirmTypedRow");
const confirmExpected = document.getElementById("confirmExpected");
const confirmInput = document.getElementById("confirmInput");
const confirmError = document.getElementById("confirmError");
const confirmCancel = document.getElementById("confirmCancel");
const confirmAccept = document.getElementById("confirmAccept");

let loadedProperty = null;
let loadedLeadCount = 0;

// Pull the property ID from the URL: /admin/property/<id>
function getPropertyId() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  // ["admin", "property", "<id>"]
  return parts[2] ? decodeURIComponent(parts[2]) : "";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

// ---- Zone rows ------------------------------------------------------

// Vocabulary for the zone-row pill multi-selects. Single source of truth —
// values are stored on the zone record, labels are user-facing copy.
const SPRINKLER_TYPES = [
  { value: "rotors", label: "Rotors" },
  { value: "popups", label: "Pop-ups" },
  { value: "drip", label: "Drip" },
  { value: "flower_pots", label: "Flower Pots" }
];
const COVERAGE_TYPES = [
  { value: "plants", label: "Plants" },
  { value: "grass", label: "Grass" },
  { value: "trees", label: "Trees" },
  { value: "shrubs", label: "Shrubs" }
];

function pillGroupHtml(groupName, options, selected) {
  const set = new Set((selected || []).map(String));
  const pills = options.map((opt) => `
    <button type="button" class="zone-pill" data-pill data-group="${groupName}" data-value="${escapeHtml(opt.value)}" aria-pressed="${set.has(opt.value) ? "true" : "false"}">${escapeHtml(opt.label)}</button>
  `).join("");
  return `<div class="zone-pill-group" data-group="${groupName}">${pills}</div>`;
}

// Build a single zone row. Using template literals + innerHTML rather
// than a heavyweight component framework — simpler, faster, fits the
// rest of the admin's vanilla-JS conventions.
//
// Schema: { number, location, sprinklerTypes:[], coverage:[], notes? }
// Backwards compat: older records use `label` instead of `location` —
// fall back to it on render so the import data isn't orphaned.
function zoneRowHtml(zone) {
  const location = zone.location || zone.label || "";
  return `
    <div class="property-zone-row" data-zone>
      <input type="number" class="zone-number" min="1" max="99" value="${escapeHtml(zone.number)}" placeholder="#">
      <input type="text" class="zone-location" value="${escapeHtml(location)}" placeholder="Location (e.g. Front lawn — north strip)">
      <button type="button" class="property-row-remove" data-action="remove-zone" aria-label="Remove zone">×</button>
      <div class="zone-pills">
        <div class="zone-pill-row">
          <span class="zone-pill-label">Sprinkler</span>
          ${pillGroupHtml("sprinklerTypes", SPRINKLER_TYPES, zone.sprinklerTypes || [])}
        </div>
        <div class="zone-pill-row">
          <span class="zone-pill-label">Coverage</span>
          ${pillGroupHtml("coverage", COVERAGE_TYPES, zone.coverage || [])}
        </div>
      </div>
    </div>
  `;
}

function valveBoxRowHtml(box) {
  return `
    <div class="property-valvebox-row" data-valvebox>
      <input type="text" class="vb-location" value="${escapeHtml(box.location || "")}" placeholder="Location (e.g. front-right corner of garden)">
      <input type="number" class="vb-count" min="1" max="50" value="${escapeHtml(box.valveCount || 1)}" placeholder="#">
      <input type="text" class="vb-notes" value="${escapeHtml(box.notes || "")}" placeholder="Notes (zone numbers, hard to find, etc.)">
      <button type="button" class="property-row-remove" data-action="remove-valvebox" aria-label="Remove valve box">×</button>
    </div>
  `;
}

function renderZones(zones) {
  zonesList.innerHTML = "";
  if (!zones.length) {
    addZoneRow({ number: 1, location: "", sprinklerTypes: [], coverage: [] });
    return;
  }
  zones.forEach((z) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = zoneRowHtml(z);
    zonesList.appendChild(wrap.firstElementChild);
  });
}

function renderValveBoxes(boxes) {
  valveBoxesList.innerHTML = "";
  if (!boxes.length) return;
  boxes.forEach((b) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = valveBoxRowHtml(b);
    valveBoxesList.appendChild(wrap.firstElementChild);
  });
}

function addZoneRow(zone = { number: nextZoneNumber(), location: "", sprinklerTypes: [], coverage: [] }) {
  const wrap = document.createElement("div");
  wrap.innerHTML = zoneRowHtml(zone);
  zonesList.appendChild(wrap.firstElementChild);
}

function addValveBoxRow(box = { location: "", valveCount: 1, notes: "" }) {
  const wrap = document.createElement("div");
  wrap.innerHTML = valveBoxRowHtml(box);
  valveBoxesList.appendChild(wrap.firstElementChild);
}

// Auto-suggest the next zone number based on the highest one currently rendered.
function nextZoneNumber() {
  const inputs = zonesList.querySelectorAll(".zone-number");
  let max = 0;
  inputs.forEach((i) => { const n = Number(i.value) || 0; if (n > max) max = n; });
  return max + 1;
}

// Click delegation for the dynamic rows' remove buttons + pill toggles.
zonesList.addEventListener("click", (event) => {
  if (event.target.matches('[data-action="remove-zone"]')) {
    event.target.closest(".property-zone-row")?.remove();
    return;
  }
  const pill = event.target.closest("[data-pill]");
  if (pill && zonesList.contains(pill)) {
    const isPressed = pill.getAttribute("aria-pressed") === "true";
    pill.setAttribute("aria-pressed", isPressed ? "false" : "true");
  }
});
valveBoxesList.addEventListener("click", (event) => {
  if (event.target.matches('[data-action="remove-valvebox"]')) {
    event.target.closest(".property-valvebox-row")?.remove();
  }
});

addZoneBtn.addEventListener("click", () => addZoneRow());
addValveBoxBtn.addEventListener("click", () => addValveBoxRow());

// ---- Hero + booking history ---------------------------------------

function renderHero(property, leads) {
  propertyHero.hidden = false;
  propertyAddress.textContent = property.address || "(address not set)";
  // Tap the address → Apple/Google Maps chooser (crm-contact.js). Only tag
  // when there's a real address so the "(address not set)" placeholder stays
  // inert.
  if (property.address) {
    propertyAddress.setAttribute("data-map-address", property.address);
  } else {
    propertyAddress.removeAttribute("data-map-address");
  }
  // If the property is linked to a customer record (Brief 2 migration
  // populates customerId on every property), link the customer name to
  // the customer profile. Fall back to plain-text snapshot for legacy
  // records that haven't been backfilled yet.
  if (property.customerId && property.customerName) {
    const link = `<a href="/admin/customer/${encodeURIComponent(property.customerId)}">${escapeHtml(property.customerName)}</a>`;
    const email = property.customerEmail ? ` · ${escapeHtml(property.customerEmail)}` : "";
    propertyCustomer.innerHTML = link + email;
  } else {
    const customer = [property.customerName, property.customerEmail].filter(Boolean).join(" · ");
    propertyCustomer.textContent = customer || "Customer details not yet captured";
  }
  const phone = property.customerPhone || "no phone on file";
  // Property code (P-YYYY-NNNN) leads the meta line so it's the first
  // thing the eye lands on — same convention as Q-/WO- in the rest of
  // the CRM.
  const codePart = property.code ? `${property.code} · ` : "";
  propertyMeta.textContent = `${codePart}${phone} · created ${formatDate(property.createdAt)}`;
  leadCount.textContent = leads.length;
}

const DEFERRED_TYPE_LABELS = {
  broken_head: "Broken head",
  leak: "Leak",
  valve: "Valve",
  wire: "Wire",
  pipe: "Pipe",
  other: "Other"
};

// Render priceSnapshot to a single line summary. Snapshots from the
// post-§5 schema have a lineItems[] + total; legacy entries (pre-§5
// admin-quote sinks) carry a flat { unitPrice, qty, label }. Both render.
function renderSnapshotSummary(snap) {
  if (!snap) return "";
  if (Array.isArray(snap.lineItems) && snap.lineItems.length) {
    const summary = snap.lineItems
      .map((l) => `${l.qty || 1}× ${l.label || l.key || "line"}`)
      .join(", ");
    const total = Number.isFinite(Number(snap.total))
      ? `$${Number(snap.total).toFixed(2)} incl. HST`
      : "";
    return `<p class="property-deferred__price"><strong>${escapeHtml(total)}</strong>${total ? " · " : ""}${escapeHtml(summary)}</p>`;
  }
  if (Number.isFinite(Number(snap.unitPrice))) {
    return `<p class="property-deferred__price">Snapshot: ${snap.qty || 1}× ${escapeHtml(snap.label || "line")} @ $${Number(snap.unitPrice).toFixed(2)}</p>`;
  }
  return "";
}

function renderDeferredItem(property, item) {
  const li = document.createElement("li");
  li.className = "property-deferred__item";
  li.dataset.deferredId = item.id;
  li.dataset.status = item.status || "open";
  const reDef = Number(item.reDeferralCount) || 0;
  if (reDef >= 3) li.dataset.flagged = "true";
  if (item.severity === "emergency") li.dataset.severity = "emergency";

  const typeLabel = DEFERRED_TYPE_LABELS[item.type] || item.type || "Issue";
  const declinedDate = item.declinedAt
    ? new Date(item.declinedAt).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })
    : "—";
  const ageDays = item.declinedAt
    ? Math.max(0, Math.round((Date.now() - new Date(item.declinedAt).getTime()) / 86400000))
    : null;
  const woLink = item.fromWoId
    ? `<a href="/admin/work-order/${encodeURIComponent(item.fromWoId)}" class="property-deferred__source">${item.fromWoId}</a>`
    : "";
  const zoneTag = Number.isFinite(Number(item.fromZone)) ? `· Zone ${item.fromZone}` : "";

  const pills = [];
  if (item.status === "pre_authorized") pills.push(`<span class="property-deferred__pill property-deferred__pill--preauth">✓ Customer pre-authorized</span>`);
  if (item.status === "in_progress") pills.push(`<span class="property-deferred__pill property-deferred__pill--progress">In progress (this visit)</span>`);
  if (item.status === "resolved") pills.push(`<span class="property-deferred__pill property-deferred__pill--resolved">Resolved</span>`);
  if (item.status === "dismissed") pills.push(`<span class="property-deferred__pill property-deferred__pill--dismissed">Dismissed</span>`);
  if (item.severity === "emergency") pills.push(`<span class="property-deferred__pill property-deferred__pill--emergency">🚨 Emergency</span>`);
  if (reDef >= 1) pills.push(`<span class="property-deferred__pill property-deferred__pill--repeat${reDef >= 3 ? " property-deferred__pill--repeat-flag" : ""}">${reDef}× declined</span>`);
  if (ageDays != null) pills.push(`<span class="property-deferred__pill property-deferred__pill--age">${ageDays}d old</span>`);

  const priceLine = renderSnapshotSummary(item.suggestedPriceSnapshot);
  const photoChips = Array.isArray(item.photoIds) && item.photoIds.length && item.fromWoId
    ? `<div class="property-deferred__photos">${item.photoIds.map((n) => `<a href="/api/work-orders/${encodeURIComponent(item.fromWoId)}/photo/${encodeURIComponent(n)}" target="_blank" rel="noopener">📷 ${escapeHtml(String(n))}</a>`).join("")}</div>`
    : "";
  const preAuthMeta = item.preAuthorization
    ? `<p class="property-deferred__preauth">Pre-authorized by ${escapeHtml(item.preAuthorization.customerName || "customer")} on ${escapeHtml(new Date(item.preAuthorization.signedAt).toLocaleString())}</p>`
    : "";
  const resolutionMeta = item.resolution && item.resolution.resolvedAt
    ? `<p class="property-deferred__resolution">${escapeHtml(item.resolution.resolvedBy || "admin")} · ${escapeHtml(new Date(item.resolution.resolvedAt).toLocaleDateString())}${item.resolution.resolvedInWoId ? " · " : ""}${item.resolution.resolvedInWoId ? `<a href="/admin/work-order/${encodeURIComponent(item.resolution.resolvedInWoId)}">${escapeHtml(item.resolution.resolvedInWoId)}</a>` : ""}${item.resolution.note ? " — " + escapeHtml(item.resolution.note) : ""}</p>`
    : "";

  // Admin action set depends on status:
  //   open           → Mark resolved | Dismiss
  //   pre_authorized → Dismiss
  //   in_progress    → (no admin actions; tech's WO sign promotes to resolved)
  //   resolved/dismissed → no actions
  let actionsHtml = "";
  if (item.status === "open") {
    actionsHtml = `
      <div class="property-deferred__actions">
        <button type="button" class="property-deferred__btn" data-defer-action="resolved">Mark resolved</button>
        <button type="button" class="property-deferred__btn property-deferred__btn--danger" data-defer-action="dismissed">Dismiss</button>
      </div>`;
  } else if (item.status === "pre_authorized") {
    actionsHtml = `
      <div class="property-deferred__actions">
        <button type="button" class="property-deferred__btn property-deferred__btn--danger" data-defer-action="dismissed">Dismiss</button>
      </div>`;
  }

  // Three-year forced-decision banner — visual prominence over an
  // ignored item per spec rule #15. The buttons just route to the
  // existing actions; the banner forces eyes-on attention.
  const threeYearBanner = (reDef >= 3 && (item.status === "open" || item.status === "pre_authorized"))
    ? `<div class="property-deferred__threeyear">⚠ This item has been declined ${reDef} years in a row. Resolve, escalate to the customer, or dismiss it.</div>`
    : "";

  li.innerHTML = `
    ${threeYearBanner}
    <div class="property-deferred__head">
      <strong>${escapeHtml(typeLabel)}</strong>
      <span class="property-deferred__qty">qty ${escapeHtml(String(item.qty || 1))}</span>
      ${pills.join("")}
    </div>
    <p class="property-deferred__meta">${item.status === "open" ? "Declined" : "First seen"} ${escapeHtml(declinedDate)} ${zoneTag} ${woLink ? "· from " + woLink : ""}</p>
    ${item.notes ? `<p class="property-deferred__notes">${escapeHtml(item.notes)}</p>` : ""}
    ${priceLine}
    ${photoChips}
    ${preAuthMeta}
    ${resolutionMeta}
    ${actionsHtml}
  `;
  return li;
}

function renderDeferredRecommendations(property) {
  const section = document.getElementById("deferredSection");
  const list = document.getElementById("deferredList");
  const countEl = document.getElementById("deferredCount");
  if (!section || !list) return;
  const all = Array.isArray(property.deferredIssues) ? property.deferredIssues : [];
  const open = all.filter((d) => d && (d.status === "open" || d.status === "pre_authorized" || d.status === "in_progress"));
  const history = all.filter((d) => d && (d.status === "resolved" || d.status === "dismissed"));
  if (!open.length && !history.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (countEl) countEl.textContent = String(open.length);
  list.innerHTML = "";
  list.dataset.propertyId = property.id;
  for (const item of open) list.appendChild(renderDeferredItem(property, item));
  if (history.length) {
    const summary = document.createElement("details");
    summary.className = "property-deferred__history";
    summary.innerHTML = `<summary>History (${history.length})</summary><ul class="property-deferred__history-list"></ul>`;
    const inner = summary.querySelector("ul");
    for (const item of history) inner.appendChild(renderDeferredItem(property, item));
    list.appendChild(summary);
  }
}

// Admin lifecycle action: PATCH /api/properties/:id/deferred/:deferredId
// {status: "resolved"|"dismissed"}. Wired via delegation on the list.
document.getElementById("deferredList")?.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-defer-action]");
  if (!btn) return;
  const li = btn.closest("[data-deferred-id]");
  const list = document.getElementById("deferredList");
  const propertyId = list?.dataset.propertyId;
  if (!li || !propertyId) return;
  const deferredId = li.dataset.deferredId;
  const action = btn.dataset.deferAction;
  if (!confirm(`Mark this item as "${action}"?`)) return;
  let note = "";
  if (action === "dismissed") {
    note = prompt("Optional note (why dismissed?)", "") || "";
  }
  btn.disabled = true;
  try {
    const r = await fetch(`/api/properties/${encodeURIComponent(propertyId)}/deferred/${encodeURIComponent(deferredId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: action, note })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't update.");
    // Pull a fresh property and re-render — keeps grouping/counts correct.
    const fresh = await fetch(`/api/properties/${encodeURIComponent(propertyId)}`).then((r) => r.json()).catch(() => null);
    if (fresh?.property) renderDeferredRecommendations(fresh.property);
  } catch (err) {
    alert(err.message || "Couldn't update.");
    btn.disabled = false;
  }
});

// Service history — completed visits at this property (spec §4.3.4
// completion cascade output). Each entry shows the WO, summary, total,
// warranty expiry, and a deep-link to the draft invoice if one exists.
const SR_TYPE_LABELS = {
  spring_opening: "Spring Opening",
  fall_closing: "Fall Closing",
  service_visit: "Service Visit"
};
function renderServiceRecords(property) {
  const section = document.getElementById("serviceRecordsSection");
  const list = document.getElementById("serviceRecordsList");
  const countEl = document.getElementById("serviceRecordsCount");
  if (!section || !list) return;
  const items = Array.isArray(property.serviceRecords) ? property.serviceRecords : [];
  if (!items.length) { section.hidden = true; return; }
  section.hidden = false;
  if (countEl) countEl.textContent = String(items.length);
  list.innerHTML = "";
  for (const r of items) {
    const li = document.createElement("li");
    li.className = "property-service-record";
    const completedDate = r.completedAt
      ? new Date(r.completedAt).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })
      : "—";
    const warrantyDate = r.warrantyExpiresAt
      ? new Date(r.warrantyExpiresAt).toLocaleDateString("en-CA", { month: "short", year: "numeric" })
      : null;
    const totalLine = r.total > 0 ? `$${Number(r.total).toFixed(2)} incl. HST` : "No charge";
    const invoiceLink = r.invoiceId
      ? `<a class="property-service-record__invoice" href="/admin/invoice/${encodeURIComponent(r.invoiceId)}">Invoice ${escapeHtml(r.invoiceId)}</a>`
      : "";
    const woLink = r.woId
      ? `<a class="property-service-record__wo" href="/admin/work-order/${encodeURIComponent(r.woId)}">${escapeHtml(r.woId)}</a>`
      : "";
    li.innerHTML = `
      <div class="property-service-record__head">
        <strong>${escapeHtml(SR_TYPE_LABELS[r.woType] || r.woType || "Visit")}</strong>
        <span class="property-service-record__date">${escapeHtml(completedDate)}</span>
      </div>
      <p class="property-service-record__summary">${escapeHtml(r.summary || "")}</p>
      <div class="property-service-record__meta">
        <span>${escapeHtml(totalLine)}</span>
        ${warrantyDate ? `<span>· Warranty thru ${escapeHtml(warrantyDate)}</span>` : ""}
        ${woLink ? `<span>· ${woLink}</span>` : ""}
        ${invoiceLink ? `<span>· ${invoiceLink}</span>` : ""}
      </div>
    `;
    list.appendChild(li);
  }
}

function renderLeadsList(leads) {
  if (!leads.length) {
    leadsSection.hidden = true;
    return;
  }
  leadsSection.hidden = false;
  leadListEl.innerHTML = "";
  leads
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .forEach((lead) => {
      const li = document.createElement("li");
      const stage = lead.crm?.status || lead.status || "new";
      const total = lead.totals?.expectedTotal ? `$${Math.round(lead.totals.expectedTotal)}` : "—";
      const sourceLabel = lead.sourceLabel || "Lead";
      li.innerHTML = `
        <a href="/admin#lead-${escapeHtml(lead.id)}">
          <span class="lead-row-stage">${escapeHtml(stage)}</span>
          <span class="lead-row-source">${escapeHtml(sourceLabel)}</span>
          <span class="lead-row-when">${escapeHtml(formatDate(lead.createdAt))}</span>
          <span class="lead-row-total">${escapeHtml(total)}</span>
        </a>
      `;
      leadListEl.appendChild(li);
    });
}

// Render the property's Field Work Orders section. Shows existing WOs for
// this property + the three create buttons. Closes the gap where existing
// customers (no active booking) had no path to spin up a WO.
const TYPE_LABELS = {
  spring_opening: "Spring Opening",
  fall_closing: "Fall Closing",
  service_visit: "Service Visit"
};
async function renderFieldWoList(property) {
  if (!property) return;
  fieldWoSection.hidden = false;
  // Hint about empty zones — for Spring/Fall the scaffold will be empty
  // until zones are added to the profile.
  const zoneCount = (property.system?.zones || []).length;
  fieldWoNoZones.hidden = zoneCount > 0;

  fieldWoList.innerHTML = "<li class=\"property-field-wo__loading\">Loading…</li>";
  try {
    const response = await fetch(`/api/work-orders?propertyId=${encodeURIComponent(property.id)}`, { cache: "no-store" });
    const data = await response.json();
    const wos = (data.ok ? data.workOrders : []) || [];
    fieldWoList.innerHTML = "";
    if (!wos.length) {
      const li = document.createElement("li");
      li.className = "property-field-wo__empty";
      li.textContent = "No field work orders yet for this property.";
      fieldWoList.appendChild(li);
      return;
    }
    wos.forEach((wo) => {
      const li = document.createElement("li");
      li.className = "property-field-wo__item";
      li.innerHTML = `
        <a href="/admin/work-order/${encodeURIComponent(wo.id)}">
          <strong>${escapeHtml(wo.id)}</strong>
          <span class="property-field-wo__type">${escapeHtml(TYPE_LABELS[wo.type] || wo.type)}</span>
          <span class="property-field-wo__status">${escapeHtml((wo.status || "scheduled").replace(/_/g, " "))}</span>
          <span class="property-field-wo__when">${escapeHtml(formatDate(wo.updatedAt))}</span>
        </a>
      `;
      fieldWoList.appendChild(li);
    });
  } catch {
    fieldWoList.innerHTML = "<li class=\"property-field-wo__empty\">Couldn't load.</li>";
  }
}

// ---- Service-call fee waiver (Service Visit WOs only) ------------------
// The $95 service-call fee is only charged on service_visit WOs (the rollup
// adds it when repairs are found). Spring/Fall are flat-rate with no separate
// trip charge, so the waiver isn't offered for them. Off by default.

// Pull the canonical service_call price from pricing.json so the checkbox
// label reflects the live fee rather than a hardcoded "$95".
(async function hydrateWaiverFeeAmount() {
  if (!woWaiveFeeAmount) return;
  try {
    const res = await fetch("/api/pricing", { cache: "no-store" });
    const data = await res.json();
    const price = data?.items?.service_call?.price;
    if (Number.isFinite(Number(price))) woWaiveFeeAmount.textContent = "$" + Number(price);
  } catch { /* keep the static fallback */ }
})();

function clearWaiverError() {
  if (woWaiveErr) { woWaiveErr.hidden = true; woWaiveErr.textContent = ""; }
}

// Show/hide the reason+notes block and flip the notes hint to "(required)"
// when the reason is Other.
function syncWaiverUi() {
  const on = !!(woWaiveFee && woWaiveFee.checked);
  if (woWaiveDetail) woWaiveDetail.hidden = !on;
  if (woWaiveNotesHint) {
    woWaiveNotesHint.textContent = woWaiveReason?.value === "other" ? "(required)" : "(optional)";
  }
  if (!on) clearWaiverError();
}
woWaiveFee?.addEventListener("change", syncWaiverUi);
woWaiveReason?.addEventListener("change", () => { syncWaiverUi(); clearWaiverError(); });
woWaiveNotes?.addEventListener("input", clearWaiverError);

// Read + validate the waiver from the form. Returns:
//   { skip: true }                 — not waived (nothing to attach)
//   { error: "..." }               — invalid; caller aborts and shows it
//   { waiver: {...} }              — valid payload for the POST body
function readServiceFeeWaiver() {
  if (!woWaiveFee || !woWaiveFee.checked) return { skip: true };
  const reason = woWaiveReason?.value || "";
  if (!reason) return { error: "Select a waiver reason." };
  const notes = (woWaiveNotes?.value || "").trim();
  if (reason === "other" && !notes) return { error: "Add a note explaining the waiver when the reason is 'Other'." };
  return { waiver: { waived: true, reason, notes } };
}

async function createFieldWoFromButton(type) {
  if (!loadedProperty) return;
  const button = document.querySelector(`[data-create-wo="${type}"]`);

  // Only service visits carry a service-call fee, so the waiver only applies
  // there. Validate before disabling anything so a bad waiver keeps the form
  // interactive.
  const body = { type, propertyId: loadedProperty.id };
  if (type === "service_visit") {
    const w = readServiceFeeWaiver();
    if (w.error) {
      if (woWaiveErr) { woWaiveErr.textContent = w.error; woWaiveErr.hidden = false; }
      return;
    }
    if (w.waiver) body.serviceFeeWaiver = w.waiver;
  }

  if (button) button.disabled = true;
  try {
    const response = await fetch("/api/work-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error((data.errors && data.errors[0]) || `Create failed (HTTP ${response.status}).`);
    }
    window.location.assign(`/admin/work-order/${encodeURIComponent(data.workOrder.id)}`);
  } catch (err) {
    alert(err.message);
    if (button) button.disabled = false;
  }
}

createWoSpring?.addEventListener("click", () => createFieldWoFromButton("spring_opening"));
createWoFall?.addEventListener("click",   () => createFieldWoFromButton("fall_closing"));
createWoVisit?.addEventListener("click",  () => createFieldWoFromButton("service_visit"));

// ---- Form populate + save ----------------------------------------

// Customer identity for the property form. Source of truth is the
// Customer record (CUST-NNNN) reached via property.customerId; the
// embedded customerName/Email/Phone are the legacy snapshot used as
// the display fallback (and the link target) when customerId hasn't
// been backfilled yet. Edit link points at the customer profile when
// linked, otherwise the customer index where Patrick can search/create.
function populateCustomerDisplay(property) {
  const nameEl = document.getElementById("propertyCustomerDisplayName");
  const metaEl = document.getElementById("propertyCustomerDisplayMeta");
  const linkEl = document.getElementById("propertyCustomerEditLink");
  const fallbackEl = document.getElementById("propertyCustomerFallbackNote");
  const warnEl = document.getElementById("propertyCustomerNameWarn");
  if (!nameEl || !metaEl || !linkEl || !fallbackEl) return;

  const rawName = String(property.customerName || "").trim();
  const name = rawName || "(no name on file)";
  const metaParts = [property.customerEmail, property.customerPhone].filter(Boolean);
  nameEl.textContent = name;
  metaEl.textContent = metaParts.length ? metaParts.join(" · ") : "—";

  if (property.customerId) {
    linkEl.href = `/admin/customer/${encodeURIComponent(property.customerId)}`;
    linkEl.textContent = "Edit customer →";
    fallbackEl.hidden = true;
  } else {
    linkEl.href = "/admin/customers";
    linkEl.textContent = "Open Customers →";
    fallbackEl.hidden = false;
  }

  // Name-invariant warning — surfaces the missing-name state so
  // Patrick sees it without having to open the outreach audit
  // (feature-seasonal-outreach-brief.md §3.9).
  if (warnEl) {
    warnEl.hidden = Boolean(rawName);
  }
}

function populateForm(property, seasonalPricingResolved) {
  // Customer identity is now read-only in this section — populate the
  // display block instead of input fields. Source of truth: the
  // Customer record (CUST-NNNN) reached via property.customerId; the
  // embedded customerName/Email/Phone are the legacy snapshot used as
  // the display fallback when customerId hasn't been backfilled.
  populateCustomerDisplay(property);
  propertyForm.elements.address.value = property.address || "";
  // Commercial billing entity + site contacts (management-company model).
  if (propertyForm.elements.billingEntity) {
    propertyForm.elements.billingEntity.value = property.billingEntity || "";
  }
  if (propertyForm.elements.billingCcEmail) {
    propertyForm.elements.billingCcEmail.value = property.billingCcEmail || "";
  }
  renderSiteContacts(property.siteContacts || []);
  renderBillToPreview();
  const sys = property.system || {};
  propertyForm.elements.controllerLocation.value = sys.controllerLocation || "";
  propertyForm.elements.controllerBrand.value = sys.controllerBrand || "";
  propertyForm.elements.shutoffLocation.value = sys.shutoffLocation || "";
  propertyForm.elements.blowoutLocation.value = sys.blowoutLocation || "";
  propertyForm.elements.notes.value = sys.notes || "";
  renderZones(sys.zones || []);
  renderValveBoxes(sys.valveBoxes || []);
  // Seasonal eligibility + comm prefs
  // (feature-seasonal-outreach-brief.md §3.1). Defaults follow the
  // lib's normalize-on-read — `springOpening !== false` so a property
  // imported before the schema landed reads as eligible. Both toggle
  // pairs are saved alongside the rest of the patch through the
  // standard form submit.
  const elig = property.seasonalEligibility || {};
  const prefs = property.commPrefs || {};
  if (propertyForm.elements.eligSpring) {
    propertyForm.elements.eligSpring.checked = elig.springOpening !== false;
  }
  if (propertyForm.elements.eligFall) {
    propertyForm.elements.eligFall.checked = elig.fallClosing !== false;
  }
  if (propertyForm.elements.prefSms) {
    propertyForm.elements.prefSms.checked = prefs.seasonalRemindersSMS !== false;
  }
  if (propertyForm.elements.prefEmail) {
    propertyForm.elements.prefEmail.checked = prefs.seasonalRemindersEmail !== false;
  }
  if (propertyForm.elements.prefNoContact) {
    // Opposite default from the two above: contact is assumed needed.
    propertyForm.elements.prefNoContact.checked = prefs.noContactNeeded === true;
  }
  populateSeasonalPricing(property.seasonalPricing || {}, seasonalPricingResolved || null);
}

// Hydrate the Seasonal Pricing card: override fields, cabana toggle,
// conditional sub-rows. Hint line under each override input shows the
// server-resolved value with a (override) / (default tier — N zones) /
// (custom quote) tag, so Patrick can see what the WO seeder will use
// without doing tier-arithmetic in his head.
function populateSeasonalPricing(sp, resolved) {
  const springInput = document.getElementById("seasonalSpringPrice");
  const fallInput   = document.getElementById("seasonalFallPrice");
  const springHint  = document.getElementById("seasonalSpringHint");
  const fallHint    = document.getElementById("seasonalFallHint");
  const yesRadio    = document.getElementById("seasonalAdditionalFallYes");
  const noRadio     = document.getElementById("seasonalAdditionalFallNo");
  const subFields   = document.getElementById("seasonalAdditionalFallFields");
  const descInput   = document.getElementById("seasonalAdditionalFallDescription");
  const priceInput  = document.getElementById("seasonalAdditionalFallPrice");
  if (!springInput || !fallInput || !yesRadio || !noRadio || !subFields) return;

  springInput.value = (sp.springOpeningPrice !== null && sp.springOpeningPrice !== undefined) ? sp.springOpeningPrice : "";
  fallInput.value   = (sp.fallClosingPrice   !== null && sp.fallClosingPrice   !== undefined) ? sp.fallClosingPrice   : "";
  if (sp.hasAdditionalFallBlowout === true) { yesRadio.checked = true; noRadio.checked = false; }
  else { noRadio.checked = true; yesRadio.checked = false; }
  descInput.value  = sp.additionalFallBlowoutDescription || "";
  priceInput.value = (sp.additionalFallBlowoutPrice !== null && sp.additionalFallBlowoutPrice !== undefined) ? sp.additionalFallBlowoutPrice : "";
  applyAdditionalFallVisibility();

  if (springHint) springHint.textContent = formatResolvedHint(resolved?.spring_opening);
  if (fallHint)   fallHint.textContent   = formatResolvedHint(resolved?.fall_closing);
}

function formatResolvedHint(r) {
  if (!r) return "—";
  if (r.source === "property_override") return `In use: $${Number(r.price).toFixed(2)} (override)`;
  if (r.source === "custom_quote_required") return `In use: Custom quote (${r.zoneCount || 0} zones — no tier price)`;
  if (r.source === "pricing_json_tier") return `In use: $${Number(r.price).toFixed(2)} (default tier — ${r.zoneCount || 0} zones)`;
  return "—";
}

function applyAdditionalFallVisibility() {
  const yesRadio    = document.getElementById("seasonalAdditionalFallYes");
  const subFields   = document.getElementById("seasonalAdditionalFallFields");
  const priceInput  = document.getElementById("seasonalAdditionalFallPrice");
  if (!yesRadio || !subFields) return;
  const on = yesRadio.checked;
  subFields.hidden = !on;
  if (priceInput) priceInput.required = on;
}

document.getElementById("seasonalAdditionalFallYes")?.addEventListener("change", applyAdditionalFallVisibility);
document.getElementById("seasonalAdditionalFallNo")?.addEventListener("change", applyAdditionalFallVisibility);

function collectForm() {
  const zones = Array.from(zonesList.querySelectorAll(".property-zone-row"))
    .map((row) => {
      const collectGroup = (groupName) =>
        Array.from(row.querySelectorAll(`[data-pill][data-group="${groupName}"][aria-pressed="true"]`))
          .map((pill) => pill.dataset.value);
      return {
        number: Number(row.querySelector(".zone-number").value) || 0,
        location: row.querySelector(".zone-location").value.trim(),
        sprinklerTypes: collectGroup("sprinklerTypes"),
        coverage: collectGroup("coverage")
      };
    })
    .filter((z) => z.number || z.location || z.sprinklerTypes.length || z.coverage.length);

  const valveBoxes = Array.from(valveBoxesList.querySelectorAll(".property-valvebox-row"))
    .map((row) => ({
      location: row.querySelector(".vb-location").value.trim(),
      valveCount: Number(row.querySelector(".vb-count").value) || 1,
      notes: row.querySelector(".vb-notes").value.trim()
    }))
    .filter((b) => b.location);

  // Customer identity (name / phone) is owned by the Customer record,
  // not by this page — omit those fields from the patch. The lib's
  // shallow merge preserves existing snapshot values when fields are
  // absent, so omission is safe.
  //
  // seasonalEligibility + commPrefs ride along on the same PATCH so a
  // single Save profile click captures every change in one audit
  // step. The lib deep-merges these so the unsurfaced
  // commPrefs.optOutTokens secrets aren't wiped by a UI patch.
  return {
    address: propertyForm.elements.address.value.trim(),
    // Commercial billing entity + site contacts (management-company model).
    // Both are full replaces; the lib normalizes and drops empty rows.
    billingEntity: (propertyForm.elements.billingEntity?.value || "").trim(),
    // Per-site billing CC — lower-cased server-side too, but normalize here
    // so the value the operator sees echoed back matches what was stored.
    billingCcEmail: (propertyForm.elements.billingCcEmail?.value || "").trim().toLowerCase(),
    siteContacts: collectSiteContacts(),
    system: {
      controllerLocation: propertyForm.elements.controllerLocation.value.trim(),
      controllerBrand: propertyForm.elements.controllerBrand.value.trim(),
      shutoffLocation: propertyForm.elements.shutoffLocation.value.trim(),
      blowoutLocation: propertyForm.elements.blowoutLocation.value.trim(),
      notes: propertyForm.elements.notes.value.trim(),
      zones,
      valveBoxes
    },
    seasonalEligibility: {
      springOpening: Boolean(propertyForm.elements.eligSpring?.checked),
      fallClosing: Boolean(propertyForm.elements.eligFall?.checked)
    },
    commPrefs: {
      seasonalRemindersSMS: Boolean(propertyForm.elements.prefSms?.checked),
      seasonalRemindersEmail: Boolean(propertyForm.elements.prefEmail?.checked),
      noContactNeeded: Boolean(propertyForm.elements.prefNoContact?.checked)
    },
    seasonalPricing: collectSeasonalPricing()
  };
}

// ---- Commercial site contacts (management-company model) --------------
// Rows live on the PROPERTY: the people at this address (board president,
// super) that PJL calls to schedule. The quote signatory normally lives on
// the CUSTOMER instead, but a site-level signatory is allowed for a board
// that signs only for its own building.
const SITE_ROLES = [
  ["", "Select role…"],
  ["owner_board", "Owner / board member"],
  ["site_contact", "Site contact"],
  ["property_manager", "Property manager"],
  ["accounts_payable", "Accounts payable"],
  ["other", "Other"]
];

function siteContactRowHtml(c) {
  const opts = SITE_ROLES.map(([v, l]) =>
    `<option value="${v}"${(c.role || "") === v ? " selected" : ""}>${l}</option>`).join("");
  const esc = (s) => String(s == null ? "" : s).replace(/"/g, "&quot;");
  // data-cid carries the contact's con_ id back to the server on save. A row
  // without one (the "+ Add contact" button) is a new contact and the server
  // mints an id for it. Dropping this attribute would re-mint every id on
  // every save and break anything referencing a contact.
  return `
    <div class="property-row" data-cid="${esc(c.id || "")}" style="gap:10px;align-items:flex-end;flex-wrap:wrap;">
      <label style="flex:2 1 180px;"><span>Name</span>
        <input type="text" class="sc-name" value="${esc(c.name)}"></label>
      <label style="flex:1 1 150px;"><span>Role</span>
        <select class="sc-role">${opts}</select></label>
      <label style="flex:2 1 180px;"><span>Email</span>
        <input type="email" class="sc-email" value="${esc(c.email)}"></label>
      <label style="flex:1 1 140px;"><span>Phone</span>
        <input type="tel" class="sc-phone" value="${esc(c.phone)}"></label>
      <label style="flex:1 1 100%;display:flex;flex-direction:row;align-items:center;gap:8px;text-transform:none;font-weight:400;">
        <input type="checkbox" class="sc-sig" style="width:16px;min-width:16px;flex:0 0 16px;height:16px;margin:0;"${c.isAuthorizedSignatory ? " checked" : ""}>
        <span style="text-transform:none;">Also authorized to sign quotes for this site</span></label>
      <button type="button" class="pjl-btn pjl-btn-outline sc-remove" style="padding:6px 12px;font-size:13px;">Remove</button>
    </div>`;
}

function renderSiteContacts(list) {
  const wrap = document.getElementById("propSiteContactsList");
  const empty = document.getElementById("propSiteContactsEmpty");
  if (!wrap) return;
  const rows = Array.isArray(list) ? list : [];
  wrap.innerHTML = rows.map(siteContactRowHtml).join("");
  if (empty) empty.hidden = rows.length > 0;
  wrap.querySelectorAll(".sc-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest(".property-row")?.remove();
      if (empty) empty.hidden = wrap.querySelectorAll(".property-row").length > 0;
    });
  });
}

function collectSiteContacts() {
  const wrap = document.getElementById("propSiteContactsList");
  if (!wrap) return [];
  return Array.from(wrap.querySelectorAll(".property-row")).map((row) => ({
    id: row.getAttribute("data-cid") || "",
    name: row.querySelector(".sc-name")?.value.trim() || "",
    role: row.querySelector(".sc-role")?.value || "",
    email: row.querySelector(".sc-email")?.value.trim() || "",
    phone: row.querySelector(".sc-phone")?.value.trim() || "",
    isSiteContact: true,
    isAuthorizedSignatory: !!row.querySelector(".sc-sig")?.checked
  })).filter((c) => c.name || c.email || c.phone);
}

document.getElementById("propAddSiteContact")?.addEventListener("click", () => {
  const wrap = document.getElementById("propSiteContactsList");
  const empty = document.getElementById("propSiteContactsEmpty");
  if (!wrap) return;
  wrap.insertAdjacentHTML("beforeend", siteContactRowHtml({ name: "", role: "", email: "", phone: "", isAuthorizedSignatory: false }));
  if (empty) empty.hidden = true;
  const last = wrap.lastElementChild;
  last?.querySelector(".sc-remove")?.addEventListener("click", () => {
    last.remove();
    if (empty) empty.hidden = wrap.querySelectorAll(".property-row").length > 0;
  });
  last?.querySelector(".sc-name")?.focus();
});

// Live preview of the invoice envelope this property will produce, so the
// entity/c/o split is visible before anything is billed. Mirrors
// lib/billing-parties.resolveBillTo.
function renderBillToPreview() {
  const el = document.getElementById("propertyBillToPreview");
  if (!el) return;
  const entity = (propertyForm.elements.billingEntity?.value || "").trim();
  const ccEmail = (propertyForm.elements.billingCcEmail?.value || "").trim();
  const custName = (loadedProperty?.customerName || "").trim();
  // Either field alone is worth previewing: a site can have a bookkeeper CC
  // without being separately incorporated.
  if (!entity && !ccEmail) { el.hidden = true; return; }
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts = [];
  if (entity) {
    const managed = Boolean(custName && entity !== custName);
    const lines = [`<strong>${esc(entity)}</strong>`];
    if (managed) lines.push(`c/o ${esc(custName)}`);
    lines.push('<span style="color:#6A6A60;">…billing address from the customer record</span>');
    parts.push(`Invoices and quotes for this property will be addressed:<br>${lines.join("<br>")}`);
  }
  if (ccEmail) {
    // Spelled out because the scope is the surprising part: the CC rides
    // invoices only, never the quote the signatory accepts.
    parts.push(`<span style="color:#6A6A60;">Invoice emails (not quotes) will also copy <strong>${esc(ccEmail)}</strong>.</span>`);
  }
  el.innerHTML = parts.join("<br><br>");
  el.hidden = false;
}

document.getElementById("propertyBillToPreview") && propertyForm.addEventListener("input", (e) => {
  if (e.target && (e.target.name === "billingEntity" || e.target.name === "billingCcEmail")) {
    renderBillToPreview();
  }
});

// Build the seasonalPricing patch from the form. Empty override inputs
// emit null so the server normalizes back to "use tier default."
// Cabana off forces the dependent fields to null/empty regardless of
// what the (potentially still-hidden-but-DOM-present) inputs hold —
// belt-and-suspenders for the lib's hydrateSeasonalPricing.
function collectSeasonalPricing() {
  const springEl  = document.getElementById("seasonalSpringPrice");
  const fallEl    = document.getElementById("seasonalFallPrice");
  const yesEl     = document.getElementById("seasonalAdditionalFallYes");
  const descEl    = document.getElementById("seasonalAdditionalFallDescription");
  const priceEl   = document.getElementById("seasonalAdditionalFallPrice");
  function numOrNull(el) {
    if (!el) return null;
    const raw = String(el.value || "").trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
  }
  const has = !!(yesEl && yesEl.checked);
  return {
    springOpeningPrice: numOrNull(springEl),
    fallClosingPrice:   numOrNull(fallEl),
    hasAdditionalFallBlowout: has,
    additionalFallBlowoutPrice:       has ? numOrNull(priceEl) : null,
    additionalFallBlowoutDescription: has ? String(descEl?.value || "").trim().slice(0, 200) : ""
  };
}

propertyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = getPropertyId();
  if (!id) return;
  saveBtn.disabled = true;
  saveStatus.textContent = "Saving…";
  try {
    const response = await fetch(`/api/properties/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collectForm())
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Save failed."]).join(" "));
    saveStatus.textContent = "Saved";
    setTimeout(() => { saveStatus.textContent = ""; }, 2000);
    // Reflect anything the server normalized (e.g. addressNormalized,
    // seasonalPricing cabana-off → cleared dependent fields). The PATCH
    // response doesn't carry seasonalPricingResolved — re-fetch the
    // hints by computing them from the resolved override values when
    // present, otherwise mark them as stale until the next page load.
    populateForm(data.property, data.seasonalPricingResolved || null);
  } catch (err) {
    saveStatus.textContent = err.message || "Couldn't save.";
  } finally {
    saveBtn.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.assign("/login");
});

// ---- Delete this customer (with typed-confirmation 2FA) -------------

let confirmResolver = null;

function openConfirm({ title, body, expected }) {
  confirmTitle.textContent = title;
  confirmBody.innerHTML = body;
  confirmError.hidden = true;
  confirmError.textContent = "";
  if (expected) {
    confirmTypedRow.hidden = false;
    confirmExpected.textContent = expected;
    confirmInput.value = "";
    confirmInput.dataset.expected = expected;
    confirmAccept.disabled = true;
  } else {
    confirmTypedRow.hidden = true;
    confirmInput.dataset.expected = "";
    confirmAccept.disabled = false;
  }
  confirmModal.hidden = false;
  setTimeout(() => {
    if (expected) confirmInput.focus();
    else confirmAccept.focus();
  }, 0);
  return new Promise((resolve) => { confirmResolver = resolve; });
}

function closeConfirm(result) {
  confirmModal.hidden = true;
  confirmInput.value = "";
  confirmAccept.disabled = false;
  if (confirmResolver) {
    const r = confirmResolver;
    confirmResolver = null;
    r(result);
  }
}

confirmCancel.addEventListener("click", () => closeConfirm(false));
confirmAccept.addEventListener("click", () => {
  const expected = confirmInput.dataset.expected;
  if (expected && confirmInput.value.trim() !== expected) {
    confirmError.hidden = false;
    confirmError.textContent = `Type ${expected} exactly to confirm.`;
    return;
  }
  closeConfirm(true);
});
confirmInput.addEventListener("input", () => {
  const expected = confirmInput.dataset.expected;
  confirmAccept.disabled = !expected || confirmInput.value.trim() !== expected;
  if (!confirmError.hidden) confirmError.hidden = true;
});
confirmModal.addEventListener("click", (event) => {
  if (event.target === confirmModal) closeConfirm(false);
});
window.addEventListener("keydown", (event) => {
  if (!confirmModal.hidden && event.key === "Escape") closeConfirm(false);
});

deleteBtn.addEventListener("click", async () => {
  const id = getPropertyId();
  if (!id || !loadedProperty) return;
  const who = loadedProperty.customerName || loadedProperty.address || "this customer";
  const linkedNote = loadedLeadCount
    ? ` <strong>${loadedLeadCount}</strong> linked booking${loadedLeadCount === 1 ? "" : "s"} will lose ${loadedLeadCount === 1 ? "its" : "their"} property reference but stay in the CRM.`
    : "";
  const ok = await openConfirm({
    title: "Delete this customer?",
    body: `This permanently removes <strong>${escapeHtml(who)}</strong> and the system profile (zones, valve boxes, notes).${linkedNote} <strong>This cannot be undone.</strong>`,
    expected: "DELETE"
  });
  if (!ok) return;
  try {
    const response = await fetch(`/api/properties/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error((data.errors && data.errors[0]) || `Delete failed (HTTP ${response.status}).`);
    }
    window.location.assign("/admin/properties");
  } catch (err) {
    alert(err.message);
  }
});

// ---- Bootstrap ----------------------------------------------------

async function init() {
  const id = getPropertyId();
  if (!id) {
    propertyLoading.hidden = true;
    propertyError.hidden = false;
    propertyError.textContent = "No property ID in the URL.";
    return;
  }
  try {
    const response = await fetch(`/api/properties/${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error("Not found");
    loadedProperty = data.property;
    loadedLeadCount = (data.leads || []).length;
    propertyLoading.hidden = true;
    propertyForm.hidden = false;
    renderHero(data.property, data.leads || []);
    populateForm(data.property, data.seasonalPricingResolved || null);
    renderLeadsList(data.leads || []);
    renderFieldWoList(data.property);
    renderDeferredRecommendations(data.property);
    renderServiceRecords(data.property);
  } catch (err) {
    propertyLoading.hidden = true;
    propertyError.hidden = false;
  }
}

init();

// ---- Change-owner modal -------------------------------------------
//
// Lets Patrick re-link a property to a different customer when the
// real-world owner changes (sale, inheritance, conflict-ownership
// resolution from lead intake). Customer search hits /api/customers
// once on first open and filters client-side. "+ Create new customer"
// fallback POSTs /api/customer then chains into the transfer call.

(function setupChangeOwnerModal() {
  const btn = document.getElementById("changeOwnerBtn");
  const modal = document.getElementById("transferOwnerModal");
  if (!btn || !modal) return;

  const currentOwnerEl = document.getElementById("transferCurrentOwner");
  const searchEl = document.getElementById("transferSearch");
  const resultsEl = document.getElementById("transferResults");
  const showNewBtn = document.getElementById("transferShowNewBtn");
  const newFields = document.getElementById("transferNewFields");
  const newName = document.getElementById("transferNewName");
  const newEmail = document.getElementById("transferNewEmail");
  const newPhone = document.getElementById("transferNewPhone");
  const selectedEl = document.getElementById("transferSelected");
  const selectedLabel = document.getElementById("transferSelectedLabel");
  const selectedClear = document.getElementById("transferSelectedClear");
  const errorEl = document.getElementById("transferError");
  const cancelBtn = document.getElementById("transferCancel");
  const confirmBtn = document.getElementById("transferConfirm");

  let allCustomers = [];
  let selected = null;       // { id, name, email, mode: "existing" }
  let creatingNew = false;

  function setSelected(value) {
    selected = value;
    if (value) {
      selectedLabel.textContent = `${value.name || "(unnamed)"} ${value.email ? "· " + value.email : ""}`;
      selectedEl.hidden = false;
    } else {
      selectedEl.hidden = true;
    }
    updateConfirm();
  }

  function updateConfirm() {
    let ok = false;
    if (selected) ok = true;
    if (creatingNew && newName.value.trim()) ok = true;
    confirmBtn.disabled = !ok;
    confirmBtn.textContent = "Transfer property" + (selected ? ` to ${selected.name}` : "");
  }

  function renderResults(query) {
    const q = (query || "").trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    const matches = allCustomers.filter((c) => {
      if (selected && c.id === selected.id) return false;
      if (!q) return false;
      const hay = [c.name, c.spouseName, c.email, c.spouseEmail].filter(Boolean).join(" ").toLowerCase();
      if (hay.includes(q)) return true;
      const phoneDigits = String(c.phone || "").replace(/\D/g, "");
      if (qDigits && phoneDigits.includes(qDigits)) return true;
      return false;
    }).slice(0, 10);

    if (!q) {
      resultsEl.innerHTML = "";
      resultsEl.style.display = "none";
      return;
    }
    if (!matches.length) {
      resultsEl.innerHTML = `<div style="padding: 12px; text-align: center; color: var(--crm-muted, #6B6B63); font-size: 13px;">No customers match. Use "Create a new customer" below.</div>`;
      resultsEl.style.display = "block";
      return;
    }
    resultsEl.innerHTML = matches.map((c) => `
      <div class="transfer-result" data-id="${c.id}" style="padding: 8px 12px; border-bottom: 1px solid #f0eee8; cursor: pointer;">
        <strong>${escapeHtml(c.name) || "(unnamed)"}</strong>
        <span style="color: var(--crm-muted, #666); font-size: 12px; margin-left: 8px;">${escapeHtml(c.email) || c.phone || c.id}</span>
      </div>
    `).join("");
    resultsEl.style.display = "block";

    resultsEl.querySelectorAll(".transfer-result").forEach((row) => {
      row.addEventListener("click", () => {
        const id = row.dataset.id;
        const c = allCustomers.find((x) => x.id === id);
        if (!c) return;
        setSelected({ id: c.id, name: c.name, email: c.email, mode: "existing" });
        searchEl.value = "";
        resultsEl.innerHTML = "";
        resultsEl.style.display = "none";
        newFields.hidden = true;
        creatingNew = false;
      });
    });
  }

  async function openModal() {
    if (!loadedProperty) return;
    errorEl.hidden = true;
    searchEl.value = "";
    newName.value = "";
    newEmail.value = "";
    newPhone.value = "";
    newFields.hidden = true;
    creatingNew = false;
    setSelected(null);
    resultsEl.innerHTML = "";
    resultsEl.style.display = "none";
    currentOwnerEl.textContent = loadedProperty.customerName || "(unknown)";
    modal.hidden = false;
    setTimeout(() => searchEl.focus(), 0);
    // Lazy-load customers on first open.
    if (!allCustomers.length) {
      try {
        const res = await fetch("/api/customers", { credentials: "same-origin" });
        const body = await res.json();
        allCustomers = Array.isArray(body.customers) ? body.customers : [];
      } catch (err) {
        console.warn("Failed to load customers for transfer modal:", err);
      }
    }
  }

  function closeModal() { modal.hidden = true; }

  btn.addEventListener("click", openModal);
  cancelBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeModal(); });
  searchEl.addEventListener("input", () => renderResults(searchEl.value));
  selectedClear.addEventListener("click", () => setSelected(null));
  showNewBtn.addEventListener("click", () => {
    newFields.hidden = !newFields.hidden;
    creatingNew = !newFields.hidden;
    if (creatingNew) {
      setSelected(null);
      setTimeout(() => newName.focus(), 0);
    }
    updateConfirm();
  });
  [newName, newEmail, newPhone].forEach((el) => el.addEventListener("input", updateConfirm));

  confirmBtn.addEventListener("click", async () => {
    if (!loadedProperty) return;
    errorEl.hidden = true;
    confirmBtn.disabled = true;
    try {
      let targetCustomerId = selected ? selected.id : null;
      if (creatingNew && !targetCustomerId) {
        const name = newName.value.trim();
        if (!name) throw new Error("Name is required for a new customer.");
        const createRes = await fetch("/api/customer", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            email: newEmail.value.trim(),
            phone: newPhone.value.trim(),
            source: "property_transfer"
          })
        });
        const createBody = await createRes.json();
        if (!createRes.ok || !createBody.ok) {
          if (createBody?.existingId) {
            // Email collision: use the existing customer instead of failing.
            targetCustomerId = createBody.existingId;
          } else {
            throw new Error(createBody?.errors?.[0] || "Couldn't create new customer.");
          }
        } else {
          targetCustomerId = createBody.customer.id;
        }
      }
      if (!targetCustomerId) throw new Error("Pick a customer or fill in the new-customer fields.");

      const transferRes = await fetch(`/api/properties/${encodeURIComponent(loadedProperty.id)}/transfer-owner`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newCustomerId: targetCustomerId, note: "Transferred via /admin/property page" })
      });
      const transferBody = await transferRes.json();
      if (!transferRes.ok || !transferBody.ok) {
        throw new Error(transferBody?.errors?.[0] || "Transfer failed.");
      }

      closeModal();
      // Refresh the page so all sections (hero, form, lead list, etc.)
      // reflect the new owner. Simpler than re-rendering in place.
      location.reload();
    } catch (err) {
      errorEl.textContent = err.message || "Couldn't transfer ownership.";
      errorEl.hidden = false;
      updateConfirm();
    }
  });
})();
