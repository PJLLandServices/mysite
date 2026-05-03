// Today's Schedule — the tech's morning hub. Fetches today's bookings
// from /api/schedule/today, renders one big tap-friendly card per row,
// and wires three actions: Navigate (deep-links to Maps), Notify on
// route (POST /api/leads/:id/notify-on-route), Open WO (POST
// /api/leads/:id/open-wo → redirect to the field WO tech-mode page).

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

const todayHeadline = document.getElementById("todayHeadline");
const todaySubline = document.getElementById("todaySubline");
const datePicker = document.getElementById("datePicker");
const todayList = document.getElementById("todayList");
const todayLoading = document.getElementById("todayLoading");
const todayError = document.getElementById("todayError");
const todayEmpty = document.getElementById("todayEmpty");
const logoutButton = document.getElementById("logoutButton");

// Type label vocabulary, mirrors server/lib/work-orders.js TEMPLATES.
const TYPE_LABELS = {
  spring_opening: "Spring Opening",
  fall_closing: "Fall Closing",
  service_visit: "Service Visit"
};

let bookingsCache = [];

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Convert an ISO datetime to today's local date in YYYY-MM-DD format.
// The server sets process.env.TZ = America/Toronto so server-rendered
// dates already match this; here we just need the raw local date.
function todayDateString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function prettyDate(yyyymmdd) {
  if (!yyyymmdd) return "";
  // Parse as local date, not UTC, so "2026-05-01" doesn't shift
  // backward when rendered in earlier timezones.
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", {
    weekday: "long", month: "long", day: "numeric"
  });
}

function prettyShortDate(yyyymmdd) {
  if (!yyyymmdd) return "";
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", {
    month: "short", day: "numeric"
  });
}

function navigateUrl(booking) {
  // Universal Maps deep-link. Google Maps URL works on iOS (offers Apple
  // Maps via "Open in Maps" prompt) and Android natively. If we have
  // coords, prefer them — the address geocode might be ambiguous.
  if (booking.coords && booking.coords.lat != null && booking.coords.lng != null) {
    const ll = `${booking.coords.lat},${booking.coords.lng}`;
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(ll)}&travelmode=driving`;
  }
  const dest = [booking.address, booking.town, "Ontario", "Canada"].filter(Boolean).join(", ");
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=driving`;
}

function fullAddress(booking) {
  // Address line shown on the card. Combines the lead's address (which
  // already includes street/town in many cases) with the parsed town
  // when separate. Avoids duplicating the town when both are set and
  // the address already contains it.
  const addr = (booking.address || "").trim();
  const town = (booking.town || "").trim();
  if (!addr) return town || "(no address)";
  if (town && !addr.toLowerCase().includes(town.toLowerCase())) {
    return `${addr}, ${town}`;
  }
  return addr;
}

function woStatusLabel(wo) {
  if (!wo) return "";
  return (wo.status || "scheduled").replace(/_/g, " ");
}

function bookingCardHtml(booking) {
  const wo = booking.workOrder;
  const woTypeLabel = wo ? (TYPE_LABELS[wo.type] || wo.type) : null;
  const notified = Boolean(booking.onRouteNotifiedAt);
  const notifiedTime = notified
    ? new Date(booking.onRouteNotifiedAt).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })
    : "";

  const customerNotes = booking.customerNotes ? `
    <p class="today-card-notes today-card-notes--customer">
      <span class="today-card-notes-label">Customer note</span>
      ${escapeHtml(booking.customerNotes)}
    </p>` : "";

  const internalNotes = booking.internalNotes ? `
    <p class="today-card-notes today-card-notes--internal">
      <span class="today-card-notes-label">Internal note</span>
      ${escapeHtml(booking.internalNotes)}
    </p>` : "";

  const woBadge = wo ? `
    <span class="today-card-wo-badge" title="Field work order ${escapeHtml(wo.id)} — ${escapeHtml(woStatusLabel(wo))}">
      <strong>${escapeHtml(wo.id)}</strong>
      <span class="today-card-wo-status">${escapeHtml(woStatusLabel(wo))}</span>
    </span>` : "";

  const phoneLink = booking.customerPhone
    ? `<a class="today-card-phone" href="tel:${escapeHtml(booking.customerPhone.replace(/[^\d+]/g, ""))}" aria-label="Call ${escapeHtml(booking.customerName || "customer")}">${escapeHtml(booking.customerPhone)}</a>`
    : "";

  return `
    <li class="today-card" data-lead-id="${escapeHtml(booking.leadId)}">
      <div class="today-card-time">
        <strong>${escapeHtml(booking.startLabel || "—")}</strong>
        ${booking.endLabel ? `<span>to ${escapeHtml(booking.endLabel)}</span>` : ""}
      </div>
      <div class="today-card-body">
        <div class="today-card-headline">
          <h2>${escapeHtml(booking.customerName || "(unnamed customer)")}</h2>
          ${woBadge}
        </div>
        <p class="today-card-address">${escapeHtml(fullAddress(booking))}</p>
        ${phoneLink}
        <p class="today-card-service">${escapeHtml(booking.serviceLabel || "Appointment")}${woTypeLabel ? ` <span class="today-card-service-template">→ ${escapeHtml(woTypeLabel)}</span>` : ""}</p>
        ${customerNotes}
        ${internalNotes}
        <div class="today-card-actions">
          <a class="today-action today-action--navigate" href="${escapeHtml(navigateUrl(booking))}" target="_blank" rel="noopener" data-action="navigate">
            <span class="today-action-icon" aria-hidden="true">→</span>
            <span class="today-action-label">Navigate</span>
          </a>
          <button type="button" class="today-action today-action--notify" data-action="notify" ${notified ? "data-notified" : ""}>
            <span class="today-action-icon" aria-hidden="true">${notified ? "✓" : "📣"}</span>
            <span class="today-action-label">${notified ? `Notified ${escapeHtml(notifiedTime)}` : "On route — notify"}</span>
          </button>
          <button type="button" class="today-action today-action--open" data-action="open-wo">
            <span class="today-action-label">${wo ? "Open WO" : "Start WO"}</span>
            <span class="today-action-icon" aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </li>
  `;
}

