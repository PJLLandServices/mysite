// Public payment page client — Stripe Payment Element (Stripe migration,
// Jul 2026; replaces the QuickBooks Payments direct-tokenization flow).
//
// Flow (deferred-intent pattern):
//   1. Load invoice summary from /api/pay/invoice/:id?t=<token>.
//   2. Render the summary card; pre-fill the AVS fields from the
//      invoice's bill-to snapshot.
//   3. Load /sdk-config → Stripe publishable key, amount, brands,
//      support phone, reCAPTCHA site key.
//   4. Mount Stripe's Payment Element (card fields live in a Stripe
//      iframe — they never exist in this page's DOM).
//   5. On Pay click: validate our fields → elements.submit() →
//      reCAPTCHA → POST /payment-intent (server creates/reuses the
//      PaymentIntent, amount comes from the INVOICE, never from here) →
//      stripe.confirmPayment (browser ↔ Stripe directly; our name +
//      street + postal ride along as billing_details for AVS).
//   6. Decline → report the intent id to /payment-failed so the server
//      pulls the verified failure from Stripe onto the invoice's
//      attempt log, and show the mapped message.
//   7. Success → POST /charge { paymentIntentId } — the server re-reads
//      the intent FROM STRIPE, verifies it, flips the invoice paid.
//   8. Redirect to /pay/invoice/:id/thanks?t=<token>.
//
// PCI scope: SAQ-A-EP. Card PAN/CVC/expiry live inside Stripe's iframe
// and go straight to api.stripe.com. PJL's server only ever sees the
// PaymentIntent id. DO NOT replace the Element with raw card inputs or
// POST card data through pjllandservices.com — that pushes the
// integration into SAQ-D scope (Hard Rule 23).
//
// NO automatic retry anywhere (Hard Rule 22): a failed attempt records
// and stops; re-enabling the Pay button is the only "retry" — a
// deliberate human one.

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
const $testBanner = document.getElementById("payTestBanner");

const $name = document.getElementById("payCardName");
const $street = document.getElementById("payCardStreet");
const $postal = document.getElementById("payCardPostal");
const $acceptedBrands = document.getElementById("payAcceptedBrands");
const $stripeMount = document.getElementById("payStripeElement");

let currentInvoice = null;
let stripeClient = null;   // Stripe(publishableKey) once config lands
let stripeElements = null; // Elements group the Payment Element lives in
let paymentElement = null;
let paymentElementReady = false;
let recaptchaSiteKey = null;
let recaptchaReady = false;
// Support phone + accepted brands from /sdk-config (settings-driven,
// never hardcoded here).
let supportPhone = "(905) 960-0181";

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

function disablePayments(message) {
  setStatus(message, "error");
  $chargeBtn.disabled = true;
}

// ---- Postal code normalization ----------------------------------------
// Uppercase, strip whitespace and hyphens, then validate. Canadian
// postal codes exclude D, F, I, O, Q, U everywhere and additionally
// W and Z in the leading position. US ZIPs are accepted and flip the
// country code — a US billing postal sent as "CA" is a guaranteed AVS
// mismatch. (Card number / CVC validation now lives inside Stripe's
// Payment Element, including Amex 15/4 — no PAN logic in this file.)
const CA_POSTAL_RE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/;
function normalizePostal(raw) {
  const compact = String(raw || "").toUpperCase().replace(/[\s\-]/g, "");
  if (CA_POSTAL_RE.test(compact)) {
    return {
      ok: true,
      country: "CA",
      display: `${compact.slice(0, 3)} ${compact.slice(3)}`,
      wire: compact
    };
  }
  if (/^\d{5}$/.test(compact)) {
    return { ok: true, country: "US", display: compact, wire: compact };
  }
  if (/^\d{9}$/.test(compact)) {
    const zip = `${compact.slice(0, 5)}-${compact.slice(5)}`;
    return { ok: true, country: "US", display: zip, wire: zip };
  }
  return { ok: false };
}

// ---- Light input handling ----------------------------------------------
$name?.addEventListener("input", () => $name.classList.remove("pay-field--invalid"));
$street?.addEventListener("input", () => $street.classList.remove("pay-field--invalid"));
$postal?.addEventListener("input", () => $postal.classList.remove("pay-field--invalid"));
// Re-render the postal code in its canonical form once the customer
// leaves the field — "l3x0a5" becomes "L3X 0A5" in front of them, so
// what they see is what gets sent.
$postal?.addEventListener("blur", () => {
  const parsed = normalizePostal($postal.value);
  if (parsed.ok) $postal.value = parsed.display;
});

