// Settings — admin notification defaults + per-customer overrides +
// customer portal preferences + QuickBooks integration config. Stored in
// server/data/settings.json — single object, no record list. Customer
// overrides + portal prefs live on the lead/property records themselves;
// this module owns the GLOBAL defaults.
//
// The schema:
//   {
//     adminDefaults: { newLead, quoteAccepted, woCompleted, ... },
//     quickbooks: {
//       hstTaxCodeId, hstTaxCodeName,
//       defaultIncomeAccountId, defaultIncomeAccountName,
//       estimateAutoPushOnAccept, invoiceAutoPushOnCascade,
//       lastSyncErrors: [{ ts, entityType, entityId, error }]   // cap 20
//     },
//     icalFeed: {
//       enabled,           // boolean — false until first generate
//       token,             // 32-char hex; null when disabled / never generated
//       regeneratedAt      // ISO timestamp of last generate/regenerate
//     },
//     audit: [{ ts, who, action, before, after }]               // cap 50
//   }
//
// Per-customer overrides live on `lead.notificationPreferences` (per-event
// override) and customer-side prefs on `lead.customerPreferences` (text/
// email opt-in). This module is just the global defaults + audit trail.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE = path.join(__dirname, "..", "data", "settings.json");

const NOTIFY_MODES = ["email_sms", "email", "sms", "silent"];
const SYNC_ERRORS_CAP = 20;

const DEFAULT_ICAL_FEED = {
  enabled: false,
  token: null,
  regeneratedAt: null
};

const DEFAULT_QUICKBOOKS = {
  hstTaxCodeId: null,
  hstTaxCodeName: null,
  defaultIncomeAccountId: null,
  defaultIncomeAccountName: null,
  estimateAutoPushOnAccept: false,
  invoiceAutoPushOnCascade: false,
  lastSyncErrors: []
};

// Seasonal-outreach message templates (feature-seasonal-outreach-brief.md
// §3.2). Patrick saves a per-season subject + SMS body + email body from
// the compose modal's "Save as default" path; the outreach page seeds the
// compose form from these on next open. Empty strings are valid — they
// signal "no saved template yet, start blank."
const BLANK_OUTREACH_TEMPLATE = { subject: "", smsBody: "", emailBody: "" };
const DEFAULT_OUTREACH_TEMPLATES = {
  spring: { ...BLANK_OUTREACH_TEMPLATE },
  fall: { ...BLANK_OUTREACH_TEMPLATE }
};

const DEFAULT_SETTINGS = {
  adminDefaults: {
    newLead: "email_sms",
    quoteAccepted: "email_sms",
    woCompleted: "email_sms",
    portalMessage: "email_sms",
    emergencyOverride: "email_sms",
    portalPreAuth: "email"
  },
  quickbooks: { ...DEFAULT_QUICKBOOKS, lastSyncErrors: [] },
  icalFeed: { ...DEFAULT_ICAL_FEED },
  outreachTemplates: {
    spring: { ...BLANK_OUTREACH_TEMPLATE },
    fall: { ...BLANK_OUTREACH_TEMPLATE }
  },
  audit: []
};

async function ensureFile() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  if (!fsSync.existsSync(FILE)) {
    await fs.writeFile(FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n", "utf8");
  }
}

async function readAll() {
  await ensureFile();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return hydrate(parsed);
  } catch {
    return hydrate({});
  }
}