function render(bookings, dateString) {
  bookingsCache = bookings;

  const today = todayDateString();
  if (dateString === today) {
    todayHeadline.textContent = `Today, ${prettyShortDate(dateString)}`;
  } else {
    todayHeadline.textContent = prettyDate(dateString);
  }
  const count = bookings.length;
  todaySubline.textContent = count === 0
    ? "Nothing scheduled."
    : count === 1
      ? "1 booking · sorted by start time"
      : `${count} bookings · sorted by start time`;

  todayLoading.hidden = true;
  todayError.hidden = true;

  if (!bookings.length) {
    todayList.innerHTML = "";
    todayEmpty.hidden = false;
    return;
  }
  todayEmpty.hidden = true;

  todayList.innerHTML = bookings.map(bookingCardHtml).join("");
}

async function load(dateString) {
  todayLoading.hidden = false;
  todayError.hidden = true;
  todayEmpty.hidden = true;
  todayList.innerHTML = "";
  try {
    const url = dateString
      ? `/api/schedule/today?date=${encodeURIComponent(dateString)}`
      : "/api/schedule/today";
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error("Couldn't load");
    datePicker.value = data.date;
    render(data.bookings, data.date);
  } catch {
    todayLoading.hidden = true;
    todayError.hidden = false;
  }
}

// ---- Action handlers --------------------------------------------

todayList.addEventListener("click", async (event) => {
  const actionEl = event.target.closest("[data-action]");
  if (!actionEl) return;
  const card = actionEl.closest(".today-card");
  if (!card) return;
  const leadId = card.dataset.leadId;
  if (!leadId) return;
  const action = actionEl.dataset.action;

  if (action === "navigate") {
    // Native <a> handles the navigate action — let the browser do its
    // thing. Don't preventDefault; just close the nav menu if open.
    return;
  }

  if (action === "notify") {
    if (actionEl.dataset.notified) {
      // Already notified — confirm before re-firing so the customer
      // doesn't get spammed by a fat-fingered tap.
      const ok = confirm("Customer already notified earlier. Send another 'on the way' message?");
      if (!ok) return;
    }
    event.preventDefault();
    actionEl.disabled = true;
    const originalHTML = actionEl.innerHTML;
    actionEl.innerHTML = `<span class="today-action-icon" aria-hidden="true">…</span><span class="today-action-label">Sending…</span>`;
    try {
      const response = await fetch(`/api/leads/${encodeURIComponent(leadId)}/notify-on-route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || ["Notify failed"]).join(" "));
      // Update the booking in place so the badge reflects the notification.
      const booking = bookingsCache.find((b) => b.leadId === leadId);
      if (booking) booking.onRouteNotifiedAt = data.notifiedAt;
      const time = new Date(data.notifiedAt).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
      actionEl.dataset.notified = "true";
      actionEl.innerHTML = `<span class="today-action-icon" aria-hidden="true">✓</span><span class="today-action-label">Notified ${escapeHtml(time)}</span>`;
    } catch (err) {
      actionEl.innerHTML = originalHTML;
      alert(err.message || "Couldn't notify customer.");
    } finally {
      actionEl.disabled = false;
    }
    return;
  }

  if (action === "open-wo") {
    event.preventDefault();
    actionEl.disabled = true;
    const originalHTML = actionEl.innerHTML;
    actionEl.innerHTML = `<span class="today-action-label">Opening…</span>`;
    try {
      const response = await fetch(`/api/leads/${encodeURIComponent(leadId)}/open-wo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || ["Open WO failed"]).join(" "));
      // Tech-mode editor — full-screen, big tap targets. That's where
      // the actual on-site work happens.
      window.location.assign(`/admin/work-order/${encodeURIComponent(data.workOrder.id)}/tech`);
    } catch (err) {
      actionEl.innerHTML = originalHTML;
      actionEl.disabled = false;
      alert(err.message || "Couldn't open work order.");
    }
    return;
  }
});

// ---- Date picker ------------------------------------------------

datePicker.addEventListener("change", () => {
  if (datePicker.value) load(datePicker.value);
});

// Step the picker by ±1 day. Parses the current value as a *local*
// date (split-on-dash) so DST transitions don't shove the day forward
// or back when the browser interprets a YYYY-MM-DD as UTC midnight.
function shiftDate(deltaDays) {
  const raw = datePicker.value || todayDateString();
  const [y, m, d] = raw.split("-").map(Number);
  const next = new Date(y, m - 1, d + deltaDays);
  const ny = next.getFullYear();
  const nm = String(next.getMonth() + 1).padStart(2, "0");
  const nd = String(next.getDate()).padStart(2, "0");
  datePicker.value = `${ny}-${nm}-${nd}`;
  load(datePicker.value);
}
document.getElementById("datePrev")?.addEventListener("click", () => shiftDate(-1));
document.getElementById("dateNext")?.addEventListener("click", () => shiftDate(1));
document.getElementById("dateToday")?.addEventListener("click", () => {
  datePicker.value = todayDateString();
  load(datePicker.value);
});

// ---- Logout -----------------------------------------------------

logoutButton?.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.assign("/login");
});

// ---- Initial load ----------------------------------------------

datePicker.value = todayDateString();
load(datePicker.value);
