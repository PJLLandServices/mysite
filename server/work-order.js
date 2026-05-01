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

// Field Work Order editor. Loads the WO by ID from the URL, renders
// the zone grid (one row per zone snapshotted from the property at
// create time), and saves via PATCH /api/work-orders/:id.
//
// The zone grid is the heart of the page. Each row shows the zone's
// number, location, and structured info, plus a status dropdown
// (Working well / Adjusted / Repair required / Other) and a notes
// field. Repair-required rows highlight so the tech can scan for
// follow-up at a glance.

const woHero = document.getElementById("woHero");
const woId = document.getElementById("woId");
const woTypeLabel = document.getElementById("woTypeLabel");
const woCustomer = document.getElementById("woCustomer");
const woMeta = document.getElementById("woMeta");
const woStatus = document.getElementById("woStatus");
const woLoading = document.getElementById("woLoading");
const woError = document.getElementById("woError");
const woForm = document.getElementById("woForm");
const woDiagnosisSection = document.getElementById("woDiagnosisSection");
const woDiagnosis = document.getElementById("woDiagnosis");
const woZones = document.getElementById("woZones");
const woEmptyZones = document.getElementById("woEmptyZones");
const woTechNotes = document.getElementById("woTechNotes");
const addZoneBtn = document.getElementById("addZoneBtn");
const saveBtn = document.getElementById("saveBtn");
const saveStatus = document.getElementById("saveStatus");
const deleteBtn = document.getElementById("deleteBtn");
const backLink = document.getElementById("backLink");
const techModeBtn = document.getElementById("techModeBtn");
const logoutButton = document.getElementById("logoutButton");

const confirmModal = document.getElementById("confirmModal");
const confirmTitle = document.getElementById("confirmTitle");
const confirmBody = document.getElementById("confirmBody");
const confirmTypedRow = document.getElementById("confirmTypedRow");
const confirmExpected = document.getElementById("confirmExpected");
const confirmInput = document.getElementById("confirmInput");
const confirmError = document.getElementById("confirmError");
const confirmCancel = document.getElementById("confirmCancel");
const confirmAccept = document.getElementById("confirmAccept");

// Same vocabulary as the property editor — used so we can render the
// pills as read-only badges (the WO snapshots the property's zone info
// at create time; editing the system spec belongs on the property
// profile, not here).
const SPRINKLER_LABELS = { rotors: "Rotors", popups: "Pop-ups", drip: "Drip", flower_pots: "Flower Pots" };
const COVERAGE_LABELS  = { plants: "Plants", grass: "Grass", trees: "Trees" };

const ZONE_STATUS_OPTIONS = [
  { value: "",                 label: "— not yet checked —" },
  { value: "working_well",     label: "Working well" },
  { value: "adjusted",         label: "Adjusted" },
  { value: "repair_required",  label: "Repair required" },
  { value: "other",            label: "Other" }
];

const TYPE_LABELS = {
  spring_opening: "Spring Opening",
  fall_closing: "Fall Closing",
  service_visit: "Service Visit"
};

let loadedWorkOrder = null;

// ---- Helpers -------------------------------------------------------

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-CA", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function getWorkOrderId() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  // ["admin", "work-order", "<id>"]
  return parts[2] ? decodeURIComponent(parts[2]) : "";
}

// ---- Zone row rendering -------------------------------------------

function badgeListHtml(values, lookup) {
  if (!values || !values.length) return "";
  return values.map((v) => `<span class="wo-badge">${escapeHtml(lookup[v] || v)}</span>`).join("");
}

function statusOptionsHtml(selected) {
  return ZONE_STATUS_OPTIONS.map((opt) =>
    `<option value="${escapeHtml(opt.value)}" ${opt.value === (selected || "") ? "selected" : ""}>${escapeHtml(opt.label)}</option>`
  ).join("");
}