async function writeAll(settings) {
  await ensureFile();
  await fs.writeFile(FILE, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function hydrate(s) {
  const qb = s?.quickbooks || {};
  const ical = s?.icalFeed || {};
  const out = s?.outreachTemplates || {};
  const pickTemplate = (key) => {
    const t = out[key] || {};
    return {
      subject: typeof t.subject === "string" ? t.subject : "",
      smsBody: typeof t.smsBody === "string" ? t.smsBody : "",
      emailBody: typeof t.emailBody === "string" ? t.emailBody : ""
    };
  };
  return {
    adminDefaults: { ...DEFAULT_SETTINGS.adminDefaults, ...(s?.adminDefaults || {}) },
    quickbooks: {
      hstTaxCodeId: qb.hstTaxCodeId || null,
      hstTaxCodeName: qb.hstTaxCodeName || null,
      defaultIncomeAccountId: qb.defaultIncomeAccountId || null,
      defaultIncomeAccountName: qb.defaultIncomeAccountName || null,
      estimateAutoPushOnAccept: qb.estimateAutoPushOnAccept === true,
      invoiceAutoPushOnCascade: qb.invoiceAutoPushOnCascade === true,
      lastSyncErrors: Array.isArray(qb.lastSyncErrors) ? qb.lastSyncErrors.slice(0, SYNC_ERRORS_CAP) : []
    },
    icalFeed: {
      enabled: ical.enabled === true,
      token: typeof ical.token === "string" && ical.token ? ical.token : null,
      regeneratedAt: ical.regeneratedAt || null
    },
    outreachTemplates: {
      spring: pickTemplate("spring"),
      fall: pickTemplate("fall")
    },
    audit: Array.isArray(s?.audit) ? s.audit : []
  };
}

async function get() {
  return readAll();
}

// Update admin defaults. `who` and `note` go into the audit trail.
async function updateAdminDefaults(patch, { who = "admin", note = "" } = {}) {
  const settings = await readAll();
  const before = { ...settings.adminDefaults };
  for (const key of Object.keys(patch || {})) {
    if (NOTIFY_MODES.includes(patch[key])) {
      settings.adminDefaults[key] = patch[key];
    }
  }
  // Audit entry — keeps last 50 changes so the UI can show a recent
  // history without bloating the file.
  settings.audit.unshift({
    ts: new Date().toISOString(),
    who,
    action: "adminDefaults",
    before,
    after: { ...settings.adminDefaults },
    note
  });
  if (settings.audit.length > 50) settings.audit.length = 50;
  await writeAll(settings);
  return settings;
}

// Resolve the effective notification mode for a given event + lead.
// Per-customer override (lead.notificationPreferences[event]) wins if set;
// otherwise falls back to admin defaults; otherwise "silent".
function resolveMode(settings, eventKey, lead = null) {
  const override = lead && lead.notificationPreferences && lead.notificationPreferences[eventKey];
  if (NOTIFY_MODES.includes(override)) return override;
  return settings?.adminDefaults?.[eventKey] || "silent";
}

// Should we send email for this event?
function shouldSendEmail(mode) { return mode === "email_sms" || mode === "email"; }
// Should we send SMS for this event?
function shouldSendSms(mode) { return mode === "email_sms" || mode === "sms"; }

// Update the `quickbooks` settings namespace. Audit-stamps. Validates the
// shape of incoming patch keys but doesn't sanity-check IDs against QB
// itself — that's the caller's job (caller looked them up via the QB
// query helpers). `who` and `note` go into the audit trail.
const QB_PATCH_KEYS = [
  "hstTaxCodeId", "hstTaxCodeName",
  "defaultIncomeAccountId", "defaultIncomeAccountName",
  "estimateAutoPushOnAccept", "invoiceAutoPushOnCascade"
];
async function updateQuickbooks(patch, { who = "admin", note = "" } = {}) {
  const settings = await readAll();
  const before = { ...settings.quickbooks };
  for (const key of QB_PATCH_KEYS) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
      if (key === "estimateAutoPushOnAccept" || key === "invoiceAutoPushOnCascade") {
        settings.quickbooks[key] = patch[key] === true;
      } else if (patch[key] === null || typeof patch[key] === "string") {
        settings.quickbooks[key] = patch[key] || null;
      }
    }
  }
  settings.audit.unshift({
    ts: new Date().toISOString(),
    who,
    action: "quickbooks",
    before,
    after: { ...settings.quickbooks },
    note
  });
  if (settings.audit.length > 50) settings.audit.length = 50;
  await writeAll(settings);
  return settings;
}

// Append a sync error to the rolling `lastSyncErrors` buffer (newest first,
// cap 20). Does NOT touch the audit trail — audit is for human-driven
// settings changes; sync errors are operational telemetry. Returns the
// updated settings record.
async function recordSyncError({ entityType, entityId, error }) {
  const settings = await readAll();
  const entry = {
    ts: new Date().toISOString(),
    entityType: String(entityType || "unknown"),
    entityId: String(entityId || ""),
    error: String(error || "").slice(0, 500)
  };
  settings.quickbooks.lastSyncErrors.unshift(entry);
  if (settings.quickbooks.lastSyncErrors.length > SYNC_ERRORS_CAP) {
    settings.quickbooks.lastSyncErrors.length = SYNC_ERRORS_CAP;
  }
  await writeAll(settings);
  return settings;
}

// Clear the lastSyncErrors buffer. Used when the admin wants to dismiss
// the warnings panel after acknowledging them.
async function clearSyncErrors() {
  const settings = await readAll();
  settings.quickbooks.lastSyncErrors = [];
  await writeAll(settings);
  return settings;
}

// ---------- iCal feed token management (Brief C) -------------------
// The feed at GET /calendar/:token.ics is gated by this token alone —
// no other auth. The token IS the credential, so regenerate invalidates
// the old URL (use when sharing the URL leaks it accidentally).

function makeIcalToken() {
  return crypto.randomBytes(16).toString("hex"); // 32 hex chars
}