// ---- Load invoice + payment config -------------------------------------
async function load() {
  if (!invoiceId || !token) return showError();
  try {
    const r = await fetch(`/api/pay/invoice/${encodeURIComponent(invoiceId)}?t=${encodeURIComponent(token)}`,
      { cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok || !data.invoice) return showError();
    currentInvoice = data.invoice;
    render(currentInvoice);
    if (!$formSection.hidden) await initPaymentForm();
  } catch (err) {
    console.error("[pay] load failed:", err);
    showError();
  }
}

async function initPaymentForm() {
  let cfg;
  try {
    const r = await fetch(`/api/pay/invoice/${encodeURIComponent(invoiceId)}/sdk-config?t=${encodeURIComponent(token)}`);
    cfg = await r.json().catch(() => ({}));
    if (!r.ok || !cfg.ok || !cfg.stripePublishableKey) {
      return disablePayments(cfg?.errors?.[0] || "Card payment is not available right now. Use e-Transfer or call us.");
    }
  } catch (err) {
    return disablePayments("Couldn't reach the payment processor. Use e-Transfer or call us.");
  }

  if (cfg.supportPhone) supportPhone = cfg.supportPhone;
  renderAcceptedBrands(cfg.acceptedCardBrands);
  if ($testBanner && cfg.liveMode === false) $testBanner.hidden = false;
  recaptchaSiteKey = cfg.recaptchaSiteKey || null;
  if (recaptchaSiteKey) loadRecaptchaScript(recaptchaSiteKey);

  // Stripe.js is loaded from js.stripe.com by a static tag in pay.html.
  // If it didn't load (blocker, network), fail toward the e-Transfer
  // path rather than a dead Pay button with no explanation.
  if (typeof window.Stripe !== "function") {
    return disablePayments(`The secure card form couldn't load. Please pay by e-Transfer below, or call us at ${supportPhone}.`);
  }

  try {
    stripeClient = window.Stripe(cfg.stripePublishableKey);
    // Deferred-intent mode: the Element renders from amount + currency
    // alone; the PaymentIntent is only created server-side when the
    // customer actually clicks Pay. Amount here is display/validation
    // only — the server always prices the intent from the invoice.
    stripeElements = stripeClient.elements({
      mode: "payment",
      amount: cfg.amountCents,
      currency: cfg.currency || "cad",
      appearance: {
        variables: {
          colorPrimary: "#1B4D2E",
          colorText: "#1A1A1A",
          colorDanger: "#B23A3A",
          fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          borderRadius: "8px"
        }
      }
    });
    paymentElement = stripeElements.create("payment", {
      layout: "tabs",
      // We collect name + street + postal in OUR fields (pre-filled from
      // the invoice, AVS brief §4.1) and pass them at confirm time.
      // "never" tells the Element not to duplicate them — Stripe then
      // REQUIRES them in confirmPayment's billing_details, which
      // validate() guarantees.
      fields: {
        billingDetails: {
          name: "never",
          address: { line1: "never", postalCode: "never", country: "never" }
        }
      }
    });
    paymentElement.on("ready", () => { paymentElementReady = true; });
    paymentElement.on("loaderror", (ev) => {
      console.warn("[pay] Payment Element load error:", ev?.error?.message);
      disablePayments(`The secure card form couldn't load. Please pay by e-Transfer below, or call us at ${supportPhone}.`);
    });
    if ($stripeMount) $stripeMount.innerHTML = "";
    paymentElement.mount("#payStripeElement");
  } catch (err) {
    console.error("[pay] Stripe init failed:", err);
    disablePayments(`The secure card form couldn't load. Please pay by e-Transfer below, or call us at ${supportPhone}.`);
  }
}

// Render the accepted-brand line from the settings-driven list. Anything
// malformed leaves the line hidden rather than printing a half-list the
// merchant account may not honour.
function renderAcceptedBrands(brands) {
  if (!$acceptedBrands || !Array.isArray(brands) || !brands.length) return;
  const labels = brands.map((b) => String(b?.label || b?.slug || "").trim()).filter(Boolean);
  if (!labels.length) return;
  const list = labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  $acceptedBrands.textContent = `We accept ${list}.`;
  $acceptedBrands.hidden = false;
}

// Pre-fill the AVS fields from the invoice's bill-to snapshot. Only ever
// fills an EMPTY field, so a customer who already started typing (or a
// browser autofill that got there first) is never overwritten.
function prefillBillingAddress(prefill) {
  if (!prefill || typeof prefill !== "object") return;
  if ($street && !$street.value.trim() && prefill.streetAddress) {
    $street.value = String(prefill.streetAddress).slice(0, 120);
  }
  if ($postal && !$postal.value.trim() && prefill.postalCode) {
    const parsed = normalizePostal(prefill.postalCode);
    $postal.value = parsed.ok ? parsed.display : String(prefill.postalCode).slice(0, 10);
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
  prefillBillingAddress(inv.billingPrefill);
}

// ---- Validation -------------------------------------------------------
// Our three fields only — card number/expiry/CVC validation (including
// Amex's 15-digit PAN + 4-digit CID) is Stripe's job inside the Element.
// Returns null when good, or a specific message to show.
function validate() {
  function flag(el, message) {
    el.classList.add("pay-field--invalid");
    el.focus();
    return message;
  }
  if (!$name.value.trim()) {
    return flag($name, "Please enter the cardholder name exactly as it appears on the card.");
  }
  if (!$street.value.trim()) {
    return flag($street, "Please enter the billing street address for this card — your bank checks it against your statement.");
  }
  const postal = normalizePostal($postal.value);
  if (!postal.ok) {
    return flag($postal, "That postal code doesn't look right. Canadian codes look like L3X 0A5.");
  }
  $postal.value = postal.display;
  return null;
}

// ---- ReCAPTCHA v3 ----------------------------------------------------
function loadRecaptchaScript(siteKey) {
  if (document.querySelector('script[data-recaptcha]')) return;
  const s = document.createElement("script");
  s.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`;
  s.async = true;
  s.defer = true;
  s.dataset.recaptcha = "1";
  s.onload = () => {
    if (window.grecaptcha?.ready) {
      window.grecaptcha.ready(() => { recaptchaReady = true; });
    } else {
      recaptchaReady = true;
    }
  };
  s.onerror = () => {
    console.warn("[pay] reCAPTCHA script failed to load — proceeding without (server may reject if it expects a token)");
  };
  document.head.appendChild(s);
}

async function getRecaptchaToken() {
  if (!recaptchaSiteKey) return null;
  const startedAt = Date.now();
  while (!recaptchaReady && Date.now() - startedAt < 5000) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (!window.grecaptcha?.execute) {
    throw new Error("reCAPTCHA didn't load. Please refresh the page and try again.");
  }
  return new Promise((resolve, reject) => {
    window.grecaptcha.ready(() => {
      window.grecaptcha
        .execute(recaptchaSiteKey, { action: "pay" })
        .then(resolve)
        .catch((err) => reject(err instanceof Error ? err : new Error("reCAPTCHA execute failed.")));
    });
  });
}

// Report a failed confirm to the server, which pulls the VERIFIED
// failure detail from Stripe onto the invoice's attempt log — so a
// browser-side decline is still visible to Patrick. If the server has a
// better (mapped) message for the failure, prefer it. Best-effort:
// logging must never block the customer's next attempt.
async function reportFailure(paymentIntentId) {
  if (!paymentIntentId) return null;
  try {
    const r = await fetch(`/api/pay/invoice/${encodeURIComponent(invoiceId)}/payment-failed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ t: token, paymentIntentId })
    });
    const data = await r.json().catch(() => ({}));
    return data?.errors?.[0] || null;
  } catch { return null; }
}

