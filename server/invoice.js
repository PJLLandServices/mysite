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
  // PDF action buttons — open in new tab vs. force download. Both hit
  // the same /api/invoices/:id/pdf route in server.js; ?download=1
  // flips Content-Disposition between inline and attachment so Chrome /
  // Safari / Firefox honour the user's intent uniformly.
  const pdfBase = `/api/invoices/${encodeURIComponent(inv.id)}/pdf`;
  const pdfLinkEl = document.getElementById("invoicePdfLink");
  const pdfDownloadEl = document.getElementById("invoicePdfDownload");
  if (pdfLinkEl) pdfLinkEl.href = pdfBase;
  if (pdfDownloadEl) {
    pdfDownloadEl.href = `${pdfBase}?download=1`;
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

  // Authorization posture — admin-only display. Surfaces which path
  // (drawn signature vs signature bypass) authorized this invoice so
  // Patrick can audit the legal record without opening the WO. Fetched
  // lazily so the invoice render isn't blocked on a second round-trip.
  refreshAuthPosture(inv.woId).catch(() => {});
  const propLink = document.getElementById("invoicePropertyLink");
  if (inv.propertyId) { propLink.href = `/admin/property/${encodeURIComponent(inv.propertyId)}`; propLink.textContent = "Open property"; }
  else { propLink.removeAttribute("href"); propLink.textContent = "—"; }

  // Email-to-customer card. Button label + style flip based on status:
  //   draft           → amber primary "Send to customer"
  //   sent/paid/void  → outlined green "Resend" + "Sent <date> to <email>"
  //                     line. Void cannot be resent (server enforces; UI
  //                     greys the button to make it visible).
  const sendBtn = document.getElementById("invoiceSendBtn");
  const sentMeta = document.getElementById("invoiceSentMeta");
  const sendStatus = document.getElementById("invoiceSendStatus");
  if (sendBtn && sentMeta && sendStatus) {
    sendStatus.textContent = "";
    sendStatus.dataset.kind = "";
    if (inv.status === "draft") {
      sendBtn.textContent = "Send to customer";
      sendBtn.classList.remove("invoice-action-btn--outline");
      sendBtn.classList.add("invoice-action-btn--amber");
      sendBtn.disabled = false;
      sentMeta.textContent = inv.customerEmail
        ? `Will email to: ${inv.customerEmail}`
        : "⚠ No customer email on file — add one before sending.";
    } else if (inv.status === "void") {
      sendBtn.textContent = "Resend";
      sendBtn.classList.remove("invoice-action-btn--amber");
      sendBtn.classList.add("invoice-action-btn--outline");
      sendBtn.disabled = true;
      sentMeta.textContent = "Voided — cannot resend.";
    } else {
      // sent or paid
      sendBtn.textContent = "Resend";
      sendBtn.classList.remove("invoice-action-btn--amber");
      sendBtn.classList.add("invoice-action-btn--outline");
      sendBtn.disabled = !inv.customerEmail;
      const sentBit = inv.sentAt ? `Sent ${fmtDate(inv.sentAt)}` : "Sent (no timestamp)";
      const toBit = inv.customerEmail ? ` to ${inv.customerEmail}` : "";
      sentMeta.textContent = sentBit + toBit;
    }
  }
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

// ---- Send / Resend invoice email -------------------------------------
// Single click handler covers both first-send (status:draft → POST /send)
// and re-email (any other status → POST /resend). Server-side route is
// the source of truth for which transitions are allowed; the UI just
// asks confirmation, fires the POST, and re-renders on the response.
document.getElementById("invoiceSendBtn")?.addEventListener("click", async () => {
  if (!currentInvoice) return;
  const isResend = currentInvoice.status !== "draft";
  const action = isResend ? "resend" : "send";
  const recipient = currentInvoice.customerEmail;
  if (!recipient) {
    alert("This invoice has no customer email. Add one in the bill-to section first.");
    return;
  }
  // Confirm with the recipient + total in the prompt so the admin can
  // catch a wrong email or wrong invoice before anything goes out.
  const confirmMsg = isResend
    ? `Resend invoice ${currentInvoice.id} (${fmt(currentInvoice.total)}) to ${recipient}?`
    : `Send invoice ${currentInvoice.id} (${fmt(currentInvoice.total)}) to ${recipient}?\n\n` +
      `Status will flip from Draft to Sent and the customer will receive the branded PDF by email.`;
  if (!confirm(confirmMsg)) return;

  const btn = document.getElementById("invoiceSendBtn");
  const status = document.getElementById("invoiceSendStatus");
  const wasLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = isResend ? "Resending…" : "Sending…";
  status.textContent = "";
  status.dataset.kind = "info";
  try {
    const r = await fetch(`/api/invoices/${encodeURIComponent(idFromPath)}/${action}`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Send failed.");
    currentInvoice = data.invoice;
    // Surface a non-blocking warning if the QB push failed but the
    // email still went out — the brief's "log + warn + continue" rule.
    if (data.warning) {
      status.textContent = `✓ Sent. ${data.warning}`;
      status.dataset.kind = "info";
    } else if (data.qbInvoiceId) {
      status.textContent = `✓ Sent. QuickBooks invoice ${data.qbInvoiceId} (${data.qbAction}).`;
      status.dataset.kind = "ok";
    } else {
      status.textContent = isResend ? "✓ Re-sent to customer." : "✓ Sent to customer.";
      status.dataset.kind = "ok";
    }
    render(data.invoice);
  } catch (err) {
    status.textContent = err.message || "Failed.";
    status.dataset.kind = "error";
    btn.disabled = false;
    btn.textContent = wasLabel;
  }
});

// Wire QB block refresh into the existing invoice render path so it
// updates whenever the invoice is loaded.
const origRender = render;
render = function (inv) {
  origRender(inv);
  refreshQbBlock();
};

// ---- Authorization posture (admin-only) -----------------------------
// Pulls the linked WO and renders which path authorized this invoice:
//   - drawn signature  → "Signed by [name] on [date]"
//   - signature bypass → "Verbal acceptance bypass recorded by [admin]
//                         on [date] — reason: [reason]"
// Customer-facing PDF + email do NOT include this info per the
// Signature Bypass for WO Completion brief §3.4.4 (admin-only visibility).
async function refreshAuthPosture(woId) {
  const card = document.getElementById("invoiceAuthCard");
  const summary = document.getElementById("invoiceAuthSummary");
  const detail = document.getElementById("invoiceAuthDetail");
  if (!card || !summary) return;
  if (!woId) { card.hidden = true; return; }
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(woId)}`, { cache: "no-store" });
    if (!r.ok) { card.hidden = true; return; }
    const data = await r.json().catch(() => ({}));
    const wo = data && data.ok && data.workOrder ? data.workOrder : null;
    if (!wo) { card.hidden = true; return; }

    if (wo.signatureBypass) {
      const b = wo.signatureBypass;
      const reasonLabel = bypassReasonLabel(b.reason);
      const by = b.bypassedBy || "admin";
      card.hidden = false;
      summary.textContent = `Verbal acceptance bypass recorded by ${by} on ${fmtDate(b.ts)} — reason: ${reasonLabel}`;
      if (detail) {
        if (b.note) { detail.hidden = false; detail.textContent = b.note; }
        else { detail.hidden = true; detail.textContent = ""; }
      }
      return;
    }
    if (wo.signature && wo.signature.signed) {
      const s = wo.signature;
      card.hidden = false;
      summary.textContent = `Signed by ${s.customerName || "(unknown)"} on ${fmtDate(s.signedAt)}`;
      if (detail) { detail.hidden = true; detail.textContent = ""; }
      return;
    }
    // WO exists but not yet authorized — useful signal on a draft invoice.
    card.hidden = false;
    summary.textContent = "WO not yet signed or bypassed.";
    if (detail) { detail.hidden = true; detail.textContent = ""; }
  } catch (_e) {
    card.hidden = true;
  }
}

function bypassReasonLabel(slug) {
  switch (slug) {
    case "customer_not_home": return "Customer not home";
    case "trusted_customer_verbal": return "Trusted customer — verbal acceptance";
    case "other": return "Other";
    default: return "Signature bypass";
  }
}

load();
