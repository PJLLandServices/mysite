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
const sheetTitle = document.getElementById("sheetTitle");
const sheetLocation = document.getElementById("sheetLocation");
const sheetSystem = document.getElementById("sheetSystem");
const sheetStatus = document.getElementById("sheetStatus");
const sheetChecks = document.getElementById("sheetChecks");
const sheetIssues = document.getElementById("sheetIssues");
const sheetIssueAdd = document.getElementById("sheetIssueAdd");
const sheetNotes = document.getElementById("sheetNotes");
const sheetClose = document.getElementById("sheetClose");
const sheetDone = document.getElementById("sheetDone");

const SPRINKLER_LABELS = { rotors: "Rotors", popups: "Pop-ups", drip: "Drip", flower_pots: "Flower Pots" };
const COVERAGE_LABELS  = { plants: "Plants", grass: "Grass", trees: "Trees" };

// Issue type catalog — labels for the per-zone issue dropdown. Keys map
// (loosely) to pricing.json categories so a future Tier-3 rollup can
// auto-price: head_replacement, manifold rebuilds, wire repairs, pipe
// break repair. "Other" is the escape hatch for anything that doesn't
// fit (custom on-site quote at the desktop side).
const ZONE_ISSUE_TYPE_OPTIONS = [
  { value: "broken_head", label: "Broken head" },
  { value: "leak",        label: "Leak" },
  { value: "valve",       label: "Valve" },
  { value: "wire",        label: "Wire" },
  { value: "pipe",        label: "Pipe" },
  { value: "other",       label: "Other" }
];

const ZONE_CHECK_KEYS = ["operated", "pressureGood", "coverageGood", "noLeaks", "allHeadsFunctional"];

// Service-specific checklist definitions per spec §4.3.2. Mirrors
// SERVICE_CHECKLISTS in server/lib/work-orders.js — keep these in sync
// if step keys change. Service visits have no checklist (one-off
// repairs use the zone walk-through + tech notes only).
const SERVICE_CHECKLISTS_TECH = {
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
  signaturePad: null
};

// Cached geolocation result so we only prompt once per page load. null
// after a denial, object after a grant. Watermark + upload calls await
// this — it returns null fast on subsequent invocations (no re-prompt).
let _cachedGeo = undefined; // undefined = not yet asked

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
        const base64 = dataUrl.split(",", 2)[1] || "";
        resolve({ base64, mediaType: "image/jpeg" });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Upload one or more photos to /api/work-orders/:id/photos. `meta` is
