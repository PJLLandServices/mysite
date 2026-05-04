// Schedule admin page. Loads blocks, working hours, and bookings, and lays
// them out on a 7-day grid. The customer-facing booking calendar reads from
// the same data via /api/booking/availability — anything you block here is
// instantly invisible to customers.

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

const weekRange = document.getElementById("weekRange");
const prevWeekBtn = document.getElementById("prevWeek");
const nextWeekBtn = document.getElementById("nextWeek");
const addBlockBtn = document.getElementById("addBlock");
const scheduleWeek = document.getElementById("scheduleWeek");
const blockList = document.getElementById("blockList");
const weekBookings = document.getElementById("weekBookings");
const weekBlockHours = document.getElementById("weekBlockHours");
const weekFreeHours = document.getElementById("weekFreeHours");
const blockDialog = document.getElementById("blockDialog");
const blockForm = document.getElementById("blockForm");
const blockLabel = document.getElementById("blockLabel");
const blockStart = document.getElementById("blockStart");
const blockEnd = document.getElementById("blockEnd");
const blockCancel = document.getElementById("blockCancel");
const blockError = document.getElementById("blockError");
const hoursGrid = document.getElementById("hoursGrid");
const settingLeadHours = document.getElementById("settingLeadHours");
const settingBuffer = document.getElementById("settingBuffer");
const settingIncrement = document.getElementById("settingIncrement");
const saveSettings = document.getElementById("saveSettings");
const settingsStatus = document.getElementById("settingsStatus");
const logoutButton = document.getElementById("logoutButton");

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

