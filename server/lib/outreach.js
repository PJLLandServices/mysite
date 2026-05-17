// Seasonal outreach — bulk booking-nudge engine
// (feature-seasonal-outreach-brief.md).
//
// Patrick visits /admin/outreach a few weeks before each season,
// picks Spring or Fall + year, sees every property where
// seasonalEligibility[season] is true, filters to "Not booked",
// composes one message, and sends to all unbooked properties at
// once. A week later he reopens the page; the customers who
// booked are filtered out automatically, and he re-sends to the
// remaining stragglers.
//
// This module is the orchestrator. The storage lives on the
// property record (server/lib/properties.js seasonalEligibility +
// seasonalOutreach + commPrefs); the per-recipient send lives on
// notify-customer.js (sendOutreachEmail + sendOutreachSms). The
// SAVED message templates live on settings.outreachTemplates.
// This module wires them together and adds the per-season-window
// booking detection, the eligibility / comm-prefs pre-flight
// checks, the rate-limited dispatch loop, and the unsubscribe
// resolution.
//
// What it deliberately does NOT do (out of scope per brief §6):
//   - Scheduled / cron-driven sends
//   - Campaign analytics (open rates, click-through)
//   - Multi-customer / household consolidation
//   - Inbound STOP webhook (Twilio handles STOP at the carrier
//     level for v1)

const crypto = require("node:crypto");

const properties = require("./properties");
const bookings = require("./bookings");
const settings = require("./settings");
const notify = require("./notify-customer");
const { resolvePublicBaseUrl } = require("./public-base-url");

// ---- Constants (brief §3.6 + §3.7) ---------------------------------

// Hardcoded season windows. Move to settings.json if Patrick ever
// wants to tweak (e.g. opening spring early in a mild year); for
// now the constants are simpler than a configurable that nobody
// edits. Inclusive on both ends. End dates are conservative:
//   - Spring closes June 30 — captures late openings without
//     spilling into summer service-call territory.
//   - Fall closes Dec 15 — captures any late closings without
//     spilling into the new year's data (Patrick wants 2026:fall
//     touches to feel like 2026 work).
const SEASON_WINDOWS = {
  spring: { startMonth: 3, startDay: 1, endMonth: 6, endDay: 30 },
  fall:   { startMonth: 9, startDay: 1, endMonth: 12, endDay: 15 }
};

// Service-key prefix matching for booking detection. A property
// counts as "booked for the season" when at least one of its
// bookings carries a serviceKey starting with the right prefix
// AND scheduledFor falls inside the season window. Cancelled /
// no-show bookings DO NOT count (brief §3.7).
const SEASONAL_SERVICE_PREFIXES = {
  spring: "spring_open_",
  fall:   "fall_close_"
};

const SEASON_LABEL = {
  spring: "Spring Opening",
  fall:   "Fall Closing"
};

// Per-recipient pacing (brief §4 "Rate limiting"). Twilio
// tolerates faster but stays courteous; Gmail tolerates much
// faster but a slow drip avoids appearing on a spam heuristic
// for a sudden burst from a residential domain.
const TWILIO_PACING_MS = 300;
const GMAIL_PACING_MS = 100;

// Single-batch-at-a-time guard (brief §4 "Concurrent send
// protection"). Module-level so the same process handles all
// requests; the lock survives across requests for the lifetime
// of the Node process. Render's single-instance runtime makes
// this safe; a multi-instance future would need a shared lock.
let sendInProgress = false;

// ---- Helpers ---------------------------------------------------------

function nowIso() { return new Date().toISOString(); }

// 8-char alphanumeric batch id. Matches the WO-random-id shape
// brief §3.2 calls out. Two batches at the same second are
// distinguishable by their random suffix.
function newBatchId() {
  return "out_" + crypto.randomBytes(4).toString("hex");
}

// Best-effort first-name extraction. Same heuristic the existing
// notify-customer.js uses on lead.contact.name — pick the first
// whitespace-separated token, fall back to "there" if blank.
// "Mary Anne Smith" → "Mary". The OG card reads cleanly with
// either "Mary" or "Mary Anne" so this trade is fine.
function firstNameOf(customerName) {
  const trimmed = String(customerName || "").trim();
  if (!trimmed) return "there";
  return trimmed.split(/\s+/)[0];
}

