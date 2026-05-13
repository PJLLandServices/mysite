// Tech-mode work order editor — mobile-first, tap-to-set, auto-save.
//
// Layout differences from the desktop editor:
//   - No Save button. Status taps fire immediately; notes save on blur
//     + on a debounced timer while typing.
//   - Run-level status is 4 big buttons (radio) instead of a dropdown.
//   - Zone list is a tap-to-open sheet so the tech can focus on one
//     zone at a time. Each row in the list shows the zone number,
//     location, current status, and a check mark when reviewed.
//   - Diagnosis + visit-notes are collapsed by default to keep the
//     scrollable surface short.
//
// Same API as the desktop page (PATCH /api/work-orders/:id).

// Build version stamp — read out loud by Patrick on the iPhone so we
// can confirm exactly which JS is running. Update in lockstep with
// tech-sw.js's CACHE_VERSION. If this string doesn't match the SW
// cache version after deploy, the iPhone is serving stale JS — clear
// website data and reload.
const TECH_BUILD_VERSION = "tech-v32";
function _setBadge(text, isError) {
  try {
    const badge = document.getElementById("techBuildBadge");
    if (!badge) return;
    badge.textContent = text;
    if (isError) {
      badge.style.background = "rgba(220,38,38,0.95)";
      badge.style.color = "#fff";
      badge.style.maxWidth = "85vw";
      badge.style.whiteSpace = "normal";
      badge.style.wordBreak = "break-word";
    }
  } catch (_e) { /* tolerate */ }
}
_setBadge(TECH_BUILD_VERSION, false);

// v22 — Global error surface. After v17/18/19/20/21 all "did nothing"
// from Patrick's perspective, the likely root cause is a JS error
// somewhere in this module that aborts execution BEFORE the photo
// upload handler attaches (line ~1900+ in this file). Without
// dev-tools access in the field, we never see those errors. This
// listener catches them and paints the message into the build badge
// so the tech can read it out — instant diagnostic without Safari
// Web Inspector. Same for unhandled promise rejections (async paths).
window.addEventListener("error", (evt) => {
  const msg = evt?.error?.message || evt?.message || "unknown error";
  const where = evt?.filename ? ` (${evt.filename.split("/").pop()}:${evt.lineno || "?"})` : "";
  console.error("[tech-js] uncaught:", evt?.error || msg);
  _setBadge(`JS ERR: ${msg}${where}`.slice(0, 200), true);
});
window.addEventListener("unhandledrejection", (evt) => {
  const reason = evt?.reason;
  const msg = (reason && reason.message) || String(reason || "unknown rejection");
  console.error("[tech-js] unhandled rejection:", reason);
  _setBadge(`PROMISE ERR: ${msg}`.slice(0, 200), true);
});

// v24 — Photos ARE uploading. The history viewer shows 6+ successful
// "Photo uploaded +1 (general)" entries proving every attempt landed
// on the server. The bug was never upload — it was the UI failing to
// refresh after upload, so from the tech's seat it looked like
// "nothing happened" while the server happily stored each photo.
//
// Quick fix: after a successful upload, hard-reload the page. The
// page re-fetches the WO and renders the photo strip from scratch
// with the new photos included. Crude (kills any unsaved typing
// in progress) but reliable. Proper fix is to debug why
// state.photos = data.workOrder.photos / renderWoPhotos() wasn't
// surfacing the new thumb — that's a follow-up.
let _photoListenerAttached = false;
function _bindPhotoUploadListener() {
  if (_photoListenerAttached) return;
  const input = document.getElementById("techWoPhotoInput");
  if (!input) return;
  _photoListenerAttached = true;
  input.addEventListener("change", async (event) => {
    const files = event.target.files;
    if (!files || !files.length) { event.target.value = ""; return; }
    const file = files[0];
    // Show an unmissable "Uploading…" overlay so the tech knows
    // something is happening. Removed on success (via reload) or
    // on error (via the catch path).
    const overlay = document.createElement("div");
    overlay.id = "techUploadOverlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(27,77,46,0.92);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;font:600 18px/1.4 system-ui,-apple-system,sans-serif;padding:24px;text-align:center;";
    overlay.innerHTML = `
      <div style="font-size:48px;margin-bottom:12px">📷</div>
      <div id="techUploadMsg">Reading photo…</div>
      <div style="opacity:0.7;margin-top:8px;font-size:14px">${file.name || ""} · ${(file.size/1_000_000).toFixed(1)} MB</div>
    `;
    document.body.appendChild(overlay);
    const setMsg = (m) => { const el = document.getElementById("techUploadMsg"); if (el) el.textContent = m; };
    function teardownOverlay() {
      const el = document.getElementById("techUploadOverlay");
      if (el) el.remove();
    }
    let base64;
    try {
      base64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(new Error("FileReader error: " + (r.error?.message || "unknown")));
        r.onload = () => {
          const s = String(r.result || "");
          const idx = s.indexOf(",");
          resolve(idx >= 0 ? s.slice(idx + 1) : s);
        };
        r.readAsDataURL(file);
      });
    } catch (err) {
      teardownOverlay();
      alert("Couldn't read the photo: " + err.message);
      event.target.value = "";
      return;
    }
    setMsg("Uploading to server…");
    const woId = (typeof state !== "undefined" && state && state.id) ? state.id : null;
    if (!woId) {
      teardownOverlay();
      alert("Page hasn't finished loading yet — wait a moment and try again.");
      event.target.value = "";
      return;
    }
    let res, data;
    try {
      res = await fetch(`/api/work-orders/${encodeURIComponent(woId)}/photos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          photos: [{
            data: base64,
            mediaType: file.type || "image/jpeg",
            category: "general",
            label: file.name || ""
          }]
        })
      });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      teardownOverlay();
      alert("Network error: " + err.message);
      event.target.value = "";
      return;
    }
    if (!res.ok) {
      teardownOverlay();
      alert(`Server rejected upload (HTTP ${res.status}): ${(data.errors && data.errors[0]) || "no error"}`);
      event.target.value = "";
      return;
    }
    // Success. Reload the page so the photo strip re-renders with the
    // new thumbnail. This is the proven path — the audit log confirms
    // uploads have been succeeding; only the in-place render was
    // failing. Reload guarantees the tech sees their photo.
    setMsg("Saved! Refreshing…");
    setTimeout(() => location.reload(), 400);
  });
}
_bindPhotoUploadListener();
document.addEventListener("DOMContentLoaded", _bindPhotoUploadListener);

// Floating photo button (v26). Same upload pipeline as the Visit-photos
// section — the FAB just triggers a programmatic click on the hidden
// file input. Visibility is managed by updateFloatingPhotoBtn() which
// gets called every time state.locked could have flipped (load,
// signature submit, server PATCH).
function _bindFloatingPhotoBtn() {
  const fab = document.getElementById("techFloatingPhotoBtn");
  if (!fab || fab.dataset.bound === "1") return;
  fab.dataset.bound = "1";
  fab.addEventListener("click", () => {
    if (typeof state !== "undefined" && state && state.locked) return;
    const input = document.getElementById("techWoPhotoInput");
    if (input) input.click();
  });
}
function updateFloatingPhotoBtn() {
  const fab = document.getElementById("techFloatingPhotoBtn");
  if (!fab) return;
  // Show once we have a WO loaded AND it isn't locked. On a fresh page
  // load (state.id not yet hydrated) keep it hidden so it doesn't
  // appear before the WO data has been fetched.
  const ready = typeof state !== "undefined" && state && state.id && !state.locked;
  fab.hidden = !ready;
}
_bindFloatingPhotoBtn();
document.addEventListener("DOMContentLoaded", _bindFloatingPhotoBtn);

const techHeader = document.getElementById("techHeader");
const techBack = document.getElementById("techBack");
const techId = document.getElementById("techId");
const techType = document.getElementById("techType");
const techCustomer = document.getElementById("techCustomer");
const techAddress = document.getElementById("techAddress");
const techMeta = document.getElementById("techMeta");
const techRunStatus = document.getElementById("techRunStatus");
const techDiagnosis = document.getElementById("techDiagnosis");
const techDiagnosisText = document.getElementById("techDiagnosisText");
const techZoneList = document.getElementById("techZoneList");
const techZonesProgress = document.getElementById("techZonesProgress");
const techEmptyZones = document.getElementById("techEmptyZones");
const techNotes = document.getElementById("techNotes");
const techMain = document.getElementById("techMain");
const techLoading = document.getElementById("techLoading");
const techError = document.getElementById("techError");
const techSaving = document.getElementById("techSaving");

const techSheet = document.getElementById("techSheet");
const sheetZoneBadgeBtn = document.getElementById("sheetZoneBadgeBtn");
const sheetLocationInput = document.getElementById("sheetLocationInput");
const sheetSprinklerPills = document.getElementById("sheetSprinklerPills");
const sheetCoveragePills = document.getElementById("sheetCoveragePills");
const sheetStatus = document.getElementById("sheetStatus");
const sheetChecks = document.getElementById("sheetChecks");
const sheetIssues = document.getElementById("sheetIssues");
const sheetIssueAdd = document.getElementById("sheetIssueAdd");
const sheetNotes = document.getElementById("sheetNotes");
const sheetClose = document.getElementById("sheetClose");
const sheetDone = document.getElementById("sheetDone");

const SPRINKLER_LABELS = { rotors: "Rotors", popups: "Pop-ups", drip: "Drip", flower_pots: "Flower Pots" };
const COVERAGE_LABELS  = { plants: "Plants", grass: "Grass", trees: "Trees", shrubs: "Shrubs" };

// Pill-toggle catalog mirrors property.js's SPRINKLER_TYPES + COVERAGE_TYPES
// so the editable bottom-sheet uses the same option list as the admin
// property editor. Spec §2.2 wording: rotors / pop-ups / drip / flower
// pots and grass / plants / trees / shrubs.
const TECH_SPRINKLER_PILLS = [
  { value: "rotors", label: "Rotors" },
  { value: "popups", label: "Pop-ups" },
  { value: "drip", label: "Drip" },
  { value: "flower_pots", label: "Flower Pots" }
];
const TECH_COVERAGE_PILLS = [
  { value: "grass", label: "Grass" },
  { value: "plants", label: "Plants" },
  { value: "trees", label: "Trees" },
  { value: "shrubs", label: "Shrubs" }
];

// Issue type catalog — labels for the per-zone issue dropdown. Keys map
// (loosely) to pricing.json categories so a future Tier-3 rollup can
// auto-price: head_replacement, manifold rebuilds, wire repairs, pipe
// break repair. "Other" is the escape hatch for anything that doesn't
// fit (custom on-site quote at the desktop side).
const ZONE_ISSUE_TYPE_OPTIONS = [
  { value: "broken_head", label: "Sprinkler head" },
  { value: "leak",        label: "Leak" },
  { value: "valve",       label: "Valve" },
  { value: "wire",        label: "Wire" },
  { value: "pipe",        label: "Pipe" },
  { value: "controller",  label: "Controller" },
  { value: "other",       label: "Other" }
];

// Cascading sub-type options. When the tech picks a primary type the
// second dropdown filters to these. Empty array = no subtype prompt
// (free-text only via the notes field). The subtype `value` flows into
// the line item label as additional specificity; the rollup engine
// keys off `type` for pricing math, so adding subtypes is purely a
// labelling refinement.
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
  // leak + other have no subtype prompt — leak rolls into the manifold
  // rule so the per-line specificity isn't actionable; other is
  // free-text by definition.
  leak:  [],
  other: []
};

// Resolve a human-readable label for an issue's type+subtype combo.
// Used by the rollup builder + the carry-forward banner so the label
// the customer sees matches the cascading dropdown the tech picked.
function issueDisplayLabel(issue) {
  if (!issue) return "Issue";
  const typeLabel = ZONE_ISSUE_TYPE_OPTIONS.find((t) => t.value === issue.type)?.label || issue.type;
  const subOpts = ZONE_ISSUE_SUBTYPE_OPTIONS[issue.type] || [];
  const subLabel = subOpts.find((s) => s.value === issue.subtype)?.label;
  if (subLabel && issue.subtype) return subLabel;
  return typeLabel;
}

const ZONE_CHECK_KEYS = ["operated", "pressureGood", "coverageGood", "noLeaks", "allHeadsFunctional"];

// Service-specific checklist definitions per spec §4.3.2. Mirrors
// SERVICE_CHECKLISTS in server/lib/work-orders.js — keep these in sync
// if step keys change. Service visits have no checklist (one-off
// repairs use the zone walk-through + tech notes only).
//
// Backflow intentionally NOT in this list — PJL is not a certified
// Ontario backflow tester (memory/backflow_not_certified.md).
const SERVICE_CHECKLISTS_TECH = {
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

const ZONE_STATUS_LABELS = {
  working_well:    "Working well",
  adjusted:        "Adjusted",
  repair_required: "Repair required",
  other:           "Other"
};

const TYPE_LABELS = {
  spring_opening: "Spring Opening",
  fall_closing:   "Fall Closing",
  service_visit:  "Service Visit"
};

// Local state — the source of truth for what we'll PATCH back. The UI
// rerenders from this on every change so optimistic updates stay
// consistent without a full reload.
let state = {
  id: "",
  type: "service_visit",
  status: "scheduled",
  techNotes: "",
  zones: [],
  serviceChecklist: {},
  signature: { signed: false, customerName: "", imageData: "", acknowledgement: false, signedAt: null },
  photos: [],
  locked: false,
  intakeGuarantee: { applies: false, scope: "", sourceQuoteId: null },
  // On-site Quote state. `builderLineItems` mirrors wo.onSiteQuote.builderLineItems.
  // `decisions` tracks per-line accept/decline during customer review (default all true).
  // `uiMode` flips between builder / review / submitted in the SAME section.
  onSiteQuote: { quoteId: null, status: "none", builderLineItems: [] },
  onSiteDecisions: [],
  onSiteUiMode: "builder",
  onSiteSigPad: null,
  // Tracks which zone the bottom sheet is currently editing.
  activeZoneIndex: -1,
  // Pending PATCH timer for debounced notes-while-typing.
  notesTimer: null,
  zoneNotesTimer: null,
  // Debounce timer for issue-row qty/notes typing inside the sheet.
  // Type selects fire immediately on change (no debounce needed).
  issueInputTimer: null,
  // Debounce timer for builder line edits.
  onSiteBuilderTimer: null,
  // Signature pad helper (set after init).
  signaturePad: null,
  // Customer info — pulled from WO snapshot at load, used by Cheat Sheet
  // and Remote Approval helper. Property record overrides if present.
  customerName: "",
  customerEmail: "",
  customerPhone: "",
  // Payment captured on-site? null = unset, true = paid, false = invoice
  // to follow. Read by the cascade to flag the draft invoice and shape
  // the customer email copy (spec §4.3.2 Payment & Billing).
  paidOnSite: null,
  // Return-visit decision (v27, Patrick's service-call flow). Same
  // tri-state shape as paidOnSite. true = need to come back, drives
  // visibility of the Parts-to-bring-back + Schedule-follow-up
  // sections. false = visit closes today. null = forces pre-sign gate.
  needsReturnVisit: null,
  // On-site execution timestamps — auto-stamped on status flip to
  // on_site / completed (spec §4.3.2 On-Site Execution).
  arrivedAt: null,
  departedAt: null,
  // Cached parts.json catalog (loaded once on init for the materials checklist).
  partsCatalog: null,
  serviceMaterials: null,
  // Linked property record — stashed on WO load so the zone source-picker
  // can offer the customer's actual zones / valve boxes / controller /
  // open issues as label sources for the auto-scaffolded "General service
  // area" placeholder. null when the WO has no property link.
  linkedProperty: null
};

// Cached geolocation result so we only prompt once per page load. null
// after a denial, object after a grant. Watermark + upload calls await
// this — it returns null fast on subsequent invocations (no re-prompt).
let _cachedGeo = undefined; // undefined = not yet asked

// Returns the cached geo (or null) IMMEDIATELY without prompting.
// Watermark uses this — never block the upload on a geo permission
// prompt. The prompt is annoying every page load (iOS quirk) AND it
// breaks the file-picker flow when it interrupts mid-upload. Geo
// is a nice-to-have watermark, not a requirement.
function getCachedGeoSync() {
  return _cachedGeo === undefined ? null : _cachedGeo;
}

// Fire-and-forget geo prefetch on page load. Resolves _cachedGeo so
// later upload calls find it. NEVER awaited from the upload path —
// upload proceeds immediately whether geo is cached or not.
// enableHighAccuracy disabled (cellular triangulation is enough for
// a watermark "where was this photo taken" tag, and high-accuracy
// triggers GPS which prompts more aggressively on iOS).
function prefetchGeoInBackground() {
  if (_cachedGeo !== undefined) return;
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
    _cachedGeo = null;
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      _cachedGeo = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      };
    },
    () => { _cachedGeo = null; },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 3_600_000 }
  );
}

// Burn a watermark strip onto a canvas. Bottom-right corner, semi-
// transparent dark background, 2-3 lines of text. Once burned the
// metadata can't be casually edited out — protects PJL on warranty
// claims + customer disputes.
function applyPjlWatermark(canvas, ctx, lines) {
  const visible = lines.filter(Boolean);
  if (!visible.length) return;
  const w = canvas.width;
  const h = canvas.height;
  const fontSize = Math.max(14, Math.round(h * 0.024));
  const padding = Math.round(fontSize * 0.6);
  const lineH = Math.round(fontSize * 1.3);
  const stripH = lineH * visible.length + padding * 2;
  // Width sized to the longest line; capped at 60% of image width.
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

// Format a Date for the watermark stamp — local-time short form.
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

// Resize + watermark a captured image. Returns a base64-encoded JPEG
// plus the geo + takenAt metadata that the server should also persist.
async function processPhotoForUpload(file, opts = {}) {
  const geo = opts.geo;
  const takenAt = opts.takenAt || new Date();
  const watermarkLines = [
    `PJL · ${formatStamp(takenAt)}`,
    formatGeoStamp(geo),
    [opts.woId, opts.seqLabel].filter(Boolean).join(" · ")
  ];
  // Wrap everything in a 30 s timeout so a stuck decode surfaces a
  // clear error instead of leaving "Uploading…" indefinitely. Race
  // against the timer.
  const timeoutPromise = new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(
      "Photo processing timed out (30 s). The file may be too large or in an unsupported format — try a smaller export, or take a fresh photo."
    )), 30_000);
  });
  return Promise.race([
    doProcessPhoto(file, watermarkLines),
    timeoutPromise
  ]);
}

// Inner decode → resize → watermark → encode. iOS Safari fix: prefer
// createImageBitmap (decodes natively, handles 48 MP HEIC without the
// data-URL + Image() hang the old path suffered from). Falls back to
// the Image + createObjectURL path on older browsers.
async function doProcessPhoto(file, watermarkLines) {
  let bitmap = null;
  let objectUrl = null;
  try {
    // Path A — createImageBitmap. Supported by iOS Safari 15+; the
    // iOS-recommended API for decoding large camera photos. Avoids the
    // Image/onload silent-hang issue entirely.
    if (typeof createImageBitmap === "function") {
      try {
        bitmap = await createImageBitmap(file);
      } catch (err) {
        console.warn("[photo] createImageBitmap failed, falling back:", err?.message);
        bitmap = null;
      }
    }
    // Path B — fallback. Image + blob: URL. Slightly worse on big HEICs
    // but still avoids the >10 MB data-URL trap.
    if (!bitmap) {
      objectUrl = URL.createObjectURL(file);
      bitmap = await new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = "async";
        img.onerror = () => reject(new Error("Couldn't decode that image. Try a different file or convert to JPEG."));
        img.onload = () => resolve(img);
        img.src = objectUrl;
      });
    }
    const sourceW = bitmap.width || bitmap.naturalWidth || 0;
    const sourceH = bitmap.height || bitmap.naturalHeight || 0;
    if (!sourceW || !sourceH) {
      throw new Error("Image has no readable dimensions. Try a different file.");
    }
    const longest = Math.max(sourceW, sourceH);
    const scale = longest > 1280 ? 1280 / longest : 1;
    const w = Math.max(1, Math.round(sourceW * scale));
    const h = Math.max(1, Math.round(sourceH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    applyPjlWatermark(canvas, ctx, watermarkLines);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    const base64 = dataUrl.split(",", 2)[1] || "";
    if (!base64) throw new Error("Couldn't encode the resized image.");
    return { base64, mediaType: "image/jpeg" };
  } finally {
    // Memory hygiene — close the ImageBitmap (frees native bitmap
    // memory immediately instead of waiting for GC) and revoke the
    // blob URL.
    if (bitmap && typeof bitmap.close === "function") {
      try { bitmap.close(); } catch { /* tolerate */ }
    }
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch { /* tolerate */ }
    }
  }
}

// Upload one or more files to /api/work-orders/:id/photos. `meta` is
// any additional fields (category, zoneNumber, issueId, label) that get
// attached to each uploaded record. Brief: WO Field-Readiness §5 widens
// the accepted set:
//   - JPEG/PNG/WebP/GIF → resized + watermarked client-side (existing
//     path), upload as JPEG ~1280px longest edge.
//   - HEIC/HEIF → resized + watermarked via canvas (iOS Safari decodes
//     HEIC natively; other browsers can't, so we fall back to sending
//     raw bytes and let the server store as HEIC).
//   - PDF → no canvas processing possible. Sent as raw base64.
// Per-file 25 MB cap enforced client-side too so the 30 MB→server
// rejection isn't the only line of defence (saves the round-trip).
const WO_MAX_UPLOAD_BYTES = 25_000_000;
const WO_PROCESSABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const WO_ALLOWED_UPLOAD_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif", "application/pdf"
]);

// v20 — readAsArrayBuffer instead of readAsDataURL. Patrick reported v19
// hangs on "Reading 1/1…" indefinitely (the FileReader stage). The
// suspicion: readAsDataURL has to allocate a giant string (base64 +
// data URL prefix) and iOS Safari can stall on that for large iCloud-
// backed HEICs. ArrayBuffer is the lower-level path — same data, no
// string encoding inside FileReader — and we do the base64 conversion
// ourselves in chunks. Bonus: progress events are reliable on the
// ArrayBuffer path; surface "Reading … 47%" so the tech can see motion
// instead of a frozen label. Also adds an explicit 60 s timeout so a
// genuine hang surfaces an actionable error instead of forever-spin.
function readFileAsBase64(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { reader.abort(); } catch (_e) { /* tolerate */ }
      reject(new Error(
        `Reading "${file.name || "file"}" timed out after 60 s. If this is an iCloud photo, open the Photos app and tap the image first so it downloads, then retry.`
      ));
    }, 60_000);
    reader.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Couldn't read "${file.name || "file"}": ${reader.error?.message || "unknown error"}`));
    };
    reader.onabort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("File read was aborted."));
    };
    reader.onprogress = (evt) => {
      if (!onProgress || !evt.lengthComputable) return;
      onProgress(evt.loaded / evt.total);
    };
    reader.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const buf = reader.result;
        if (!buf || !(buf instanceof ArrayBuffer)) {
          throw new Error("FileReader produced no ArrayBuffer.");
        }
        // Convert ArrayBuffer → base64 in chunks. Doing it as one big
        // String.fromCharCode(...new Uint8Array(buf)) blows the JS stack
        // for files >~64 KB. 8 KB chunks are well under any iOS limit.
        const bytes = new Uint8Array(buf);
        const chunkSize = 8192;
        let binary = "";
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
          binary += String.fromCharCode.apply(null, slice);
        }
        resolve(btoa(binary));
      } catch (err) {
        reject(err);
      }
    };
    try {
      reader.readAsArrayBuffer(file);
    } catch (err) {
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Couldn't start reading "${file.name || "file"}": ${err?.message || "unknown error"}`));
    }
  });
}

// Surfaces a per-stage status string on the photo-add label so the
// tech (and the dev debugging this) can see exactly which step is
// running. Replaces the silent "Uploading…" forever-spinner with
// "Reading 1/3…", "Sending 12 MB…", etc.
function setUploadStatus(text) {
  document.querySelectorAll(".tech-photo-add, .tech-issue-photo-add").forEach((el) => {
    const label = el.querySelector("span:last-child");
    if (label && el.classList.contains("is-uploading")) {
      label.textContent = text || "Uploading…";
    }
  });
}

