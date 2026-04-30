// Booking-session store — short-lived envelopes that carry data from a
// pre-booking touchpoint (the AI chat agent, an external CRM, a service-area
// page CTA with a diagnosis pre-attached) into /book.html.
//
// The flow it enables:
//   1. AI chat or external system POSTs to /api/booking/prepare-session
//      with a diagnosis payload + suggested service + customer hints.
//   2. We persist the session to disk with a 1-hour TTL and return a
//      short token.
//   3. The customer is sent to /book.html?session=<token>.
//   4. book.html GETs /api/booking/session/:token, prefills the booking
//      flow (service card pre-selected, contact fields populated, zone
//      count if known), and silently attaches the diagnosis to the
//      booking when reserved.
//   5. The diagnosis lands on lead.booking.workOrder.diagnosis — visible
//      to both PJL (CRM) and the customer (portal).
//
// Sessions are deleted from disk when consumed (used by /reserve) or when
// they expire. We don't index by customer email because the same customer
// may have multiple chat sessions in flight; the token IS the identity.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE = path.join(__dirname, "..", "data", "booking-sessions.json");
const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

async function ensureFile() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  if (!fsSync.existsSync(FILE)) {
    await fs.writeFile(FILE, "{}\n", "utf8");
  }
}

async function readAll() {
  await ensureFile();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const data = JSON.parse(raw || "{}");
    // Sweep expired entries on every read so the file doesn't grow forever.
    const now = Date.now();
    let dirty = false;
    for (const token of Object.keys(data)) {
      if (!data[token].expiresAt || data[token].expiresAt < now) {
        delete data[token];
        dirty = true;
      }
    }
    if (dirty) await fs.writeFile(FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
    return data;
  } catch {
    return {};
  }
}

async function writeAll(data) {
  await ensureFile();
  await fs.writeFile(FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// Tokens — 24 base64url chars from 18 random bytes. Short enough for a URL,
// long enough that brute-forcing the session space is infeasible.
function mintToken() {
  return crypto.randomBytes(18).toString("base64url");
}

// Create a new session. The shape of `payload` is intentionally permissive —
// the AI agent owns the diagnosis text, and we just persist whatever fields
// it sends. The booking page reads the ones it knows about and ignores the rest.
async function createSession(payload, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const token = mintToken();
  const now = Date.now();
  const session = {
    token,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + ttlSeconds * 1000,
    consumed: false,
    consumedAt: null,
    leadId: null,
    payload: {
      diagnosis: typeof payload.diagnosis === "string" ? payload.diagnosis.slice(0, 4000) : "",
      diagnosisSummary: typeof payload.diagnosisSummary === "string" ? payload.diagnosisSummary.slice(0, 280) : "",
      suggestedService: typeof payload.suggestedService === "string" ? payload.suggestedService.slice(0, 60) : "",
      suggestedTier: typeof payload.suggestedTier === "string" ? payload.suggestedTier.slice(0, 60) : "",
      severity: typeof payload.severity === "string" ? payload.severity.slice(0, 30) : "",
      source: typeof payload.source === "string" ? payload.source.slice(0, 40) : "ai_chat",
      customerHints: payload.customerHints && typeof payload.customerHints === "object"
        ? {
            firstName: String(payload.customerHints.firstName || "").slice(0, 80),
            lastName:  String(payload.customerHints.lastName  || "").slice(0, 80),
            email:     String(payload.customerHints.email     || "").slice(0, 254),
            phone:     String(payload.customerHints.phone     || "").slice(0, 40),
            address:   String(payload.customerHints.address   || "").slice(0, 320),
            zoneCount: payload.customerHints.zoneCount === "unsure"
              ? "unsure"
              : (Number.isFinite(Number(payload.customerHints.zoneCount))
                  ? Math.min(24, Math.max(1, Math.floor(Number(payload.customerHints.zoneCount))))
                  : null),
            notes:     String(payload.customerHints.notes     || "").slice(0, 1500)
          }
        : null,
      // Line items the AI / admin chose during the handoff. When the
      // customer reserves a slot, these get pre-populated as features on
      // the lead so the work order shows the full repair plan, not just
      // the slot-determining service. Each entry is { key, qty } — the
      // server resolves `key` against its FEATURES catalog at reserve time
      // (so the price + label can't be tampered with from the AI side).
      lineItems: Array.isArray(payload.lineItems)
        ? payload.lineItems
            .filter((item) => item && typeof item.key === "string")
            .map((item) => ({
              key: item.key.slice(0, 60),
              qty: Math.max(1, Math.min(99, Math.floor(Number(item.qty) || 1)))
            }))
            .slice(0, 20)
        : []
    }
  };
  const data = await readAll();
  data[token] = session;
  await writeAll(data);
  return session;
}

async function getSession(token) {
  if (!token || typeof token !== "string") return null;
  const data = await readAll();
  const session = data[token];
  if (!session) return null;
  if (session.expiresAt < Date.now()) return null;
  return session;
}

// Mark a session consumed once it's been used to create a lead. We keep the
// record around (not deleted) for audit trail — Patrick can see in the data
// file which AI sessions converted into actual bookings.
async function markConsumed(token, leadId) {
  const data = await readAll();
  if (!data[token]) return false;
  data[token].consumed = true;
  data[token].consumedAt = new Date().toISOString();
  data[token].leadId = leadId;
  await writeAll(data);
  return true;
}

module.exports = { createSession, getSession, markConsumed };
