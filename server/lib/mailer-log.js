// Send ledger — JOB-008 (INF-02 phase one).
//
// Append-only log of every outbound email ATTEMPT, one entry per attempt:
//   { ts, kind, to, ok, error?, refId? }
// where `kind` is one of KINDS below and `refId` is the lead / invoice /
// WO id where one exists. The ledger is server-side data and may hold the
// full recipient address; only the SMS alert masks it.
//
// This module must NEVER change the behaviour of a send: logSend() never
// throws and never rejects — a ledger failure is itself only a console
// line. Callers may await it (it's fast) or fire-and-forget.
//
// On any logged CUSTOMER-FACING failure this also dispatches the Task 3
// digest SMS to Patrick — at most one per hour via lib/rate-limit — so an
// outage sends one alarm, not two hundred.
//
// Storage: server/data/email-log.json. Self-pruning like magic-tokens.js:
// keep 90 days or 5 000 entries, whichever is smaller.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const rateLimit = require("./rate-limit");
const { sendEmailFailureAlertSms } = require("./notify-sms");

const FILE = path.join(__dirname, "..", "data", "email-log.json");
// Failures Patrick has looked at and waved off — reached by phone, stale,
// or handled some other way. Kept beside the ledger, never in it: the
// ledger is what happened, this is what he decided about it.
const DISMISSED_FILE = path.join(__dirname, "..", "data", "email-dismissed.json");

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const MAX_ENTRIES = 5000;

const KINDS = new Set([
  "magic_link", "invoice", "receipt", "completion", "stage_notice",
  "review_ask", "portal_reply", "booking_cancel", "lead_alert",
  "outreach", "supplier", "other"
]);

// Failures of these kinds page Patrick (digest-limited). Admin-facing and
// supplier failures stay ledger-only — the lead-alert path already has its
// own SMS redundancy, and interactive sends surface errors in the admin UI.
const CUSTOMER_FACING = new Set([
  "magic_link", "invoice", "receipt", "completion", "stage_notice",
  "review_ask", "portal_reply", "booking_cancel"
]);

// One digest SMS per hour, tops.
const ALERT_KEY = "email-failure-sms";
const ALERT_LIMIT = 1;
const ALERT_WINDOW_MS = 60 * 60 * 1000;

// ---- File I/O ---------------------------------------------------------
// All writes are funnelled through a single promise chain so concurrent
// sends (e.g. an outreach batch) can't interleave read-modify-write and
// drop each other's entries.

let writeChain = Promise.resolve();

async function ensureFile() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  if (!fsSync.existsSync(FILE)) {
    await fs.writeFile(FILE, "[]\n", "utf8");
  }
}

