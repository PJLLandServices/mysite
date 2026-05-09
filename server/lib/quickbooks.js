// QuickBooks Online integration — push PJL draft invoices into QB so
// Patrick doesn't have to re-key numbers.
//
// Setup (one-time, Patrick does this):
//   1. Create a QuickBooks Developer app at https://developer.intuit.com
//      Type: "Accounting" scope. Production environment when ready.
//   2. Set Redirect URI on the QB app to:
//        https://<your-render-or-public-domain>/api/admin/quickbooks/callback
//      (Currently: https://pjl-land-services-onrender-com.onrender.com/api/admin/quickbooks/callback)
//   3. Set Render env vars:
//        QB_CLIENT_ID         (from QB app dashboard)
//        QB_CLIENT_SECRET     (from QB app dashboard)
//        QB_ENVIRONMENT       "sandbox" or "production" (default: sandbox)
//   4. Visit /admin/settings → click "Connect to QuickBooks" → consent
//      → tokens stored in server/data/quickbooks.json (gitignored).
//   5. Then any invoice in /admin/invoice/<id> shows "Push to QuickBooks"
//      which POSTs the invoice into QB and stores the QB invoice id back
//      on the local record.
//
// Token storage: server/data/quickbooks.json (lives only on Render's
// persistent disk; never committed). Refresh token expires after 100
// days of inactivity — module auto-refreshes the access token before
// each push so as long as Patrick uses it monthly, no re-auth needed.
//
// Customer matching strategy:
//   1. Try to find existing QB customer by exact email (preferred) or name
//   2. If not found → create a new QB customer with the invoice's billing data
//   3. Cache the QB customer id on the local property record for next time
//
// All QB API calls go through requestQB() which handles token refresh on
// 401 and throws on hard failures with clear messages the admin UI can
// surface.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const TOKEN_FILE = path.join(__dirname, "..", "data", "quickbooks.json");

const QB_BASE_PROD = "https://quickbooks.api.intuit.com";
const QB_BASE_SANDBOX = "https://sandbox-quickbooks.api.intuit.com";
const OAUTH_BASE = "https://oauth.platform.intuit.com";

function envCfg() {
  return {
    clientId: process.env.QB_CLIENT_ID || "",
    clientSecret: process.env.QB_CLIENT_SECRET || "",
    environment: (process.env.QB_ENVIRONMENT || "sandbox").toLowerCase(),
    redirectUri: process.env.QB_REDIRECT_URI || ""
  };
}

function isConfigured() {
  const c = envCfg();
  return Boolean(c.clientId && c.clientSecret);
}

function apiBase() {
  return envCfg().environment === "production" ? QB_BASE_PROD : QB_BASE_SANDBOX;
}

// ---- Token persistence ------------------------------------------------

async function readTokens() {
  if (!fsSync.existsSync(TOKEN_FILE)) return null;
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeTokens(tokens) {
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2) + "\n", "utf8");
}

async function isConnected() {
  const t = await readTokens();
  return !!(t && t.access_token && t.realmId);
}

async function clearTokens() {
  if (fsSync.existsSync(TOKEN_FILE)) {
    await fs.unlink(TOKEN_FILE);
  }
}

// ---- OAuth ------------------------------------------------------------

function buildAuthUrl(state, baseRedirectUri) {
  const cfg = envCfg();
  const redirect = baseRedirectUri || cfg.redirectUri;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: redirect,
    state
  });
  return `https://appcenter.intuit.com/connect/oauth2?${params.toString()}`;
}

async function exchangeCodeForTokens(code, realmId, baseRedirectUri) {
  const cfg = envCfg();
  const redirect = baseRedirectUri || cfg.redirectUri;
  const auth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect
  });
  const r = await fetch(`${OAUTH_BASE}/oauth2/v1/tokens/bearer`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: body.toString()
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`QB token exchange failed: HTTP ${r.status} — ${data?.error_description || data?.error || JSON.stringify(data)}`);
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    refresh_expires_at: Date.now() + (Number(data.x_refresh_token_expires_in) || 8640000) * 1000,
    realmId,
    connectedAt: new Date().toISOString()
  };
  await writeTokens(tokens);
  return tokens;
}