async function uploadWoPhotos(files, meta = {}) {
  const arr = Array.from(files || []);
  if (!arr.length) return null;
  // v19 simplification — strip ALL client-side processing. Previous
  // versions tried to resize + watermark + re-encode via canvas, which
  // hung iOS Safari on big iPhone HEICs (data URL size limit, then
  // bitmap memory OOM even with createImageBitmap). The server already
  // accepts raw HEIC/PDF/JPEG/PNG/WebP/GIF, verifies magic bytes, and
  // caps at 25 MB per file — same protections, fewer client moving
  // parts. Watermarking can be added back server-side later if needed
  // (it was a warranty-protection nice-to-have, not a hard requirement).
  const geo = getCachedGeoSync();
  const photos = [];
  for (let i = 0; i < arr.length; i++) {
    const f = arr[i];
    const sizeMb = (f.size / 1_000_000).toFixed(1);
    setUploadStatus(`Reading ${i + 1}/${arr.length} · ${sizeMb} MB…`);
    const fileType = (f.type || "").toLowerCase();
    if (!fileType || !WO_ALLOWED_UPLOAD_TYPES.has(fileType)) {
      const lowerName = (f.name || "").toLowerCase();
      const heicByExt = lowerName.endsWith(".heic") || lowerName.endsWith(".heif");
      const pdfByExt = lowerName.endsWith(".pdf");
      if (!heicByExt && !pdfByExt) {
        throw new Error(`Unsupported file type${fileType ? ` "${fileType}"` : ""}. Allowed: JPEG, PNG, HEIC, WebP, GIF, PDF.`);
      }
    }
    if (f.size > WO_MAX_UPLOAD_BYTES) {
      const fileMb = (f.size / 1_000_000).toFixed(1);
      throw new Error(`File too large — 25 MB max (this one is ${fileMb} MB).`);
    }
    let resolvedType = fileType;
    if (!resolvedType) {
      const lowerName = (f.name || "").toLowerCase();
      if (lowerName.endsWith(".heic")) resolvedType = "image/heic";
      else if (lowerName.endsWith(".heif")) resolvedType = "image/heif";
      else if (lowerName.endsWith(".pdf")) resolvedType = "application/pdf";
      else resolvedType = "image/jpeg"; // safe default
    }
    // Read RAW bytes. Server handles the storage + format detection.
    // onProgress surfaces "Reading 1/1 · 12.3 MB · 47%…" so a slow read
    // (iCloud download, large HEIC) shows motion instead of a dead spin.
    const base64 = await readFileAsBase64(f, (pct) => {
      const pctStr = Math.round(pct * 100);
      setUploadStatus(`Reading ${i + 1}/${arr.length} · ${sizeMb} MB · ${pctStr}%…`);
    });
    if (!base64) throw new Error(`Couldn't read "${f.name || "file"}" — got 0 bytes.`);
    setUploadStatus(`Sending ${i + 1}/${arr.length}…`);
    photos.push({
      data: base64,
      mediaType: resolvedType,
      geo: geo || null,
      takenAt: new Date().toISOString(),
      ...meta,
      label: meta.label || f.name || ""
    });
  }
  if (!photos.length) return null;
  // Photo bodies are base64-encoded JSON (not multipart), so they fit
  // through the existing offline queue. When the tech is in the field
  // with no signal, the upload gets staged in IndexedDB and replays
  // on reconnect — no lost photos.
  const fetchFn = (window.PJLOffline && window.PJLOffline.queuedFetch) || fetch;
  // 90 s upload timeout — slow cellular can take a while for a 5 MB
  // PDF, but anything longer is almost certainly hung (browser default
  // is "wait forever"). AbortController surfaces a network error to
  // the catch block above, which clears the "Uploading…" state.
  const controller = new AbortController();
  const uploadTimeout = setTimeout(() => controller.abort(), 90_000);
  let response;
  try {
    response = await fetchFn(`/api/work-orders/${encodeURIComponent(state.id)}/photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photos }),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(uploadTimeout);
    if (err && err.name === "AbortError") {
      throw new Error("Upload timed out (90 s). The file may be too large for the current connection — try a smaller export or retry on Wi-Fi.");
    }
    throw err;
  }
  clearTimeout(uploadTimeout);
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !data.queued) {
    throw new Error((data.errors && data.errors[0]) || "Couldn't upload photo.");
  }
  // Queued path returns 202 with { ok: true, queued: true } — no
  // workOrder echo. Caller renders optimistically from local state;
  // the replay will produce the canonical record on next refresh.
  return data.workOrder || null;
}

async function deleteWoPhoto(n) {
  const response = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}/photos/${n}`, {
    method: "DELETE"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error((data.errors && data.errors[0]) || "Couldn't delete photo.");
  }
  return data.workOrder;
}

function woPhotoUrl(n) {
  return `/api/work-orders/${encodeURIComponent(state.id)}/photo/${n}`;
}

function countChecks(checks) {
  if (!checks || typeof checks !== "object") return 0;
  return ZONE_CHECK_KEYS.reduce((n, k) => n + (checks[k] ? 1 : 0), 0);
}

function issueTypeLabel(value) {
  const found = ZONE_ISSUE_TYPE_OPTIONS.find((t) => t.value === value);
  return found ? found.label : "Issue";
}

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
  // /admin/work-order/<id>/tech
  const parts = window.location.pathname.split("/").filter(Boolean);
  // ["admin", "work-order", "<id>", "tech"]
  return parts[2] ? decodeURIComponent(parts[2]) : "";
}

// ---- Save (PATCH) -------------------------------------------------

let inflight = 0;
function showSaving() {
  inflight += 1;
  techSaving.hidden = false;
  techSaving.textContent = "Saving…";
}
function hideSaving(err) {
  inflight = Math.max(0, inflight - 1);
  if (inflight > 0) return;
  if (err) {
    techSaving.hidden = false;
    techSaving.textContent = "Save failed";
    setTimeout(() => { if (!inflight) techSaving.hidden = true; }, 2500);
  } else {
    techSaving.textContent = "Saved";
    setTimeout(() => { if (!inflight) techSaving.hidden = true; }, 1200);
  }
}

async function patchWorkOrder(payload) {
  const id = state.id;
  if (!id) return;
  showSaving();
  try {
    // Optimistic concurrency — send the last-known updatedAt as
    // If-Match so the server can detect "this WO moved on while you
    // were editing." 409 → showConflictBanner() prompts the tech to
    // reload before they accidentally overwrite a co-tech's save.
    const headers = { "Content-Type": "application/json" };
    if (state.updatedAt) headers["If-Match"] = state.updatedAt;
    const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && data.error === "version_conflict") {
      showConflictBanner(data.currentVersion);
      hideSaving();
      return;
    }
    if (!response.ok || !data.ok) {
      throw new Error((data.errors && data.errors[0]) || `Save failed (HTTP ${response.status}).`);
    }
    if (data.workOrder) {
      // Reflect the server's normalized state (e.g. updatedAt). We don't
      // overwrite zones from the server unless we sent zones — otherwise
      // an in-flight notes-debounce save could clobber a status tap that
      // happened mid-flight.
      if ("status" in payload)    state.status = data.workOrder.status;
      if ("techNotes" in payload) state.techNotes = data.workOrder.techNotes;
      if ("zones" in payload) {
        state.zones = data.workOrder.zones;
        // Re-render any UI that derives from zones so server-normalized
        // state (issue ids confirmed, arrays sorted, anything the server
        // rewrote) is visible without a page reload. Brief: WO Field-
        // Readiness §4 — "create an issue, new issue appears in the
        // zone's issue list immediately, no page reload."
        if (typeof renderZones === "function") renderZones();
        if (state.activeZoneIndex >= 0 && typeof renderSheetIssues === "function") {
          const liveZone = state.zones[state.activeZoneIndex];
          if (liveZone) renderSheetIssues(liveZone);
        }
        if (typeof renderOnSiteQuote === "function") renderOnSiteQuote();
        // Walk-out / pre-sign readiness depends on zone status + issue
        // counts — refresh the gating list too.
        if (typeof updateSignoffSubmitState === "function") updateSignoffSubmitState();
      }
      if ("photos" in payload) {
        state.photos = data.workOrder.photos || [];
      }
      // Always track the latest updatedAt as the local version so the
      // next PATCH's If-Match header reflects "I just saw this version".
      if (data.workOrder.updatedAt) state.updatedAt = data.workOrder.updatedAt;
      techMeta.textContent = `Updated ${formatDateTime(data.workOrder.updatedAt)}`;
    }
    hideSaving();
  } catch (err) {
    hideSaving(err);
  }
}

// Show a "this WO was updated elsewhere" banner with a reload button.
// Renders into a fixed bar at the top of the page; reuses the offline
// banner styling for visual consistency.
let conflictBannerShown = false;
function showConflictBanner(/* currentVersion */) {
  if (conflictBannerShown) return;
  conflictBannerShown = true;
  const bar = document.createElement("div");
  bar.id = "techConflictBanner";
  bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:1500;padding:14px 18px;background:#fef6e6;border-bottom:2px solid #d6a800;color:#6b4e00;font-size:14px;display:flex;align-items:center;justify-content:space-between;gap:12px;box-shadow:0 2px 8px rgba(0,0,0,0.08);";
  bar.innerHTML = `
    <div><strong>⚠️ Another save happened on this work order while you were editing.</strong> Reload to see the latest before continuing — otherwise your next save could overwrite their changes.</div>
    <button type="button" id="techConflictReload" style="padding:8px 16px;background:#1B4D2E;color:#fff;border:none;border-radius:6px;cursor:pointer;font:inherit;font-weight:600;">Reload now</button>
  `;
  document.body.appendChild(bar);
  document.getElementById("techConflictReload").addEventListener("click", () => location.reload());
}

// ---- Run-level status (radio buttons) ---------------------------
// Two surfaces share this state: the top "Visit status" block (Scheduled
// / On site) and the bottom "Finish the visit" sticky bar (Awaiting
// approval / Completed). Pressed-state + click handlers iterate ALL
// elements with [data-run-status] so the two surfaces stay in sync.

function renderRunStatus() {
  document.querySelectorAll("[data-run-status]").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.dataset.runStatus === state.status ? "true" : "false");
  });
}

// Spec §4.3.3 rule #3 — status transitions forward-only. Skips allowed,
// reverses not. Cancelled / no_show terminal (rule #7). The order array
// is the canonical sequence; same enum is enforced server-side too.
const STATUS_ORDER = ["scheduled", "dispatched", "en_route", "on_site", "in_progress", "awaiting_approval", "completed"];
const STATUS_TERMINAL = new Set(["completed", "cancelled", "no_show"]);

function statusRank(s) {
  const i = STATUS_ORDER.indexOf(s);
  return i === -1 ? -1 : i;
}

document.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-run-status]");
  if (!btn) return;
  const next = btn.dataset.runStatus;
  if (next === state.status) return;

  // Forward-only guard
  const fromRank = statusRank(state.status);
  const toRank = statusRank(next);
  if (fromRank !== -1 && toRank !== -1 && toRank < fromRank) {
    alert(`Status only moves forward. You can't roll back from "${state.status}" to "${next}".`);
    return;
  }
  if (STATUS_TERMINAL.has(state.status)) {
    alert(`This visit is in a terminal state (${state.status}) and can't change.`);
    return;
  }

  // Walk-out checklist before "Completed" — spec §4.3.3 rule #14.
  // Blocks completion if signature missing, zones not all touched, or
  // open carry-forward items still need a tech action. Replaces the
  // earlier confirm() dialog.
  if (next === "completed") {
    const failures = walkoutCheckFailures();
    if (failures.length) {
      alert("Can't complete yet:\n\n• " + failures.join("\n• ") + "\n\nResolve these and try again.");
      return;
    }
    if (!confirm("All checks pass. Mark this visit completed? Creates a service record on the property and a draft invoice from the authorized line items.")) return;
  }

  // Arrival / departure auto-stamps (spec §4.3.2 On-Site Execution).
  const patch = { status: next };
  if (next === "on_site" && !state.arrivedAt) {
    patch.arrivedAt = new Date().toISOString();
    state.arrivedAt = patch.arrivedAt;
  }
  if (next === "completed" && !state.departedAt) {
    patch.departedAt = new Date().toISOString();
    state.departedAt = patch.departedAt;
  }
  state.status = next;
  renderRunStatus();
  renderExecutionTimestamps();
  renderPostSigBanner();
  patchWorkOrder(patch);

  // Post-completion: cascade fires fire-and-forget on the server. After
  // a short delay, look up the draft invoice we just created and surface
  // its ID in the banner so the tech sees the immediate result. Skip on
  // any other status flip.
  if (next === "completed" && state.id) {
    setTimeout(async () => {
      try {
        const r = await fetch(`/api/invoices?woId=${encodeURIComponent(state.id)}`);
        const data = await r.json().catch(() => ({}));
        const inv = data && data.ok && Array.isArray(data.invoices) ? data.invoices[0] : null;
        if (inv && inv.id) {
          state.completedInvoiceId = inv.id;
          renderPostSigBanner();
        }
      } catch (_e) {}
    }, 1500);
  }
});

// Mirror of lib's PHOTO_REQUIREMENT_BY_TYPE (Brief E / spec §4.3.2).
// Keep in sync with server/lib/work-orders.js — if the threshold per
// type changes, update both. Fall closings stay optional because
// winterized systems often have nothing visible to photograph.
const TECH_PHOTO_REQUIREMENT_BY_TYPE = {
  spring_opening: 1,
  service_visit:  1,
  fall_closing:   0
};

// Walk-out checklist — returns an array of human-readable failure reasons.
// Empty = green light to complete. Spec §4.3.3 rule #14.
function walkoutCheckFailures() {
  const fails = [];
  // Signature captured?
  if (!state.signature?.signed) {
    fails.push("Customer hasn't signed off yet (use the Customer sign-off section).");
  }
  // All zones touched? "Touched" = has a status set, or has at least one
  // standard check ticked. Empty zone status with all checks blank = not
  // touched.
  const untouched = (state.zones || []).filter((z) => {
    if (z.status && z.status !== "") return false;
    const checks = z.checks || {};
    return !Object.values(checks).some(Boolean);
  });
  if (untouched.length) {
    fails.push(`${untouched.length} zone${untouched.length === 1 ? "" : "s"} haven't been checked yet (zones ${untouched.map((z) => z.number).join(", ")}).`);
  }
  // Open carry-forward items pending a tech decision — only checked on
  // spring openings since that's where the banner shows.
  if (state.type === "spring_opening") {
    const openCfCards = document.querySelectorAll('#techCarryForwardList [data-deferred-id]');
    if (openCfCards.length) {
      fails.push(`${openCfCards.length} carry-forward recommendation${openCfCards.length === 1 ? "" : "s"} still need an action (Repair / Decline / Already fixed / Can't locate).`);
    }
  }
  // Completion photo gate (Brief E). find_only (fall_closing) = 0 (optional);
  // find_and_fix / fix_only = 1+ photo required as proof of work.
  const minPhotos = TECH_PHOTO_REQUIREMENT_BY_TYPE[state.type] ?? 1;
  if (minPhotos > 0) {
    const photoCount = Array.isArray(state.photos) ? state.photos.length : 0;
    if (photoCount < minPhotos) {
      fails.push(`Capture ${minPhotos === 1 ? "at least one completion photo" : `at least ${minPhotos} completion photos`} before marking complete.`);
    }
  }
  return fails;
}

// Render arrival/departure timestamps in the On-Site Execution section.
function renderExecutionTimestamps() {
  const arrived = document.getElementById("techArrivedAt");
  const departed = document.getElementById("techDepartedAt");
  if (arrived) arrived.textContent = state.arrivedAt ? formatDateTime(state.arrivedAt) : "—";
  if (departed) departed.textContent = state.departedAt ? formatDateTime(state.departedAt) : "—";
}

// ---- Zone list (cards) ------------------------------------------

function statusDotClass(status) {
  switch (status) {
    case "working_well":    return "is-good";
    case "adjusted":        return "is-warn";
    case "repair_required": return "is-bad";
    case "other":           return "is-neutral";
    default:                return "";
  }
}

function badgeListHtml(values, lookup) {
  if (!values || !values.length) return "";
  return values
    .map((v) => `<span class="tech-badge">${escapeHtml(lookup[v] || v)}</span>`)
    .join("");
}

function renderZones() {
  techZoneList.innerHTML = "";
  if (!state.zones.length) {
    techEmptyZones.hidden = false;
    techZonesProgress.textContent = "0 / 0";
    return;
  }
  techEmptyZones.hidden = true;

  const reviewed = state.zones.filter((z) => z.status).length;
  techZonesProgress.textContent = `${reviewed} / ${state.zones.length}`;

  state.zones
    .map((z, i) => ({ z, i }))
    .sort((a, b) => (a.z.number || 0) - (b.z.number || 0))
    .forEach(({ z, i }) => {
      const li = document.createElement("li");
      li.className = "tech-zone-item";
      li.dataset.index = String(i);
      li.dataset.status = z.status || "";
      const reviewedTag = z.status ? `<span class="tech-zone-status-tag">${escapeHtml(ZONE_STATUS_LABELS[z.status] || z.status)}</span>` : "";
      // Walk-through evidence tags — show on the zone-list card so the
      // tech can scan progress without opening each sheet. The checks
      // tag only renders once at least one check is ticked (no "0/5
      // checks" noise on first load).
      const checksDone = countChecks(z.checks);
      const checksTag = checksDone > 0
        ? `<span class="tech-zone-checks-tag" data-full="${checksDone === 5 ? "1" : "0"}">${checksDone}/5 checks</span>`
        : "";
      const issueCount = Array.isArray(z.issues) ? z.issues.length : 0;
      const issuesTag = issueCount > 0
        ? `<span class="tech-zone-issues-tag">${issueCount} issue${issueCount === 1 ? "" : "s"}</span>`
        : "";
      li.innerHTML = `
        <button type="button" class="tech-zone-item-btn" data-open-zone="${i}">
          <span class="tech-zone-num">${escapeHtml(zoneBadgeLabel(z).replace(/^Zone /, ""))}</span>
          <span class="tech-zone-body">
            <span class="tech-zone-location">${escapeHtml(z.location || "(unnamed)")}</span>
            <span class="tech-zone-tags">
              ${reviewedTag}
              ${checksTag}
              ${issuesTag}
            </span>
            ${z.notes ? `<span class="tech-zone-notes-preview">${escapeHtml(z.notes)}</span>` : ""}
          </span>
          <span class="tech-zone-dot ${statusDotClass(z.status)}" aria-hidden="true"></span>
        </button>
      `;
      techZoneList.appendChild(li);
    });
}

techZoneList.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-open-zone]");
  if (!btn) return;
  const idx = Number(btn.dataset.openZone);
  if (!Number.isInteger(idx)) return;
  openZoneSheet(idx);
});

// "+ Add zone" — appends a new blank zone to state, persists, then opens
// the edit sheet so the tech can rename it without a second tap. Auto-
// numbered at max-existing + 1 so spring/fall sweeps stay sequential.
// Brief Hot — debounce against rapid double-tap on iPhone (Patrick saw
// the button felt unresponsive; idempotency guard ensures one tap = one
// zone even if the touch event fires twice). Disable for ~600 ms across
// the PATCH round-trip, then re-enable.
const techAddZoneBtn = document.getElementById("techAddZoneBtn");

// v32 — Styled zone-number dialog. Replaces both window.prompt() (ugly
// browser system UI, sometimes blocked in iOS PWAs) and the inline
// #techZonePicker DOM (which silently went missing on Patrick's
// iPhone for unknown reasons). The dialog is built on the fly,
// appended to document.body, and resolves a Promise with either the
// zone number (1-99) or null on cancel. Branded styling: Barlow
// Condensed heading, PJL green CTA. Works regardless of HTML cache
// state or PWA install state.
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

// v30 — Zone picker, ANY zone number. Patrick's actual workflow:
// service call for Zone 3 pipe break + Zone 8 sprinkler head off +
// Zone 12 sprinkler head broken. Tech goes zone-by-zone, picking
// specific non-consecutive numbers (3, then 8, then 12). The picker
// supports two paths and ALWAYS lets the tech enter any zone number:
//   • Tap a row from the property's known zone profile (auto-fills
//     location / sprinkler types / coverage from the property record).
//   • Type any number 1–99 into the input → "Add zone" (covers new
//     properties without zones in profile, and zones the profile
//     doesn't know about).
// Crucially: NO sequential auto-numbering. The tech picks the actual
// number every time. New-property zones flow back to the property
// profile via the existing completion cascade (newZones).
function openZonePicker() {
  const picker = document.getElementById("techZonePicker");
  const numInput = document.getElementById("techZonePickerNumber");
  // BULLETPROOF FALLBACK (v32). If the picker DOM is missing — stale
  // HTML cache or iOS PWA prompt-block — fall back to the styled
  // in-app dialog. Always works, brand-consistent UI (no browser
  // system prompt).
  if (!picker || !numInput) {
    showZoneNumberDialog().then((n) => {
      if (n != null) addZoneAndOpen(n);
    });
    return;
  }
  const knownWrap = document.getElementById("techZonePickerKnown");
  const list = document.getElementById("techZonePickerList");
  const propertyZones = (state.linkedProperty && state.linkedProperty.system && Array.isArray(state.linkedProperty.system.zones))
    ? state.linkedProperty.system.zones : [];
  const onWoNumbers = new Set((state.zones || []).map((z) => Number(z.number)).filter(Boolean));
  const candidates = propertyZones
    .filter((pz) => pz && Number(pz.number) > 0 && !onWoNumbers.has(Number(pz.number)))
    .sort((a, b) => Number(a.number) - Number(b.number));
  if (candidates.length && knownWrap && list) {
    knownWrap.hidden = false;
    list.innerHTML = candidates.map((pz) => {
      const n = Number(pz.number);
      const loc = String(pz.location || pz.label || `Zone ${n}`);
      return `<li>
        <button type="button" class="tech-zone-pick-row" data-zone-number="${n}"
          style="width:100%;display:flex;align-items:center;gap:12px;padding:14px 14px;background:#fff;border:1px solid #e0ddd1;border-radius:6px;cursor:pointer;text-align:left;font:inherit;">
          <strong style="font-size:15px;flex-shrink:0;min-width:60px;color:#1B4D2E;">Zone ${n}</strong>
          <span style="font-size:13px;color:#444;flex:1;">${escapeHtml(loc)}</span>
          <span aria-hidden="true" style="font-size:18px;color:#1B4D2E;flex-shrink:0;">→</span>
        </button>
      </li>`;
    }).join("");
  } else if (knownWrap) {
    // Property has no zones (or all already on WO) — hide the known
    // list, lean entirely on the number input. The tech can still
    // add any zone they want.
    knownWrap.hidden = true;
    if (list) list.innerHTML = "";
  }
  if (numInput) numInput.value = "";
  picker.hidden = false;
  picker.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (numInput) numInput.focus();
}

function closeZonePicker() {
  const picker = document.getElementById("techZonePicker");
  if (picker) picker.hidden = true;
}

// Add a specific zone number to the WO. Pulls metadata from the
// linked property's zone record when one exists for that number;
// otherwise the zone starts with just its number + location text
// "Zone N" for the tech to fill in. NO sequential auto-numbering.
// Always opens the new zone's edit sheet immediately.
function addZoneAndOpen(zoneNumber) {
  const n = Number(zoneNumber);
  if (!n || n < 1 || n > 99) {
    alert("Zone number must be between 1 and 99.");
    return;
  }
  const existingNumbers = new Set((state.zones || []).map((z) => Number(z.number)).filter(Boolean));
  if (existingNumbers.has(n)) {
    alert(`Zone ${n} is already on this work order — open it from the zones list above to edit.`);
    return;
  }
  const propertyZones = (state.linkedProperty && state.linkedProperty.system && Array.isArray(state.linkedProperty.system.zones))
    ? state.linkedProperty.system.zones : [];
  const pz = propertyZones.find((p) => Number(p.number) === n);
  const blankChecks = {};
  for (const k of ZONE_CHECK_KEYS) blankChecks[k] = false;
  state.zones.push({
    number: n,
    kind: "zone",
    location: pz ? (pz.location || pz.label || `Zone ${n}`) : `Zone ${n}`,
    sprinklerTypes: (pz && Array.isArray(pz.sprinklerTypes)) ? pz.sprinklerTypes.slice() : [],
    coverage: (pz && Array.isArray(pz.coverage)) ? pz.coverage.slice() : [],
    status: "",
    notes: "",
    checks: { ...blankChecks },
    issues: []
  });
  renderZones();
  patchWorkOrder({ zones: state.zones });
  closeZonePicker();
  const idx = state.zones.findIndex((z) => Number(z.number) === n);
  if (idx >= 0) openZoneSheet(idx);
}

// v32 — Event delegation. Direct binding `techAddZoneBtn?.addEventListener`
// silently no-ops when techAddZoneBtn is null at module-load time
// (e.g. stale HTML cache where the button has a different id, or the
// element somehow wasn't in the DOM at script-run). Patrick reported
// v31 "tech +Add zone does nothing" — most likely cause was a null
// binding. Delegation on document survives any of those failure modes
// AND keeps working if the button is re-rendered dynamically.
let _addZoneBusy = false;
document.addEventListener("click", async (event) => {
  if (!event.target.closest("#techAddZoneBtn")) return;
  event.preventDefault();
  if (typeof state !== "undefined" && state && state.locked) return;
  if (_addZoneBusy) return;
  _addZoneBusy = true;
  setTimeout(() => { _addZoneBusy = false; }, 600);
  // Use the styled in-app dialog directly. The inline #techZonePicker
  // DOM is no longer relied upon — if it loads, that's a bonus; if
  // not (Patrick's v30/v31 case), the dialog still works.
  const n = await showZoneNumberDialog();
  if (n == null) return;
  // Refuse duplicates with a friendly nudge.
  const existing = new Set((state.zones || []).map((z) => Number(z.number)).filter(Boolean));
  if (existing.has(n)) {
    alert(`Zone ${n} is already on this work order — tap it in the list above to edit.`);
    return;
  }
  addZoneAndOpen(n);
});

