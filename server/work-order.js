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

// Standard zone-check tap-boxes (per spec §4.3.2 walk-through). Order
// here drives the rendered order in the row UI.
const ZONE_CHECK_DEFS = [
  { key: "operated",            label: "Operated" },
  { key: "pressureGood",        label: "Pressure good" },
  { key: "coverageGood",        label: "Coverage good" },
  { key: "noLeaks",             label: "No leaks" },
  { key: "allHeadsFunctional",  label: "All heads functional" }
];

// Issue type catalog — keys map (loosely) to pricing.json categories
// for the Tier-3 quote rollup. Mirrors the tech-mode dropdown.
const ZONE_ISSUE_TYPE_OPTIONS = [
  { value: "broken_head", label: "Broken head" },
  { value: "leak",        label: "Leak" },
  { value: "valve",       label: "Valve" },
  { value: "wire",        label: "Wire" },
  { value: "pipe",        label: "Pipe" },
  { value: "other",       label: "Other" }
];

function makeIssueId() {
  return "iss_" + Math.random().toString(36).slice(2, 10) + "_" + Date.now();
}

// Mirror of SERVICE_CHECKLISTS in server/lib/work-orders.js. Keep in
// sync if step keys change. Spring/fall get a tap-through; service
// visits have no service-specific steps.
const SERVICE_CHECKLISTS_DESKTOP = {
  spring_opening: [
    { key: "water_on",                  label: "Water turned on at main shut-off" },
    { key: "backflow_check",            label: "Backflow visual check" },
    { key: "controller_programmed",     label: "Controller programmed for season" },
    { key: "walkthrough_with_customer", label: "Walk-through with customer (if home)" }
  ],
  fall_closing: [
    { key: "controller_off",            label: "Controller set to off / winter mode" },
    { key: "water_off",                 label: "Water shut off at main" },
    { key: "compressor_connected",      label: "Compressor connected at blow-out" },
    { key: "zones_blown_clear",         label: "All zones blown clear" },
    { key: "compressor_disconnected",   label: "Compressor disconnected" },
    { key: "system_winterized",         label: "System winterized" }
  ],
  service_visit: []
};

