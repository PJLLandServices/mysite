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
const COVERAGE_LABELS  = { plants: "Plants", grass: "Grass", trees: "Trees", shrubs: "Shrubs" };

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

// v32 — Styled in-app dialog (same shape + branding as the tech-mode
// version). Replaces the v31 window.prompt() popup that looked like
// a browser system dialog (Patrick: "i wish it wasn't a prompt like
// youve made it. it pops up from what looks like the webpage. Can
// you change it so it looks like my website UI?"). Returns a Promise
// resolving to the typed zone number, or null on cancel.
function showZoneNumberDialog() {
  return new Promise((resolve) => {
    document.getElementById("pjlZoneDialog")?.remove();
    const backdrop = document.createElement("div");
    backdrop.id = "pjlZoneDialog";
    backdrop.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px;";
    const dialog = document.createElement("div");
    dialog.style.cssText = "background:#fff;border-radius:14px;padding:24px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.35);box-sizing:border-box;";
    dialog.innerHTML = `
      <h3 style="margin:0 0 6px;color:#1B4D2E;font-family:'Barlow Condensed',system-ui,sans-serif;font-size:22px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;">Add zone</h3>
      <p style="margin:0 0 16px;color:#555;font-size:14px;">Which zone are you working on? (1–99)</p>
      <input type="number" id="pjlZoneDialogInput" min="1" max="99" inputmode="numeric" placeholder="e.g. 3"
        style="width:100%;padding:14px;font-size:18px;border:2px solid #d9d6c8;border-radius:8px;box-sizing:border-box;margin-bottom:16px;outline:none;">
      <div style="display:flex;gap:10px;">
        <button type="button" id="pjlZoneDialogCancel" style="flex:1;padding:12px;background:#fff;border:1px solid #c9c6b8;border-radius:8px;font-weight:500;cursor:pointer;font-size:15px;color:#444;">Cancel</button>
        <button type="button" id="pjlZoneDialogOk" style="flex:2;padding:12px;background:#1B4D2E;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:15px;">Add zone</button>
      </div>
    `;
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    const input = dialog.querySelector("#pjlZoneDialogInput");
    const okBtn = dialog.querySelector("#pjlZoneDialogOk");
    const cancelBtn = dialog.querySelector("#pjlZoneDialogCancel");
    function cleanup() { backdrop.remove(); }
    function tryOk() {
      const n = Number(input.value);
      if (!Number.isFinite(n) || n < 1 || n > 99) {
        input.style.borderColor = "#c00";
        input.focus();
        return;
      }
      cleanup();
      resolve(n);
    }
    okBtn.addEventListener("click", tryOk);
    cancelBtn.addEventListener("click", () => { cleanup(); resolve(null); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); tryOk(); }
      else if (e.key === "Escape") { cleanup(); resolve(null); }
    });
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) { cleanup(); resolve(null); }
    });
    setTimeout(() => input.focus(), 50);
  });
}

async function addZoneRow(zone) {
  woEmptyZones.hidden = true;
  // v32 — when called without a pre-built zone (i.e. the +Add zone
  // button), open the styled in-app dialog. Same brand UI both on
  // tech-mode and here. Refuses non-numeric / out-of-range entries
  // and duplicates.
  //
  // v38 — Type-aware. Spring openings + fall closings are walk-the-
  // whole-system visits, so "+ Add zone" just appends the next
  // consecutive number (no prompt). Service visits keep the dialog
  // for non-consecutive picks (zone 3, then 8, then 12).
  let seed = zone;
  if (!seed) {
    const woType = loadedWorkOrder?.type || "";
    const onPage = new Set();
    woZones.querySelectorAll(".wo-zone-num").forEach((el) => {
      const v = Number(String(el.textContent || "").replace(/[^0-9]/g, ""));
      if (v > 0) onPage.add(v);
    });
    if (woType === "spring_opening" || woType === "fall_closing") {
      const max = onPage.size ? Math.max(...onPage) : 0;
      const next = max + 1;
      seed = { number: next, location: "", sprinklerTypes: [], coverage: [], status: "", notes: "" };
    } else {
      const n = await showZoneNumberDialog();
      if (n == null) return;
      if (onPage.has(n)) {
        alert(`Zone ${n} is already on this work order.`);
        return;
      }
      seed = { number: n, location: "", sprinklerTypes: [], coverage: [], status: "", notes: "" };
    }
  }
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
      // Photo gate may have flipped — refresh post-sig banner.
      renderPostSigBanner(wo);
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
        renderPostSigBanner(wo);
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

// AI-Correct-Diagnosis Bonus banner — desktop mirror of tech-mode's
// banner. Brief F: Match / Didn't Match buttons before signature; on
// match, the server adds a -1hr labour credit to the on-site quote
// builder. Locked at signature (intakeGuarantee is in SCOPE_PROTECTED_FIELDS).
function renderIntakeGuarantee(wo) {
  const banner = document.getElementById("woIntakeGuarantee");
  const eyebrow = document.getElementById("woIntakeEyebrow");
  const scope = document.getElementById("woIntakeScope");
  const source = document.getElementById("woIntakeSource");
  const actions = document.getElementById("woIntakeActions");
  const decided = document.getElementById("woIntakeDecided");
  if (!banner) return;
  if (!wo || !wo.intakeGuarantee || wo.intakeGuarantee.applies !== true) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const ig = wo.intakeGuarantee;
  if (scope) scope.textContent = ig.scope || "Locked scope";
  if (source) {
    source.textContent = ig.sourceQuoteId ? `Source: ${ig.sourceQuoteId}` : "";
  }
  const isLocked = wo.locked === true || wo.signature?.signed === true;
  if (ig.matched === true) {
    banner.dataset.decision = "matched";
    if (eyebrow) eyebrow.textContent = "AI-Correct-Diagnosis Bonus — 1 Hour Labour Credited";
    if (actions) actions.hidden = true;
    if (decided) {
      decided.hidden = false;
      decided.textContent = "Diagnosis matched. Credit line added to the on-site quote.";
    }
  } else if (ig.matched === false) {
    banner.dataset.decision = "mismatch";
    if (eyebrow) eyebrow.textContent = "AI-Correct-Diagnosis Bonus — Diagnosis Didn't Match";
    if (actions) actions.hidden = true;
    if (decided) {
      decided.hidden = false;
      decided.textContent = ig.mismatchReason
        ? `No credit applied: ${ig.mismatchReason}`
        : "No credit applied. Labour bills at the listed rate.";
    }
  } else {
    banner.dataset.decision = "pending";
    if (eyebrow) eyebrow.textContent = "AI-Correct-Diagnosis Bonus — Decision Required";
    if (actions) actions.hidden = isLocked;
    if (decided) decided.hidden = true;
  }
}

document.getElementById("woIntakeMatchBtn")?.addEventListener("click", async () => {
  if (!loadedWorkOrder || loadedWorkOrder.locked) return;
  if (!confirm("Confirm: the on-site diagnosis matches the AI-quoted scope. This credits 1 hour of repair labour to the customer.")) return;
  await postIntakeDecisionDesktop({ matched: true });
});
document.getElementById("woIntakeMismatchBtn")?.addEventListener("click", async () => {
  if (!loadedWorkOrder || loadedWorkOrder.locked) return;
  const reason = prompt("Optional: brief note on why the diagnosis didn't match. Leave blank if none.", "");
  if (reason === null) return;
  await postIntakeDecisionDesktop({ matched: false, mismatchReason: reason || "" });
});

async function postIntakeDecisionDesktop(body) {
  const id = getWorkOrderId();
  if (!id) return;
  const matchBtn = document.getElementById("woIntakeMatchBtn");
  const mismBtn = document.getElementById("woIntakeMismatchBtn");
  if (matchBtn) matchBtn.disabled = true;
  if (mismBtn) mismBtn.disabled = true;
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(id)}/intake-guarantee/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't record decision.");
    if (data.workOrder) {
      loadedWorkOrder = data.workOrder;
      renderIntakeGuarantee(data.workOrder);
      renderOnSiteQuote(data.workOrder);
      renderSignoff(data.workOrder);
    }
  } catch (err) {
    alert(err.message || "Couldn't record decision.");
  } finally {
    if (matchBtn) matchBtn.disabled = false;
    if (mismBtn) mismBtn.disabled = false;
  }
}