async function readAll() {
  await ensureFile();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(records) {
  await ensureFile();
  await fs.writeFile(FILE, JSON.stringify(records, null, 2) + "\n", "utf8");
}

function prune(records) {
  const cutoff = Date.now() - RETENTION_MS;
  let kept = records.filter((r) => (Date.parse(r.ts) || 0) >= cutoff);
  if (kept.length > MAX_ENTRIES) kept = kept.slice(kept.length - MAX_ENTRIES);
  return kept;
}

// ---- Alerting (Task 3) ------------------------------------------------

// "j***@example.com" — never the full local part. The full address lives
// only in the server-side ledger.
function maskRecipient(to) {
  const addr = String(to || "").trim();
  const at = addr.indexOf("@");
  if (at < 1) return addr ? "***" : "(no address)";
  return `${addr[0]}***@${addr.slice(at + 1)}`;
}

async function maybeAlert(records) {
  const hourAgo = Date.now() - ALERT_WINDOW_MS;
  const recent = records.filter((r) =>
    !r.ok && CUSTOMER_FACING.has(r.kind) && (Date.parse(r.ts) || 0) >= hourAgo
  );
  if (!recent.length) return;
  if (!rateLimit.check(ALERT_KEY, ALERT_LIMIT, ALERT_WINDOW_MS)) return;
  rateLimit.record(ALERT_KEY);
  const first = recent[0];
  const body =
    `⚠ ${recent.length} customer email(s) failed in the last hour ` +
    `(first: ${first.kind} to ${maskRecipient(first.to)}). ` +
    `Check Admin → Email health.`;
  await sendEmailFailureAlertSms(body);
}

// ---- Public API -------------------------------------------------------

// Record one send attempt. Never throws, never rejects.
function logSend({ kind, to, ok, error, refId, resendOf } = {}) {
  const entry = {
    ts: new Date().toISOString(),
    kind: KINDS.has(kind) ? kind : "other",
    to: String(to || "").trim(),
    ok: Boolean(ok)
  };
  if (!entry.ok && error) entry.error = String(error).slice(0, 500);
  if (refId) entry.refId = String(refId);
  // A resend says so, and names the attempt it is making good. Without
  // this the ledger records a second send and nothing distinguishes it
  // from an ordinary one — "why did this customer get two?" would have no
  // answer in the only place that keeps the history.
  if (resendOf) entry.resendOf = String(resendOf);

  writeChain = writeChain.then(async () => {
    const records = prune(await readAll());
    records.push(entry);
    await writeAll(records);
    if (!entry.ok) await maybeAlert(records);
  }).catch((err) => {
    console.error("[mailer-log] ledger write failed:", err?.message);
  });
  return writeChain;
}

// ---- Outstanding failures ---------------------------------------------
//
// A failure is OUTSTANDING when nothing has gone through SINCE, to the same
// recipient, about the same thing. Anything else is history: a bad address
// that later succeeded, or a retry that worked.
//
// Defined once, here, because two readers need the same answer and must
// never disagree — the panel that counts them and the resend that acts on
// them. A resend driven by a stale list is how a customer gets the same
// email twice.
//
// WHY THIS EXISTS. 2026-09-11: Patrick changed his Google account password,
// which silently revoked the app password every outbound email in this
// system shares. 56 sends died on authentication in an hour — customer
// cancellation confirmations among them. Nothing retries and nothing
// queues, so this ledger was the only record those messages had ever been
// attempted. It is now also the way to put them right.
function outstandingKey(entry) {
  return [
    entry.kind,
    entry.refId || "",
    String(entry.to || "").trim().toLowerCase()
  ].join("|");
}

// A stable name for one ledger entry, so the panel can hand the server back
// exactly the failure a human picked. The timestamp is the entry's identity
// (the ledger is append-only and one entry is written per attempt); the key
// rides along so a tampered id can't point at a different message.
function failureId(entry) {
  return `${entry.ts}|${outstandingKey(entry)}`;
}

// The kinds a resend can faithfully REBUILD from a record that still
// exists. Deliberately short, and everything left out is left out for a
// reason rather than for now:
//   magic_link  — a fresh link is a new credential with a new expiry.
//                 Re-issuing one because an old send failed hands out a
//                 login by way of an error log. The customer asks again.
//   outreach    — a campaign step owned by the cadence, not by this
//                 ledger. Resending one here would double-message someone
//                 whose step the cadence still considers spent.
//   invoice / receipt / completion / stage_notice / review_ask /
//   portal_reply / supplier / other
//               — each is generated inside its own flow with context this
//                 ledger doesn't keep. They are listed for a human with
//                 the full address and error, which is the honest answer
//                 rather than a rebuild that quietly says something else.
const RESENDABLE_KINDS = new Set(["booking_cancel", "lead_alert"]);

// Failures still outstanding, newest first, one per thing (five failed
// attempts at the same message are one problem, not five).
//
// Returns the REAL recipient — this is server-side data and the resend
// needs it. Mask at the route.
async function readDismissed() {
  try {
    const raw = await fs.readFile(DISMISSED_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Wave off failures by id. They stay in the ledger (the outage is still
// history); they leave the "never went out" list. Returns how many were
// newly dismissed.
async function dismissFailures(ids, { by = "admin", note = "" } = {}) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
  if (!wanted.length) return { ok: true, dismissed: 0 };
  const current = await readDismissed();
  const now = new Date().toISOString();
  let dismissed = 0;
  for (const id of wanted) {
    if (current[id]) continue;
    current[id] = { ts: now, by: String(by).slice(0, 120), ...(note ? { note: String(note).slice(0, 200) } : {}) };
    dismissed += 1;
  }
  if (dismissed) {
    await fs.mkdir(path.dirname(DISMISSED_FILE), { recursive: true });
    await fs.writeFile(DISMISSED_FILE, JSON.stringify(current, null, 2) + "\n", "utf8");
  }
  return { ok: true, dismissed };
}

// `dismissed` may be handed in (a Set of failure ids) — tests do — else
// it is read from the file beside the ledger.
async function outstandingFailures({ sinceMs = 30 * 24 * 60 * 60 * 1000, now = Date.now(), dismissed = null } = {}) {
  const records = await readAll();
  const cutoff = now - sinceMs;
  const waved = dismissed instanceof Set ? dismissed : new Set(Object.keys(await readDismissed()));

  // Latest success per key first, so one pass can answer "anything since?"
  const lastOkByKey = new Map();
  for (const r of records) {
    if (!r.ok) continue;
    const key = outstandingKey(r);
    const prev = lastOkByKey.get(key);
    if (!prev || r.ts > prev) lastOkByKey.set(key, r.ts);
  }

  const newestByKey = new Map();
  for (const r of records) {
    if (r.ok) continue;
    if ((Date.parse(r.ts) || 0) < cutoff) continue;
    const key = outstandingKey(r);
    const okAt = lastOkByKey.get(key);
    if (okAt && okAt > r.ts) continue;            // it went through later
    const prev = newestByKey.get(key);
    if (!prev || r.ts > prev.ts) newestByKey.set(key, r);
  }

  return [...newestByKey.values()]
    .filter((r) => !waved.has(failureId(r)))
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .map((r) => ({
      id: failureId(r),
      ts: r.ts,
      kind: r.kind,
      to: r.to || "",
      refId: r.refId || "",
      error: r.error || "",
      resendable: RESENDABLE_KINDS.has(r.kind)
    }));
}

// Task 4 — aggregate view for /api/admin/email-health.
// Returns last-7-day sent/failed counts by kind, the most recent 20
// failures (masked recipient), and — per Patrick's 2026-08-03 ruling —
// the timestamp of the last SUCCESSFUL send, overall and per kind:
// during a total outage, zero-sent/zero-failed is indistinguishable
// from a quiet day; "last success: 3 days ago" is the tell.
async function healthSummary() {
  const records = await readAll();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const last7d = {};
  const lastSuccessByKind = {};
  let lastSuccessAt = null;

  for (const r of records) {
    const t = Date.parse(r.ts) || 0;
    if (r.ok) {
      if (!lastSuccessAt || r.ts > lastSuccessAt) lastSuccessAt = r.ts;
      const prev = lastSuccessByKind[r.kind];
      if (!prev || r.ts > prev) lastSuccessByKind[r.kind] = r.ts;
    }
    if (t < weekAgo) continue;
    const bucket = last7d[r.kind] || (last7d[r.kind] = { sent: 0, failed: 0 });
    if (r.ok) bucket.sent += 1; else bucket.failed += 1;
  }

  const recentFailures = records
    .filter((r) => !r.ok)
    .slice(-20)
    .reverse()
    .map((r) => ({
      ts: r.ts,
      kind: r.kind,
      to: maskRecipient(r.to),
      error: r.error || "",
      refId: r.refId || ""
    }));

  return { last7d, recentFailures, lastSuccessAt, lastSuccessByKind };
}

module.exports = {
  logSend, healthSummary, maskRecipient, outstandingFailures, failureId,
  dismissFailures, readDismissed, DISMISSED_FILE,
  KINDS: [...KINDS], CUSTOMER_FACING: [...CUSTOMER_FACING],
  RESENDABLE_KINDS: [...RESENDABLE_KINDS]
};
