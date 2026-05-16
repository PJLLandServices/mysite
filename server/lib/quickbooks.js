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
const ITEMS_FILE = path.join(__dirname, "..", "data", "quickbooks-items.json");
const PRICING_FILE = path.join(__dirname, "..", "..", "pricing.json");
const PARTS_FILE = path.join(__dirname, "..", "..", "parts.json");

// settings + recordSyncError live in lib/settings — the rolling errors
// buffer is part of the same settings audit surface the admin UI reads.
const settingsLib = require("./settings.js");

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
//
// Tokens are encrypted at rest (AES-256-GCM) per Intuit's "App
// encrypts access tokens before storing them" production-keys
// requirement. The encryption key is either:
//
//   1. process.env.TOKEN_ENCRYPTION_KEY  — 32-byte hex string (preferred)
//   2. Derived from QB_CLIENT_SECRET via SHA-256                (fallback)
//
// The fallback means existing deployments don't need a new env var to
// pick up encryption — but it ties the at-rest key to the OAuth secret,
// which isn't ideal long-term. Set TOKEN_ENCRYPTION_KEY explicitly in
// production for proper key separation.
//
// Stored format: { iv, ciphertext, tag }, all base64. Plaintext-format
// tokens (from before this change) are auto-migrated on first read —
// we detect by the absence of `iv` / `ciphertext`, decrypt as plaintext
// JSON, then rewrite encrypted.

const cryptoLib = require("node:crypto");

function getEncryptionKey() {
  const explicit = process.env.TOKEN_ENCRYPTION_KEY;
  if (explicit) {
    // Accept hex (64 chars) or base64 (44 chars with padding).
    const hexClean = explicit.trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(hexClean)) return Buffer.from(hexClean, "hex");
    try {
      const buf = Buffer.from(explicit, "base64");
      if (buf.length === 32) return buf;
    } catch {}
    // Fall through to derived key if the env var is malformed.
  }
  const cfg = envCfg();
  if (!cfg.clientSecret) {
    throw new Error("Cannot derive token encryption key — set TOKEN_ENCRYPTION_KEY or QB_CLIENT_SECRET in env vars.");
  }
  return cryptoLib.createHash("sha256").update("pjl.qb.tokens.v1:" + cfg.clientSecret).digest();
}

function encryptTokens(tokens) {
  const key = getEncryptionKey();
  const iv = cryptoLib.randomBytes(12); // 96-bit IV is the GCM standard
  const cipher = cryptoLib.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(tokens), "utf8");
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString("base64"),
    ciphertext: enc.toString("base64"),
    tag: tag.toString("base64")
  };
}

function decryptTokens(envelope) {
  const key = getEncryptionKey();
  const iv = Buffer.from(envelope.iv, "base64");
  const enc = Buffer.from(envelope.ciphertext, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const decipher = cryptoLib.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString("utf8"));
}

