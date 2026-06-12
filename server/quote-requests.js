// Quote Requests (RFQ) index — Phase A.
// Card list of every RFQ in the system. Status filter pills, free-text
// search, deep-link into the per-RFQ detail page. Cards show supplier,
// line count, and the source material list. Deliberately NO prices:
// an RFQ asks suppliers for prices, it never displays any — and unlike
// the PO index there is no subtotal column to render.
// Bulk-selection wiring is intentionally omitted (PO index has it; RFQs
// don't participate in bulk actions).

const els = {
  container: document.getElementById("rfqContainer"),
  empty: document.getElementById("rfqEmpty"),
  search: document.getElementById("rfqSearch"),
  filterButtons: document.querySelectorAll("[data-status-filter]"),
  showClosed: document.getElementById("rfqShowClosed")
};

const STATUS_LABELS = {
  draft: "Draft",
  sent: "Sent",
  quoted: "Quoted",
  applied: "Applied",
  cancelled: "Cancelled"
};
// Closed = terminal states. Hidden from the index by default; users
// toggle "Show closed RFQs" to see the archive.
const CLOSED_STATUSES = new Set(["applied", "cancelled"]);

let currentStatus = "";
let cachedRfqs = [];

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

async function load() {
  const url = currentStatus ? `/api/quote-requests?status=${encodeURIComponent(currentStatus)}` : "/api/quote-requests";
  const r = await fetch(url, { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  cachedRfqs = (data.ok && Array.isArray(data.quoteRequests)) ? data.quoteRequests : [];
  render();
}

function applyFilters(items) {
  let result = items;
  // Hide terminal RFQs unless either the explicit status filter is one
  // of them OR the "Show closed" toggle is on. Keeps the default index
  // focused on quotes still in flight.
  const showClosed = els.showClosed.checked;
  if (!showClosed && !CLOSED_STATUSES.has(currentStatus)) {
    result = result.filter((rfq) => !CLOSED_STATUSES.has(rfq.status));
  }
  const q = els.search.value.trim().toLowerCase();
  if (q) {
    result = result.filter((rfq) => {
      const haystack = [
        rfq.id, rfq.supplierName, rfq.supplierEmail, rfq.sourceMaterialListId
      ].map((v) => String(v || "").toLowerCase()).join(" ");
      return haystack.includes(q);
    });
  }
  return result;
}

function render() {
  const items = applyFilters(cachedRfqs);
  if (!items.length) {
    els.container.innerHTML = "";
    els.empty.hidden = false;
    return;
  }
  els.empty.hidden = true;
  els.container.innerHTML = items.map((rfq) => {
    const lineCount = (rfq.lines || []).length;
    const sourceList = rfq.sourceMaterialListId;
    const sourcePill = sourceList
      ? `<a class="ml-source-pill" href="/admin/material-list/${encodeURIComponent(sourceList)}">${escapeHtml(sourceList)}</a>`
      : `<span class="ml-source-pill ml-source-pill--manual">manual</span>`;
    const sentLine = rfq.sentAt
      ? `<div class="ml-card-line"><strong>Sent</strong> ${escapeHtml(fmtDate(rfq.sentAt))}${rfq.emailedToEmail ? ` to ${escapeHtml(rfq.emailedToEmail)}` : ""}</div>`
      : "";
    return `
      <li class="ml-card" data-rfq-id="${escapeHtml(rfq.id)}">
        <a class="ml-card-link" href="/admin/quote-request/${encodeURIComponent(rfq.id)}">
          <div class="ml-card-head">
            <h3 class="ml-card-name">${escapeHtml(rfq.supplierName || "(no supplier)")}</h3>
            <span class="ml-card-id">${escapeHtml(rfq.id)}</span>
            <span class="rfq-status rfq-status--${escapeHtml(rfq.status)}">${escapeHtml(STATUS_LABELS[rfq.status] || rfq.status)}</span>
          </div>
          <div class="ml-card-source-row">From ${sourcePill}</div>
          <div class="ml-card-lines">
            <div class="ml-card-line"><strong>Created</strong> ${escapeHtml(fmtDate(rfq.createdAt))}</div>
            ${sentLine}
          </div>
          <div class="ml-card-stats">
            <span class="ml-stat"><span class="ml-stat-num">${lineCount}</span><span class="ml-stat-label">${lineCount === 1 ? "line" : "lines"}</span></span>
          </div>
        </a>
      </li>
    `;
  }).join("");
}

els.search.addEventListener("input", () => render());
els.showClosed.addEventListener("change", () => render());
els.filterButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentStatus = btn.dataset.statusFilter || "";
    els.filterButtons.forEach((b) => b.classList.toggle("is-active", b === btn));
    load();
  });
});

load();
