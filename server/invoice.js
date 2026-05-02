const idFromPath = (() => {
  const m = location.pathname.match(/^\/admin\/invoice\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
})();

const loading = document.getElementById("invoiceLoading");
const card = document.getElementById("invoiceCard");

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function fmt(n) { return "$" + (Number(n) || 0).toFixed(2); }
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
}

let currentInvoice = null;

async function load() {
  if (!idFromPath) return;
  const r = await fetch(`/api/invoices/${encodeURIComponent(idFromPath)}`, { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!data.ok || !data.invoice) {
    loading.textContent = "Invoice not found.";
    return;
  }
  currentInvoice = data.invoice;
  render(data.invoice);
}

function render(inv) {
  loading.hidden = true;
  card.hidden = false;
  document.getElementById("invoiceTitle").textContent = `Invoice ${inv.id}`;
  document.getElementById("invoiceId").textContent = inv.id;
  document.getElementById("invoiceMeta").textContent = `Created ${fmtDate(inv.createdAt)}${inv.sentAt ? ` · Sent ${fmtDate(inv.sentAt)}` : ""}${inv.paidAt ? ` · Paid ${fmtDate(inv.paidAt)}` : ""}`;
  document.getElementById("invoiceStatus").value = inv.status;

  const statusMeta = document.getElementById("invoiceStatusMeta");
  statusMeta.textContent = inv.quickbooksInvoiceId ? `QB: ${inv.quickbooksInvoiceId}` : "Not synced to QuickBooks";

  document.getElementById("invoiceCustomerName").textContent = inv.customerName || "—";
  document.getElementById("invoiceCustomerAddress").textContent = inv.address || "";
  const contact = [inv.customerPhone, inv.customerEmail].filter(Boolean).join(" · ");
  document.getElementById("invoiceCustomerContact").textContent = contact;

  const linesEl = document.getElementById("invoiceLines");
  linesEl.innerHTML = (inv.lineItems || []).map((l) => `
    <tr>
      <td>${escapeHtml(l.label || l.key || "Line")}${l.note ? `<br><span class="invoice-line-note">${escapeHtml(l.note)}</span>` : ""}</td>
      <td>${escapeHtml(String(l.qty || 1))}</td>
      <td>${fmt(l.unitPrice)}</td>
      <td>${fmt(l.lineTotal)}</td>
    </tr>
  `).join("") || `<tr><td colspan="4" class="invoice-line-empty">No line items.</td></tr>`;

  document.getElementById("invoiceSubtotal").textContent = fmt(inv.subtotal);
  document.getElementById("invoiceHst").textContent = fmt(inv.hst);
  document.getElementById("invoiceTotal").textContent = fmt(inv.total);
  document.getElementById("invoiceNotes").value = inv.notes || "";

  const woLink = document.getElementById("invoiceWoLink");
  if (inv.woId) { woLink.href = `/admin/work-order/${encodeURIComponent(inv.woId)}`; woLink.textContent = inv.woId; }
  else { woLink.removeAttribute("href"); woLink.textContent = "no WO"; }
  const propLink = document.getElementById("invoicePropertyLink");
  if (inv.propertyId) { propLink.href = `/admin/property/${encodeURIComponent(inv.propertyId)}`; propLink.textContent = "Property"; }
  else { propLink.removeAttribute("href"); propLink.textContent = "no property"; }
}

document.getElementById("invoiceStatus")?.addEventListener("change", async (event) => {
  const status = event.target.value;
  if (!confirm(`Set invoice status to "${status}"?`)) {
    event.target.value = currentInvoice?.status || "draft";
    return;
  }
  try {
    const r = await fetch(`/api/invoices/${encodeURIComponent(idFromPath)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't update status.");
    currentInvoice = data.invoice;
    render(data.invoice);
  } catch (err) {
    alert(err.message || "Failed.");
    event.target.value = currentInvoice?.status || "draft";
  }
});

document.getElementById("invoiceSaveNotes")?.addEventListener("click", async () => {
  const notes = document.getElementById("invoiceNotes").value;
  try {
    const r = await fetch(`/api/invoices/${encodeURIComponent(idFromPath)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't save.");
    currentInvoice = data.invoice;
  } catch (err) {
    alert(err.message || "Failed.");
  }
});

load();