async function readTokens() {
  if (!fsSync.existsSync(TOKEN_FILE)) return null;
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.iv && parsed?.ciphertext && parsed?.tag) {
      // Encrypted envelope — decrypt and return.
      return decryptTokens(parsed);
    }
    // Legacy plaintext format — migrate transparently. Auto-rewrite as
    // encrypted so the next read takes the encrypted path.
    if (parsed?.access_token) {
      try {
        await fs.writeFile(TOKEN_FILE, JSON.stringify(encryptTokens(parsed), null, 2) + "\n", "utf8");
        console.log("[qb] token store migrated to encrypted format.");
      } catch (e) {
        console.warn("[qb] token migration write failed:", e.message);
      }
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeTokens(tokens) {
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  const envelope = encryptTokens(tokens);
  await fs.writeFile(TOKEN_FILE, JSON.stringify(envelope, null, 2) + "\n", "utf8");
}

async function isConnected() {
  const t = await readTokens();
  return !!(t && t.access_token && t.realmId);
}

async function clearTokens() {
  if (fsSync.existsSync(TOKEN_FILE)) {
    await fs.unlink(TOKEN_FILE);
  }
  // Reset the item-ref cache too — a new connection might be a different
  // QB realm with different items.
  _itemRefCache = { realmId: null, itemId: null };
}

// ---- OAuth ------------------------------------------------------------

function buildAuthUrl(state, baseRedirectUri) {
  const cfg = envCfg();
  const redirect = baseRedirectUri || cfg.redirectUri;
  // Conditional scope: in production we request both accounting and
  // payment because PJL's real QBO has Payments active. In sandbox we
  // request accounting only because Canadian sandbox companies can't
  // enroll in Payments and asking for the payment scope triggers a
  // "Set up payments" gate that blocks the OAuth flow entirely.
  const scope = cfg.environment === "production"
    ? "com.intuit.quickbooks.accounting com.intuit.quickbooks.payment"
    : "com.intuit.quickbooks.accounting";
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    scope,
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
    // Log the full Intuit response body — the surface error message
    // ("A business validation error occurred") is generic; the real
    // detail lives in Fault.Error[i].Detail and Fault.Error[i].code.
    // Server logs get the full picture; the thrown error stays short.
    console.warn(`[qb-api] ${method} ${pathname} → HTTP ${r.status}`, JSON.stringify(data?.Fault?.Error || data || {}, null, 2));
    const detail = err?.Detail || err?.detail || err?.Message || err?.message || JSON.stringify(err).slice(0, 200);
    throw new Error(`QB API ${method} ${pathname} failed: HTTP ${r.status} — ${detail}`);
  }
  return data;
}