let weekStart = startOfWeek(new Date());
let blocks = [];
let bookings = [];
let defaults = { hours: {}, settings: {}, services: {} };
let overrides = { hours: {}, settings: {} };

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // Sunday = 0
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function fmtDate(d) {
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

function fmtRange(start) {
  const end = addDays(start, 6);
  return `${fmtDate(start)} – ${fmtDate(end)}, ${end.getFullYear()}`;
}

function fmtTime(value) {
  return new Date(value).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
}

function fmtDateTime(value) {
  return new Date(value).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function effectiveHours() {
  const merged = { ...defaults.hours };
  Object.keys(overrides.hours || {}).forEach((dow) => {
    merged[dow] = overrides.hours[dow];
  });
  return merged;
}

function effectiveSettings() {
  return { ...defaults.settings, ...(overrides.settings || {}) };
}

async function loadAll() {
  const [blocksResp, bookingsResp, settingsResp] = await Promise.all([
    fetch("/api/schedule/blocks", { cache: "no-store" }).then((r) => r.json()),
    fetch("/api/quotes", { cache: "no-store" }).then((r) => r.json()),
    fetch("/api/schedule/settings", { cache: "no-store" }).then((r) => r.json())
  ]);
  blocks = blocksResp.ok ? blocksResp.blocks : [];
  bookings = (bookingsResp.leads || [])
    .filter((l) => l.booking && l.booking.start && l.booking.end)
    .map((l) => ({
      id: l.id,
      start: l.booking.start,
      end: l.booking.end,
      label: l.booking.serviceLabel || "Booking",
      customer: l.contact?.name || "Customer",
      address: l.contact?.address || "",
      status: l.crm?.status
    }));
  if (settingsResp.ok) {
    defaults = settingsResp.defaults;
    overrides = settingsResp.overrides;
  }
  renderSettings();
  render();
}

function render() {
  weekRange.textContent = fmtRange(weekStart);
  scheduleWeek.innerHTML = "";

  const hours = effectiveHours();
  let totalBlockedMs = 0;
  let totalBookedMs = 0;
  let totalBookableMs = 0;

  for (let i = 0; i < 7; i++) {
    const day = addDays(weekStart, i);
    const dow = day.getDay();
    const window = hours[dow];
    const dayCol = document.createElement("div");
    dayCol.className = "schedule-day";

    const head = document.createElement("header");
    head.innerHTML = `<strong>${DAY_NAMES[dow].slice(0, 3)}</strong><span>${fmtDate(day)}</span>`;
    dayCol.append(head);

    if (!window) {
      const closed = document.createElement("div");
      closed.className = "schedule-closed";
      closed.textContent = "Closed";
      dayCol.append(closed);
      scheduleWeek.append(dayCol);
      continue;
    }

    const open = document.createElement("div");
    open.className = "schedule-window";
    open.innerHTML = `<span>Window</span><strong>${escapeHtml(window.open)}–${escapeHtml(window.close)}</strong>`;
    dayCol.append(open);

    const startMs = setHHmm(day, window.open).getTime();
    const endMs = setHHmm(day, window.close).getTime();
    totalBookableMs += endMs - startMs;

    // Bookings on this day. Each card carries the leadId + start time
    // as data-* attributes; the click is handled via event delegation
    // on scheduleWeek (set up once, below loadAll). Cards are <button>s
    // so screen readers + keyboard users can also activate them.
    const dayBookings = bookings.filter((b) => sameDay(new Date(b.start), day));
    dayBookings.forEach((b) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "schedule-event schedule-booking";
      card.title = "Click to reschedule this appointment";
      card.dataset.leadId = b.id;
      card.dataset.start = b.start;
      card.innerHTML = `
        <span class="event-time">${escapeHtml(fmtTime(b.start))} – ${escapeHtml(fmtTime(b.end))}</span>
        <strong>${escapeHtml(b.label)}</strong>
        <span>${escapeHtml(b.customer)}</span>
        <span class="event-reschedule-hint">📅 Reschedule</span>
      `;
      dayCol.append(card);
      totalBookedMs += new Date(b.end) - new Date(b.start);
    });

    // Blocks on this day
    const dayBlocks = blocks.filter((b) => rangesOverlap(new Date(b.start), new Date(b.end), setHHmm(day, "00:00"), setHHmm(addDays(day, 1), "00:00")));
    dayBlocks.forEach((b) => {
      const card = document.createElement("div");
      card.className = "schedule-event schedule-block";
      card.innerHTML = `
        <span class="event-time">${escapeHtml(fmtTime(b.start))} – ${escapeHtml(fmtTime(b.end))}</span>
        <strong>${escapeHtml(b.label)}</strong>
        <button type="button" class="event-delete" data-block-id="${escapeHtml(b.id)}" aria-label="Remove block">×</button>
      `;
      dayCol.append(card);
      // Count only the block portion that intersects this day's window.
      const overlapStart = Math.max(new Date(b.start).getTime(), startMs);
      const overlapEnd = Math.min(new Date(b.end).getTime(), endMs);
      if (overlapEnd > overlapStart) totalBlockedMs += overlapEnd - overlapStart;
    });

    if (!dayBookings.length && !dayBlocks.length) {
      const empty = document.createElement("div");
      empty.className = "schedule-empty";
      empty.textContent = "Open";
      dayCol.append(empty);
    }

    scheduleWeek.append(dayCol);
  }

  weekBookings.textContent = bookings.filter((b) => {
    const t = new Date(b.start).getTime();
    return t >= weekStart.getTime() && t < addDays(weekStart, 7).getTime();
  }).length;
  weekBlockHours.textContent = (totalBlockedMs / 3_600_000).toFixed(1);
  weekFreeHours.textContent = Math.max(0, (totalBookableMs - totalBookedMs - totalBlockedMs) / 3_600_000).toFixed(1);

  renderBlockList();
}

function renderBlockList() {
  if (!blocks.length) {
    blockList.innerHTML = `<li class="empty">No blocked time. Use the &ldquo;Block off time&rdquo; button to add a vacation, holiday, or appointment.</li>`;
    return;
  }
  blockList.innerHTML = "";
  blocks.forEach((b) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div>
        <strong>${escapeHtml(b.label)}</strong>
        <span>${escapeHtml(fmtDateTime(b.start))} → ${escapeHtml(fmtDateTime(b.end))}</span>
      </div>
      <button type="button" data-block-id="${escapeHtml(b.id)}" class="pjl-btn pjl-btn-outline">Remove</button>
    `;
    blockList.append(li);
  });
}

function renderSettings() {
  const hours = effectiveHours();
  hoursGrid.innerHTML = "";
  for (let i = 0; i < 7; i++) {
    const window = hours[i];
    const row = document.createElement("div");
    row.className = "hours-row";
    row.innerHTML = `
      <strong>${DAY_NAMES[i]}</strong>
      <label><span>Open</span><input type="time" data-day="${i}" data-field="open" value="${window?.open || ""}" ${window ? "" : "disabled"}></label>
      <label><span>Close</span><input type="time" data-day="${i}" data-field="close" value="${window?.close || ""}" ${window ? "" : "disabled"}></label>
      <label><span>Last start</span><input type="time" data-day="${i}" data-field="lastStart" value="${window?.lastStart || ""}" ${window ? "" : "disabled"}></label>
      <label class="hours-closed-toggle"><input type="checkbox" data-day="${i}" data-field="closed" ${window ? "" : "checked"}><span>Closed</span></label>
    `;
    hoursGrid.append(row);
  }
  const settings = effectiveSettings();
  settingLeadHours.value = settings.leadTimeHours ?? 5;
  settingBuffer.value = settings.bufferMinutes ?? 15;
  settingIncrement.value = settings.slotIncrementMinutes ?? 30;
}

function setHHmm(date, hhmm) {
  const [h, m] = String(hhmm || "00:00").split(":").map(Number);
  const d = new Date(date);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
}

prevWeekBtn.addEventListener("click", () => { weekStart = addDays(weekStart, -7); render(); });
nextWeekBtn.addEventListener("click", () => { weekStart = addDays(weekStart, 7); render(); });

// Delegated click for booking cards on the schedule grid. Cards are
// re-rendered every week-change, so attaching per-card listeners is
// fragile — one missed re-attachment leaves dead cards. Delegating
// to scheduleWeek (which exists for the page lifetime) means the
// reschedule click ALWAYS fires regardless of when the cards were
// rendered or how many times the grid has been redrawn.
scheduleWeek.addEventListener("click", (event) => {
  const card = event.target.closest(".schedule-booking");
  if (!card) return;
  if (typeof window.openCrmReschedule !== "function") return;
  const leadId = card.dataset.leadId;
  const start = card.dataset.start;
  if (!leadId) return;
  window.openCrmReschedule({
    leadId,
    scheduledFor: start || undefined,
    onDone: () => loadAll().then(render).catch(() => {})
  });
});

addBlockBtn.addEventListener("click", () => {
  blockLabel.value = "";
  const now = new Date();
  now.setMinutes(0, 0, 0);
  blockStart.value = toLocalInput(now);
  blockEnd.value = toLocalInput(new Date(now.getTime() + 60 * 60 * 1000));
  blockError.hidden = true;
  if (typeof blockDialog.showModal === "function") blockDialog.showModal();
  else blockDialog.setAttribute("open", "");
});

blockCancel.addEventListener("click", () => blockDialog.close());

blockForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  blockError.hidden = true;
  try {
    const response = await fetch("/api/schedule/blocks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: blockLabel.value.trim(),
        start: new Date(blockStart.value).toISOString(),
        end: new Date(blockEnd.value).toISOString()
      })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Couldn't save block."]).join(" "));
    blockDialog.close();
    await loadAll();
  } catch (err) {
    blockError.textContent = err.message;
    blockError.hidden = false;
  }
});

function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Click-to-delete blocks (works in the calendar grid OR the active-blocks list).
document.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-block-id]");
  if (!btn || btn.tagName !== "BUTTON") return;
  if (!confirm("Remove this block?")) return;
  const id = btn.dataset.blockId;
  const response = await fetch(`/api/schedule/blocks/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (response.ok) await loadAll();
});

saveSettings.addEventListener("click", async () => {
  settingsStatus.textContent = "Saving...";
  const hoursPayload = {};
  hoursGrid.querySelectorAll(".hours-row").forEach((row, dow) => {
    const closed = row.querySelector('input[data-field="closed"]').checked;
    if (closed) {
      hoursPayload[dow] = null;
    } else {
      hoursPayload[dow] = {
        open: row.querySelector('input[data-field="open"]').value || "08:00",
        close: row.querySelector('input[data-field="close"]').value || "21:00",
        lastStart: row.querySelector('input[data-field="lastStart"]').value || "17:30"
      };
    }
  });
  const settingsPayload = {
    leadTimeHours: Number(settingLeadHours.value) || 5,
    bufferMinutes: Number(settingBuffer.value) || 15,
    slotIncrementMinutes: Number(settingIncrement.value) || 30
  };
  try {
    const response = await fetch("/api/schedule/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hours: hoursPayload, settings: settingsPayload })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Save failed."]).join(" "));
    settingsStatus.textContent = "Saved";
    await loadAll();
  } catch (err) {
    settingsStatus.textContent = err.message;
  }
});

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.assign("/login");
});

