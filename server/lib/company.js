// PJL Land Services — single source of truth for the company's
// outbound identity (name, address, phone, website, email, brand color).
//
// Where this lives:
//   - All PO/invoice/quote PDFs render sender + footer from this module.
//   - All supplier/customer emails set their "From" line from this module.
//
// Sender email rule (carries the brief from the PO redesign):
//   The address PJL sends from is the Gmail account currently auth'd via
//   GMAIL_USER + GMAIL_APP_PASSWORD on Render. We surface that as
//   `email()` so renderers stay aligned with what's actually used in
//   transit. The fallback is the canonical info@ address — never
//   orders@ (the historical orders@pjllandservices.com address does
//   not exist as a mailbox).
//
// Migration notes (forward-looking):
//   - po-pdf.js + notify-supplier.js are wired through this module.
//   - invoice-pdf.js + quote-pdf.js + notify-customer.js still
//     hardcode the same constants in-place — out of scope for the PO
//     redesign brief, but ready to migrate to this module later. When
//     they do, this becomes the only place to edit company-wide info.

const NAME = "PJL Land Services";
const CITY = "Newmarket, Ontario";
const PHONE = "(905) 960-0181";
const WEBSITE = "pjllandservices.com";
const FALLBACK_EMAIL = "info@pjllandservices.com";

// Brand green. Same hex previously duplicated across all three PDF
// renderers — kept here so a brand-color tweak is a one-line change.
const GREEN_HEX = "#1B4D2E";

// Resolve the live sender email at call time (not at module load) so a
// dev process that loads this module before .env loads still picks up
// the right value. Always returns a non-empty string.
function email() {
  const fromEnv = String(process.env.GMAIL_USER || "").trim();
  return fromEnv || FALLBACK_EMAIL;
}

module.exports = {
  NAME,
  CITY,
  PHONE,
  WEBSITE,
  GREEN_HEX,
  FALLBACK_EMAIL,
  email
};