// Idempotent generate — returns the existing token if one is already
// set and enabled. Use regenerateIcalToken() to force a new token.
async function generateIcalToken({ who = "admin" } = {}) {
  const settings = await readAll();
  if (settings.icalFeed.enabled && settings.icalFeed.token) {
    return settings;
  }
  const before = { ...settings.icalFeed };
  settings.icalFeed = {
    enabled: true,
    token: makeIcalToken(),
    regeneratedAt: new Date().toISOString()
  };
  settings.audit.unshift({
    ts: new Date().toISOString(),
    who,
    action: "icalFeed.generate",
    // Don't write tokens into the audit log — only the side effect.
    before: { enabled: before.enabled },
    after: { enabled: true },
    note: "iCal feed generated"
  });
  if (settings.audit.length > 50) settings.audit.length = 50;
  await writeAll(settings);
  return settings;
}

async function regenerateIcalToken({ who = "admin" } = {}) {
  const settings = await readAll();
  const before = { ...settings.icalFeed };
  settings.icalFeed = {
    enabled: true,
    token: makeIcalToken(),
    regeneratedAt: new Date().toISOString()
  };
  settings.audit.unshift({
    ts: new Date().toISOString(),
    who,
    action: "icalFeed.regenerate",
    before: { enabled: before.enabled },
    after: { enabled: true },
    note: "iCal feed token regenerated (old URL now invalid)"
  });
  if (settings.audit.length > 50) settings.audit.length = 50;
  await writeAll(settings);
  return settings;
}

async function disableIcalFeed({ who = "admin" } = {}) {
  const settings = await readAll();
  const before = { ...settings.icalFeed };
  settings.icalFeed = {
    enabled: false,
    token: null,
    regeneratedAt: settings.icalFeed.regeneratedAt
  };
  settings.audit.unshift({
    ts: new Date().toISOString(),
    who,
    action: "icalFeed.disable",
    before: { enabled: before.enabled },
    after: { enabled: false },
    note: "iCal feed disabled (subscribers will hit 404)"
  });
  if (settings.audit.length > 50) settings.audit.length = 50;
  await writeAll(settings);
  return settings;
}

// Save a seasonal-outreach template (subject + smsBody + emailBody).
// `season` must be "spring" or "fall". Missing keys in the patch keep
// the existing value; passing an empty string clears that piece. Audit-
// stamps under "outreachTemplates.<season>".
async function saveOutreachTemplate(season, patch, { who = "admin", note = "" } = {}) {
  const slot = season === "spring" || season === "fall" ? season : null;
  if (!slot) throw new Error(`Unknown season for outreach template: ${season}`);
  const settings = await readAll();
  const current = settings.outreachTemplates?.[slot] || { ...BLANK_OUTREACH_TEMPLATE };
  const next = {
    subject: typeof patch?.subject === "string" ? patch.subject : current.subject,
    smsBody: typeof patch?.smsBody === "string" ? patch.smsBody : current.smsBody,
    emailBody: typeof patch?.emailBody === "string" ? patch.emailBody : current.emailBody
  };
  settings.outreachTemplates = {
    ...settings.outreachTemplates,
    [slot]: next
  };
  settings.audit.unshift({
    ts: new Date().toISOString(),
    who,
    action: `outreachTemplates.${slot}`,
    before: current,
    after: next,
    note
  });
  if (settings.audit.length > 50) settings.audit.length = 50;
  await writeAll(settings);
  return settings;
}

// Generic audit-trail append. Used by callers OUTSIDE of admin-defaults
// /quickbooks (e.g. catalog edits — see lib/parts.js). Same 50-entry
// rolling buffer; oldest entries fall off the end.
//
// `action` is a dotted string like "catalog.add" / "catalog.import" so
// the UI can filter by namespace. `before` / `after` are optional
// structured payloads; `note` is the human-readable summary the audit
// viewer surfaces.
async function recordAudit({ who = "admin", action, before = null, after = null, note = "" } = {}) {
  if (!action) throw new Error("audit action required");
  const settings = await readAll();
  settings.audit.unshift({
    ts: new Date().toISOString(),
    who,
    action: String(action),
    before,
    after,
    note: String(note || "")
  });
  if (settings.audit.length > 50) settings.audit.length = 50;
  await writeAll(settings);
  return settings;
}

module.exports = {
  NOTIFY_MODES,
  DEFAULT_SETTINGS,
  SYNC_ERRORS_CAP,
  get,
  updateAdminDefaults,
  updateQuickbooks,
  recordSyncError,
  clearSyncErrors,
  recordAudit,
  generateIcalToken,
  regenerateIcalToken,
  disableIcalFeed,
  saveOutreachTemplate,
  resolveMode,
  shouldSendEmail,
  shouldSendSms
};