// Tap a row from the property's known zones — adds that zone with
// auto-populated metadata, opens edit sheet.
document.getElementById("techZonePickerList")?.addEventListener("click", (event) => {
  const btn = event.target.closest(".tech-zone-pick-row");
  if (!btn) return;
  const n = Number(btn.dataset.zoneNumber);
  if (!n) return;
  addZoneAndOpen(n);
});

// "Add zone" by typed number — pick any zone 1–99, in any order.
document.getElementById("techZonePickerAddByNumber")?.addEventListener("click", () => {
  const input = document.getElementById("techZonePickerNumber");
  const n = Number(input?.value);
  if (!Number.isFinite(n) || n < 1 || n > 99) {
    alert("Please enter a zone number between 1 and 99.");
    if (input) input.focus();
    return;
  }
  addZoneAndOpen(n);
});

// Enter-key on the number input fires the same add.
document.getElementById("techZonePickerNumber")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    document.getElementById("techZonePickerAddByNumber")?.click();
  }
});

document.getElementById("techZonePickerCancel")?.addEventListener("click", closeZonePicker);

// ---- Zone-edit bottom sheet -------------------------------------

function openZoneSheet(index) {
  const zone = state.zones[index];
  if (!zone) return;
  state.activeZoneIndex = index;

  if (sheetZoneBadgeBtn) sheetZoneBadgeBtn.textContent = zoneBadgeLabel(zone);
  if (sheetLocationInput) sheetLocationInput.value = zone.location || "";

  // Sprinkler + Coverage editable pill toggles (Brief Hot, spec §2.2).
  // The summary badges that used to live here (read-only display) moved
  // into the zone-list card preview only; the sheet itself is now where
  // the tech edits these fields.
  renderSheetPills(sheetSprinklerPills, "sprinklerTypes", TECH_SPRINKLER_PILLS, zone.sprinklerTypes || []);
  renderSheetPills(sheetCoveragePills,  "coverage",       TECH_COVERAGE_PILLS,  zone.coverage       || []);

  // Status pills — one is pressed if the zone has been reviewed.
  sheetStatus.querySelectorAll("[data-zone-status]").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.dataset.zoneStatus === zone.status ? "true" : "false");
  });

  // Standard checks (5 tap-boxes) and issues-found list.
  renderSheetChecks(zone);
  renderSheetIssues(zone);

  sheetNotes.value = zone.notes || "";

  techSheet.hidden = false;
  document.body.classList.add("tech-sheet-open");
}

// Apply zone.checks state to the 5 check buttons in the sheet. Each
// button uses aria-pressed for both accessibility and CSS targeting.
function renderSheetChecks(zone) {
  const checks = (zone && zone.checks) || {};
  sheetChecks.querySelectorAll("[data-zone-check]").forEach((btn) => {
    btn.setAttribute("aria-pressed", checks[btn.dataset.zoneCheck] ? "true" : "false");
  });
}

// Render an editable pill group (sprinkler type / coverage type) into a
// container. Mirrors property.js's pillGroupHtml shape so the data flow
// is identical — same data-pill / data-group / data-value attributes and
// the same aria-pressed state — but rendered into a container the bottom
// sheet picks up. Brief Hot, spec §2.2.
function renderSheetPills(container, groupName, options, selectedValues) {
  if (!container) return;
  const set = new Set((selectedValues || []).map(String));
  container.innerHTML = options.map((opt) =>
    `<button type="button" class="tech-sheet-pill" data-pill data-group="${groupName}" data-value="${escapeHtml(opt.value)}" aria-pressed="${set.has(opt.value) ? "true" : "false"}">${escapeHtml(opt.label)}</button>`
  ).join("");
}

// Pill-tap delegation — toggles aria-pressed, mutates state.zones[active]
// for the matching group, and fires patchWorkOrder({ zones }) optimistically.
// Optimistic UI: we flip the chip immediately and let the PATCH catch up.
// On failure, the next zone-sheet open will re-render from server state
// and the chip will return to its persisted value (offline-queue covers
// the offline case).
function attachSheetPillHandler(container) {
  if (!container) return;
  container.addEventListener("click", (event) => {
    const pill = event.target.closest("[data-pill]");
    if (!pill || state.locked) return;
    const idx = state.activeZoneIndex;
    const zone = idx >= 0 ? state.zones[idx] : null;
    if (!zone) return;
    const group = pill.dataset.group;
    const value = pill.dataset.value;
    if (!group || !value) return;
    const fieldArr = Array.isArray(zone[group]) ? zone[group].slice() : [];
    const i = fieldArr.indexOf(value);
    if (i === -1) fieldArr.push(value);
    else fieldArr.splice(i, 1);
    zone[group] = fieldArr;
    pill.setAttribute("aria-pressed", i === -1 ? "true" : "false");
    // Re-render the zone list so the card preview badges reflect the
    // updated arrays (the card uses badgeListHtml, which reads from
    // state.zones directly).
    renderZones();
    patchWorkOrder({ zones: state.zones });
  });
}
attachSheetPillHandler(sheetSprinklerPills);
attachSheetPillHandler(sheetCoveragePills);

// Render the issues-found list inside the sheet. Each row is a card
// with a type select, a qty input, a notes input, and a remove button.
// The id on the data-attr is the stable key — when the tech edits a
// field we look up the issue by id (not by index) so reordering or
// concurrent removals don't bite.
function renderSheetIssues(zone) {
  if (!sheetIssues) return;
  sheetIssues.innerHTML = "";
  const issues = (zone && Array.isArray(zone.issues)) ? zone.issues : [];
  if (!issues.length) {
    const empty = document.createElement("p");
    empty.className = "tech-zone-issues-empty";
    empty.textContent = "No issues found yet.";
    sheetIssues.appendChild(empty);
    return;
  }
  // Fall-mode actions only render on an UNlocked fall_closing WO. After
  // sign-off the WO is the contract — defer/emergency must not fire.
  const isFallMode = state.type === ON_SITE_FIND_ONLY && !state.locked && !state.signature?.signed;
  issues.forEach((issue) => {
    const div = document.createElement("div");
    div.className = "tech-zone-issue" + (isFallMode ? " is-fall-mode" : "");
    div.dataset.issueId = issue.id;
    div.dataset.zoneNumber = String(zone.number || 0);
    const typeOptionsHtml = ZONE_ISSUE_TYPE_OPTIONS.map((t) =>
      `<option value="${t.value}" ${t.value === issue.type ? "selected" : ""}>${escapeHtml(t.label)}</option>`
    ).join("");
    const subtypeOpts = ZONE_ISSUE_SUBTYPE_OPTIONS[issue.type] || [];
    const subtypeOptionsHtml = subtypeOpts.map((s) =>
      `<option value="${escapeHtml(s.value)}" ${s.value === (issue.subtype || "") ? "selected" : ""}>${escapeHtml(s.label)}</option>`
    ).join("");
    const subtypeHidden = subtypeOpts.length === 0 ? "hidden" : "";
    // Quantity input only relevant for valves (manifold rule needs the
    // count) and head replacements (multi-head zones). Other types stay
    // qty=1 and the field is dimmed but not removed.
    const qtyRelevant = issue.type === "valve" || issue.type === "broken_head" || issue.type === "controller";
    div.innerHTML = `
      <select class="tech-zone-issue-type" aria-label="Issue type">${typeOptionsHtml}</select>
      <select class="tech-zone-issue-subtype" aria-label="Specific item" ${subtypeHidden}>${subtypeOptionsHtml}</select>
      <input type="number" class="tech-zone-issue-qty${qtyRelevant ? "" : " is-dim"}" min="1" inputmode="numeric" value="${escapeHtml(String(issue.qty || 1))}" aria-label="Quantity">
      <input type="text" class="tech-zone-issue-notes" value="${escapeHtml(issue.notes || "")}" placeholder="Notes (optional)" aria-label="Issue notes" data-voice-input>
      <button type="button" class="tech-zone-issue-remove" aria-label="Remove issue">×</button>
      <div class="tech-issue-photos" data-issue-photos="${escapeHtml(issue.id)}"></div>
      <div class="tech-zone-issue-fall-actions">
        <button type="button" class="tech-zone-issue-defer-btn" data-defer-issue>📋 Save to deferred</button>
        <button type="button" class="tech-zone-issue-emergency-btn" data-emergency-issue>🚨 Emergency override</button>
      </div>
    `;
    sheetIssues.appendChild(div);
    renderIssuePhotos(div.querySelector("[data-issue-photos]"), issue.id, zone);
  });
}

// Render the per-issue photo strip inside a single issue card. Filters
// state.photos by issueId, renders thumbnails + an upload button. The
// upload button uses capture="environment" so mobile cameras open
// directly to the rear camera.
function renderIssuePhotos(host, issueId, zone) {
  if (!host) return;
  host.innerHTML = "";
  const issuePhotos = (state.photos || []).filter((p) => p.issueId === issueId);
  issuePhotos.forEach((photo) => host.appendChild(renderPhotoThumb(photo)));

  if (state.locked) return; // post-sign: no upload UI

  const label = document.createElement("label");
  label.className = "tech-issue-photo-add";
  // No capture attribute — same flow as the visit-photos input: lets
  // iOS/Android offer Photo Library + Take Photo + Choose File. accept
  // matches the visit-photos input so per-issue uploads accept the
  // same set (JPEG/PNG/HEIC/WebP/GIF/PDF) — receipts, fence-line shots,
  // wiring diagrams. Brief: WO Field-Readiness §5.
  label.innerHTML = `
    <input type="file" multiple hidden
           accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/gif,application/pdf,.heic,.heif">
    <span aria-hidden="true">📷</span>
    <span>Photo / PDF</span>
  `;
  label.querySelector("input").addEventListener("change", async (event) => {
    if (state.locked) return;
    const input = event.target;
    const files = input.files;
    // v21 — same immediate diagnostic as the visit-photo handler.
    label.classList.add("is-uploading");
    setUploadStatus(`Picked ${files ? files.length : 0} file(s)…`);
    if (!files || !files.length) {
      setUploadStatus("No file selected — try again.");
      setTimeout(() => {
        label.classList.remove("is-uploading");
        setUploadStatus(null);
      }, 1500);
      return;
    }
    try {
      const wo = await uploadWoPhotos(files, {
        category: "issue",
        issueId,
        zoneNumber: zone?.number || null
      });
      if (wo) {
        state.photos = wo.photos || [];
        // Re-render only this issue's photos to preserve focus on
        // adjacent inputs (e.g. tech mid-typing in another row).
        renderIssuePhotos(host, issueId, zone);
        // Also refresh the WO-level strip in case user uploaded more
        // photos before navigating away.
        renderWoPhotos();
        // Photo gate may have just flipped — refresh the post-sig banner.
        renderPostSigBanner();
      }
    } catch (err) {
      alert(err.message || "Couldn't upload photo.");
    } finally {
      label.classList.remove("is-uploading");
      input.value = "";
    }
  });
  host.appendChild(label);
}

function closeZoneSheet() {
  // Final flush: write any pending notes change before we let the sheet
  // close. The blur path handles most of this, but a hard close (back
  // button, escape) skips blur, so we belt-and-suspender here.
  flushZoneNotes();
  techSheet.hidden = true;
  document.body.classList.remove("tech-sheet-open");
  state.activeZoneIndex = -1;
}

sheetClose.addEventListener("click", closeZoneSheet);
sheetDone.addEventListener("click", closeZoneSheet);

// Delete zone — destructive action, confirm-prompted with copy that
// reflects what's about to be lost. Removes the zone from state.zones,
// PATCHes the WO, and closes the sheet. Refuses on locked WOs (defense
// in depth — applyLockState also disables the button visually).
document.getElementById("sheetDeleteZone")?.addEventListener("click", () => {
  if (state.locked) return;
  const idx = state.activeZoneIndex;
  const zone = idx >= 0 ? state.zones[idx] : null;
  if (!zone) return;
  // Build a context-aware confirm message. If the zone has any captured
  // evidence (issues, photos, notes, status, ticked checks, sprinkler/
  // coverage selections), the tech might be about to nuke real on-site
  // documentation — say so explicitly.
  const photoCount = (state.photos || []).filter((p) => Number(p.zoneNumber) === Number(zone.number)).length;
  const issueCount = Array.isArray(zone.issues) ? zone.issues.length : 0;
  const checkCount = zone.checks ? Object.values(zone.checks).filter(Boolean).length : 0;
  const hasNotes = !!(zone.notes && zone.notes.trim());
  const hasStatus = !!zone.status;
  const hasMultiSelects = (Array.isArray(zone.sprinklerTypes) && zone.sprinklerTypes.length) ||
                          (Array.isArray(zone.coverage) && zone.coverage.length);
  const captured = [];
  if (issueCount) captured.push(`${issueCount} issue${issueCount === 1 ? "" : "s"}`);
  if (photoCount) captured.push(`${photoCount} photo${photoCount === 1 ? "" : "s"}`);
  if (checkCount) captured.push(`${checkCount} check${checkCount === 1 ? "" : "s"}`);
  if (hasNotes)   captured.push("notes");
  if (hasStatus)  captured.push("status");
  if (hasMultiSelects) captured.push("sprinkler/coverage selections");
  const zoneLabel = zone.location ? `${zone.location} (Zone ${zone.number})` : `Zone ${zone.number}`;
  const message = captured.length
    ? `Delete ${zoneLabel}?\n\nThis will discard ${captured.join(", ")}. This can't be undone.`
    : `Delete ${zoneLabel}?\n\nThis can't be undone.`;
  if (!confirm(message)) return;

  // Splice the zone out, close the sheet, re-render, persist.
  state.zones.splice(idx, 1);
  closeZoneSheet();
  renderZones();
  patchWorkOrder({ zones: state.zones });
});
techSheet.addEventListener("click", (event) => {
  if (event.target === techSheet) closeZoneSheet();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !techSheet.hidden) closeZoneSheet();
});

// Status taps inside the sheet — auto-save and re-render the list
// behind the sheet so the dot/progress update immediately.
sheetStatus.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-zone-status]");
  if (!btn) return;
  const idx = state.activeZoneIndex;
  if (idx < 0) return;
  const zone = state.zones[idx];
  if (!zone) return;
  // Tapping the already-pressed status clears it (so the tech can
  // un-mark a zone if they tapped wrong).
  const next = btn.dataset.zoneStatus === zone.status ? "" : btn.dataset.zoneStatus;
  zone.status = next;
  sheetStatus.querySelectorAll("[data-zone-status]").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.zoneStatus === next ? "true" : "false");
  });
  renderZones();
  patchWorkOrder({ zones: state.zones });
});

// Notes typing — debounce so we don't PATCH on every keystroke.
sheetNotes.addEventListener("input", () => {
  if (state.zoneNotesTimer) clearTimeout(state.zoneNotesTimer);
  state.zoneNotesTimer = setTimeout(flushZoneNotes, 1200);
});
sheetNotes.addEventListener("blur", flushZoneNotes);

// Standard-check tap-boxes — toggle the boolean, persist, refresh both
// the sheet's pressed state and the zone-list "X/5 checks" badge.
sheetChecks.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-zone-check]");
  if (!btn) return;
  const idx = state.activeZoneIndex;
  if (idx < 0) return;
  const zone = state.zones[idx];
  if (!zone) return;
  const key = btn.dataset.zoneCheck;
  zone.checks = zone.checks || {};
  zone.checks[key] = !zone.checks[key];
  btn.setAttribute("aria-pressed", zone.checks[key] ? "true" : "false");
  renderZones();
  patchWorkOrder({ zones: state.zones });
});

// Add an empty issue row — defaults to "broken_head" / qty 1 / no notes
// so the tech can tap once and only need to edit if the default is
// wrong. The fresh row is appended; renderSheetIssues redraws the list
// (preserves stable ids on existing rows so the user's focus doesn't
// move while they're typing in another row).
sheetIssueAdd.addEventListener("click", () => {
  const idx = state.activeZoneIndex;
  if (idx < 0) return;
  const zone = state.zones[idx];
  if (!zone) return;
  zone.issues = Array.isArray(zone.issues) ? zone.issues : [];
  zone.issues.push({
    id: "iss_" + Math.random().toString(36).slice(2, 10) + "_" + Date.now(),
    type: "broken_head",
    subtype: "",
    qty: 1,
    notes: ""
  });
  renderSheetIssues(zone);
  renderZones();
  patchWorkOrder({ zones: state.zones });
});

// Issue-row delegation: remove button click + change/input on the
// type/qty/notes fields. Type select is instant; qty + notes debounce
// 800ms (or flush on blur) so we don't PATCH on every keystroke.
sheetIssues.addEventListener("click", (event) => {
  if (!event.target.classList.contains("tech-zone-issue-remove")) return;
  const card = event.target.closest("[data-issue-id]");
  if (!card) return;
  const idx = state.activeZoneIndex;
  if (idx < 0) return;
  const zone = state.zones[idx];
  if (!zone) return;
  const issueId = card.dataset.issueId;
  zone.issues = (zone.issues || []).filter((i) => i.id !== issueId);
  renderSheetIssues(zone);
  renderZones();
  patchWorkOrder({ zones: state.zones });
});

sheetIssues.addEventListener("change", (event) => {
  // Type change → reset subtype to first option, then re-render this
  // single row so the subtype dropdown reflects the new type's options.
  if (event.target.classList.contains("tech-zone-issue-type")) {
    const card = event.target.closest("[data-issue-id]");
    const idx = state.activeZoneIndex;
    if (idx >= 0 && card) {
      const zone = state.zones[idx];
      const issue = (zone?.issues || []).find((i) => i.id === card.dataset.issueId);
      if (issue) {
        issue.type = event.target.value;
        issue.subtype = ""; // reset — new type has different subtype options
      }
      // Re-render the whole sheet's issue list so the subtype dropdown
      // gets the right <option> set. Cheaper-rerender of just the row
      // would mean string-templating in the same place; sheet-level
      // rerender is simpler and the lists are short.
      renderSheetIssues(zone);
    }
    flushIssueRow(card);
  }
  // Subtype change → just persist.
  if (event.target.classList.contains("tech-zone-issue-subtype")) {
    flushIssueRow(event.target.closest("[data-issue-id]"));
  }
});

sheetIssues.addEventListener("input", (event) => {
  if (event.target.classList.contains("tech-zone-issue-qty") ||
      event.target.classList.contains("tech-zone-issue-notes")) {
    if (state.issueInputTimer) clearTimeout(state.issueInputTimer);
    const card = event.target.closest("[data-issue-id]");
    state.issueInputTimer = setTimeout(() => flushIssueRow(card), 800);
  }
});

// Capture-phase blur listener so we catch blur on the inputs (blur
// doesn't bubble in the standard sense — using capture is the
// idiomatic fix).
sheetIssues.addEventListener("blur", (event) => {
  if (event.target.classList.contains("tech-zone-issue-qty") ||
      event.target.classList.contains("tech-zone-issue-notes")) {
    if (state.issueInputTimer) { clearTimeout(state.issueInputTimer); state.issueInputTimer = null; }
    flushIssueRow(event.target.closest("[data-issue-id]"));
  }
}, true);

function flushIssueRow(card) {
  if (!card) return;
  const idx = state.activeZoneIndex;
  if (idx < 0) return;
  const zone = state.zones[idx];
  if (!zone) return;
  const issueId = card.dataset.issueId;
  const issue = (zone.issues || []).find((i) => i.id === issueId);
  if (!issue) return;
  const typeEl    = card.querySelector(".tech-zone-issue-type");
  const subtypeEl = card.querySelector(".tech-zone-issue-subtype");
  const qtyEl     = card.querySelector(".tech-zone-issue-qty");
  const notesEl   = card.querySelector(".tech-zone-issue-notes");
  const nextType    = typeEl ? typeEl.value : issue.type;
  const nextSubtype = subtypeEl ? subtypeEl.value : (issue.subtype || "");
  const nextQty     = Math.max(1, Math.floor(Number(qtyEl?.value) || 1));
  const nextNotes   = (notesEl?.value || "").trim();
  if (issue.type === nextType && (issue.subtype || "") === nextSubtype && issue.qty === nextQty && issue.notes === nextNotes) return;
  issue.type    = nextType;
  issue.subtype = nextSubtype;
  issue.qty   = nextQty;
  issue.notes = nextNotes;
  // Notes-driven changes don't need a zone-list re-render (issue count
  // didn't change), but a type/qty change is cheap to redraw too.
  renderZones();
  patchWorkOrder({ zones: state.zones });
}

function flushZoneNotes() {
  if (state.zoneNotesTimer) {
    clearTimeout(state.zoneNotesTimer);
    state.zoneNotesTimer = null;
  }
  const idx = state.activeZoneIndex;
  if (idx < 0) return;
  const zone = state.zones[idx];
  if (!zone) return;
  const next = sheetNotes.value.trim();
  if (zone.notes === next) return;
  zone.notes = next;
  renderZones();
  patchWorkOrder({ zones: state.zones });
}

// ---- Zone source-picker -----------------------------------------
// Tap the "Zone N" badge in the open zone sheet → an anchored dropdown
// menu lists the customer's pre-configured zones (with number + label),
// valve boxes, controller, and open deferred issues. Picking applies:
//   - kind     → drives the badge text via zoneBadgeLabel()
//   - number   (only for property zones)
//   - location (zone label → description input next to the badge)
//   - notes    (only when the WO zone notes textarea is empty — never
//              clobbers on-site work)
// The description input remains free-text so a tech at an unknown
// property can type whatever describes the zone.

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

let zonePickerMenu = null;
let zonePickerSources = [];

