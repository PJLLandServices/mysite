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
// Cached customer record for spouse-CC fields. Fetched after the
// invoice loads so the three per-send "CC spouse" toggles can pre-fill
// from copySpouseOnInvoices + show the spouseEmail / spousePhone
// disclosure text. Null when the invoice has no customerId.
let currentCustomer = null;

let currentDisclaimerObjects = [];

async function load() {
  if (!idFromPath) return;
  const r = await fetch(`/api/invoices/${encodeURIComponent(idFromPath)}`, { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!data.ok || !data.invoice) {
    loading.textContent = "Invoice not found.";
    return;
  }
  currentInvoice = data.invoice;
  currentDisclaimerObjects = Array.isArray(data.disclaimerObjects) ? data.disclaimerObjects : [];
  // Fetch the customer record so the spouse-CC toggles can pre-fill
  // from copySpouseOnInvoices. Non-fatal — invoices without a
  // customerId or whose customer fetch fails just hide the toggles.
  currentCustomer = null;
  if (currentInvoice.customerId) {
    try {
      const cr = await fetch(`/api/customer/${encodeURIComponent(currentInvoice.customerId)}`, { cache: "no-store" });
      const cd = await cr.json().catch(() => ({}));
      if (cd && cd.ok && cd.customer) currentCustomer = cd.customer;
    } catch (_) { /* tolerate */ }
  }
  render(data.invoice);
  syncSpouseToggles();
}

// Initialize the three per-send CC-spouse toggles from the cached
// customer record. Called after every render. Each toggle is hidden
// when the spouse channel (email or phone) is empty; visible + pre-
// checked when copySpouseOnInvoices is true.
function syncSpouseToggles() {
  const cust = currentCustomer || {};
  const flag = cust.copySpouseOnInvoices === true;
  const spouseEmail = (cust.spouseEmail || "").trim();
  const spousePhone = (cust.spousePhone || "").trim();

  function wire(toggleId, checkboxId, disclosureId, channelValue, label) {
    const toggle = document.getElementById(toggleId);
    const checkbox = document.getElementById(checkboxId);
    const disclosure = document.getElementById(disclosureId);
    if (!toggle || !checkbox || !disclosure) return;
    if (!channelValue) {
      // No spouse channel of this type — hide the whole row.
      toggle.hidden = true;
      disclosure.hidden = true;
      checkbox.checked = false;
      return;
    }
    toggle.hidden = false;
    checkbox.checked = flag;
    if (flag) {
      disclosure.hidden = false;
      disclosure.textContent = `Will also CC: ${channelValue}`;
    } else {
      disclosure.hidden = true;
    }
    // Re-check the disclosure when the checkbox flips.
    if (!checkbox.dataset.spouseWired) {
      checkbox.dataset.spouseWired = "1";
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          disclosure.hidden = false;
          disclosure.textContent = `Will also CC: ${channelValue}`;
        } else {
          disclosure.hidden = true;
        }
      });
    }
  }
  wire("invoiceSendSpouseToggle", "invoiceSendSpouseCheckbox", "invoiceSendSpouseDisclosure", spouseEmail, "spouse email");
  wire("invoiceReminderSpouseToggle", "invoiceReminderSpouseCheckbox", "invoiceReminderSpouseDisclosure", spousePhone, "spouse phone");
  wire("invoiceJunkWarningSpouseToggle", "invoiceJunkWarningSpouseCheckbox", "invoiceJunkWarningSpouseDisclosure", spousePhone, "spouse phone");
}