function populateForm(wo) {
  woTechNotes.value = wo.techNotes || "";
  renderZones(wo.zones || []);
  renderDiagnosis(wo);
  renderIntakeGuarantee(wo);
  renderServiceChecklist(wo);
  renderWoPhotos(wo);
  renderSignoff(wo);
  renderPaidOnSite(wo);
  renderOnSiteQuote(wo);
  renderPostSigBanner(wo);
  renderHistory(wo);
  applyLockState(wo.locked === true, wo.signature);
}

// Mirror of lib's PHOTO_REQUIREMENT_BY_TYPE — keep in sync.
const WO_PHOTO_REQUIREMENT_BY_TYPE = {
  spring_opening: 1,
  service_visit:  1,
  fall_closing:   0
};

// Post-signature narrative banner (Brief E) — desktop mirror of tech
// mode's banner. Surfaces the photo gate + Mark Complete CTA so Patrick
// isn't stranded between "signature captured" and "visit completed."
// Three states: pending_photos / ready / completed. Hidden when not
// applicable (pre-signature, cancelled, etc).
function renderPostSigBanner(wo) {
  // Keep the pre-sign readiness list in sync as zones / photos / CF
  // resolutions mutate. Cheap; runs whenever this banner re-renders.
  updateWoSignoffSubmitState();

  const banner = document.getElementById("woPostSigBanner");
  const icon = document.getElementById("woPostSigIcon");
  const headline = document.getElementById("woPostSigHeadline");
  const detail = document.getElementById("woPostSigDetail");
  const completeBtn = document.getElementById("woPostSigCompleteBtn");
  if (!banner || !headline || !detail) return;
  const signed = wo.signature?.signed === true;
  const bypassed = !!wo.signatureBypass;
  const captured = wo.locked === true || signed || bypassed;
  const completed = wo.status === "completed";

  if (completedInvoiceForBanner) {
    banner.hidden = false;
    banner.dataset.state = "completed";
    if (icon) icon.textContent = "✓";
    headline.textContent = bypassed && !signed
      ? "Visit bypass-locked and completed."
      : "Visit signed, locked, and completed.";
    const safeId = String(completedInvoiceForBanner).replace(/</g, "&lt;");
    detail.innerHTML = `Draft invoice <a href="/admin/invoice/${encodeURIComponent(completedInvoiceForBanner)}" class="wo-postsig-link">${safeId}</a> on file. Customer summary email sent.`;
    if (completeBtn) completeBtn.hidden = true;
    return;
  }
  if (completed) {
    banner.hidden = false;
    banner.dataset.state = "completed";
    if (icon) icon.textContent = "✓";
    headline.textContent = bypassed && !signed
      ? "Visit bypass-locked and completed."
      : "Visit signed, locked, and completed.";
    detail.textContent = "Service record on file. No invoice for this visit (no billable line items).";
    if (completeBtn) completeBtn.hidden = true;
    return;
  }
  if (!captured) {
    banner.hidden = true;
    if (completeBtn) completeBtn.hidden = true;
    return;
  }

  // Edge case: captured (signed or bypassed) but status didn't flip
  // (cascade gate tripped on missing propertyId, or this is a legacy
  // WO from before the merge). Surface the recovery path.
  banner.hidden = false;
  banner.dataset.state = "needs_retry";
  if (icon) icon.textContent = "↻";
  headline.textContent = bypassed && !signed
    ? "Bypass recorded — completion didn't fire."
    : "Signed and locked — completion didn't fire.";
  detail.textContent = "Tap Mark Complete to retry the cascade, or use Re-run completion cascade below.";
  if (completeBtn) completeBtn.hidden = false;
}

// Tracks the freshly-created invoice ID after Mark Complete fires the
// cascade — we look it up via /api/invoices?woId=<id> after a short delay.
let completedInvoiceForBanner = null;

