// Material Lists index — Phase 1.
// Lists every material list in the system. Status filter pills, free-text
// search across name + customer + id, "+ New list" inline form that
// creates a list and redirects into the builder.

const els = {
  container: document.getElementById("listsContainer"),
  empty: document.getElementById("listsEmpty"),
  newButton: document.getElementById("newListButton"),
  newForm: document.getElementById("newListForm"),
  newName: document.getElementById("newListName"),
  newCustomerName: document.getElementById("newListCustomerName"),
  newAddress: document.getElementById("newListAddress"),
  newError: document.getElementById("newListError"),
  newSave: document.getElementById("newListSave"),
  newCancel: document.getElementById("newListCancel"),
  search: document.getElementById("listSearch"),
  includeArchived: document.getElementById("includeArchived"),
  filterButtons: document.querySelectorAll("[data-status-filter]")
};

const STATUS_LABELS = {
  draft: "Draft",
  in_progress: "In progress",
  complete: "Complete",
  archived: "Archived"
};

let currentStatus = "";
let cachedLists = [];

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function fmtCents(cents) {
  return "$" + ((Number(cents) || 0) / 100).toFixed(2);
}
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

async function loadLists() {
  const params = new URLSearchParams();
  if (currentStatus) params.set("status", currentStatus);
  // Always fetch totals — the index card displays line counts + subtotals.
  params.set("withTotals", "1");
  // Server hides archived from default lists unless we either ask for them
  // explicitly OR filter ON archived. The "Show archived" checkbox flips
  // the includeArchived flag.
  if (els.includeArchived.checked) params.set("includeArchived", "1");
  const r = await fetch(`/api/material-lists?${params.toString()}`, { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  cachedLists = (data.ok && Array.isArray(data.lists)) ? data.lists : [];
  renderLists();
}

function applySearch(items) {
  const q = els.search.value.trim().toLowerCase();
  if (!q) return items;
  return items.filter((rec) => {
    const haystack = [
      rec.id, rec.name, rec.customerName, rec.customerEmail, rec.address
    ].map((v) => String(v || "").toLowerCase()).join(" ");
    return haystack.includes(q);
  });
}

function renderLists() {
  const items = applySearch(cachedLists);
  if (!items.length) {
    els.container.innerHTML = "";
    els.empty.hidden = false;
    return;
  }
  els.empty.hidden = true;
  els.container.innerHTML = items.map((rec) => {
    const totals = rec.totals || {};
    const customerLine = rec.customerName || rec.customerEmail || "—";
    const addressLine = rec.address ? ` &middot; ${escapeHtml(rec.address)}` : "";
    return `
      <li class="ml-card${rec.status === "archived" ? " is-archived" : ""}">
        <a class="ml-card-link" href="/admin/material-list/${encodeURIComponent(rec.id)}">
          <div class="ml-card-head">
            <h3 class="ml-card-name">${escapeHtml(rec.name || "(untitled list)")}</h3>
            <span class="ml-card-id">${escapeHtml(rec.id)}</span>
            <span class="ml-status ml-status--${escapeHtml(rec.status)}">${escapeHtml(STATUS_LABELS[rec.status] || rec.status)}</span>
          </div>
          <div class="ml-card-meta">
            <strong>${escapeHtml(customerLine)}</strong>${addressLine}
            <br>Updated ${escapeHtml(fmtDate(rec.updatedAt))}
          </div>
          <div class="ml-card-stats">
            <span class="ml-stat"><span class="ml-stat-num">${totals.lineCount || 0}</span><span class="ml-stat-label">lines</span></span>
            <span class="ml-stat"><span class="ml-stat-num ml-stat-num--need">${totals.needCount || 0}</span><span class="ml-stat-label">need</span></span>
            ${totals.orderedCount ? `<span class="ml-stat"><span class="ml-stat-num ml-stat-num--ordered">${totals.orderedCount}</span><span class="ml-stat-label">ordered</span></span>` : ""}
            <span class="ml-stat"><span class="ml-stat-num ml-stat-num--have">${totals.haveCount || 0}</span><span class="ml-stat-label">have</span></span>
            <span class="ml-card-total">${fmtCents(totals.grandSubtotalCents)}</span>
          </div>
        </a>
      </li>
    `;
  }).join("");
}

function openNewForm() {
  els.newError.hidden = true;
  els.newError.textContent = "";
  els.newForm.hidden = false;
  els.newForm.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => els.newName.focus(), 200);
}
function closeNewForm() {
  els.newForm.hidden = true;
  els.newForm.reset();
  els.newError.hidden = true;
}
async function saveNew(event) {
  event.preventDefault();
  const name = els.newName.value.trim();
  if (!name) {
    els.newError.textContent = "List name is required.";
    els.newError.hidden = false;
    els.newName.focus();
    return;
  }
  els.newSave.disabled = true;
  try {
    const r = await fetch("/api/material-lists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        customerName: els.newCustomerName.value,
        address: els.newAddress.value
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      els.newError.textContent = (data.errors && data.errors[0]) || `HTTP ${r.status}`;
      els.newError.hidden = false;
      return;
    }
    // Drop straight into the builder for the new list — that's where the
    // user is going next anyway (add line items).
    location.href = `/admin/material-list/${encodeURIComponent(data.list.id)}`;
  } catch (err) {
    els.newError.textContent = err.message || "Couldn't create list.";
    els.newError.hidden = false;
  } finally {
    els.newSave.disabled = false;
  }
}

// Event wiring
els.newButton.addEventListener("click", openNewForm);
els.newCancel.addEventListener("click", closeNewForm);
els.newForm.addEventListener("submit", saveNew);
els.search.addEventListener("input", () => renderLists());
els.includeArchived.addEventListener("change", loadLists);
els.filterButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentStatus = btn.dataset.statusFilter || "";
    els.filterButtons.forEach((b) => b.classList.toggle("is-active", b === btn));
    loadLists();
  });
});

loadLists();
