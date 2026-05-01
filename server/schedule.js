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

    // Bookings on this day
    const dayBookings = bookings.filter((b) => sameDay(new Date(b.start), day));
    dayBookings.forEach((b) => {
      const card = document.createElement("div");
      card.className = "schedule-event schedule-booking";
      card.innerHTML = `
        <span class="event-time">${escapeHtml(fmtTime(b.start))} – ${escapeHtml(fmtTime(b.end))}</span>
        <strong>${escapeHtml(b.label)}</strong>
        <span>${escapeHtml(b.customer)}</span>
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

loadAll();