// "123 Main St" — used by the OG card and the {{propertyAddress}}
// merge tag. The Property.address field already stores just the
// street portion in most records; for legacy records that include
// city/postal, take everything before the first comma.
function streetAddressOf(address) {
  const trimmed = String(address || "").trim();
  if (!trimmed) return "";
  const commaIdx = trimmed.indexOf(",");
  return commaIdx === -1 ? trimmed : trimmed.slice(0, commaIdx).trim();
}

// Is the given ISO timestamp inside the [startMonth/startDay,
// endMonth/endDay] window for the given year? Uses local-month
// math because seasons are calendar concepts, not UTC ones.
// Defensive against legacy bookings whose scheduledFor is null.
function isInSeasonWindow(iso, season, year) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const win = SEASON_WINDOWS[season];
  if (!win) return false;
  const targetYear = Number(year);
  if (d.getFullYear() !== targetYear) return false;
  const month = d.getMonth() + 1;  // 1-indexed for window comparison
  const day = d.getDate();
  if (month < win.startMonth) return false;
  if (month > win.endMonth) return false;
  if (month === win.startMonth && day < win.startDay) return false;
  if (month === win.endMonth && day > win.endDay) return false;
  return true;
}

// Resolve the portal token for a property. Returns a deterministic
// per-property token derived from the property id — same SHA-256
// "pjl-portal:<id>" → base64url[0..24] scheme the lead system uses
// (server.js portalTokenForId). Every property has a usable token
// the moment it exists, regardless of whether a lead has been
// attached or whether that lead has a `portal.token` field.
//
// Round 1 walked property.leadIds[] looking for a tokened lead;
// that left every xlsx-imported / legacy-pre-lead-intake property
// unsendable. Patrick's intent (brief + clarification): every
// property is eligible by default, the operator deselects.
//
// `leadsCache` arg kept for back-compat with callers; ignored.
function resolvePortalToken(property, _leadsCache = null) {
  if (!property || !property.id) return null;
  return crypto
    .createHash("sha256")
    .update(`pjl-portal:${property.id}`)
    .digest("base64url")
    .slice(0, 24);
}

// Build the customer-facing portal URL with the season hint that
// the /portal/<token> OG-substitution handler reads. Brief §3.8.
// Always production-domain (resolvePublicBaseUrl honours
// PUBLIC_BASE_URL; the startup guard in server.js ensures it's
// set in production).
function buildPortalLink(token, season) {
  const base = resolvePublicBaseUrl();
  return `${base}/portal/${token}?season=${season}`;
}

// Construct the per-recipient unsubscribe URLs (one for email-
// only, one for the "stop everything" path). Tokens are minted
// in resolveRecipient() so by the time we build URLs they exist.
function buildUnsubscribeUrls(property) {
  const base = resolvePublicBaseUrl();
  const tokens = property.commPrefs?.optOutTokens || {};
  return {
    email: tokens.seasonalEmail ? `${base}/unsubscribe/${tokens.seasonalEmail}?type=email` : null,
    sms:   tokens.seasonalSMS   ? `${base}/unsubscribe/${tokens.seasonalSMS}?type=sms`     : null,
    all:   tokens.seasonalAll   ? `${base}/unsubscribe/${tokens.seasonalAll}?type=all`     : null
  };
}

// Sleep — for the per-recipient pacing loop. Wrapped here so the
// orchestrator reads cleanly.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Public: booking detection -----------------------------------