// ---------------------------------------------------------------
// Admin booking dialog — internal "book a customer" flow.
// Lets Patrick add a booking from the schedule for phone/walk-in
// customers or re-book an existing property. Uses the same
// /api/booking/reserve endpoint the public booking page uses.
// ---------------------------------------------------------------

const addBookingBtn       = document.getElementById("addBooking");
const bookingDialog       = document.getElementById("bookingDialog");
const bookingForm         = document.getElementById("bookingForm");
const bookingClose        = document.getElementById("bookingClose");
const bookingCancel       = document.getElementById("bookingCancel");
const bookingSubmit       = document.getElementById("bookingSubmit");
const bookingError        = document.getElementById("bookingError");
const bookingPropertySearch  = document.getElementById("bookingPropertySearch");
const bookingPropertyResults = document.getElementById("bookingPropertyResults");
const bookingFirstName    = document.getElementById("bookingFirstName");
const bookingLastName     = document.getElementById("bookingLastName");
const bookingPhone        = document.getElementById("bookingPhone");
const bookingEmail        = document.getElementById("bookingEmail");
const bookingAddress      = document.getElementById("bookingAddress");
const bookingNotes        = document.getElementById("bookingNotes");
const bookingService      = document.getElementById("bookingService");
const bookingZoneCount    = document.getElementById("bookingZoneCount");
const bookingSlotHelp     = document.getElementById("bookingSlotHelp");
const bookingSlotResults  = document.getElementById("bookingSlotResults");
const bookingSlotStart    = document.getElementById("bookingSlotStart");

