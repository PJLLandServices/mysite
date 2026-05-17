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

// Google-Calendar-style schedule (Patrick's request). Day / Week / Month
// views share a single cursorDate and currentView state; the toolbar
// changes navigation behaviour to match (prev/next a day, week, or
// month). The mini-calendar in the sidebar always shows a single
// month's grid for quick jumping to any date.
const calToday = document.getElementById("calToday");
const calPrev = document.getElementById("calPrev");
const calNext = document.getElementById("calNext");
const calTitle = document.getElementById("calTitle");
const calCanvas = document.getElementById("calCanvas");
const calMini = document.getElementById("calMini");
const viewBtns = Array.from(document.querySelectorAll(".cal-view-btn"));
const addBlockBtn = document.getElementById("addBlock");
const blockList = document.getElementById("blockList");
const weekBookings = document.getElementById("weekBookings");
const weekBlockHours = document.getElementById("weekBlockHours");
const weekFreeHours = document.getElementById("weekFreeHours");
const blockDialog = document.getElementById("blockDialog");
const blockForm = document.getElementById("blockForm");
const blockLabel = document.getElementById("blockLabel");
const blockRangeHost = document.getElementById("blockRangeHost");
const blockSubmit = document.getElementById("blockSubmit");
const blockCancel = document.getElementById("blockCancel");
const blockError = document.getElementById("blockError");
const hoursGrid = document.getElementById("hoursGrid");
const settingLeadHours = document.getElementById("settingLeadHours");
const settingBuffer = document.getElementById("settingBuffer");
const settingIncrement = document.getElementById("settingIncrement");
const saveSettings = document.getElementById("saveSettings");
const settingsStatus = document.getElementById("settingsStatus");
const scheduleSettingsCollapse = document.querySelector(".schedule-settings-collapse");
const logoutButton = document.getElementById("logoutButton");