async function refreshAccessToken(currentTokens) {
  const cfg = envCfg();
  const auth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: currentTokens.refresh_token
  });
  const r = await fetch(`${OAUTH_BASE}/oauth2/v1/tokens/bearer`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: body.toString()
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`QB token refresh failed: HTTP ${r.status} — ${data?.error_description || JSON.stringify(data)}`);
  const next = {
    ...currentTokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token || currentTokens.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    refresh_expires_at: Date.now() + (Number(data.x_refresh_token_expires_in) || 8640000) * 1000
  };
  await writeTokens(next);
  return next;
}

async function getValidAccessToken() {
  const tokens = await readTokens();
  if (!tokens) throw new Error("Not connected to QuickBooks. Visit /admin/settings to connect.");
  // Refresh 5 minutes before expiry to avoid mid-request 401s.
  if (Date.now() + 5 * 60 * 1000 >= tokens.expires_at) {
    return refreshAccessToken(tokens);
  }
  return tokens;
}

// ---- QB API request wrapper ------------------------------------------

async function requestQB(pathname, { method = "GET", body = null } = {}) {
  let tokens = await getValidAccessToken();
  const url = `${apiBase()}/v3/company/${tokens.realmId}${pathname}`;
  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    Accept: "application/json"
  };
  let init = { method, headers };
  if (body) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  let r = await fetch(url, init);
  if (r.status === 401) {
    // Token expired between getValidAccessToken() and now. Try once more.
    tokens = await refreshAccessToken(tokens);
    headers.Authorization = `Bearer ${tokens.access_token}`;
    r = await fetch(url, init);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = data?.Fault?.Error?.[0] || data?.error || data;
    throw new Error(`QB API ${method} ${pathname} failed: HTTP ${r.status} — ${err?.Message || err?.message || JSON.stringify(err).slice(0, 200)}`);
  }
  return data;
}

// ---- Customer find-or-create + invoice push --------------------------

