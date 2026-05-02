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
  document.getElementById("invoiceMeta").innerHTML = `Issued ${escapeHtml(fmtDate(inv.createdAt))}${inv.sentAt ? `<br>Sent ${escapeHtml(fmtDate(inv.sentAt))}` : ""}${inv.paidAt ? `<br>Paid ${escapeHtml(fmtDate(inv.paidAt))}` : ""}`;
  document.getElementById("invoiceStatus").value = inv.status;
  // PDF action buttons — open in new tab vs. force download (same URL,
  // download attr triggers the browser save dialog).
  const pdfPath = `/api/admin/quote-folder/${encodeURIComponent(inv.quoteId || inv.id)}/pdf`;
  const pdfLinkEl = document.getElementById("invoicePdfLink");
  const pdfDownloadEl = document.getElementById("invoicePdfDownload");
  if (pdfLinkEl) pdfLinkEl.href = pdfPath;
  if (pdfDownloadEl) {
    pdfDownloadEl.href = pdfPath;
    pdfDownloadEl.setAttribute("download", `${inv.id}.pdf`);
  }

  const statusMeta = document.getElementById("invoiceStatusMeta");
  statusMeta.textContent = inv.quickbooksInvoiceId ? `QB: ${inv.quickbooksInvoiceId}` : "Not synced to QuickBooks";

  document.getElementById("invoiceCustomerName").textContent = inv.customerName || "—";
  document.getElementById("invoiceCustomerAddress").textContent = inv.address || "";
  const contact = [inv.customerPhone, inv.customerEmail].filter(Boolean).join(" · ");
  document.getElementById("invoiceCustomerContact").textContent = contact;

  const linesEl = document.getElementById("invoiceLines");
  linesEl.innerHTML = (inv.lineItems || []).map((l) => `
    <tr>
      <td>${escapeHtml(l.label || l.key || "Line")}${l.note ? `<br><span class="invoice-doc-line-note">${escapeHtml(l.note)}</span>` : ""}</td>
      <td class="num">${escapeHtml(String(l.qty || 1))}</td>
      <td class="num">${fmt(l.unitPrice)}</td>
      <td class="num">${fmt(l.lineTotal)}</td>
    </tr>
  `).join("") || `<tr><td colspan="4" class="invoice-doc-line-empty">No line items yet — generate from the work order to populate.</td></tr>`;

  document.getElementById("invoiceSubtotal").textContent = fmt(inv.subtotal);
  document.getElementById("invoiceHst").textContent = fmt(inv.hst);
  document.getElementById("invoiceTotal").textContent = fmt(inv.total);
  document.getElementById("invoiceNotes").value = inv.notes || "";

  const woLink = document.getElementById("invoiceWoLink");
  if (inv.woId) { woLink.href = `/admin/work-order/${encodeURIComponent(inv.woId)}`; woLink.textContent = inv.woId; }
  else { woLink.removeAttribute("href"); woLink.textContent = "—"; }
  const propLink = document.getElementById("invoicePropertyLink");
  if (inv.propertyId) { propLink.href = `/admin/property/${encodeURIComponent(inv.propertyId)}`; propLink.textContent = "Open property"; }
  else { propLink.removeAttribute("href"); propLink.textContent = "—"; }
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

// ---- QuickBooks push -------------------------------------------------
async function refreshQbBlock() {
  const meta = document.getElementById("invoiceQbMeta");
  const btn = document.getElementById("invoiceQbPushBtn");
  if (!meta || !btn || !currentInvoice) return;
  try {
    const r = await fetch("/api/admin/quickbooks/status", { cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!data.ok || !data.configured) {
      meta.innerHTML = `Not configured. <a href="/admin/settings">Set it up in Settings</a>.`;
      btn.hidden = true;
      return;
    }
    if (!data.connected) {
      meta.innerHTML = `Configured but not connected. <a href="/admin/settings">Connect in Settings</a>.`;
      btn.hidden = true;
      return;
    }
    if (currentInvoice.quickbooksInvoiceId) {
      meta.textContent = `Synced to QuickBooks: invoice ${currentInvoice.quickbooksInvoiceId}.`;
      btn.textContent = "Re-push to QuickBooks";
    } else {
      meta.textContent = "Not yet pushed to QuickBooks.";
      btn.textContent = "Push to QuickBooks";
    }
    btn.hidden = false;
  } catch (err) {
    meta.textContent = "Couldn't check QuickBooks status: " + err.message;
    btn.hidden = true;
  }
}

document.getElementById("invoiceQbPushBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("invoiceQbPushBtn");
  const status = document.getElementById("invoiceQbStatus");
  btn.disabled = true;
  status.textContent = "Pushing to QuickBooks…";
  status.dataset.kind = "info";
  try {
    const r = await fetch(`/api/admin/quickbooks/invoice/${encodeURIComponent(idFromPath)}/push`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Push failed.");
    currentInvoice = data.invoice;
    status.textContent = `✓ ${data.qbAction === "updated" ? "Updated" : "Pushed"} successfully — QB invoice ${data.invoice.quickbooksInvoiceId}.`;
    status.dataset.kind = "ok";
    refreshQbBlock();
  } catch (err) {
    status.textContent = err.message || "Push failed.";
    status.dataset.kind = "error";
  } finally {
    btn.disabled = false;
  }
});

// Wire QB block refresh into the existing invoice render path so it
// updates whenever the invoice is loaded.
const origRender = render;
render = function (inv) {
  origRender(inv);
  refreshQbBlock();
};

load();