// settingsStatus doubles as the booking-success/delete toast (see
// `Booked. WO …` and `Booking … permanently deleted.` writes below).
// When the Working hours panel is collapsed those toasts would be
// invisible — auto-open the panel any time text lands in the status
// span so the user actually sees the feedback.
if (scheduleSettingsCollapse && settingsStatus) {
  new MutationObserver(() => {
    if (settingsStatus.textContent.trim()) scheduleSettingsCollapse.open = true;
  }).observe(settingsStatus, { childList: true, characterData: true, subtree: true });
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DOW_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

// Time-grid sizing. 1 px = 1 minute so the math in renderTimeGrid stays
// trivial. Day starts at 6 AM, ends at 10 PM; covers Patrick's working
// hours plus an hour of headroom either side for events that hang over.
const GRID_DAY_START_HOUR = 6;
const GRID_DAY_END_HOUR = 22;
const GRID_HOUR_HEIGHT_PX = 60;
const GRID_HOURS = GRID_DAY_END_HOUR - GRID_DAY_START_HOUR;
const GRID_TOTAL_HEIGHT_PX = GRID_HOURS * GRID_HOUR_HEIGHT_PX;

// Map serviceKey/family -> CSS class for the colour coding strip on
// each event card. Mirrors the FAMILY_SHORT_NAMES in ical-feed.js but
// scoped to the schedule UI.
function eventColorClass(serviceKey) {
  if (!serviceKey) return "";
  if (serviceKey.startsWith("spring_open"))   return "svc-spring";
  if (serviceKey.startsWith("fall_close"))    return "svc-fall";
  if (serviceKey === "sprinkler_repair")      return "svc-repair";
  if (serviceKey === "hydrawise_retrofit")    return "svc-install";
  if (serviceKey === "site_visit")            return "svc-consult";
  return "";
}

let cursorDate = startOfDay(new Date());      // anchor for the current view
// Default to Day on first load -- Patrick wants today's appointments
// front-and-center on every visit. Week + Month are still available
// via the toolbar switcher.
let currentView = "day";
let miniMonth = startOfMonth(new Date());     // mini-calendar's visible month
let blocks = [];
let bookings = [];
let defaults = { hours: {}, settings: {}, services: {} };
let overrides = { hours: {}, settings: {} };

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
function startOfMonth(date) {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}
function endOfMonth(date) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + 1, 0);
  d.setHours(23, 59, 59, 999);
  return d;
}
function isSameDate(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

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
      phone: l.contact?.phone || "",
      address: l.contact?.address || "",
      status: l.crm?.status,
      // serviceKey drives the color-coding class on the calendar event.
      serviceKey: l.booking.serviceKey || "",
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

// ---------------------------------------------------------------
// View dispatcher
// ---------------------------------------------------------------

function render() {
  calCanvas.dataset.activeView = currentView;
  viewBtns.forEach((b) => b.classList.toggle("is-active", b.dataset.view === currentView));
  updateTitle();
  renderMini();

  if (currentView === "day") renderDay();
  else if (currentView === "month") renderMonth();
  else renderWeek();

  renderBlockList();
  recomputeStats();
}

function updateTitle() {
  if (currentView === "day") {
    calTitle.textContent = cursorDate.toLocaleDateString("en-CA", {
      weekday: "long", month: "long", day: "numeric", year: "numeric"
    });
  } else if (currentView === "month") {
    calTitle.textContent = `${MONTH_NAMES[cursorDate.getMonth()]} ${cursorDate.getFullYear()}`;
  } else {
    const start = startOfWeek(cursorDate);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const sameYear = start.getFullYear() === end.getFullYear();
    if (sameMonth) {
      calTitle.textContent = `${MONTH_NAMES[start.getMonth()]} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`;
    } else if (sameYear) {
      calTitle.textContent = `${MONTH_NAMES[start.getMonth()]} ${start.getDate()} – ${MONTH_NAMES[end.getMonth()]} ${end.getDate()}, ${start.getFullYear()}`;
    } else {
      calTitle.textContent = `${MONTH_NAMES[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()} – ${MONTH_NAMES[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
    }
  }
}

// ---------------------------------------------------------------
// Day + Week views (shared time grid)
// ---------------------------------------------------------------

function renderDay() {
  const host = calCanvas.querySelector('[data-view="day"]');
  host.innerHTML = renderTimeGridShell([cursorDate]);
  layoutEvents(host, [cursorDate]);
  drawNowLine(host, [cursorDate]);
}

function renderWeek() {
  const host = calCanvas.querySelector('[data-view="week"]');
  const start = startOfWeek(cursorDate);
  const days = [];
  for (let i = 0; i < 7; i++) days.push(addDays(start, i));
  host.innerHTML = renderTimeGridShell(days);
  layoutEvents(host, days);
  drawNowLine(host, days);
}

// Build the static time-grid scaffolding for an array of Date objects
// (1 for Day view, 7 for Week). The CSS picks up --cal-day-cols /
// --cal-hours / --cal-hour-h to size the columns + rows.
function renderTimeGridShell(days) {
  const today = startOfDay(new Date());
  const dayColsTemplate = `repeat(${days.length}, 1fr)`;
  const headDays = days.map((d) => {
    const isToday = isSameDate(d, today);
    return `
      <div class="cal-tg-head-day${isToday ? " is-today" : ""}" data-date="${dateKey(d)}">
        <span class="dow">${DAY_NAMES[d.getDay()].slice(0, 3)}</span>
        <span class="num">${d.getDate()}</span>
      </div>`;
  }).join("");
  const hourLabels = [];
  for (let h = GRID_DAY_START_HOUR; h < GRID_DAY_END_HOUR; h++) {
    const label = h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`;
    hourLabels.push(`<div class="cal-tg-hour-label">${label}</div>`);
  }
  const dayCols = days.map((d) => {
    const hourCells = [];
    for (let h = 0; h < GRID_HOURS; h++) {
      hourCells.push(`<div class="cal-tg-day-hour" data-hour="${GRID_DAY_START_HOUR + h}"></div>`);
    }
    return `<div class="cal-tg-day" data-date="${dateKey(d)}">${hourCells.join("")}</div>`;
  }).join("");

  return `
    <div class="cal-tg-head" style="--cal-day-cols: ${dayColsTemplate};">
      <div class="cal-tg-head-spacer"></div>
      <div class="cal-tg-head-days" style="--cal-day-cols: ${dayColsTemplate};">${headDays}</div>
    </div>
    <div class="cal-tg-body" style="--cal-hour-h: ${GRID_HOUR_HEIGHT_PX}px; --cal-hours: ${GRID_HOURS}; --cal-grid-height: ${GRID_TOTAL_HEIGHT_PX}px;">
      <div class="cal-tg-hours">${hourLabels.join("")}</div>
      <div class="cal-tg-days" style="--cal-day-cols: ${dayColsTemplate};">${dayCols}</div>
    </div>
  `;
}

// Drop events + admin blocks into the rendered grid. Positioning is by
// CSS top/height in px (1 px = 1 minute). Bookings whose time falls
// outside the GRID_DAY_START_HOUR..GRID_DAY_END_HOUR window are clipped.
function layoutEvents(host, days) {
  const dayCols = host.querySelectorAll(".cal-tg-day");
  const dayByKey = new Map();
  dayCols.forEach((c) => dayByKey.set(c.dataset.date, c));

  // Admin blocks first (render BEHIND events).
  for (const block of blocks) {
    const bStart = new Date(block.start);
    const bEnd = new Date(block.end);
    for (const day of days) {
      const dayStart = startOfDay(day);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      if (bEnd <= dayStart || bStart >= dayEnd) continue;
      const lo = new Date(Math.max(bStart, dayStart));
      const hi = new Date(Math.min(bEnd, dayEnd));
      const { top, height } = clipToGrid(lo, hi, day);
      if (height <= 0) continue;
      const col = dayByKey.get(dateKey(day));
      if (!col) continue;
      const div = document.createElement("div");
      div.className = "cal-tg-block";
      div.style.top = `${top}px`;
      div.style.height = `${height}px`;
      div.textContent = block.label || "Blocked";
      col.appendChild(div);
    }
  }

  // Bookings.
  for (const b of bookings) {
    const start = new Date(b.start);
    const end = new Date(b.end);
    for (const day of days) {
      if (!isSameDate(start, day)) continue;
      const { top, height } = clipToGrid(start, end, day);
      if (height <= 0) continue;
      const col = dayByKey.get(dateKey(day));
      if (!col) continue;
      const isCancelled = b.bookingStatus === "cancelled";
      const colorClass = eventColorClass(b.serviceKey);
      // <div role="button"> instead of a real <button> so we can legally
      // nest the <a href="tel:..."> tap-to-call link inside. Keyboard
      // users still get Enter/Space activation via the listener below.
      const evtEl = document.createElement("div");
      evtEl.setAttribute("role", "button");
      evtEl.setAttribute("tabindex", "0");
      evtEl.className = `cal-event${isCancelled ? " is-cancelled" : ""}${colorClass ? " " + colorClass : ""}`;
      evtEl.style.top = `${top}px`;
      // Bumped the minimum height from 22 to 84 so the 4 lines of detail
      // (service / customer / address / phone) all fit even on the
      // tightest 45-min bucket slot.
      evtEl.style.height = `${Math.max(height, 84)}px`;
      evtEl.dataset.leadId = b.id;
      evtEl.dataset.start = b.start;
      evtEl.dataset.bookingStatus = b.bookingStatus;
      evtEl.title = isCancelled
        ? "Cancelled — tap for details"
        : "Tap to manage this appointment";
      const timeStr = `${fmtTime(b.start)} – ${fmtTime(b.end)}`;
      const shortAddr = shortAddress(b.address);
      const phoneTel = b.phone ? telHref(b.phone) : "";
      // Phone is rendered as a real <a tel:> so iOS hands the tap off
      // to the dialer. event.stopPropagation on the link keeps the
      // outer "open action panel" click from also firing.
      const phoneHtml = phoneTel
        ? `<a class="cal-event-phone" href="${escapeHtml(phoneTel)}" onclick="event.stopPropagation()">${escapeHtml(b.phone)}</a>`
        : "";
      evtEl.innerHTML = `
        <strong class="cal-event-svc">${escapeHtml(b.label)}</strong>
        <span class="cal-event-customer">${escapeHtml(b.customer)}</span>
        ${shortAddr ? `<span class="cal-event-addr">${escapeHtml(shortAddr)}</span>` : ""}
        ${phoneHtml}
        <span class="cal-event-time">${escapeHtml(timeStr)}</span>
      `;
      col.appendChild(evtEl);
    }
  }
}

// Trim a PJL address blob down to "street, town" for the calendar card
// display. Server-side ical-feed has the same idea but we duplicate
// the parser here so we don't have to round-trip.
function shortAddress(addr) {
  if (!addr) return "";
  const segments = String(addr).split(/[\n,]+/).map((p) => p.trim()).filter(Boolean);
  if (!segments.length) return "";
  const street = segments[0];
  let town = segments[1] || "";
  // Strip "ON L4A 1A1" tail from the town segment if it's glued in.
  town = town.replace(/\s+ON\b.*$/i, "").trim();
  return [street, town].filter(Boolean).join(", ");
}

// Build a tel: URI that iOS Safari recognizes. Strips formatting so
// "(905) 960-0181" becomes "tel:+19059600181" -- iPhone's dialer
// handles both, but the +1 form is the most portable.
function telHref(phone) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  // North American 10-digit number? Prefix +1. Leave already-+ numbers alone.
  if (digits.length === 10) return `tel:+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `tel:+${digits}`;
  return `tel:${digits}`;
}

// Clip a [start, end] interval to the grid's hour window for a given day.
// Returns top + height in px, with negatives zero'd out.
function clipToGrid(start, end, day) {
  const gridStart = setHHmm(day, `${String(GRID_DAY_START_HOUR).padStart(2, "0")}:00`);
  const gridEnd = setHHmm(day, `${String(GRID_DAY_END_HOUR).padStart(2, "0")}:00`);
  const lo = new Date(Math.max(start, gridStart));
  const hi = new Date(Math.min(end, gridEnd));
  const top = Math.max(0, (lo - gridStart) / 60000);
  const height = Math.max(0, (hi - lo) / 60000);
  return { top, height };
}

function drawNowLine(host, days) {
  const now = new Date();
  const today = startOfDay(now);
  const targetIdx = days.findIndex((d) => isSameDate(d, today));
  if (targetIdx === -1) return;
  if (now.getHours() < GRID_DAY_START_HOUR || now.getHours() >= GRID_DAY_END_HOUR) return;
  const col = host.querySelectorAll(".cal-tg-day")[targetIdx];
  if (!col) return;
  const gridStart = setHHmm(today, `${String(GRID_DAY_START_HOUR).padStart(2, "0")}:00`);
  const top = Math.max(0, (now - gridStart) / 60000);
  const line = document.createElement("div");
  line.className = "cal-tg-now-line";
  line.style.top = `${top}px`;
  col.appendChild(line);
}

// ---------------------------------------------------------------
// Month view
// ---------------------------------------------------------------

function renderMonth() {
  const host = calCanvas.querySelector('[data-view="month"]');
  const first = startOfMonth(cursorDate);
  const startOffset = first.getDay();
  const gridStart = addDays(first, -startOffset);
  const today = startOfDay(new Date());

  const weekdays = DOW_LETTERS.map((l) => `<span>${l}</span>`).join("");
  const rows = [];
  for (let r = 0; r < 6; r++) {
    const cells = [];
    for (let c = 0; c < 7; c++) {
      const cellDate = addDays(gridStart, r * 7 + c);
      const inThisMonth = cellDate.getMonth() === first.getMonth();
      const isToday = isSameDate(cellDate, today);
      const dayBookings = bookings.filter((b) => isSameDate(new Date(b.start), cellDate));
      const eventPills = dayBookings.slice(0, 3).map((b) => {
        const isCancelled = b.bookingStatus === "cancelled";
        const colorClass = eventColorClass(b.serviceKey);
        return `<button type="button" class="cal-month-event${isCancelled ? " is-cancelled" : ""}${colorClass ? " " + colorClass : ""}"
          data-lead-id="${escapeHtml(b.id)}" data-start="${escapeHtml(b.start)}" data-booking-status="${escapeHtml(b.bookingStatus)}"
          title="${escapeHtml(b.label)} — ${escapeHtml(b.customer)}">${escapeHtml(fmtTime(b.start))} ${escapeHtml(b.label)}</button>`;
      }).join("");
      const more = dayBookings.length > 3
        ? `<span class="cal-month-more">+${dayBookings.length - 3} more</span>`
        : "";
      cells.push(`
        <div class="cal-month-cell${inThisMonth ? "" : " is-other-month"}${isToday ? " is-today" : ""}" data-date="${dateKey(cellDate)}">
          <span class="cal-month-cell-num">${cellDate.getDate()}</span>
          ${eventPills}
          ${more}
        </div>
      `);
    }
    rows.push(`<div class="cal-month-row">${cells.join("")}</div>`);
  }

  host.innerHTML = `
    <div class="cal-month" style="--cal-month-h: 720px;">
      <div class="cal-month-weekdays">${weekdays}</div>
      ${rows.join("")}
    </div>
  `;
}

// ---------------------------------------------------------------
// Sidebar: mini-calendar + stats + block list
// ---------------------------------------------------------------

function renderMini() {
  const first = startOfMonth(miniMonth);
  const startOffset = first.getDay();
  const gridStart = addDays(first, -startOffset);
  const today = startOfDay(new Date());

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const cellDate = addDays(gridStart, i);
    const inThisMonth = cellDate.getMonth() === first.getMonth();
    const isToday = isSameDate(cellDate, today);
    const isSelected = isSameDate(cellDate, cursorDate);
    const cls = [
      inThisMonth ? "" : "is-other-month",
      isToday ? "is-today" : "",
      isSelected ? "is-selected" : ""
    ].filter(Boolean).join(" ");
    cells.push(`<button type="button" class="${cls}" data-date="${dateKey(cellDate)}">${cellDate.getDate()}</button>`);
  }

  calMini.innerHTML = `
    <div class="cal-mini-header">
      <button type="button" class="cal-mini-nav" data-mini-prev aria-label="Previous month">‹</button>
      <span class="cal-mini-month">${MONTH_NAMES[first.getMonth()]} ${first.getFullYear()}</span>
      <button type="button" class="cal-mini-nav" data-mini-next aria-label="Next month">›</button>
    </div>
    <div class="cal-mini-weekdays">${DOW_LETTERS.map((l) => `<span>${l}</span>`).join("")}</div>
    <div class="cal-mini-grid">${cells.join("")}</div>
  `;
}

function recomputeStats() {
  // Stats track the visible period (day / week / month). Cancelled
  // bookings are excluded from the booked-hours total because they
  // aren't real work; they remain visible on the canvas though.
  const hours = effectiveHours();
  let periodStart, periodEnd;
  if (currentView === "day") {
    periodStart = startOfDay(cursorDate);
    periodEnd = new Date(periodStart.getTime() + 86400000);
  } else if (currentView === "month") {
    periodStart = startOfMonth(cursorDate);
    periodEnd = new Date(endOfMonth(cursorDate).getTime() + 1);
  } else {
    periodStart = startOfWeek(cursorDate);
    periodEnd = addDays(periodStart, 7);
  }

  let booked = 0, blocked = 0, bookable = 0;
  // bookable hours: sum of working windows that fall inside the period.
  let cursor = new Date(periodStart);
  while (cursor < periodEnd) {
    const window = hours[cursor.getDay()];
    if (window) {
      const openMs = setHHmm(cursor, window.open).getTime();
      const closeMs = setHHmm(cursor, window.close).getTime();
      bookable += Math.max(0, closeMs - openMs);
    }
    cursor = addDays(cursor, 1);
  }
  for (const b of bookings) {
    if (b.bookingStatus === "cancelled") continue;
    const s = new Date(b.start).getTime();
    if (s < periodStart.getTime() || s >= periodEnd.getTime()) continue;
    booked += new Date(b.end) - new Date(b.start);
  }
  for (const blk of blocks) {
    const s = Math.max(new Date(blk.start), periodStart);
    const e = Math.min(new Date(blk.end), periodEnd);
    if (e > s) blocked += e - s;
  }
  const confirmedCount = bookings.filter((b) => {
    if (b.bookingStatus === "cancelled") return false;
    const s = new Date(b.start).getTime();
    return s >= periodStart.getTime() && s < periodEnd.getTime();
  }).length;
  weekBookings.textContent = confirmedCount;
  weekBlockHours.textContent = (blocked / 3_600_000).toFixed(1);
  weekFreeHours.textContent = Math.max(0, (bookable - booked - blocked) / 3_600_000).toFixed(1);
}

function renderBlockList() {
  if (!blocks.length) {
    blockList.innerHTML = `<li class="empty">No blocked time.</li>`;
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
      <button type="button" data-block-id="${escapeHtml(b.id)}" aria-label="Remove">×</button>
    `;
    blockList.append(li);
  });
}