document.getElementById("woPostSigCompleteBtn")?.addEventListener("click", async () => {
  if (!loadedWorkOrder) return;
  const id = getWorkOrderId();
  if (!id) return;
  if (loadedWorkOrder.status === "completed") return;
  if (!confirm("Mark this visit completed? Fires the cascade — service record + draft invoice + customer email.")) return;
  const btn = document.getElementById("woPostSigCompleteBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Marking complete…"; }
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors || ["Couldn't mark complete."]).join(" "));
    if (data.workOrder) {
      loadedWorkOrder = data.workOrder;
      // Status dropdown + cascade visuals refresh from the new state.
      if (woStatus) woStatus.value = data.workOrder.status;
      renderPostSigBanner(data.workOrder);
    }
    // Look up the freshly-drafted invoice so the banner can surface its
    // ID. The cascade fires async on the server; give it a moment.
    setTimeout(async () => {
      try {
        const ir = await fetch(`/api/invoices?woId=${encodeURIComponent(id)}`);
        const idata = await ir.json().catch(() => ({}));
        const inv = idata && idata.ok && Array.isArray(idata.invoices) ? idata.invoices[0] : null;
        if (inv && inv.id) {
          completedInvoiceForBanner = inv.id;
          if (loadedWorkOrder) renderPostSigBanner(loadedWorkOrder);
        }
      } catch (_e) {}
    }, 1500);
  } catch (err) {
    alert(err.message || "Couldn't mark complete.");
    if (btn) { btn.disabled = false; btn.textContent = "Mark visit completed"; }
  }
});

// ---- On-site Quote (Brief B — desktop parity) ------------------------
// Mirror of tech mode's quote builder, adapted for desktop layout. Same
// endpoints: /on-site-quote/build, /on-site-quote/builder,
// /on-site-quote/send-for-approval. NO customer-review or signature
// canvas — those are tech-mode only (customer is in front of the tech).
//
// State machine on desktop:
//   - fall_closing → defer-only banner, builder hidden
//   - signed (locked) → read-only summary + locked Quote ID + totals
//   - unsigned + no lines → "Generate from issues" CTA prominent
//   - unsigned + has lines → editable list + +Add + totals + Send

function woFormatMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "$0.00";
  return v < 0 ? "-$" + Math.abs(v).toFixed(2) : "$" + v.toFixed(2);
}

function woEffectiveLinePrice(line) {
  if (line && line.overridePrice != null && Number.isFinite(Number(line.overridePrice))) {
    return Number(line.overridePrice);
  }
  return Number(line && line.originalPrice) || 0;
}

function woLineRowTotal(line) {
  return Math.round(woEffectiveLinePrice(line) * (Number(line.qty) || 0) * 100) / 100;
}

function woTotalsForLines(lines) {
  let subtotal = 0;
  for (const line of lines || []) subtotal += woLineRowTotal(line);
  subtotal = Math.round(subtotal * 100) / 100;
  const hst = Math.round(subtotal * 0.13 * 100) / 100;
  const total = Math.round((subtotal + hst) * 100) / 100;
  return { subtotal, hst, total };
}

function renderOnSiteQuote(wo) {
  const section = document.getElementById("woOnSiteQuoteSection");
  if (!section) return;
  section.hidden = false;

  const isFallClosing = wo.type === "fall_closing";
  // "Signed" here means "locked by any path" — both drawn signature and
  // signature bypass freeze the on-site quote builder per hard rule §11.
  const isSigned = wo.locked === true || wo.signature?.signed === true || !!wo.signatureBypass;
  const lines = (wo.onSiteQuote && wo.onSiteQuote.builderLineItems) || [];
  const status = wo.onSiteQuote?.status;
  const quoteId = wo.onSiteQuote?.quoteId;

  const buildBtn = document.getElementById("woOnSiteBuildBtn");
  const addBtn = document.getElementById("woOnSiteAddBtn");
  const linesEl = document.getElementById("woOnSiteLines");
  const emptyEl = document.getElementById("woOnSiteEmpty");
  const totalsEl = document.getElementById("woOnSiteTotals");
  const deferEl = document.getElementById("woOnSiteDefer");
  const statusEl = document.getElementById("woOnSiteStatus");
  const remoteEl = document.getElementById("woOnSiteRemoteSection");
  const titleEl = document.getElementById("woOnSiteQuoteTitle");
  const helpEl = document.getElementById("woOnSiteQuoteHelp");

  // Reset visibility
  if (buildBtn) buildBtn.hidden = true;
  if (addBtn) addBtn.hidden = true;
  if (deferEl) deferEl.hidden = true;
  if (statusEl) { statusEl.hidden = true; statusEl.textContent = ""; }
  if (remoteEl) remoteEl.hidden = true;

  // Find_only — defer-only banner, no builder.
  if (isFallClosing) {
    if (titleEl) titleEl.textContent = "Issues → Deferred (find-only)";
    if (helpEl) helpEl.textContent = "Fall closings don't quote on-site (PJL operations rule 8). Use tech mode to defer issues to spring follow-up.";
    if (deferEl) deferEl.hidden = false;
    if (linesEl) linesEl.innerHTML = "";
    if (emptyEl) emptyEl.hidden = true;
    if (totalsEl) totalsEl.hidden = true;
    return;
  }

  if (titleEl) titleEl.textContent = "Issues → Draft Quote";
  if (helpEl) helpEl.textContent = isSigned
    ? "Scope was locked at signature. Adjustments now happen on the invoice — see the Cascade actions below."
    : "Aggregate this visit's issues into priced line items. Tech can also do this from /tech with the customer on-screen.";

  // Signed → read-only summary.
  if (isSigned) {
    if (statusEl) {
      const lockedSummary = (() => {
        if (status === "accepted" && quoteId) return `Customer accepted all lines. Quote ${quoteId} on file.`;
        if (status === "partially_accepted" && quoteId) return `Customer accepted some lines. Quote ${quoteId} on file. Declined items routed to deferred recommendations.`;
        if (status === "declined") return `Customer declined all lines. All items routed to deferred recommendations.`;
        if (status === "sent_for_remote_approval" && quoteId) return `Awaiting remote approval. Quote ${quoteId} sent to customer.`;
        return `Scope locked at signature.`;
      })();
      statusEl.textContent = lockedSummary;
      statusEl.hidden = false;
    }
    renderOnSiteLines(lines, { readonly: true });
    renderOnSiteTotals(lines);
    return;
  }

  // Unsigned editable state.
  if (buildBtn) buildBtn.hidden = false;
  if (lines.length) {
    if (addBtn) addBtn.hidden = false;
    if (remoteEl) remoteEl.hidden = false;
  }
  renderOnSiteLines(lines, { readonly: false });
  renderOnSiteTotals(lines);
}

