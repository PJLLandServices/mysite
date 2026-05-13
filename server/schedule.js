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
      status: l.crm?.status,
      // Mirror from lead.booking — the cancel route writes status here so
      // legacy CRM/portal consumers see the cancellation without rewiring.
      bookingStatus: l.booking.status || "confirmed",
      cancelledAt: l.booking.cancelledAt || null
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
      const isCancelled = b.bookingStatus === "cancelled";
      const card = document.createElement("button");
      card.type = "button";
      card.className = "schedule-event schedule-booking" + (isCancelled ? " is-cancelled" : "");
      card.title = isCancelled
        ? "Cancelled — click for details / delete"
        : "Click to manage this appointment";
      card.dataset.leadId = b.id;
      card.dataset.start = b.start;
      card.dataset.bookingStatus = b.bookingStatus;
      card.innerHTML = `
        <span class="event-time">${escapeHtml(fmtTime(b.start))} – ${escapeHtml(fmtTime(b.end))}</span>
        <strong>${escapeHtml(b.label)}</strong>
        <span>${escapeHtml(b.customer)}</span>
        ${isCancelled
          ? `<span class="event-cancelled-pill">Cancelled</span>`
          : `<span class="event-reschedule-hint">📅 Manage</span>`}
      `;
      dayCol.append(card);
      // Cancelled bookings don't consume booked-hours on the totals strip.
      if (!isCancelled) totalBookedMs += new Date(b.end) - new Date(b.start);
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

  // Week-total badge: count CONFIRMED bookings only. Cancelled bookings
  // remain on the canvas (greyed) but don't contribute to the headline
  // "N bookings this week" number — they're not real work for Patrick.
  weekBookings.textContent = bookings.filter((b) => {
    if (b.bookingStatus === "cancelled") return false;
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
// click ALWAYS fires regardless of when the cards were rendered.
//
// Click no longer goes straight to reschedule — instead it opens the
// action panel (Reschedule / Cancel / Delete) so Patrick can pick the
// right branch per Brief B §3.3.
scheduleWeek.addEventListener("click", (event) => {
  const card = event.target.closest(".schedule-booking");
  if (!card) return;
  const leadId = card.dataset.leadId;
  const start = card.dataset.start;
  if (!leadId) return;
  openBookingActionPanel({
    leadId,
    scheduledFor: start || undefined,
    bookingStatus: card.dataset.bookingStatus || "confirmed"
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
  if (typeof bookingPickerDestroy === "function") {
    try { bookingPickerDestroy(); } catch (_) {}
    bookingPickerDestroy = null;
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

let bookingPickerDestroy = null;

// Mount (or re-mount) the shared month-calendar picker into the +Book
// modal's slot host. The loader closes over the current form inputs and
// rebuilds the URL each fetch — so any change to service / address that
// triggers scheduleAvailLookup() ends up calling mountTimePicker again
// with the same host, and the picker re-renders against the new query.
function loadAvailability() {
  const serviceKey = bookingService.value;
  const address = bookingAddress.value.trim();
  if (!serviceKey || !address) {
    bookingSlotHelp.hidden = false;
    bookingSlotHelp.textContent = "Fill in service + address to load available slots.";
    bookingSlotResults.innerHTML = "";
    bookingSlotStart.value = "";
    bookingSubmit.disabled = true;
    if (typeof bookingPickerDestroy === "function") {
      try { bookingPickerDestroy(); } catch (_) {}
      bookingPickerDestroy = null;
    }
    return;
  }
  const key = `${serviceKey}|${address}`;
  if (key === bookingAvailLastKey && bookingPickerDestroy) return;
  bookingAvailLastKey = key;
  bookingSlotHelp.hidden = true;
  bookingSlotStart.value = "";
  bookingSubmit.disabled = true;
  if (typeof window.mountTimePicker !== "function") {
    bookingSlotHelp.hidden = false;
    bookingSlotHelp.textContent = "Time picker failed to load. Refresh the page and try again.";
    return;
  }
  bookingPickerDestroy = window.mountTimePicker(bookingSlotResults, {
    mode: "admin",
    allowCustomTime: true,
    loadAvailability: async ({ from, to }) => {
      const url = `/api/booking/availability`
        + `?service=${encodeURIComponent(serviceKey)}`
        + `&address=${encodeURIComponent(address)}`
        + `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const r = await fetch(url, { cache: "no-store" });
      const data = await r.json();
      if (!data.ok) throw new Error((data.errors || ["Couldn't load slots."]).join(" "));
      return { days: data.days || [] };
    },
    onSelect: (iso) => {
      bookingSlotStart.value = iso;
      bookingSubmit.disabled = false;
    }
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

// ---------------------------------------------------------------
// Booking action panel — opens when a card on the canvas is clicked.
// Branches to Reschedule (shared crm-reschedule modal), Cancel (new
// modal with reason + notify), or Delete (admin-only, hard delete).
// ---------------------------------------------------------------

const actionDialog          = document.getElementById("bookingActionDialog");
const actionClose           = document.getElementById("bookingActionClose");
const actionSummary         = document.getElementById("bookingActionSummary");
const actionRescheduleBtn   = document.getElementById("bookingActionReschedule");
const actionCancelBtn       = document.getElementById("bookingActionCancel");
const actionDeleteBtn       = document.getElementById("bookingActionDelete");
const actionStatus          = document.getElementById("bookingActionStatus");

const cancelDialog          = document.getElementById("cancelBookingDialog");
const cancelClose           = document.getElementById("cancelBookingClose");
const cancelBack            = document.getElementById("cancelBookingBack");
const cancelForm            = document.getElementById("cancelBookingForm");
const cancelReason          = document.getElementById("cancelBookingReason");
const cancelNotify          = document.getElementById("cancelBookingNotify");
const cancelSummary         = document.getElementById("cancelBookingSummary");
const cancelSubmit          = document.getElementById("cancelBookingSubmit");
const cancelError           = document.getElementById("cancelBookingError");

// Delete uses a native browser confirm() — no HTML modal — so there's
// no DOM to wire up here. The handler lives inline on actionDeleteBtn.

// Pending action context — the leadId + resolved bookingId + the
// summary fields are stashed here so the Cancel + Delete dialogs can
// be opened from the action panel and read the same record without a
// second lookup.
let pendingAction = null; // { leadId, scheduledFor, bookingId, summary, bookingStatus }

// Admin role gate. Hide the Delete button entirely for tech users so
// the visible affordance matches their permissions. The server still
// enforces requireAdmin on DELETE — this is just to avoid showing a
// button that would 403.
let viewerRole = null;
(async function detectRole() {
  try {
    const r = await fetch("/api/session", { cache: "no-store" });
    const data = await r.json();
    // /api/session returns { ok, authenticated, role, user } — role is
    // top-level. Default null = "not admin", so Delete stays hidden.
    if (data && data.ok && data.authenticated) viewerRole = data.role || null;
  } catch (_) { /* leave null; Delete stays hidden by default */ }
})();

function showDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}
function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function summaryHtml({ label, customer, address, scheduledFor, status }) {
  const when = scheduledFor
    ? new Date(scheduledFor).toLocaleString("en-CA", {
        weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit"
      })
    : "—";
  const statusRow = status === "cancelled"
    ? `<dt>Status</dt><dd><strong style="color:#7A7A72;">Cancelled</strong></dd>`
    : "";
  return `
    <dt>Service</dt><dd>${escapeHtml(label || "Booking")}</dd>
    <dt>Customer</dt><dd>${escapeHtml(customer || "—")}</dd>
    <dt>Address</dt><dd>${escapeHtml(address || "—")}</dd>
    <dt>When</dt><dd>${escapeHtml(when)}</dd>
    ${statusRow}
  `;
}

async function resolveBookingByLead(leadId, scheduledFor) {
  // Same lookup the reschedule modal uses — match exact start time when
  // we have it (a lead may have a follow-up plus an original booking).
  // Returns the booking record, or null if none exists yet.
  const r = await fetch(`/api/bookings?leadId=${encodeURIComponent(leadId)}`);
  const data = await r.json();
  if (!data.ok || !Array.isArray(data.bookings) || !data.bookings.length) return null;
  if (scheduledFor) {
    const exact = data.bookings.find((b) => b.scheduledFor === scheduledFor);
    if (exact) return exact;
  }
  return data.bookings[0];
}

async function openBookingActionPanel({ leadId, scheduledFor, bookingStatus }) {
  if (!leadId) return;
  // Find the matching booking row from the cached canvas state so we can
  // populate the summary instantly (the canonical record fetch happens
  // in the background and updates pendingAction.bookingId before the
  // user reaches the Cancel/Delete flows).
  const localMatch = bookings.find((b) => b.id === leadId && (!scheduledFor || b.start === scheduledFor));
  const summary = localMatch
    ? { label: localMatch.label, customer: localMatch.customer, address: localMatch.address, scheduledFor: localMatch.start, status: localMatch.bookingStatus }
    : { label: "Booking", customer: "", address: "", scheduledFor };
  pendingAction = { leadId, scheduledFor, bookingId: null, summary, bookingStatus: bookingStatus || "confirmed" };
  actionSummary.innerHTML = summaryHtml(summary);
  actionStatus.textContent = "";
  // Reschedule + Cancel are meaningless on an already-cancelled booking
  // — hide both, leaving only Delete (admin) on the panel.
  const cancelled = pendingAction.bookingStatus === "cancelled";
  actionRescheduleBtn.hidden = cancelled;
  actionCancelBtn.hidden = cancelled;
  actionDeleteBtn.hidden = viewerRole !== "admin";
  showDialog(actionDialog);
  // Resolve the canonical bookingId in the background — the user can
  // click Reschedule (which calls openCrmReschedule by leadId anyway)
  // or wait briefly for Cancel/Delete to enable.
  resolveBookingByLead(leadId, scheduledFor).then((rec) => {
    if (!rec) return;
    if (pendingAction && pendingAction.leadId === leadId) {
      pendingAction.bookingId = rec.id;
    }
  }).catch(() => {});
}

actionClose?.addEventListener("click", () => closeDialog(actionDialog));
actionRescheduleBtn?.addEventListener("click", () => {
  if (!pendingAction || typeof window.openCrmReschedule !== "function") return;
  const { leadId, scheduledFor } = pendingAction;
  closeDialog(actionDialog);
  window.openCrmReschedule({
    leadId,
    scheduledFor: scheduledFor || undefined,
    onDone: () => loadAll().catch(() => {})
  });
});

actionCancelBtn?.addEventListener("click", async () => {
  if (!pendingAction) return;
  if (!pendingAction.bookingId) {
    actionStatus.textContent = "Resolving booking…";
    pendingAction.bookingId = (await resolveBookingByLead(pendingAction.leadId, pendingAction.scheduledFor))?.id || null;
    actionStatus.textContent = "";
  }
  if (!pendingAction.bookingId) {
    actionStatus.textContent = "Couldn't find the booking record — refresh and try again.";
    return;
  }
  closeDialog(actionDialog);
  cancelSummary.innerHTML = summaryHtml(pendingAction.summary);
  cancelReason.value = "";
  cancelNotify.checked = true;
  cancelError.hidden = true;
  cancelSubmit.disabled = false;
  cancelSubmit.textContent = "Cancel booking";
  showDialog(cancelDialog);
});

// Hard delete uses a native confirm() — bulletproof + Patrick's
// preferred level of friction. No HTML dialog to fail-to-wire-up.
actionDeleteBtn?.addEventListener("click", async () => {
  if (!pendingAction) return;
  if (!pendingAction.bookingId) {
    actionStatus.textContent = "Resolving booking…";
    pendingAction.bookingId = (await resolveBookingByLead(pendingAction.leadId, pendingAction.scheduledFor))?.id || null;
    actionStatus.textContent = "";
  }
  if (!pendingAction.bookingId) {
    actionStatus.textContent = "Couldn't find the booking record — refresh and try again.";
    return;
  }
  const { summary, bookingId } = pendingAction;
  const lines = [
    `Permanently delete this booking? There is no undo.`,
    ``,
    `${summary.label || "Booking"}`,
    `${summary.customer || ""}`,
    `${summary.address || ""}`,
    summary.scheduledFor
      ? new Date(summary.scheduledFor).toLocaleString("en-CA", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })
      : ""
  ].filter(Boolean).join("\n");
  if (!window.confirm(lines)) return;
  try {
    const r = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}`, { method: "DELETE" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      const msg = (data.errors || ["Couldn't delete."]).join(" ");
      const tail = data.linkedWoId ? ` (Linked: ${data.linkedWoId})` : "";
      throw new Error(msg + tail);
    }
    closeDialog(actionDialog);
    settingsStatus.textContent = `Booking ${bookingId} permanently deleted.`;
    setTimeout(() => { settingsStatus.textContent = ""; }, 6000);
    await loadAll();
  } catch (err) {
    // Surface inside the action panel — it's still open at this point.
    actionStatus.textContent = err.message || "Couldn't delete.";
  }
});

cancelClose?.addEventListener("click", () => closeDialog(cancelDialog));
cancelBack?.addEventListener("click", () => closeDialog(cancelDialog));

cancelForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pendingAction?.bookingId) return;
  const reason = cancelReason.value.trim();
  if (!reason) {
    cancelError.hidden = false;
    cancelError.textContent = "Reason is required.";
    cancelReason.focus();
    return;
  }
  cancelError.hidden = true;
  cancelSubmit.disabled = true;
  cancelSubmit.textContent = "Cancelling…";
  try {
    const r = await fetch(`/api/bookings/${encodeURIComponent(pendingAction.bookingId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason,
        notifyCustomer: cancelNotify.checked
      })
    });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      throw new Error((data.errors || ["Couldn't cancel."]).join(" "));
    }
    closeDialog(cancelDialog);
    // Surface email-send failure as a toast so Patrick knows the cancel
    // committed but the customer didn't get the email. The cancel itself
    // is already in the books — this is just a heads-up to follow up.
    if (data.notify && data.notify.ok === false && !data.notify.skipped) {
      settingsStatus.textContent = "Booking cancelled. Customer email failed — retry from settings if needed.";
    } else if (data.notify && data.notify.skipped) {
      settingsStatus.textContent = "Booking cancelled. (Customer not notified per checkbox.)";
    } else {
      settingsStatus.textContent = "Booking cancelled. Customer notified.";
    }
    setTimeout(() => { settingsStatus.textContent = ""; }, 6000);
    await loadAll();
  } catch (err) {
    cancelError.hidden = false;
    cancelError.textContent = err.message || "Couldn't cancel.";
    cancelSubmit.disabled = false;
    cancelSubmit.textContent = "Cancel booking";
  }
});

// (Delete is handled inline on actionDeleteBtn above via native confirm().)

loadAll();