let bookingProperties = [];
let bookingServicesCatalog = {};
let bookingAvailLastKey = "";
let bookingAvailTimer = null;

function resetBookingForm() {
  bookingForm?.reset();
  if (bookingPropertyResults) {
    bookingPropertyResults.hidden = true;
    bookingPropertyResults.innerHTML = "";
  }
  bookingSlotResults.innerHTML = "";
  bookingSlotHelp.hidden = false;
  bookingSlotHelp.textContent = "Fill in service + email + address to load available slots.";
  bookingSlotStart.value = "";
  bookingError.hidden = true;
  bookingError.textContent = "";
  bookingSubmit.disabled = true;
  bookingAvailLastKey = "";
}

async function ensureBookingPropertiesLoaded() {
  if (bookingProperties.length) return;
  try {
    const r = await fetch("/api/properties");
    const data = await r.json();
    if (data.ok && Array.isArray(data.properties)) {
      bookingProperties = data.properties;
    }
  } catch {
    bookingProperties = [];
  }
}

async function ensureBookingServicesLoaded() {
  if (bookingService.options.length > 1) return; // already populated
  try {
    const r = await fetch("/api/booking/services");
    const data = await r.json();
    bookingServicesCatalog = (data.ok && data.services) || {};
    // Group + label for the dropdown. Sorts seasonal first, then commercial,
    // then site_visit. Each option carries the service key.
    const entries = Object.entries(bookingServicesCatalog).filter(([, s]) => s.bookable);
    const groups = {
      "Spring opening (residential)":  entries.filter(([k, s]) => s.family === "spring_opening" && !k.includes("commercial")),
      "Spring opening (commercial)":   entries.filter(([k, s]) => s.family === "spring_opening" && k.includes("commercial")),
      "Fall winterization (residential)": entries.filter(([k, s]) => s.family === "fall_closing" && !k.includes("commercial")),
      "Fall winterization (commercial)":  entries.filter(([k, s]) => s.family === "fall_closing" && k.includes("commercial")),
      "Other": entries.filter(([, s]) => !["spring_opening", "fall_closing"].includes(s.family))
    };
    for (const [groupLabel, items] of Object.entries(groups)) {
      if (!items.length) continue;
      const og = document.createElement("optgroup");
      og.label = groupLabel;
      items.forEach(([key, svc]) => {
        const o = document.createElement("option");
        o.value = key;
        o.textContent = svc.label || key;
        og.appendChild(o);
      });
      bookingService.appendChild(og);
    }
  } catch {
    // leave empty — submit will catch missing service
  }
}

