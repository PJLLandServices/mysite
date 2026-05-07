// Public payment page client.
//
// Flow:
//   1. Load invoice summary from /api/pay/invoice/:id?t=<token>.
//   2. Render the summary card.
//   3. If status is paid → show the paid banner, hide the form.
//   4. Otherwise initialize Intuit's hosted card-entry iframe via the
//      QuickBooks Payments JS SDK.
//   5. On Pay click: ask the SDK to tokenize the card. The SDK collects
//      card data INSIDE its iframe (Intuit-hosted), tokenizes it, and
//      returns a one-shot card token. Card data never touches PJL JS.
//   6. POST the card token to /api/pay/invoice/:id/charge.
//   7. On success → redirect to /pay/invoice/:id/thanks?t=<token>.
//
// PCI scope note: This client never sees raw PAN. The Intuit iframe is
// loaded from js.intuit.com and submits to api.intuit.com directly. We
// only handle the resulting tokens. Stay in PCI SAQ-A — DO NOT change
// this to read card-number inputs from your own DOM.

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

let currentInvoice = null;
let sdkInstance = null;

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

async function load() {
  if (!invoiceId || !token) return showError();
  try {
    const r = await fetch(`/api/pay/invoice/${encodeURIComponent(invoiceId)}?t=${encodeURIComponent(token)}`,
      { cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok || !data.invoice) return showError();
    currentInvoice = data.invoice;
    render(currentInvoice);
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

  // Status is sent (or draft, edge case) — initialize the card form.
  initIntuitSdk(inv);
}

// ----------------------------------------------------------------------
// Intuit Payments SDK init.
//
// PR 3 NOTE — this is the area with the most Intuit-specific
// uncertainty. Real production exact-method names / option keys may
// differ from what's coded here; we'll discover during sandbox
// testing. The high-level shape (load SDK script → call init → mount
// iframe → handle tokenization callback) is stable across SDK
// versions.
//
// What we expect from the SDK (as documented at developer.intuit.com):
//   - window.Intuit (or window.intuit) is exposed once IntuitPaymentsJS.js
//     loads.
//   - There's an init/factory function that takes:
//       env: 'sandbox' | 'production'
//       authToken: a short-lived bearer minted server-side (we hit
//                  /api/pay/invoice/:id/sdk-token to get one)
//       container: DOM node or selector for the iframe mount
//   - On successful tokenization the SDK fires a callback with a
//     one-shot token string (Intuit names it "card token" or
//     "tokenized_card" depending on docs version).
//
// If the SDK exposes a different surface than this, the swap is a
// localized 5-10 LOC edit inside this function. Everything downstream
// (POST to /charge, server-side charge call) is decoupled from the
// SDK and won't need changes.
async function initIntuitSdk(inv) {
  // Pull the SDK config (publishable client ID + environment) from our
  // server. The publishable client ID is safe to ship to the browser —
  // it's the same model as Stripe's pk_live_* keys: it identifies the
  // app to Intuit but doesn't grant data access. The server-side OAuth
  // tokens never leave the server.
  let sdkConfig;
  try {
    const r = await fetch(`/api/pay/invoice/${encodeURIComponent(inv.id)}/sdk-config?t=${encodeURIComponent(token)}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data?.errors?.[0] || "Couldn't initialize the secure form.");
    sdkConfig = data;
  } catch (err) {
    setStatus(`Couldn't initialize the secure card form: ${err.message}`, "error");
    return;
  }

  // Wait up to 5 seconds for the SDK script to finish loading.
  const sdk = await waitForSdk(5000);
  if (!sdk) {
    setStatus("The secure card form couldn't load. Please try again or pay by e-Transfer / phone.", "error");
    return;
  }

  try {
    // The factory call shape is the area most likely to differ from
    // what real Intuit docs document for the current SDK version. The
    // shape below is a reasonable guess — adjust here on first sandbox
    // failure.
    const factory = sdk.payments?.create || sdk.create || sdk.PaymentsForm || sdk.payments;
    if (!factory) {
      throw new Error("Intuit SDK loaded but exposed an unexpected API surface.");
    }
    sdkInstance = await factory({
      env: sdkConfig.environment || "sandbox",
      clientId: sdkConfig.clientId,
      mountSelector: "#pay-card-form",
      style: { brandColor: "#1B4D2E" }
    });

    // Enable the Pay button only after the iframe is ready.
    $chargeBtn.disabled = false;
  } catch (err) {
    console.error("[pay] SDK init failed:", err);
    setStatus(`Couldn't initialize the secure card form: ${err.message}`, "error");
  }
}

function waitForSdk(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const sdk = window.Intuit || window.intuit || null;
      if (sdk) return resolve(sdk);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, 100);
    };
    tick();
  });
}

// ---- Pay button → tokenize → charge ----------------------------------
$chargeBtn?.addEventListener("click", async () => {
  if (!sdkInstance || !currentInvoice) return;
  $chargeBtn.disabled = true;
  setStatus("Securely processing your payment…", "info");

  let cardToken;
  try {
    // Ask the SDK to tokenize whatever's in the iframe. Method name
    // varies by SDK version — try a couple of common names.
    const tokenize = sdkInstance.tokenize?.bind(sdkInstance)
      || sdkInstance.submit?.bind(sdkInstance)
      || sdkInstance.getToken?.bind(sdkInstance);
    if (!tokenize) throw new Error("Card form doesn't expose a tokenize method.");
    const result = await tokenize();
    cardToken = result?.token || result?.cardToken || result?.value || result;
    if (!cardToken || typeof cardToken !== "string") {
      throw new Error("Card couldn't be tokenized. Double-check your card details.");
    }
  } catch (err) {
    setStatus(err.message || "Couldn't process the card.", "error");
    $chargeBtn.disabled = false;
    return;
  }

  // POST to our charge endpoint.
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