function buildZonePickerSources() {
  zonePickerSources = [];
  const property = state.linkedProperty;
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
    // schema used `label`; we read both so legacy records still surface.
    const rawLabel = String(z.location || z.label || "").trim();
    const notes = String(z.notes || "").trim();
    // Final fallback when neither field is filled in.
    const fillLabel = rawLabel || `Zone ${number || "?"}`;
    zonePickerSources.push({
      group: "Zones",
      kind: "zone",
      number,
      label: fillLabel,
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
  zonePickerMenu.className = "tech-zone-picker-menu";
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
  // Menu is position: fixed → coords are viewport-relative, no scroll math.
  // Clamp so the menu can't run off the right edge on a narrow phone.
  const menuWidth = Math.min(window.innerWidth - 16, 360);
  const maxLeft = window.innerWidth - 8 - menuWidth;
  zonePickerMenu.style.top  = `${rect.bottom + 6}px`;
  zonePickerMenu.style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`;
  zonePickerMenu.style.minWidth = `${Math.max(rect.width, 220)}px`;
  zonePickerMenu.style.maxWidth = `${menuWidth}px`;
}

function openZonePicker() {
  if (state.locked) return;
  if (state.activeZoneIndex < 0) return;
  if (!sheetZoneBadgeBtn) return;
  ensureZonePickerMenu();

  const groups = new Map();
  zonePickerSources.forEach((src, idx) => {
    if (!groups.has(src.group)) groups.set(src.group, []);
    groups.get(src.group).push({ src, idx });
  });
  let html = "";
  if (!groups.size) {
    html = `<p class="tech-zone-picker-empty">No property zones / valves / controller on file. Type a custom description in the field below.</p>`;
  } else {
    groups.forEach((items, label) => {
      html += `<section class="tech-zone-picker-group"><h4>${escapeHtml(label)}</h4><ul>`;
      items.forEach(({ src, idx }) => {
        html += `<li>
          <button type="button" class="tech-zone-picker-item" data-source-idx="${idx}" role="option">
            <span class="tech-zone-picker-item-label">${escapeHtml(src.display)}</span>
            ${src.sub ? `<span class="tech-zone-picker-item-sub">${escapeHtml(src.sub)}</span>` : ""}
          </button>
        </li>`;
      });
      html += `</ul></section>`;
    });
  }
  zonePickerMenu.innerHTML = html;
  zonePickerMenu.hidden = false;
  sheetZoneBadgeBtn.setAttribute("aria-expanded", "true");
  positionZonePickerMenu(sheetZoneBadgeBtn);
}

function closeZonePicker() {
  if (!zonePickerMenu || zonePickerMenu.hidden) return;
  zonePickerMenu.hidden = true;
  if (sheetZoneBadgeBtn) sheetZoneBadgeBtn.setAttribute("aria-expanded", "false");
}

function applyZoneSourceFromIdx(idx) {
  const src = zonePickerSources[idx];
  const zoneIdx = state.activeZoneIndex;
  const zone = state.zones[zoneIdx];
  if (!src || !zone) return closeZonePicker();

  zone.kind = src.kind;
  if (src.kind === "zone" && Number.isFinite(src.number) && src.number > 0) {
    zone.number = src.number;
  } else if (src.kind !== "zone") {
    zone.number = 0;
  }
  zone.location = src.label;

  // Auto-populate notes when WO notes are empty.
  if (src.notes && !String(zone.notes || "").trim()) {
    zone.notes = src.notes;
    if (sheetNotes) sheetNotes.value = src.notes;
  }

  // Reflect in the sheet header + location input + zone list.
  if (sheetZoneBadgeBtn) sheetZoneBadgeBtn.textContent = zoneBadgeLabel(zone);
  if (sheetLocationInput) sheetLocationInput.value = zone.location;
  renderZones();
  patchWorkOrder({ zones: state.zones });
  closeZonePicker();
}

// Description input — keep state.zones[idx].location in sync, persist on
// blur or 1.2s debounce. Picker writes directly to the input value, so
// this handler only fires for tech-typed edits.
sheetLocationInput?.addEventListener("input", () => {
  if (state.locked) return;
  const idx = state.activeZoneIndex;
  const zone = state.zones[idx];
  if (!zone) return;
  zone.location = String(sheetLocationInput.value || "").trim().slice(0, 200);
  if (state.zoneLocationTimer) clearTimeout(state.zoneLocationTimer);
  state.zoneLocationTimer = setTimeout(() => {
    state.zoneLocationTimer = null;
    renderZones();
    patchWorkOrder({ zones: state.zones });
  }, 1200);
});
sheetLocationInput?.addEventListener("blur", () => {
  if (state.zoneLocationTimer) {
    clearTimeout(state.zoneLocationTimer);
    state.zoneLocationTimer = null;
    renderZones();
    patchWorkOrder({ zones: state.zones });
  }
});

// Open / close wiring + outside-click + escape.
sheetZoneBadgeBtn?.addEventListener("click", () => {
  if (zonePickerMenu && !zonePickerMenu.hidden) {
    closeZonePicker();
  } else {
    openZonePicker();
  }
});
document.addEventListener("click", (event) => {
  if (!zonePickerMenu || zonePickerMenu.hidden) return;
  if (event.target.closest(".tech-zone-picker-menu")) return;
  if (event.target === sheetZoneBadgeBtn || sheetZoneBadgeBtn?.contains(event.target)) return;
  closeZonePicker();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && zonePickerMenu && !zonePickerMenu.hidden) closeZonePicker();
});
window.addEventListener("resize", () => {
  if (!zonePickerMenu || zonePickerMenu.hidden || !sheetZoneBadgeBtn) return;
  positionZonePickerMenu(sheetZoneBadgeBtn);
});

// ---- Visit notes (textarea) -------------------------------------

techNotes.addEventListener("input", () => {
  if (state.notesTimer) clearTimeout(state.notesTimer);
  state.notesTimer = setTimeout(flushVisitNotes, 1200);
});
techNotes.addEventListener("blur", flushVisitNotes);

function flushVisitNotes() {
  if (state.notesTimer) {
    clearTimeout(state.notesTimer);
    state.notesTimer = null;
  }
  const next = techNotes.value.trim();
  if (state.techNotes === next) return;
  state.techNotes = next;
  patchWorkOrder({ techNotes: next });
}

// ---- Service-specific checklist ---------------------------------

// Render the service-specific checklist (spring opening / fall closing).
// Hidden for service_visit (no service-specific steps in that template).
// Each step is a tap-pill that toggles the boolean in state.serviceChecklist
// and PATCHes immediately. Mirrors the zone-check tap-box pattern.
function renderServiceChecklist() {
  const section = document.getElementById("techServiceChecklistSection");
  const list = document.getElementById("techServiceChecklistList");
  const title = document.getElementById("techServiceChecklistTitle");
  if (!section || !list) return;
  const steps = SERVICE_CHECKLISTS_TECH[state.type] || [];
  if (!steps.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (title) title.textContent = TYPE_LABELS[state.type] ? `${TYPE_LABELS[state.type]} checklist` : "Service checklist";
  list.innerHTML = "";
  steps.forEach((step) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tech-service-step";
    btn.dataset.serviceStep = step.key;
    btn.setAttribute("aria-pressed", state.serviceChecklist[step.key] ? "true" : "false");
    btn.innerHTML = `<span class="check-tick" aria-hidden="true"></span><span>${escapeHtml(step.label)}</span>`;
    li.appendChild(btn);
    list.appendChild(li);
  });
}

document.getElementById("techServiceChecklistList")?.addEventListener("click", (event) => {
  if (state.locked) return;
  const btn = event.target.closest("[data-service-step]");
  if (!btn) return;
  const key = btn.dataset.serviceStep;
  state.serviceChecklist[key] = !state.serviceChecklist[key];
  btn.setAttribute("aria-pressed", state.serviceChecklist[key] ? "true" : "false");
  patchWorkOrder({ serviceChecklist: state.serviceChecklist });
});

// ---- Visit photos -----------------------------------------------

// Render the WO-level photo strip (anything not tied to a specific
// issue). Issue photos render inline in the per-zone sheet via
// renderSheetIssues. The "Add visit photo" button stays mounted but
// is disabled when locked.
function renderWoPhotos() {
  const strip = document.getElementById("techWoPhotoStrip");
  const count = document.getElementById("techWoPhotoCount");
  const saveAll = document.getElementById("techPhotoSaveAll");
  if (!strip) return;
  const woLevel = (state.photos || []).filter((p) => !p.issueId);
  if (count) count.textContent = String(woLevel.length);
  strip.innerHTML = "";
  woLevel.forEach((photo) => {
    strip.appendChild(renderPhotoThumb(photo));
  });
  // The "Save all to phone" button is visible only when the WO has
  // any photos at all (zone-attached or not). Hidden on empty WOs.
  if (saveAll) {
    saveAll.hidden = !(state.photos && state.photos.length);
  }
}

// Bulk-save every photo on the WO to the technician's device. Uses the
// Web Share API where supported (iOS Safari + modern Android Chrome) so
// the share sheet pops once with all photos batched — single tap to
// "Save Images" lands them all in Photos. Falls back to per-file
// download attribute on browsers without canShare for files. The
// watermarked files come straight from the server (already burned).
async function saveAllPhotosToDevice() {
  const photos = state.photos || [];
  if (!photos.length) return;
  const btn = document.getElementById("techPhotoSaveAll");
  if (btn) { btn.disabled = true; btn.classList.add("is-saving"); }
  try {
    const files = await Promise.all(photos.map(async (p) => {
      const resp = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}/photo/${p.n}`, {
        cache: "force-cache"
      });
      const blob = await resp.blob();
      const filename = p.filename || `pjl-photo-${p.n}.jpg`;
      return new File([blob], filename, { type: blob.type || "image/jpeg" });
    }));
    if (navigator.canShare && navigator.canShare({ files })) {
      try {
        await navigator.share({ files, title: `PJL ${state.id} photos` });
        return;
      } catch (err) {
        // AbortError = user dismissed the share sheet, no error to show.
        if (err && err.name === "AbortError") return;
        // Fall through to download fallback for any other share failure.
      }
    }
    // Download fallback: trigger one save per file (silent on Android,
    // opens new tab on iOS — the share-sheet path is preferred).
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

document.getElementById("techPhotoSaveAll")?.addEventListener("click", saveAllPhotosToDevice);

function renderPhotoThumb(photo) {
  const wrap = document.createElement("div");
  wrap.className = "tech-photo-thumb";
  wrap.dataset.photoN = String(photo.n);
  // Brief: WO Field-Readiness §5.3 — PDFs render as a filename tile
  // (icon + name + tap-through), not <img>. The server marks each
  // entry with `kind: 'image' | 'pdf'`; legacy uploads default to
  // image (all pre-brief WO uploads were images).
  const isPdf = photo.kind === "pdf" || photo.mediaType === "application/pdf";
  if (isPdf) {
    wrap.classList.add("is-pdf");
    const link = document.createElement("a");
    link.className = "tech-photo-pdf-tile";
    link.href = woPhotoUrl(photo.n);
    link.target = "_blank";
    link.rel = "noopener";
    const filename = photo.label || photo.filename || `PDF ${photo.n}`;
    link.innerHTML = `
      <span class="tech-photo-pdf-icon" aria-hidden="true">📄</span>
      <span class="tech-photo-pdf-name">${escapeHtml(filename)}</span>
    `;
    wrap.appendChild(link);
  } else {
    const img = document.createElement("img");
    img.src = woPhotoUrl(photo.n);
    img.loading = "lazy";
    img.alt = photo.label || `Photo ${photo.n}`;
    img.addEventListener("click", () => openLightbox(woPhotoUrl(photo.n)));
    wrap.appendChild(img);
  }
  if (!state.locked) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tech-photo-thumb-remove";
    remove.setAttribute("aria-label", "Remove photo");
    remove.textContent = "×";
    remove.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Remove this photo?")) return;
      try {
        const wo = await deleteWoPhoto(photo.n);
        state.photos = wo.photos || [];
        renderWoPhotos();
        // Re-render the issue sheet if open — this photo might've been
        // attached to the issue currently being edited.
        if (state.activeZoneIndex >= 0) {
          renderSheetIssues(state.zones[state.activeZoneIndex]);
        }
        // Deleting a completion photo could push the WO back below the
        // gate threshold — refresh the banner.
        renderPostSigBanner();
      } catch (err) { alert(err.message); }
    });
    wrap.appendChild(remove);
  }
  return wrap;
}

// Visit-photo upload — fires when the file picker emits a change. Mobile
// browsers honor `capture="environment"` to open the camera directly.
// NOTE: v22 also binds this handler at the top of the file as a safety
// net (before any other code can throw). The early bind sets
// _photoListenerAttached=true; if so, we skip this binding to avoid
// double-uploads. This block is kept so we still attach in the rare
// case the early bind didn't find the input element.
if (typeof _photoListenerAttached === "undefined" || !_photoListenerAttached) {
document.getElementById("techWoPhotoInput")?.addEventListener("change", async (event) => {
  if (state.locked) return;
  const input = event.target;
  const files = input.files;
  // v21 — immediate diagnostic. If the user picks a file and sees
  // NOTHING change, we can't tell whether the change event fired
  // empty or whether the handler ran but stalled. This adds a
  // visible "Picked N file(s)…" stamp BEFORE any async work so we
  // know the handler at least executed. The is-uploading class is
  // added FIRST so setUploadStatus has a target to update.
  const addBtn = document.querySelector(".tech-photo-add");
  if (addBtn) addBtn.classList.add("is-uploading");
  setUploadStatus(`Picked ${files ? files.length : 0} file(s)…`);
  if (!files || !files.length) {
    setUploadStatus("No file selected — try again.");
    setTimeout(() => {
      if (addBtn) addBtn.classList.remove("is-uploading");
      setUploadStatus(null);
    }, 1500);
    return;
  }
  try {
    const wo = await uploadWoPhotos(files, { category: "general" });
    if (wo) {
      state.photos = wo.photos || [];
      renderWoPhotos();
      // Photo gate may have just flipped — refresh the post-sig banner.
      renderPostSigBanner();
    }
  } catch (err) {
    alert(err.message || "Couldn't upload photo.");
  } finally {
    if (addBtn) addBtn.classList.remove("is-uploading");
    input.value = "";  // reset so picking the same file re-fires change
  }
});
} // end fallback-only `if (!_photoListenerAttached)`

// Lightbox — taps anywhere dismiss it. Single shared element so we
// don't have to render one per thumbnail.
function openLightbox(url) {
  const box = document.getElementById("techPhotoLightbox");
  const img = document.getElementById("techPhotoLightboxImg");
  if (!box || !img) return;
  img.src = url;
  box.hidden = false;
  document.body.classList.add("tech-lightbox-open");
}
document.getElementById("techPhotoLightbox")?.addEventListener("click", () => {
  const box = document.getElementById("techPhotoLightbox");
  if (box) box.hidden = true;
  document.body.classList.remove("tech-lightbox-open");
});

// ---- Customer sign-off + signature pad --------------------------

// Switch the sign-off section between pre-sign (form + canvas) and
// post-sign (read-only image + name + date) based on state.signature.signed.
function renderSignoff() {
  const form = document.getElementById("techSignoffForm");
  const signed = document.getElementById("techSignoffSigned");
  if (!form || !signed) return;
  if (state.signature && state.signature.signed) {
    form.hidden = true;
    signed.hidden = false;
    const img = document.getElementById("techSignoffImage");
    const nameEl = document.getElementById("techSignoffSignedName");
    const atEl = document.getElementById("techSignoffSignedAt");
    if (img && state.signature.imageData) img.src = state.signature.imageData;
    if (nameEl) nameEl.textContent = state.signature.customerName || "—";
    if (atEl && state.signature.signedAt) {
      atEl.textContent = ` · ${formatDateTime(state.signature.signedAt)}`;
    }
  } else {
    form.hidden = false;
    signed.hidden = true;
    // Lazy-init the signature pad on first render.
    if (!state.signaturePad) {
      const canvas = document.getElementById("techSignoffCanvas");
      if (canvas) state.signaturePad = createSignaturePad(canvas, updateSignoffSubmitState);
    }
    updateSignoffSubmitState();
  }
}

