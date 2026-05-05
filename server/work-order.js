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
const woRescheduleBtn = document.getElementById("woRescheduleBtn");
const woFollowupBtn = document.getElementById("woFollowupBtn");
const woBookingActivity = document.getElementById("woBookingActivity");
const woBookingActivityList = document.getElementById("woBookingActivityList");
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
// for the Tier-3 quote rollup. Mirrors ZONE_ISSUE_TYPE_OPTIONS in
// server/work-order-tech.js — KEEP IN SYNC.
const ZONE_ISSUE_TYPE_OPTIONS = [
  { value: "broken_head", label: "Sprinkler head" },
  { value: "leak",        label: "Leak" },
  { value: "valve",       label: "Valve" },
  { value: "wire",        label: "Wire" },
  { value: "pipe",        label: "Pipe" },
  { value: "controller",  label: "Controller" },
  { value: "other",       label: "Other" }
];

// Cascading sub-type options. Mirrors ZONE_ISSUE_SUBTYPE_OPTIONS in
// server/work-order-tech.js — KEEP IN SYNC.
const ZONE_ISSUE_SUBTYPE_OPTIONS = {
  broken_head: [
    { value: "",             label: "— Select head model —" },
    { value: "pgp_4",        label: "Hunter PGP (4\")" },
    { value: "pgp_6",        label: "Hunter PGP (6\")" },
    { value: "pgp_12",       label: "Hunter PGP (12\")" },
    { value: "prospray_4",   label: "Hunter Pro-Spray (4\")" },
    { value: "prospray_6",   label: "Hunter Pro-Spray (6\")" },
    { value: "prospray_12",  label: "Hunter Pro-Spray (12\" mulch)" },
    { value: "i20",          label: "Hunter I-20 rotor" },
    { value: "mp_rotator",   label: "MP Rotator" },
    { value: "drip",         label: "Drip emitter" },
    { value: "other",        label: "Other head — see notes" }
  ],
  valve: [
    { value: "",             label: "— Select valve fix —" },
    { value: "pgv_full",     label: "Hunter PGV valve replacement + manifold rebuild" },
    { value: "solenoid",     label: "Solenoid only" },
    { value: "diaphragm",    label: "Diaphragm rebuild" },
    { value: "other",        label: "Other valve fix — see notes" }
  ],
  wire: [
    { value: "",             label: "— Select wire issue —" },
    { value: "cut",          label: "Control wire cut" },
    { value: "removed",      label: "Control wire removed" },
    { value: "no_comms",     label: "Control wire not communicating with controller" },
    { value: "splice",       label: "Splice failure / waterlogged connector" },
    { value: "other",        label: "Other wire issue — see notes" }
  ],
  pipe: [
    { value: "",             label: "— Select pipe size —" },
    { value: "poly_1",       label: "1\" HDPE poly pipe break" },
    { value: "poly_3_4",     label: "3/4\" HDPE poly pipe break" },
    { value: "funny",        label: "1/2\" funny pipe break" },
    { value: "other",        label: "Other pipe break — see notes" }
  ],
  controller: [
    { value: "",             label: "— Select controller fix —" },
    { value: "hpc_4",        label: "4-zone Hydrawise controller replaced" },
    { value: "hpc_8",        label: "8-zone Hydrawise controller replaced" },
    { value: "hpc_16",       label: "16-zone Hydrawise controller replaced" },
    { value: "module",       label: "Zone-expansion module added" },
    { value: "rain_sensor",  label: "Rain sensor added" },
    { value: "other",        label: "Other controller fix — see notes" }
  ],
  leak:  [],
  other: []
};

function makeIssueId() {
  return "iss_" + Math.random().toString(36).slice(2, 10) + "_" + Date.now();
}

// Mirror of SERVICE_CHECKLISTS in server/lib/work-orders.js. Keep in
// sync if step keys change. Spring/fall get a tap-through; service
// visits have no service-specific steps.
//
// Backflow intentionally NOT in this list — PJL is not a certified
// Ontario backflow tester (memory/backflow_not_certified.md).
const SERVICE_CHECKLISTS_DESKTOP = {
  spring_opening: [
    { key: "water_on",                  label: "Water turned on at main shut-off" },
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

// ---- Photo helpers (mirror work-order-tech.js) -----------------------

let _cachedGeo = undefined;
async function getCurrentGeo() {
  if (_cachedGeo !== undefined) return _cachedGeo;
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
    _cachedGeo = null;
    return null;
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        _cachedGeo = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        };
        resolve(_cachedGeo);
      },
      () => { _cachedGeo = null; resolve(null); },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 }
    );
  });
}