function zoneRowHtml(zone) {
  const sprinklerBadges = badgeListHtml(zone.sprinklerTypes || [], SPRINKLER_LABELS);
  const coverageBadges  = badgeListHtml(zone.coverage       || [], COVERAGE_LABELS);
  const sysLine = (sprinklerBadges || coverageBadges)
    ? `<div class="wo-zone-system">
         ${sprinklerBadges ? `<div class="wo-zone-sys-row"><span class="wo-zone-sys-label">Sprinkler</span>${sprinklerBadges}</div>` : ""}
         ${coverageBadges  ? `<div class="wo-zone-sys-row"><span class="wo-zone-sys-label">Coverage</span>${coverageBadges}</div>`  : ""}
       </div>`
    : "";
  const status = zone.status || "";
  // Stash the read-only snapshot on data-attrs so collectForm can round-trip
  // the values without re-parsing the rendered badges. Editable fields
  // (status, notes) are read from the form inputs at save time.
  const sprinklerAttr = (zone.sprinklerTypes || []).join(",");
  const coverageAttr  = (zone.coverage       || []).join(",");
  return `
    <div class="wo-zone-row" data-zone data-status="${escapeHtml(status)}" data-number="${escapeHtml(zone.number || "")}" data-location="${escapeHtml(zone.location || "")}" data-sprinkler="${escapeHtml(sprinklerAttr)}" data-coverage="${escapeHtml(coverageAttr)}">
      <div class="wo-zone-head">
        <span class="wo-zone-num">Zone ${escapeHtml(zone.number || "?")}</span>
        <span class="wo-zone-location">${escapeHtml(zone.location || "(unnamed)")}</span>
        <button type="button" class="property-row-remove" data-action="remove-zone" aria-label="Remove zone">×</button>
      </div>
      ${sysLine}
      <div class="wo-zone-controls">
        <label class="wo-zone-status-label">
          <span>Status</span>
          <select class="wo-zone-status">${statusOptionsHtml(status)}</select>
        </label>
        <label class="wo-zone-notes-label">
          <span>Notes</span>
          <input type="text" class="wo-zone-notes" value="${escapeHtml(zone.notes || "")}" placeholder="What did you find / do?">
        </label>
      </div>
    </div>
  `;
}

function renderZones(zones) {
  woZones.innerHTML = "";
  if (!zones.length) {
    woEmptyZones.hidden = false;
    return;
  }
  woEmptyZones.hidden = true;
  zones
    .slice()
    .sort((a, b) => (a.number || 0) - (b.number || 0))
    .forEach((z) => {
      const wrap = document.createElement("div");
      wrap.innerHTML = zoneRowHtml(z);
      woZones.appendChild(wrap.firstElementChild);
    });
}

function nextZoneNumber() {
  let max = 0;
  woZones.querySelectorAll(".wo-zone-num").forEach((el) => {
    const n = Number(String(el.textContent || "").replace(/[^0-9]/g, "")) || 0;
    if (n > max) max = n;
  });
  return max + 1;
}

function addZoneRow(zone) {
  woEmptyZones.hidden = true;
  const seed = zone || { number: nextZoneNumber(), location: "", sprinklerTypes: [], coverage: [], status: "", notes: "" };
  const wrap = document.createElement("div");
  wrap.innerHTML = zoneRowHtml(seed);
  woZones.appendChild(wrap.firstElementChild);
}

// Click + change delegation for the dynamic zone rows.
woZones.addEventListener("click", (event) => {
  if (event.target.matches('[data-action="remove-zone"]')) {
    event.target.closest(".wo-zone-row")?.remove();
    if (!woZones.querySelectorAll(".wo-zone-row").length) woEmptyZones.hidden = false;
  }
});
woZones.addEventListener("change", (event) => {
  if (event.target.matches(".wo-zone-status")) {
    const row = event.target.closest(".wo-zone-row");
    if (row) row.dataset.status = event.target.value;
  }
});
addZoneBtn.addEventListener("click", () => addZoneRow());

// ---- Header + form populate --------------------------------------

function renderHero(wo, property, lead) {
  woHero.hidden = false;
  woId.textContent = wo.id;
  woTypeLabel.textContent = TYPE_LABELS[wo.type] || wo.type;
  const customer = [wo.customerName, wo.customerEmail].filter(Boolean).join(" · ");
  woCustomer.textContent = customer || "Customer details not yet captured";
  const parts = [];
  if (wo.address) parts.push(wo.address);
  if (wo.scheduledFor) parts.push(`scheduled ${formatDateTime(wo.scheduledFor)}`);
  parts.push(`updated ${formatDateTime(wo.updatedAt)}`);
  woMeta.textContent = parts.join(" · ");
  woStatus.value = wo.status || "scheduled";
  if (techModeBtn) techModeBtn.href = `/admin/work-order/${encodeURIComponent(wo.id)}/tech`;

  // Back link points wherever we came from. Prefer the lead detail
  // (deep-links via #lead-<id>) so save → back → keep working in CRM.
  if (lead && lead.id) {
    backLink.href = `/admin#lead-${encodeURIComponent(lead.id)}`;
    backLink.textContent = "← Back to lead";
  } else if (property && property.id) {
    backLink.href = `/admin/property/${encodeURIComponent(property.id)}`;
    backLink.textContent = "← Back to property";
  } else {
    backLink.href = "/admin";
    backLink.textContent = "← CRM";
  }
}