// Create a signature canvas with pointer-event drawing (works for touch,
// mouse, and stylus). Returns a small API: isDirty, clear, toDataURL.
// onChange fires whenever the dirty state flips so the submit button
// can enable/disable in sync with the form.
function createSignaturePad(canvas, onChange) {
  const ctx = canvas.getContext("2d");
  let drawing = false;
  let dirty = false;

  function fitCanvas() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    // Preserve any existing strokes by snapshotting before resize.
    const snapshot = canvas.width ? canvas.toDataURL() : null;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0F1F14";
    ctx.lineWidth = 2.2 * dpr;
    if (snapshot && dirty) {
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
    if (state.locked) return;
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

// Submit button enables only when name + signature + acknowledgement
// AND every walkout gate (zones touched, photos captured, carry-forward
// resolved, paidOnSite selected, materials confirmed when relevant) is
// met. The merged "Sign, Lock & Generate Invoice" tap completes the
// visit, so the WO must be ready-to-complete at the moment the customer
// signs. Re-runs on every input change so the tech sees the gating in
// real time.
function updateSignoffSubmitState() {
  const submit = document.getElementById("techSignoffSubmit");
  if (!submit) return;
  const name = (document.getElementById("techSignoffName")?.value || "").trim();
  const ack = !!document.getElementById("techSignoffAck")?.checked;
  const drawn = !!(state.signaturePad && state.signaturePad.isDirty());
  // Brief F — AI bonus decision must be captured before signature when
  // the WO is bonus-eligible. Gates the submit button so the tech can't
  // sign a WO with a pending bonus decision (the decision becomes
  // irrevocable at signature per SCOPE_PROTECTED_FIELDS).
  const ig = state.intakeGuarantee || {};
  const bonusGateOk = !ig.applies || ig.matched === true || ig.matched === false;
  const readinessFails = preSignReadinessFailures();
  const readinessOk = readinessFails.length === 0;
  submit.disabled = !(name && ack && drawn && bonusGateOk && readinessOk);

  // Render the always-visible pre-sign checklist (Brief: WO Field-
  // Readiness §6.3). Every gate shows with ✓ or ⨯ + label, regardless
  // of whether it passes. Tapping a gate scrolls to its capture
  // surface. Replaces the former "show only on partial fill" pattern.
  renderPreSignChecklist({ name, ack, drawn, bonusGateOk });

  if (!bonusGateOk) {
    submit.title = "Resolve the AI Correct Diagnosis Bonus decision before signing.";
  } else if (!readinessOk) {
    submit.title = readinessFails.join(" • ");
  } else {
    submit.removeAttribute("title");
  }
}

// Build the pre-sign checklist contents — every gate as a row with a
// ✓ or ⨯ icon, the gate label, and a `data-jump` target that scrolls
// the relevant surface into view when tapped. Re-runs on every state
// change via updateSignoffSubmitState. Brief: WO Field-Readiness §6.3.
function renderPreSignChecklist({ name, ack, drawn, bonusGateOk }) {
  const list = document.getElementById("techPreSignList");
  if (!list) return;
  const ig = state.intakeGuarantee || {};
  const minPhotos = TECH_PHOTO_REQUIREMENT_BY_TYPE[state.type] ?? 1;
  const photoCount = Array.isArray(state.photos) ? state.photos.length : 0;
  const photoOk = minPhotos === 0 || photoCount >= minPhotos;
  const untouchedZones = (state.zones || []).filter((z) => {
    if (z.status && z.status !== "") return false;
    const checks = z.checks || {};
    return !Object.values(checks).some(Boolean);
  });
  const zonesOk = untouchedZones.length === 0;
  let cfOk = true;
  if (state.type === "spring_opening") {
    cfOk = !document.querySelectorAll('#techCarryForwardList [data-deferred-id]').length;
  }
  // Payment + materials gates promoted from post-sign per the brief.
  const paymentOk = state.paidOnSite === true || state.paidOnSite === false;
  // Materials gate only applies when the materials section is currently
  // visible (i.e. this is a follow-up visit with a packing list). When
  // hidden, treat the gate as satisfied so non-followup WOs aren't
  // blocked. "Confirmed" = every row has packed > 0 OR the tech has
  // explicitly cleared the section (no rows expected). Brief: §6.2.
  const materialsSection = document.getElementById("techMaterialsSection");
  const materialsVisible = materialsSection && !materialsSection.hidden;
  let materialsOk = true;
  if (materialsVisible) {
    const rows = document.querySelectorAll("#techMaterialsList .tech-materials-row");
    if (rows.length) {
      const unpacked = Array.from(rows).filter((r) => !r.classList.contains("is-packed"));
      materialsOk = unpacked.length === 0;
    }
  }

  // Gate list — preserves the brief's example order. Each entry:
  //   key: stable id, label: human text, ok: bool, jumpTo: css selector.
  // Return-visit gate (v27) — tri-state. true/false both satisfy.
  const returnOk = state.needsReturnVisit === true || state.needsReturnVisit === false;
  const gates = [
    { key: "name",  label: "Customer name entered",  ok: !!name,  jumpTo: "#techSignoffName" },
    { key: "ack",   label: "Acknowledgment ticked",  ok: ack,     jumpTo: "#techSignoffAck" },
    { key: "drawn", label: "Signature drawn",        ok: drawn,   jumpTo: "#techSignoffCanvas" },
    { key: "return", label: "Need a return visit? (Yes / No)", ok: returnOk, jumpTo: "#techReturnGateSection" },
    { key: "payment", label: "Payment method selected", ok: paymentOk, jumpTo: "#techPaymentSection" }
  ];
  if (ig.applies) {
    gates.push({ key: "bonus", label: "AI bonus decision recorded", ok: bonusGateOk, jumpTo: "#techIntakeGuarantee" });
  }
  if (minPhotos > 0) {
    gates.push({
      key: "photos",
      label: minPhotos === 1
        ? "Completion photo captured"
        : `${minPhotos} completion photos captured`,
      ok: photoOk,
      jumpTo: "#techWoPhotosSection"
    });
  }
  gates.push({
    key: "zones",
    label: zonesOk ? "All zones reviewed" : `${untouchedZones.length} zone${untouchedZones.length === 1 ? "" : "s"} not yet reviewed`,
    ok: zonesOk,
    jumpTo: "#techZoneList"
  });
  if (state.type === "spring_opening") {
    gates.push({
      key: "carryforward",
      label: cfOk ? "Carry-forward items resolved" : "Carry-forward items need an action",
      ok: cfOk,
      jumpTo: "#techCarryForward"
    });
  }
  if (materialsVisible) {
    gates.push({ key: "materials", label: "Materials check confirmed", ok: materialsOk, jumpTo: "#techMaterialsSection" });
  }
  list.innerHTML = gates.map((g) =>
    `<li class="tech-pre-sign-row" data-ok="${g.ok ? "1" : "0"}" data-jump="${escapeHtml(g.jumpTo)}">
       <span class="tech-pre-sign-icon" aria-hidden="true">${g.ok ? "✓" : "✕"}</span>
       <span class="tech-pre-sign-label">${escapeHtml(g.label)}</span>
     </li>`
  ).join("");
}

// Tap-to-jump on a pre-sign checklist row — scrolls the relevant
// capture surface into view so the tech can resolve a gap without
// scrolling around manually. Delegated once at module load.
document.getElementById("techPreSignList")?.addEventListener("click", (event) => {
  const row = event.target.closest("[data-jump]");
  if (!row) return;
  const target = document.querySelector(row.dataset.jump);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  // Optional: focus the input if the target is one. iOS keyboard pops
  // up which is what the tech wants when, e.g., jumping to the name.
  if (target.matches("input, textarea, select")) {
    setTimeout(() => target.focus(), 250);
  }
});

// Same checks as walkoutCheckFailures(), minus the "signature missing"
// gate — used pre-sign to prove the WO is ready to be marked complete
// at the moment the customer signs (since signing now also completes
// the visit per the merged button). Mirrored gates: zone walk, photo
// gate, carry-forward resolution, plus the newly-promoted paidOnSite
// + materials check gates per Brief: WO Field-Readiness §6.2.
function preSignReadinessFailures() {
  const fails = [];
  const untouched = (state.zones || []).filter((z) => {
    if (z.status && z.status !== "") return false;
    const checks = z.checks || {};
    return !Object.values(checks).some(Boolean);
  });
  if (untouched.length) {
    fails.push(`${untouched.length} zone${untouched.length === 1 ? "" : "s"} haven't been checked yet (zones ${untouched.map((z) => z.number).join(", ")}).`);
  }
  if (state.type === "spring_opening") {
    const openCfCards = document.querySelectorAll('#techCarryForwardList [data-deferred-id]');
    if (openCfCards.length) {
      fails.push(`${openCfCards.length} carry-forward recommendation${openCfCards.length === 1 ? "" : "s"} still need an action (Repair / Decline / Already fixed / Can't locate).`);
    }
  }
  const minPhotos = TECH_PHOTO_REQUIREMENT_BY_TYPE[state.type] ?? 1;
  if (minPhotos > 0) {
    const photoCount = Array.isArray(state.photos) ? state.photos.length : 0;
    if (photoCount < minPhotos) {
      fails.push(`Capture ${minPhotos === 1 ? "at least one completion photo" : `at least ${minPhotos} completion photos`} before signing.`);
    }
  }
  // Payment-method gate — promoted from post-sign to pre-sign so the
  // cascade fires with the right paidOnSiteAtCompletion flag on the
  // draft invoice. null = neither radio chosen.
  if (state.paidOnSite !== true && state.paidOnSite !== false) {
    fails.push("Pick a payment method (Yes / No — invoice to follow).");
  }
  // Return-visit decision gate (v27). Forces the tech to answer "Yes"
  // (which reveals the parts-to-bring-back + follow-up sections) or
  // "No" (today's visit closes the work order) before signing.
  if (state.needsReturnVisit !== true && state.needsReturnVisit !== false) {
    fails.push("Answer 'Need a return visit?' (Yes or No).");
  }
  // Materials check — only blocks when the section is visible (follow-
  // up visit with a packing list) AND there's an unpacked row. Non-
  // follow-up WOs skip this gate entirely.
  const materialsSection = document.getElementById("techMaterialsSection");
  if (materialsSection && !materialsSection.hidden) {
    const rows = document.querySelectorAll("#techMaterialsList .tech-materials-row");
    if (rows.length) {
      const unpacked = Array.from(rows).filter((r) => !r.classList.contains("is-packed"));
      if (unpacked.length) {
        fails.push(`Mark ${unpacked.length} remaining material${unpacked.length === 1 ? "" : "s"} as packed (or remove the line items they came from).`);
      }
    }
  }
  // Cascade-merge follow-up — brief-literal §4.6 materials gate.
  // Layered on top of the techMaterialsSection packing-rows gate
  // above. This fires when the tech has parts on the truck (Parts to
  // bring back) and hasn't tapped "Confirm materials list" since the
  // last qty change. Auto-passes for fall_closing + empty-materials
  // WOs via hydrate()'s server-side auto-confirm.
  if (!state.materialsConfirmedAt) {
    fails.push("Tap “Confirm materials list is accurate” in the Parts to bring back section.");
  }
  return fails;
}

document.getElementById("techSignoffName")?.addEventListener("input", updateSignoffSubmitState);
document.getElementById("techSignoffAck")?.addEventListener("change", updateSignoffSubmitState);
document.getElementById("techSignoffClear")?.addEventListener("click", () => {
  if (state.locked) return;
  state.signaturePad?.clear();
});

document.getElementById("techSignoffSubmit")?.addEventListener("click", async () => {
  if (state.locked) return;
  const submit = document.getElementById("techSignoffSubmit");
  const nameEl = document.getElementById("techSignoffName");
  const ackEl  = document.getElementById("techSignoffAck");
  const customerName = (nameEl?.value || "").trim();
  if (!customerName || !ackEl?.checked || !state.signaturePad?.isDirty()) return;

  // Last-line defence — gates should already have disabled the button,
  // but verify before the irreversible PATCH.
  const readinessFails = preSignReadinessFailures();
  if (readinessFails.length) {
    alert("Can't sign yet:\n\n• " + readinessFails.join("\n• ") + "\n\nResolve these first.");
    return;
  }

  submit.disabled = true;
  submit.textContent = "Signing & invoicing…";
  try {
    const imageData = state.signaturePad.toDataURL();
    // Combined PATCH: signature + status → completed in one round-trip.
    // The server applies the signature (sets wo.locked = true), flips
    // status to "completed", AWAITS the cascade, and returns the new
    // invoice id in response.cascade.invoiceId. Spec §4.3.2 / §4.3.4.
    //
    // arrivedAt + departedAt back-fill: the legacy two-tap flow auto-
    // stamped these on each status change via the [data-run-status]
    // click handler. With the merge, we set them here if absent so
    // the On-Site Execution timestamps stay correct.
    const nowIso = new Date().toISOString();
    const payload = {
      signature: { customerName, imageData, acknowledgement: true },
      status: "completed"
    };
    if (!state.arrivedAt) payload.arrivedAt = nowIso;
    if (!state.departedAt) payload.departedAt = nowIso;
    const response = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error((data.errors && data.errors[0]) || "Couldn't save signature.");
    }
    state.signature = data.workOrder.signature || state.signature;
    state.locked = data.workOrder.locked === true;
    state.status = data.workOrder.status || state.status;
    state.departedAt = data.workOrder.departedAt || state.departedAt;
    // Track the new updatedAt so any subsequent patchWorkOrder call
    // (paidOnSite toggle, materials sync, late tech note) sends the
    // fresh If-Match header. Without this, the very next post-sign
    // PATCH would 409 and pop the conflict banner.
    if (data.workOrder.updatedAt) state.updatedAt = data.workOrder.updatedAt;
    // Surface the freshly-drafted invoice id immediately — no polling
    // race. data.cascade is present when the cascade fired this PATCH.
    if (data.cascade && data.cascade.invoiceId) {
      state.completedInvoiceId = data.cascade.invoiceId;
    }
    // Cascade error path (Brief: WO Field-Readiness §6.4) — signature
    // and lock persisted, but the downstream artifacts didn't land.
    // Surface a non-blocking alert so the tech knows to tap the
    // recovery button. The recovery surface auto-renders below.
    if (data.cascade && data.cascade.error && !data.cascade.invoiceId) {
      alert(`Visit signed and locked. Invoice generation hit a snag — tap "Re-run cascade" below to retry, or create one manually.\n\n(${data.cascade.error})`);
    }
    // Pick up the fresh history (cascade_fire + invoice_drafted just
    // got appended server-side) and the freshest zone/property snapshot.
    if (Array.isArray(data.workOrder.history)) state.history = data.workOrder.history;
    renderSignoff();
    renderExecutionTimestamps();
    renderRunStatus();
    renderPostSigBanner();
    renderTechHistory();
    applyLockState(state.locked);
    renderCascadeRecovery();
  } catch (err) {
    submit.disabled = false;
    submit.textContent = "Sign, lock & generate invoice";
    alert(err.message || "Couldn't save signature.");
  }
});

// Decide whether to show the cascade-recovery surface inside the
// signoff card. Brief: WO Field-Readiness §6.5 — visible only when
// the WO is locked AND a downstream artifact didn't land. Two
// independent buttons:
//   - "Generate invoice now" when locked && no invoice on this WO
//   - "Re-run cascade" when locked && no cascade_fire history entry
// On a clean WO neither button renders, and the parent container
// stays hidden so the layout doesn't shift.
function renderCascadeRecovery() {
  const wrap = document.getElementById("techCascadeRecovery");
  if (!wrap) return;
  const locked = state.locked === true || state.signature?.signed === true;
  if (!locked) { wrap.hidden = true; return; }
  const history = Array.isArray(state.history) ? state.history : [];
  const cascadeFired = history.some((h) => h && h.action === "cascade_fire");
  const hasInvoice = !!state.completedInvoiceId;
  const genBtn = document.getElementById("techGenerateInvoiceBtn");
  const runBtn = document.getElementById("techRunCascadeBtn");
  const help = document.getElementById("techCascadeRecoveryHelp");
  const showGen = locked && !hasInvoice;
  const showRun = locked && !cascadeFired;
  if (genBtn) genBtn.hidden = !showGen;
  if (runBtn) runBtn.hidden = !showRun;
  if (help) {
    help.textContent = !cascadeFired
      ? "Signed and locked, but the completion cascade didn't fire. Re-run to draft the invoice + service record."
      : !hasInvoice
        ? "Cascade fired, but no draft invoice landed. Try Generate invoice now."
        : "Recovery actions for this signed WO.";
  }
  wrap.hidden = !(showGen || showRun);
}

document.getElementById("techGenerateInvoiceBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("techGenerateInvoiceBtn");
  const status = document.getElementById("techCascadeRecoveryStatus");
  if (!btn || !state.id) return;
  if (!confirm("Draft an invoice from this WO's line items?")) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "Drafting…";
  if (status) { status.hidden = true; status.textContent = ""; }
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}/create-invoice`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't draft invoice.");
    if (data.invoice && data.invoice.id) {
      state.completedInvoiceId = data.invoice.id;
      if (status) {
        status.hidden = false;
        status.innerHTML = `Draft invoice <a href="/admin/invoice/${encodeURIComponent(data.invoice.id)}" class="tech-postsig-link">${escapeHtml(data.invoice.id)}</a> on file.`;
      }
    }
    renderCascadeRecovery();
    renderPostSigBanner();
  } catch (err) {
    if (status) { status.hidden = false; status.textContent = err.message || "Couldn't draft invoice."; }
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

document.getElementById("techRunCascadeBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("techRunCascadeBtn");
  const status = document.getElementById("techCascadeRecoveryStatus");
  if (!btn || !state.id) return;
  if (!confirm("Re-run the completion cascade? Idempotent — safe to retry.")) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "Running…";
  if (status) { status.hidden = true; status.textContent = ""; }
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}/run-cascade`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't run cascade.");
    if (data.invoice && data.invoice.id) state.completedInvoiceId = data.invoice.id;
    // Refresh full WO state so the new history entries surface.
    try {
      const r2 = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}`);
      const d2 = await r2.json().catch(() => ({}));
      if (d2.ok && d2.workOrder && Array.isArray(d2.workOrder.history)) state.history = d2.workOrder.history;
    } catch (_e) {}
    if (status) {
      status.hidden = false;
      status.textContent = data.alreadyRan
        ? "Cascade had already fired — nothing to do."
        : (data.invoice?.id ? `Cascade fired. Invoice ${data.invoice.id} drafted.` : "Cascade fired. No billable line items.");
    }
    renderCascadeRecovery();
    renderTechHistory();
    renderPostSigBanner();
  } catch (err) {
    if (status) { status.hidden = false; status.textContent = err.message || "Couldn't run cascade."; }
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// Apply the locked / unlocked state across the whole page. When locked,
// the body gets data-locked="true" so CSS can grey out interactive
// surfaces; we also explicitly disable form inputs and buttons (defence
// in depth — pointer-events alone won't stop keyboard activations).
function applyLockState(locked) {
  document.body.dataset.locked = locked ? "true" : "false";
  const banner = document.getElementById("techLockedBanner");
  const meta = document.getElementById("techLockedMeta");
  if (banner) banner.hidden = !locked;
  // Floating photo FAB hides on locked WO (no more uploads accepted)
  // and appears as soon as the WO is editable.
  if (typeof updateFloatingPhotoBtn === "function") updateFloatingPhotoBtn();
  if (locked && meta) {
    const parts = [];
    if (state.signature?.customerName) parts.push(`by ${state.signature.customerName}`);
    if (state.signature?.signedAt) parts.push(formatDateTime(state.signature.signedAt));
    meta.textContent = parts.length ? `· ${parts.join(" · ")}` : "";
  }
  // Disable run-status taps, zone taps, notes, and checklist taps.
  // Sign-off form stays mounted (renderSignoff swaps to read-only view)
  // but its inputs get disabled too in case the swap raced.
  const disable = (selector) => document.querySelectorAll(selector).forEach((el) => {
    if (locked) el.setAttribute("disabled", "");
    else el.removeAttribute("disabled");
  });
  disable("#techRunStatus button");
  disable("#techNotes");
  disable("#techServiceChecklistList button");
  disable("#techZoneList button");
  disable("#techAddZoneBtn");
  disable("#sheetDeleteZone");
  disable("#techSignoffName");
  disable("#techSignoffAck");
  disable("#techSignoffSubmit");
  disable("#techSignoffClear");
}

// ---- Issues → Draft Quote (on-site rollup) ----------------------

const ON_SITE_FIND_ONLY = "fall_closing";

function hasAnyIssues() {
  return (state.zones || []).some((z) => Array.isArray(z.issues) && z.issues.length > 0);
}

function formatMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "$0.00";
  return v < 0
    ? "-$" + Math.abs(v).toFixed(2)
    : "$" + v.toFixed(2);
}

function effectiveLinePrice(line) {
  if (line && line.overridePrice != null && Number.isFinite(Number(line.overridePrice))) {
    return Number(line.overridePrice);
  }
  return Number(line && line.originalPrice) || 0;
}

function lineRowTotal(line) {
  return Math.round(effectiveLinePrice(line) * (Number(line.qty) || 0) * 100) / 100;
}

function totalsForLines(lines) {
  let subtotal = 0;
  for (const line of lines || []) subtotal += lineRowTotal(line);
  subtotal = Math.round(subtotal * 100) / 100;
  const hst = Math.round(subtotal * 0.13 * 100) / 100;
  const total = Math.round((subtotal + hst) * 100) / 100;
  return { subtotal, hst, total };
}

// Top-level entry. Decides which mode to display:
//   - none/zero issues across all zones → hide the whole section
//   - fall_closing → defer-only state
//   - already submitted (status=accepted/partially_accepted/declined and quote linked) → submitted summary
//   - has builder lines → builder edit state
//   - default (issues exist but builder empty) → builder with "Generate from issues" CTA
function renderOnSiteQuote() {
  // Re-render the dependent blocks (Materials + Payment) whenever the
  // quote builder re-renders. They derive entirely from the current
  // builderLineItems so they have to stay in sync.
  renderMaterials();
  renderPaymentBlock();
  const section = document.getElementById("techOnSiteQuote");
  if (!section) return;
  if (!hasAnyIssues()) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const findOnly = state.type === ON_SITE_FIND_ONLY;
  const intakeNote = document.getElementById("techOnSiteIntakeNote");
  const titleEl = document.getElementById("techOnSiteQuoteTitle");
  const builder = document.getElementById("techOnSiteBuilder");
  const review = document.getElementById("techOnSiteReview");
  const submitted = document.getElementById("techOnSiteSubmitted");
  const defer = document.getElementById("techOnSiteDefer");

  // Reset all sub-states
  if (builder) builder.hidden = true;
  if (review) review.hidden = true;
  if (submitted) submitted.hidden = true;
  if (defer) defer.hidden = true;
  if (intakeNote) intakeNote.hidden = true;

  if (findOnly) {
    if (titleEl) titleEl.textContent = "Issues found this visit";
    if (defer) defer.hidden = false;
    return;
  }

  if (titleEl) titleEl.textContent = "Build draft quote";
  // AI-Correct-Diagnosis Bonus callout: only shown when an AI repair quote
  // produced this WO and its bonus eligibility flag is set (pending until
  // tech confirms on-site diagnosis matches the quoted scope).
  if (state.intakeGuarantee?.applies && intakeNote) intakeNote.hidden = false;

  // Submitted state (already accepted) takes precedence — show read-only summary.
  if (state.onSiteQuote?.status === "accepted" || state.onSiteQuote?.status === "partially_accepted" || (state.onSiteQuote?.status === "declined" && state.onSiteQuote?.quoteId === null)) {
    if (state.onSiteQuote.status === "declined") {
      // declined-all: no Quote, just show the deferred summary
      if (submitted) submitted.hidden = false;
      renderOnSiteSubmitted();
      return;
    }
    if (state.onSiteQuote.quoteId) {
      if (submitted) submitted.hidden = false;
      renderOnSiteSubmitted();
      return;
    }
  }

  // Otherwise show the right sub-state for the current uiMode.
  if (state.onSiteUiMode === "review") {
    if (review) review.hidden = false;
    renderOnSiteReview();
  } else {
    if (builder) builder.hidden = false;
    renderOnSiteBuilder();
  }
}

function renderOnSiteBuilder() {
  const lines = (state.onSiteQuote && state.onSiteQuote.builderLineItems) || [];
  const buildBtn = document.getElementById("techOnSiteBuildBtn");
  const addBtn = document.getElementById("techOnSiteAddBtn");
  const showBtn = document.getElementById("techOnSiteShowBtn");
  const totalsEl = document.getElementById("techOnSiteTotals");
  const linesEl = document.getElementById("techOnSiteLines");
  const countEl = document.getElementById("techOnSiteQuoteCount");

  // Build button label flips between "Generate from issues" (first run) and
  // "Re-generate from issues" (re-run after edits).
  if (buildBtn) {
    buildBtn.firstChild?.nextSibling && (buildBtn.querySelector("span:last-child").textContent = lines.length ? "Re-generate from issues" : "Generate from issues");
  }
  if (addBtn) addBtn.hidden = !lines.length;
  if (showBtn) showBtn.hidden = !lines.length;
  updateOnSiteShowBtnState();

  if (!linesEl) return;
  linesEl.innerHTML = "";
  lines.forEach((line, idx) => {
    const li = document.createElement("li");
    li.className = "tech-on-site-line";
    li.dataset.idx = String(idx);
    const overridden = line.overridePrice != null && Number(line.overridePrice) !== Number(line.originalPrice);
    const priceVal = line.overridePrice != null ? Number(line.overridePrice) : Number(line.originalPrice);
    li.innerHTML = `
      <div class="tech-on-site-line-head">
        <input type="text" class="tech-on-site-line-label" value="${escapeHtml(line.label || "")}" placeholder="Describe the work…" maxlength="200" aria-label="Line description">
        <button type="button" class="tech-on-site-line-remove" data-action="remove-line" aria-label="Remove line">×</button>
      </div>
      <div class="tech-on-site-line-controls">
        <label>
          <span>Qty</span>
          <input type="number" min="1" inputmode="numeric" class="tech-on-site-line-qty" value="${escapeHtml(String(line.qty || 1))}">
        </label>
        <label>
          <span>Unit price${overridden ? ' <em class="tech-on-site-overridden">override</em>' : ""}</span>
          <input type="number" min="0" step="0.01" inputmode="decimal" class="tech-on-site-line-price" value="${escapeHtml(priceVal.toFixed(2))}">
        </label>
        <span class="tech-on-site-line-total">${formatMoney(lineRowTotal(line))}</span>
      </div>
      ${line.note ? `<p class="tech-on-site-line-note">${escapeHtml(line.note)}</p>` : ""}
    `;
    linesEl.appendChild(li);
  });

  if (totalsEl) {
    if (lines.length) {
      const t = totalsForLines(lines);
      totalsEl.hidden = false;
      totalsEl.innerHTML = `Subtotal <strong>${formatMoney(t.subtotal)}</strong> · HST <strong>${formatMoney(t.hst)}</strong> · <span class="tech-on-site-total-final">${formatMoney(t.total)}</span>`;
    } else {
      totalsEl.hidden = true;
    }
  }
  if (countEl) countEl.textContent = lines.length ? `${lines.length} line${lines.length === 1 ? "" : "s"}` : "";
}

// Gate "Show to customer" until every line has a description. Called from
// the renderer AND from the live label-input handler so the button flips
// the moment the tech types.
function updateOnSiteShowBtnState() {
  const showBtn = document.getElementById("techOnSiteShowBtn");
  if (!showBtn) return;
  const lines = (state.onSiteQuote && state.onSiteQuote.builderLineItems) || [];
  const unlabeled = lines.filter((l) => !String(l && l.label || "").trim()).length;
  if (unlabeled > 0) {
    showBtn.disabled = true;
    showBtn.textContent = unlabeled === 1
      ? "Add a description to 1 line first"
      : `Add descriptions to ${unlabeled} lines first`;
  } else {
    showBtn.disabled = false;
    showBtn.textContent = "Show to customer →";
  }
}

function renderOnSiteReview() {
  const lines = (state.onSiteQuote && state.onSiteQuote.builderLineItems) || [];
  const linesEl = document.getElementById("techOnSiteReviewLines");
  const totalsEl = document.getElementById("techOnSiteReviewTotals");
  if (!linesEl) return;

  // Initialize decisions to "all accepted" if not already shaped.
  if (!Array.isArray(state.onSiteDecisions) || state.onSiteDecisions.length !== lines.length) {
    state.onSiteDecisions = lines.map((_l, i) => ({ lineItemIdx: i, accepted: true }));
  }

  linesEl.innerHTML = "";
  lines.forEach((line, idx) => {
    const decision = state.onSiteDecisions[idx];
    const accepted = decision ? decision.accepted : true;
    const li = document.createElement("li");
    li.className = "tech-on-site-review-line";
    li.dataset.idx = String(idx);
    li.dataset.accepted = accepted ? "1" : "0";
    li.innerHTML = `
      <label class="tech-on-site-review-checkbox">
        <input type="checkbox" data-decision-idx="${idx}" ${accepted ? "checked" : ""}>
        <span class="tech-on-site-review-line-label">${escapeHtml(line.label || "(unlabeled)")}</span>
      </label>
      <div class="tech-on-site-review-line-meta">
        <span>Qty ${escapeHtml(String(line.qty || 1))}</span>
        <strong>${formatMoney(lineRowTotal(line))}</strong>
      </div>
    `;
    linesEl.appendChild(li);
  });

  // Totals show ACCEPTED-only — what the customer is actually paying.
  const acceptedLines = lines.filter((_l, i) => state.onSiteDecisions[i]?.accepted);
  const t = totalsForLines(acceptedLines);
  if (totalsEl) {
    totalsEl.innerHTML = `Customer pays <strong>${formatMoney(t.total)}</strong> (${formatMoney(t.subtotal)} + ${formatMoney(t.hst)} HST)`;
  }
  updateOnSiteSubmitState();
}

function renderOnSiteSubmitted() {
  const summaryEl = document.getElementById("techOnSiteSubmittedSummary");
  const imageEl = document.getElementById("techOnSiteSubmittedImage");
  const metaEl = document.getElementById("techOnSiteSubmittedMeta");
  if (!summaryEl) return;
  const status = state.onSiteQuote?.status;
  if (status === "declined") {
    summaryEl.textContent = "Customer declined all items. Saved as deferred recommendations on the property.";
    if (imageEl) imageEl.innerHTML = "";
    if (metaEl) metaEl.textContent = "";
    return;
  }
  const lines = state.onSiteQuote?.builderLineItems || [];
  const acceptedCount = (state.onSiteQuote?.builderLineItems || []).filter((_l, i) => {
    // Best-effort — read from the full Quote if we have it later, but
    // for the on-the-fly summary the WO knows status and decisions stay
    // out of the WO record. Show a generic line.
    return true;
  }).length;
  summaryEl.textContent = status === "partially_accepted"
    ? `Customer accepted some items. Declined items saved as deferred recommendations.`
    : `Customer accepted all ${lines.length} line${lines.length === 1 ? "" : "s"}. Quote ${state.onSiteQuote?.quoteId || ""} on file.`;
  if (metaEl) metaEl.textContent = state.onSiteQuote?.quoteId ? `Quote ${state.onSiteQuote.quoteId}` : "";
}

function updateOnSiteSubmitState() {
  const submit = document.getElementById("techOnSiteSubmitBtn");
  if (!submit) return;
  if (state.locked) { submit.disabled = true; return; }
  const name = (document.getElementById("techOnSiteSigName")?.value || "").trim();
  const ack = !!document.getElementById("techOnSiteSigAck")?.checked;
  const drawn = !!(state.onSiteSigPad && state.onSiteSigPad.isDirty());
  // Need at least one accepted line
  const anyAccepted = (state.onSiteDecisions || []).some((d) => d && d.accepted);
  submit.disabled = !(name && ack && drawn && anyAccepted);
}

// Patch builder lines back to the server. Debounced to avoid PATCHing
// on every keystroke while the tech is editing qty / price.
function persistBuilderLines() {
  if (state.onSiteBuilderTimer) {
    clearTimeout(state.onSiteBuilderTimer);
    state.onSiteBuilderTimer = null;
  }
  const lines = (state.onSiteQuote && state.onSiteQuote.builderLineItems) || [];
  fetch(`/api/work-orders/${encodeURIComponent(state.id)}/on-site-quote/builder`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lineItems: lines })
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok && data.workOrder) {
      // Server sometimes corrects line shapes (re-snapshots originalPrice).
      // Pull the canonical version back so subsequent edits are based on truth.
      state.onSiteQuote = data.workOrder.onSiteQuote || state.onSiteQuote;
      // Don't re-render on success — the user is mid-edit; their inputs
      // already reflect the truth.
    }
  }).catch(() => {});
}

function scheduleBuilderPersist() {
  if (state.onSiteBuilderTimer) clearTimeout(state.onSiteBuilderTimer);
  state.onSiteBuilderTimer = setTimeout(persistBuilderLines, 800);
}

// ---- On-site quote event handlers --------------------------------

document.getElementById("techOnSiteBuildBtn")?.addEventListener("click", async () => {
  if (state.locked) return;
  const btn = document.getElementById("techOnSiteBuildBtn");
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}/on-site-quote/build`, {
      method: "POST"
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      throw new Error((data.errors && data.errors[0]) || "Couldn't build quote.");
    }
    if (data.workOrder) {
      state.onSiteQuote = data.workOrder.onSiteQuote || state.onSiteQuote;
    }
    state.onSiteUiMode = "builder";
    renderOnSiteQuote();
  } catch (err) {
    alert(err.message || "Couldn't build quote.");
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.getElementById("techOnSiteLines")?.addEventListener("click", (event) => {
  if (state.locked) return;
  if (event.target.matches('[data-action="remove-line"]')) {
    const li = event.target.closest(".tech-on-site-line");
    if (!li) return;
    const idx = Number(li.dataset.idx);
    const lines = state.onSiteQuote.builderLineItems || [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= lines.length) return;
    lines.splice(idx, 1);
    state.onSiteQuote.builderLineItems = lines;
    renderOnSiteBuilder();
    persistBuilderLines();
  }
});

document.getElementById("techOnSiteLines")?.addEventListener("input", (event) => {
  if (state.locked) return;
  const li = event.target.closest(".tech-on-site-line");
  if (!li) return;
  const idx = Number(li.dataset.idx);
  const line = state.onSiteQuote.builderLineItems?.[idx];
  if (!line) return;
  if (event.target.classList.contains("tech-on-site-line-qty")) {
    const next = Math.max(1, Math.floor(Number(event.target.value) || 1));
    line.qty = next;
  } else if (event.target.classList.contains("tech-on-site-line-price")) {
    const v = Number(event.target.value);
    if (Number.isFinite(v) && v >= 0) {
      // Override only when the value differs from originalPrice (so a
      // tech who types the same number doesn't tag the line as overridden).
      line.overridePrice = Math.abs(v - Number(line.originalPrice)) < 0.005 ? null : v;
    }
  } else if (event.target.classList.contains("tech-on-site-line-label")) {
    line.label = String(event.target.value || "").slice(0, 200);
    // Re-evaluate the "Show to customer" gate live as the tech types.
    updateOnSiteShowBtnState();
    // Persist on debounce; no in-place re-render needed (the value the
    // tech is typing is already what's on screen).
    scheduleBuilderPersist();
    return;
  } else {
    return;
  }
  // Update only the row total + grand totals; full re-render would
  // wipe the input the tech is currently editing.
  const totalEl = li.querySelector(".tech-on-site-line-total");
  if (totalEl) totalEl.textContent = formatMoney(lineRowTotal(line));
  const totalsEl = document.getElementById("techOnSiteTotals");
  if (totalsEl) {
    const t = totalsForLines(state.onSiteQuote.builderLineItems);
    totalsEl.innerHTML = `Subtotal <strong>${formatMoney(t.subtotal)}</strong> · HST <strong>${formatMoney(t.hst)}</strong> · <span class="tech-on-site-total-final">${formatMoney(t.total)}</span>`;
  }
  scheduleBuilderPersist();
});

document.getElementById("techOnSiteAddBtn")?.addEventListener("click", () => {
  if (state.locked) return;
  state.onSiteQuote.builderLineItems = state.onSiteQuote.builderLineItems || [];
  state.onSiteQuote.builderLineItems.push({
    key: null,
    label: "",
    qty: 1,
    originalPrice: 0,
    overridePrice: null,
    custom: true,
    source: { zoneNumbers: [], issueIds: [] },
    note: ""
  });
  renderOnSiteBuilder();
  persistBuilderLines();
});

document.getElementById("techOnSiteShowBtn")?.addEventListener("click", () => {
  // Defense in depth: never show the customer a quote with unlabeled lines,
  // even if the disabled state was bypassed somehow.
  const lines = (state.onSiteQuote && state.onSiteQuote.builderLineItems) || [];
  if (!lines.length || lines.some((l) => !String(l && l.label || "").trim())) return;
  state.onSiteUiMode = "review";
  state.onSiteDecisions = (state.onSiteQuote.builderLineItems || []).map((_l, i) => ({ lineItemIdx: i, accepted: true }));
  // Lazy-init the second signature pad on first review render.
  setTimeout(() => {
    if (!state.onSiteSigPad) {
      const canvas = document.getElementById("techOnSiteSigCanvas");
      if (canvas) state.onSiteSigPad = createSignaturePad(canvas, updateOnSiteSubmitState);
    }
  }, 0);
  renderOnSiteQuote();
});

document.getElementById("techOnSiteBackBtn")?.addEventListener("click", () => {
  state.onSiteUiMode = "builder";
  renderOnSiteQuote();
});

// Live decision-checkbox toggling in review state.
document.getElementById("techOnSiteReviewLines")?.addEventListener("change", (event) => {
  if (!event.target.matches("[data-decision-idx]")) return;
  const idx = Number(event.target.dataset.decisionIdx);
  if (!Array.isArray(state.onSiteDecisions) || idx < 0 || idx >= state.onSiteDecisions.length) return;
  state.onSiteDecisions[idx].accepted = !!event.target.checked;
  const li = event.target.closest(".tech-on-site-review-line");
  if (li) li.dataset.accepted = event.target.checked ? "1" : "0";
  // Recompute totals (accepted-only)
  const lines = state.onSiteQuote.builderLineItems || [];
  const acceptedLines = lines.filter((_l, i) => state.onSiteDecisions[i]?.accepted);
  const t = totalsForLines(acceptedLines);
  const totalsEl = document.getElementById("techOnSiteReviewTotals");
  if (totalsEl) {
    totalsEl.innerHTML = `Customer pays <strong>${formatMoney(t.total)}</strong> (${formatMoney(t.subtotal)} + ${formatMoney(t.hst)} HST)`;
  }
  updateOnSiteSubmitState();
});

document.getElementById("techOnSiteSigName")?.addEventListener("input", updateOnSiteSubmitState);
document.getElementById("techOnSiteSigAck")?.addEventListener("change", updateOnSiteSubmitState);
document.getElementById("techOnSiteSigClear")?.addEventListener("click", () => {
  if (state.locked) return;
  state.onSiteSigPad?.clear();
});

document.getElementById("techOnSiteSubmitBtn")?.addEventListener("click", async () => {
  if (state.locked) return;
  const submit = document.getElementById("techOnSiteSubmitBtn");
  const customerName = (document.getElementById("techOnSiteSigName")?.value || "").trim();
  const ack = !!document.getElementById("techOnSiteSigAck")?.checked;
  if (!customerName || !ack || !state.onSiteSigPad?.isDirty()) return;
  // If every line is declined, route to decline-all instead.
  const anyAccepted = (state.onSiteDecisions || []).some((d) => d && d.accepted);
  submit.disabled = true;
  submit.textContent = "Saving…";
  try {
    if (!anyAccepted) {
      const r = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}/on-site-quote/decline-all`, {
        method: "POST"
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't save.");
      if (data.workOrder) state.onSiteQuote = data.workOrder.onSiteQuote || state.onSiteQuote;
    } else {
      const imageData = state.onSiteSigPad.toDataURL();
      const r = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}/on-site-quote/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName,
          imageData,
          acknowledgement: true,
          decisions: state.onSiteDecisions
        })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't accept.");
      if (data.workOrder) state.onSiteQuote = data.workOrder.onSiteQuote || state.onSiteQuote;
    }
    state.onSiteUiMode = "submitted";
    renderOnSiteQuote();
  } catch (err) {
    submit.disabled = false;
    submit.textContent = "Sign & accept";
    alert(err.message || "Couldn't save.");
  }
});

// Remote approval — customer wasn't on-site to sign. Tech taps this to
// fire the email + SMS link to the customer-facing /approve/<id> page.
// Reuses the WO's customer email + phone from the WO record. Idempotent
// at the server: subsequent taps re-send to the same Q-YYYY-NNNN.
document.getElementById("techOnSiteSendApprovalBtn")?.addEventListener("click", async () => {
  if (state.locked) return;
  const btn = document.getElementById("techOnSiteSendApprovalBtn");
  const status = document.getElementById("techOnSiteRemoteStatus");
  if (!confirm(`Send the on-site quote to ${state.customerName || "the customer"} via email${state.customerPhone ? " + SMS" : ""} for remote approval?`)) return;
  btn.disabled = true;
  status.hidden = false;
  status.textContent = "Sending…";
  status.dataset.kind = "info";
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}/on-site-quote/send-for-approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sendEmail: !!state.customerEmail,
        sendSms: !!state.customerPhone,
        email: state.customerEmail,
        phone: state.customerPhone
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
    if (channels.length) {
      status.textContent = `Sent via ${channels.join(" + ")}. Quote ${data.quote.id}. Awaiting customer signature.`;
      status.dataset.kind = "ok";
    } else {
      status.textContent = `Quote created (${data.quote.id}) but no delivery channel succeeded. Errors: ${errs.join("; ")}.`;
      status.dataset.kind = "error";
    }
    // Refresh the WO status so the on-site quote section reflects the
    // sent_for_remote_approval state.
    const refreshed = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}`).then((r) => r.json()).catch(() => null);
    if (refreshed?.workOrder?.onSiteQuote) {
      state.onSiteQuote = refreshed.workOrder.onSiteQuote;
      renderOnSiteQuote();
    }
  } catch (err) {
    status.textContent = err.message || "Failed.";
    status.dataset.kind = "error";
  } finally {
    btn.disabled = false;
  }
});

