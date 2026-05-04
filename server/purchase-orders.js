// Purchase Orders index — Phase 3.
// Card list of every PO in the system. Status filter pills, free-text
// search, deep-link into the per-PO detail page. Cards show supplier,
// line count, subtotal, and the source material list.

const els = {
  container: document.getElementById("poContainer"),
  empty: document.getElementById("poEmpty"),
  search: document.getElementById("poSearch"),
  filterButtons: document.querySelectorAll("[data-status-filter]")
};

const STATUS_LABELS = {
  draft: "Draft",
  sent: "Sent",
  received: "Received",
  cancelled: "Cancelled"
};

let currentStatus = "";
let cachedPos = [];

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function fmtCents(c) { return "$" + ((Number(c) || 0) / 100).toFixed(2); }
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

async function load() {
  const url = currentStatus ? `/api/purchase-orders?status=${encodeURIComponent(currentStatus)}` : "/api/purchase-orders";
  const r = await fetch(url, { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  cachedPos = (data.ok && Array.isArray(data.purchaseOrders)) ? data.purchaseOrders : [];
  render();
}

function applySearch(items) {
  const q = els.search.value.trim().toLowerCase();
  if (!q) return items;
  return items.filter((po) => {
    const haystack = [
      po.id, po.supplierName, po.supplierEmail, ...(po.sourceMaterialListIds || [])
    ].map((v) => String(v || "").toLowerCase()).join(" ");
    return haystack.includes(q);
  });
}

function render() {
  const items = applySearch(cachedPos);
  if (!items.length) {
    els.container.innerHTML = "";
    els.empty.hidden = false;
    return;
  }
  els.empty.hidden = true;
  els.container.innerHTML = items.map((po) => {
    const lineCount = (po.lineItems || []).length;
    const sourceList = (po.sourceMaterialListIds || [])[0];
    const sourceLink = sourceList
      ? `<a href="/admin/material-list/${encodeURIComponent(sourceList)}" style="color:#1B4D2E;text-decoration:none">${escapeHtml(sourceList)}</a>`
      : "<em>(manual)</em>";
    const sentLine = po.sentAt
      ? `<br>Sent ${escapeHtml(fmtDate(po.sentAt))}${po.emailedToEmail ? ` to ${escapeHtml(po.emailedToEmail)}` : ""}`
      : "";
    const receivedLine = po.receivedAt
      ? `<br>Received ${escapeHtml(fmtDate(po.receivedAt))}`
      : "";
    return `
      <li class="ml-card">
        <a class="ml-card-link" href="/admin/purchase-order/${encodeURIComponent(po.id)}">
          <div class="ml-card-head">
            <h3 class="ml-card-name">${escapeHtml(po.supplierName || "(no supplier)")}</h3>
            <span class="ml-card-id">${escapeHtml(po.id)}</span>
            <span class="po-status po-status--${escapeHtml(po.status)}">${escapeHtml(STATUS_LABELS[po.status] || po.status)}</span>
          </div>
          <div class="ml-card-meta">
            ${lineCount} line${lineCount === 1 ? "" : "s"} &middot; from ${sourceLink}
            <br>Created ${escapeHtml(fmtDate(po.createdAt))}
            ${sentLine}${receivedLine}
          </div>
          <div class="ml-card-stats">
            <span class="ml-card-total">${fmtCents(po.subtotalCents)}</span>
          </div>
        </a>
      </li>
    `;
  }).join("");
}

els.search.addEventListener("input", () => render());
els.filterButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentStatus = btn.dataset.statusFilter || "";
    els.filterButtons.forEach((b) => b.classList.toggle("is-active", b === btn));
    load();
  });
});

load();
