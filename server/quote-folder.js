const tableBody = document.getElementById("quotesBody");
const tableEl = document.getElementById("quotesTable");
const emptyEl = document.getElementById("quotesEmpty");
const filterBtns = document.querySelectorAll("[data-status-filter]");

const TYPE_LABELS = {
  ai_repair_quote: "AI repair",
  on_site_quote: "On-site",
  formal_quote: "Formal"
};

let currentFilter = "";

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function fmt(n) { return "$" + (Number(n) || 0).toFixed(2); }
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

async function load() {
  const url = currentFilter ? `/api/admin/quote-folder?status=${encodeURIComponent(currentFilter)}` : "/api/admin/quote-folder";
  const r = await fetch(url, { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  const items = (data.ok && Array.isArray(data.quotes)) ? data.quotes : [];
  if (!items.length) {
    tableEl.hidden = true;
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  tableEl.hidden = false;
  tableBody.innerHTML = items.map((q) => {
    // Lead deep-link if we have a leadId — quotes don't have their own
    // detail page yet, so the lead detail (which embeds the Quote card)
    // is the closest thing to a "quote view."
    const customer = q.customerEmail || "(no email)";
    const leadLink = q.leadId
      ? `<a href="/admin#lead-${encodeURIComponent(q.leadId)}">Open in CRM</a>`
      : "—";
    return `
      <tr>
        <td>
          <strong>${escapeHtml(q.id)}</strong>${q.version > 1 ? ` <span class="invoices-row-sub">v${q.version}</span>` : ""}
          <br><a class="invoices-row-sub" href="/api/admin/quote-folder/${encodeURIComponent(q.id)}/pdf" target="_blank" rel="noopener">📄 PDF</a>
        </td>
        <td>${escapeHtml(TYPE_LABELS[q.type] || q.type)}</td>
        <td>${escapeHtml(customer)}<br><span class="invoices-row-sub">${leadLink}</span></td>
        <td class="invoices-amount">${fmt(q.total)}</td>
        <td><span class="invoices-status invoices-status--${escapeHtml(q.status)}">${escapeHtml(q.status)}</span></td>
        <td>${escapeHtml(fmtDate(q.createdAt))}${q.validUntil ? `<br><span class="invoices-row-sub">expires ${escapeHtml(fmtDate(q.validUntil))}</span>` : ""}</td>
      </tr>
    `;
  }).join("");
}

filterBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentFilter = btn.dataset.statusFilter || "";
    filterBtns.forEach((b) => b.classList.toggle("is-active", b === btn));
    load();
  });
});

load();