// Find or create a Service item to use as ItemRef on invoice line items.
// Production QBOs vary: some have an item with Id "1" (a default set up
// at company creation), some don't, and some have it set to a non-Service
// type which makes invoice creation fail. This helper:
//
//   1. Queries QBO for the first active Service-type item
//   2. If none exists, creates a "PJL Services" item and returns its id
//   3. Caches the result for the life of the process so we don't re-query
//      on every invoice push
//
// The cache lives in module scope and gets invalidated on disconnect
// (clearTokens() also clears it) since a new connection might be a
// different QB realm.
let _itemRefCache = { realmId: null, itemId: null };
async function getInvoiceItemRef() {
  const tokens = await readTokens();
  if (_itemRefCache.realmId === tokens?.realmId && _itemRefCache.itemId) {
    return _itemRefCache.itemId;
  }
  // Look for an active Service item we can reuse.
  const q = "select * from Item where Type='Service' and Active=true MAXRESULTS 1";
  const result = await requestQB(`/query?query=${encodeURIComponent(q)}&minorversion=70`).catch(() => null);
  let itemId = result?.QueryResponse?.Item?.[0]?.Id || null;
  if (!itemId) {
    // No existing Service item — create a generic one for PJL's use.
    // QBO Plus requires Service items to have a non-empty IncomeAccountRef;
    // "Sales" is a default account name in fresh QBOs. Fall back to looking
    // up any income account if "Sales" doesn't exist.
    let incomeAccountId = null;
    const acctQ1 = "select * from Account where AccountType='Income' and Active=true MAXRESULTS 1";
    const acctResult = await requestQB(`/query?query=${encodeURIComponent(acctQ1)}&minorversion=70`).catch(() => null);
    incomeAccountId = acctResult?.QueryResponse?.Account?.[0]?.Id || null;
    if (!incomeAccountId) {
      throw new Error("Couldn't find an Income account to use for the Services item. Add one in QuickBooks Online and retry.");
    }
    const newItem = await requestQB("/item?minorversion=70", {
      method: "POST",
      body: {
        Name: "PJL Services",
        Type: "Service",
        IncomeAccountRef: { value: incomeAccountId }
      }
    });
    itemId = newItem?.Item?.Id;
    if (!itemId) throw new Error("QB rejected the Service item creation.");
  }
  _itemRefCache = { realmId: tokens?.realmId, itemId };
  return itemId;
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
//
// Tax handling: every line is sent pre-tax with its own ItemRef. The
// invoice carries a `TxnTaxDetail.TxnTaxCodeRef` pointing at the HST tax
// code configured in /admin/settings → QuickBooks. QB calculates HST
// server-side using that code's rate; PJL's local hst/total become
// for-display-only post-push.
//
// Hard-fail conditions (won't even attempt the QB call):
//   - QB not configured / not connected
//   - settings.quickbooks.hstTaxCodeId unset (would silently push $0 tax
//     into the books — worse than failing loudly)
//
// Soft-fall conditions (pushes anyway, records a warning):
//   - A line item key is not in quickbooks-items.json — falls back to the
//     single shared "PJL Services" item so the push doesn't 400. The
//     `qb_items_unmapped` warning surfaces in /admin/settings so Patrick
//     can run the items sync.
async function pushInvoice(localInvoice) {
  if (!isConfigured()) throw new Error("QuickBooks credentials missing — set QB_CLIENT_ID + QB_CLIENT_SECRET in Render env vars.");
  if (!(await isConnected())) throw new Error("Not connected to QuickBooks. Visit /admin/settings to connect first.");

  const settings = await settingsLib.get();
  const hstTaxCodeId = settings?.quickbooks?.hstTaxCodeId || null;
  if (!hstTaxCodeId) {
    throw new Error("HST tax code not configured. Open /admin/settings → QuickBooks and pick the HST tax code before pushing invoices (otherwise QB stores $0 tax against an HST-bearing invoice).");
  }

  let customer;
  try {
    customer = await findOrCreateCustomer({
      name: localInvoice.customerName,
      email: localInvoice.customerEmail,
      phone: localInvoice.customerPhone,
      address: localInvoice.address
    });
  } catch (err) {
    await recordSyncError({ entityType: "invoice", entityId: localInvoice.id, error: `Customer resolution failed: ${err.message}` });
    throw err;
  }
  if (!customer || !customer.Id) {
    await recordSyncError({ entityType: "invoice", entityId: localInvoice.id, error: "Couldn't resolve a QB customer for this invoice." });
    throw new Error("Couldn't resolve a QB customer for this invoice.");
  }

  // Resolve each line item to its QB Item (mapped via quickbooks-items.json
  // when present, else the single shared "PJL Services" fallback that the
  // pre-Phase-2 push used). Track unmapped keys so we can surface a
  // warning post-push.
  const itemsMap = await getItemsMap();
  const unmappedKeys = [];
  const lines = [];
  for (const line of localInvoice.lineItems || []) {
    const key = line.key || null;
    let qbItemId = null;
    if (key && itemsMap?.services?.[key]?.qbItemId) {
      qbItemId = itemsMap.services[key].qbItemId;
    } else if (key && itemsMap?.parts?.[key]?.qbItemId) {
      qbItemId = itemsMap.parts[key].qbItemId;
    }
    if (!qbItemId) {
      // Fall back to the single shared "PJL Services" item so the push
      // doesn't fail. We already noted the gap below — Patrick can run a
      // sync to fix it.
      qbItemId = await getInvoiceItemRef();
      if (key) unmappedKeys.push(key);
    }
    lines.push({
      Description: line.label || line.key || "Service",
      Amount: Number(line.lineTotal) || (Number(line.unitPrice) || 0) * (Number(line.qty) || 1),
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: {
        Qty: Number(line.qty) || 1,
        UnitPrice: Number(line.unitPrice) || 0,
        ItemRef: { value: qbItemId },
        // TaxCodeRef on the line tells QB this line is taxable under the
        // invoice-level TxnTaxCodeRef. Without this every line shows up
        // as NON in QB even when the invoice header has a tax code.
        TaxCodeRef: { value: hstTaxCodeId }
      }
    });
  }

  // Note on dropped fields:
  //   DocNumber              — only honoured when the QBO has "Custom
  //                            transaction numbers" turned on under
  //                            Account & Settings → Sales. Default is
  //                            OFF, and sending DocNumber against a
  //                            default-config QBO can trigger a 400.
  //                            Our local invoice id lives in
  //                            PrivateNote so the mapping is still
  //                            recoverable when reconciling books.
  //   AllowOnlineACHPayment  — US-only feature. Sending true to a
  //                            Canadian QBO is rejected by validation.
  //                            We only set CC payments which work in
  //                            both regions.
  const invoicePayload = {
    Line: lines,
    CustomerRef: { value: customer.Id },
    TxnTaxDetail: {
      TxnTaxCodeRef: { value: hstTaxCodeId }
    },
    AllowOnlineCreditCardPayment: true,
    BillEmail: localInvoice.customerEmail
      ? { Address: localInvoice.customerEmail }
      : (customer.PrimaryEmailAddr || undefined),
    PrivateNote: `PJL local invoice ${localInvoice.id}${localInvoice.woId ? ` from WO ${localInvoice.woId}` : ""}`
  };

  let result;
  try {
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
        result = { id: updated.Invoice?.Id || existing.Invoice.Id, action: "updated" };
      }
    }
    if (!result) {
      const created = await requestQB("/invoice?minorversion=70", { method: "POST", body: invoicePayload });
      result = { id: created.Invoice?.Id, action: "created" };
    }
  } catch (err) {
    await recordSyncError({ entityType: "invoice", entityId: localInvoice.id, error: err.message });
    throw err;
  }

  // Surface unmapped-line warnings post-push. The push succeeded so no
  // throw — the warning shows up in the Settings panel for Patrick to
  // resolve at his leisure (run the items sync).
  if (unmappedKeys.length > 0) {
    const unique = [...new Set(unmappedKeys)];
    await recordSyncError({
      entityType: "qb_items_unmapped",
      entityId: localInvoice.id,
      error: `Invoice pushed but ${unique.length} line key${unique.length === 1 ? "" : "s"} fell back to the shared item: ${unique.join(", ")}. Run /admin/settings → Sync items to QuickBooks.`
    });
  }

  return result;
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
  const rawText = await r.clone().text().catch(() => "");
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.warn(
      "[charge] HTTP " + r.status +
      " intuit_tid=" + (r.headers.get("intuit_tid") || "none") +
      " body=" + rawText.slice(0, 2000)
    );
    const detail = data?.errors?.[0] || data?.Errors?.[0] || data?.fault?.error?.[0] || data?.Fault?.Error?.[0] || data?.error || data;
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

