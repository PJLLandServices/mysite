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
const sheetNotes = document.getElementById("sheetNotes");
const sheetClose = document.getElementById("sheetClose");
const sheetDone = document.getElementById("sheetDone");

const SPRINKLER_LABELS = { rotors: "Rotors", popups: "Pop-ups", drip: "Drip", flower_pots: "Flower Pots" };
const COVERAGE_LABELS  = { plants: "Plants", grass: "Grass", trees: "Trees" };

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
  status: "scheduled",
  techNotes: "",
  zones: [],
  // Tracks which zone the bottom sheet is currently editing.
  activeZoneIndex: -1,
  // Pending PATCH timer for debounced notes-while-typing.
  notesTimer: null,
  zoneNotesTimer: null
};

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
      li.innerHTML = `
        <button type="button" class="tech-zone-item-btn" data-open-zone="${i}">
          <span class="tech-zone-num">${escapeHtml(z.number || "?")}</span>
          <span class="tech-zone-body">
            <span class="tech-zone-location">${escapeHtml(z.location || "(unnamed)")}</span>
            ${reviewedTag}
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

  sheetNotes.value = zone.notes || "";

  techSheet.hidden = false;
  document.body.classList.add("tech-sheet-open");
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
    state.status = wo.status || "scheduled";
    state.techNotes = wo.techNotes || "";
    state.zones = Array.isArray(wo.zones) ? wo.zones.map((z) => ({ ...z })) : [];

    techId.textContent = wo.id;
    techType.textContent = TYPE_LABELS[wo.type] || wo.type;
    const customer = [wo.customerName, wo.customerEmail].filter(Boolean).join(" · ");
    techCustomer.textContent = customer || "Customer details not yet captured";
    techAddress.textContent = wo.address || "—";
    techMeta.textContent = `Updated ${formatDateTime(wo.updatedAt)}`;
    techNotes.value = state.techNotes;

    if (wo.diagnosis) {
      techDiagnosisText.textContent = typeof wo.diagnosis === "string"
        ? wo.diagnosis
        : JSON.stringify(wo.diagnosis, null, 2);
      techDiagnosis.hidden = false;
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