function renderOnSiteLines(lines, { readonly }) {
  const linesEl = document.getElementById("woOnSiteLines");
  const emptyEl = document.getElementById("woOnSiteEmpty");
  if (!linesEl) return;
  linesEl.innerHTML = "";
  if (!lines.length) {
    if (emptyEl) emptyEl.hidden = false;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;

  lines.forEach((line, idx) => {
    const li = document.createElement("li");
    li.className = "wo-on-site-line";
    li.dataset.idx = String(idx);
    const overridden = line.overridePrice != null && Number(line.overridePrice) !== Number(line.originalPrice);
    const priceVal = line.overridePrice != null ? Number(line.overridePrice) : Number(line.originalPrice);
    if (readonly) {
      li.innerHTML = `
        <div class="wo-on-site-line-head">
          <span class="wo-on-site-line-label-readonly">${escapeHtml(line.label || "(unlabeled)")}</span>
          <span class="wo-on-site-line-lock" aria-hidden="true">🔒</span>
        </div>
        <div class="wo-on-site-line-controls">
          <span class="wo-on-site-line-meta">Qty ${escapeHtml(String(line.qty || 1))}</span>
          <span class="wo-on-site-line-meta">${woFormatMoney(priceVal)}${overridden ? ' <em class="wo-on-site-overridden">override</em>' : ""}</span>
          <span class="wo-on-site-line-total">${woFormatMoney(woLineRowTotal(line))}</span>
        </div>
        ${line.note ? `<p class="wo-on-site-line-note">${escapeHtml(line.note)}</p>` : ""}
      `;
    } else {
      li.innerHTML = `
        <div class="wo-on-site-line-head">
          <input type="text" class="wo-on-site-line-label" value="${escapeHtml(line.label || "")}" placeholder="Describe the work…" maxlength="200" aria-label="Line description">
          <button type="button" class="wo-on-site-line-remove" data-action="remove-line" aria-label="Remove line">×</button>
        </div>
        <div class="wo-on-site-line-controls">
          <label>
            <span>Qty</span>
            <input type="number" min="1" inputmode="numeric" class="wo-on-site-line-qty" value="${escapeHtml(String(line.qty || 1))}">
          </label>
          <label>
            <span>Unit price${overridden ? ' <em class="wo-on-site-overridden">override</em>' : ""}</span>
            <input type="number" min="0" step="0.01" inputmode="decimal" class="wo-on-site-line-price" value="${escapeHtml(priceVal.toFixed(2))}">
          </label>
          <span class="wo-on-site-line-total">${woFormatMoney(woLineRowTotal(line))}</span>
        </div>
        ${line.note ? `<p class="wo-on-site-line-note">${escapeHtml(line.note)}</p>` : ""}
      `;
    }
    linesEl.appendChild(li);
  });
}

function renderOnSiteTotals(lines) {
  const totalsEl = document.getElementById("woOnSiteTotals");
  if (!totalsEl) return;
  if (!lines.length) {
    totalsEl.hidden = true;
    return;
  }
  const t = woTotalsForLines(lines);
  totalsEl.hidden = false;
  // Structured markup — every visible text element gets its own class
  // with an explicit color in CSS. Without this, the bare text nodes
  // ("Subtotal", "HST", "·") inherited from the wrapper color and an
  // ancestor form/section style silently overrode them — labels rendered
  // dark-on-dark and were nearly invisible.
  totalsEl.innerHTML = `
    <span class="wo-on-site-totals-row">
      <span class="wo-on-site-totals-label">Subtotal</span>
      <span class="wo-on-site-totals-value">${woFormatMoney(t.subtotal)}</span>
    </span>
    <span class="wo-on-site-totals-divider" aria-hidden="true">·</span>
    <span class="wo-on-site-totals-row">
      <span class="wo-on-site-totals-label">HST</span>
      <span class="wo-on-site-totals-value">${woFormatMoney(t.hst)}</span>
    </span>
    <span class="wo-on-site-totals-divider" aria-hidden="true">·</span>
    <span class="wo-on-site-totals-row wo-on-site-totals-row--final">
      <span class="wo-on-site-totals-label">Total</span>
      <span class="wo-on-site-totals-value wo-on-site-total-final">${woFormatMoney(t.total)}</span>
    </span>
  `;
}

// "Generate from issues" — POSTs to the same /build endpoint tech mode
// uses. On success, refreshes the WO and re-renders.
document.getElementById("woOnSiteBuildBtn")?.addEventListener("click", async () => {
  const id = getWorkOrderId();
  if (!id) return;
  const btn = document.getElementById("woOnSiteBuildBtn");
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(id)}/on-site-quote/build`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't build quote.");
    if (data.workOrder) {
      loadedWorkOrder = data.workOrder;
      renderOnSiteQuote(data.workOrder);
    }
  } catch (err) {
    alert(err.message || "Couldn't build quote.");
  } finally {
    if (btn) btn.disabled = false;
  }
});

// "+ Add custom line" — append a blank custom line to the builder.
document.getElementById("woOnSiteAddBtn")?.addEventListener("click", () => {
  if (!loadedWorkOrder) return;
  const lines = ((loadedWorkOrder.onSiteQuote && loadedWorkOrder.onSiteQuote.builderLineItems) || []).slice();
  lines.push({
    key: null,
    label: "",
    qty: 1,
    originalPrice: 0,
    overridePrice: null,
    custom: true,
    source: { zoneNumbers: [], issueIds: [] },
    note: ""
  });
  loadedWorkOrder.onSiteQuote = { ...(loadedWorkOrder.onSiteQuote || {}), builderLineItems: lines };
  renderOnSiteLines(lines, { readonly: false });
  renderOnSiteTotals(lines);
  persistOnSiteBuilder();
});

// Per-row remove button + per-row input edits. Event delegation so new
// rows don't need re-binding. Persists to /on-site-quote/builder on
// debounce.
let onSiteBuilderTimer = null;
function persistOnSiteBuilder() {
  if (onSiteBuilderTimer) clearTimeout(onSiteBuilderTimer);
  onSiteBuilderTimer = setTimeout(async () => {
    const id = getWorkOrderId();
    if (!id || !loadedWorkOrder) return;
    const lines = (loadedWorkOrder.onSiteQuote && loadedWorkOrder.onSiteQuote.builderLineItems) || [];
    try {
      const r = await fetch(`/api/work-orders/${encodeURIComponent(id)}/on-site-quote/builder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineItems: lines })
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok && data.workOrder) {
        // Server may correct line shapes (re-snapshot originalPrice).
        // Pull canonical state back without nuking inputs the user is
        // currently editing — only the totals strip + non-active rows
        // re-render. The full re-render fires on next populateForm.
        loadedWorkOrder = data.workOrder;
        renderOnSiteTotals(data.workOrder.onSiteQuote.builderLineItems || []);
      }
    } catch (_e) {}
  }, 600);
}