// Find_only path — fall closing tech taps "Save to deferred recommendations"
document.getElementById("techOnSiteDeferBtn")?.addEventListener("click", async () => {
  if (state.locked) return;
  const btn = document.getElementById("techOnSiteDeferBtn");
  const success = document.getElementById("techOnSiteDeferSuccess");
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}/issues/defer`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't defer.");
    if (success) {
      success.hidden = false;
      success.textContent = `Saved ${data.deferredCount} item${data.deferredCount === 1 ? "" : "s"} to deferred recommendations.`;
    }
    // Issues were stripped server-side — pull a fresh WO so the zone list
    // re-renders empty and the section auto-hides.
    const refreshed = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}`).then((r) => r.json()).catch(() => null);
    if (refreshed?.workOrder?.zones) {
      state.zones = refreshed.workOrder.zones;
      renderZones();
      renderOnSiteQuote();
    }
  } catch (err) {
    alert(err.message || "Couldn't defer.");
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ---- Per-issue defer (fall mode) ---------------------------------------
// Click delegation in the zone sheet — one tap per issue row.
sheetIssues.addEventListener("click", async (event) => {
  const deferBtn = event.target.closest("[data-defer-issue]");
  const emergencyBtn = event.target.closest("[data-emergency-issue]");
  if (!deferBtn && !emergencyBtn) return;
  if (state.locked) return;
  const card = event.target.closest("[data-issue-id]");
  if (!card) return;
  const issueId = card.dataset.issueId;
  const zoneNumber = Number(card.dataset.zoneNumber);
  if (!issueId || !zoneNumber) return;

  if (deferBtn) {
    if (state.signature?.signed) {
      alert("Work order is signed and locked.");
      return;
    }
    deferBtn.disabled = true;
    try {
      const r = await fetch(
        `/api/work-orders/${encodeURIComponent(state.id)}/zones/${zoneNumber}/issues/${encodeURIComponent(issueId)}/defer`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't defer.");
      // Sync local state from the server response so the zone list re-renders.
      if (data.workOrder?.zones) state.zones = data.workOrder.zones;
      const idx = state.activeZoneIndex;
      if (idx >= 0) renderSheetIssues(state.zones[idx]);
      renderZones();
      renderOnSiteQuote();
    } catch (err) {
      alert(err.message || "Couldn't defer.");
      deferBtn.disabled = false;
    }
    return;
  }

  // Emergency — open the modal pre-loaded with this issue's metadata.
  openEmergencyModal({ issueId, zoneNumber, card });
});

// ---- Emergency override modal -----------------------------------------

let emergencyContext = null;
let emergencyPad = null;

function openEmergencyModal(ctx) {
  // Hard guards — refuse to open if the WO is locked, not a fall closing,
  // or the issue context is missing. Any of these indicate a stale click
  // from before sign-off or an out-of-band button. Fail loud (no silent
  // open with empty fields, which is what stranded the user the first time).
  if (state.locked || state.signature?.signed) {
    alert("Work order is signed and locked — emergency override unavailable. Refresh to clear.");
    return;
  }
  if (state.type !== ON_SITE_FIND_ONLY) {
    alert("Emergency override only applies to fall closings.");
    return;
  }
  const idx = state.activeZoneIndex;
  const zone = idx >= 0 ? state.zones[idx] : null;
  const issue = zone ? (zone.issues || []).find((i) => i.id === ctx.issueId) : null;
  if (!issue || !zone) {
    console.warn("[emergency] no live issue found for", ctx);
    return;
  }

  emergencyContext = ctx;
  const modal = document.getElementById("techEmergencyModal");
  const issueLabel = document.getElementById("techEmergencyIssueLabel");
  const reasonSel = document.getElementById("techEmergencyReason");
  const nameInput = document.getElementById("techEmergencyName");
  const submit = document.getElementById("techEmergencySubmit");
  const errEl = document.getElementById("techEmergencyError");
  if (!modal) return;

  if (issueLabel) {
    const typeLabel = ZONE_ISSUE_TYPE_OPTIONS.find((t) => t.value === issue.type)?.label || issue.type;
    const note = issue.notes ? ` — ${issue.notes}` : "";
    issueLabel.textContent = `Zone ${ctx.zoneNumber}: ${typeLabel} (qty ${issue.qty || 1})${note}`;
  }
  if (reasonSel) reasonSel.value = "";
  if (nameInput) nameInput.value = state.customerName || "";
  if (errEl) errEl.hidden = true;
  if (submit) submit.disabled = true;
  modal.hidden = false;
  document.body.classList.add("tech-emergency-open");

  // Lazy-init the canvas pad. Reuse the existing createSignaturePad helper.
  const canvas = document.getElementById("techEmergencyCanvas");
  if (canvas) {
    // Always recreate so resize math runs against the current modal layout.
    emergencyPad = createSignaturePad(canvas, updateEmergencySubmitState);
  }
  updateEmergencySubmitState();
}

function closeEmergencyModal() {
  const modal = document.getElementById("techEmergencyModal");
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove("tech-emergency-open");
  emergencyContext = null;
  emergencyPad = null;
}

function updateEmergencySubmitState() {
  const submit = document.getElementById("techEmergencySubmit");
  const reason = document.getElementById("techEmergencyReason")?.value;
  const name = document.getElementById("techEmergencyName")?.value.trim();
  const drawn = !!(emergencyPad && emergencyPad.isDirty && emergencyPad.isDirty());
  if (submit) submit.disabled = !(reason && name && drawn);
}

document.getElementById("techEmergencyClose")?.addEventListener("click", closeEmergencyModal);
document.getElementById("techEmergencyClear")?.addEventListener("click", () => {
  if (emergencyPad && emergencyPad.clear) emergencyPad.clear();
  updateEmergencySubmitState();
});
// Backdrop click — closes when the user taps the dimmed area outside the card.
document.getElementById("techEmergencyModal")?.addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeEmergencyModal();
});
// Esc key — universal escape hatch, only active while the modal is open.
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const modal = document.getElementById("techEmergencyModal");
  if (modal && !modal.hidden) closeEmergencyModal();
});
document.getElementById("techEmergencyReason")?.addEventListener("change", updateEmergencySubmitState);
document.getElementById("techEmergencyName")?.addEventListener("input", updateEmergencySubmitState);

document.getElementById("techEmergencySubmit")?.addEventListener("click", async () => {
  if (!emergencyContext) return;
  const submit = document.getElementById("techEmergencySubmit");
  const errEl = document.getElementById("techEmergencyError");
  if (errEl) errEl.hidden = true;
  if (submit) { submit.disabled = true; submit.textContent = "Sending…"; }
  try {
    const reason = document.getElementById("techEmergencyReason")?.value;
    const customerName = document.getElementById("techEmergencyName")?.value.trim();
    const imageData = emergencyPad?.toDataURL ? emergencyPad.toDataURL() : "";
    if (!reason || !customerName || !imageData) throw new Error("Fill reason, name, and signature.");
    const { issueId, zoneNumber } = emergencyContext;
    const r = await fetch(
      `/api/work-orders/${encodeURIComponent(state.id)}/zones/${zoneNumber}/issues/${encodeURIComponent(issueId)}/emergency`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          severity_reason: reason,
          customerSignature: { name: customerName, imageData }
        })
      }
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't process emergency.");
    if (data.workOrder?.zones) state.zones = data.workOrder.zones;
    if (data.workOrder?.techNotes != null) {
      state.techNotes = data.workOrder.techNotes;
      const ta = document.getElementById("techNotes");
      if (ta) ta.value = state.techNotes;
    }
    closeEmergencyModal();
    const idx = state.activeZoneIndex;
    if (idx >= 0) renderSheetIssues(state.zones[idx]);
    renderZones();
    renderOnSiteQuote();
    const followup = data.followupWoId ? `\nFollow-up WO ${data.followupWoId}` : "";
    alert(`Emergency logged. Patrick has been paged.${followup}`);
  } catch (err) {
    if (errEl) { errEl.textContent = err.message || "Failed."; errEl.hidden = false; }
    if (submit) { submit.disabled = false; submit.textContent = "Page Patrick & create follow-up"; }
  }
});

// ---- Carry-forward banner (spring openings) ---------------------------
// Loaded fresh every time the WO renders so portal pre-auths landing
// between WO open and tech arrival show up correctly. Snapshot pattern
// (embedding into wo.carryForward at create time) was rejected in the
// plan for that reason.

async function renderCarryForward(property) {
  const section = document.getElementById("techCarryForward");
  const list = document.getElementById("techCarryForwardList");
  const countEl = document.getElementById("techCarryForwardCount");
  if (!section || !list) return;
  if (state.type !== "spring_opening" || !property?.id) {
    section.hidden = true;
    return;
  }
  list.innerHTML = "";
  list.dataset.propertyId = property.id;

  let items = [];
  try {
    const r = await fetch(`/api/properties/${encodeURIComponent(property.id)}/deferred?status=open,pre_authorized`);
    const data = await r.json().catch(() => ({}));
    if (data.ok && Array.isArray(data.deferred)) items = data.deferred;
  } catch {
    section.hidden = true;
    return;
  }
  if (!items.length) {
    section.hidden = true;
    return;
  }
  if (countEl) countEl.textContent = String(items.length);
  section.hidden = false;
  for (const item of items) list.appendChild(buildCarryForwardCard(item));
}

function buildCarryForwardCard(item) {
  const card = document.createElement("article");
  card.className = "tech-cf-card";
  card.dataset.deferredId = item.id;
  card.dataset.status = item.status;
  card.dataset.flagged = item.reDeferralCount >= 3 ? "true" : "false";
  const typeLabel = ZONE_ISSUE_TYPE_OPTIONS.find((t) => t.value === item.type)?.label || item.type;
  const ageDays = item.declinedAt
    ? Math.max(0, Math.round((Date.now() - new Date(item.declinedAt).getTime()) / 86400000))
    : null;
  const pillPreauth = item.status === "pre_authorized"
    ? `<span class="tech-cf-pill tech-cf-pill--preauth">✓ Pre-authorized</span>` : "";
  const pillRepeat = item.reDeferralCount >= 3
    ? `<span class="tech-cf-pill tech-cf-pill--repeat">${item.reDeferralCount}× declined</span>` : "";
  const pillAge = ageDays != null
    ? `<span class="tech-cf-pill tech-cf-pill--age">${ageDays} day${ageDays === 1 ? "" : "s"} old</span>` : "";
  const snap = item.suggestedPriceSnapshot;
  let priceBlock = "";
  if (snap && Array.isArray(snap.lineItems) && snap.lineItems.length) {
    const lineRows = snap.lineItems.map((l) => {
      const price = l.overridePrice != null ? l.overridePrice : l.originalPrice;
      const lineTotal = (Number(price) || 0) * (Number(l.qty) || 1);
      return `<div class="tech-cf-price-line"><div class="tech-cf-price-label">${escapeHtml(l.label || l.key || "Line")} × ${escapeHtml(String(l.qty))}</div><div class="tech-cf-price-amount">${formatMoney(lineTotal)}</div></div>`;
    }).join("");
    priceBlock = `
      <div class="tech-cf-price">
        ${lineRows}
        <div class="tech-cf-price-line tech-cf-price-total"><div class="tech-cf-price-label">Total incl. HST</div><div class="tech-cf-price-amount">${formatMoney(snap.total)}</div></div>
      </div>`;
  }
  const photoStrip = (Array.isArray(item.photoIds) && item.photoIds.length && item.fromWoId)
    ? `<div class="tech-cf-photos">${item.photoIds.slice(0, 6).map((n) =>
        `<a class="tech-cf-photo" href="/api/work-orders/${encodeURIComponent(item.fromWoId)}/photo/${n}" target="_blank" rel="noopener" style="background-image:url('/api/work-orders/${encodeURIComponent(item.fromWoId)}/photo/${n}')" aria-label="Photo from prior visit"></a>`
      ).join("")}</div>` : "";
  const repairDisabled = !snap || !Array.isArray(snap.lineItems) || !snap.lineItems.length;
  card.innerHTML = `
    <div class="tech-cf-card-header">
      <span class="tech-cf-zone">Zone ${item.fromZone || "—"}</span>
      <span class="tech-cf-type">${escapeHtml(typeLabel)} × ${escapeHtml(String(item.qty || 1))}</span>
      ${pillPreauth}${pillRepeat}${pillAge}
    </div>
    ${item.notes ? `<p class="tech-cf-notes">${escapeHtml(item.notes)}</p>` : ""}
    ${photoStrip}
    ${priceBlock}
    <div class="tech-cf-actions">
      <button type="button" class="tech-cf-action tech-cf-action--primary" data-cf-action="repair_now" ${repairDisabled ? "disabled" : ""} title="${repairDisabled ? "No priced snapshot — fix via the in-zone issue flow" : ""}">Repair now</button>
      <button type="button" class="tech-cf-action" data-cf-action="already_fixed">Already fixed</button>
      <button type="button" class="tech-cf-action tech-cf-action--danger" data-cf-action="decline">Customer declined</button>
      <button type="button" class="tech-cf-action" data-cf-action="cannot_locate">Can't locate</button>
    </div>
  `;
  return card;
}

document.getElementById("techCarryForwardList")?.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-cf-action]");
  if (!btn) return;
  if (state.locked) return;
  const card = btn.closest("[data-deferred-id]");
  const list = document.getElementById("techCarryForwardList");
  if (!card || !list) return;
  const propertyId = list.dataset.propertyId;
  const deferredId = card.dataset.deferredId;
  const action = btn.dataset.cfAction;
  if (!propertyId || !deferredId || !action) return;
  card.querySelectorAll("[data-cf-action]").forEach((b) => { b.disabled = true; });
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}/carry-forward/${encodeURIComponent(deferredId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't update.");
    if (action === "repair_now" && data.workOrder?.onSiteQuote) {
      state.onSiteQuote = data.workOrder.onSiteQuote;
      renderOnSiteQuote();
    }
    // Re-fetch — items can disappear (resolved/dismissed/repair_now flips to in_progress).
    const property = await fetch(`/api/properties/${encodeURIComponent(propertyId)}`).then((r) => r.json()).catch(() => null);
    if (property?.property) await renderCarryForward(property.property);
  } catch (err) {
    alert(err.message || "Couldn't update.");
    card.querySelectorAll("[data-cf-action]").forEach((b) => { b.disabled = false; });
  }
});

// ---- Cheat Sheet --------------------------------------------------

// One-tap action chips + collapsible context blocks at the top of the
// WO. Pulls from the WO itself (customer phone for tel:/sms:, address
// for maps), the linked property (system overview + free-form notes),
// and the most-recent completed WO at the property (lastService
// summary). Each subsection hides when its underlying data is missing
// so first-time properties / WOs without a property link don't show
// hollow blocks.
function renderCheatSheet(wo, property, lastService) {
  const sheet = document.getElementById("techCheatSheet");
  if (!sheet) return;

  // Per spec §4.3.3 rule #2: "Property info is pulled FRESH at WO open."
  // The WO carries snapshots (wo.customerPhone, wo.address) for cases
  // where the property link is missing OR those fields drift, but the
  // property record is the source of truth when available. Falling back
  // to the WO snapshot keeps the sheet useful for ad-hoc WOs that don't
  // yet have a property attached.
  const phone = (property && property.customerPhone) || wo.customerPhone || "";
  const address = (property && property.address) || wo.address || "";
  const customerName = (property && property.customerName) || wo.customerName || "";
  const customerEmail = (property && property.customerEmail) || wo.customerEmail || "";

  // ---- Action chips: call / text / maps -----------------------------
  const phoneNormalized = phone.replace(/[^\d+]/g, "");
  const callLink = document.getElementById("techCallLink");
  const textLink = document.getElementById("techTextLink");
  if (phoneNormalized) {
    if (callLink) { callLink.href = "tel:" + phoneNormalized; callLink.hidden = false; }
    if (textLink) { textLink.href = "sms:" + phoneNormalized; textLink.hidden = false; }
  }
  const mapsLink = document.getElementById("techMapsLink");
  if (mapsLink && address) {
    // Universal Google Maps URL — opens in the system's default maps app
    // on iOS and Android, browser on desktop.
    mapsLink.href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(address);
    mapsLink.hidden = false;
  }
  // Reschedule chip — visible when the WO has a leadId, hasn't been
  // started, and isn't terminal. Cheap to show even before the booking
  // record has been confirmed; resolution happens inside the modal via
  // /api/bookings?leadId=<id>.
  const reschedBtn = document.getElementById("techRescheduleBtn");
  if (reschedBtn) {
    const canReschedule = !wo.arrivedAt
      && !["completed", "cancelled"].includes(wo.status)
      && !!wo.leadId;
    if (canReschedule) {
      reschedBtn.hidden = false;
      reschedBtn.onclick = () => {
        if (typeof window.openCrmReschedule !== "function") return;
        window.openCrmReschedule({
          leadId: wo.leadId,
          onDone: () => window.location.reload()
        });
      };
    } else {
      reschedBtn.hidden = true;
    }
  }
  // Customer name + email surface back into the WO summary block too —
  // before the Cheat Sheet existed, that line read "Customer details not
  // yet captured" whenever the WO snapshot was empty even though the
  // property record had the data.
  if (customerName || customerEmail) {
    const summary = [customerName, customerEmail].filter(Boolean).join(" · ");
    if (techCustomer && summary) techCustomer.textContent = summary;
  }
  if (techAddress && address) techAddress.textContent = address;

  // ---- System overview ----------------------------------------------
  const sysBlock = document.getElementById("techSystemBlock");
  const sys = property && property.system ? property.system : null;
  let sysHasContent = false;
  if (sys) {
    const zoneCount = Array.isArray(sys.zones) ? sys.zones.length : 0;
    const controllerParts = [];
    if (sys.controllerBrand) controllerParts.push(sys.controllerBrand);
    if (sys.controllerLocation) controllerParts.push(sys.controllerLocation);
    const controllerLabel = controllerParts.join(" · ");
    setCheat("techSysZones", zoneCount ? `${zoneCount}` : "—");
    setCheat("techSysController", controllerLabel || "—");
    setCheat("techSysShutoff", sys.shutoffLocation || "—");
    setCheat("techSysBlowout", sys.blowoutLocation || "—");

    // Valve boxes — surface a one-line count + locations so the tech
    // knows how many to lift before they start digging.
    const valveBoxes = Array.isArray(sys.valveBoxes) ? sys.valveBoxes : [];
    const vbEl = document.getElementById("techSysValveBoxes");
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

    sysHasContent = zoneCount > 0 || controllerLabel || sys.shutoffLocation || sys.blowoutLocation || valveBoxes.length > 0;
  }
  if (sysBlock) sysBlock.hidden = !sysHasContent;

  // ---- Property notes (access / gate / dog / parking) ---------------
  const accessBlock = document.getElementById("techAccessBlock");
  const accessText = sys && sys.notes ? String(sys.notes).trim() : "";
  if (accessBlock) {
    if (accessText) {
      const notesEl = document.getElementById("techAccessNotes");
      if (notesEl) notesEl.textContent = accessText;
      accessBlock.hidden = false;
    } else {
      accessBlock.hidden = true;
    }
  }

  // ---- Last service summary (existing properties only) --------------
  const lastBlock = document.getElementById("techLastServiceBlock");
  if (lastBlock) {
    if (lastService && lastService.completedAt) {
      const typeLabel = TYPE_LABELS[lastService.type] || lastService.type || "Visit";
      const dateLabel = formatDateOnly(lastService.completedAt);
      const noteSnippet = lastService.techNotes ? ` — ${lastService.techNotes}` : "";
      const text = `${typeLabel} · ${dateLabel}${noteSnippet}`;
      const lastEl = document.getElementById("techLastServiceText");
      if (lastEl) lastEl.textContent = text;
      lastBlock.hidden = false;
    } else {
      lastBlock.hidden = true;
    }
  }

  // The whole sheet hides only if NOTHING is populated — a WO with even
  // just an address still gets the maps chip, which is useful on its own.
  const anyVisible = (callLink && !callLink.hidden) ||
                     (textLink && !textLink.hidden) ||
                     (mapsLink && !mapsLink.hidden) ||
                     (sysBlock && !sysBlock.hidden) ||
                     (accessBlock && !accessBlock.hidden) ||
                     (lastBlock && !lastBlock.hidden);
  sheet.hidden = !anyVisible;
}