// Local YYYY-MM-DD key for indexing into the day-column map.
function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

// ---------------------------------------------------------------
// Navigation: Today / prev / next adapt to the current view.
// Prev/next step by 1 day / 7 days / 1 month depending on currentView.
// ---------------------------------------------------------------
calToday.addEventListener("click", () => {
  cursorDate = startOfDay(new Date());
  miniMonth = startOfMonth(cursorDate);
  render();
});
calPrev.addEventListener("click", () => {
  if (currentView === "day") cursorDate = addDays(cursorDate, -1);
  else if (currentView === "month") cursorDate = addMonths(cursorDate, -1);
  else cursorDate = addDays(cursorDate, -7);
  miniMonth = startOfMonth(cursorDate);
  render();
});
calNext.addEventListener("click", () => {
  if (currentView === "day") cursorDate = addDays(cursorDate, 1);
  else if (currentView === "month") cursorDate = addMonths(cursorDate, 1);
  else cursorDate = addDays(cursorDate, 7);
  miniMonth = startOfMonth(cursorDate);
  render();
});

// View switcher.
viewBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const v = btn.dataset.view;
    if (v !== "day" && v !== "week" && v !== "month") return;
    currentView = v;
    render();
  });
});

// Mini-calendar interactions: prev/next month buttons, click a date
// to jump the main view to it.
calMini.addEventListener("click", (event) => {
  if (event.target.closest("[data-mini-prev]")) {
    miniMonth = addMonths(miniMonth, -1);
    renderMini();
    return;
  }
  if (event.target.closest("[data-mini-next]")) {
    miniMonth = addMonths(miniMonth, 1);
    renderMini();
    return;
  }
  const cell = event.target.closest("[data-date]");
  if (!cell) return;
  const [y, m, d] = cell.dataset.date.split("-").map(Number);
  cursorDate = new Date(y, m - 1, d);
  render();
});

