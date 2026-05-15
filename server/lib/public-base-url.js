// Resolves the public-facing base URL for outbound notification links —
// the "Open in CRM" button in lead-intake SMS/email, the portal magic
// links in customer emails, the invoice "View and pay" CTA, etc.
//
// Resolution order:
//   1. process.env.PUBLIC_BASE_URL — authoritative. If set to any
//      non-empty trimmed string, it wins (trailing slash stripped).
//   2. Otherwise, in non-production (NODE_ENV !== "production"), fall
//      back to http://127.0.0.1:<PORT> so local dev links open the
//      running server. PORT mirrors server.js's bind default (4173).
//   3. Otherwise fall back to the hardcoded canonical domain
//      https://pjllandservices.com. Never fall back to req.headers.host
//      — on Render that's the *.onrender.com subdomain and would land
//      customers and admin alike on the wrong host.
//
// Used by notify-sms.js, notify-email.js, and notify-customer.js so
// every outbound notification URL resolves identically regardless of
// which HTTP route happened to trigger the send.

function resolvePublicBaseUrl() {
  const envValue = String(process.env.PUBLIC_BASE_URL || "").trim();
  if (envValue) return envValue.replace(/\/+$/, "");
  if (process.env.NODE_ENV !== "production") {
    const port = Number(process.env.PORT || 4173);
    return `http://127.0.0.1:${port}`;
  }
  return "https://pjllandservices.com";
}

module.exports = { resolvePublicBaseUrl };