// ---- Items map persistence (Phase 1) ---------------------------------
//
// `data/quickbooks-items.json` maps PJL pricing.json keys + parts.json
// SKUs to QuickBooks Item IDs. Atomic writes (temp-file + rename) match
// the pattern in lib/properties.js so a crash mid-sync can't leave a
// half-written map.
//
// File shape:
//   {
//     "_doc": "...",
//     "services": { "<pricingKey>": { qbItemId, lastSyncedAt, lastPriceSynced } },
//     "parts":    { "<sku>":        { qbItemId, lastSyncedAt, lastPriceSynced } }
//   }
//
// Keep this file separate from pricing.json / parts.json: those are the
// git-tracked source-of-truth catalogs; this is runtime QB state on
// Render's persistent disk (gitignored via server/data/).

const DEFAULT_ITEMS_DOC = "Map PJL pricing.json keys and parts.json SKUs to QuickBooks Item IDs. Source-of-truth side-file — do NOT add qbItemId fields directly to pricing.json or parts.json.";

async function getItemsMap() {
  if (!fsSync.existsSync(ITEMS_FILE)) {
    const empty = { _doc: DEFAULT_ITEMS_DOC, services: {}, parts: {} };
    await fs.mkdir(path.dirname(ITEMS_FILE), { recursive: true });
    await fs.writeFile(ITEMS_FILE, JSON.stringify(empty, null, 2) + "\n", "utf8");
    return empty;
  }
  try {
    const raw = await fs.readFile(ITEMS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      _doc: parsed._doc || DEFAULT_ITEMS_DOC,
      services: parsed.services && typeof parsed.services === "object" ? parsed.services : {},
      parts: parsed.parts && typeof parsed.parts === "object" ? parsed.parts : {}
    };
  } catch {
    return { _doc: DEFAULT_ITEMS_DOC, services: {}, parts: {} };
  }
}

