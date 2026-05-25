// Public portal-invoice view (Invoice SMS brief). Read-only render of a
// single invoice, deep-linked from the customer-ready SMS sent ~5 min
// after the WO completion cascade. Token-gated: the page mounts with
// ?t=<portalToken> in the URL, hands that to /api/portal/invoice/:id,
// and renders whatever sanitized JSON the server returns.
//
// No admin chrome. No card-entry form (that lives on /pay/invoice/:id —
// the "Pay this invoice" button on this page deep-links there).

(function () {
  const idFromPath = (() => {
    const m = location.pathname.match(/^\/portal\/invoice\/([^/]+)\/?$/);
    return m ? decodeURIComponent(m[1]) : null;
  })();
  const tokenFromQuery = (() => {
    const params = new URLSearchParams(location.search);
    return params.get("t") || "";
  })();

  const loadingEl = document.getElementById("pinvLoading");
  const errorEl = document.getElementById("pinvError");
  const cardEl = document.getElementById("pinvCard");

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function fmtMoney(n) {
    const num = Number(n) || 0;
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: "CAD"
    }).format(num);
  }

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-CA", {
      year: "numeric",
      month: "long",
      day: "numeric"
    });
  }

  function showError() {
    loadingEl.hidden = true;
    cardEl.hidden = true;
    errorEl.hidden = false;
  }

  function render(invoice) {
    loadingEl.hidden = true;
    errorEl.hidden = true;
    cardEl.hidden = false;

    document.getElementById("pinvId").textContent = invoice.id || "";

    // Issued line. Shows "Issued <date>" with paid date appended when
    // applicable. Sent date is intentionally suppressed — the customer
    // doesn't care about admin send timestamps; only what's relevant
    // to their next action.
    const issuedBits = [];
    if (invoice.createdAt) issuedBits.push(`Issued ${fmtDate(invoice.createdAt)}`);
    if (invoice.status === "paid" && invoice.paidAt) issuedBits.push(`Paid ${fmtDate(invoice.paidAt)}`);
    document.getElementById("pinvIssued").textContent = issuedBits.join(" · ");

    // PAID badge: shown only when status is paid. The pay block also
    // hides itself in that case (see below) so there's no contradiction.
    const paidBadge = document.getElementById("pinvPaidBadge");
    paidBadge.hidden = invoice.status !== "paid";

    // Bill-to line — name + short property label. Skipped if both are
    // empty so the heading area stays clean.
    const billParts = [];
    if (invoice.customerName) billParts.push(invoice.customerName);
    if (invoice.propertyShortLabel) billParts.push(invoice.propertyShortLabel);
    const billTo = document.getElementById("pinvBillTo");
    if (billParts.length) {
      billTo.textContent = `For ${billParts.join(" · ")}`;
    } else {
      billTo.hidden = true;
    }

    // Line items. Same fields as the admin invoice editor, minus the
    // internal note column (which can leak admin shorthand and isn't
    // useful to the customer). The customer-facing PDF doesn't include
    // notes either — we follow the same rule here.
    const linesEl = document.getElementById("pinvLines");
    const items = Array.isArray(invoice.lineItems) ? invoice.lineItems : [];
    if (!items.length) {
      linesEl.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#999;font-style:italic;padding:18px;">No line items.</td></tr>`;
    } else {
      linesEl.innerHTML = items.map((l) => `
        <tr>
          <td>${escapeHtml(l.label || l.key || "Line")}</td>
          <td class="num">${escapeHtml(String(l.qty || 1))}</td>
          <td class="num">${fmtMoney(l.unitPrice)}</td>
          <td class="num">${fmtMoney(l.lineTotal)}</td>
        </tr>
      `).join("");
    }
    document.getElementById("pinvSubtotal").textContent = fmtMoney(invoice.subtotal);
    document.getElementById("pinvHst").textContent = fmtMoney(invoice.hst);
    document.getElementById("pinvTotal").textContent = fmtMoney(invoice.total);

    // Pay block. Four states:
    //   1. paid       → hide the whole section
    //   2. void       → "This invoice has been voided" notice
    //   3. !payUrl    → "Payment link is being prepared" banner
    //   4. otherwise  → Pay button to /pay/invoice/:id?t=<paymentToken>
    const paySection = document.getElementById("pinvPaySection");
    const payBlock = document.getElementById("pinvPayBlock");
    const payHeading = document.getElementById("pinvPayHeading");
    if (invoice.status === "paid") {
      paySection.hidden = true;
    } else if (invoice.status === "void") {
      paySection.hidden = false;
      payHeading.textContent = "Invoice voided";
      payBlock.innerHTML = `<div class="pinv-status-banner">This invoice has been voided and is no longer payable. If you believe this was a mistake, please call <a href="tel:+19059600181">(905) 960-0181</a>.</div>`;
    } else if (!invoice.payUrl) {
      paySection.hidden = false;
      payHeading.textContent = "Pay this invoice";
      payBlock.innerHTML = `<div class="pinv-status-banner">Payment link is being prepared. Please check the email you received, or contact Patrick at <a href="mailto:info@pjllandservices.com">info@pjllandservices.com</a>.</div>`;
    } else {
      paySection.hidden = false;
      payHeading.textContent = "Pay this invoice";
      payBlock.innerHTML = `<a class="pinv-pay-btn" href="${escapeHtml(invoice.payUrl)}" target="_blank" rel="noopener">Pay ${escapeHtml(fmtMoney(invoice.total))} →</a>`;
    }

    document.title = `Invoice ${invoice.id || ""} — PJL Land Services`;
  }

  async function load() {
    if (!idFromPath || !tokenFromQuery) {
      showError();
      return;
    }
    try {
      const r = await fetch(
        `/api/portal/invoice/${encodeURIComponent(idFromPath)}?t=${encodeURIComponent(tokenFromQuery)}`,
        { cache: "no-store" }
      );
      if (!r.ok) {
        showError();
        return;
      }
      const data = await r.json().catch(() => ({}));
      if (!data?.ok || !data.invoice) {
        showError();
        return;
      }
      render(data.invoice);
    } catch (_err) {
      showError();
    }
  }

  load();
})();