function addMonths(date, delta) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + delta);
  return d;
}

// Delegated click for booking events on the calendar canvas. Catches
// both the time-grid .cal-event blocks (day/week) and the
// .cal-month-event pills (month). The tel: phone link inside an event
// stops propagation itself so iOS hands the tap to the dialer instead
// of opening the action panel.
calCanvas.addEventListener("click", (event) => {
  if (event.target.closest(".cal-event-phone")) return;
  const evtEl = event.target.closest(".cal-event, .cal-month-event");
  if (!evtEl) return;
  const leadId = evtEl.dataset.leadId;
  const start = evtEl.dataset.start;
  if (!leadId) return;
  openBookingActionPanel({
    leadId,
    scheduledFor: start || undefined,
    bookingStatus: evtEl.dataset.bookingStatus || "confirmed"
  });
});

// Keyboard activation for the event cards (they're div role="button" so
// they don't get the native button keyboard handling for free).
calCanvas.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const evtEl = event.target.closest(".cal-event");
  if (!evtEl) return;
  // Don't trap Space/Enter when focus is on the inner tel: link.
  if (event.target.closest(".cal-event-phone")) return;
  event.preventDefault();
  evtEl.click();
});

// Range picker drives the Block-off-time dialog. blockRange holds the
// most recent {start, end} from the picker so the form submit doesn't
// have to re-read the DOM. Submit stays disabled until both endpoints
// are picked.
let blockRange = { start: null, end: null };
let blockPickerDestroy = null;