// Query bookings.json for any booking on this property whose
// serviceKey signals the right season and whose scheduledFor
// lands in-window for the given year. Status filtering excludes
// cancelled / no_show — the customer is still effectively
// unbooked in either case.
async function deriveBookingState(propertyId, season, year) {
  if (!propertyId) return null;
  const prefix = SEASONAL_SERVICE_PREFIXES[season];
  if (!prefix) return null;
  const matches = await bookings.listByProperty(propertyId);
  const candidate = matches.find((b) => {
    if (!b || typeof b.serviceKey !== "string") return false;
    if (!b.serviceKey.startsWith(prefix)) return false;
    if (b.status === "cancelled" || b.status === "no_show") return false;
    return isInSeasonWindow(b.scheduledFor, season, year);
  });
  if (!candidate) return { hasBooking: false, bookingId: null, scheduledDate: null };
  return {
    hasBooking: true,
    bookingId: candidate.id,
    scheduledDate: candidate.scheduledFor
  };
}

// ---- Public: candidate listing -----------------------------------

// Build the property + state list for a given season + year, then
// apply the filter. Totals are computed from the unfiltered set so
// the stats row at the top of /admin/outreach reflects reality
// even when the operator is looking at, say, just "Not booked".
async function listCandidates({ season, year, filter = "all" } = {}) {
  if (season !== "spring" && season !== "fall") {
    throw new Error(`Unknown season: ${season}`);
  }
  if (!Number.isFinite(Number(year))) {
    throw new Error(`Invalid year: ${year}`);
  }
  const eligibilityKey = season === "spring" ? "springOpening" : "fallClosing";
  const seasonKey = properties.seasonKey(year, season);

  const allProperties = await properties.list();  // excludes deleted+archived

  const eligible = allProperties.filter((p) => p.seasonalEligibility?.[eligibilityKey] !== false);

  // Per-property state, then filter at the end.
  const decorated = await Promise.all(eligible.map(async (p) => {
    const bookingState = await deriveBookingState(p.id, season, year);
    const seasonState = p.seasonalOutreach?.[seasonKey] || { touches: [], optOutThisSeason: false };
    const touches = Array.isArray(seasonState.touches) ? seasonState.touches : [];
    const lastTouch = touches.length
      ? touches.reduce((max, t) => (t.ts > max ? t.ts : max), "")
      : null;
    const smsOn = p.commPrefs?.seasonalRemindersSMS !== false;
    const emailOn = p.commPrefs?.seasonalRemindersEmail !== false;
    const optedOutSeason = seasonState.optOutThisSeason === true;
    const optedOutAll = !smsOn && !emailOn;
    const portalToken = resolvePortalToken(p);
    return {
      propertyId: p.id,
      code: p.code || "",
      customerId: p.customerId || null,
      customerName: p.customerName || "",
      firstName: firstNameOf(p.customerName),
      email: p.customerEmail || "",
      phone: p.customerPhone || "",
      address: p.address || "",
      streetAddress: streetAddressOf(p.address),
      lastTouchTs: lastTouch,
      touchCount: touches.length,
      bookingState: bookingState || { hasBooking: false, bookingId: null, scheduledDate: null },
      optedOutSeason,
      optedOutAll,
      commPrefs: {
        seasonalRemindersSMS: smsOn,
        seasonalRemindersEmail: emailOn
      },
      missingName: !String(p.customerName || "").trim(),
      portalToken
    };
  }));

  // Totals — over the eligible set, NOT the filtered subset.
  // "Awaiting" = contacted but not yet booked.
  const totals = {
    eligible: decorated.length,
    contacted: 0,
    booked: 0,
    awaiting: 0,
    optedOut: 0,
    missingName: 0
  };
  for (const row of decorated) {
    const hasBooking = row.bookingState.hasBooking;
    const contacted = Boolean(row.lastTouchTs);
    const opted = row.optedOutSeason || row.optedOutAll;
    if (hasBooking) totals.booked += 1;
    if (contacted) totals.contacted += 1;
    if (contacted && !hasBooking) totals.awaiting += 1;
    if (opted) totals.optedOut += 1;
    if (row.missingName) totals.missingName += 1;
  }

  // Filter.
  let candidates = decorated;
  switch (filter) {
    case "all":
      break;
    case "not_booked":
      candidates = decorated.filter((r) => !r.bookingState.hasBooking);
      break;
    case "not_contacted":
      candidates = decorated.filter((r) => !r.lastTouchTs && !r.bookingState.hasBooking);
      break;
    case "contacted_no_booking":
      candidates = decorated.filter((r) => r.lastTouchTs && !r.bookingState.hasBooking);
      break;
    case "booked":
      candidates = decorated.filter((r) => r.bookingState.hasBooking);
      break;
    case "opted_out":
      candidates = decorated.filter((r) => r.optedOutSeason || r.optedOutAll);
      break;
    default:
      throw new Error(`Unknown filter: ${filter}`);
  }

  // Stable sort — alpha by customerName, then by code. Makes the
  // list predictable across reloads (the page polls after each
  // send batch and the operator expects rows to stay put).
  candidates.sort((a, b) => {
    const byName = String(a.customerName || "").localeCompare(String(b.customerName || ""));
    if (byName !== 0) return byName;
    return String(a.code || "").localeCompare(String(b.code || ""));
  });

  return { candidates, totals };
}