// ---- Pay click: submit → intent → confirm → finalize -------------------
$chargeBtn?.addEventListener("click", async () => {
  if (!currentInvoice || !stripeClient || !stripeElements) {
    setStatus(`Payment processor not ready. Use e-Transfer or call ${supportPhone}.`, "error");
    return;
  }
  if (!paymentElementReady) {
    setStatus("The card form is still loading — one moment…", "info");
    return;
  }
  const invalidMessage = validate();
  if (invalidMessage) {
    setStatus(invalidMessage, "error");
    return;
  }

  $chargeBtn.disabled = true;
  setStatus("Checking your card details…", "info");

  // 1. Element-side validation (card number, expiry, CVC — including
  //    Amex 15/4). Errors surface inline inside the Element itself.
  const { error: submitError } = await stripeElements.submit();
  if (submitError) {
    setStatus(submitError.message || "Please check your card details and try again.", "error");
    $chargeBtn.disabled = false;
    return;
  }

  // 2. reCAPTCHA, then ask OUR server for the PaymentIntent. The amount
  //    comes from the invoice server-side — nothing this page could lie
  //    about.
  let recaptchaToken = null;
  try {
    recaptchaToken = await getRecaptchaToken();
  } catch (err) {
    setStatus(err.message || "Couldn't verify you're human.", "error");
    $chargeBtn.disabled = false;
    return;
  }

  setStatus("Preparing your payment…", "info");
  let clientSecret = null;
  let paymentIntentId = null;
  try {
    const r = await fetch(`/api/pay/invoice/${encodeURIComponent(currentInvoice.id)}/payment-intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ t: token, recaptchaToken })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok || !data.clientSecret) {
      throw new Error(data?.errors?.[0] || `We couldn't start the payment. Please try again, or call us at ${supportPhone}.`);
    }
    clientSecret = data.clientSecret;
    paymentIntentId = data.paymentIntentId;
  } catch (err) {
    setStatus(err.message, "error");
    $chargeBtn.disabled = false;
    return;
  }

  // 3. Confirm — browser ↔ Stripe directly. Our name/street/postal ride
  //    along as billing_details (the Element was told not to collect
  //    them), which is what AVS checks. redirect:"if_required" — cards
  //    and wallets settle in-page; the server disallows redirect-based
  //    methods on the intent.
  setStatus("Processing your payment…", "info");
  const postal = normalizePostal($postal.value);
  const { error: confirmError, paymentIntent } = await stripeClient.confirmPayment({
    elements: stripeElements,
    clientSecret,
    redirect: "if_required",
    confirmParams: {
      return_url: `${location.origin}/pay/invoice/${encodeURIComponent(currentInvoice.id)}/thanks?t=${encodeURIComponent(token)}`,
      payment_method_data: {
        billing_details: {
          name: $name.value.trim(),
          address: {
            line1: $street.value.trim(),
            postal_code: postal.wire,
            country: postal.country
          }
        }
      }
    }
  });

  if (confirmError) {
    // Stripe's card_error messages are written for customers, but our
    // mapped copy carries the office number and the next step — ask the
    // server to record the failure (verified against Stripe) and hand
    // back the mapped message; fall back to Stripe's own text.
    const mapped = await reportFailure(confirmError.payment_intent?.id || paymentIntentId);
    setStatus(mapped || confirmError.message || `Payment couldn't be completed. Please call us at ${supportPhone}.`, "error");
    // Deliberate-human-retry only (Hard Rule 22): re-enabling the button
    // is the one and only retry path.
    $chargeBtn.disabled = false;
    return;
  }

  if (!paymentIntent || paymentIntent.status !== "succeeded") {
    // requires_action fell through, or processing. Don't guess — the
    // webhook will finalize if it succeeds; tell the customer the truth.
    setStatus(`Your bank is still processing this payment. Don't pay again — call us at ${supportPhone} if you don't get a receipt within a few minutes.`, "info");
    return;
  }

  // 4. Tell our server to verify with Stripe and flip the invoice.
  setStatus("Payment approved — updating your invoice…", "info");
  try {
    const r = await fetch(`/api/pay/invoice/${encodeURIComponent(currentInvoice.id)}/charge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ t: token, paymentIntentId: paymentIntent.id })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data?.errors?.[0] || "");
    setStatus("✓ Payment received. Redirecting…", "ok");
    setTimeout(() => {
      location.href = `/pay/invoice/${encodeURIComponent(currentInvoice.id)}/thanks?t=${encodeURIComponent(token)}`;
    }, 1000);
  } catch (err) {
    // The MONEY MOVED — Stripe said succeeded — only our bookkeeping
    // call failed. The webhook will finalize the invoice; the one thing
    // the customer must hear is "do not pay twice."
    setStatus(err.message || `Your payment went through — the receipt may take a few minutes. Please DON'T pay again. Questions? ${supportPhone}.`, "info");
  }
});

load();
