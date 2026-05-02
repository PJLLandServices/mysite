// Settings — admin notification defaults + per-customer overrides +
// customer portal preferences. Spec §1.3 (the three-layer notification
// model). Stored in server/data/settings.json — single object, no record
// list. Customer overrides + portal prefs live on the lead/property
// records themselves; this module owns the GLOBAL defaults.
//
// The schema:
//   {
//     adminDefaults: {
//       newLead:        "email_sms" | "email" | "sms" | "silent",
//       quoteAccepted:  "email_sms" | ...,
//       woCompleted:    "email_sms" | ...,
//       portalMessage:  "email_sms" | ...,
//       emergencyOverride: "email_sms" | ... (always "email_sms" recommended)
//     },
//     audit: [
//       { ts, who, action, before, after }   // last 50 changes
//     ]
//   }
//
// Per-customer overrides live on `lead.notificationPreferences` (per-event
// override) and customer-side prefs on `lead.customerPreferences` (text/
// email opt-in). This module is just the global defaults + audit trail.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "data", "settings.json");

const NOTIFY_MODES = ["email_sms", "email", "sms", "silent"];

const DEFAULT_SETTINGS = {
  adminDefaults: {
    newLead: "email_sms",
    quoteAccepted: "email_sms",
    woCompleted: "email_sms",
    portalMessage: "email_sms",
    emergencyOverride: "email_sms",
    portalPreAuth: "email"
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
  return {
    adminDefaults: { ...DEFAULT_SETTINGS.adminDefaults, ...(s?.adminDefaults || {}) },
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

module.exports = {
  NOTIFY_MODES,
  DEFAULT_SETTINGS,
  get,
  updateAdminDefaults,
  resolveMode,
  shouldSendEmail,
  shouldSendSms
};