// any additional fields (category, zoneNumber, issueId, label) that get
// attached to each uploaded photo. Each file is resized + watermarked
// before send, with geo + takenAt captured at processing time.
async function uploadWoPhotos(files, meta = {}) {
  const arr = Array.from(files || []);
  if (!arr.length) return null;
  // Geolocation prompt fires here — once per page load. Returns null on
  // denial / timeout, in which case the watermark + uploaded meta omit it.
  const geo = await getCurrentGeo();
  const photos = [];
  // Best-effort sequence label for the watermark — counts NEW photos
  // about to land. Server filename uses real n; this is just visual.
  const existingCount = (state.photos || []).length;
  let seq = 0;
  for (const f of arr) {
    if (!f.type || !f.type.startsWith("image/")) continue;
    seq += 1;
    const takenAt = new Date();
    const seqLabel = `#${existingCount + seq}`;
    const processed = await processPhotoForUpload(f, {
      geo,
      takenAt,
      woId: state.id,
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
  const response = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}/photos`, {
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
    const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
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
      if ("zones" in payload)     state.zones = data.workOrder.zones;
      techMeta.textContent = `Updated ${formatDateTime(data.workOrder.updatedAt)}`;
    }
    hideSaving();
  } catch (err) {
    hideSaving(err);
  }
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

document.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-run-status]");
  if (!btn) return;
  const next = btn.dataset.runStatus;
  if (next === state.status) return;
  // Confirm the destructive-feeling "Completed" tap so a misclick on the
  // finish bar doesn't fire the cascade. Other transitions are silent.
  if (next === "completed") {
    if (!confirm("Mark this visit completed? This will create a service record on the property and a draft invoice if there are any line items. You can still edit the WO afterwards.")) return;
  }
  state.status = next;
  renderRunStatus();
  patchWorkOrder({ status: next });
});

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
          <span class="tech-zone-num">${escapeHtml(z.number || "?")}</span>
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

// ---- Zone-edit bottom sheet -------------------------------------

function openZoneSheet(index) {
  const zone = state.zones[index];
  if (!zone) return;
  state.activeZoneIndex = index;

  sheetTitle.textContent = `Zone ${zone.number || "?"}`;
  sheetLocation.textContent = zone.location || "(unnamed)";

  // Sprinkler + coverage badges (read-only — system facts come from
  // the property profile, not the WO). Hidden when neither is set.
  const sprinkler = badgeListHtml(zone.sprinklerTypes || [], SPRINKLER_LABELS);
  const coverage  = badgeListHtml(zone.coverage       || [], COVERAGE_LABELS);
  if (sprinkler || coverage) {
    sheetSystem.innerHTML = `
      ${sprinkler ? `<div class="tech-sheet-sys-row"><span>Sprinkler</span><div>${sprinkler}</div></div>` : ""}
      ${coverage  ? `<div class="tech-sheet-sys-row"><span>Coverage</span><div>${coverage}</div></div>`  : ""}
    `;
    sheetSystem.hidden = false;
  } else {
    sheetSystem.hidden = true;
    sheetSystem.innerHTML = "";
  }

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
    const optionsHtml = ZONE_ISSUE_TYPE_OPTIONS.map((t) =>
      `<option value="${t.value}" ${t.value === issue.type ? "selected" : ""}>${escapeHtml(t.label)}</option>`
    ).join("");
    div.innerHTML = `
      <select class="tech-zone-issue-type" aria-label="Issue type">${optionsHtml}</select>
      <input type="number" class="tech-zone-issue-qty" min="1" inputmode="numeric" value="${escapeHtml(String(issue.qty || 1))}" aria-label="Quantity">
      <input type="text" class="tech-zone-issue-notes" value="${escapeHtml(issue.notes || "")}" placeholder="Details (optional)" aria-label="Issue notes">
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
  // iOS/Android offer Photo Library + Take Photo + Choose File.
  label.innerHTML = `
    <input type="file" accept="image/*" multiple hidden>
    <span aria-hidden="true">📷</span>
    <span>Photo</span>
  `;
  label.querySelector("input").addEventListener("change", async (event) => {
    if (state.locked) return;
    const input = event.target;
    const files = input.files;
    if (!files || !files.length) return;
    label.classList.add("is-uploading");
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
  if (event.target.classList.contains("tech-zone-issue-type")) {
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
  const typeEl  = card.querySelector(".tech-zone-issue-type");
  const qtyEl   = card.querySelector(".tech-zone-issue-qty");
  const notesEl = card.querySelector(".tech-zone-issue-notes");
  const nextType  = typeEl ? typeEl.value : issue.type;
  const nextQty   = Math.max(1, Math.floor(Number(qtyEl?.value) || 1));
  const nextNotes = (notesEl?.value || "").trim();
  if (issue.type === nextType && issue.qty === nextQty && issue.notes === nextNotes) return;
  issue.type  = nextType;
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
  const img = document.createElement("img");
  img.src = woPhotoUrl(photo.n);
  img.loading = "lazy";
  img.alt = photo.label || `Photo ${photo.n}`;
  img.addEventListener("click", () => openLightbox(woPhotoUrl(photo.n)));
  wrap.appendChild(img);
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
      } catch (err) { alert(err.message); }
    });
    wrap.appendChild(remove);
  }
  return wrap;
}

// Visit-photo upload — fires when the file picker emits a change. Mobile
// browsers honor `capture="environment"` to open the camera directly.
document.getElementById("techWoPhotoInput")?.addEventListener("change", async (event) => {
  if (state.locked) return;
  const input = event.target;
  const files = input.files;
  if (!files || !files.length) return;
  const addBtn = document.querySelector(".tech-photo-add");
  if (addBtn) addBtn.classList.add("is-uploading");
  try {
    const wo = await uploadWoPhotos(files, { category: "general" });
    if (wo) {
      state.photos = wo.photos || [];
      renderWoPhotos();
    }
  } catch (err) {
    alert(err.message || "Couldn't upload photo.");
  } finally {
    if (addBtn) addBtn.classList.remove("is-uploading");
    input.value = "";  // reset so picking the same file re-fires change
  }
});

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
// are all set. Re-runs on every input change so the tech sees the
// gating in real time.
function updateSignoffSubmitState() {
  const submit = document.getElementById("techSignoffSubmit");
  if (!submit) return;
  const name = (document.getElementById("techSignoffName")?.value || "").trim();
  const ack = !!document.getElementById("techSignoffAck")?.checked;
  const drawn = !!(state.signaturePad && state.signaturePad.isDirty());
  submit.disabled = !(name && ack && drawn);
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
  submit.disabled = true;
  submit.textContent = "Signing…";
  try {
    const imageData = state.signaturePad.toDataURL();
    const response = await fetch(`/api/work-orders/${encodeURIComponent(state.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signature: { customerName, imageData, acknowledgement: true }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error((data.errors && data.errors[0]) || "Couldn't save signature.");
    }
    state.signature = data.workOrder.signature || state.signature;
    state.locked = data.workOrder.locked === true;
    renderSignoff();
    applyLockState(state.locked);
  } catch (err) {
    submit.disabled = false;
    submit.textContent = "Sign & lock work order";
    alert(err.message || "Couldn't save signature.");
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
  // Intake-guarantee callout: only shown when AI quote is locked.
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
        <span class="tech-on-site-line-label">${escapeHtml(line.label || "(unlabeled)")}</span>
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
    label: "Custom line — describe the work",
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

  // ---- Action chips: call / text / maps -----------------------------
  const phone = wo.customerPhone || "";
  const phoneNormalized = phone.replace(/[^\d+]/g, "");
  const callLink = document.getElementById("techCallLink");
  const textLink = document.getElementById("techTextLink");
  if (phoneNormalized) {
    if (callLink) { callLink.href = "tel:" + phoneNormalized; callLink.hidden = false; }
    if (textLink) { textLink.href = "sms:" + phoneNormalized; textLink.hidden = false; }
  }
  const mapsLink = document.getElementById("techMapsLink");
  if (mapsLink && wo.address) {
    // Universal Google Maps URL — opens in the system's default maps app
    // on iOS and Android, browser on desktop.
    mapsLink.href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(wo.address);
    mapsLink.hidden = false;
  }

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

    // Cheat Sheet — first thing the tech reviews on arrival. Pulls from
    // the property record + the most-recent completed WO at the property.
    renderCheatSheet(wo, data.property, data.lastService);

    // Carry-forward banner — spec §5. Spring openings auto-load the
    // property's open + pre-authorized deferred items so the tech walks in
    // knowing what to fix from prior visits. Awaits a fetch but doesn't
    // block the rest of the render — the section reveals when ready.
    renderCarryForward(data.property).catch((err) => console.warn("[carry-forward]", err?.message));

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

    // AI Intake Guarantee banner — populated from the WO's snapshotted
    // copy of the source Quote's intake guarantee. Visible only when the
    // AI quoted a specific repair scope and the customer accepted; serves
    // as the tech's reminder that labour is locked.
    const igBanner = document.getElementById("techIntakeGuarantee");
    const igScope = document.getElementById("techIntakeScope");
    const igSource = document.getElementById("techIntakeSource");
    if (igBanner && wo.intakeGuarantee && wo.intakeGuarantee.applies === true) {
      if (igScope) igScope.textContent = wo.intakeGuarantee.scope || "Locked scope";
      if (igSource && wo.intakeGuarantee.sourceQuoteId) {
        igSource.textContent = `Source: ${wo.intakeGuarantee.sourceQuoteId}`;
      }
      igBanner.hidden = false;
    }

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

    techLoading.hidden = true;
    techMain.hidden = false;
  } catch {
    techLoading.hidden = true;
    techError.hidden = false;
  }
}

init();