function setCheat(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function formatDateOnly(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

// ---- Bootstrap ---------------------------------------------------

async function init() {
  const id = getWorkOrderId();
  if (!id) {
    techLoading.hidden = true;
    techError.hidden = false;
    return;
  }
  state.id = id;
  try {
    const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error("Not found");

    const wo = data.workOrder;
    state.type = wo.type || "service_visit";
    state.status = wo.status || "scheduled";
    // Track the WO's version (updatedAt) so subsequent PATCHes can
    // send it as If-Match. Server returns 409 on stale version.
    state.updatedAt = wo.updatedAt || null;
    state.techNotes = wo.techNotes || "";
    state.zones = Array.isArray(wo.zones) ? wo.zones.map((z) => ({ ...z })) : [];
    state.serviceChecklist = (wo.serviceChecklist && typeof wo.serviceChecklist === "object") ? { ...wo.serviceChecklist } : {};
    state.signature = wo.signature || state.signature;
    state.photos = Array.isArray(wo.photos) ? wo.photos : [];
    state.locked = wo.locked === true;
    state.intakeGuarantee = (wo.intakeGuarantee && typeof wo.intakeGuarantee === "object")
      ? wo.intakeGuarantee
      : state.intakeGuarantee;
    state.onSiteQuote = (wo.onSiteQuote && typeof wo.onSiteQuote === "object")
      ? { ...wo.onSiteQuote, builderLineItems: Array.isArray(wo.onSiteQuote.builderLineItems) ? wo.onSiteQuote.builderLineItems.slice() : [] }
      : state.onSiteQuote;
    state.customerName  = wo.customerName  || "";
    state.customerEmail = wo.customerEmail || "";
    state.customerPhone = wo.customerPhone || "";
    // Address comes from the WO (snapshot at create time) or the
    // linked property if the WO snapshot is empty. Both feed the
    // follow-up modal's availability lookup.
    state.address = wo.address || "";
    // materialsPacked migrated from { sku: bool } to { sku: qty (number) }
    // in May 2026 (Patrick: tech needs +/- counts, not just ticks).
    // Coerce legacy `true` values to qty=1, drop `false`/null. New WOs
    // arrive as numbers already.
    state.materialsPacked = (() => {
      const out = {};
      const raw = wo.materialsPacked;
      if (!raw || typeof raw !== "object") return out;
      for (const [sku, val] of Object.entries(raw)) {
        if (val === true) { out[sku] = 1; continue; }
        if (val === false || val == null) continue;
        const n = Math.max(0, Math.floor(Number(val) || 0));
        if (n > 0) out[sku] = n;
      }
      return out;
    })();
    // Custom parts not in the parts.json catalog. Each item:
    //   { id, name, size, qty } — id is a client-side uuid for dedup.
    state.customParts = Array.isArray(wo.customParts)
      ? wo.customParts.filter((p) => p && typeof p === "object").map((p) => ({
          id: p.id || `cp_${Math.random().toString(36).slice(2, 10)}`,
          name: typeof p.name === "string" ? p.name : "",
          size: typeof p.size === "string" ? p.size : "",
          qty: Math.max(0, Math.floor(Number(p.qty) || 0))
        }))
      : [];
    // Back-fill timestamps from status when missing (covers WOs where
    // the status was advanced server-side or by another session — the
    // tech opens the WO and expects to see when arrival happened, not
    // a "—" placeholder). On-site rank: scheduled < dispatched <
    // en_route < on_site < in_progress < awaiting_approval < completed.
    state.arrivedAt = wo.arrivedAt || null;
    state.departedAt = wo.departedAt || null;
    const STATUS_ON_OR_AFTER_ARRIVAL = ["on_site", "in_progress", "awaiting_approval", "completed"];
    if (!state.arrivedAt && STATUS_ON_OR_AFTER_ARRIVAL.includes(state.status)) {
      state.arrivedAt = wo.updatedAt || wo.createdAt || null;
    }
    if (!state.departedAt && state.status === "completed") {
      state.departedAt = wo.updatedAt || null;
    }
    state.followupOfWoId = wo.followupOfWoId || null;
    state.followupWoIds = Array.isArray(wo.followupWoIds) ? wo.followupWoIds : [];
    // Coerce paidOnSite to one of true / false / null. Defends against
    // legacy records or accidental string values.
    state.paidOnSite = wo.paidOnSite === true ? true
      : wo.paidOnSite === false ? false
      : null;
    // Same tri-state coercion for needsReturnVisit (v27).
    state.needsReturnVisit = wo.needsReturnVisit === true ? true
      : wo.needsReturnVisit === false ? false
      : null;
    // Cascade-merge follow-up — brief-literal §4.6 materials gate
    // state. Server-side hydrate auto-fills for fall_closing + empty-
    // materials WOs so the gate doesn't block there.
    state.materialsConfirmedAt = wo.materialsConfirmedAt || null;

    techId.textContent = wo.id;
    techType.textContent = TYPE_LABELS[wo.type] || wo.type;
    const customer = [wo.customerName, wo.customerEmail].filter(Boolean).join(" · ");
    techCustomer.textContent = customer || "Customer details not yet captured";
    techAddress.textContent = wo.address || "—";
    techMeta.textContent = `Updated ${formatDateTime(wo.updatedAt)}`;
    techNotes.value = state.techNotes;

    // Property code (P-YYYY-NNNN) — identification badge in the
    // summary section. Hidden when the WO has no linked property
    // (rare — first-time visits before a property gets created).
    const techCodeEl = document.getElementById("techPropertyCode");
    if (techCodeEl) {
      if (data.property && data.property.code) {
        techCodeEl.textContent = data.property.code;
        techCodeEl.hidden = false;
      } else {
        techCodeEl.hidden = true;
      }
    }

    // Stash the property record so the zone source-picker can offer the
    // customer's real zones / valves / controller / issues as label sources,
    // then build the picker source list for instant access on tap.
    state.linkedProperty = data.property || null;
    buildZonePickerSources();

    // Cheat Sheet — first thing the tech reviews on arrival. Pulls from
    // the property record + the most-recent completed WO at the property.
    renderCheatSheet(wo, data.property, data.lastService);

    // Carry-forward banner — spec §5. Spring openings auto-load the
    // property's open + pre-authorized deferred items so the tech walks in
    // knowing what to fix from prior visits. Awaits a fetch but doesn't
    // block the rest of the render — the section reveals when ready.
    renderCarryForward(data.property).catch((err) => console.warn("[carry-forward]", err?.message));

    // On-Site Execution timestamps + Materials checklist + Payment block
    // (spec §4.3.2). Materials needs parts.json — fetched once and cached
    // on state. All three are deterministic from current WO data so they
    // re-render anytime onSiteQuote changes (see renderOnSiteQuote).
    renderExecutionTimestamps();
    loadPartsCatalog().then(() => {
      renderMaterials();
      renderBringback();
    }).catch(() => {
      renderMaterials();
      renderBringback();
    });
    renderPaymentBlock();

    // Service-specific checklist (spring opening / fall closing) and
    // customer sign-off section. Lock state cascades after both are
    // rendered so disabled inputs apply uniformly.
    renderServiceChecklist();
    renderWoPhotos();
    renderOnSiteQuote();
    renderSignoff();
    applyLockState(state.locked);

    if (wo.diagnosis) {
      techDiagnosisText.textContent = typeof wo.diagnosis === "string"
        ? wo.diagnosis
        : JSON.stringify(wo.diagnosis, null, 2);
      techDiagnosis.hidden = false;
    }

    // AI-Correct-Diagnosis Bonus banner — populated from the WO's snapshotted
    // copy of the source Quote's bonus eligibility flag. Visible only when the
    // AI quoted a specific repair scope and the customer accepted; serves as
    // the tech's reminder that the customer's first hour of repair labour is
    // PENDING (temporarily disabled) until the tech confirms the on-site
    // diagnosis matches the AI's quoted scope. Match → credit 1 hr free.
    // Mismatch → bill labour normally at $95/hr, no free hour.
    state.intakeGuarantee = wo.intakeGuarantee || state.intakeGuarantee;
    renderIntakeGuarantee();

    // Back link prefers the lead detail (deep-link) over the desktop
    // editor — the tech is unlikely to want the desktop layout.
    if (data.lead && data.lead.id) {
      techBack.href = `/admin#lead-${encodeURIComponent(data.lead.id)}`;
    } else if (data.property && data.property.id) {
      techBack.href = `/admin/property/${encodeURIComponent(data.property.id)}`;
    } else {
      techBack.href = "/admin";
    }

    renderRunStatus();
    renderZones();

    // Return-visit gate visibility (v27). Apply on initial load so the
    // bringback + followup sections show up correctly for WOs that
    // already have a needsReturnVisit answer persisted.
    if (typeof applyReturnVisitVisibility === "function") applyReturnVisitVisibility();

    // Property updates preview (Brief D / spec §10 r3 + §4.3.2) — the
    // server's GET decorator computes what would flow back to the
    // property record when the cascade fires. Hidden when the WO has
    // no diffs (or has already been applied via propertyEditsAppliedAt).
    renderPropertyUpdates(data.propertyEdits);

    // Post-signature banner (Brief E) — narrates the gap between
    // "customer signed" and "visit completed" so the tech isn't stranded
    // with locked line items and no obvious next step. Re-renders on
    // signature capture / photo upload / status change.
    state.completedInvoiceId = null;
    renderPostSigBanner();

    // History viewer — append-only audit trail. Hydrated from the WO
    // record on load; doesn't update mid-session (refresh to see
    // freshly-appended entries). Spec §10 r4.
    state.history = Array.isArray(wo.history) ? wo.history.slice() : [];
    renderTechHistory();

    techLoading.hidden = true;
    techMain.hidden = false;
  } catch {
    techLoading.hidden = true;
    techError.hidden = false;
  }
}

// ---- History viewer (spec §10 r4) -----------------------------------
// Tech-mode mirror of the desktop History panel. Same data, terser layout
// (no diff column — fits the narrow viewport). Read-only. Newest-first.
const TECH_HISTORY_ACTOR_LABELS = {
  admin: "Admin",
  tech: "Tech",
  system: "System",
  customer: "Customer"
};
const TECH_HISTORY_ACTION_LABELS = {
  created: "Created",
  status_change: "Status",
  signature_capture: "Signature",
  patch: "Edited",
  photo_upload: "Photo +",
  photo_delete: "Photo −",
  quote_built: "Quote built",
  customer_accepted: "Accepted",
  customer_declined_all: "Declined all",
  remote_approval_sent: "Approval sent",
  issue_deferred: "Issue deferred",
  issues_bulk_deferred: "Bulk deferred",
  emergency_override: "Emergency",
  carry_forward_repair_now: "CF → repair",
  carry_forward_declined: "CF → declined",
  carry_forward_already_fixed: "CF → fixed",
  carry_forward_cannot_locate: "CF → no locate",
  cascade_fire: "Cascade",
  cascade_failed: "Cascade failed",
  invoice_drafted: "Invoice draft",
  followup_created: "Follow-up",
  created_as_followup: "From parent",
  created_as_emergency_followup: "Emergency follow-up"
};

function renderTechHistory() {
  const list = document.getElementById("techHistoryList");
  const count = document.getElementById("techHistoryCount");
  const empty = document.getElementById("techHistoryEmpty");
  if (!list) return;
  const history = Array.isArray(state.history) ? state.history.slice() : [];
  if (count) count.textContent = String(history.length);
  if (!history.length) {
    list.innerHTML = "";
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  history.sort((a, b) => (new Date(b.ts || 0)) - (new Date(a.ts || 0)));
  list.innerHTML = history.map((entry) => {
    const ts = entry.ts ? formatDateTime(entry.ts) : "—";
    const actorRaw = entry.by || "system";
    const actor = TECH_HISTORY_ACTOR_LABELS[actorRaw] || actorRaw;
    const actionLabel = TECH_HISTORY_ACTION_LABELS[entry.action] || (entry.action || "Updated").replace(/_/g, " ");
    const note = entry.note ? escapeHtml(entry.note) : "";
    const diff = (entry.before !== undefined || entry.after !== undefined)
      ? `<span class="tech-history-diff">${escapeHtml(String(entry.before ?? "—"))} → ${escapeHtml(String(entry.after ?? "—"))}</span>`
      : "";
    return `
      <li class="tech-history-row">
        <div class="tech-history-row-head">
          <span class="tech-history-action">${escapeHtml(actionLabel)}</span>
          <span class="tech-history-actor">${escapeHtml(actor)}</span>
          <span class="tech-history-ts">${escapeHtml(ts)}</span>
        </div>
        ${note ? `<p class="tech-history-note">${note}</p>` : ""}
        ${diff}
      </li>
    `;
  }).join("");
}

// ---- Materials checklist (spec §4.3.2) ---------------------------------
// Auto-derives from the current authorized line items in the on-site
// quote builder. Looks up each line's pricing.json key against
// parts.json's service_materials map → expands into per-SKU rows the
// tech can tap "packed" on. Refreshed every time renderOnSiteQuote runs.

async function loadPartsCatalog() {
  if (state.partsCatalog) return;
  // Routes through the shared CrmParts.loadCatalog so the follow-up
  // modal + this page share the same in-page promise. First caller
  // fires the network round-trip; subsequent callers reuse the
  // resolved catalog. Browser cache (max-age=300) + SW cache cover
  // longer horizons.
  try {
    const data = window.CrmParts && window.CrmParts.loadCatalog
      ? await window.CrmParts.loadCatalog()
      : null;
    if (data && data.parts) {
      state.partsCatalog = data.parts;
      state.partsCategories = Array.isArray(data.categories) ? data.categories : [];
      state.serviceMaterials = data.service_materials || {};
    }
  } catch (err) {
    console.warn("[materials] parts.json load failed:", err?.message);
  }
}

// Inline "Parts to bring back" section. Renders the shared CrmParts
// tree with quantity steppers (qty starts at 0; tap +/- to adjust).
// Persists qty map to wo.materialsPacked through the standard PATCH
// path (debounced so rapid taps don't spam the server). Also renders
// the "Custom parts (not in catalog)" block below the tree, which
// persists to wo.customParts. Tracks the "saved/saving/idle" state in
// the status line at the top.
let bringbackSaveTimer = null;
// Pending materialsPacked/customParts payload — kept around so a
// page reload mid-debounce can still flush via beforeunload, and so
// offline-mode replays through PJLOffline.queuedFetch when available.
let bringbackPendingPayload = null;
function setBringbackSavingState(state) {
  const section = document.getElementById("techBringbackSection");
  if (!section) return;
  const savedEl = section.querySelector("[data-saved]");
  if (!savedEl) return;
  savedEl.classList.remove("is-saved", "is-saving");
  if (state === "saving") {
    savedEl.textContent = "saving…";
    savedEl.classList.add("is-saving");
  } else if (state === "saved") {
    savedEl.textContent = "saved";
    savedEl.classList.add("is-saved");
  } else if (state === "error") {
    savedEl.textContent = "save failed — will retry";
  } else if (state === "loaded") {
    savedEl.textContent = "loaded";
  } else {
    savedEl.textContent = "idle";
  }
}
function updateBringbackCounts() {
  const section = document.getElementById("techBringbackSection");
  if (!section) return;
  const catalogPicked = Object.values(state.materialsPacked || {}).filter((v) => Number(v) > 0).length;
  const customPicked = (state.customParts || []).filter((p) => Number(p.qty) > 0).length;
  const countEl = section.querySelector("[data-count]");
  const customCountEl = section.querySelector("[data-custom-count]");
  if (countEl) countEl.textContent = String(catalogPicked + customPicked);
  if (customCountEl) customCountEl.textContent = String(customPicked);
}
// Cascade-merge follow-up — brief-literal §4.6 materials gate UI.
// Paints the "Confirm materials list" button or the ✓ Confirmed-at
// status. Hidden on locked WOs (gate is moot post-signature).
function renderMaterialsConfirm() {
  const wrap = document.getElementById("techMaterialsConfirmWrap");
  const btn = document.getElementById("techMaterialsConfirmBtn");
  const status = document.getElementById("techMaterialsConfirmStatus");
  if (!wrap || !btn || !status) return;
  if (state.locked) { wrap.hidden = true; return; }
  wrap.hidden = false;
  if (state.materialsConfirmedAt) {
    btn.disabled = false;
    btn.textContent = "Re-confirm materials list";
    status.textContent = `✓ Confirmed ${formatDateTime(state.materialsConfirmedAt)}`;
    status.style.color = "#0c8a3e";
  } else {
    btn.disabled = false;
    btn.textContent = "Confirm materials list is accurate";
    status.textContent = "Required before signing.";
    status.style.color = "#6b4e00";
  }
}

document.getElementById("techMaterialsConfirmBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("techMaterialsConfirmBtn");
  if (!btn || !state.id) return;
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const now = new Date().toISOString();
    await patchWorkOrder({ materialsConfirmedAt: now });
    state.materialsConfirmedAt = now;
    renderMaterialsConfirm();
    if (typeof updateSignoffSubmitState === "function") updateSignoffSubmitState();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Confirm materials list is accurate";
    alert(err.message || "Couldn't confirm — try again.");
  }
});

function scheduleBringbackSave(payload) {
  setBringbackSavingState("saving");
  // Always track the latest payload so beforeunload can flush even if
  // the debounce timer hasn't fired yet (fixes the "rapid taps lost on
  // page reload" bug — HANDOFF.md "Materials checklist persistence").
  bringbackPendingPayload = payload;
  clearTimeout(bringbackSaveTimer);
  // Cascade-merge follow-up — materials mutation invalidates the
  // confirmation stamp. Server clears it server-side; reflect locally
  // so the gate fails in real time and the Confirm button re-arms.
  if (state.materialsConfirmedAt) {
    state.materialsConfirmedAt = null;
    if (typeof renderMaterialsConfirm === "function") renderMaterialsConfirm();
    if (typeof updateSignoffSubmitState === "function") updateSignoffSubmitState();
  }
  bringbackSaveTimer = setTimeout(() => { flushBringbackSave(); }, 500);
}

async function flushBringbackSave({ keepalive = false } = {}) {
  if (!bringbackPendingPayload) return;
  const payload = bringbackPendingPayload;
  bringbackPendingPayload = null;
  clearTimeout(bringbackSaveTimer);
  bringbackSaveTimer = null;
  // Use the offline-aware queuedFetch when available so taps the tech
  // makes in a no-signal field still hit the server when they come
  // back online. The fetch wrapper for PATCH work-orders already
  // exists (see wrapPatchWorkOrder below), but scheduleBringbackSave
  // bypassed it — go through PJLOffline directly here.
  const url = `/api/work-orders/${encodeURIComponent(state.id)}`;
  const init = {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    // `keepalive: true` lets fetch complete even if the page is
    // unloading. Critical for the beforeunload flush path.
    keepalive
  };
  try {
    const fetchFn = (window.PJLOffline && window.PJLOffline.queuedFetch) || fetch;
    const r = await fetchFn(url, init);
    if (!r.ok && !r.queued) throw new Error("save failed");
    setBringbackSavingState("saved");
  } catch (err) {
    setBringbackSavingState("error");
  }
}

// Flush any pending bringback save on page unload. Without this, a
// tech who taps a quantity then immediately closes the tab loses the
// last 500ms of changes.
window.addEventListener("beforeunload", () => {
  if (bringbackPendingPayload) flushBringbackSave({ keepalive: true });
});
// Same flush on visibilitychange → hidden, since mobile browsers
// don't always fire beforeunload reliably when the app is backgrounded.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && bringbackPendingPayload) {
    flushBringbackSave({ keepalive: true });
  }
});
function renderBringback() {
  const tree = document.getElementById("techBringbackTree");
  const section = document.getElementById("techBringbackSection");
  // Cascade-merge follow-up — always paint the Confirm materials row,
  // even when the parts catalog hasn't loaded (gate state is independent).
  renderMaterialsConfirm();
  if (!tree || !section || !window.CrmParts) return;
  if (!state.partsCatalog || !Object.keys(state.partsCatalog).length) {
    tree.innerHTML = `<p class="tech-bringback-loading">Parts catalog unavailable.</p>`;
    renderCustomParts();
    updateBringbackCounts();
    return;
  }
  window.CrmParts.render(tree, {
    categories: state.partsCategories || [],
    parts: state.partsCatalog
  }, {
    preQty: state.materialsPacked || {},
    idPrefix: "bringback_",
    onChange: (qtyMap) => {
      state.materialsPacked = qtyMap;
      updateBringbackCounts();
      scheduleBringbackSave({ materialsPacked: qtyMap });
    }
  });
  renderCustomParts();
  updateBringbackCounts();
  const totalPicked = Object.values(state.materialsPacked || {}).filter((v) => Number(v) > 0).length
    + (state.customParts || []).filter((p) => Number(p.qty) > 0).length;
  setBringbackSavingState(totalPicked ? "loaded" : "idle");
}

// "Custom parts (not in catalog)" — renders the list of free-form
// rows under the catalog tree. Each row mirrors the catalog row layout
// (qty stepper on the left, then size + description, then a remove
// button on the right). Persists to wo.customParts via the same
// debounced PATCH path the catalog tree uses.
function renderCustomParts() {
  const list = document.getElementById("techCustomPartsList");
  if (!list) return;
  list.innerHTML = "";
  (state.customParts || []).forEach((part) => {
    const row = document.createElement("div");
    row.className = "crm-parts-row crm-parts-row--custom" + (Number(part.qty) > 0 ? " is-picked" : "");
    row.dataset.customId = part.id;
    row.innerHTML = `
      <span class="crm-parts-stepper" data-stepper>
        <button type="button" class="crm-parts-stepper-btn" data-custom-step="-1" aria-label="Decrease quantity">−</button>
        <input type="number" class="crm-parts-qty" data-custom-qty value="${Number(part.qty) || 0}" min="0" step="1" inputmode="numeric" aria-label="Quantity">
        <button type="button" class="crm-parts-stepper-btn" data-custom-step="1" aria-label="Increase quantity">+</button>
      </span>
      <input type="text" class="crm-parts-custom-size-input" data-custom-size value="${escapeHtmlAttr(part.size)}" placeholder="size" maxlength="16" aria-label="Size">
      <input type="text" class="crm-parts-custom-desc-input" data-custom-name value="${escapeHtmlAttr(part.name)}" placeholder="Description / supplier note" maxlength="120" aria-label="Description">
      <button type="button" class="crm-parts-custom-remove" data-custom-remove aria-label="Remove custom part">×</button>
    `;
    list.appendChild(row);
  });
}