let signaturePadInstance = null;

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
  // (status, notes, checks, issues) are read from the form inputs at save time.
  const sprinklerAttr = (zone.sprinklerTypes || []).join(",");
  const coverageAttr  = (zone.coverage       || []).join(",");

  // Standard checks — 5 inline checkboxes. Pre-checked from zone.checks.
  const checks = (zone && zone.checks) || {};
  const checksHtml = ZONE_CHECK_DEFS
    .map((def) => `
      <label class="wo-zone-check">
        <input type="checkbox" data-zone-check="${escapeHtml(def.key)}" ${checks[def.key] ? "checked" : ""}>
        <span>${escapeHtml(def.label)}</span>
      </label>
    `)
    .join("");

  // Issues found — collapsible. Issue count surfaces in the summary so
  // Patrick can scan a long zone list and spot zones with active issues
  // without expanding each block.
  const issues = Array.isArray(zone.issues) ? zone.issues : [];
  const issuesHtml = issues.length
    ? issues.map(issueRowHtml).join("")
    : `<p class="wo-zone-issues-empty">No issues recorded for this zone.</p>`;
  const issueCountTag = issues.length
    ? `<span class="wo-zone-issue-count">${issues.length}</span>`
    : "";

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
      <details class="wo-zone-checks-block">
        <summary>Standard checks</summary>
        <div class="wo-zone-checks-grid">${checksHtml}</div>
      </details>
      <details class="wo-zone-issues-block">
        <summary>Issues found ${issueCountTag}</summary>
        <div class="wo-zone-issues" data-zone-issues>${issuesHtml}</div>
        <button type="button" class="wo-zone-issue-add" data-action="add-issue">+ Add issue</button>
      </details>
    </div>
  `;
}

function issueRowHtml(issue) {
  const optionsHtml = ZONE_ISSUE_TYPE_OPTIONS
    .map((t) => `<option value="${t.value}" ${t.value === issue.type ? "selected" : ""}>${escapeHtml(t.label)}</option>`)
    .join("");
  return `
    <div class="wo-zone-issue" data-issue-id="${escapeHtml(issue.id || makeIssueId())}">
      <select class="wo-zone-issue-type" aria-label="Issue type">${optionsHtml}</select>
      <input type="number" class="wo-zone-issue-qty" min="1" value="${escapeHtml(String(issue.qty || 1))}" aria-label="Quantity">
      <input type="text" class="wo-zone-issue-notes" value="${escapeHtml(issue.notes || "")}" placeholder="Details (optional)" aria-label="Issue notes">
      <button type="button" class="wo-zone-issue-remove" data-action="remove-issue" aria-label="Remove issue">×</button>
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
    return;
  }
  if (event.target.matches('[data-action="add-issue"]')) {
    const row = event.target.closest(".wo-zone-row");
    if (!row) return;
    const container = row.querySelector("[data-zone-issues]");
    if (!container) return;
    // First-add: replace the empty-state message before appending.
    const empty = container.querySelector(".wo-zone-issues-empty");
    if (empty) empty.remove();
    const wrap = document.createElement("div");
    wrap.innerHTML = issueRowHtml({ id: makeIssueId(), type: "broken_head", qty: 1, notes: "" });
    container.appendChild(wrap.firstElementChild);
    return;
  }
  if (event.target.matches('[data-action="remove-issue"]')) {
    const issueRow = event.target.closest(".wo-zone-issue");
    const container = issueRow?.parentElement;
    issueRow?.remove();
    if (container && !container.querySelector(".wo-zone-issue")) {
      // Restore the empty-state when the last issue is removed.
      const empty = document.createElement("p");
      empty.className = "wo-zone-issues-empty";
      empty.textContent = "No issues recorded for this zone.";
      container.appendChild(empty);
    }
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

// AI Intake Guarantee banner — same data as the tech-mode page reads,
// rendered here on the desktop editor so Patrick sees the locked scope
// when reviewing/editing a WO that came from an AI repair quote.
function renderIntakeGuarantee(wo) {
  const banner = document.getElementById("woIntakeGuarantee");
  const scope = document.getElementById("woIntakeScope");
  const source = document.getElementById("woIntakeSource");
  if (!banner) return;
  if (!wo || !wo.intakeGuarantee || wo.intakeGuarantee.applies !== true) {
    banner.hidden = true;
    return;
  }
  if (scope) scope.textContent = wo.intakeGuarantee.scope || "Locked scope";
  if (source) {
    source.textContent = wo.intakeGuarantee.sourceQuoteId
      ? `Source: ${wo.intakeGuarantee.sourceQuoteId}`
      : "";
  }
  banner.hidden = false;
}

function populateForm(wo) {
  woTechNotes.value = wo.techNotes || "";
  renderZones(wo.zones || []);
  renderDiagnosis(wo);
  renderIntakeGuarantee(wo);
  renderServiceChecklist(wo);
  renderSignoff(wo);
  applyLockState(wo.locked === true, wo.signature);
}

// Service-specific checklist (spring_opening / fall_closing only).
// Hidden for service_visit. Each step is a tap-pill that auto-saves
// — the desktop form's Save button will also persist any pending
// changes, but immediate-save matches what the tech sees in tech-mode.
function renderServiceChecklist(wo) {
  const section = document.getElementById("woServiceChecklistSection");
  const list = document.getElementById("woServiceChecklistList");
  const title = document.getElementById("woServiceChecklistTitle");
  if (!section || !list) return;
  const steps = SERVICE_CHECKLISTS_DESKTOP[wo.type] || [];
  if (!steps.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (title) title.textContent = `${TYPE_LABELS[wo.type] || "Service"} checklist`;
  const checklist = (wo.serviceChecklist && typeof wo.serviceChecklist === "object") ? wo.serviceChecklist : {};
  list.innerHTML = steps.map((step) => `
    <button type="button" class="wo-service-step" data-service-step="${escapeHtml(step.key)}" aria-pressed="${checklist[step.key] ? "true" : "false"}">
      <span class="check-tick" aria-hidden="true"></span>
      <span>${escapeHtml(step.label)}</span>
    </button>
  `).join("");
}

document.getElementById("woServiceChecklistList")?.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-service-step]");
  if (!btn || btn.disabled) return;
  if (loadedWorkOrder?.locked) return;
  const key = btn.dataset.serviceStep;
  const checklist = (loadedWorkOrder.serviceChecklist && typeof loadedWorkOrder.serviceChecklist === "object")
    ? { ...loadedWorkOrder.serviceChecklist }
    : {};
  checklist[key] = !checklist[key];
  btn.setAttribute("aria-pressed", checklist[key] ? "true" : "false");
  loadedWorkOrder.serviceChecklist = checklist;
  try {
    const response = await fetch(`/api/work-orders/${encodeURIComponent(getWorkOrderId())}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceChecklist: checklist })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error("Save failed.");
    loadedWorkOrder = data.workOrder;
  } catch (_err) {
    // Roll back on failure so the UI matches the server state.
    checklist[key] = !checklist[key];
    btn.setAttribute("aria-pressed", checklist[key] ? "true" : "false");
    loadedWorkOrder.serviceChecklist = checklist;
  }
});

// Signature pad + sign-off flow ----------------------------------------

function renderSignoff(wo) {
  const form = document.getElementById("woSignoffForm");
  const signed = document.getElementById("woSignoffSigned");
  if (!form || !signed) return;
  const sig = wo && wo.signature;
  if (sig && sig.signed) {
    form.hidden = true;
    signed.hidden = false;
    const img = document.getElementById("woSignoffImage");
    const nameEl = document.getElementById("woSignoffSignedName");
    const atEl = document.getElementById("woSignoffSignedAt");
    if (img && sig.imageData) img.src = sig.imageData;
    if (nameEl) nameEl.textContent = sig.customerName || "—";
    if (atEl && sig.signedAt) atEl.textContent = ` · ${formatDateTime(sig.signedAt)}`;
  } else {
    form.hidden = false;
    signed.hidden = true;
    if (!signaturePadInstance) {
      const canvas = document.getElementById("woSignoffCanvas");
      if (canvas) signaturePadInstance = createWoSignaturePad(canvas, updateWoSignoffSubmitState);
    }
    updateWoSignoffSubmitState();
  }
}

function createWoSignaturePad(canvas, onChange) {
  const ctx = canvas.getContext("2d");
  let drawing = false;
  let dirty = false;

  function fitCanvas() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    const snapshot = canvas.width && dirty ? canvas.toDataURL() : null;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0F1F14";
    ctx.lineWidth = 2.2 * dpr;
    if (snapshot) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.src = snapshot;
    }
  }
  fitCanvas();
  window.addEventListener("resize", fitCanvas);

  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height)
    };
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (loadedWorkOrder?.locked) return;
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!dirty) { dirty = true; if (onChange) onChange(); }
    e.preventDefault();
  });
  const endStroke = (e) => {
    if (!drawing) return;
    drawing = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  canvas.addEventListener("pointerleave", endStroke);

  return {
    isDirty: () => dirty,
    clear: () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      dirty = false;
      if (onChange) onChange();
    },
    toDataURL: () => canvas.toDataURL("image/png")
  };
}

function updateWoSignoffSubmitState() {
  const submit = document.getElementById("woSignoffSubmit");
  if (!submit) return;
  if (loadedWorkOrder?.locked) { submit.disabled = true; return; }
  const name = (document.getElementById("woSignoffName")?.value || "").trim();
  const ack = !!document.getElementById("woSignoffAck")?.checked;
  const drawn = !!(signaturePadInstance && signaturePadInstance.isDirty());
  submit.disabled = !(name && ack && drawn);
}

document.getElementById("woSignoffName")?.addEventListener("input", updateWoSignoffSubmitState);
document.getElementById("woSignoffAck")?.addEventListener("change", updateWoSignoffSubmitState);
document.getElementById("woSignoffClear")?.addEventListener("click", () => {
  if (loadedWorkOrder?.locked) return;
  signaturePadInstance?.clear();
});

document.getElementById("woSignoffSubmit")?.addEventListener("click", async () => {
  if (loadedWorkOrder?.locked) return;
  const submit = document.getElementById("woSignoffSubmit");
  const customerName = (document.getElementById("woSignoffName")?.value || "").trim();
  const ack = !!document.getElementById("woSignoffAck")?.checked;
  if (!customerName || !ack || !signaturePadInstance?.isDirty()) return;
  submit.disabled = true;
  submit.textContent = "Signing…";
  try {
    const imageData = signaturePadInstance.toDataURL();
    const response = await fetch(`/api/work-orders/${encodeURIComponent(getWorkOrderId())}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: { customerName, imageData, acknowledgement: true } })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't save signature.");
    loadedWorkOrder = data.workOrder;
    renderSignoff(data.workOrder);
    applyLockState(data.workOrder.locked === true, data.workOrder.signature);
  } catch (err) {
    submit.disabled = false;
    submit.textContent = "Sign & lock work order";
    alert(err.message || "Couldn't save signature.");
  }
});