// ---- Public: per-season opt-out toggle ----------------------------

async function setOptOutForSeason(propertyId, season, year, value) {
  if (season !== "spring" && season !== "fall") {
    throw new Error(`Unknown season: ${season}`);
  }
  return properties.setSeasonalOptOut(propertyId, { season, year, value });
}

// ---- Public: unsubscribe ------------------------------------------

// Validate the token (linear scan via properties.findByOptOutToken),
// flip the corresponding commPref off, return whatever the client
// needs to render the confirmation page. Returns null for an
// unknown token so the public route can render a generic "link
// invalid" page without leaking which slot the token belonged to.
async function honorUnsubscribe(token, type) {
  if (!token) return null;
  if (type !== "sms" && type !== "email" && type !== "all") return null;
  const property = await properties.findByOptOutToken(token, type);
  if (!property) return null;
  const updated = await properties.setSeasonalCommPref(property.id, type, false);
  return {
    propertyId: property.id,
    type,
    customerName: property.customerName || "",
    address: property.address || ""
  };
}

// ---- Public: templates --------------------------------------------

async function getTemplates() {
  const s = await settings.get();
  return s.outreachTemplates || { spring: { subject: "", smsBody: "", emailBody: "" }, fall: { subject: "", smsBody: "", emailBody: "" } };
}

async function saveTemplate(season, patch, opts) {
  const result = await settings.saveOutreachTemplate(season, patch, opts);
  return result.outreachTemplates;
}

