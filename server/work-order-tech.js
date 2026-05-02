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
  locked: false,
  // Tracks which zone the bottom sheet is currently editing.
  activeZoneIndex: -1,
  // Pending PATCH timer for debounced notes-while-typing.
  notesTimer: null,
  zoneNotesTimer: null,
  // Debounce timer for issue-row qty/notes typing inside the sheet.
  // Type selects fire immediately on change (no debounce needed).
  issueInputTimer: null,
  // Signature pad helper (set after init).
  signaturePad: null
};

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

function renderRunStatus() {
  techRunStatus.querySelectorAll("[data-run-status]").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.dataset.runStatus === state.status ? "true" : "false");
  });
}

techRunStatus.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-run-status]");
  if (!btn) return;
  const next = btn.dataset.runStatus;
  if (next === state.status) return;
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
  issues.forEach((issue) => {
    const div = document.createElement("div");
    div.className = "tech-zone-issue";
    div.dataset.issueId = issue.id;
    const optionsHtml = ZONE_ISSUE_TYPE_OPTIONS.map((t) =>
      `<option value="${t.value}" ${t.value === issue.type ? "selected" : ""}>${escapeHtml(t.label)}</option>`
    ).join("");
    div.innerHTML = `
      <select class="tech-zone-issue-type" aria-label="Issue type">${optionsHtml}</select>
      <input type="number" class="tech-zone-issue-qty" min="1" inputmode="numeric" value="${escapeHtml(String(issue.qty || 1))}" aria-label="Quantity">
      <input type="text" class="tech-zone-issue-notes" value="${escapeHtml(issue.notes || "")}" placeholder="Details (optional)" aria-label="Issue notes">
      <button type="button" class="tech-zone-issue-remove" aria-label="Remove issue">×</button>
    `;
    sheetIssues.appendChild(div);
  });
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
    state.locked = wo.locked === true;

    techId.textContent = wo.id;
    techType.textContent = TYPE_LABELS[wo.type] || wo.type;
    const customer = [wo.customerName, wo.customerEmail].filter(Boolean).join(" · ");
    techCustomer.textContent = customer || "Customer details not yet captured";
    techAddress.textContent = wo.address || "—";
    techMeta.textContent = `Updated ${formatDateTime(wo.updatedAt)}`;
    techNotes.value = state.techNotes;

    // Cheat Sheet — first thing the tech reviews on arrival. Pulls from
    // the property record + the most-recent completed WO at the property.
    renderCheatSheet(wo, data.property, data.lastService);

    // Service-specific checklist (spring opening / fall closing) and
    // customer sign-off section. Lock state cascades after both are
    // rendered so disabled inputs apply uniformly.
    renderServiceChecklist();
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
