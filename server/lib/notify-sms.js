// SMS notification on new lead intake — calls Twilio's REST API directly via
// fetch (no SDK dependency).
//
// Reads credentials from environment variables (loaded from .env at server boot):
//   TWILIO_ACCOUNT_SID  — starts with "AC" (Twilio console -> Account info)
//   TWILIO_AUTH_TOKEN   — paired with the SID
//   TWILIO_FROM_NUMBER  — the Twilio phone number you bought, in E.164 format (+15551234567)
//   NOTIFY_TO_PHONE     — your cell phone, also E.164 (+19059600181 for Patrick)
//   PUBLIC_BASE_URL     — used to build the CRM link in the SMS body.
//                         If absent, link is omitted.
//
// If any Twilio var is missing, this module logs a clear message and returns
// { ok: false, skipped: true } — lead intake still succeeds. SMS turns on the
// moment all four vars are populated.

function isConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER &&
    process.env.NOTIFY_TO_PHONE
  );
}

function buildSmsBody(lead, baseUrl) {
  const sourceLabel = lead.sourceLabel || lead.source || "Lead";
  const name = lead.contact?.name || "Unknown";
  // Try to extract a town from the address — splits "123 Main St, Newmarket ON L3Y 1A1"
  // into ["123 Main St", "Newmarket ON L3Y 1A1"] and grabs the second piece.
  const addressParts = String(lead.contact?.address || "").split(",").map((s) => s.trim()).filter(Boolean);
  const town = addressParts[1] ? addressParts[1].replace(/\s+ON\b.*/i, "").trim() : "";
  const link = baseUrl ? `\n${baseUrl}/admin` : "";
  const where = town ? ` in ${town}` : "";
  // Twilio SMS segments are 160 GSM-7 chars or 70 UCS-2 chars. Keep it short to
  // stay in a single segment (avoids surprise per-message charges).
  return `New PJL ${sourceLabel}: ${name}${where} - ${lead.contact?.phone || ""}${link}`.trim();
}

async function sendNewLeadSms(lead, { baseUrl } = {}) {
  if (!isConfigured()) {
    console.warn("[sms] Twilio env vars not set — skipping SMS notification (lead still saved).");
    console.warn("[sms] Lead:", lead.id, "-", lead.sourceLabel || lead.source, "-", lead.contact?.name);
    return { ok: false, skipped: true };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");

  const body = new URLSearchParams({
    To: process.env.NOTIFY_TO_PHONE,
    From: process.env.TWILIO_FROM_NUMBER,
    Body: buildSmsBody(lead, baseUrl || "")
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("[sms] Twilio rejected the message:", response.status, data?.message || data?.code || "(no detail)");
      return { ok: false, error: data?.message || `Twilio HTTP ${response.status}` };
    }
    console.log("[sms] Sent lead notification:", data.sid);
    return { ok: true, sid: data.sid };
  } catch (error) {
    console.error("[sms] Network or runtime error sending SMS:", error.message);
    return { ok: false, error: error.message };
  }
}

module.exports = { sendNewLeadSms };
