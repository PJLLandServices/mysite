// /admin/customers — index page. Vertical list, search box, status
// filter chips, + New customer modal.
//
// Data source: GET /api/customers — returns each customer record
// decorated with `propertyCount` and `lastActivityAt`. Click a row
// to navigate to /admin/customer/<id>.

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

const listEl = document.getElementById("customersList");
const emptyEl = document.getElementById("customersEmpty");
const searchEl = document.getElementById("customerSearch");
const countEl = document.getElementById("customersCount");
const filterEls = Array.from(document.querySelectorAll(".customers-filter"));
const newCustomerBtn = document.getElementById("newCustomerBtn");
const modalEl = document.getElementById("newCustomerModal");
const newForm = document.getElementById("newCustomerForm");
const newErrorEl = document.getElementById("newCustomerError");
const newCancelBtn = document.getElementById("newCustomerCancel");
const logoutButton = document.getElementById("logoutButton");

let customers = [];
let statusFilter = "all";

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
}

function searchable(c) {
  return [c.name, c.spouseName, c.email, c.spouseEmail, c.phone, c.spousePhone, c.id]
    .filter(Boolean).join(" ").toLowerCase();
}

function visibleCustomers() {
  const q = searchEl.value.trim().toLowerCase();
  return customers.filter((c) => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    if (q && !searchable(c).includes(q)) return false;
    return true;
  });
}

function render() {
  const filtered = visibleCustomers();

  countEl.textContent = filtered.length === customers.length
    ? `${customers.length} ${customers.length === 1 ? "customer" : "customers"}`
    : `${filtered.length} of ${customers.length}`;

  listEl.innerHTML = "";
  if (!filtered.length) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  for (const c of filtered) {
    const link = document.createElement("a");
    link.className = "customer-card";
    link.href = `/admin/customer/${encodeURIComponent(c.id)}`;
    const propertyCount = c.propertyCount || 0;
    const lastActivity = formatDate(c.lastActivityAt || c.updatedAt || c.createdAt);
    link.innerHTML = `
      <div class="customer-card-name">
        <strong>${escapeHtml(c.name) || "(unnamed)"}</strong>
        ${c.spouseName ? `<span class="customer-card-id">+ ${escapeHtml(c.spouseName)}</span>` : ""}
        <span class="customer-card-id">${escapeHtml(c.id)}</span>
      </div>
      <div class="customer-card-contact">
        <span>${escapeHtml(c.email) || "—"}</span>
        <span>${escapeHtml(c.phone) || "—"}</span>
      </div>
      <div class="customer-card-stat">
        <strong>${propertyCount}</strong>
        ${propertyCount === 1 ? "property" : "properties"}
      </div>
      <div class="customer-card-stat">
        <strong>${lastActivity}</strong>
        last activity
      </div>
      <span class="customer-status is-${escapeHtml(c.status || "lead")}">${escapeHtml(c.status || "lead")}</span>
    `;
    listEl.appendChild(link);
  }
}

async function load() {
  try {
    const res = await fetch("/api/customers", { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    customers = Array.isArray(body.customers) ? body.customers : [];
  } catch (err) {
    console.error("Failed to load customers:", err);
    customers = [];
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

// New customer modal
function openModal() {
  newForm.reset();
  newErrorEl.hidden = true;
  modalEl.hidden = false;
  setTimeout(() => newForm.querySelector("input[name=name]")?.focus(), 0);
}
function closeModal() { modalEl.hidden = true; }

newCustomerBtn.addEventListener("click", openModal);
newCancelBtn.addEventListener("click", closeModal);
modalEl.addEventListener("click", (e) => {
  if (e.target === modalEl) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modalEl.hidden) closeModal();
});

newForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  newErrorEl.hidden = true;
  const formData = new FormData(newForm);
  const payload = {
    name: (formData.get("name") || "").toString().trim(),
    email: (formData.get("email") || "").toString().trim(),
    phone: (formData.get("phone") || "").toString().trim()
  };
  if (!payload.name) {
    newErrorEl.textContent = "Name is required.";
    newErrorEl.hidden = false;
    return;
  }
  try {
    const res = await fetch("/api/customer", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      newErrorEl.textContent = body?.errors?.[0] || body?.error || "Couldn't create customer.";
      newErrorEl.hidden = false;
      return;
    }
    closeModal();
    location.href = `/admin/customer/${encodeURIComponent(body.customer.id)}`;
  } catch (err) {
    newErrorEl.textContent = err?.message || "Network error.";
    newErrorEl.hidden = false;
  }
});

load();