document.getElementById("woOnSiteLines")?.addEventListener("click", (event) => {
  if (!loadedWorkOrder || loadedWorkOrder.locked) return;
  if (event.target.matches('[data-action="remove-line"]')) {
    const li = event.target.closest(".wo-on-site-line");
    if (!li) return;
    const idx = Number(li.dataset.idx);
    const lines = ((loadedWorkOrder.onSiteQuote && loadedWorkOrder.onSiteQuote.builderLineItems) || []).slice();
    if (!Number.isInteger(idx) || idx < 0 || idx >= lines.length) return;
    lines.splice(idx, 1);
    loadedWorkOrder.onSiteQuote = { ...(loadedWorkOrder.onSiteQuote || {}), builderLineItems: lines };
    renderOnSiteLines(lines, { readonly: false });
    renderOnSiteTotals(lines);
    persistOnSiteBuilder();
  }
});

document.getElementById("woOnSiteLines")?.addEventListener("input", (event) => {
  if (!loadedWorkOrder || loadedWorkOrder.locked) return;
  const li = event.target.closest(".wo-on-site-line");
  if (!li) return;
  const idx = Number(li.dataset.idx);
  const lines = (loadedWorkOrder.onSiteQuote && loadedWorkOrder.onSiteQuote.builderLineItems) || [];
  const line = lines[idx];
  if (!line) return;
  if (event.target.classList.contains("wo-on-site-line-qty")) {
    line.qty = Math.max(1, Math.floor(Number(event.target.value) || 1));
  } else if (event.target.classList.contains("wo-on-site-line-price")) {
    const v = Number(event.target.value);
    if (Number.isFinite(v) && v >= 0) {
      line.overridePrice = Math.abs(v - Number(line.originalPrice)) < 0.005 ? null : v;
    }
  } else if (event.target.classList.contains("wo-on-site-line-label")) {
    line.label = String(event.target.value || "").slice(0, 200);
  } else {
    return;
  }
  // Update only the row total + grand totals; full re-render would
  // wipe the input the user is editing.
  const rowTotal = li.querySelector(".wo-on-site-line-total");
  if (rowTotal) rowTotal.textContent = woFormatMoney(woLineRowTotal(line));
  renderOnSiteTotals(lines);
  persistOnSiteBuilder();
});

// "Send for customer approval" — same endpoint tech mode uses. Reuses
// the WO's customer email + phone snapshot. Confirm-then-fire pattern;
// status surfaces in the wo-on-site-remote-status element.
document.getElementById("woOnSiteSendApprovalBtn")?.addEventListener("click", async () => {
  if (!loadedWorkOrder) return;
  const id = getWorkOrderId();
  if (!id) return;
  const btn = document.getElementById("woOnSiteSendApprovalBtn");
  const statusEl = document.getElementById("woOnSiteRemoteStatus");
  const customerEmail = loadedWorkOrder.customerEmail || "";
  const customerPhone = loadedWorkOrder.customerPhone || "";
  if (!customerEmail && !customerPhone) {
    alert("Customer has no email or phone on file. Add one before sending an approval link.");
    return;
  }
  const customerName = loadedWorkOrder.customerName || "the customer";
  if (!confirm(`Send the on-site quote to ${customerName} via ${[customerEmail && "email", customerPhone && "SMS"].filter(Boolean).join(" + ")} for remote approval?`)) return;

  if (btn) btn.disabled = true;
  if (statusEl) { statusEl.hidden = false; statusEl.textContent = "Sending…"; statusEl.dataset.kind = "info"; }
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(id)}/on-site-quote/send-for-approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sendEmail: !!customerEmail,
        sendSms: !!customerPhone,
        email: customerEmail,
        phone: customerPhone
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't send.");
    const channels = [];
    if (data.emailSent) channels.push("email");
    if (data.smsSent) channels.push("SMS");
    const errs = [];
    if (data.emailError) errs.push(`email: ${data.emailError}`);
    if (data.smsError) errs.push(`SMS: ${data.smsError}`);
    if (statusEl) {
      if (channels.length) {
        statusEl.textContent = `Sent via ${channels.join(" + ")}. Quote ${data.quote.id}. Awaiting customer signature.`;
        statusEl.dataset.kind = "ok";
      } else {
        statusEl.textContent = `Quote created (${data.quote.id}) but no delivery channel succeeded. Errors: ${errs.join("; ")}.`;
        statusEl.dataset.kind = "error";
      }
    }
    // Refresh the WO so the section reflects the sent_for_remote_approval state.
    const refreshed = await fetch(`/api/work-orders/${encodeURIComponent(id)}`).then((r) => r.json()).catch(() => null);
    if (refreshed?.workOrder) {
      loadedWorkOrder = refreshed.workOrder;
      renderOnSiteQuote(refreshed.workOrder);
    }
  } catch (err) {
    if (statusEl) { statusEl.textContent = err.message || "Failed."; statusEl.dataset.kind = "error"; }
  } finally {
    if (btn) btn.disabled = false;
  }
});