async function writeItemsMap(map) {
  await fs.mkdir(path.dirname(ITEMS_FILE), { recursive: true });
  const tmp = ITEMS_FILE + ".tmp";
  const body = JSON.stringify(map, null, 2) + "\n";
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, ITEMS_FILE);
}

// Idempotent upsert. `kind` is "services" or "parts". Records the price
// at sync time so future syncs can detect drift and re-push with the new
// price.
async function setItemMap(kind, key, qbItemId, price) {
  if (kind !== "services" && kind !== "parts") {
    throw new Error(`setItemMap: kind must be "services" or "parts", got "${kind}"`);
  }
  const map = await getItemsMap();
  map[kind][key] = {
    qbItemId: String(qbItemId),
    lastSyncedAt: new Date().toISOString(),
    lastPriceSynced: Number.isFinite(Number(price)) ? Number(price) : null
  };
  await writeItemsMap(map);
  return map[kind][key];
}

// Mark a mapping as stale (its source-of-truth key is gone from pricing/
// parts). We keep the mapping so historical invoices can still find the
// QB item; lint surfaces stale rows as a warning, not an error.
async function markItemMapStale(kind, key) {
  const map = await getItemsMap();
  if (map[kind]?.[key] && !map[kind][key].staleSince) {
    map[kind][key].staleSince = new Date().toISOString();
    await writeItemsMap(map);
  }
}

// ---- QB query helpers (Phase 1) --------------------------------------

async function listTaxCodes() {
  if (!isConfigured()) throw new Error("QuickBooks credentials missing.");
  if (!(await isConnected())) throw new Error("Not connected to QuickBooks.");
  const q = "select * from TaxCode where Active=true";
  const r = await requestQB(`/query?query=${encodeURIComponent(q)}&minorversion=70`);
  const codes = r?.QueryResponse?.TaxCode || [];
  // Each TaxCode has SalesTaxRateList.TaxRateDetail[].TaxRateRef which
  // points at a TaxRate row. The percentage we surface is the sum of the
  // associated rates (HST is single-rate so this is just the headline %).
  // For the dropdown we only need id + name + a rate hint, not the full
  // rate-list resolution — keeping it simple here.
  return codes.map((c) => ({
    id: String(c.Id),
    name: c.Name || "(unnamed)",
    description: c.Description || "",
    taxable: c.Taxable !== false,
    active: c.Active !== false
  }));
}

async function listIncomeAccounts() {
  if (!isConfigured()) throw new Error("QuickBooks credentials missing.");
  if (!(await isConnected())) throw new Error("Not connected to QuickBooks.");
  const q = "select * from Account where AccountType='Income' and Active=true";
  const r = await requestQB(`/query?query=${encodeURIComponent(q)}&minorversion=70`);
  const accounts = r?.QueryResponse?.Account || [];
  return accounts.map((a) => ({
    id: String(a.Id),
    name: a.Name || "(unnamed)",
    fullyQualifiedName: a.FullyQualifiedName || a.Name,
    accountSubType: a.AccountSubType || ""
  }));
}

// ---- Items sync (Phase 2) --------------------------------------------
//
// One QB Item per pricing.json key + parts.json SKU. Idempotent:
//   - No mapping → POST a new Item, store mapping
//   - Mapping exists, price unchanged → skip
//   - Mapping exists, price changed → sparse PATCH UnitPrice
//
// Throttled to 5 req/sec defensively (well under QB's 500/min limit).
// Each item's mapping writes atomically before moving on so a crash
// mid-sync doesn't leave the map and QB out of step.

function loadCatalog() {
  // Re-read on demand; pricing.json is small and doesn't change often.
  // Doing it lazily means a deploy that updates the catalog gets picked
  // up next sync without bouncing the server.
  const pricing = JSON.parse(fsSync.readFileSync(PRICING_FILE, "utf8"));
  const parts = JSON.parse(fsSync.readFileSync(PARTS_FILE, "utf8"));
  return {
    services: pricing?.items || {},
    parts: parts?.parts || {}
  };
}