function renderDiagnosis(wo) {
  if (!wo.diagnosis) {
    woDiagnosisSection.hidden = true;
    return;
  }
  woDiagnosisSection.hidden = false;
  woDiagnosis.textContent = typeof wo.diagnosis === "string" ? wo.diagnosis : JSON.stringify(wo.diagnosis, null, 2);
}

function populateForm(wo) {
  woTechNotes.value = wo.techNotes || "";
  renderZones(wo.zones || []);
  renderDiagnosis(wo);
}

function collectForm() {
  const zones = Array.from(woZones.querySelectorAll(".wo-zone-row"))
    .map((row) => {
      // The property snapshot (number, location, sprinkler/coverage) is
      // stored on data-attrs at render time — round-trip those without
      // re-parsing the rendered badges. Status + notes come from the
      // form inputs (the only editable fields on a row).
      const splitCsv = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
      return {
        number: Number(row.dataset.number) || 0,
        location: row.dataset.location || "",
        sprinklerTypes: splitCsv(row.dataset.sprinkler),
        coverage:       splitCsv(row.dataset.coverage),
        status: row.querySelector(".wo-zone-status")?.value || "",
        notes:  row.querySelector(".wo-zone-notes")?.value.trim() || ""
      };
    });
  return {
    status: woStatus.value,
    techNotes: woTechNotes.value.trim(),
    zones
  };
}

// ---- Save / delete -----------------------------------------------

woForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = getWorkOrderId();
  if (!id) return;
  saveBtn.disabled = true;
  saveStatus.textContent = "Saving…";
  try {
    const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectForm())
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Save failed."]).join(" "));
    saveStatus.textContent = "Saved";
    setTimeout(() => { saveStatus.textContent = ""; }, 2000);
    loadedWorkOrder = data.workOrder;
    populateForm(data.workOrder);
  } catch (err) {
    saveStatus.textContent = err.message || "Couldn't save.";
  } finally {
    saveBtn.disabled = false;
  }
});

// Status dropdown auto-saves on change so Patrick can flip "scheduled"
// → "on_site" → "completed" without hitting Save. The zone grid still
// requires explicit save (it's where most edits happen and we don't
// want to write on every keystroke).
woStatus.addEventListener("change", async () => {
  const id = getWorkOrderId();
  if (!id) return;
  try {
    const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: woStatus.value })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Status update failed."]).join(" "));
    saveStatus.textContent = "Status saved";
    setTimeout(() => { saveStatus.textContent = ""; }, 1500);
  } catch (err) {
    saveStatus.textContent = err.message || "Couldn't save status.";
  }
});

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.assign("/login");
});

// ---- Confirm modal (typed-DELETE 2FA) ---------------------------

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
  const id = getWorkOrderId();
  if (!id || !loadedWorkOrder) return;
  const ok = await openConfirm({
    title: "Delete work order?",
    body: `This permanently removes <strong>${escapeHtml(loadedWorkOrder.id)}</strong> and every per-zone status/note on it. <strong>This cannot be undone.</strong>`,
    expected: "DELETE"
  });
  if (!ok) return;
  try {
    const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error((data.errors && data.errors[0]) || `Delete failed (HTTP ${response.status}).`);
    }
    window.location.assign(backLink.href);
  } catch (err) {
    alert(err.message);
  }
});

// ---- Bootstrap ---------------------------------------------------

async function init() {
  const id = getWorkOrderId();
  if (!id) {
    woLoading.hidden = true;
    woError.hidden = false;
    woError.textContent = "No work-order ID in the URL.";
    return;
  }
  try {
    const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error("Not found");
    loadedWorkOrder = data.workOrder;
    woLoading.hidden = true;
    woForm.hidden = false;
    renderHero(data.workOrder, data.property, data.lead);
    populateForm(data.workOrder);
  } catch {
    woLoading.hidden = true;
    woError.hidden = false;
  }
}

init();
