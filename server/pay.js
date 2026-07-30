// Public payment page client — Stripe Payment Element (Stripe migration,
// Jul 2026; replaces the QuickBooks Payments direct-tokenization flow).
//
// Flow (deferred-intent pattern):
//   1. Load invoice summary from /api/pay/invoice/:id?t=<token>.
//   2. Render the summary card.
//   3. Load /sdk-config → Stripe publishable key, amount, brands,
//      support phone, reCAPTCHA site key.
//   4. Mount Stripe's Payment Element (card fields live in a Stripe
//      iframe — they never exist in this page's DOM). The Element
//      collects card number, expiry, CVC, and billing postal + country
//      (postal pre-filled from the invoice's bill-to snapshot via
//      defaultValues); Apple Pay / Google Pay render inside it when the
//      device qualifies and the domain's wallet verification passed.
//   5. On Pay click: elements.submit() → reCAPTCHA →
//      POST /payment-intent (server creates/reuses the PaymentIntent,
//      amount comes from the INVOICE, never from here) →
//      stripe.confirmPayment (browser ↔ Stripe directly).
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

// All card-side input handling — number, expiry, CVC, postal format —
// lives inside Stripe's Payment Element now (including Amex 15/4).
// This file has no card or address fields of its own.

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
      // MUST match payment_method_types on the server-created intent
      // (stripe.js createPaymentIntent) — deferred-intent rules: if the
      // Element offers a method the intent doesn't allow, confirmPayment
      // fails after the customer already picked it. Card only: it
      // carries Apple Pay / Google Pay. Link was removed (Jul 2026,
      // Patrick's request) — its save-my-info block dominated the form.
      paymentMethodTypes: ["card"],
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
    // Slim form (Jul 2026, Patrick's request): the Element collects only
    // what Stripe requires for a card — number, expiry, CVC, and the
    // billing postal code + country it asks for natively. The custom
    // name/street/postal fields from the QuickBooks-era AVS work are
    // gone: Stripe's rail runs postal-only address verification by
    // default (the live Amex test passed full AVS), and the street
    // field's job is done. If Amex declines ever resurface, re-add
    // address collection with fields.billingDetails.address: "full"
    // here — one line — rather than rebuilding custom inputs.
    const prefillPostal = currentInvoice?.billingPrefill?.postalCode || "";
    paymentElement = stripeElements.create("payment", {
      layout: "tabs",
      // Explicit for the next reader: wallets ride the card rail and
      // "auto" (also the default) shows them whenever the device
      // qualifies AND the domain's wallet verification has passed in
      // Stripe → Settings → Payment method domains. No code can force
      // the Apple Pay button past a failed domain verification.
      wallets: { applePay: "auto", googlePay: "auto" },
      // Pre-fill the Element's own postal field from the invoice's
      // bill-to snapshot — same courtesy the custom field used to do,
      // still fully editable by the customer.
      defaultValues: prefillPostal ? {
        billingDetails: { address: { postal_code: prefillPostal, country: "CA" } }
      } : undefined
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
  // The Element's postal pre-fill happens at initPaymentForm() via
  // defaultValues, from the same invoice billingPrefill.
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

  // 3. Confirm — browser ↔ Stripe directly. Billing details (postal +
  //    country) come from the Element's own fields, wallet flows bring
  //    their own. redirect:"if_required" — cards and wallets settle
  //    in-page; the server disallows redirect-based methods on the
  //    intent.
  setStatus("Processing your payment…", "info");
  const { error: confirmError, paymentIntent } = await stripeClient.confirmPayment({
    elements: stripeElements,
    clientSecret,
    redirect: "if_required",
    confirmParams: {
      return_url: `${location.origin}/pay/invoice/${encodeURIComponent(currentInvoice.id)}/thanks?t=${encodeURIComponent(token)}`
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