addBookingBtn?.addEventListener("click", async () => {
  if (!bookingDialog) return;
  resetBookingForm();
  await Promise.all([ensureBookingPropertiesLoaded(), ensureBookingServicesLoaded()]);
  if (typeof bookingDialog.showModal === "function") bookingDialog.showModal();
  else bookingDialog.setAttribute("open", "");
});

function closeBookingDialog() {
  if (typeof bookingDialog.close === "function") bookingDialog.close();
  else bookingDialog.removeAttribute("open");
}
bookingClose?.addEventListener("click", closeBookingDialog);
bookingCancel?.addEventListener("click", closeBookingDialog);

// ---- Existing-property typeahead -------------------------------
bookingPropertySearch?.addEventListener("input", () => {
  const q = bookingPropertySearch.value.trim().toLowerCase();
  if (!q) {
    bookingPropertyResults.hidden = true;
    bookingPropertyResults.innerHTML = "";
    return;
  }
  const matches = bookingProperties.filter((p) => {
    const hay = [p.customerName, p.customerEmail, p.address, p.code].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  }).slice(0, 8);
  bookingPropertyResults.innerHTML = "";
  if (!matches.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No match — fill in the new-customer fields below.";
    bookingPropertyResults.appendChild(li);
  } else {
    matches.forEach((p) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.innerHTML = `
        <strong>${escapeHtml(p.customerName || "(no name)")}</strong>
        <small>${escapeHtml(p.address || "")}${p.customerEmail ? " · " + escapeHtml(p.customerEmail) : ""}</small>
      `;
      btn.addEventListener("click", () => fillFromProperty(p));
      li.appendChild(btn);
      bookingPropertyResults.appendChild(li);
    });
  }
  bookingPropertyResults.hidden = false;
});

function fillFromProperty(p) {
  const parts = String(p.customerName || "").trim().split(/\s+/);
  bookingFirstName.value = parts[0] || "";
  bookingLastName.value  = parts.slice(1).join(" ") || "";
  bookingPhone.value     = p.customerPhone || "";
  bookingEmail.value     = p.customerEmail || "";
  bookingAddress.value   = p.address || "";
  // Prefill zone count from the property's known zone list.
  const zoneCount = Array.isArray(p.system?.zones) ? p.system.zones.length : 0;
  if (zoneCount) bookingZoneCount.value = String(zoneCount);
  bookingPropertyResults.hidden = true;
  bookingPropertyResults.innerHTML = "";
  bookingPropertySearch.value = `${p.customerName || ""} · ${p.address || ""}`.trim();
  scheduleAvailLookup();
}

// ---- Availability fetch / slot list ----------------------------
function scheduleAvailLookup() {
  clearTimeout(bookingAvailTimer);
  bookingAvailTimer = setTimeout(loadAvailability, 250);
}

[bookingService, bookingAddress, bookingEmail].forEach((el) => {
  el?.addEventListener("change", scheduleAvailLookup);
  el?.addEventListener("blur", scheduleAvailLookup);
});

