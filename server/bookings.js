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
  return d.toLocaleString("en-CA", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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
    const link = document.createElement("a");
    link.className = "customer-card";
    link.href = `/admin/booking/${encodeURIComponent(b.id)}`;
    const woCount = (b.workOrderIds || []).length;
    link.innerHTML = `
      <div class="customer-card-name">
        <strong>${esc(b.id)}</strong>
        <span class="customer-card-id">${esc(b.customerName) || "(no customer)"}</span>
      </div>
      <div class="customer-card-contact">
        <span>${esc(b.serviceLabel || b.serviceKey || "—")}</span>
        <span>${esc(b.address) || "—"}</span>
      </div>
      <div class="customer-card-stat">
        <strong>${formatDateTime(b.scheduledFor)}</strong>
        scheduled
      </div>
      <div class="customer-card-stat">
        <strong>${woCount}</strong>
        WO${woCount === 1 ? "" : "s"}
      </div>
      <span class="customer-status is-${esc(b.status || "confirmed")}">${esc(b.status || "confirmed")}</span>
    `;
    listEl.appendChild(link);
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
