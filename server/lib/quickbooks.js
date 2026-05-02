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
  const r = await fetch(`${OAUTH_BASE}/oauth2/v1/tokens/bearer_token`, {
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
  const r = await fetch(`${OAUTH_BASE}/oauth2/v1/tokens/bearer_token`, {
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

  const invoicePayload = {
    Line: lines,
    CustomerRef: { value: customer.Id },
    DocNumber: localInvoice.id,
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

module.exports = {
  isConfigured,
  isConnected,
  envCfg,
  buildAuthUrl,
  exchangeCodeForTokens,
  pushInvoice,
  clearTokens
};