async function loadAvailability() {
  const serviceKey = bookingService.value;
  const address = bookingAddress.value.trim();
  if (!serviceKey || !address) {
    bookingSlotHelp.hidden = false;
    bookingSlotHelp.textContent = "Fill in service + address to load available slots.";
    bookingSlotResults.innerHTML = "";
    bookingSlotStart.value = "";
    bookingSubmit.disabled = true;
    return;
  }
  // Don't refetch if nothing meaningful changed.
  const key = `${serviceKey}|${address}`;
  if (key === bookingAvailLastKey && bookingSlotResults.children.length) return;
  bookingAvailLastKey = key;
  bookingSlotHelp.hidden = false;
  bookingSlotHelp.textContent = "Loading slots…";
  bookingSlotResults.innerHTML = "";
  bookingSlotStart.value = "";
  bookingSubmit.disabled = true;
  try {
    const url = `/api/booking/availability?service=${encodeURIComponent(serviceKey)}&address=${encodeURIComponent(address)}`;
    const r = await fetch(url);
    const data = await r.json();
    if (!data.ok) throw new Error((data.errors || ["Couldn't load slots."]).join(" "));
    renderSlotResults(data.days || []);
  } catch (err) {
    bookingSlotHelp.hidden = false;
    bookingSlotHelp.textContent = err.message || "Couldn't load slots.";
  }
}

// Bucket a day's slots into Morning / Midday / Afternoon / Evening.
// Returns the FIRST available slot per bucket so the time picker is
// max 4 buttons per day. Same logic as the reschedule + follow-up
// pickers — keep them in sync.
function condenseSlotsForDay(slots) {
  const buckets = [
    { key: "morning",   label: "Morning",   from: 8,  to: 11 },
    { key: "midday",    label: "Midday",    from: 11, to: 14 },
    { key: "afternoon", label: "Afternoon", from: 14, to: 17 },
    { key: "evening",   label: "Evening",   from: 17, to: 22 }
  ];
  return buckets
    .map((b) => ({
      ...b,
      slot: (slots || []).find((s) => {
        const h = new Date(s.start).getHours();
        return h >= b.from && h < b.to;
      })
    }))
    .filter((b) => b.slot);
}

// Date-first picker. Vertical list of date rows; tapping one expands
// its 4 time buckets inline below. Only one date open at a time.
// No drawers, no slides — single-panel inline expand.
function renderSlotResults(days) {
  bookingSlotResults.innerHTML = "";
  let totalDays = 0;
  days.forEach((day) => {
    if ((day.slots || []).length) totalDays++;
  });
  if (!totalDays) {
    bookingSlotHelp.hidden = true;
    const empty = document.createElement("p");
    empty.className = "booking-slot-empty";
    empty.textContent = "No available slots in the next 14 days. Try a different service or check the working-hours rules below.";
    bookingSlotResults.appendChild(empty);
    return;
  }
  bookingSlotHelp.hidden = true;
  days.forEach((day) => {
    const condensed = condenseSlotsForDay(day.slots);
    if (!condensed.length) return;
    const dateBtn = document.createElement("button");
    dateBtn.type = "button";
    dateBtn.className = "booking-slot-date";
    dateBtn.innerHTML = `
      <span class="booking-slot-date-label"></span>
      <span class="booking-slot-date-count"></span>
    `;
    dateBtn.querySelector(".booking-slot-date-label").textContent = day.label || day.date || "";
    dateBtn.querySelector(".booking-slot-date-count").textContent = `${condensed.length} time${condensed.length === 1 ? "" : "s"}`;
    const times = document.createElement("div");
    times.className = "booking-slot-times";
    times.hidden = true;
    condensed.forEach((b) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "booking-slot-btn";
      btn.dataset.slotStart = b.slot.start;
      const time = new Date(b.slot.start).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
      btn.innerHTML = `${time}<span class="booking-slot-bucket">${b.label}</span>`;
      btn.addEventListener("click", () => {
        bookingSlotResults.querySelectorAll(".booking-slot-btn.is-selected")
          .forEach((x) => x.classList.remove("is-selected"));
        btn.classList.add("is-selected");
        bookingSlotStart.value = b.slot.start;
        bookingSubmit.disabled = false;
      });
      times.appendChild(btn);
    });
    dateBtn.addEventListener("click", () => {
      bookingSlotResults.querySelectorAll(".booking-slot-date.is-open").forEach((d) => d.classList.remove("is-open"));
      bookingSlotResults.querySelectorAll(".booking-slot-times").forEach((t) => { t.hidden = true; });
      const wasOpen = dateBtn.dataset.open === "1";
      if (!wasOpen) {
        dateBtn.classList.add("is-open");
        times.hidden = false;
        dateBtn.dataset.open = "1";
      } else {
        dateBtn.dataset.open = "0";
      }
    });
    bookingSlotResults.appendChild(dateBtn);
    bookingSlotResults.appendChild(times);
  });
}