function applyPjlWatermark(canvas, ctx, lines) {
  const visible = lines.filter(Boolean);
  if (!visible.length) return;
  const w = canvas.width;
  const h = canvas.height;
  const fontSize = Math.max(14, Math.round(h * 0.024));
  const padding = Math.round(fontSize * 0.6);
  const lineH = Math.round(fontSize * 1.3);
  const stripH = lineH * visible.length + padding * 2;
  ctx.font = `600 ${fontSize}px sans-serif`;
  ctx.textBaseline = "top";
  let maxText = 0;
  visible.forEach((l) => { maxText = Math.max(maxText, ctx.measureText(l).width); });
  const stripW = Math.min(Math.round(maxText + padding * 2), Math.round(w * 0.7));
  const stripX = w - stripW;
  const stripY = h - stripH;
  ctx.fillStyle = "rgba(15, 31, 20, 0.78)";
  ctx.fillRect(stripX, stripY, stripW, stripH);
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  visible.forEach((line, i) => {
    ctx.fillText(line, stripX + padding, stripY + padding + i * lineH);
  });
}

function formatStamp(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatGeoStamp(geo) {
  if (!geo) return "";
  const ns = geo.lat >= 0 ? "N" : "S";
  const ew = geo.lng >= 0 ? "E" : "W";
  return `${Math.abs(geo.lat).toFixed(4)}°${ns}, ${Math.abs(geo.lng).toFixed(4)}°${ew}`;
}

async function processPhotoForUpload(file, opts = {}) {
  const geo = opts.geo;
  const takenAt = opts.takenAt || new Date();
  const watermarkLines = [
    `PJL · ${formatStamp(takenAt)}`,
    formatGeoStamp(geo),
    [opts.woId, opts.seqLabel].filter(Boolean).join(" · ")
  ];
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Couldn't decode that image."));
      img.onload = () => {
        const longest = Math.max(img.width, img.height);
        const scale = longest > 1280 ? 1280 / longest : 1;
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        applyPjlWatermark(canvas, ctx, watermarkLines);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        resolve({ base64: dataUrl.split(",", 2)[1] || "", mediaType: "image/jpeg" });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function uploadWoPhotos(files, meta = {}) {
  const arr = Array.from(files || []);
  if (!arr.length) return null;
  const geo = await getCurrentGeo();
  const id = getWorkOrderId();
  const photos = [];
  const existingCount = (loadedWorkOrder?.photos || []).length;
  let seq = 0;
  for (const f of arr) {
    if (!f.type || !f.type.startsWith("image/")) continue;
    seq += 1;
    const takenAt = new Date();
    const seqLabel = `#${existingCount + seq}`;
    const processed = await processPhotoForUpload(f, {
      geo,
      takenAt,
      woId: id,
      seqLabel
    });
    photos.push({
      data: processed.base64,
      mediaType: processed.mediaType,
      geo: geo || null,
      takenAt: takenAt.toISOString(),
      ...meta
    });
  }
  if (!photos.length) return null;
  const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photos })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error((data.errors && data.errors[0]) || "Couldn't upload photo.");
  }
  return data.workOrder;
}

// Bulk-save every photo on the WO to the local device. Web Share API
// where supported (single share-sheet popup with all files), download
// fallback elsewhere. Mirrors tech-mode's saveAllPhotosToDevice.
async function saveAllWoPhotosToDevice() {
  const photos = loadedWorkOrder?.photos || [];
  if (!photos.length) return;
  const btn = document.getElementById("woPhotoSaveAll");
  if (btn) { btn.disabled = true; btn.classList.add("is-saving"); }
  try {
    const id = getWorkOrderId();
    const files = await Promise.all(photos.map(async (p) => {
      const resp = await fetch(`/api/work-orders/${encodeURIComponent(id)}/photo/${p.n}`, { cache: "force-cache" });
      const blob = await resp.blob();
      const filename = p.filename || `pjl-photo-${p.n}.jpg`;
      return new File([blob], filename, { type: blob.type || "image/jpeg" });
    }));
    if (navigator.canShare && navigator.canShare({ files })) {
      try {
        await navigator.share({ files, title: `PJL ${id} photos` });
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return;
      }
    }
    for (const file of files) {
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 500);
    }
  } catch (err) {
    alert(err.message || "Couldn't save photos.");
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove("is-saving"); }
  }
}

document.getElementById("woPhotoSaveAll")?.addEventListener("click", saveAllWoPhotosToDevice);