// Apply locked / unlocked state to the desktop form. The save and
// delete buttons stay enabled — Patrick is admin-side and can always
// override; the visual cue is the banner + greyed-out form sections.
function applyLockState(locked, signature) {
  document.body.dataset.locked = locked ? "true" : "false";
  const banner = document.getElementById("woLockedBanner");
  const meta = document.getElementById("woLockedMeta");
  if (banner) banner.hidden = !locked;
  if (locked && meta && signature) {
    const parts = [];
    if (signature.customerName) parts.push(`by ${signature.customerName}`);
    if (signature.signedAt) parts.push(formatDateTime(signature.signedAt));
    meta.textContent = parts.length ? `· ${parts.join(" · ")}` : "";
  }
}

function collectForm() {
  const zones = Array.from(woZones.querySelectorAll(".wo-zone-row"))
    .map((row) => {
      // The property snapshot (number, location, sprinkler/coverage) is
      // stored on data-attrs at render time — round-trip those without
      // re-parsing the rendered badges. Status + notes + checks + issues
      // come from the live form inputs.
      const splitCsv = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

      // Standard checks — read each tap-box's checked state into a
      // checks{} map keyed by the data-zone-check attribute.
      const checks = {};
      row.querySelectorAll("[data-zone-check]").forEach((cb) => {
        checks[cb.dataset.zoneCheck] = !!cb.checked;
      });

      // Issues found — read each issue row's type/qty/notes. The id is
      // preserved so the server can dedupe / track audit history.
      const issues = Array.from(row.querySelectorAll(".wo-zone-issue")).map((card) => ({
        id:    card.dataset.issueId || makeIssueId(),
        type:  card.querySelector(".wo-zone-issue-type")?.value || "other",
        qty:   Math.max(1, Math.floor(Number(card.querySelector(".wo-zone-issue-qty")?.value) || 1)),
        notes: (card.querySelector(".wo-zone-issue-notes")?.value || "").trim()
      }));

      return {
        number: Number(row.dataset.number) || 0,
        location: row.dataset.location || "",
        sprinklerTypes: splitCsv(row.dataset.sprinkler),
        coverage:       splitCsv(row.dataset.coverage),
        status: row.querySelector(".wo-zone-status")?.value || "",
        notes:  row.querySelector(".wo-zone-notes")?.value.trim() || "",
        checks,
        issues
      };
    });
  // Service checklist round-trips with the form save too — though
  // taps already persist immediately. This keeps the form Save action
  // the source of truth on submit (in case of rapid taps + save).
  const serviceChecklist = {};
  document.querySelectorAll("#woServiceChecklistList [data-service-step]").forEach((btn) => {
    serviceChecklist[btn.dataset.serviceStep] = btn.getAttribute("aria-pressed") === "true";
  });

  return {
    status: woStatus.value,
    techNotes: woTechNotes.value.trim(),
    zones,
    serviceChecklist
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
    renderCheatSheet(data.workOrder, data.property, data.lastService);
    populateForm(data.workOrder);
  } catch {
    woLoading.hidden = true;
    woError.hidden = false;
  }
}

