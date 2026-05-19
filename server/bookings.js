// /admin/bookings — first-class booking folder browser. Vertical list,
// search, status filters. Click a row → /admin/booking/<BK-id>.

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

const listEl = document.getElementById("bookingsList");
const emptyEl = document.getElementById("bookingsEmpty");
const searchEl = document.getElementById("bookingSearch");
const countEl = document.getElementById("bookingsCount");
const filterEls = Array.from(document.querySelectorAll(".customers-filter"));
const logoutButton = document.getElementById("logoutButton");

let bookings = [];
let statusFilter = "all";

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${time}`;
}

// Header badge label (raw status). Map underscore → space-separated word
// so "no_show" reads as "No-show" in uppercase rather than "NO_SHOW".
function statusBadgeLabel(status) {
  const map = {
    confirmed: "Confirmed",
    tentative: "Tentative",
    completed: "Completed",
    cancelled: "Cancelled",
    no_show: "No-show"
  };
  return map[status] || "Confirmed";
}

// Lifecycle word for the bottom row. Distinct from the badge label —
// a "confirmed" booking with a scheduled time is "Scheduled" in
// lifecycle terms (per brief mockup).
function lifecycleLabel(status) {
  if (status === "confirmed") return "Scheduled";
  return statusBadgeLabel(status);
}

function searchable(b) {
  return [b.id, b.customerName, b.customerEmail, b.address, b.serviceLabel, b.serviceKey]
    .filter(Boolean).join(" ").toLowerCase();
}

function visibleBookings() {
  const q = searchEl.value.trim().toLowerCase();
  return bookings.filter((b) => {
    if (statusFilter !== "all" && b.status !== statusFilter) return false;
    if (q && !searchable(b).includes(q)) return false;
    return true;
  });
}

function render() {
  const filtered = visibleBookings();
  countEl.textContent = filtered.length === bookings.length
    ? `${bookings.length} booking${bookings.length === 1 ? "" : "s"}`
    : `${filtered.length} of ${bookings.length}`;

  listEl.innerHTML = "";
  if (!filtered.length) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  for (const b of filtered) {
    const status = b.status || "confirmed";
    const woCount = (b.workOrderIds || []).length;
    const stateText = woCount > 0
      ? `${lifecycleLabel(status)} · ${woCount} work order${woCount === 1 ? "" : "s"}`
      : lifecycleLabel(status);
    const card = document.createElement("a");
    card.className = "bk-card";
    card.href = `/admin/booking/${encodeURIComponent(b.id)}`;
    card.dataset.bookingId = b.id;
    card.innerHTML = `
      <header class="bk-card__head">
        <span class="bk-card__id">${esc(b.id)}</span>
        <span class="bk-card__status bk-card__status--${esc(status)}">${esc(statusBadgeLabel(status))}</span>
      </header>
      <p class="bk-card__service">${esc(b.serviceLabel || b.serviceKey || "—")}</p>
      <p class="bk-card__customer">${esc(b.customerName) || "(no customer)"}</p>
      <p class="bk-card__address">${esc(b.address) || "—"}</p>
      <p class="bk-card__datetime">${esc(formatDateTime(b.scheduledFor))}</p>
      <p class="bk-card__state">${esc(stateText)}</p>
    `;
    listEl.appendChild(card);
  }
}

async function load() {
  try {
    const res = await fetch("/api/bookings", { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    bookings = Array.isArray(body.bookings) ? body.bookings : [];
    bookings.sort((a, b) => String(b.scheduledFor || "").localeCompare(String(a.scheduledFor || "")));
  } catch (err) {
    console.error("Failed to load bookings:", err);
    bookings = [];
  }
  render();
}

searchEl.addEventListener("input", render);
filterEls.forEach((btn) => {
  btn.addEventListener("click", () => {
    filterEls.forEach((b) => b.classList.toggle("is-active", b === btn));
    statusFilter = btn.dataset.status || "all";
    render();
  });
});
if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    try { await fetch("/api/logout", { method: "POST" }); } catch {}
    location.href = "/login";
  });
}

load();