// ---- Public: bulk send --------------------------------------------
//
// Orchestrates per-recipient send. For each property in the
// selection:
//   1. Resolve the recipient (eligibility, comm prefs,
//      per-season opt-out, contact info, portal token). Skip
//      with a reason if any pre-flight check fails.
//   2. Mint opt-out tokens if missing (idempotent — first send
//      against a property mints them; subsequent sends reuse).
//   3. Dispatch email (if channel selected + email on file +
//      email pref on), then SMS (same checks). Pace between
//      sends per GMAIL_PACING_MS / TWILIO_PACING_MS.
//   4. On any successful dispatch, append a touch entry to the
//      property's seasonalOutreach[year:season].touches.
//
// Returns { batchId, sent, skipped[], errors[] }. Per-recipient
// errors don't abort the batch — partial-failure reporting lets
// Patrick retry just the failures.
async function sendBulk({
  propertyIds,
  season,
  year,
  channels = ["sms", "email"],
  subject = "",
  smsBody = "",
  emailBody = "",
  by = "patrick"
} = {}) {
  if (season !== "spring" && season !== "fall") {
    throw new Error(`Unknown season: ${season}`);
  }
  if (!Number.isFinite(Number(year))) {
    throw new Error(`Invalid year: ${year}`);
  }
  if (!Array.isArray(propertyIds) || !propertyIds.length) {
    throw new Error("propertyIds must be a non-empty array.");
  }
  const wantsSms = channels.includes("sms");
  const wantsEmail = channels.includes("email");
  if (!wantsSms && !wantsEmail) {
    throw new Error("At least one channel (sms or email) is required.");
  }

  // Concurrent-send guard. The second caller learns we're busy
  // and can retry; we don't queue, on purpose (a queue creates
  // its own consistency questions).
  if (sendInProgress) {
    const err = new Error("Another outreach send is already in progress.");
    err.code = "SEND_LOCKED";
    throw err;
  }
  sendInProgress = true;

  const batchId = newBatchId();
  const seasonName = SEASON_LABEL[season];
  const result = { batchId, sent: 0, skipped: [], errors: [] };

  try {
    for (const propertyId of propertyIds) {
      const property = await properties.get(propertyId);
      if (!property) {
        result.skipped.push({ propertyId, reason: "not_found" });
        continue;
      }
      if (property.deletedAt || property.archivedAt) {
        result.skipped.push({ propertyId, reason: "inactive" });
        continue;
      }

      // Eligibility check — defense in depth. The candidates
      // list already filters but a direct API call could pass
      // an ineligible id.
      const eligibilityKey = season === "spring" ? "springOpening" : "fallClosing";
      if (property.seasonalEligibility?.[eligibilityKey] === false) {
        result.skipped.push({ propertyId, reason: "not_eligible" });
        continue;
      }

      // Name invariant — outreach refuses any property without
      // a name, so the OG card never reads "Hey there,".
      const customerName = String(property.customerName || "").trim();
      if (!customerName) {
        result.skipped.push({ propertyId, reason: "missing_name" });
        continue;
      }

      // Per-season opt-out.
      const seasonKey = properties.seasonKey(year, season);
      if (property.seasonalOutreach?.[seasonKey]?.optOutThisSeason === true) {
        result.skipped.push({ propertyId, reason: "season_opt_out" });
        continue;
      }

      // Already booked → don't pester. The candidates list
      // already excludes by default, but a stale UI could send
      // a request anyway; honour the booking either way.
      const bookingState = await deriveBookingState(property.id, season, year);
      if (bookingState?.hasBooking) {
        result.skipped.push({ propertyId, reason: "already_booked", bookingId: bookingState.bookingId });
        continue;
      }

      // Portal token — deterministic SHA-256 of property.id. Every
      // property has a usable token the moment it's created, so a
      // missing token here would mean a corrupted property record.
      const portalToken = resolvePortalToken(property);
      if (!portalToken) {
        // Defensive — would only fire on a property with no id,
        // which shouldn't be possible through the lib.
        result.skipped.push({ propertyId, reason: "no_property_id" });
        continue;
      }

      // Mint opt-out tokens lazily — first send against this
      // property creates them, subsequent sends reuse.
      const propertyWithTokens = await properties.mintOptOutTokensIfMissing(property.id) || property;
      const unsubscribeUrls = buildUnsubscribeUrls(propertyWithTokens);
      const portalLink = buildPortalLink(portalToken, season);

      // Per-channel pre-flight (existence of contact + pref on).
      // We don't fail-fast on "no channel will deliver" — we
      // dispatch the channels that CAN go through and record the
      // others as skips. That matches the brief's per-channel
      // skip-reason behaviour.
      const phone = String(property.customerPhone || "").trim();
      const email = String(property.customerEmail || "").trim();
      const smsAllowed = wantsSms
        && phone
        && (propertyWithTokens.commPrefs?.seasonalRemindersSMS !== false);
      const emailAllowed = wantsEmail
        && email
        && (propertyWithTokens.commPrefs?.seasonalRemindersEmail !== false);

      // Per-channel record-keeping. If neither channel can fire,
      // we record one composite skip with the most specific
      // reason; if at least one fires, we still note the other
      // channel's skip on the property's per-recipient report
      // (kept inline in result.skipped).
      const channelSkips = [];
      if (wantsSms && !smsAllowed) {
        const why = !phone ? "no_phone"
                    : (propertyWithTokens.commPrefs?.seasonalRemindersSMS === false ? "opted_out_sms" : "sms_unavailable");
        channelSkips.push({ propertyId, channel: "sms", reason: why });
      }
      if (wantsEmail && !emailAllowed) {
        const why = !email ? "no_email"
                    : (propertyWithTokens.commPrefs?.seasonalRemindersEmail === false ? "opted_out_email" : "email_unavailable");
        channelSkips.push({ propertyId, channel: "email", reason: why });
      }
      if (!smsAllowed && !emailAllowed) {
        // No channel will deliver — record one consolidated
        // skip + the per-channel detail. Don't append a touch.
        const reasons = channelSkips.map((s) => s.reason);
        result.skipped.push({
          propertyId,
          reason: reasons.length === 1 ? reasons[0] : "no_contact",
          detail: channelSkips
        });
        continue;
      }

      // Dispatch.
      const channelsActuallySent = [];
      const firstName = firstNameOf(customerName);
      const propertyAddress = streetAddressOf(property.address);

      if (emailAllowed) {
        const emailResult = await notify.sendOutreachEmail({
          to: email,
          firstName,
          propertyAddress,
          seasonName,
          portalLink,
          subject,
          emailBody,
          unsubscribeUrlEmail: unsubscribeUrls.email,
          unsubscribeUrlAll: unsubscribeUrls.all
        });
        if (emailResult.ok) {
          channelsActuallySent.push("email");
        } else if (emailResult.skipped) {
          channelSkips.push({ propertyId, channel: "email", reason: emailResult.reason || "config" });
        } else {
          result.errors.push({ propertyId, channel: "email", error: emailResult.error || "unknown" });
        }
        // Pacing — even when the send was skipped at the
        // module layer (no transporter), the loop pacing
        // doesn't matter so we skip the sleep. Real sends
        // get the courtesy delay.
        if (emailResult.ok) await sleep(GMAIL_PACING_MS);
      }

      if (smsAllowed) {
        const smsResult = await notify.sendOutreachSms({
          to: phone,
          firstName,
          propertyAddress,
          seasonName,
          portalLink,
          smsBody
        });
        if (smsResult.ok) {
          channelsActuallySent.push("sms");
        } else if (smsResult.skipped) {
          channelSkips.push({ propertyId, channel: "sms", reason: smsResult.reason || "config" });
        } else {
          result.errors.push({ propertyId, channel: "sms", error: smsResult.error || "unknown" });
        }
        if (smsResult.ok) await sleep(TWILIO_PACING_MS);
      }

      if (channelsActuallySent.length) {
        // Touch recorded only on success — brief's per-recipient
        // outcome contract.
        await properties.recordOutreachTouch(property.id, {
          season,
          year,
          channels: channelsActuallySent,
          by,
          messageBatchId: batchId
        });
        result.sent += 1;
        if (channelSkips.length) {
          // Partial: some channels delivered, others didn't.
          // Record the skipped-channel reasons so the report
          // shows the recipient's name once, with the per-
          // channel breakdown.
          result.skipped.push({
            propertyId,
            reason: "partial",
            detail: channelSkips
          });
        }
      } else if (channelSkips.length && !result.errors.some((e) => e.propertyId === propertyId)) {
        // Nothing delivered, no hard errors — record a skip
        // with the per-channel reasons.
        result.skipped.push({
          propertyId,
          reason: channelSkips.length === 1 ? channelSkips[0].reason : "no_delivery",
          detail: channelSkips
        });
      }
    }
  } finally {
    sendInProgress = false;
  }

  return result;
}

