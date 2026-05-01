// Property profile editor. Loads the property by ID from the URL,
// renders the form, lets Patrick edit zones / valve boxes / system info,
// saves via PATCH /api/properties/:id.

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

// Build a single zone row. Using template literals + innerHTML rather
// than a heavyweight component framework — simpler, faster, fits the
// rest of the admin's vanilla-JS conventions.
function zoneRowHtml(zone) {
  return `
    <div class="property-zone-row" data-zone>
      <input type="number" class="zone-number" min="1" max="99" value="${escapeHtml(zone.number)}" placeholder="#">
      <input type="text" class="zone-label" value="${escapeHtml(zone.label || "")}" placeholder="Front lawn — north strip">
      <input type="text" class="zone-notes" value="${escapeHtml(zone.notes || "")}" placeholder="Notes (sprays mixed with rotors, etc.)">
      <button type="button" class="property-row-remove" data-action="remove-zone" aria-label="Remove zone">×</button>
    </div>
  `;
}

function valveBoxRowHtml(box) {
  return `
    <div class="property-valvebox-row" data-valvebox>
      <input type="text" class="vb-location" value="${escapeHtml(box.location || "")}" placeholder="Location (e.g. front-right corner of garden)">
      <input type="number" class="vb-count" min="1" max="20" value="${escapeHtml(box.valveCount || 1)}" placeholder="#">
      <input type="text" class="vb-notes" value="${escapeHtml(box.notes || "")}" placeholder="Notes (zone numbers, hard to find, etc.)">
      <button type="button" class="property-row-remove" data-action="remove-valvebox" aria-label="Remove valve box">×</button>
    </div>
  `;
}

function renderZones(zones) {
  zonesList.innerHTML = "";
  if (!zones.length) {
    addZoneRow({ number: 1, label: "", notes: "" });
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

function addZoneRow(zone = { number: nextZoneNumber(), label: "", notes: "" }) {
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

// Click delegation for the dynamic rows' remove buttons.
zonesList.addEventListener("click", (event) => {
  if (event.target.matches('[data-action="remove-zone"]')) {
    event.target.closest(".property-zone-row")?.remove();
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
  propertyMeta.textContent = `${phone} · created ${formatDate(property.createdAt)}`;
  leadCount.textContent = leads.length;
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
    .map((row) => ({
      number: Number(row.querySelector(".zone-number").value) || 0,
      label: row.querySelector(".zone-label").value.trim(),
      notes: row.querySelector(".zone-notes").value.trim()
    }))
    .filter((z) => z.number || z.label);

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
  } catch (err) {
    propertyLoading.hidden = true;
    propertyError.hidden = false;
  }
}

init();
