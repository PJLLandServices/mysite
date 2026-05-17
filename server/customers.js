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
const bulkbarEl = document.getElementById("customersBulkbar");
const bulkbarCountEl = document.getElementById("customersBulkbarCount");
const bulkbarSelectAllEl = document.getElementById("customersBulkbarSelectAll");
const bulkbarClearEl = document.getElementById("customersBulkbarClear");
const bulkbarDownloadEl = document.getElementById("customersBulkbarDownload");

let customers = [];
let statusFilter = "all";
// Selected customer ids for bulk vCard download. Survives re-renders
// (filter / search changes) so a selection made while filtered isn't
// silently dropped when the filter is cleared.
const selectedIds = new Set();

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
    updateBulkbar();
    return;
  }
  emptyEl.hidden = true;

  for (const c of filtered) {
    const row = document.createElement("div");
    row.className = "customer-row";
    const propertyCount = c.propertyCount || 0;
    const lastActivity = formatDate(c.lastActivityAt || c.updatedAt || c.createdAt);
    const idAttr = escapeHtml(c.id);
    const isChecked = selectedIds.has(c.id);
    // The card link spans the middle column; checkbox + download anchor
    // flank it on either side. We use a plain <a download> for the
    // per-row download — the server's Content-Disposition: attachment
    // header turns it into a save dialog without leaving the page.
    row.innerHTML = `
      <label class="customer-row-check" title="Select for bulk download">
        <input type="checkbox" data-customer-id="${idAttr}"${isChecked ? " checked" : ""}>
      </label>
      <a class="customer-card" href="/admin/customer/${encodeURIComponent(c.id)}">
        <div class="customer-card-name">
          <strong>${escapeHtml(c.name) || "(unnamed)"}</strong>
          ${c.spouseName ? `<span class="customer-card-id">+ ${escapeHtml(c.spouseName)}</span>` : ""}
          <span class="customer-card-id">${idAttr}</span>
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
      </a>
      <a class="customer-row-download" href="/api/customer/${encodeURIComponent(c.id)}/vcard" title="Download vCard" aria-label="Download vCard for ${escapeHtml(c.name) || c.id}" download>⬇</a>
    `;
    listEl.appendChild(row);
  }

  // Wire checkboxes after they're in the DOM.
  listEl.querySelectorAll("input[type=checkbox][data-customer-id]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.customerId;
      if (cb.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      updateBulkbar();
    });
  });

  updateBulkbar();
}

// Show / hide the bulk bar, refresh its labels, and add bottom padding
// to the page so the last row isn't covered by the fixed-position bar.
function updateBulkbar() {
  const n = selectedIds.size;
  if (n === 0) {
    bulkbarEl.hidden = true;
    document.body.classList.remove("has-bulkbar");
    return;
  }
  bulkbarEl.hidden = false;
  document.body.classList.add("has-bulkbar");
  bulkbarCountEl.textContent = `${n} selected`;
  bulkbarDownloadEl.textContent = `⬇ Download ${n} vCard${n === 1 ? "" : "s"}`;
  // Toggle Select-all label/behavior depending on whether every visible
  // customer is already checked.
  const visible = visibleCustomers();
  const allVisibleSelected = visible.length > 0 && visible.every((c) => selectedIds.has(c.id));
  bulkbarSelectAllEl.textContent = allVisibleSelected ? "Deselect visible" : "Select all visible";
  bulkbarSelectAllEl.dataset.mode = allVisibleSelected ? "deselect" : "select";
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

// ---- Bulk vCard download bar -------------------------------------
//
// The Select-all button toggles between "select every visible row" and
// "clear the visible rows from selection" so a single button covers
// both intents (also matches what Patrick instinctively reaches for on
// iPhone, where multiple distinct buttons would be cramped).

bulkbarSelectAllEl.addEventListener("click", () => {
  const visible = visibleCustomers();
  if (bulkbarSelectAllEl.dataset.mode === "deselect") {
    for (const c of visible) selectedIds.delete(c.id);
  } else {
    for (const c of visible) selectedIds.add(c.id);
  }
  render();
});

bulkbarClearEl.addEventListener("click", () => {
  selectedIds.clear();
  render();
});

bulkbarDownloadEl.addEventListener("click", async () => {
  if (!selectedIds.size) return;
  const ids = Array.from(selectedIds);
  bulkbarDownloadEl.disabled = true;
  const originalLabel = bulkbarDownloadEl.textContent;
  bulkbarDownloadEl.textContent = "Preparing…";
  try {
    const res = await fetch("/api/customers/vcards.vcf", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids })
    });
    if (!res.ok) {
      let msg = `Download failed (HTTP ${res.status}).`;
      try {
        const body = await res.json();
        if (body?.error) msg = body.error;
      } catch {}
      alert(msg);
      return;
    }
    const skipped = parseInt(res.headers.get("X-Customers-Skipped") || "0", 10);
    // Pull filename out of Content-Disposition so the saved file
    // matches what the server picked (pjl-customers-YYYY-MM-DD.vcf).
    const cd = res.headers.get("Content-Disposition") || "";
    const fnMatch = cd.match(/filename="([^"]+)"/);
    const filename = fnMatch ? fnMatch[1] : "pjl-customers.vcf";
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (skipped > 0) {
      alert(`Downloaded ${ids.length - skipped} vCards. ${skipped} customer${skipped === 1 ? " was" : "s were"} skipped (not found).`);
    }
    // Refresh customers so the new vcfDownloads[] entries surface in
    // last-activity timestamps and the detail page's Downloads tab.
    selectedIds.clear();
    await load();
  } catch (err) {
    alert(err?.message || "Network error.");
  } finally {
    bulkbarDownloadEl.disabled = false;
    bulkbarDownloadEl.textContent = originalLabel;
  }
});

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