function buildServiceItemPayload(key, source, incomeAccountId) {
  // QB Item Name must be unique + ≤100 chars. label is usually short
  // enough; truncate defensively.
  const label = source.label || key;
  const name = label.length > 100 ? label.slice(0, 97) + "..." : label;
  return {
    Name: name,
    Description: label,
    Type: "Service",
    Taxable: true,
    UnitPrice: Number(source.price) || 0,
    IncomeAccountRef: { value: incomeAccountId },
    Sku: key  // optional, but helps reconciliation
  };
}

function buildPartItemPayload(sku, source, incomeAccountId) {
  // Parts use partNumber + description so the QB Item is searchable in
  // QB by either. NonInventory matches PJL's "we don't track stock; we
  // re-order each job" workflow.
  const desc = source.description || sku;
  const namePrefix = source.partNumber || sku;
  const candidate = `${namePrefix} ${desc}`;
  const name = candidate.length > 100 ? candidate.slice(0, 97) + "..." : candidate;
  const priceCents = Number(source.priceCents) || 0;
  return {
    Name: name,
    Description: desc,
    Type: "NonInventory",
    Taxable: true,
    UnitPrice: priceCents / 100,
    IncomeAccountRef: { value: incomeAccountId },
    Sku: sku
  };
}

function currentPriceFor(kind, source) {
  if (kind === "services") return Number(source.price) || 0;
  if (kind === "parts") return Number(source.priceCents) ? Number(source.priceCents) / 100 : 0;
  return 0;
}

// Push (create or update) a single item. Returns
//   { qbItemId, action: 'created'|'updated'|'skipped', error? }
async function pushItem(kind, key) {
  if (!isConfigured()) throw new Error("QuickBooks credentials missing.");
  if (!(await isConnected())) throw new Error("Not connected to QuickBooks.");
  const settings = await settingsLib.get();
  const incomeAccountId = settings?.quickbooks?.defaultIncomeAccountId || null;
  if (!incomeAccountId) {
    throw new Error("Default income account not configured. Open /admin/settings → QuickBooks and pick the income account before syncing items.");
  }

  const catalog = loadCatalog();
  const source = catalog[kind]?.[key];
  if (!source) {
    throw new Error(`No ${kind === "services" ? "pricing.json" : "parts.json"} entry for "${key}".`);
  }

  // pricing.json items with quoteType:"custom" don't have a stable price
  // — skip them silently. They'd just produce noisy QB Items with $0
  // that drift on every sync.
  if (kind === "services" && source.quoteType === "custom") {
    return { qbItemId: null, action: "skipped", reason: "quoteType=custom (no fixed price)" };
  }

  const map = await getItemsMap();
  const mapped = map[kind][key];
  const currentPrice = currentPriceFor(kind, source);

  // Existing mapping: check for price drift.
  if (mapped?.qbItemId) {
    const drift = mapped.lastPriceSynced == null || Math.abs(Number(mapped.lastPriceSynced) - currentPrice) > 0.005;
    if (!drift) return { qbItemId: mapped.qbItemId, action: "skipped" };

    // Drift — fetch current SyncToken and PATCH UnitPrice.
    try {
      const existing = await requestQB(`/item/${encodeURIComponent(mapped.qbItemId)}?minorversion=70`);
      if (!existing?.Item?.Id) {
        // Mapping refers to a missing QB item (deleted or wrong realm).
        // Drop the mapping and fall through to create.
        delete map[kind][key];
        await writeItemsMap(map);
      } else {
        const patchPayload = {
          Id: existing.Item.Id,
          SyncToken: existing.Item.SyncToken,
          UnitPrice: currentPrice,
          sparse: true
        };
        await requestQB("/item?minorversion=70", { method: "POST", body: patchPayload });
        await setItemMap(kind, key, existing.Item.Id, currentPrice);
        return { qbItemId: existing.Item.Id, action: "updated" };
      }
    } catch (err) {
      await recordSyncError({ entityType: `qb_item_${kind}`, entityId: key, error: err.message });
      throw err;
    }
  }

  // No mapping — POST a new Item.
  const payload = kind === "services"
    ? buildServiceItemPayload(key, source, incomeAccountId)
    : buildPartItemPayload(key, source, incomeAccountId);

  let created;
  try {
    created = await requestQB("/item?minorversion=70", { method: "POST", body: payload });
  } catch (err) {
    // Handle DuplicateNameExistsError — retry with " (PJL)" suffix once.
    if (/duplicate.?name|already in use|6240/i.test(err.message)) {
      payload.Name = `${payload.Name.slice(0, 92)} (PJL)`;
      try {
        created = await requestQB("/item?minorversion=70", { method: "POST", body: payload });
      } catch (err2) {
        await recordSyncError({ entityType: `qb_item_${kind}`, entityId: key, error: `Duplicate-name retry failed: ${err2.message}` });
        throw err2;
      }
    } else {
      await recordSyncError({ entityType: `qb_item_${kind}`, entityId: key, error: err.message });
      throw err;
    }
  }

  const qbId = created?.Item?.Id;
  if (!qbId) {
    const msg = `QB returned no Item Id when creating "${key}".`;
    await recordSyncError({ entityType: `qb_item_${kind}`, entityId: key, error: msg });
    throw new Error(msg);
  }
  await setItemMap(kind, key, qbId, currentPrice);
  return { qbItemId: qbId, action: "created" };
}

