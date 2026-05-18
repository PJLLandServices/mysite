const tableBody = document.getElementById("invoicesBody");
const tableEl = document.getElementById("invoicesTable");
const emptyEl = document.getElementById("invoicesEmpty");
const filterBtns = document.querySelectorAll("[data-status-filter]");

let currentFilter = "";

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function fmt(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

async function load() {
  const url = currentFilter ? `/api/invoices?status=${encodeURIComponent(currentFilter)}` : "/api/invoices";
  const r = await fetch(url, { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  const items = (data.ok && Array.isArray(data.invoices)) ? data.invoices : [];
  if (!items.length) {
    tableEl.hidden = true;
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  tableEl.hidden = false;
  tableBody.innerHTML = items.map((inv) => `
    <tr class="invoice-row" data-invoice-id="${escapeHtml(inv.id)}">
      <td><a href="/admin/invoice/${encodeURIComponent(inv.id)}">${escapeHtml(inv.id)}</a></td>
      <td>
        <strong>${escapeHtml(inv.customerName || "—")}</strong>
        ${inv.address ? `<br><span class="invoices-row-sub">${escapeHtml(inv.address)}</span>` : ""}
      </td>
      <td>${inv.woId ? `<a href="/admin/work-order/${encodeURIComponent(inv.woId)}">${escapeHtml(inv.woId)}</a>` : "—"}</td>
      <td class="invoices-amount">${fmt(inv.total)}</td>
      <td><span class="invoices-status invoices-status--${escapeHtml(inv.status)}">${escapeHtml(inv.status)}</span></td>
      <td>${escapeHtml(fmtDate(inv.createdAt))}</td>
    </tr>
  `).join("");
  // Wire bulk-selection toolbar (Session 2 brief). Each call refreshes
  // the controller's row scan since the table just re-rendered.
  if (window.pjlBulkWiring) window.pjlBulkWiring.attach("invoices", { onActionComplete: load });
  // bulk-selection.js injects a leading <td class="pjl-bulk-checkbox-cell">
  // on every row + a matching <th> in thead. Move the wrap into the
  // invoice-id <td> so the checkbox sits inline with the ID instead of
  // claiming its own column (desktop) / reserving 40px of indent (mobile
  // card view). Hide the now-empty leading <td>/<th> with `hidden` so
  // they don't render but the bulk controller's "has wrap?" / "has th?"
  // re-injection guards still find them and skip duplicate inserts.
  tableBody.querySelectorAll("tr.invoice-row").forEach((row) => {
    const bulkCell = row.querySelector(":scope > .pjl-bulk-checkbox-cell");
    if (!bulkCell) return;
    const wrap = bulkCell.querySelector(".pjl-bulk-checkbox-wrap");
    const firstDataCell = Array.from(row.children).find((td) => td !== bulkCell && td.tagName === "TD");
    if (wrap && firstDataCell) {
      firstDataCell.insertBefore(wrap, firstDataCell.firstChild);
      bulkCell.hidden = true;
    }
  });
  const bulkTh = tableEl.querySelector("thead .pjl-bulk-checkbox-th");
  if (bulkTh) bulkTh.hidden = true;
}

filterBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentFilter = btn.dataset.statusFilter || "";
    filterBtns.forEach((b) => b.classList.toggle("is-active", b === btn));
    load();
  });
});

load();