// Payment captured on-site? Mirror of the tech-mode radio. Coerces
// wo.paidOnSite (true | false | null) onto the matching radio. Spec
// §4.3.2 Payment & Billing.
function renderPaidOnSite(wo) {
  const yes = document.getElementById("woPaidOnSiteYes");
  const no = document.getElementById("woPaidOnSiteNo");
  const v = wo?.paidOnSite;
  if (yes) yes.checked = v === true;
  if (no)  no.checked  = v === false;
}

document.getElementById("woPaidOnSiteSection")?.addEventListener("change", async (event) => {
  if (event.target.name !== "woPaidOnSite") return;
  const value = event.target.value === "yes" ? true
    : event.target.value === "no" ? false
    : null;
  const id = getWorkOrderId();
  if (!id) return;
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paidOnSite: value })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors || ["Couldn't save."]).join(" "));
    if (data.workOrder) loadedWorkOrder = data.workOrder;
    // Brief: WO Field-Readiness §6.2 — paidOnSite is now a pre-sign
    // gate. Re-render the readiness state so the sign button enables
    // as soon as the radio is picked.
    if (typeof updateWoSignoffSubmitState === "function") updateWoSignoffSubmitState();
  } catch (err) {
    alert(err.message || "Couldn't save payment status.");
    // Revert the radio to the persisted state on failure.
    if (loadedWorkOrder) renderPaidOnSite(loadedWorkOrder);
  }
});

// History viewer — append-only audit trail per spec §10 r4. Renders
// newest-first as a flat list. Each entry: timestamp · actor · action
// slug · summary note. Status changes show before→after on a second line.
const HISTORY_ACTOR_LABELS = {
  admin: "Admin",
  tech: "Tech",
  system: "System",
  customer: "Customer"
};
const HISTORY_ACTION_LABELS = {
  created: "Created",
  status_change: "Status changed",
  signature_capture: "Customer signed",
  patch: "Edited",
  photo_upload: "Photo uploaded",
  photo_delete: "Photo removed",
  quote_built: "Quote generated",
  customer_accepted: "Customer accepted scope",
  customer_declined_all: "Customer declined all",
  remote_approval_sent: "Sent for remote approval",
  issue_deferred: "Issue deferred",
  issues_bulk_deferred: "Issues bulk-deferred",
  emergency_override: "Emergency override",
  carry_forward_repair_now: "Carry-forward → repair now",
  carry_forward_declined: "Carry-forward → declined",
  carry_forward_already_fixed: "Carry-forward → already fixed",
  carry_forward_cannot_locate: "Carry-forward → can't locate",
  cascade_fire: "Completion cascade",
  cascade_failed: "Cascade failed",
  invoice_drafted: "Invoice drafted",
  followup_created: "Follow-up scheduled",
  created_as_followup: "Created as follow-up",
  created_as_emergency_followup: "Created as emergency follow-up"
};