// Read the checkbox state for a given send action. Returns boolean
// when the toggle is visible, null when hidden (server interprets
// null as "use the customer's profile flag default"). The latter
// case shouldn't happen if the toggles are wired correctly, but
// stays as defense-in-depth.
function readSpouseToggle(checkboxId, toggleId) {
  const toggle = document.getElementById(toggleId);
  const checkbox = document.getElementById(checkboxId);
  if (!toggle || !checkbox || toggle.hidden) return null;
  return checkbox.checked;
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

  // Bill-to vs service address (billing-party brief). The billTo
  // snapshot is set at draft time; when it names a different payer or
  // address, the Bill-to column carries the payer and the service
  // address gets its own column. Self-billing (snapshot identical) and
  // legacy invoices (billTo null) render exactly as before.
  const billTo = inv.billTo && typeof inv.billTo === "object" ? inv.billTo : null;
  const billToNameDiffers = Boolean(billTo && billTo.name && billTo.name !== (inv.customerName || ""));
  const billToDiffers = Boolean(billTo) && (
    billToNameDiffers || Boolean(billTo.address && billTo.address !== (inv.address || ""))
  );
  const serviceCol = document.getElementById("invoiceServiceCol");
  if (billToDiffers) {
    document.getElementById("invoiceCustomerName").textContent = billTo.name || inv.customerName || "—";
    document.getElementById("invoiceCustomerAddress").textContent = billTo.address || inv.address || "";
    // The paying entity never inherits the service contact's phone.
    document.getElementById("invoiceCustomerContact").textContent = billTo.email || "";
    if (serviceCol) {
      serviceCol.hidden = false;
      document.getElementById("invoiceServiceName").textContent = inv.customerName || "—";
      document.getElementById("invoiceServiceAddress").textContent = inv.address || "";
    }
  } else {
    document.getElementById("invoiceCustomerName").textContent = inv.customerName || "—";
    document.getElementById("invoiceCustomerAddress").textContent = inv.address || "";
    const contact = [inv.customerPhone, inv.customerEmail].filter(Boolean).join(" · ");
    document.getElementById("invoiceCustomerContact").textContent = contact;
    if (serviceCol) serviceCol.hidden = true;
  }

  // Bill-to editor card — inputs while draft, read-only line after.
  const billToEdit = document.getElementById("invoiceBillToEdit");
  const billToReadonly = document.getElementById("invoiceBillToReadonly");
  if (billToEdit && billToReadonly) {
    const effective = {
      name: billTo?.name || inv.customerName || "",
      address: billTo?.address || inv.address || "",
      email: billTo?.email || inv.customerEmail || ""
    };
    if (inv.status === "draft") {
      billToEdit.hidden = false;
      billToReadonly.hidden = true;
      document.getElementById("invoiceBillToName").value = effective.name;
      document.getElementById("invoiceBillToAddress").value = effective.address;
      document.getElementById("invoiceBillToEmail").value = effective.email;
    } else {
      billToEdit.hidden = true;
      billToReadonly.hidden = false;
      billToReadonly.textContent = `${effective.name}${effective.address ? " · " + effective.address : ""}${effective.email ? " · " + effective.email : ""} (locked after send)`;
    }
  }

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

  // Disclaimer callouts (e.g. fall_additional_plumbing). Server returns
  // the resolved { title, body } pairs in disclaimerObjects so the
  // client doesn't carry a copy of the text. Rendered as one card per
  // key, below totals, above terms.
  const discEl = document.getElementById("invoiceDisclaimers");
  if (discEl) {
    if (!currentDisclaimerObjects.length) {
      discEl.hidden = true;
      discEl.innerHTML = "";
    } else {
      discEl.hidden = false;
      discEl.innerHTML = currentDisclaimerObjects.map((d) => `
        <article class="invoice-doc-disclaimer" data-key="${escapeHtml(d.key)}" style="margin: 14px 0 0; padding: 14px 16px; background: #fff8ec; border: 1px solid #e3b97a; border-left: 4px solid #c97824; border-radius: 6px;">
          <h3 style="margin: 0 0 6px; font-size: 13px; font-weight: 700; color: #6b3a09; text-transform: uppercase; letter-spacing: 0.04em;">${escapeHtml(d.title)}</h3>
          <p style="margin: 0; font-size: 13px; color: #2b2a26; line-height: 1.5;">${escapeHtml(d.body)}</p>
        </article>
      `).join("");
    }
  }

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

  // SMS-to-customer card (Invoice SMS brief). Three timeline states:
  //   1. paid-on-site / opted-out / no-phone → "Not scheduled (<reason>)"
  //   2. scheduled, not yet sent             → "Scheduled for <ts>"
  //   3. sent                                → "Sent <ts>"
  // Skip reasons fall out of the history entries the cascade / sender
  // stamps; the most-recent customer_sms_* entry wins.
  const smsStatusLine = document.getElementById("invoiceSmsStatusLine");
  const smsSentLine = document.getElementById("invoiceSmsSentLine");
  const smsScheduledLine = document.getElementById("invoiceSmsScheduledLine");
  if (smsStatusLine && smsSentLine && smsScheduledLine) {
    smsSentLine.hidden = true;
    smsScheduledLine.hidden = true;
    if (inv.customerSmsSentAt) {
      smsStatusLine.textContent = "Sent";
      smsSentLine.hidden = false;
      smsSentLine.textContent = `Sent at: ${fmtDate(inv.customerSmsSentAt)}`;
      if (inv.customerSmsScheduledAt) {
        smsScheduledLine.hidden = false;
        smsScheduledLine.textContent = `Scheduled at: ${fmtDate(inv.customerSmsScheduledAt)}`;
      }
    } else if (inv.customerSmsScheduledAt) {
      smsStatusLine.textContent = "Scheduled";
      smsScheduledLine.hidden = false;
      smsScheduledLine.textContent = `Scheduled at: ${fmtDate(inv.customerSmsScheduledAt)}`;
    } else {
      // No schedule and no send — read the most recent customer_sms_*
      // history entry to surface the skip reason. Falls back to a
      // generic "Not scheduled" line when no entry is present
      // (e.g. paid-on-site invoice).
      const lastSmsEntry = (Array.isArray(inv.history) ? inv.history : [])
        .slice()
        .reverse()
        .find((h) => typeof h?.action === "string" && h.action.startsWith("customer_sms_"));
      if (lastSmsEntry) {
        const reasonMap = {
          customer_sms_skipped_opted_out: "Not scheduled — customer opted out of text reminders",
          customer_sms_skipped_no_phone: "Not scheduled — no customer phone on invoice",
          customer_sms_skipped_voided: "Not scheduled — invoice voided",
          customer_sms_skipped_paid: "Not scheduled — invoice already paid",
          customer_sms_failed: "Failed — see invoice history"
        };
        smsStatusLine.textContent = reasonMap[lastSmsEntry.action] || "Not scheduled";
      } else if (inv.paidOnSiteAtCompletion) {
        smsStatusLine.textContent = "Not scheduled (paid on site)";
      } else {
        smsStatusLine.textContent = "Not scheduled";
      }
    }
  }

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

// ---- Bill-to editor (billing-party brief) -----------------------------
// PATCHes the billTo snapshot. Server-side, invoices.update() rejects
// the edit unless status === "draft" — the UI hides the inputs on
// non-draft invoices, this is just the matching write path.
document.getElementById("invoiceBillToSave")?.addEventListener("click", async () => {
  const statusEl = document.getElementById("invoiceBillToStatus");
  const billTo = {
    name: document.getElementById("invoiceBillToName").value.trim(),
    address: document.getElementById("invoiceBillToAddress").value.trim(),
    email: document.getElementById("invoiceBillToEmail").value.trim()
  };
  if (!billTo.name || !billTo.address) {
    if (statusEl) statusEl.textContent = "Bill-to needs at least a name and an address.";
    return;
  }
  try {
    if (statusEl) statusEl.textContent = "Saving…";
    const r = await fetch(`/api/invoices/${encodeURIComponent(idFromPath)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ billTo })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't save bill-to.");
    currentInvoice = data.invoice;
    if (statusEl) statusEl.textContent = "Saved.";
    render(data.invoice);
  } catch (err) {
    if (statusEl) statusEl.textContent = err.message || "Failed.";
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
    // Per-send "CC spouse" override. Read the checkbox; null when hidden.
    const includeSpouse = readSpouseToggle("invoiceSendSpouseCheckbox", "invoiceSendSpouseToggle");
    const r = await fetch(`/api/invoices/${encodeURIComponent(idFromPath)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(includeSpouse === null ? {} : { includeSpouse })
    });
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

// ---- Manual reminder SMS (Invoice Reminder brief) -------------------
//
// The "Send reminder SMS" button on the invoice page fires a manual
// follow-up SMS distinct from the auto-fire (which only sends once,
// ~5 min after WO completion). Server enforces a 1-hour rate limit
// based on customerReminderHistory[]; this UI:
//   - disables the button when the invoice is paid or voided
//   - renders the rate-limit countdown live ("Available in 42 min")
//   - shows a history list of every prior attempt with success/error
//   - on success, refreshes from server response (no extra round-trip)
const REMINDER_RATE_LIMIT_MS = 60 * 60 * 1000;

function fmtAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem ? `${hrs}h ${rem}m ago` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function renderReminderCard(inv) {
  const meta = document.getElementById("invoiceReminderMeta");
  const btn = document.getElementById("invoiceReminderBtn");
  const status = document.getElementById("invoiceReminderStatus");
  const list = document.getElementById("invoiceReminderHistory");
  if (!meta || !btn || !status || !list) return;

  // Clear transient status when we re-render (a fresh load shouldn't
  // carry over a stale "Sending…" or error from the last click).
  status.textContent = "";
  status.dataset.kind = "";

  const history = Array.isArray(inv?.customerReminderHistory)
    ? inv.customerReminderHistory
    : [];
  const lastSuccessful = [...history].reverse().find((h) => h?.success === true);

  // Button state — paid/voided disable entirely. Otherwise rate-limit
  // check using the last successful send. The button's enabled state
  // is the UI-side guardrail; the server enforces independently.
  if (inv?.status === "paid") {
    btn.disabled = true;
    btn.textContent = "Reminder SMS";
    meta.textContent = "Invoice paid — no reminder needed.";
  } else if (inv?.status === "void") {
    btn.disabled = true;
    btn.textContent = "Reminder SMS";
    meta.textContent = "Invoice voided — reminder disabled.";
  } else if (lastSuccessful?.sentAt) {
    const elapsed = Date.now() - Date.parse(lastSuccessful.sentAt);
    if (Number.isFinite(elapsed) && elapsed < REMINDER_RATE_LIMIT_MS) {
      const remainMin = Math.ceil((REMINDER_RATE_LIMIT_MS - elapsed) / 60000);
      btn.disabled = true;
      btn.textContent = `📱 Available in ${remainMin} min`;
      meta.textContent = `Last reminder ${fmtAgo(lastSuccessful.sentAt)}. Minimum 1 hour between manual reminders.`;
    } else {
      btn.disabled = false;
      btn.textContent = "📱 Send reminder SMS";
      meta.textContent = inv.customerPhone
        ? `Will send to ${inv.customerPhone}. Last reminder ${fmtAgo(lastSuccessful.sentAt)}.`
        : "⚠ No customer phone on this invoice.";
    }
  } else {
    btn.disabled = false;
    btn.textContent = "📱 Send reminder SMS";
    meta.textContent = inv?.customerPhone
      ? `Will send to ${inv.customerPhone}.`
      : "⚠ No customer phone on this invoice.";
  }

  // History list — most recent first. Show timestamp + outcome (success
  // shows the SMS body so admin can confirm what the customer received).
  list.innerHTML = "";
  if (history.length === 0) {
    list.hidden = true;
  } else {
    list.hidden = false;
    const sorted = [...history].reverse();
    for (const entry of sorted) {
      const li = document.createElement("li");
      const when = fmtDate(entry.sentAt);
      const ago = fmtAgo(entry.sentAt);
      if (entry.success) {
        li.innerHTML = `<strong>Sent</strong> on ${when} <span class="invoice-action-meta">(${ago})</span>`;
        if (entry.body) {
          const body = document.createElement("p");
          body.className = "invoice-action-meta";
          body.style.cssText = "margin: 4px 0 0; font-style: italic; opacity: 0.85;";
          body.textContent = `"${entry.body}"`;
          li.appendChild(body);
        }
      } else {
        const reason = entry.reason ? ` — ${entry.reason}` : "";
        const err = entry.error ? `: ${entry.error}` : "";
        li.innerHTML = `<strong>Skipped/failed</strong> on ${when}${reason}${err} <span class="invoice-action-meta">(${ago})</span>`;
      }
      list.appendChild(li);
    }
  }
}

document.getElementById("invoiceReminderBtn")?.addEventListener("click", async () => {
  if (!currentInvoice) return;

  const recipient = currentInvoice.customerPhone || "the customer";
  const customerName = currentInvoice.customerName || "this customer";
  if (!confirm(`Send a reminder SMS to ${customerName} at ${recipient}?`)) return;

  const btn = document.getElementById("invoiceReminderBtn");
  const status = document.getElementById("invoiceReminderStatus");
  const wasLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Sending…";
  status.textContent = "";
  status.dataset.kind = "info";

  try {
    const includeSpouse = readSpouseToggle("invoiceReminderSpouseCheckbox", "invoiceReminderSpouseToggle");
    const baseBody = includeSpouse === null ? {} : { includeSpouse };
    const r = await fetch(`/api/invoices/${encodeURIComponent(idFromPath)}/send-reminder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody)
    });
    const data = await r.json().catch(() => ({}));

    if (r.ok && data.ok) {
      status.textContent = `✓ Reminder sent at ${fmtDate(data.sentAt)}.`;
      status.dataset.kind = "ok";
      if (data.invoice) {
        currentInvoice = data.invoice;
        renderReminderCard(data.invoice);
      }
      return;
    }

    // 429 rate-limit — offer force override.
    if (r.status === 429 && data.error === "rate_limited") {
      btn.textContent = wasLabel;
      btn.disabled = false;
      status.dataset.kind = "warn";
      const serverMsg = (data.errors && data.errors[0]) || "Rate-limited.";
      status.textContent = serverMsg;
      const forceConfirm = confirm(`${serverMsg}\n\nSend anyway (override the rate limit)?`);
      if (forceConfirm) {
        btn.disabled = true;
        btn.textContent = "Sending…";
        status.textContent = "";
        const r2 = await fetch(`/api/invoices/${encodeURIComponent(idFromPath)}/send-reminder`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...baseBody, force: true })
        });
        const data2 = await r2.json().catch(() => ({}));
        if (r2.ok && data2.ok) {
          status.textContent = `✓ Reminder sent at ${fmtDate(data2.sentAt)} (override).`;
          status.dataset.kind = "ok";
          if (data2.invoice) {
            currentInvoice = data2.invoice;
            renderReminderCard(data2.invoice);
          }
        } else {
          status.textContent = (data2.errors && data2.errors[0]) || "Force send failed.";
          status.dataset.kind = "error";
          btn.disabled = false;
          btn.textContent = wasLabel;
        }
      }
      return;
    }

    // 409 skip conditions or 502 Twilio failure — surface the message,
    // re-enable the button (unless it's a hard "paid"/"voided" state,
    // which the next render will disable anyway).
    const msg = (data.errors && data.errors[0]) || data.error || "Reminder not sent.";
    status.textContent = msg;
    status.dataset.kind = "error";
    if (data.invoice) {
      currentInvoice = data.invoice;
      renderReminderCard(data.invoice);
    } else {
      btn.disabled = false;
      btn.textContent = wasLabel;
    }
  } catch (err) {
    status.textContent = err.message || "Network error.";
    status.dataset.kind = "error";
    btn.disabled = false;
    btn.textContent = wasLabel;
  }
});

// ---- Manual junk-mail warning SMS (Junk-Mail Warning brief) ----------
//
// Third SMS surface alongside the auto-fire "invoice ready" and the
// manual reminder. Auto-fires ~30s after each invoice email send/resend
// (server-side setTimeout in /send route). The button on this card is
// the manual override — same 1-hour rate limit + force prompt as the
// reminder card, plus an extra "autofire_recent" skip code (409) when
// the auto-fire "invoice ready" SMS landed in the last 5 min (the auto-
// fire body already mentions junk/spam — a second SMS in that window
// would be noise). The force prompt offers to override both the rate
// limit AND the autofire blackout.
const JUNK_WARNING_RATE_LIMIT_MS = 60 * 60 * 1000;

function renderJunkWarningCard(inv) {
  const meta = document.getElementById("invoiceJunkWarningMeta");
  const btn = document.getElementById("invoiceJunkWarningBtn");
  const status = document.getElementById("invoiceJunkWarningStatus");
  const list = document.getElementById("invoiceJunkWarningHistory");
  if (!meta || !btn || !status || !list) return;

  status.textContent = "";
  status.dataset.kind = "";

  const history = Array.isArray(inv?.customerJunkMailWarningHistory)
    ? inv.customerJunkMailWarningHistory
    : [];
  const lastSuccessful = [...history].reverse().find((h) => h?.success === true);

  if (inv?.status === "paid") {
    btn.disabled = true;
    btn.textContent = "Warning SMS";
    meta.textContent = "Invoice paid — warning disabled.";
  } else if (inv?.status === "void") {
    btn.disabled = true;
    btn.textContent = "Warning SMS";
    meta.textContent = "Invoice voided — warning disabled.";
  } else if (lastSuccessful?.sentAt) {
    const elapsed = Date.now() - Date.parse(lastSuccessful.sentAt);
    if (Number.isFinite(elapsed) && elapsed < JUNK_WARNING_RATE_LIMIT_MS) {
      const remainMin = Math.ceil((JUNK_WARNING_RATE_LIMIT_MS - elapsed) / 60000);
      btn.disabled = true;
      btn.textContent = `📱 Available in ${remainMin} min`;
      meta.textContent = `Last warning ${fmtAgo(lastSuccessful.sentAt)}. Auto-fires on every email /send; manual rate-limit 1h.`;
    } else {
      btn.disabled = false;
      btn.textContent = "📱 Send warning now";
      meta.textContent = inv.customerPhone
        ? `Auto-fires ~30s after each email /send. Last warning ${fmtAgo(lastSuccessful.sentAt)}.`
        : "⚠ No customer phone on this invoice.";
    }
  } else {
    btn.disabled = false;
    btn.textContent = "📱 Send warning now";
    meta.textContent = inv?.customerPhone
      ? `Will send automatically when invoice email is sent. Or fire manually to ${inv.customerPhone}.`
      : "⚠ No customer phone on this invoice.";
  }

  // History list — most recent first; same shape/style as the reminder
  // history. Skip entries (reason: autofire_recent, opted_out, etc.)
  // show as "Skipped/failed" with the reason inline.
  list.innerHTML = "";
  if (history.length === 0) {
    list.hidden = true;
  } else {
    list.hidden = false;
    const sorted = [...history].reverse();
    for (const entry of sorted) {
      const li = document.createElement("li");
      const when = fmtDate(entry.sentAt);
      const ago = fmtAgo(entry.sentAt);
      if (entry.success) {
        li.innerHTML = `<strong>Sent</strong> on ${when} <span class="invoice-action-meta">(${ago})</span>`;
        if (entry.body) {
          const body = document.createElement("p");
          body.className = "invoice-action-meta";
          body.style.cssText = "margin: 4px 0 0; font-style: italic; opacity: 0.85;";
          body.textContent = `"${entry.body}"`;
          li.appendChild(body);
        }
      } else {
        const reason = entry.reason ? ` — ${entry.reason}` : "";
        const err = entry.error ? `: ${entry.error}` : "";
        li.innerHTML = `<strong>Skipped/failed</strong> on ${when}${reason}${err} <span class="invoice-action-meta">(${ago})</span>`;
      }
      list.appendChild(li);
    }
  }
}

document.getElementById("invoiceJunkWarningBtn")?.addEventListener("click", async () => {
  if (!currentInvoice) return;

  const recipient = currentInvoice.customerPhone || "the customer";
  const customerName = currentInvoice.customerName || "this customer";
  if (!confirm(`Send a junk-mail warning SMS to ${customerName} at ${recipient}?`)) return;

  const btn = document.getElementById("invoiceJunkWarningBtn");
  const status = document.getElementById("invoiceJunkWarningStatus");
  const wasLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Sending…";
  status.textContent = "";
  status.dataset.kind = "info";

  const post = async (body) => {
    const r = await fetch(`/api/invoices/${encodeURIComponent(idFromPath)}/send-junk-warning`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    });
    const data = await r.json().catch(() => ({}));
    return { r, data };
  };

  try {
    const includeSpouse = readSpouseToggle("invoiceJunkWarningSpouseCheckbox", "invoiceJunkWarningSpouseToggle");
    const baseBody = includeSpouse === null ? {} : { includeSpouse };
    const { r, data } = await post(baseBody);

    if (r.ok && data.ok) {
      status.textContent = `✓ Warning sent at ${fmtDate(data.sentAt)}.`;
      status.dataset.kind = "ok";
      if (data.invoice) {
        currentInvoice = data.invoice;
        renderJunkWarningCard(data.invoice);
      }
      return;
    }

    // 429 rate limit OR 409 autofire_recent both offer a force override
    // (matches the lib's behavior — force: true bypasses both gates).
    const offersForce = r.status === 429 || (r.status === 409 && data.error === "autofire_recent");
    if (offersForce) {
      btn.textContent = wasLabel;
      btn.disabled = false;
      status.dataset.kind = "warn";
      const serverMsg = (data.errors && data.errors[0]) || "Skipped.";
      status.textContent = serverMsg;
      const forceConfirm = confirm(`${serverMsg}\n\nSend anyway?`);
      if (forceConfirm) {
        btn.disabled = true;
        btn.textContent = "Sending…";
        status.textContent = "";
        const { r: r2, data: data2 } = await post({ ...baseBody, force: true });
        if (r2.ok && data2.ok) {
          status.textContent = `✓ Warning sent at ${fmtDate(data2.sentAt)} (override).`;
          status.dataset.kind = "ok";
          if (data2.invoice) {
            currentInvoice = data2.invoice;
            renderJunkWarningCard(data2.invoice);
          }
        } else {
          status.textContent = (data2.errors && data2.errors[0]) || "Force send failed.";
          status.dataset.kind = "error";
          btn.disabled = false;
          btn.textContent = wasLabel;
        }
      }
      return;
    }

    const msg = (data.errors && data.errors[0]) || data.error || "Warning not sent.";
    status.textContent = msg;
    status.dataset.kind = "error";
    if (data.invoice) {
      currentInvoice = data.invoice;
      renderJunkWarningCard(data.invoice);
    } else {
      btn.disabled = false;
      btn.textContent = wasLabel;
    }
  } catch (err) {
    status.textContent = err.message || "Network error.";
    status.dataset.kind = "error";
    btn.disabled = false;
    btn.textContent = wasLabel;
  }
});

// ---- Void + delete (feature-invoice-void-delete-brief.md §4.4) --------
//
// Void is offered on draft/sent; Delete is offered ONLY once the invoice
// is void. Void-first is the mandatory road to deletion. Both actions run
// through a modal — void's reason is optional, delete's reason is required
// and pre-fills from the void reason.

function renderVoidDeleteCard(inv) {
  const voidBtn = document.getElementById("invoiceVoidBtn");
  const deleteBtn = document.getElementById("invoiceDeleteBtn");
  const meta = document.getElementById("invoiceVoidMeta");
  if (!voidBtn || !deleteBtn || !meta) return;

  const status = inv?.status;
  const canVoid = status === "draft" || status === "sent";
  const isVoid = status === "void";

  voidBtn.hidden = !canVoid;
  deleteBtn.hidden = !isVoid;

  if (isVoid) {
    meta.hidden = false;
    const who = inv.voidedBy ? ` by ${inv.voidedBy}` : "";
    const when = inv.voidedAt ? ` on ${fmtDate(inv.voidedAt)}` : "";
    const why = inv.voidReason ? ` — “${inv.voidReason}”` : "";
    meta.textContent = `Voided${who}${when}${why}. Delete removes it permanently (a snapshot is kept in the audit log).`;
  } else if (status === "paid") {
    // A paid invoice can't be voided/deleted here — say so instead of an
    // empty card.
    meta.hidden = false;
    meta.textContent = "Paid invoices can’t be voided or deleted here (that’s a QuickBooks credit-memo).";
  } else {
    meta.hidden = true;
    meta.textContent = "";
  }
}

// --- Modal helpers ---
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.hidden = false;
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.hidden = true;
}

// Void modal
document.getElementById("invoiceVoidBtn")?.addEventListener("click", () => {
  const err = document.getElementById("voidModalError");
  if (err) err.textContent = "";
  const input = document.getElementById("voidReasonInput");
  if (input) input.value = "";
  openModal("voidModal");
  setTimeout(() => input?.focus(), 0);
});
document.getElementById("voidCancelBtn")?.addEventListener("click", () => closeModal("voidModal"));
document.getElementById("voidModal")?.addEventListener("click", (e) => {
  if (e.target === document.getElementById("voidModal")) closeModal("voidModal");
});

document.getElementById("voidConfirmBtn")?.addEventListener("click", async () => {
  if (!currentInvoice) return;
  const btn = document.getElementById("voidConfirmBtn");
  const err = document.getElementById("voidModalError");
  const reason = document.getElementById("voidReasonInput")?.value || "";
  btn.disabled = true;
  if (err) err.textContent = "";
  try {
    const r = await fetch(`/api/invoices/${encodeURIComponent(idFromPath)}/void`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't void invoice.");
    currentInvoice = data.invoice;
    closeModal("voidModal");
    render(data.invoice);
    if (data.warning) alert(data.warning);
  } catch (e) {
    if (err) err.textContent = e.message || "Failed.";
  } finally {
    btn.disabled = false;
  }
});

// Delete modal — reason dropdown (required) + "confirm delete" checkbox
// + QB checkbox (when a QB id exists). Confirm enables only when a reason
// is chosen AND the delete checkbox is ticked AND (QB ticked where shown).
function syncDeleteConfirmState() {
  const btn = document.getElementById("deleteConfirmBtn");
  const reasonSel = document.getElementById("deleteReasonInput");
  const confirmCheck = document.getElementById("deleteConfirmCheck");
  const qbRow = document.getElementById("deleteQbCheckRow");
  const qbCheck = document.getElementById("deleteQbConfirm");
  if (!btn || !reasonSel || !confirmCheck) return;
  const reasonChosen = Boolean(reasonSel.value);
  const confirmed = Boolean(confirmCheck.checked);
  const qbOk = qbRow && !qbRow.hidden ? Boolean(qbCheck?.checked) : true;
  btn.disabled = !(reasonChosen && confirmed && qbOk);
}

document.getElementById("invoiceDeleteBtn")?.addEventListener("click", () => {
  if (!currentInvoice) return;
  const err = document.getElementById("deleteModalError");
  if (err) err.textContent = "";
  // Pre-select the reason from the void reason when it matches an option;
  // otherwise leave on the "Select a reason…" placeholder.
  const reasonSel = document.getElementById("deleteReasonInput");
  if (reasonSel) {
    const pre = currentInvoice.voidReason || "";
    reasonSel.value = Array.from(reasonSel.options).some((o) => o.value === pre) ? pre : "";
  }
  const confirmCheck = document.getElementById("deleteConfirmCheck");
  if (confirmCheck) confirmCheck.checked = false;
  // QB checkbox only when a QB id exists.
  const qbRow = document.getElementById("deleteQbCheckRow");
  const qbCheck = document.getElementById("deleteQbConfirm");
  if (qbRow) qbRow.hidden = !currentInvoice.quickbooksInvoiceId;
  if (qbCheck) qbCheck.checked = false;
  syncDeleteConfirmState();
  openModal("deleteModal");
  setTimeout(() => reasonSel?.focus(), 0);
});
document.getElementById("deleteCancelBtn")?.addEventListener("click", () => closeModal("deleteModal"));
document.getElementById("deleteModal")?.addEventListener("click", (e) => {
  if (e.target === document.getElementById("deleteModal")) closeModal("deleteModal");
});
document.getElementById("deleteReasonInput")?.addEventListener("change", syncDeleteConfirmState);
document.getElementById("deleteConfirmCheck")?.addEventListener("change", syncDeleteConfirmState);
document.getElementById("deleteQbConfirm")?.addEventListener("change", syncDeleteConfirmState);

document.getElementById("deleteConfirmBtn")?.addEventListener("click", async () => {
  if (!currentInvoice) return;
  const btn = document.getElementById("deleteConfirmBtn");
  const err = document.getElementById("deleteModalError");
  const reason = document.getElementById("deleteReasonInput")?.value || "";
  // The "confirm delete" checkbox is the deliberate gate now; the server
  // still validates confirmId === id, so send the id directly.
  const confirmId = currentInvoice.id;
  const qbRow = document.getElementById("deleteQbCheckRow");
  const qbVoidConfirmed = qbRow && !qbRow.hidden
    ? Boolean(document.getElementById("deleteQbConfirm")?.checked)
    : false;
  if (err) err.textContent = "";
  if (!reason) { if (err) err.textContent = "Choose a reason."; return; }
  btn.disabled = true;
  try {
    const r = await fetch(`/api/invoices/${encodeURIComponent(idFromPath)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason, confirmId, qbVoidConfirmed })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't delete invoice.");
    // Redirect to the index with a toast payload in the query string.
    location.href = `/admin/invoices?deleted=${encodeURIComponent(data.deletedId || currentInvoice.id)}`;
  } catch (e) {
    if (err) err.textContent = e.message || "Failed.";
    syncDeleteConfirmState();
  }
});

// Close either modal on Escape.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!document.getElementById("voidModal")?.hidden) closeModal("voidModal");
  if (!document.getElementById("deleteModal")?.hidden) closeModal("deleteModal");
});

// Wire QB block refresh + reminder card + junk-warning card + void/delete
// card render into the existing invoice render path so all update whenever
// the invoice is loaded.
const origRender = render;
render = function (inv) {
  origRender(inv);
  refreshQbBlock();
  renderReminderCard(inv);
  renderJunkWarningCard(inv);
  renderVoidDeleteCard(inv);
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
      const covers = b.coversQuoteAcceptance === true;
      card.hidden = false;
      // Two posture variants per v2 brief §3.4.4:
      //   bypass-only:               "Verbal acceptance bypass..."
      //   bypass+quote-acceptance:   "Verbal acceptance bypass (incl.
      //                              on-site quote acceptance) ...
      //                              Scope: N line items, $XXX.XX."
      // The "incl." variant signals to whoever reviews the invoice that
      // there is no separate Quote record in the folder — the bypass
      // record is the scope record.
      if (covers && b.acceptedScopeSnapshot) {
        const snap = b.acceptedScopeSnapshot;
        const count = Array.isArray(snap.builderLineItems) ? snap.builderLineItems.length : 0;
        const total = Number(snap.total) || 0;
        summary.textContent = `Verbal acceptance bypass (incl. on-site quote acceptance) recorded by ${by} on ${fmtDate(b.ts)} — reason: ${reasonLabel}. Scope: ${count} line item${count === 1 ? "" : "s"}, $${total.toFixed(2)}.`;
      } else {
        summary.textContent = `Verbal acceptance bypass recorded by ${by} on ${fmtDate(b.ts)} — reason: ${reasonLabel}`;
      }
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