// ---- Submit ----------------------------------------------------
bookingForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  bookingError.hidden = true;
  bookingError.textContent = "";

  const firstName = bookingFirstName.value.trim();
  const lastName  = bookingLastName.value.trim();
  const phone     = bookingPhone.value.trim();
  const email     = bookingEmail.value.trim();
  const address   = bookingAddress.value.trim();
  const serviceKey = bookingService.value;
  const slotStart  = bookingSlotStart.value;

  // Pre-validate before hitting the server. Pairs each missing piece with a
  // human label and (for required form fields) the input element so we can
  // scroll + focus the first offender. Server's validateLead reads contact.name
  // (combined), not firstName/lastName — the missing field most often surfaces
  // there, so we map it back to "First name" for the user-visible message.
  const missing = [];
  if (!firstName)  missing.push({ label: "First name", el: bookingFirstName });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) missing.push({ label: "A valid email", el: bookingEmail });
  if (!phone)      missing.push({ label: "Phone",      el: bookingPhone });
  if (!address)    missing.push({ label: "Address",    el: bookingAddress });
  if (!serviceKey) missing.push({ label: "Service",    el: bookingService });
  if (!slotStart)  missing.push({ label: "Time slot",  el: null });

  if (missing.length) {
    bookingError.hidden = false;
    bookingError.textContent = `Missing: ${missing.map((m) => m.label).join(", ")}.`;
    const firstWithEl = missing.find((m) => m.el);
    if (firstWithEl) {
      firstWithEl.el.scrollIntoView({ behavior: "smooth", block: "center" });
      firstWithEl.el.focus({ preventScroll: true });
    }
    return;
  }

  // Server-side validateLead reads `contact.name` (combined). Public book.html
  // sends both the split fields AND `name` — we mirror that exactly so the
  // server's name check passes without a server change.
  const payload = {
    serviceKey,
    slotStart,
    contact: {
      firstName,
      lastName,
      name: `${firstName} ${lastName}`.trim(),
      phone,
      email,
      address,
      notes: bookingNotes.value.trim()
    },
    zoneCount: bookingZoneCount.value.trim() || null,
    pageUrl: location.href,
    userAgent: navigator.userAgent
  };
  bookingSubmit.disabled = true;
  bookingSubmit.textContent = "Booking…";
  try {
    const r = await fetch("/api/booking/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      throw new Error((data.errors || ["Booking failed."]).join(" "));
    }
    closeBookingDialog();
    await loadAll();
    // Friendly toast — leverage the existing settingsStatus span for now.
    if (settingsStatus) {
      settingsStatus.textContent = `Booked. WO ${data.workOrderId || ""}`.trim();
      setTimeout(() => { settingsStatus.textContent = ""; }, 5000);
    }
  } catch (err) {
    bookingError.hidden = false;
    bookingError.textContent = err.message || "Booking failed.";
    bookingSubmit.disabled = false;
  } finally {
    bookingSubmit.textContent = "Book customer";
  }
});

// HTML escape — needed by the property typeahead. Ported from the public
// site helper; kept local to avoid coupling with admin.js.
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

loadAll();