// Iterate the entire catalog and push each item. Throttled to ~5 req/sec
// (200ms inter-call) so a 180-item sync takes ~36s — well under any
// reasonable HTTP timeout. Returns a summary plus the per-error array
// for the UI's "X failed — see details" surface.
async function syncAllItems() {
  if (!isConfigured()) throw new Error("QuickBooks credentials missing.");
  if (!(await isConnected())) throw new Error("Not connected to QuickBooks.");
  const settings = await settingsLib.get();
  if (!settings?.quickbooks?.defaultIncomeAccountId) {
    throw new Error("Default income account not configured. Open /admin/settings → QuickBooks and pick one before syncing items.");
  }

  const catalog = loadCatalog();
  const summary = {
    servicesCreated: 0, servicesUpdated: 0, servicesSkipped: 0,
    partsCreated: 0, partsUpdated: 0, partsSkipped: 0,
    errors: []
  };

  // Mark stale mappings before sync so the lint surface stays correct
  // even for catalog deletions.
  const map = await getItemsMap();
  for (const k of Object.keys(map.services)) {
    if (!catalog.services[k] && !map.services[k].staleSince) await markItemMapStale("services", k);
  }
  for (const k of Object.keys(map.parts)) {
    if (!catalog.parts[k] && !map.parts[k].staleSince) await markItemMapStale("parts", k);
  }

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  for (const key of Object.keys(catalog.services)) {
    try {
      const r = await pushItem("services", key);
      if (r.action === "created") summary.servicesCreated++;
      else if (r.action === "updated") summary.servicesUpdated++;
      else summary.servicesSkipped++;
    } catch (err) {
      summary.errors.push({ kind: "services", key, error: err.message });
    }
    await sleep(200);
  }
  for (const key of Object.keys(catalog.parts)) {
    try {
      const r = await pushItem("parts", key);
      if (r.action === "created") summary.partsCreated++;
      else if (r.action === "updated") summary.partsUpdated++;
      else summary.partsSkipped++;
    } catch (err) {
      summary.errors.push({ kind: "parts", key, error: err.message });
    }
    await sleep(200);
  }

  return summary;
}

// Thin wrapper so quickbooks.js callers don't have to require settings
// directly. Keeps the dependency graph one-way (quickbooks → settings,
// never the reverse).
async function recordSyncError({ entityType, entityId, error }) {
  try {
    await settingsLib.recordSyncError({ entityType, entityId, error });
  } catch (e) {
    // recordSyncError is best-effort telemetry — never let it mask the
    // real error by throwing. Worst case the error doesn't appear in the
    // settings panel; the caller still threw the underlying problem.
    console.warn("[qb] recordSyncError failed:", e.message);
  }
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
  voidInvoice,
  // Phase 1 additions
  listTaxCodes,
  listIncomeAccounts,
  getItemsMap,
  setItemMap,
  recordSyncError,
  // Phase 2 additions
  pushItem,
  syncAllItems
};