async function deleteWoPhoto(n) {
  const id = getWorkOrderId();
  const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}/photos/${n}`, {
    method: "DELETE"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error((data.errors && data.errors[0]) || "Couldn't delete photo.");
  }
  return data.workOrder;
}

function woPhotoUrl(n) {
  const id = getWorkOrderId();
  return `/api/work-orders/${encodeURIComponent(id)}/photo/${n}`;
}

function photoThumbHtml(photo) {
  return `
    <div class="wo-photo-thumb" data-photo-n="${escapeHtml(String(photo.n))}">
      <img src="${escapeHtml(woPhotoUrl(photo.n))}" alt="${escapeHtml(photo.label || ("Photo " + photo.n))}" loading="lazy">
      <button type="button" class="wo-photo-thumb-remove" data-action="delete-photo" aria-label="Remove photo">×</button>
    </div>
  `;
}

const TYPE_LABELS = {
  spring_opening: "Spring Opening",
  fall_closing: "Fall Closing",
  service_visit: "Service Visit"
};

let loadedWorkOrder = null;
// Property record for the WO's linked customer. Stashed on init so the
// zone-location datalist can offer the customer's actual zones /
// valve boxes / controller / open issues as autocomplete suggestions,
// and so we can auto-populate notes from the property when the WO zone
// notes are empty.
let loadedProperty = null;

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

// Renders the badge text shown on the zone-row trigger button. Property
// zones get "Zone N"; other source kinds get a 2-3 letter abbreviation
// since they don't have a meaningful zone number ("VB" for valve box,
// "CTL" for controller, "ISS" for an open issue). Custom typed labels
// fall back to the existing zone number ("Zone N") since the user
// explicitly chose a number when adding the row.
function zoneBadgeLabel(zone) {
  switch (zone?.kind) {
    case "valveBox":   return "VB";
    case "controller": return "CTL";
    case "issue":      return "ISS";
    case "zone":
    case "custom":
    default:           return `Zone ${zone?.number || "?"}`;
  }
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
    <div class="wo-zone-row" data-zone data-status="${escapeHtml(status)}" data-number="${escapeHtml(zone.number || "")}" data-location="${escapeHtml(zone.location || "")}" data-kind="${escapeHtml(zone.kind || "zone")}" data-sprinkler="${escapeHtml(sprinklerAttr)}" data-coverage="${escapeHtml(coverageAttr)}">
      <div class="wo-zone-head">
        <button type="button" class="wo-zone-num" data-action="open-zone-picker" aria-haspopup="listbox" aria-expanded="false" aria-label="Pick zone source">${escapeHtml(zoneBadgeLabel(zone))}</button>
        <input type="text" class="wo-zone-location" value="${escapeHtml(zone.location || "")}" placeholder="Description (auto-fills from property pick or type custom)" maxlength="200" autocomplete="off">
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
          <input type="text" class="wo-zone-notes" value="${escapeHtml(zone.notes || "")}" placeholder="What did you find / do?" data-voice-input>
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
  const subOpts = ZONE_ISSUE_SUBTYPE_OPTIONS[issue.type] || [];
  const subtypeOptionsHtml = subOpts
    .map((s) => `<option value="${escapeHtml(s.value)}" ${s.value === (issue.subtype || "") ? "selected" : ""}>${escapeHtml(s.label)}</option>`)
    .join("");
  const subtypeHidden = subOpts.length === 0 ? "hidden" : "";
  const safeId = issue.id || makeIssueId();
  const issuePhotos = (loadedWorkOrder?.photos || []).filter((p) => p.issueId === safeId);
  const thumbsHtml = issuePhotos.map(photoThumbHtml).join("");
  return `
    <div class="wo-zone-issue" data-issue-id="${escapeHtml(safeId)}">
      <select class="wo-zone-issue-type" aria-label="Issue type">${optionsHtml}</select>
      <select class="wo-zone-issue-subtype" aria-label="Specific item" ${subtypeHidden}>${subtypeOptionsHtml}</select>
      <input type="number" class="wo-zone-issue-qty" min="1" value="${escapeHtml(String(issue.qty || 1))}" aria-label="Quantity">
      <input type="text" class="wo-zone-issue-notes" value="${escapeHtml(issue.notes || "")}" placeholder="Notes (optional)" aria-label="Issue notes">
      <button type="button" class="wo-zone-issue-remove" data-action="remove-issue" aria-label="Remove issue">×</button>
      <div class="wo-issue-photos" data-issue-photos="${escapeHtml(safeId)}">
        ${thumbsHtml}
        <label class="wo-issue-photo-add">
          <input type="file" accept="image/*" data-action="upload-issue-photo" data-issue-id="${escapeHtml(safeId)}" multiple hidden>
          <span aria-hidden="true">📷</span>
          <span>Add photo</span>
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
woZones.addEventListener("click", async (event) => {
  if (event.target.matches('[data-action="remove-zone"]')) {
    event.target.closest(".wo-zone-row")?.remove();
    if (!woZones.querySelectorAll(".wo-zone-row").length) woEmptyZones.hidden = false;
    return;
  }
  if (event.target.matches('[data-action="delete-photo"]')) {
    const thumb = event.target.closest(".wo-photo-thumb");
    if (!thumb) return;
    if (!confirm("Remove this photo?")) return;
    const n = Number(thumb.dataset.photoN);
    try {
      const wo = await deleteWoPhoto(n);
      loadedWorkOrder = wo;
      // Refresh all photo surfaces — both WO-level strip and any
      // matching issue photo strip.
      renderWoPhotos(wo);
      const issuePhotos = thumb.closest("[data-issue-photos]");
      if (issuePhotos) {
        const issueId = issuePhotos.dataset.issuePhotos;
        renderIssuePhotosInline(issuePhotos, issueId);
      }
    } catch (err) { alert(err.message); }
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
woZones.addEventListener("change", async (event) => {
  if (event.target.matches(".wo-zone-status")) {
    const row = event.target.closest(".wo-zone-row");
    if (row) row.dataset.status = event.target.value;
    return;
  }
  // Cascading subtype: when the type select changes, swap the subtype
  // <select>'s options to match the new type's preset list. Resets the
  // subtype value so leftover options from the old type don't persist.
  if (event.target.matches(".wo-zone-issue-type")) {
    const card = event.target.closest(".wo-zone-issue");
    const subSel = card?.querySelector(".wo-zone-issue-subtype");
    if (subSel) {
      const opts = ZONE_ISSUE_SUBTYPE_OPTIONS[event.target.value] || [];
      subSel.innerHTML = opts.map((s) => `<option value="${s.value}">${s.label.replace(/</g, "&lt;")}</option>`).join("");
      subSel.hidden = opts.length === 0;
    }
    return;
  }
  if (event.target.matches('[data-action="upload-issue-photo"]')) {
    const input = event.target;
    const issueId = input.dataset.issueId;
    const row = input.closest(".wo-zone-row");
    const zoneNumber = Number(row?.dataset.number) || null;
    if (!input.files || !input.files.length) return;
    const label = input.closest(".wo-issue-photo-add");
    if (label) label.classList.add("is-uploading");
    try {
      const wo = await uploadWoPhotos(input.files, { category: "issue", issueId, zoneNumber });
      if (wo) {
        loadedWorkOrder = wo;
        renderWoPhotos(wo);
        const host = row.querySelector(`[data-issue-photos="${CSS.escape(issueId)}"]`);
        if (host) renderIssuePhotosInline(host, issueId);
      }
    } catch (err) { alert(err.message); }
    finally {
      if (label) label.classList.remove("is-uploading");
      input.value = "";
    }
  }
});

// Re-render an issue's photo strip after upload/delete. Reads from the
// live loadedWorkOrder.photos so it stays in sync without re-rendering
// the full zone row (preserves focus on adjacent inputs).
function renderIssuePhotosInline(host, issueId) {
  if (!host) return;
  const photos = (loadedWorkOrder?.photos || []).filter((p) => p.issueId === issueId);
  const thumbsHtml = photos.map(photoThumbHtml).join("");
  host.innerHTML = `
    ${thumbsHtml}
    <label class="wo-issue-photo-add">
      <input type="file" accept="image/*" data-action="upload-issue-photo" data-issue-id="${escapeHtml(issueId)}" multiple hidden>
      <span aria-hidden="true">📷</span>
      <span>Add photo</span>
    </label>
  `;
}
addZoneBtn.addEventListener("click", () => addZoneRow());

// ---- Header + form populate --------------------------------------

function renderHero(wo, property, lead) {
  woHero.hidden = false;
  woId.textContent = wo.id;
  woTypeLabel.textContent = TYPE_LABELS[wo.type] || wo.type;
  // Property code (P-YYYY-NNNN) — small identification badge below the
  // WO id. Hidden when no linked property.
  const codeEl = document.getElementById("woPropertyCode");
  if (codeEl) {
    if (property && property.code) {
      codeEl.textContent = property.code;
      codeEl.hidden = false;
    } else {
      codeEl.hidden = true;
    }
  }
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

// Surface booking-level history (reschedules, status moves) on the WO
// page. Pulls /api/bookings?leadId=<wo.leadId>, takes the first matching
// record, and renders the last few history entries above the form.
// Hidden when there's no canonical booking yet (legacy leads).
async function renderBookingActivity(wo, lead) {
  if (!woBookingActivity || !woBookingActivityList) return;
  if (!wo || !wo.leadId) return;

  // Show / hide the Reschedule button depending on WO state. We hide it
  // when the tech is already on-site (arrivedAt set) or when the WO is
  // beyond scheduled-status (server will reject anyway, but the UI cue
  // matches). Cancelled/completed: also hidden.
  let canReschedule = !wo.arrivedAt && !["completed", "cancelled"].includes(wo.status);
  let bookingForButton = null;

  try {
    const r = await fetch(`/api/bookings?leadId=${encodeURIComponent(wo.leadId)}`);
    const data = await r.json();
    const recs = (data && data.ok && Array.isArray(data.bookings)) ? data.bookings : [];
    // A lead can have multiple bookings (original + follow-ups). Show
    // the one tied to THIS WO if it exists; otherwise fall back to the
    // first non-terminal record on the lead.
    const tiedToThisWo = recs.find((b) => Array.isArray(b.workOrderIds) && b.workOrderIds.includes(wo.id));
    const live = tiedToThisWo
      || recs.find((b) => b.status !== "cancelled" && b.status !== "completed" && b.status !== "no_show")
      || recs[0];
    if (!live) {
      woBookingActivity.hidden = true;
    } else {
      bookingForButton = live;
      const history = Array.isArray(live.history) ? live.history.slice().reverse() : [];
      const reschedules = history.filter((h) => h.action === "rescheduled" || h.action.startsWith("status:"));
      if (!reschedules.length) {
        woBookingActivity.hidden = true;
      } else {
        woBookingActivity.hidden = false;
        woBookingActivityList.innerHTML = "";
        reschedules.slice(0, 6).forEach((h) => {
          const li = document.createElement("li");
          const when = new Date(h.ts).toLocaleString("en-CA", {
            month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
          });
          const action = h.action === "rescheduled" ? "Rescheduled" : h.action.replace(/^status:/, "Status → ");
          li.innerHTML = `<strong>${escapeHtml(when)}</strong> · ${escapeHtml(action)}${h.note ? ` <span class="wo-booking-activity-note">${escapeHtml(h.note)}</span>` : ""}`;
          woBookingActivityList.appendChild(li);
        });
      }
    }
  } catch {
    woBookingActivity.hidden = true;
  }

  if (woRescheduleBtn) {
    if (canReschedule && bookingForButton) {
      woRescheduleBtn.hidden = false;
      woRescheduleBtn.onclick = () => {
        if (typeof window.openCrmReschedule !== "function") return;
        window.openCrmReschedule({
          bookingId: bookingForButton.id,
          onDone: () => {
            // Reload the WO so scheduledFor + activity refresh.
            window.location.reload();
          }
        });
      };
    } else {
      woRescheduleBtn.hidden = true;
    }
  }

  // Follow-up scheduling — visible on completed visits OR active visits
  // where the tech has identified parts that need to come back. Hidden
  // on cancelled WOs. The modal handles the rest (date+time, parts,
  // notes, two submit buttons).
  if (woFollowupBtn) {
    const showFollowup = wo.status !== "cancelled";
    if (showFollowup) {
      woFollowupBtn.hidden = false;
      woFollowupBtn.onclick = () => {
        if (typeof window.openCrmFollowup !== "function") return;
        const inheritedSkus = (wo.onSiteQuote?.builderLineItems || [])
          .map((li) => li?.source?.partSku || li?.source?.sku || li?.sku || "")
          .filter(Boolean);
        window.openCrmFollowup({
          workOrderId: wo.id,
          parentAddress: wo.address || "",
          parentSkus: inheritedSkus,
          onDone: (data) => {
            // Open the new follow-up WO in a new tab so Patrick can
            // review it while staying on the current visit's page.
            if (data?.followupWoId) {
              window.open(`/admin/work-order/${encodeURIComponent(data.followupWoId)}`, "_blank", "noopener");
            }
          }
        });
      };
    } else {
      woFollowupBtn.hidden = true;
    }
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

// AI-Correct-Diagnosis Bonus banner — same data as the tech-mode page
// reads, rendered here on the desktop editor so Patrick sees the diagnosed
// scope (and pending-bonus state) when reviewing/editing a WO that came
// from an AI repair quote.
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
  renderWoPhotos(wo);
  renderSignoff(wo);
  applyLockState(wo.locked === true, wo.signature);
}

// WO-level photo gallery — anything not tied to a specific issue.
function renderWoPhotos(wo) {
  const strip = document.getElementById("woPhotoStrip");
  const count = document.getElementById("woPhotoCount");
  const saveAll = document.getElementById("woPhotoSaveAll");
  if (!strip) return;
  const woLevel = (wo.photos || []).filter((p) => !p.issueId);
  if (count) count.textContent = String(woLevel.length);
  strip.innerHTML = woLevel.map(photoThumbHtml).join("");
  // Save-all visible whenever the WO has any photos (zone-attached or not).
  if (saveAll) saveAll.hidden = !((wo.photos || []).length);
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

// WO-level photo upload + lightbox (for both WO-level and per-issue
// thumbnails). Wired here at module level so they bind once at load.
document.getElementById("woPhotoInput")?.addEventListener("change", async (event) => {
  const input = event.target;
  if (!input.files || !input.files.length) return;
  const label = input.closest(".wo-photo-add");
  if (label) label.classList.add("is-uploading");
  try {
    const wo = await uploadWoPhotos(input.files, { category: "general" });
    if (wo) {
      loadedWorkOrder = wo;
      renderWoPhotos(wo);
    }
  } catch (err) {
    alert(err.message || "Couldn't upload photo.");
  } finally {
    if (label) label.classList.remove("is-uploading");
    input.value = "";
  }
});

// Lightbox — shared overlay; clicks anywhere dismiss.
document.addEventListener("click", (event) => {
  const thumb = event.target.closest(".wo-photo-thumb img");
  if (thumb) {
    const box = document.getElementById("woPhotoLightbox");
    const img = document.getElementById("woPhotoLightboxImg");
    if (box && img) {
      img.src = thumb.src;
      box.hidden = false;
      document.body.classList.add("wo-lightbox-open");
    }
  }
});
document.getElementById("woPhotoLightbox")?.addEventListener("click", () => {
  const box = document.getElementById("woPhotoLightbox");
  if (box) box.hidden = true;
  document.body.classList.remove("wo-lightbox-open");
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
        id:      card.dataset.issueId || makeIssueId(),
        type:    card.querySelector(".wo-zone-issue-type")?.value || "other",
        subtype: card.querySelector(".wo-zone-issue-subtype")?.value || "",
        qty:     Math.max(1, Math.floor(Number(card.querySelector(".wo-zone-issue-qty")?.value) || 1)),
        notes:   (card.querySelector(".wo-zone-issue-notes")?.value || "").trim()
      }));

      // Location now lives in a real <input> element — read it live so a
      // tech who typed but didn't blur the field still gets their text on
      // save. Falls back to the dataset for safety. `kind` rides on the
      // row's data-kind attribute (set when picker fires).
      const liveLocation = row.querySelector(".wo-zone-location")?.value.trim();
      return {
        number: Number(row.dataset.number) || 0,
        kind: row.dataset.kind || "zone",
        location: liveLocation || row.dataset.location || "",
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

// Cascade-recovery actions: explicit "Create draft invoice" + "Re-run
// completion cascade" so Patrick can recover from cases where the auto-
// fire on status→completed didn't produce what he expected (usually
// because the WO had no line items at the time of the status flip).
const woCreateInvoiceBtn = document.getElementById("woCreateInvoiceBtn");
const woRunCascadeBtn = document.getElementById("woRunCascadeBtn");
const woCascadeStatus = document.getElementById("woCascadeStatus");

function setCascadeStatus(text, kind = "info") {
  if (!woCascadeStatus) return;
  woCascadeStatus.textContent = text;
  woCascadeStatus.dataset.kind = kind;
}

woCreateInvoiceBtn?.addEventListener("click", async () => {
  const id = getWorkOrderId();
  if (!id) return;
  woCreateInvoiceBtn.disabled = true;
  setCascadeStatus("Creating invoice…", "info");
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(id)}/create-invoice`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't create invoice.");
    if (data.alreadyExisted) {
      setCascadeStatus(`Invoice ${data.invoice.id} already exists for this WO.`, "info");
    } else {
      setCascadeStatus(`Draft invoice ${data.invoice.id} created — $${Number(data.invoice.total).toFixed(2)}.`, "ok");
    }
    // Open it in a new tab so Patrick keeps the WO context.
    setTimeout(() => window.open(`/admin/invoice/${encodeURIComponent(data.invoice.id)}`, "_blank"), 350);
  } catch (err) {
    setCascadeStatus(err.message || "Failed.", "error");
  } finally {
    woCreateInvoiceBtn.disabled = false;
  }
});

woRunCascadeBtn?.addEventListener("click", async () => {
  const id = getWorkOrderId();
  if (!id) return;
  if (!confirm("Re-run the full completion cascade? This is idempotent — if a service record already exists for this WO, it'll just return the existing record.")) return;
  woRunCascadeBtn.disabled = true;
  setCascadeStatus("Re-running cascade…", "info");
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(id)}/run-cascade`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't run cascade.");
    if (data.alreadyRan) {
      setCascadeStatus(`Cascade already ran for this WO. Service record: ${data.serviceRecord?.id}${data.invoice ? ` · Invoice ${data.invoice.id}` : ""}.`, "info");
    } else {
      setCascadeStatus(`Cascade fired. Service record: ${data.serviceRecord?.id}${data.invoice ? ` · Invoice ${data.invoice.id}` : " · No invoice (no line items)"}.`, "ok");
    }
  } catch (err) {
    setCascadeStatus(err.message || "Failed.", "error");
  } finally {
    woRunCascadeBtn.disabled = false;
  }
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

// ---- Zone source-picker (desktop) -------------------------------
// Click a row's "Zone N" / "VB" / "CTL" / "ISS" badge → an anchored
// dropdown menu opens listing the customer's pre-configured zones (with
// number + label), valve boxes, controller, and open deferred issues.
// Picking applies:
//   - kind     ("zone" / "valveBox" / "controller" / "issue") → drives
//              the badge text via zoneBadgeLabel()
//   - number   (only for property zones; the WO row adopts the customer's
//              real zone number)
//   - location (zone label → description input next to the badge)
//   - notes    (only when the WO zone notes textarea is empty — never
//              clobbers on-site work)
// Closes on outside-click, Escape, or after a selection. The description
// input remains free-text so a tech can type custom for unknown properties.

let zonePickerMenu = null;       // The single dropdown <ul> reused per row
let zonePickerActiveRow = null;  // .wo-zone-row currently driving the menu
let zonePickerSources = [];      // Cached list, rebuilt when loadedProperty changes

function buildZonePickerSources() {
  zonePickerSources = [];
  const property = loadedProperty;
  if (!property) return;
  const sys = property.system || {};
  const zones      = Array.isArray(sys.zones) ? sys.zones : [];
  const valveBoxes = Array.isArray(sys.valveBoxes) ? sys.valveBoxes : [];
  const ctrlBrand  = String(sys.controllerBrand || "").trim();
  const ctrlLoc    = String(sys.controllerLocation || "").trim();
  const issues = (Array.isArray(property.deferredIssues) ? property.deferredIssues : [])
    .filter((d) => d && (d.status === "open" || d.status === "pre_authorized"));

  zones.forEach((z) => {
    const number = Number(z.number) || 0;
    // Property zones store the human description in `location`. The older
    // schema used `label`; the property page falls back to it for legacy
    // records, and we mirror that here so imported data isn't orphaned.
    const rawLabel = String(z.location || z.label || "").trim();
    const notes = String(z.notes || "").trim();
    // Final fallback: when neither field is filled in, auto-populate the
    // description with "Zone N" so the field never looks empty after a
    // pick. Tech can overtype if they want a richer description.
    const fillLabel = rawLabel || `Zone ${number || "?"}`;
    zonePickerSources.push({
      group: "Zones",
      kind: "zone",
      number,
      label: fillLabel,                          // description-only — what fills the input
      display: rawLabel ? `Zone ${number || "?"} — ${rawLabel}` : `Zone ${number || "?"}`,
      sub: notes,
      notes
    });
  });
  valveBoxes.forEach((vb) => {
    const loc = String(vb.location || "").trim() || "Valve box";
    const cnt = Number(vb.valveCount) > 0 ? `${vb.valveCount} valve${vb.valveCount === 1 ? "" : "s"}` : "";
    const desc = `${loc}${cnt ? ` (${cnt})` : ""}`;
    zonePickerSources.push({
      group: "Valve boxes",
      kind: "valveBox",
      number: 0,
      label: desc,
      display: `VB — ${desc}`,
      sub: String(vb.notes || "").trim(),
      notes: String(vb.notes || "").trim()
    });
  });
  if (ctrlBrand || ctrlLoc) {
    const parts = [ctrlBrand || "Controller", ctrlLoc].filter(Boolean);
    zonePickerSources.push({
      group: "Controller",
      kind: "controller",
      number: 0,
      label: parts.join(" · "),
      display: `CTL — ${parts.join(" · ")}`,
      sub: "",
      notes: ""
    });
  }
  issues.forEach((iss, i) => {
    const note = String(iss.notes || iss.type || "").trim() || "Open issue";
    const trimmed = note.length > 80 ? note.slice(0, 78) + "…" : note;
    zonePickerSources.push({
      group: "Open issues",
      kind: "issue",
      number: 0,
      label: trimmed,
      display: `ISS #${i + 1} — ${trimmed}`,
      sub: iss.fromWoId ? `From ${iss.fromWoId}` : "",
      notes: String(iss.notes || "").trim()
    });
  });
}

function ensureZonePickerMenu() {
  if (zonePickerMenu) return zonePickerMenu;
  zonePickerMenu = document.createElement("div");
  zonePickerMenu.className = "wo-zone-picker-menu";
  zonePickerMenu.setAttribute("role", "listbox");
  zonePickerMenu.hidden = true;
  document.body.appendChild(zonePickerMenu);

  zonePickerMenu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-source-idx]");
    if (!item) return;
    const idx = Number(item.dataset.sourceIdx);
    if (!Number.isInteger(idx)) return;
    applyZoneSourceFromIdx(idx);
  });
  return zonePickerMenu;
}

function positionZonePickerMenu(triggerBtn) {
  const rect = triggerBtn.getBoundingClientRect();
  // Anchor below the trigger with a small gap. Account for scroll position
  // since position: absolute uses page coords, not viewport coords.
  zonePickerMenu.style.top  = `${rect.bottom + window.scrollY + 4}px`;
  zonePickerMenu.style.left = `${rect.left + window.scrollX}px`;
  // Cap width to viewport on small screens; cap min-width so it's
  // readable on desktop where the trigger is narrow.
  zonePickerMenu.style.minWidth = `${Math.max(rect.width, 260)}px`;
  zonePickerMenu.style.maxWidth = `${Math.min(window.innerWidth - 16, 480)}px`;
}

function openZonePicker(triggerBtn, row) {
  if (loadedWorkOrder?.locked) return;
  ensureZonePickerMenu();
  zonePickerActiveRow = row;
  // Build menu HTML grouped by source category. If the property has no
  // sources at all, we still show a single "Type custom in the description
  // field" hint so the tech doesn't tap a button that does nothing.
  const groups = new Map();
  zonePickerSources.forEach((src, idx) => {
    if (!groups.has(src.group)) groups.set(src.group, []);
    groups.get(src.group).push({ src, idx });
  });
  let html = "";
  if (!groups.size) {
    html = `<p class="wo-zone-picker-empty">No property zones / valves / controller on file. Type a custom description in the field.</p>`;
  } else {
    groups.forEach((items, label) => {
      html += `<section class="wo-zone-picker-group">
        <h4>${escapeHtml(label)}</h4>
        <ul>`;
      items.forEach(({ src, idx }) => {
        html += `<li>
          <button type="button" class="wo-zone-picker-item" data-source-idx="${idx}" role="option">
            <span class="wo-zone-picker-item-label">${escapeHtml(src.display)}</span>
            ${src.sub ? `<span class="wo-zone-picker-item-sub">${escapeHtml(src.sub)}</span>` : ""}
          </button>
        </li>`;
      });
      html += `</ul></section>`;
    });
  }
  zonePickerMenu.innerHTML = html;
  zonePickerMenu.hidden = false;
  triggerBtn.setAttribute("aria-expanded", "true");
  positionZonePickerMenu(triggerBtn);
}

function closeZonePicker() {
  if (!zonePickerMenu || zonePickerMenu.hidden) return;
  zonePickerMenu.hidden = true;
  document.querySelectorAll('.wo-zone-num[aria-expanded="true"]').forEach((b) => {
    b.setAttribute("aria-expanded", "false");
  });
  zonePickerActiveRow = null;
}

async function applyZoneSourceFromIdx(idx) {
  const src = zonePickerSources[idx];
  const row = zonePickerActiveRow;
  if (!src || !row) return closeZonePicker();

  // Update DOM data-attrs (collectForm reads these).
  row.dataset.kind = src.kind;
  if (src.kind === "zone" && Number.isFinite(src.number) && src.number > 0) {
    row.dataset.number = String(src.number);
  } else if (src.kind !== "zone") {
    row.dataset.number = "0";
  }
  row.dataset.location = src.label;

  // Update visible badge + description input.
  const numEl   = row.querySelector(".wo-zone-num");
  const locEl   = row.querySelector(".wo-zone-location");
  const notesEl = row.querySelector(".wo-zone-notes");
  if (numEl) numEl.textContent = zoneBadgeLabel({ kind: src.kind, number: src.number });
  if (locEl) locEl.value = src.label;
  // Auto-populate notes when WO notes are still empty.
  if (src.notes && notesEl && !notesEl.value.trim()) notesEl.value = src.notes;

  closeZonePicker();

  // Persist immediately so a reload keeps the swap.
  try {
    const id = getWorkOrderId();
    if (!id) return;
    const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zones: collectForm().zones })
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.ok && data.workOrder) loadedWorkOrder = data.workOrder;
  } catch {
    // Silent — Save button still works as a fallback.
  }
}

