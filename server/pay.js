// Public payment page client.
//
// Flow (corrected in PR 3.1 — Intuit doesn't ship a JS SDK):
//   1. Load invoice summary from /api/pay/invoice/:id?t=<token>.
//   2. Render the summary card.
//   3. If status is paid → show the paid banner, hide the form.
//   4. Customer enters card details into a normal HTML form on this page.
//   5. On Pay click, this JS POSTs the card payload DIRECTLY to Intuit's
//      tokenization endpoint (api.intuit.com or sandbox.api.intuit.com),
//      cross-origin, with NO Authorization header. The endpoint accepts
//      unauthenticated POSTs by design (same model as Stripe.js).
//   6. Intuit returns a one-shot card token in field `value`.
//   7. We POST { t, cardToken } to /api/pay/invoice/:id/charge.
//   8. Server uses its OAuth bearer to actually charge via /v4/payments/charges.
//   9. Redirect to /pay/invoice/:id/thanks?t=<token>.
//
// PCI scope: SAQ-A-EP. Card PAN/CVC never reach pjllandservices.com's
// server. They go directly from the user's browser to api.intuit.com.
// PJL's server only ever sees the opaque token. DO NOT change this to
// POST card data through pjllandservices.com — that pushes the
// integration into SAQ-D scope (a much heavier compliance burden).
//
// Verified against Intuit's official Node.js sample app:
// https://github.com/IntuitDeveloper/SampleApp-Payments-Nodejs

const matchPath = location.pathname.match(/^\/pay\/invoice\/([^/]+)\/?$/);
const invoiceId = matchPath ? decodeURIComponent(matchPath[1]) : null;
const token = new URLSearchParams(location.search).get("t");

const $loading = document.getElementById("payLoading");
const $error = document.getElementById("payError");
const $card = document.getElementById("payCard");
const $paidBanner = document.getElementById("payPaidBanner");
const $formSection = document.getElementById("payFormSection");
const $chargeBtn = document.getElementById("payChargeBtn");
const $chargeBtnAmount = document.getElementById("payChargeBtnAmount");
const $chargeStatus = document.getElementById("payChargeStatus");

const $name = document.getElementById("payCardName");
const $number = document.getElementById("payCardNumber");
const $exp = document.getElementById("payCardExp");
const $cvc = document.getElementById("payCardCvc");
const $postal = document.getElementById("payCardPostal");

let currentInvoice = null;
let tokenizeUrl = null; // Filled from /sdk-config response

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function fmt(n) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" })
    .format(Number(n) || 0);
}
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", {
    year: "numeric", month: "long", day: "numeric"
  });
}

function showError() {
  $loading.hidden = true;
  $error.hidden = false;
}

function setStatus(msg, kind) {
  $chargeStatus.textContent = msg;
  $chargeStatus.dataset.kind = kind || "";
}

// ---- Light input formatting -------------------------------------------
// Card number: insert spaces every 4 digits as the user types.
$number?.addEventListener("input", () => {
  const digits = $number.value.replace(/\D/g, "").slice(0, 19);
  const grouped = digits.replace(/(.{4})/g, "$1 ").trim();
  if (grouped !== $number.value) $number.value = grouped;
  $number.classList.remove("pay-field--invalid");
});
// Expiry: auto-insert / after MM. Accept "MM/YY" or "MMYY".
$exp?.addEventListener("input", () => {
  const digits = $exp.value.replace(/\D/g, "").slice(0, 4);
  const formatted = digits.length >= 3 ? digits.slice(0, 2) + "/" + digits.slice(2) : digits;
  if (formatted !== $exp.value) $exp.value = formatted;
  $exp.classList.remove("pay-field--invalid");
});
$cvc?.addEventListener("input", () => {
  $cvc.value = $cvc.value.replace(/\D/g, "").slice(0, 4);
  $cvc.classList.remove("pay-field--invalid");
});
$name?.addEventListener("input", () => $name.classList.remove("pay-field--invalid"));
$postal?.addEventListener("input", () => $postal.classList.remove("pay-field--invalid"));

