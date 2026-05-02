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
  { value: "trees", label: "Trees" }
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
  const customer = [property.customerName, property.customerEmail].filter(Boolean).join(" · ");
  propertyCustomer.textContent = customer || "Customer details not yet captured";
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

function renderDeferredRecommendations(property) {
  const section = document.getElementById("deferredSection");
  const list = document.getElementById("deferredList");
  const countEl = document.getElementById("deferredCount");
  if (!section || !list) return;
  const items = (property.deferredIssues || []).filter((d) => d && d.status !== "resolved" && d.status !== "dismissed");
  if (!items.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (countEl) countEl.textContent = String(items.length);
  list.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "property-deferred__item";
    const typeLabel = DEFERRED_TYPE_LABELS[item.type] || item.type || "Issue";
    const declinedDate = item.declinedAt
      ? new Date(item.declinedAt).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })
      : "—";
    const woLink = item.fromWoId
      ? `<a href="/admin/work-order/${encodeURIComponent(item.fromWoId)}" class="property-deferred__source">${item.fromWoId}</a>`
      : "";
    const zoneTag = Number.isFinite(Number(item.fromZone)) ? `· Zone ${item.fromZone}` : "";
    const priceLine = item.suggestedPriceSnapshot && Number.isFinite(Number(item.suggestedPriceSnapshot.unitPrice))
      ? `<p class="property-deferred__price">Snapshot: ${item.suggestedPriceSnapshot.qty || 1}× ${escapeHtml(item.suggestedPriceSnapshot.label || typeLabel)} @ $${Number(item.suggestedPriceSnapshot.unitPrice).toFixed(2)}</p>`
      : "";
    const photoChips = Array.isArray(item.photoIds) && item.photoIds.length && item.fromWoId
      ? `<div class="property-deferred__photos">${item.photoIds.map((n) => `<a href="/api/work-orders/${encodeURIComponent(item.fromWoId)}/photo/${encodeURIComponent(n)}" target="_blank" rel="noopener">📷 ${escapeHtml(String(n))}</a>`).join("")}</div>`
      : "";
    li.innerHTML = `
      <div class="property-deferred__head">
        <strong>${escapeHtml(typeLabel)}</strong>
        <span class="property-deferred__qty">qty ${escapeHtml(String(item.qty || 1))}</span>
      </div>
      <p class="property-deferred__meta">Declined ${escapeHtml(declinedDate)} ${zoneTag} ${woLink ? "· from " + woLink : ""}</p>
      ${item.notes ? `<p class="property-deferred__notes">${escapeHtml(item.notes)}</p>` : ""}
      ${priceLine}
      ${photoChips}
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

async function createFieldWoFromButton(type) {
  if (!loadedProperty) return;
  const button = document.querySelector(`[data-create-wo="${type}"]`);
  if (button) button.disabled = true;
  try {
    const response = await fetch("/api/work-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, propertyId: loadedProperty.id })
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

function populateForm(property) {
  propertyForm.elements.customerName.value = property.customerName || "";
  propertyForm.elements.customerPhone.value = property.customerPhone || "";
  propertyForm.elements.address.value = property.address || "";
  const sys = property.system || {};
  propertyForm.elements.controllerLocation.value = sys.controllerLocation || "";
  propertyForm.elements.controllerBrand.value = sys.controllerBrand || "";
  propertyForm.elements.shutoffLocation.value = sys.shutoffLocation || "";
  propertyForm.elements.blowoutLocation.value = sys.blowoutLocation || "";
  propertyForm.elements.notes.value = sys.notes || "";
  renderZones(sys.zones || []);
  renderValveBoxes(sys.valveBoxes || []);
}

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

  return {
    customerName: propertyForm.elements.customerName.value.trim(),
    customerPhone: propertyForm.elements.customerPhone.value.trim(),
    address: propertyForm.elements.address.value.trim(),
    system: {
      controllerLocation: propertyForm.elements.controllerLocation.value.trim(),
      controllerBrand: propertyForm.elements.controllerBrand.value.trim(),
      shutoffLocation: propertyForm.elements.shutoffLocation.value.trim(),
      blowoutLocation: propertyForm.elements.blowoutLocation.value.trim(),
      notes: propertyForm.elements.notes.value.trim(),
      zones,
      valveBoxes
    }
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
    // Reflect anything the server normalized (e.g. addressNormalized).
    populateForm(data.property);
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
    populateForm(data.property);
    renderLeadsList(data.leads || []);
    renderFieldWoList(data.property);
    renderDeferredRecommendations(data.property);
  } catch (err) {
    propertyLoading.hidden = true;
    propertyError.hidden = false;
  }
}

init();