// Lightweight HTML-attribute escaper — used for default values inside
// the inputs we inject in renderCustomParts. Slightly different from
// the JSX-style escapeHtml above (we only need to defend against
// breaking out of an attribute).
function escapeHtmlAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Custom-parts event delegation — handles the +/- stepper, the remove
// button, and the size/name text inputs. All paths funnel into
// scheduleBringbackSave with the full state.customParts payload.
(function wireCustomPartsEvents() {
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!target || !(target instanceof Element)) return;

    // + Add button
    if (target.closest("#techCustomPartsAdd")) {
      const next = (state.customParts || []).slice();
      next.push({
        id: `cp_${Math.random().toString(36).slice(2, 10)}`,
        name: "",
        size: "",
        qty: 1
      });
      state.customParts = next;
      renderCustomParts();
      updateBringbackCounts();
      scheduleBringbackSave({ customParts: state.customParts });
      // Focus the newly-added description input so the tech can type
      // immediately without a second tap.
      const list = document.getElementById("techCustomPartsList");
      const lastRow = list && list.lastElementChild;
      const lastInput = lastRow && lastRow.querySelector("[data-custom-name]");
      if (lastInput) lastInput.focus();
      return;
    }

    // − / + on a custom row
    const stepBtn = target.closest("[data-custom-step]");
    if (stepBtn) {
      const row = stepBtn.closest("[data-custom-id]");
      const id = row && row.dataset.customId;
      if (!id) return;
      const part = (state.customParts || []).find((p) => p.id === id);
      if (!part) return;
      const step = Number(stepBtn.dataset.customStep) || 0;
      part.qty = Math.max(0, (Number(part.qty) || 0) + step);
      const input = row.querySelector("[data-custom-qty]");
      if (input) input.value = String(part.qty);
      row.classList.toggle("is-picked", part.qty > 0);
      updateBringbackCounts();
      scheduleBringbackSave({ customParts: state.customParts });
      return;
    }

    // Remove
    const removeBtn = target.closest("[data-custom-remove]");
    if (removeBtn) {
      const row = removeBtn.closest("[data-custom-id]");
      const id = row && row.dataset.customId;
      if (!id) return;
      state.customParts = (state.customParts || []).filter((p) => p.id !== id);
      renderCustomParts();
      updateBringbackCounts();
      scheduleBringbackSave({ customParts: state.customParts });
      return;
    }
  });

  // input events — qty number, size, and name. We update state, then
  // debounce-save on every keystroke (the existing 500ms timer
  // collapses bursts).
  document.addEventListener("input", (e) => {
    const target = e.target;
    if (!target || !(target instanceof Element)) return;
    const row = target.closest && target.closest("[data-custom-id]");
    if (!row) return;
    const id = row.dataset.customId;
    const part = (state.customParts || []).find((p) => p.id === id);
    if (!part) return;
    if (target.matches("[data-custom-qty]")) {
      part.qty = Math.max(0, Math.floor(Number(target.value) || 0));
      row.classList.toggle("is-picked", part.qty > 0);
      updateBringbackCounts();
    } else if (target.matches("[data-custom-size]")) {
      part.size = String(target.value || "").slice(0, 16);
    } else if (target.matches("[data-custom-name]")) {
      part.name = String(target.value || "").slice(0, 120);
    } else {
      return;
    }
    scheduleBringbackSave({ customParts: state.customParts });
  });
})();

function renderMaterials() {
  const section = document.getElementById("techMaterialsSection");
  const list = document.getElementById("techMaterialsList");
  const empty = document.getElementById("techMaterialsEmpty");
  if (!section || !list) return;
  // Materials list shows ONLY on follow-up WOs (per Patrick: regular
  // visits don't need it because the tech is already on-site; the list
  // is for prepping the next truckload). A WO is a follow-up when it
  // carries a followupOfWoId pointer to its parent.
  if (!state.followupOfWoId) {
    section.hidden = true;
    return;
  }
  if (!state.partsCatalog || !state.serviceMaterials) {
    section.hidden = true;
    return;
  }
  const builderLines = (state.onSiteQuote && state.onSiteQuote.builderLineItems) || [];
  if (!builderLines.length) {
    section.hidden = true;
    return;
  }

  // Aggregate parts across all line items: { sku → { qty, name, packed } }
  const aggregate = new Map();
  for (const line of builderLines) {
    const mapping = line.key && state.serviceMaterials[line.key];
    const lineQty = Number(line.qty) || 1;
    const defaultParts = (mapping && Array.isArray(mapping.default_parts)) ? mapping.default_parts : [];
    for (const part of defaultParts) {
      const sku = part.sku;
      if (!sku || !state.partsCatalog[sku]) continue;
      const totalQty = (Number(part.quantity) || 0) * lineQty;
      const existing = aggregate.get(sku);
      if (existing) {
        existing.qty += totalQty;
      } else {
        // wo.materialsPacked is { sku: qty } (number). qty>0 means
        // packed. Falls back to false if absent or coerced to 0.
        const packedQty = Math.max(0, Math.floor(Number(state.materialsPacked && state.materialsPacked[sku]) || 0));
        aggregate.set(sku, {
          sku,
          qty: totalQty,
          name: state.partsCatalog[sku].description || state.partsCatalog[sku].name || sku,
          unit: state.partsCatalog[sku].unit || "each",
          packed: packedQty > 0
        });
      }
    }
  }

  if (!aggregate.size) {
    section.hidden = false;
    list.innerHTML = "";
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  section.hidden = false;
  list.innerHTML = "";
  for (const row of aggregate.values()) {
    const li = document.createElement("li");
    li.className = "tech-materials-row" + (row.packed ? " is-packed" : "");
    const qtyDisplay = row.qty < 1 ? row.qty.toFixed(2) : (Number.isInteger(row.qty) ? String(row.qty) : row.qty.toFixed(1));
    li.innerHTML = `
      <input type="checkbox" data-sku="${escapeHtml(row.sku)}" data-expected-qty="${escapeHtml(String(Math.max(1, Math.ceil(row.qty))))}" ${row.packed ? "checked" : ""} aria-label="Mark ${escapeHtml(row.name)} packed">
      <span class="tech-materials-name">${escapeHtml(row.name)}</span>
      <span class="tech-materials-qty">${escapeHtml(qtyDisplay)} ${escapeHtml(row.unit)}</span>
    `;
    list.appendChild(li);
  }
}

// Materials checklist (follow-up WOs only) — tech ticks each line as
// they load it on the truck. `is-packed` is a UI-only flag; the actual
// quantity-on-truck state lives in wo.materialsPacked (maintained by
// the bringback section above). Toggling here flips the row's qty
// between 0 (unpacked) and the line's expected qty (packed). Persists
// through the same debounced PATCH path bringback uses.
document.getElementById("techMaterialsList")?.addEventListener("change", (event) => {
  const cb = event.target;
  if (cb.tagName !== "INPUT" || cb.type !== "checkbox") return;
  const sku = cb.dataset.sku;
  if (!sku) return;
  const expectedQty = Math.max(1, Math.floor(Number(cb.dataset.expectedQty) || 1));
  state.materialsPacked = state.materialsPacked || {};
  state.materialsPacked[sku] = cb.checked ? expectedQty : 0;
  cb.closest("li")?.classList.toggle("is-packed", cb.checked);
  patchWorkOrder({ materialsPacked: state.materialsPacked });
  // Materials gate (Brief: WO Field-Readiness §6.2) is promoted to
  // pre-sign — refresh the checklist when a row flips packed/unpacked.
  updateSignoffSubmitState();
});

// ---- AI Correct Diagnosis Bonus banner (Brief F / spec §4.3.3 r6) -----
// Three states keyed off intakeGuarantee.matched:
//   pending   — DECISION REQUIRED. Match + Mismatch buttons visible.
//                Signature canvas is gated until the tech decides.
//   matched   — Bonus credit applied to the on-site quote builder.
//                "1 HOUR LABOUR CREDITED" eyebrow, no buttons.
//   mismatch  — No credit applied. "DIAGNOSIS DIDN'T MATCH" eyebrow.
// Locked at signature (intakeGuarantee is in SCOPE_PROTECTED_FIELDS).
function renderIntakeGuarantee() {
  const banner = document.getElementById("techIntakeGuarantee");
  const eyebrow = document.getElementById("techIntakeEyebrow");
  const scope = document.getElementById("techIntakeScope");
  const source = document.getElementById("techIntakeSource");
  const actions = document.getElementById("techIntakeActions");
  const decided = document.getElementById("techIntakeDecided");
  if (!banner) return;
  const ig = state.intakeGuarantee || {};
  if (!ig.applies) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  if (scope) scope.textContent = ig.scope || "Locked scope";
  if (source) {
    source.textContent = ig.sourceQuoteId ? `Source: ${ig.sourceQuoteId}` : "";
  }
  const isLocked = state.locked === true || state.signature?.signed === true;
  // Hide buttons whenever the WO is locked (decision is final post-sign)
  // OR a decision has already been made.
  if (ig.matched === true) {
    banner.dataset.decision = "matched";
    if (eyebrow) eyebrow.textContent = "AI-CORRECT-DIAGNOSIS BONUS — 1 HOUR LABOUR CREDITED";
    if (actions) actions.hidden = true;
    if (decided) {
      decided.hidden = false;
      decided.textContent = "Diagnosis matched. Credit line added to the on-site quote.";
    }
  } else if (ig.matched === false) {
    banner.dataset.decision = "mismatch";
    if (eyebrow) eyebrow.textContent = "AI-CORRECT-DIAGNOSIS BONUS — DIAGNOSIS DIDN'T MATCH";
    if (actions) actions.hidden = true;
    if (decided) {
      decided.hidden = false;
      decided.textContent = ig.mismatchReason
        ? `No credit applied: ${ig.mismatchReason}`
        : "No credit applied. Labour bills at the listed rate.";
    }
  } else {
    banner.dataset.decision = "pending";
    if (eyebrow) eyebrow.textContent = "AI-CORRECT-DIAGNOSIS BONUS — DECISION REQUIRED";
    if (actions) actions.hidden = isLocked;
    if (decided) decided.hidden = true;
  }
}

document.getElementById("techIntakeMatchBtn")?.addEventListener("click", async () => {
  if (state.locked) return;
  if (!confirm("Confirm: the on-site diagnosis matches the AI-quoted scope. This credits 1 hour of repair labour to the customer.")) return;
  await postIntakeDecision({ matched: true });
});
document.getElementById("techIntakeMismatchBtn")?.addEventListener("click", async () => {
  if (state.locked) return;
  const reason = prompt("Optional: brief note on why the diagnosis didn't match (e.g. 'AI quoted leak; actual issue was valve'). Leave blank if none.", "");
  if (reason === null) return; // user cancelled
  await postIntakeDecision({ matched: false, mismatchReason: reason || "" });
});

async function postIntakeDecision(body) {
  const matchBtn = document.getElementById("techIntakeMatchBtn");
  const mismBtn = document.getElementById("techIntakeMismatchBtn");
  if (matchBtn) matchBtn.disabled = true;
  if (mismBtn) mismBtn.disabled = true;
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}/intake-guarantee/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't record decision.");
    if (data.workOrder) {
      state.intakeGuarantee = data.workOrder.intakeGuarantee || state.intakeGuarantee;
      state.onSiteQuote = data.workOrder.onSiteQuote || state.onSiteQuote;
    }
    renderIntakeGuarantee();
    renderOnSiteQuote();
    // Signature canvas was gated on this decision — refresh its state.
    if (typeof updateSignoffSubmitState === "function") updateSignoffSubmitState();
  } catch (err) {
    alert(err.message || "Couldn't record decision.");
  } finally {
    if (matchBtn) matchBtn.disabled = false;
    if (mismBtn) mismBtn.disabled = false;
  }
}

// ---- Property updates preview (Brief D / spec §10 r3 + §4.3.2) ---------
// Renders the previously-empty techPropertyUpdatesSection. Lists what
// will flow back to the property record on completion: per-zone field
// diffs and any newly-discovered zones. Read-only preview; the cascade
// applies it when the tech marks complete.
const PROPERTY_FIELD_LABELS = {
  location: "Description",
  notes: "Notes",
  sprinklerTypes: "Sprinkler types",
  coverage: "Coverage"
};
function renderPropertyUpdates(propertyEdits) {
  const section = document.getElementById("techPropertyUpdatesSection");
  const list = document.getElementById("techPropertyUpdatesList");
  if (!section || !list) return;
  const edits = propertyEdits && typeof propertyEdits === "object" ? propertyEdits : null;
  if (!edits || !edits.hasChanges) {
    section.hidden = true;
    list.innerHTML = "";
    return;
  }
  section.hidden = false;
  list.innerHTML = "";
  const fmtVal = (v) => {
    if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
    if (typeof v === "string") return v.trim() || "—";
    return String(v ?? "—");
  };
  for (const ze of edits.zoneEdits || []) {
    const li = document.createElement("li");
    li.className = "tech-property-updates-row";
    const fieldsHtml = (ze.fields || []).map((f) =>
      `<div class="tech-property-updates-field">
         <span class="tech-property-updates-field-label">${escapeHtml(PROPERTY_FIELD_LABELS[f.field] || f.field)}</span>
         <span class="tech-property-updates-diff"><span class="tech-property-updates-before">${escapeHtml(fmtVal(f.before))}</span><span aria-hidden="true">→</span><span class="tech-property-updates-after">${escapeHtml(fmtVal(f.after))}</span></span>
       </div>`
    ).join("");
    li.innerHTML = `
      <div class="tech-property-updates-zone">Zone ${escapeHtml(String(ze.number))} — ${escapeHtml(ze.label || "")}</div>
      ${fieldsHtml}
    `;
    list.appendChild(li);
  }
  for (const nz of edits.newZones || []) {
    const li = document.createElement("li");
    li.className = "tech-property-updates-row tech-property-updates-row--new";
    const desc = [];
    if (nz.location) desc.push(escapeHtml(nz.location));
    if (Array.isArray(nz.sprinklerTypes) && nz.sprinklerTypes.length) desc.push(`sprinkler: ${escapeHtml(nz.sprinklerTypes.join(", "))}`);
    if (Array.isArray(nz.coverage) && nz.coverage.length) desc.push(`coverage: ${escapeHtml(nz.coverage.join(", "))}`);
    li.innerHTML = `
      <div class="tech-property-updates-zone">
        <span class="tech-property-updates-new-pill">NEW</span>
        Zone ${escapeHtml(String(nz.number))}${desc.length ? ` — ${desc.join(" · ")}` : ""}
      </div>
      <div class="tech-property-updates-flag">Flagged for Patrick to review on the property page.</div>
    `;
    list.appendChild(li);
  }
}

// ---- Post-signature narrative banner (Brief E / spec §4.3.2) ----------
// Three states:
//   pending_photos    — signed, photo gate not met, status not completed
//   ready_to_complete — signed, photo gate met, status not completed
//   completed         — status === completed (cascade fired or about to)
// Hidden otherwise. Updates whenever signature / photos / status change.
function renderPostSigBanner() {
  // Keep the pre-sign readiness list in sync as zones / photos / CF
  // resolutions mutate. Cheap; runs whenever this banner re-renders.
  updateSignoffSubmitState();
  // The recovery surface gates on the same state (locked + history +
  // invoice). Re-render here so a freshly-fired cascade hides the
  // recovery buttons within the same tick.
  if (typeof renderCascadeRecovery === "function") renderCascadeRecovery();

  const banner = document.getElementById("techPostSigBanner");
  const icon = document.getElementById("techPostSigIcon");
  const headline = document.getElementById("techPostSigHeadline");
  const detail = document.getElementById("techPostSigDetail");
  if (!banner || !headline || !detail) return;
  const signed = !!state.signature?.signed;
  const completed = state.status === "completed";

  if (completed) {
    banner.hidden = false;
    banner.dataset.state = "completed";
    if (icon) icon.textContent = "✓";
    headline.textContent = "Visit signed, locked, and completed.";
    detail.innerHTML = state.completedInvoiceId
      ? `Draft invoice <a href="/admin/invoice/${encodeURIComponent(state.completedInvoiceId)}" class="tech-postsig-link">${state.completedInvoiceId.replace(/</g, "&lt;")}</a> on file. Customer summary email sent.`
      : "Service record on file. No charge for this visit.";
    return;
  }

  if (!signed) {
    // Pre-signature — banner stays hidden. The sign-section readiness
    // list (below the Sign, Lock & Generate Invoice button) is the
    // pre-sig narrative now.
    banner.hidden = true;
    return;
  }

  // Edge case: signed but status didn't flip to completed. Happens when
  // the cascade gate trips (e.g. WO has no linked propertyId) so the
  // server applied the signature + lock but didn't run the cascade.
  // Surface a recovery hint pointing at the fallback button.
  banner.hidden = false;
  banner.dataset.state = "needs_retry";
  if (icon) icon.textContent = "↻";
  headline.textContent = "Signed and locked — completion didn't fire.";
  detail.textContent = "Likely no linked property on the WO. Open it in the desktop editor to link a property and re-run the cascade.";
}

// ---- Payment & billing block (spec §4.3.2) ----------------------------
function renderPaymentBlock() {
  const subtotalEl = document.getElementById("techPaySubtotal");
  const hstEl = document.getElementById("techPayHst");
  const totalEl = document.getElementById("techPayTotal");
  const invoiceLine = document.getElementById("techPayInvoiceLine");
  if (!subtotalEl) return;
  const lines = (state.onSiteQuote && state.onSiteQuote.builderLineItems) || [];
  const totals = totalsForLines(lines);
  subtotalEl.textContent = formatMoney(totals.subtotal);
  hstEl.textContent = formatMoney(totals.hst);
  totalEl.textContent = formatMoney(totals.total);
  if (invoiceLine && state.onSiteQuote?.quoteId) {
    invoiceLine.textContent = `Quote on file: ${state.onSiteQuote.quoteId}. Invoice drafts at completion.`;
  }
  // Reflect persisted paidOnSite. null = neither radio checked (forces
  // tech to actively pick); true/false drives the appropriate one.
  const yesRadio = document.getElementById("techPayCapturedYes");
  const noRadio = document.getElementById("techPayCapturedNo");
  if (yesRadio) yesRadio.checked = state.paidOnSite === true;
  if (noRadio)  noRadio.checked  = state.paidOnSite === false;
}

// Wire the radio change → PATCH. Spec §4.3.2 Payment & Billing requires
// this to persist; the cascade reads it to flag the draft invoice.
// Allowed on a signed WO (paidOnSite is NOT scope-protected — scope is
// frozen at signature, payment metadata isn't).
document.getElementById("techPaymentSection")?.addEventListener("change", (event) => {
  if (event.target.name !== "techPayCaptured") return;
  const value = event.target.value === "yes" ? true
    : event.target.value === "no" ? false
    : null;
  if (state.paidOnSite === value) return;
  state.paidOnSite = value;
  patchWorkOrder({ paidOnSite: value });
  // Pre-sign checklist surfaces this gate (Brief: WO Field-Readiness
  // §6.2). Re-render immediately so the ✓ flips without waiting for
  // the PATCH round-trip.
  updateSignoffSubmitState();
});

// Return-visit decision (v27). Tri-state radio: Yes (true) reveals the
// Parts-to-bring-back + Schedule-follow-up sections, No (false) keeps
// them hidden. Toggles the section visibility immediately so the tech
// doesn't have to wait on the PATCH round-trip.
function applyReturnVisitVisibility() {
  const bringback = document.getElementById("techBringbackSection");
  const followup = document.getElementById("techFollowupSection");
  const wantsReturn = state.needsReturnVisit === true;
  if (bringback) bringback.hidden = !wantsReturn;
  if (followup) followup.hidden = !wantsReturn;
  // Mirror state into the radio inputs (matches the renderPaymentSection
  // pattern — JS is the source of truth, HTML defaults are overridden).
  const yes = document.getElementById("techReturnGateYes");
  const no = document.getElementById("techReturnGateNo");
  if (yes) yes.checked = state.needsReturnVisit === true;
  if (no) no.checked = state.needsReturnVisit === false;
}
document.getElementById("techReturnGateSection")?.addEventListener("change", (event) => {
  if (event.target.name !== "techReturnGate") return;
  const value = event.target.value === "yes" ? true
    : event.target.value === "no" ? false
    : null;
  if (state.needsReturnVisit === value) return;
  state.needsReturnVisit = value;
  patchWorkOrder({ needsReturnVisit: value });
  applyReturnVisitVisibility();
  // The return-visit gate is one of the pre-sign failures (v27 server
  // + client check). Re-render the checklist + the submit-button
  // enable state without waiting on the PATCH round-trip.
  updateSignoffSubmitState();
});

// ---- Follow-up visit (spec §4.3.2 Follow-Up WO Trigger) ---------------
// Opens the shared crm-followup modal. The modal lets the tech pick a
// return slot (condensed Morning / Midday / Afternoon / Evening), check
// off parts to load on the truck, and add scope notes — then either
// "Schedule + create WO" or "Create WO — schedule later."
document.getElementById("techFollowupBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("techFollowupBtn");
  const status = document.getElementById("techFollowupStatus");
  if (typeof window.openCrmFollowup !== "function") {
    if (status) { status.hidden = false; status.textContent = "Follow-up modal couldn't load."; }
    return;
  }
  // Inherit the standalone "Parts to bring back" qty map first (the
  // tech built it during the visit), then fall back to legacy line-
  // item SKUs from the parent's onSiteQuote builder for older WOs.
  // Custom parts (not in the catalog) ride alongside as a separate
  // array so the modal/server can pre-load both into the follow-up.
  const bringbackQty = {};
  Object.entries(state.materialsPacked || {}).forEach(([sku, qty]) => {
    const n = Math.max(0, Math.floor(Number(qty) || 0));
    if (n > 0) bringbackQty[sku] = n;
  });
  const inheritedQty = Object.keys(bringbackQty).length
    ? bringbackQty
    : (state.onSiteQuote?.builderLineItems || [])
        .map((li) => li?.source?.partSku || li?.source?.sku || li?.sku || "")
        .filter(Boolean)
        .reduce((acc, sku) => { acc[sku] = (acc[sku] || 0) + 1; return acc; }, {});
  const inheritedCustom = (state.customParts || [])
    .filter((p) => Number(p.qty) > 0 && (p.name || p.size))
    .map((p) => ({ name: p.name || "", size: p.size || "", qty: Math.floor(Number(p.qty) || 0) }));
  if (status) status.hidden = true;
  window.openCrmFollowup({
    workOrderId: state.id,
    parentAddress: state.address || "",
    parentSkus: inheritedQty,
    parentCustomParts: inheritedCustom,
    onDone: (data) => {
      if (status) {
        status.hidden = false;
        status.textContent = data.scheduledFor
          ? `Follow-up ${data.followupWoId} scheduled for ${new Date(data.scheduledFor).toLocaleString("en-CA")}.`
          : `Follow-up ${data.followupWoId} created. Patrick will call to schedule.`;
      }
      btn.disabled = true;
    }
  });
});

// ---- Offline banner + queued-mutation status (spec §4.3.3 rule #12) -----
// Wires the offline-queue helper to the banner up top. Updates on every
// online/offline transition and every queue change. Hidden when the
// browser is online AND nothing is queued.
function renderOfflineBanner() {
  const banner = document.getElementById("techOfflineBanner");
  const text = document.getElementById("techOfflineText");
  if (!banner || !text) return;
  const online = navigator.onLine;
  const queued = (window.PJLOffline && window.PJLOffline.pendingCount && window.PJLOffline.pendingCount()) || 0;
  if (online && queued === 0) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  if (!online && queued > 0) {
    text.textContent = `Offline — ${queued} change${queued === 1 ? "" : "s"} saved locally, will sync when you reconnect.`;
  } else if (!online) {
    text.textContent = "Offline — changes will be saved locally and synced when you reconnect.";
  } else {
    text.textContent = `Syncing ${queued} pending change${queued === 1 ? "" : "s"}…`;
  }
}
window.addEventListener("online", renderOfflineBanner);
window.addEventListener("offline", renderOfflineBanner);
if (window.PJLOffline) {
  window.PJLOffline.on("change", renderOfflineBanner);
  renderOfflineBanner();
}

// Patch the global fetch wrapper used by patchWorkOrder so writes get
// queued offline. Only intercept the WO PATCH path — other endpoints
// stay online-only for v1 (carry-forward, on-site-quote/build, etc.
// are non-trivial to replay correctly, so leave them as-is).
(function wrapPatchWorkOrder() {
  if (typeof patchWorkOrder !== "function") return;
  const original = patchWorkOrder;
  // eslint-disable-next-line no-undef
  window.patchWorkOrder = async function (...args) {
    if (!window.PJLOffline) return original.apply(this, args);
    // Re-implement the inner fetch using PJLOffline.queuedFetch so the
    // call falls into IndexedDB on offline. Original signature:
    //   patchWorkOrder(patchObj) → debounced PATCH
    // The original uses fetch() internally; we monkey-patch fetch
    // briefly during the call so the mutation goes through queuedFetch.
    const realFetch = window.fetch;
    window.fetch = function (url, init = {}) {
      const method = (init.method || "GET").toUpperCase();
      if (typeof url === "string" && method === "PATCH" && /^\/api\/work-orders\/[^/]+$/.test(new URL(url, location.origin).pathname)) {
        return window.PJLOffline.queuedFetch(url, init);
      }
      return realFetch.call(this, url, init);
    };
    try {
      return await original.apply(this, args);
    } finally {
      window.fetch = realFetch;
    }
  };
})();

init();