// Persist .wo-zone-location text edits on change (blur). Mirrors what the
// datalist version did, minus the auto-fill on match (the picker handles
// that flow). Custom typed values flag the row as kind=custom so the
// badge stays showing whatever zone number the row had.
woZones?.addEventListener("change", async (event) => {
  if (!event.target.classList.contains("wo-zone-location")) return;
  if (loadedWorkOrder?.locked) return;
  const row = event.target.closest(".wo-zone-row");
  if (!row) return;
  const value = String(event.target.value || "").trim().slice(0, 200);
  // Only flip to custom if the user actually typed something — and only
  // when the row isn't already a zone-kind row that the picker populated.
  // (Picker writes location + sets kind first; a follow-on change here
  // is the user editing the description manually — keep kind as-is.)
  row.dataset.location = value;

  try {
    const id = getWorkOrderId();
    if (!id) return;
    const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zones: collectForm().zones })
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.ok && data.workOrder) loadedWorkOrder = data.workOrder;
  } catch {
    // Silent — Save button still works as a fallback.
  }
});

// Click delegate on the zone list — opens the picker for the clicked row.
woZones?.addEventListener("click", (event) => {
  const trigger = event.target.closest('[data-action="open-zone-picker"]');
  if (!trigger) return;
  const row = trigger.closest(".wo-zone-row");
  if (!row) return;
  // Toggle: if already open for this row, close.
  if (zonePickerActiveRow === row && zonePickerMenu && !zonePickerMenu.hidden) {
    closeZonePicker();
    return;
  }
  openZonePicker(trigger, row);
});