// Cheat Sheet — desktop mirror of the tech-mode Cheat Sheet. Pulls the
// same data (workOrder + property + lastService) from /api/work-orders/:id
// and renders it as cards above the form. Per spec §4.3.2: rendered first
// when the WO opens, so the reviewer (Patrick on desktop, the tech on
// mobile) gets context before drilling into the form.
function renderCheatSheet(wo, property, lastService) {
  const sheet = document.getElementById("woCheatSheet");
  if (!sheet) return;

  // Action chips
  const phone = wo.customerPhone || "";
  const phoneNormalized = phone.replace(/[^\d+]/g, "");
  const callLink = document.getElementById("woCallLink");
  const textLink = document.getElementById("woTextLink");
  if (phoneNormalized) {
    if (callLink) {
      callLink.href = "tel:" + phoneNormalized;
      const detail = document.getElementById("woCallDetail");
      if (detail) detail.textContent = phone;
      callLink.hidden = false;
    }
    if (textLink) {
      textLink.href = "sms:" + phoneNormalized;
      const detail = document.getElementById("woTextDetail");
      if (detail) detail.textContent = phone;
      textLink.hidden = false;
    }
  }
  const mapsLink = document.getElementById("woMapsLink");
  if (mapsLink && wo.address) {
    mapsLink.href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(wo.address);
    const detail = document.getElementById("woMapsDetail");
    if (detail) detail.textContent = wo.address;
    mapsLink.hidden = false;
  }

  // System overview
  const sysBlock = document.getElementById("woSystemBlock");
  const sys = property && property.system ? property.system : null;
  let sysHasContent = false;
  if (sys) {
    const zoneCount = Array.isArray(sys.zones) ? sys.zones.length : 0;
    const controllerParts = [];
    if (sys.controllerBrand) controllerParts.push(sys.controllerBrand);
    if (sys.controllerLocation) controllerParts.push(sys.controllerLocation);
    setText("woSysZones", zoneCount ? `${zoneCount}` : "—");
    setText("woSysController", controllerParts.join(" · ") || "—");
    setText("woSysShutoff", sys.shutoffLocation || "—");
    setText("woSysBlowout", sys.blowoutLocation || "—");

    const valveBoxes = Array.isArray(sys.valveBoxes) ? sys.valveBoxes : [];
    const vbEl = document.getElementById("woSysValveBoxes");
    if (vbEl) {
      if (valveBoxes.length) {
        const totalValves = valveBoxes.reduce((sum, vb) => sum + (Number(vb.valveCount) || 0), 0);
        const locations = valveBoxes
          .map((vb) => vb.location)
          .filter((loc) => loc && loc.trim())
          .join("; ");
        const valveText = totalValves ? ` (${totalValves} valve${totalValves === 1 ? "" : "s"} total)` : "";
        const locationText = locations ? ` · ${locations}` : "";
        vbEl.textContent = `${valveBoxes.length} valve box${valveBoxes.length === 1 ? "" : "es"}${valveText}${locationText}`;
        vbEl.hidden = false;
      } else {
        vbEl.hidden = true;
      }
    }

    sysHasContent = zoneCount > 0 || controllerParts.length > 0 || sys.shutoffLocation || sys.blowoutLocation || valveBoxes.length > 0;
  }
  if (sysBlock) sysBlock.hidden = !sysHasContent;

  // Property notes
  const accessBlock = document.getElementById("woAccessBlock");
  const accessText = sys && sys.notes ? String(sys.notes).trim() : "";
  if (accessBlock) {
    if (accessText) {
      const notesEl = document.getElementById("woAccessNotes");
      if (notesEl) notesEl.textContent = accessText;
      accessBlock.hidden = false;
    } else {
      accessBlock.hidden = true;
    }
  }

  // Last service summary
  const lastBlock = document.getElementById("woLastServiceBlock");
  if (lastBlock) {
    if (lastService && lastService.completedAt) {
      const typeLabel = TYPE_LABELS[lastService.type] || lastService.type || "Visit";
      const dateLabel = formatDateOnly(lastService.completedAt);
      const noteSnippet = lastService.techNotes ? ` — ${lastService.techNotes}` : "";
      const lastEl = document.getElementById("woLastServiceText");
      if (lastEl) lastEl.textContent = `${typeLabel} · ${dateLabel}${noteSnippet}`;
      lastBlock.hidden = false;
    } else {
      lastBlock.hidden = true;
    }
  }

  const anyVisible = (callLink && !callLink.hidden) ||
                     (textLink && !textLink.hidden) ||
                     (mapsLink && !mapsLink.hidden) ||
                     (sysBlock && !sysBlock.hidden) ||
                     (accessBlock && !accessBlock.hidden) ||
                     (lastBlock && !lastBlock.hidden);
  sheet.hidden = !anyVisible;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function formatDateOnly(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

init();
