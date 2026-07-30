// Public payment page client.
//
// Flow (corrected in PR 3.1 — Intuit doesn't ship a JS SDK):
//   1. Load invoice summary from /api/pay/invoice/:id?t=<token>.
//   2. Render the summary card.
//   3. If status is paid → show the paid banner, hide the form.
//   4. Customer enters card details + billing address into a normal HTML
//      form on this page. The address fields (street + postal) ride in
//      the tokenization payload as card.address so the charge can pass
//      AVS — they are not card data, but they travel WITH the card
//      because Intuit attaches AVS to the token, not to the charge.
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
const $street = document.getElementById("payCardStreet");
const $postal = document.getElementById("payCardPostal");
const $acceptedBrands = document.getElementById("payAcceptedBrands");

let currentInvoice = null;
let tokenizeUrl = null; // Filled from /sdk-config response
let recaptchaSiteKey = null; // Filled from /sdk-config response (may stay null in dev)
let recaptchaReady = false; // True once grecaptcha global is loaded
// Accepted brands + support phone, both from /sdk-config (settings-driven,
// never hardcoded here). acceptedBrands stays null until the config lands,
// which means "we don't know yet" — the brand pre-check is skipped rather
// than guessing and blocking a card that would have worked.
let acceptedBrands = null;
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

// ---- Card brand detection ---------------------------------------------
// Drives three things: the CVC length rule (Amex uses a 4-digit CID, the
// others a 3-digit code), the PAN length rule (Amex is 15 digits, not
// 16), and the pre-submit check against the accepted-brands list. IIN
// ranges only — no network call, no dependency.
const CARD_BRANDS = [
  { slug: "amex",       label: "American Express", test: /^3[47]/,                                       panLengths: [15], cvcLength: 4 },
  { slug: "visa",       label: "Visa",             test: /^4/,                                           panLengths: [13, 16, 19], cvcLength: 3 },
  { slug: "mastercard", label: "Mastercard",       test: /^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/,        panLengths: [16], cvcLength: 3 },
  { slug: "discover",   label: "Discover",         test: /^(6011|64[4-9]|65|622)/,                       panLengths: [16, 19], cvcLength: 3 }
];
function brandFor(digits) {
  return CARD_BRANDS.find((b) => b.test.test(digits)) || null;
}