function renderHistory(wo) {
  const section = document.getElementById("woHistorySection");
  const list = document.getElementById("woHistoryList");
  const count = document.getElementById("woHistoryCount");
  const empty = document.getElementById("woHistoryEmpty");
  if (!section || !list) return;
  const history = Array.isArray(wo?.history) ? wo.history.slice() : [];
  if (count) count.textContent = String(history.length);
  if (!history.length) {
    list.innerHTML = "";
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  // Newest first — sort by ts descending. Stable for entries with the
  // same ts (cascade may write multiple entries within the same ms tick).
  history.sort((a, b) => (new Date(b.ts || 0)) - (new Date(a.ts || 0)));
  list.innerHTML = history.map(historyEntryHtml).join("");
}

function historyEntryHtml(entry) {
  const ts = entry.ts ? formatDateTime(entry.ts) : "—";
  const actorRaw = entry.by || "system";
  const actor = HISTORY_ACTOR_LABELS[actorRaw] || actorRaw;
  const actionLabel = HISTORY_ACTION_LABELS[entry.action] || (entry.action || "Updated").replace(/_/g, " ");
  const note = entry.note ? escapeHtml(entry.note) : "";
  const beforeAfter = (entry.before !== undefined || entry.after !== undefined)
    ? `<span class="wo-history-diff">${escapeHtml(String(entry.before ?? "—"))} <span aria-hidden="true">→</span> ${escapeHtml(String(entry.after ?? "—"))}</span>`
    : "";
  return `
    <li class="wo-history-row" data-action="${escapeHtml(entry.action || "")}">
      <div class="wo-history-row-head">
        <span class="wo-history-action">${escapeHtml(actionLabel)}</span>
        <span class="wo-history-ts">${escapeHtml(ts)}</span>
        <span class="wo-history-actor">${escapeHtml(actor)}</span>
      </div>
      ${note ? `<p class="wo-history-note">${note}</p>` : ""}
      ${beforeAfter}
    </li>
  `;
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
  const bypassed = document.getElementById("woSignoffBypassed");
  if (!form || !signed) return;
  const sig = wo && wo.signature;
  const bypass = wo && wo.signatureBypass;

  if (bypass) {
    form.hidden = true;
    signed.hidden = true;
    if (bypassed) {
      bypassed.hidden = false;
      const meta = document.getElementById("woSignoffBypassedMeta");
      const note = document.getElementById("woSignoffBypassedNote");
      const reasonLabel = woBypassReasonLabel(bypass.reason);
      const by = bypass.bypassedBy || "admin";
      const at = bypass.ts ? formatDateTime(bypass.ts) : "—";
      if (meta) meta.textContent = `${reasonLabel} · Recorded by ${by} · ${at}`;
      if (note) note.textContent = bypass.note || "";
    }
    return;
  }

  if (sig && sig.signed) {
    form.hidden = true;
    signed.hidden = false;
    if (bypassed) bypassed.hidden = true;
    const img = document.getElementById("woSignoffImage");
    const nameEl = document.getElementById("woSignoffSignedName");
    const atEl = document.getElementById("woSignoffSignedAt");
    if (img && sig.imageData) img.src = sig.imageData;
    if (nameEl) nameEl.textContent = sig.customerName || "—";
    if (atEl && sig.signedAt) atEl.textContent = ` · ${formatDateTime(sig.signedAt)}`;
  } else {
    form.hidden = false;
    signed.hidden = true;
    if (bypassed) bypassed.hidden = true;
    if (!signaturePadInstance) {
      const canvas = document.getElementById("woSignoffCanvas");
      if (canvas) signaturePadInstance = createWoSignaturePad(canvas, updateWoSignoffSubmitState);
    }
    updateWoSignoffSubmitState();
  }
}

function woBypassReasonLabel(slug) {
  switch (slug) {
    case "customer_not_home": return "Customer not home";
    case "trusted_customer_verbal": return "Trusted customer — verbal acceptance";
    case "other": return "Other";
    default: return "Signature bypass";
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
  // Brief F — AI bonus decision must be captured before signature when
  // the WO is bonus-eligible. Same gate logic as tech mode.
  const ig = loadedWorkOrder?.intakeGuarantee || {};
  const bonusGateOk = !ig.applies || ig.matched === true || ig.matched === false;
  const readinessFails = woPreSignReadinessFailures();
  const readinessOk = readinessFails.length === 0;
  submit.disabled = !(name && ack && drawn && bonusGateOk && readinessOk);

  // Inline readiness list mirrors the tech-mode treatment so Patrick
  // sees from the desktop editor exactly what's blocking sign-off.
  const readinessList = document.getElementById("woSignoffReadiness");
  if (readinessList) {
    if (!readinessOk && (name || drawn)) {
      readinessList.hidden = false;
      readinessList.innerHTML = readinessFails
        .map((f) => `<li>${f.replace(/</g, "&lt;")}</li>`)
        .join("");
    } else {
      readinessList.hidden = true;
      readinessList.innerHTML = "";
    }
  }

  if (!bonusGateOk) {
    submit.title = "Resolve the AI Correct Diagnosis Bonus decision before signing.";
  } else if (!readinessOk) {
    submit.title = readinessFails.join(" • ");
  } else {
    submit.removeAttribute("title");
  }
}

// Pre-sign walkout mirror — same gates as tech mode (zones touched,
// photo threshold, carry-forward resolved, paidOnSite selected,
// materials confirmed when relevant) minus the signature check.
// Used to gate the merged "Sign, Lock & Generate Invoice" button so
// signing only fires the cascade on a fully-complete visit.
// Brief: WO Field-Readiness §6.2 promotes paidOnSite + materials to
// pre-sign gates so the cascade fires with correct invoice flags.
function woPreSignReadinessFailures() {
  const wo = loadedWorkOrder;
  if (!wo) return [];
  const fails = [];
  const zones = Array.isArray(wo.zones) ? wo.zones : [];
  const untouched = zones.filter((z) => {
    if (z.status && z.status !== "") return false;
    const checks = z.checks || {};
    return !Object.values(checks).some(Boolean);
  });
  if (untouched.length) {
    fails.push(`${untouched.length} zone${untouched.length === 1 ? "" : "s"} haven't been checked yet (zones ${untouched.map((z) => z.number).join(", ")}).`);
  }
  if (wo.type === "spring_opening") {
    const openCfCards = document.querySelectorAll('#woCarryForwardList [data-deferred-id]');
    if (openCfCards.length) {
      fails.push(`${openCfCards.length} carry-forward recommendation${openCfCards.length === 1 ? "" : "s"} still need an action.`);
    }
  }
  const minPhotos = WO_PHOTO_REQUIREMENT_BY_TYPE[wo.type] ?? 1;
  if (minPhotos > 0) {
    const photoCount = Array.isArray(wo.photos) ? wo.photos.length : 0;
    if (photoCount < minPhotos) {
      fails.push(`Capture ${minPhotos === 1 ? "at least one completion photo" : `at least ${minPhotos} completion photos`} before signing.`);
    }
  }
  // Payment-method gate — promoted to pre-sign so the cascade fires
  // with the right paidOnSiteAtCompletion flag on the draft invoice.
  if (wo.paidOnSite !== true && wo.paidOnSite !== false) {
    fails.push("Pick a payment method (Yes / No — invoice to follow).");
  }
  // Cascade-merge follow-up — brief-literal §4.6 materials gate.
  // Server-side enforces too; this mirrors so the desktop user sees
  // the specific block reason instead of getting a confusing 422.
  // Note: desktop has no "Confirm materials" button yet — Patrick can
  // tap it on tech mode for that WO, or PATCH materialsConfirmedAt
  // directly via /admin/work-order/<id> dev tooling.
  if (!wo.materialsConfirmedAt) {
    fails.push("Confirm the materials list (tap “Confirm materials list is accurate” in tech mode for this WO).");
  }
  return fails;
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

  const readinessFails = woPreSignReadinessFailures();
  if (readinessFails.length) {
    alert("Can't sign yet:\n\n• " + readinessFails.join("\n• ") + "\n\nResolve these first.");
    return;
  }

  submit.disabled = true;
  submit.textContent = "Signing & invoicing…";
  try {
    const imageData = signaturePadInstance.toDataURL();
    // Combined PATCH: signature + status → completed in one round-trip.
    // Server awaits the cascade and returns the invoice id directly.
    // arrivedAt + departedAt back-fill mirrors the tech-mode behaviour.
    const nowIso = new Date().toISOString();
    const payload = {
      signature: { customerName, imageData, acknowledgement: true },
      status: "completed"
    };
    if (!loadedWorkOrder.arrivedAt) payload.arrivedAt = nowIso;
    if (!loadedWorkOrder.departedAt) payload.departedAt = nowIso;
    const response = await fetch(`/api/work-orders/${encodeURIComponent(getWorkOrderId())}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't save signature.");
    loadedWorkOrder = data.workOrder;
    if (data.cascade && data.cascade.invoiceId) {
      completedInvoiceForBanner = data.cascade.invoiceId;
    }
    // Cascade error path (Brief: WO Field-Readiness §6.4) — signature
    // + lock persisted server-side but the cascade hit a hard error
    // mid-flight. Surface a non-blocking alert; the recovery buttons
    // (Create draft invoice now / Re-run completion cascade) below
    // the post-sig banner will be the next thing Patrick sees.
    if (data.cascade && data.cascade.error && !data.cascade.invoiceId) {
      alert(`Visit signed and locked. Invoice generation hit a snag — use the Create draft invoice or Re-run cascade buttons below to retry.\n\n(${data.cascade.error})`);
    }
    renderSignoff(data.workOrder);
    renderPostSigBanner(data.workOrder);
    renderHistory(data.workOrder);
    applyLockState(data.workOrder.locked === true, data.workOrder.signature);
    // Status dropdown reflects the new completed state.
    const woStatus = document.getElementById("woStatus");
    if (woStatus && data.workOrder.status) woStatus.value = data.workOrder.status;
  } catch (err) {
    submit.disabled = false;
    submit.textContent = "Sign, lock & generate invoice";
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
      // Photo gate may have flipped — refresh post-sig banner.
      renderPostSigBanner(wo);
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

// ---- Signature bypass modal (desktop) -------------------------------
// Same posture as tech mode's bottom sheet — reason + ≥10-char note +
// verbal-acceptance ack before Record enables. Scope-additions warning
// state swaps the body on 409 scope_additions_require_acknowledgement.
function openWoBypassModal() {
  if (!loadedWorkOrder) return;
  if (loadedWorkOrder.locked || loadedWorkOrder.signature?.signed || loadedWorkOrder.signatureBypass) return;
  const modal = document.getElementById("woBypassModal");
  if (!modal) return;
  const body = document.getElementById("woBypassBody");
  const warn = document.getElementById("woBypassWarning");
  const err = document.getElementById("woBypassError");
  if (body) body.hidden = false;
  if (warn) warn.hidden = true;
  if (err) { err.hidden = true; err.textContent = ""; }
  const ack = document.getElementById("woBypassAck");
  const warnAck = document.getElementById("woBypassWarningAck");
  if (ack) ack.checked = false;
  if (warnAck) warnAck.checked = false;
  modal.hidden = false;
  updateWoBypassSubmitState();
}

function closeWoBypassModal() {
  const modal = document.getElementById("woBypassModal");
  if (modal) modal.hidden = true;
}

function updateWoBypassSubmitState() {
  const reason = document.getElementById("woBypassReason")?.value || "";
  const note = (document.getElementById("woBypassNote")?.value || "").trim();
  const ack = !!document.getElementById("woBypassAck")?.checked;
  const submit = document.getElementById("woBypassSubmit");
  if (submit) submit.disabled = !(reason && note.length >= 10 && ack);
}

function updateWoBypassWarningSubmitState() {
  const ack = !!document.getElementById("woBypassWarningAck")?.checked;
  const btn = document.getElementById("woBypassConfirmAnyway");
  if (btn) btn.disabled = !ack;
}

async function submitWoBypass(acknowledgeWarning) {
  const id = getWorkOrderId();
  if (!id) return;
  const submitBtn = acknowledgeWarning
    ? document.getElementById("woBypassConfirmAnyway")
    : document.getElementById("woBypassSubmit");
  const errEl = document.getElementById("woBypassError");
  if (!submitBtn) return;
  const reason = document.getElementById("woBypassReason")?.value || "";
  const note = (document.getElementById("woBypassNote")?.value || "").trim();
  if (!reason || note.length < 10) {
    if (errEl) { errEl.hidden = false; errEl.textContent = "Pick a reason and write a note (≥10 chars)."; }
    return;
  }
  const orig = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Recording…";
  if (errEl) { errEl.hidden = true; errEl.textContent = ""; }

  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(id)}/signature-bypass`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, note, acknowledgeWarning: !!acknowledgeWarning })
    });
    const data = await r.json().catch(() => ({}));

    if (r.status === 409 && data?.error === "scope_additions_require_acknowledgement") {
      const body = document.getElementById("woBypassBody");
      const warn = document.getElementById("woBypassWarning");
      const warnBody = document.getElementById("woBypassWarningBody");
      if (body) body.hidden = true;
      if (warn) warn.hidden = false;
      if (warnBody && Number.isFinite(Number(data.additionCount))) {
        const total = Number(data.additionTotal) || 0;
        warnBody.textContent = `This work order has ${data.additionCount} line item${data.additionCount === 1 ? "" : "s"} beyond the baseline. Bypassing signature on a visit with added scope means the customer hasn't signed off on $${total.toFixed(2)} of additional work.`;
      }
      updateWoBypassWarningSubmitState();
      submitBtn.disabled = false;
      submitBtn.textContent = orig;
      return;
    }

    if (!r.ok || !data?.ok) {
      const msg = (data && data.errors && data.errors[0]) || "Couldn't record bypass.";
      if (errEl) { errEl.hidden = false; errEl.textContent = msg; }
      submitBtn.disabled = false;
      submitBtn.textContent = orig;
      return;
    }

    // Success — refresh the loaded WO state and re-render the sign-off
    // section so it swaps to the bypass status banner.
    loadedWorkOrder = data.workOrder;
    closeWoBypassModal();
    populateForm(loadedWorkOrder);
  } catch (err) {
    if (errEl) { errEl.hidden = false; errEl.textContent = err?.message || "Network error. Try again."; }
    submitBtn.disabled = false;
    submitBtn.textContent = orig;
  }
}