function startOfDay(d) {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}
function endOfDay(d) {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}

addBlockBtn.addEventListener("click", () => {
  blockLabel.value = "";
  blockRange = { start: null, end: null };
  blockError.hidden = true;
  blockSubmit.disabled = true;
  // Re-mount the range picker fresh each open so the previous state
  // doesn't leak into a new block. mountDateRangePicker is idempotent
  // but we also clear blockRange above for safety.
  if (typeof blockPickerDestroy === "function") {
    try { blockPickerDestroy(); } catch (_) {}
    blockPickerDestroy = null;
  }
  if (typeof window.mountDateRangePicker === "function") {
    blockPickerDestroy = window.mountDateRangePicker(blockRangeHost, {
      allowPast: false,
      onChange: ({ start, end }) => {
        blockRange = { start, end };
        // Enable submit only once the full range is set.
        blockSubmit.disabled = !(start && end);
      }
    });
  } else {
    blockRangeHost.innerHTML = `<p class="dialog-error">Range picker failed to load. Refresh the page.</p>`;
  }
  if (typeof blockDialog.showModal === "function") blockDialog.showModal();
  else blockDialog.setAttribute("open", "");
});

blockCancel.addEventListener("click", () => blockDialog.close());

blockForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  blockError.hidden = true;
  if (!blockRange.start || !blockRange.end) {
    blockError.textContent = "Pick a date range first.";
    blockError.hidden = false;
    return;
  }
  if (!blockLabel.value.trim()) {
    blockError.textContent = "Add a label (vacation, holiday, etc.).";
    blockError.hidden = false;
    blockLabel.focus();
    return;
  }
  // Full-day block: from 00:00 of the first selected day to 23:59:59
  // of the last selected day. The availability engine's rangeOverlaps
  // check treats any overlap with this range as blocked, so every slot
  // inside the picked range is removed from /api/booking/availability.
  const startIso = startOfDay(blockRange.start).toISOString();
  const endIso = endOfDay(blockRange.end).toISOString();
  blockSubmit.disabled = true;
  try {
    const response = await fetch("/api/schedule/blocks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: blockLabel.value.trim(),
        start: startIso,
        end: endIso
      })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Couldn't save block."]).join(" "));
    blockDialog.close();
    if (typeof blockPickerDestroy === "function") { try { blockPickerDestroy(); } catch (_) {} blockPickerDestroy = null; }
    await loadAll();
  } catch (err) {
    blockError.textContent = err.message;
    blockError.hidden = false;
    blockSubmit.disabled = false;
  }
});

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
  bookingSlotSource = "slot";
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
// Tracks whether the currently-picked time came from a bucket slot or
// from the admin "Custom time" override (admin_custom). Sent with the
// booking-reserve POST so the server can skip its slot-availability
// match for custom times -- those are explicitly outside the grid.
let bookingSlotSource = "slot";

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
    onSelect: (iso, slotMeta) => {
      bookingSlotStart.value = iso;
      bookingSlotSource = (slotMeta && slotMeta.source === "admin_custom") ? "admin_custom" : "slot";
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
    source: bookingSlotSource,  // "admin_custom" bypasses slot-availability check (admin-gated server-side)
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