// ---- Postal code normalization ----------------------------------------
// Uppercase, strip whitespace and hyphens, then validate. Canadian
// postal codes exclude D, F, I, O, Q, U everywhere and additionally
// W and Z in the leading position — a rule the old "is it non-empty"
// check couldn't catch, so a typo'd code went to Intuit as-is and came
// back an AVS failure the customer had no way to interpret.
//
// US ZIPs are accepted too and flip the country code. A US billing
// postal sent with country "CA" is a guaranteed AVS mismatch, which is
// exactly the failure mode this brief is closing.
const CA_POSTAL_RE = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/;
function normalizePostal(raw) {
  const compact = String(raw || "").toUpperCase().replace(/[\s\-]/g, "");
  if (CA_POSTAL_RE.test(compact)) {
    return {
      ok: true,
      country: "CA",
      // Display gets the familiar spaced form; the wire gets the compact
      // 6-character form, which is the shape card networks match on for
      // Canadian AVS.
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

// ---- Light input formatting -------------------------------------------
// Card number: insert spaces every 4 digits as the user types, and keep
// the CVC field's length rule in step with the detected brand.
$number?.addEventListener("input", () => {
  const digits = $number.value.replace(/\D/g, "").slice(0, 19);
  const grouped = digits.replace(/(.{4})/g, "$1 ").trim();
  if (grouped !== $number.value) $number.value = grouped;
  $number.classList.remove("pay-field--invalid");
  syncCvcToBrand(digits);
});

// Amex prints a 4-digit CID on the FRONT of the card; everyone else
// prints 3 on the back. Retitle the field so the customer isn't hunting
// the back of an Amex for a code that isn't there.
function syncCvcToBrand(digits) {
  if (!$cvc) return;
  const brand = brandFor(digits);
  const isAmex = brand?.slug === "amex";
  $cvc.placeholder = isAmex ? "1234" : "123";
  const label = $cvc.closest(".pay-field")?.querySelector(".pay-field-label");
  if (label) label.textContent = isAmex ? "CID (4 digits)" : "CVC";
}
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
$street?.addEventListener("input", () => $street.classList.remove("pay-field--invalid"));
$postal?.addEventListener("input", () => $postal.classList.remove("pay-field--invalid"));
// Re-render the postal code in its canonical form once the customer
// leaves the field — "l3x0a5" becomes "L3X 0A5" in front of them, so
// what they see is what gets sent.
$postal?.addEventListener("blur", () => {
  const parsed = normalizePostal($postal.value);
  if (parsed.ok) $postal.value = parsed.display;
});

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
          recaptchaSiteKey = d2.recaptchaSiteKey || null;
          if (d2.supportPhone) supportPhone = d2.supportPhone;
          renderAcceptedBrands(d2.acceptedCardBrands);
          if (recaptchaSiteKey) loadRecaptchaScript(recaptchaSiteKey);
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

// Render the accepted-brand line from the settings-driven list. Called
// with whatever /sdk-config returned; anything malformed leaves the line
// hidden rather than printing a half-list the merchant account may not
// honour.
function renderAcceptedBrands(brands) {
  if (!$acceptedBrands || !Array.isArray(brands) || !brands.length) return;
  const labels = brands.map((b) => String(b?.label || b?.slug || "").trim()).filter(Boolean);
  if (!labels.length) return;
  acceptedBrands = brands.map((b) => String(b?.slug || "").toLowerCase()).filter(Boolean);
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
// Returns null when the form is good, or a specific message to show.
// Generic "check the highlighted field" copy is a dead end on a phone —
// every rejection below names what is wrong and what to do about it.
function validate() {
  function flag(el, message) {
    el.classList.add("pay-field--invalid");
    el.focus();
    return message;
  }

  if (!$name.value.trim()) {
    return flag($name, "Please enter the cardholder name exactly as it appears on the card.");
  }

  const digits = $number.value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) {
    return flag($number, "That card number looks incomplete — please check it and try again.");
  }
  // Luhn check — fast sanity to fail invalid card numbers before
  // we waste a tokenization call.
  if (!luhnValid(digits)) {
    return flag($number, "That card number doesn't look right — please double-check the digits.");
  }

  // Brand-specific length. Amex is 15 digits and the rest are 16 (Visa
  // and Discover also issue 19); an unrecognized brand keeps the loose
  // 13–19 rule above rather than being rejected on a guess.
  const brand = brandFor(digits);
  if (brand && !brand.panLengths.includes(digits.length)) {
    return flag($number, `${brand.label} card numbers are ${brand.panLengths.join(" or ")} digits — please check the number.`);
  }
  // Brand acceptance, when we know the list. Advisory only: Intuit's
  // merchant account is the authority, this just saves the customer a
  // decline they can't act on.
  if (brand && acceptedBrands && !acceptedBrands.includes(brand.slug)) {
    return flag($number, `We're not able to accept ${brand.label} right now. Please use another card, pay by e-Transfer below, or call us at ${supportPhone}.`);
  }

  const expMatch = $exp.value.match(/^(\d{2})\s*\/?\s*(\d{2})$/);
  if (!expMatch) {
    return flag($exp, "Please enter the expiry as MM/YY.");
  }
  const expMonth = parseInt(expMatch[1], 10);
  if (expMonth < 1 || expMonth > 12) {
    return flag($exp, "That expiry month isn't valid — please enter it as MM/YY.");
  }

  // CVC: 4 digits on Amex (the CID on the front), 3 on the other
  // brands. Unknown brand keeps the permissive 3-or-4 rule.
  const cvc = $cvc.value.trim();
  if (brand) {
    if (cvc.length !== brand.cvcLength) {
      return flag($cvc, brand.slug === "amex"
        ? "American Express uses a 4-digit code printed on the FRONT of the card."
        : `${brand.label} security codes are ${brand.cvcLength} digits, on the back of the card.`);
    }
  } else if (!/^\d{3,4}$/.test(cvc)) {
    return flag($cvc, "Please enter the 3- or 4-digit security code from your card.");
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

// ---- ReCAPTCHA v3 ----------------------------------------------------
// Loads Google's reCAPTCHA script with the site key from /sdk-config.
// The script exposes window.grecaptcha; we wait for `ready()` then
// flag recaptchaReady so the Pay click can request a token.
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
      // Older API — flag ready immediately if `ready` isn't present.
      recaptchaReady = true;
    }
  };
  s.onerror = () => {
    console.warn("[pay] reCAPTCHA script failed to load — proceeding without (server may reject if it expects a token)");
  };
  document.head.appendChild(s);
}

// Request a v3 reCAPTCHA token. Returns null if reCAPTCHA wasn't
// configured (server didn't ship a site key). Throws on failure.
async function getRecaptchaToken() {
  if (!recaptchaSiteKey) return null;
  // Wait up to 5s for grecaptcha.ready() to fire if it hasn't yet.
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

// Map an Intuit tokenization rejection onto the field the customer can
// actually fix. Same principle as the server-side charge-failure map: no
// gateway string reaches the page, and every message ends somewhere the
// customer can go next.
function tokenizationMessage(raw) {
  const text = String(raw || "").toLowerCase();
  if (/streetaddress|address/.test(text)) {
    return "Your bank couldn't read that billing address. Please check the street address and postal code against your credit card statement.";
  }
  if (/expmonth|expyear|expir/.test(text)) {
    return "Please check the expiry date on your card and try again.";
  }
  if (/cvc|securitycode/.test(text)) {
    return "Please check the security code on your card and try again.";
  }
  if (/number|card/.test(text)) {
    return "Please double-check the card number and try again.";
  }
  return `We couldn't read those card details. Please check them and try again, or call us at ${supportPhone}.`;
}

// ---- Tokenize → charge -----------------------------------------------
$chargeBtn?.addEventListener("click", async () => {
  if (!currentInvoice || !tokenizeUrl) {
    setStatus(`Payment processor not ready. Use e-Transfer or call ${supportPhone}.`, "error");
    return;
  }
  const invalidMessage = validate();
  if (invalidMessage) {
    setStatus(invalidMessage, "error");
    return;
  }

  $chargeBtn.disabled = true;
  setStatus("Securing your card details with QuickBooks…", "info");

  // Parse expiry MM/YY → 4-digit year.
  const expMatch = $exp.value.match(/^(\d{2})\s*\/?\s*(\d{2})$/);
  const expMonth = expMatch[1];
  const expYear = "20" + expMatch[2];

  // Address: the AVS payload. Intuit's tokenization endpoint accepts
  // `streetAddress`, `city`, `region`, `country` and `postalCode` on
  // card.address, and runs validation on every field that is PRESENT —
  // sending streetAddress: "" returns "address.streetAddress is
  // invalid" — so only fields with a real value are shipped.
  //
  // Until Jul 2026 this was postal code + country only. A card-not-
  // present charge with no street address is what Amex's stricter
  // address verification declines while Visa and Mastercard let it
  // through; that asymmetry is the whole "most payments work, Amex
  // keeps failing" pattern. `city` and `region` are deliberately NOT
  // sent: we don't collect them, and inventing them from a pre-fill the
  // customer never saw would fail AVS on its own terms.
  const postal = normalizePostal($postal.value);
  const address = {
    streetAddress: $street.value.trim(),
    postalCode: postal.wire,
    country: postal.country
  };
  const cardPayload = {
    card: {
      number: $number.value.replace(/\D/g, ""),
      expMonth,
      expYear,
      cvc: $cvc.value,
      name: $name.value.trim(),
      address
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
      const raw = data?.errors?.[0]?.message || data?.message || "";
      // Intuit's tokenization errors are field-path jargon
      // ("address.streetAddress is invalid"). They go to the console for
      // debugging; the customer gets the field named in plain language.
      console.warn("[pay] tokenization rejected:", raw || `HTTP ${r.status}`);
      throw new Error(tokenizationMessage(raw));
    }
    cardToken = data.value;
    if (!cardToken) throw new Error("Card couldn't be tokenized — please double-check the number and try again.");
  } catch (err) {
    setStatus(err.message || `Couldn't process the card. Please call us at ${supportPhone}.`, "error");
    $chargeBtn.disabled = false;
    return;
  }

  // Get a reCAPTCHA token (if reCAPTCHA is configured). The token is
  // single-use, expires in 2 minutes; the server forwards it to Google
  // for verification before processing the charge.
  let recaptchaToken = null;
  try {
    recaptchaToken = await getRecaptchaToken();
  } catch (err) {
    setStatus(err.message || "Couldn't verify you're human.", "error");
    $chargeBtn.disabled = false;
    return;
  }

  // Now hand the (opaque) token off to our server to actually charge.
  setStatus("Processing your payment…", "info");
  try {
    const r = await fetch(`/api/pay/invoice/${encodeURIComponent(currentInvoice.id)}/charge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ t: token, cardToken, recaptchaToken })
    });
    const data = await r.json().catch(() => ({}));
    // The server maps Intuit's error code to customer-legible copy before
    // it gets here (AVS brief §4.4) — errors[0] is safe to render
    // verbatim and always names a next step. No retry happens on this
    // path, deliberately: a capture is not idempotent, so the customer
    // re-submits by hand or not at all.
    if (!r.ok || !data.ok) {
      throw new Error(data?.errors?.[0] || `Payment couldn't be completed. Please call us at ${supportPhone}.`);
    }
    setStatus("✓ Payment received. Redirecting…", "ok");
    setTimeout(() => {
      location.href = `/pay/invoice/${encodeURIComponent(currentInvoice.id)}/thanks?t=${encodeURIComponent(token)}`;
    }, 1000);
  } catch (err) {
    setStatus(err.message || `Payment couldn't be completed. Please call us at ${supportPhone}.`, "error");
    // Re-enabling the button lets the customer make a DELIBERATE second
    // attempt. That is the only retry in this flow — nothing re-submits
    // on its own.
    $chargeBtn.disabled = false;
  }
});

load();