document.getElementById("woBypassOpenBtn")?.addEventListener("click", openWoBypassModal);
document.getElementById("woBypassClose")?.addEventListener("click", closeWoBypassModal);
document.getElementById("woBypassCancel")?.addEventListener("click", closeWoBypassModal);
document.getElementById("woBypassReason")?.addEventListener("change", updateWoBypassSubmitState);
document.getElementById("woBypassNote")?.addEventListener("input", updateWoBypassSubmitState);
document.getElementById("woBypassAck")?.addEventListener("change", updateWoBypassSubmitState);
document.getElementById("woBypassWarningAck")?.addEventListener("change", updateWoBypassWarningSubmitState);
document.getElementById("woBypassSubmit")?.addEventListener("click", () => submitWoBypass(false));
document.getElementById("woBypassConfirmAnyway")?.addEventListener("click", () => submitWoBypass(true));
document.getElementById("woBypassRemoteApproval")?.addEventListener("click", () => {
  closeWoBypassModal();
  const remoteBtn = document.getElementById("woOnSiteSendApprovalBtn");
  if (remoteBtn) {
    remoteBtn.scrollIntoView({ behavior: "smooth", block: "center" });
    remoteBtn.focus();
  } else {
    alert("Open the on-site quote section and tap 'Send for remote approval'.");
  }
});

init();