// Outside click + escape close the menu. Re-position on resize/scroll
// so the menu stays anchored to its trigger when the layout shifts.
document.addEventListener("click", (event) => {
  if (!zonePickerMenu || zonePickerMenu.hidden) return;
  if (event.target.closest(".wo-zone-picker-menu")) return;
  if (event.target.closest('[data-action="open-zone-picker"]')) return;
  closeZonePicker();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && zonePickerMenu && !zonePickerMenu.hidden) closeZonePicker();
});
window.addEventListener("resize", () => {
  if (!zonePickerMenu || zonePickerMenu.hidden || !zonePickerActiveRow) return;
  const trigger = zonePickerActiveRow.querySelector('[data-action="open-zone-picker"]');
  if (trigger) positionZonePickerMenu(trigger);
});
window.addEventListener("scroll", () => {
  if (!zonePickerMenu || zonePickerMenu.hidden || !zonePickerActiveRow) return;
  const trigger = zonePickerActiveRow.querySelector('[data-action="open-zone-picker"]');
  if (trigger) positionZonePickerMenu(trigger);
}, true);

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
    loadedProperty  = data.property || null;
    buildZonePickerSources();
    woLoading.hidden = true;
    woForm.hidden = false;
    renderHero(data.workOrder, data.property, data.lead);
    renderCheatSheet(data.workOrder, data.property, data.lastService);
    renderBookingActivity(data.workOrder, data.lead);
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