// ---- Load invoice ----------------------------------------------------
async function load() {
  if (!invoiceId || !token) return showError();
  try {
    const r = await fetch(`/api/pay/invoice/${encodeURIComponent(invoiceId)}?t=${encodeURIComponent(token)}`,
      { cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok || !data.invoice) return showError();
    currentInvoice = data.invoice;
    render(currentInvoice);
    // Fetch the tokenization URL only if the form section is visible
    // (i.e. the invoice is unpaid and chargeable).
    if (!$formSection.hidden) {
      try {
        const r2 = await fetch(`/api/pay/invoice/${encodeURIComponent(invoiceId)}/sdk-config?t=${encodeURIComponent(token)}`);
        const d2 = await r2.json().catch(() => ({}));
        if (r2.ok && d2.ok && d2.tokenizeUrl) {
          tokenizeUrl = d2.tokenizeUrl;
        } else {
          setStatus(d2?.errors?.[0] || "Card payment is not available right now. Use e-Transfer or call us.", "error");
          $chargeBtn.disabled = true;
        }
      } catch (err) {
        setStatus("Couldn't reach the payment processor. Use e-Transfer or call us.", "error");
        $chargeBtn.disabled = true;
      }
    }
  } catch (err) {
    console.error("[pay] load failed:", err);
    showError();
  }
}

function render(inv) {
  $loading.hidden = true;
  $card.hidden = false;
  document.getElementById("payInvoiceId").textContent = inv.id;
  document.getElementById("payInvoiceIssued").textContent =
    inv.createdAt ? `Issued ${fmtDate(inv.createdAt)}` : "";

  const $lines = document.getElementById("paySummaryLines");
  $lines.innerHTML = (inv.lineItems || []).map((l) => `
    <tr>
      <td>
        ${escapeHtml(l.label || l.key || "Line")}
        ${l.note ? `<span class="pay-summary-line-note">${escapeHtml(l.note)}</span>` : ""}
      </td>
      <td class="num">${escapeHtml(String(l.qty || 1))}</td>
      <td class="num">${fmt(l.lineTotal)}</td>
    </tr>
  `).join("") || `<tr><td colspan="3" style="text-align:center;color:#999;font-style:italic;padding:20px;">No line items.</td></tr>`;

  document.getElementById("paySubtotal").textContent = fmt(inv.subtotal);
  document.getElementById("payHst").textContent = fmt(inv.hst);
  document.getElementById("payTotal").textContent = fmt(inv.total);
  $chargeBtnAmount.textContent = fmt(inv.total);

  if (inv.eTransferEmail) {
    const link = document.getElementById("payETransferEmail");
    link.href = `mailto:${inv.eTransferEmail}`;
    link.textContent = inv.eTransferEmail;
  }

  if (inv.status === "paid") {
    $paidBanner.hidden = false;
    $formSection.hidden = true;
    document.getElementById("payPaidMessage").textContent =
      inv.paidAt
        ? `Thanks — payment received ${fmtDate(inv.paidAt)}. A receipt was sent to your email.`
        : "Thanks — payment received. A receipt was sent to your email.";
    return;
  }

  if (inv.status === "void") {
    $paidBanner.hidden = false;
    $formSection.hidden = true;
    const banner = $paidBanner.querySelector("h2");
    if (banner) banner.textContent = "Invoice voided";
    document.getElementById("payPaidMessage").textContent =
      "This invoice has been voided. If you think this is a mistake, please call (905) 960-0181.";
    return;
  }

  // Status is sent (or draft, edge case) — form section already visible.
}

// ---- Validation -------------------------------------------------------
function validate() {
  let ok = true;
  function flag(el) { el.classList.add("pay-field--invalid"); ok = false; el.focus(); }
  if (!$name.value.trim()) { flag($name); return false; }
  const digits = $number.value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) { flag($number); return false; }
  // Luhn check — fast sanity to fail invalid card numbers before
  // we waste a tokenization call.
  if (!luhnValid(digits)) { flag($number); return false; }
  const expMatch = $exp.value.match(/^(\d{2})\s*\/?\s*(\d{2})$/);
  if (!expMatch) { flag($exp); return false; }
  const expMonth = parseInt(expMatch[1], 10);
  if (expMonth < 1 || expMonth > 12) { flag($exp); return false; }
  if (!/^\d{3,4}$/.test($cvc.value)) { flag($cvc); return false; }
  if (!$postal.value.trim()) { flag($postal); return false; }
  return ok;
}
function luhnValid(num) {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = parseInt(num.charAt(i), 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ---- Tokenize → charge -----------------------------------------------
$chargeBtn?.addEventListener("click", async () => {
  if (!currentInvoice || !tokenizeUrl) {
    setStatus("Payment processor not ready. Use e-Transfer or call (905) 960-0181.", "error");
    return;
  }
  if (!validate()) {
    setStatus("Please check the highlighted field(s) and try again.", "error");
    return;
  }

  $chargeBtn.disabled = true;
  setStatus("Securing your card details with QuickBooks…", "info");

  // Parse expiry MM/YY → 4-digit year.
  const expMatch = $exp.value.match(/^(\d{2})\s*\/?\s*(\d{2})$/);
  const expMonth = expMatch[1];
  const expYear = "20" + expMatch[2];

  const cardPayload = {
    card: {
      number: $number.value.replace(/\D/g, ""),
      expMonth,
      expYear,
      cvc: $cvc.value,
      name: $name.value.trim(),
      address: {
        postalCode: $postal.value.trim(),
        // Intuit accepts these fields but doesn't strictly require them
        // for AVS in Canadian card-not-present transactions. Leaving
        // them blank-but-present matches the official Node sample.
        streetAddress: "",
        city: "",
        region: "",
        country: "CA"
      }
    }
  };

  let cardToken;
  try {
    // Direct cross-origin POST to Intuit. NO Authorization header.
    const r = await fetch(tokenizeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cardPayload)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.errors?.[0]?.message || data?.message
        || `Tokenization failed (HTTP ${r.status}).`;
      throw new Error(msg);
    }
    cardToken = data.value;
    if (!cardToken) throw new Error("Card couldn't be tokenized — please double-check the number and try again.");
  } catch (err) {
    setStatus(err.message || "Couldn't process the card.", "error");
    $chargeBtn.disabled = false;
    return;
  }

  // Now hand the (opaque) token off to our server to actually charge.
  setStatus("Processing your payment…", "info");
  try {
    const r = await fetch(`/api/pay/invoice/${encodeURIComponent(currentInvoice.id)}/charge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ t: token, cardToken })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data?.errors?.[0] || "Payment couldn't be completed.");
    setStatus("✓ Payment received. Redirecting…", "ok");
    setTimeout(() => {
      location.href = `/pay/invoice/${encodeURIComponent(currentInvoice.id)}/thanks?t=${encodeURIComponent(token)}`;
    }, 1000);
  } catch (err) {
    setStatus(err.message || "Payment couldn't be completed.", "error");
    $chargeBtn.disabled = false;
  }
});

load();