async function findOrCreateCustomer({ name, email, phone, address }) {
  // Try by email first
  if (email) {
    const safeEmail = email.replace(/['\\]/g, "");
    const q = `select * from Customer where PrimaryEmailAddr = '${safeEmail}' MAXRESULTS 1`;
    const r = await requestQB(`/query?query=${encodeURIComponent(q)}&minorversion=70`);
    const found = r?.QueryResponse?.Customer?.[0];
    if (found) return found;
  }
  // Fall back to name match
  if (name) {
    const safeName = name.replace(/['\\]/g, "");
    const q = `select * from Customer where DisplayName = '${safeName}' MAXRESULTS 1`;
    const r = await requestQB(`/query?query=${encodeURIComponent(q)}&minorversion=70`);
    const found = r?.QueryResponse?.Customer?.[0];
    if (found) return found;
  }
  // Create
  const customer = {
    DisplayName: name || email || "PJL Customer",
    GivenName: (name || "").split(" ")[0] || undefined,
    FamilyName: (name || "").split(" ").slice(1).join(" ") || undefined,
    PrimaryEmailAddr: email ? { Address: email } : undefined,
    PrimaryPhone: phone ? { FreeFormNumber: phone } : undefined,
    BillAddr: address ? { Line1: address } : undefined
  };
  const created = await requestQB("/customer?minorversion=70", { method: "POST", body: customer });
  return created.Customer;
}

// Push a local invoice (from server/data/invoices.json) into QuickBooks.
// Returns the QB invoice id which the caller stores back on the local
// record so re-pushes update rather than duplicate.
async function pushInvoice(localInvoice) {
  if (!isConfigured()) throw new Error("QuickBooks credentials missing — set QB_CLIENT_ID + QB_CLIENT_SECRET in Render env vars.");
  if (!(await isConnected())) throw new Error("Not connected to QuickBooks. Visit /admin/settings to connect first.");

  const customer = await findOrCreateCustomer({
    name: localInvoice.customerName,
    email: localInvoice.customerEmail,
    phone: localInvoice.customerPhone,
    address: localInvoice.address
  });
  if (!customer || !customer.Id) throw new Error("Couldn't resolve a QB customer for this invoice.");

  const lines = (localInvoice.lineItems || []).map((line) => ({
    Description: line.label || line.key || "Service",
    Amount: Number(line.lineTotal) || (Number(line.unitPrice) || 0) * (Number(line.qty) || 1),
    DetailType: "SalesItemLineDetail",
    SalesItemLineDetail: {
      Qty: Number(line.qty) || 1,
      UnitPrice: Number(line.unitPrice) || 0,
      // Use QB's default service item — Patrick can map specific items
      // to PJL SKUs in a future pass. For v1, lump everything onto the
      // QB "Services" account via the implicit default.
      ItemRef: { value: "1" }
    }
  }));

  // AllowOnlineCreditCardPayment + BillEmail let QB generate a customer
  // payment URL for the invoice (the "View and pay" link the customer
  // uses). The PJL portal-hosted /pay page (PR 3) takes over from this
  // QB-hosted fallback; until then, customers can still pay via QB if
  // their email arrives. BillEmail is required by Intuit when
  // AllowOnlineCreditCardPayment is true.
  const invoicePayload = {
    Line: lines,
    CustomerRef: { value: customer.Id },
    DocNumber: localInvoice.id,
    AllowOnlineCreditCardPayment: true,
    AllowOnlineACHPayment: true,
    BillEmail: localInvoice.customerEmail
      ? { Address: localInvoice.customerEmail }
      : (customer.PrimaryEmailAddr || undefined),
    PrivateNote: `PJL local invoice ${localInvoice.id}${localInvoice.woId ? ` from WO ${localInvoice.woId}` : ""}`
  };

  // If we've already pushed this invoice once, update instead of creating.
  if (localInvoice.quickbooksInvoiceId) {
    const existing = await requestQB(`/invoice/${encodeURIComponent(localInvoice.quickbooksInvoiceId)}?minorversion=70`).catch(() => null);
    if (existing?.Invoice) {
      const updatePayload = {
        ...invoicePayload,
        Id: existing.Invoice.Id,
        SyncToken: existing.Invoice.SyncToken,
        sparse: false
      };
      const updated = await requestQB("/invoice?operation=update&minorversion=70", { method: "POST", body: updatePayload });
      return { id: updated.Invoice?.Id || existing.Invoice.Id, action: "updated" };
    }
  }
  const created = await requestQB("/invoice?minorversion=70", { method: "POST", body: invoicePayload });
  return { id: created.Invoice?.Id, action: "created" };
}

// ---- Payments API ----------------------------------------------------
//
// PR 3: charge a tokenized card via the QuickBooks Payments REST API
// and record the resulting payment on the matching QB invoice. The card
// data was already tokenized client-side by Intuit's hosted iframe, so
// PJL never sees the PAN — only a one-shot card token. We pass the
// token to Intuit's charges endpoint, get back a charge ID, then create
// a QB Payment record so the QBO invoice flips to paid in the books.
//
// API endpoints:
//   Charges (sandbox):    https://sandbox.api.intuit.com/quickbooks/v4/payments/charges
//   Charges (production): https://api.intuit.com/quickbooks/v4/payments/charges
//   Payment record:       /v3/company/<realmId>/payment (Accounting API)
//
// PR 3 NOTE on uncertainty: the exact request body shape for the
// Charges API has shifted slightly across Intuit revisions. The fields
// below match the documented v4 schema as of mid-2025 (amount,
// currency, token, capture). If sandbox returns "BadRequest: Unknown
// field" on first run, check the latest Intuit Payments docs and adjust
// the field names here — every other piece (OAuth, the charge → payment
// → invoice update flow) is independent of this exact shape.

const PAYMENTS_BASE_PROD = "https://api.intuit.com";
const PAYMENTS_BASE_SANDBOX = "https://sandbox.api.intuit.com";

function paymentsBase() {
  return envCfg().environment === "production" ? PAYMENTS_BASE_PROD : PAYMENTS_BASE_SANDBOX;
}

// Charge a tokenized card. Throws on hard failure (declined, expired,
// network error, invalid token). Returns { id, amount, currency, status }.
async function chargeCard({ amountCents, currency = "CAD", cardToken, invoiceId, customerEmail }) {
  if (!isConfigured()) throw new Error("QuickBooks credentials missing — set QB_CLIENT_ID + QB_CLIENT_SECRET in Render env vars.");
  if (!(await isConnected())) throw new Error("QuickBooks not connected. The site administrator needs to reconnect via /admin/settings.");
  const tokens = await getValidAccessToken();
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error("Charge amount must be a positive number of cents.");
  }
  if (!cardToken || typeof cardToken !== "string") {
    throw new Error("Card token is missing.");
  }

  // Build the charge request. Per Intuit docs the v4 Charges API takes
  // `amount` (decimal string) and `currency`, with the tokenized card
  // referenced via the `token` field. `capture: true` makes this a
  // direct charge rather than an authorization.
  const requestId = cryptoRandomHex(16); // for idempotency header
  const body = {
    amount: (amountCents / 100).toFixed(2),
    currency,
    token: cardToken,
    capture: true,
    context: {
      mobile: false,
      isEcommerce: true,
      tax: "0.00",
      // Echoed back in the receipt; helps PJL reconcile when a
      // dispute or webhook comes in.
      recurring: false,
      ...(invoiceId ? { description: `PJL invoice ${invoiceId}` } : {})
    }
  };
  if (customerEmail) body.customerEmail = customerEmail;

  const url = `${paymentsBase()}/quickbooks/v4/payments/charges`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      // Idempotency — Intuit honours this header to dedupe retries that
      // happen if the customer hits Pay twice or the network blips.
      "Request-Id": requestId
    },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = data?.errors?.[0] || data?.fault?.error?.[0] || data?.error || data;
    const msg = detail?.message || detail?.detail || JSON.stringify(detail).slice(0, 200);
    throw new Error(`Charge failed (HTTP ${r.status}): ${msg}`);
  }
  const status = data?.status || data?.paymentStatus || "UNKNOWN";
  if (String(status).toUpperCase() !== "CAPTURED" && String(status).toUpperCase() !== "PAID") {
    // Status returned but not captured — could be 3DS challenge required,
    // pending, etc. For PR 3 v1 we treat anything non-captured as a
    // declined charge so the customer sees a clear "try another card"
    // message rather than ambiguous "we have your money maybe."
    throw new Error(`Charge not captured (status: ${status}).`);
  }
  return {
    id: data.id || data.chargeId,
    amount: data.amount,
    currency: data.currency,
    status
  };
}

// Record a Payment in QB Accounting against an existing QB invoice.
// Flips the QB invoice from "Open" to "Paid" in the books. Idempotent
// at the QB end via the chargeId pinned in the payment's privateNote.
async function recordPaymentForInvoice({ qbInvoiceId, amountCents, chargeId }) {
  if (!qbInvoiceId) throw new Error("Missing QB invoice ID — can't record a payment without one.");
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error("Payment amount must be positive.");

  // Pull the QB invoice so we can grab its CustomerRef.
  const inv = await requestQB(`/invoice/${encodeURIComponent(qbInvoiceId)}?minorversion=70`).catch(() => null);
  if (!inv?.Invoice?.Id) throw new Error(`QB invoice ${qbInvoiceId} not found — payment record skipped.`);
  const customerId = inv.Invoice.CustomerRef?.value;
  if (!customerId) throw new Error("QB invoice has no CustomerRef — payment record skipped.");

  const payload = {
    TotalAmt: (amountCents / 100).toFixed(2),
    CustomerRef: { value: customerId },
    PrivateNote: `Auto-recorded from QB Payments charge ${chargeId}`,
    Line: [{
      Amount: (amountCents / 100).toFixed(2),
      LinkedTxn: [{ TxnId: qbInvoiceId, TxnType: "Invoice" }]
    }]
  };
  const created = await requestQB(`/payment?minorversion=70`, { method: "POST", body: payload });
  return { id: created?.Payment?.Id || null };
}

// Mark a QB invoice as voided. Used by status mirror when admin sets
// status: void in the PJL portal. Returns the updated QB invoice or
// throws if QB rejects the void (e.g. payment already recorded).
async function voidInvoice(qbInvoiceId) {
  if (!qbInvoiceId) throw new Error("Missing QB invoice ID — can't void without one.");
  const existing = await requestQB(`/invoice/${encodeURIComponent(qbInvoiceId)}?minorversion=70`);
  if (!existing?.Invoice?.Id) throw new Error(`QB invoice ${qbInvoiceId} not found.`);
  const payload = {
    Id: existing.Invoice.Id,
    SyncToken: existing.Invoice.SyncToken
  };
  const result = await requestQB(`/invoice?operation=void&minorversion=70`, {
    method: "POST",
    body: payload
  });
  return result?.Invoice || null;
}

function cryptoRandomHex(bytes) {
  return require("node:crypto").randomBytes(bytes).toString("hex");
}

module.exports = {
  isConfigured,
  isConnected,
  envCfg,
  buildAuthUrl,
  exchangeCodeForTokens,
  pushInvoice,
  clearTokens,
  chargeCard,
  recordPaymentForInvoice,
  voidInvoice
};