// ---- Public: test send (pre-flight verification) -----------------
//
// Fires a single message — using the same render path as a real
// sendBulk — to the admin's own NOTIFY_TO_PHONE / NOTIFY_TO_EMAIL
// recipients. Lets Patrick verify exactly what customers will see
// before blasting to 45+ people. Deliberately does NOT:
//   - append a touch entry to any property record (it's a test,
//     not a real send — the audit trail stays clean)
//   - engage the concurrent-send lock (Patrick can hammer this
//     button while iterating on copy without locking himself out)
//   - mint opt-out tokens on the sampled property
//
// `sampleId` (optional) is the property id whose data drives the
// merge tags — typically the first selected row in the operator's
// list. Without it, fallback placeholders are used so the test
// still works even when nothing's selected.
async function sendTest({
  season,
  year,
  channels = ["sms", "email"],
  subject = "",
  smsBody = "",
  emailBody = "",
  sampleId
} = {}) {
  if (season !== "spring" && season !== "fall") {
    throw new Error(`Unknown season: ${season}`);
  }
  const wantsSms = channels.includes("sms");
  const wantsEmail = channels.includes("email");
  if (!wantsSms && !wantsEmail) {
    throw new Error("At least one channel (sms or email) is required.");
  }
  const seasonName = SEASON_LABEL[season];

  // Sample data — first selected recipient if provided, otherwise a
  // placeholder so a "send test" before selecting anyone still goes
  // through with something readable.
  let firstName = "Patrick";
  let propertyAddress = "(sample property)";
  let portalLink = `${resolvePublicBaseUrl()}/portal/sample-token?season=${season}`;
  if (sampleId) {
    const property = await properties.get(sampleId);
    if (property) {
      firstName = firstNameOf(property.customerName);
      propertyAddress = streetAddressOf(property.address) || propertyAddress;
      const token = resolvePortalToken(property);
      if (token) portalLink = buildPortalLink(token, season);
    }
  }

  // Test recipients — reuse the same env vars that drive admin
  // lead-intake notifications. Each channel is skipped if its
  // recipient env var isn't set so a partial config still tests
  // what it can.
  const testEmail = String(process.env.NOTIFY_TO_EMAIL || process.env.GMAIL_USER || "").trim();
  const testPhone = String(process.env.NOTIFY_TO_PHONE || "").trim();

  const result = { sentTo: { email: null, phone: null }, channels: {}, errors: [] };

  if (wantsEmail) {
    if (!testEmail) {
      result.channels.email = { skipped: true, reason: "no_notify_email_env" };
    } else {
      const r = await notify.sendOutreachEmail({
        to: testEmail,
        firstName,
        propertyAddress,
        seasonName,
        portalLink,
        // Brief 2: prepend a clear marker so a test message is
        // unmistakable in the operator's inbox. Doesn't affect the
        // actual outreach send (which uses subject verbatim).
        subject: `[TEST] ${subject || `Time to book your ${seasonName}`}`.slice(0, 250),
        emailBody,
        // Test sends include the unsubscribe footer with placeholder
        // URLs so the layout matches the real customer email, but
        // the links go nowhere — clicking a placeholder won't unsub
        // any real customer.
        unsubscribeUrlEmail: `${resolvePublicBaseUrl()}/unsubscribe/sample-test-token?type=email`,
        unsubscribeUrlAll: `${resolvePublicBaseUrl()}/unsubscribe/sample-test-token?type=all`
      });
      result.channels.email = r;
      if (r.ok) result.sentTo.email = testEmail;
      else if (r.error) result.errors.push({ channel: "email", error: r.error });
    }
  }

  if (wantsSms) {
    if (!testPhone) {
      result.channels.sms = { skipped: true, reason: "no_notify_phone_env" };
    } else {
      const r = await notify.sendOutreachSms({
        to: testPhone,
        firstName,
        propertyAddress,
        seasonName,
        portalLink,
        smsBody: smsBody ? `[TEST] ${smsBody}` : smsBody
      });
      result.channels.sms = r;
      if (r.ok) result.sentTo.phone = testPhone;
      else if (r.error) result.errors.push({ channel: "sms", error: r.error });
    }
  }

  return result;
}

// ---- Module exports -----------------------------------------------

module.exports = {
  SEASON_WINDOWS,
  SEASONAL_SERVICE_PREFIXES,
  SEASON_LABEL,
  listCandidates,
  sendBulk,
  sendTest,
  setOptOutForSeason,
  honorUnsubscribe,
  deriveBookingState,
  getTemplates,
  saveTemplate,
  // Exposed for the /portal/<token> OG-substitution handler in
  // server.js — turns season strings into the rendered label.
  seasonLabel: (season) => SEASON_LABEL[season] || "appointment",
  // Test/diagnostic surface.
  isInSeasonWindow,
  firstNameOf,
  streetAddressOf,
  buildPortalLink,
  buildUnsubscribeUrls,
  resolvePortalToken
};
