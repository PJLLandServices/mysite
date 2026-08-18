// Unit tests for the "Prepared for" address on proposals (2026-08).
//
// Regression under test: the PREPARED FOR block resolved its address from the
// SERVICE-address chain (property -> lead -> most recent lead/work order by
// email), so on a customer with several concurrent sites the proposal was
// addressed to whichever OTHER site had been adopted or worked most recently.
// Observed on Q-2026-0067: a Norwood SITE address printed on a Dundalk
// proposal for GreenTree Construction Inc.
//
// Covers the pure resolver (billing-parties.js), the draft-only lock
// (quotes.js), and the two PDF cover blocks that print it (quote-pdf.js).
// No server, no disk writes. Run: node scripts/test-prepared-for-address.mjs

import { createRequire } from "node:module";
import zlib from "node:zlib";
const require = createRequire(import.meta.url);
const { resolvePreparedForAddress } = require("../server/lib/billing-parties.js");
const { SCOPE_PROTECTED_FIELDS, findProtectedFieldTouched } = require("../server/lib/quotes.js");
const { renderProjectProposalPdf, renderSmartControllerPdf } = require("../server/lib/quote-pdf.js");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", label); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// The two addresses from the real defect.
const SITE = "4293 ON-7, Norwood, ON K0L 2V0";          // a DIFFERENT project's site
const OWN  = "18 Vipond Rd, Dundalk, ON N0C 1B0";       // GreenTree's own address
const OVERRIDE = "77 Head Office Rd, Suite 200, Barrie, ON L4N 0A1";

// ---- resolver precedence ---------------------------------------------
eq(resolvePreparedForAddress({ preparedForAddress: OVERRIDE }, { billingAddress: OWN }, { serviceAddress: SITE }),
   OVERRIDE, "explicit per-proposal override wins over everything");
eq(resolvePreparedForAddress({}, { billingAddress: OWN }, { serviceAddress: SITE }),
   OWN, "no override -> the customer's OWN address, never the site address");
eq(resolvePreparedForAddress({}, {}, { serviceAddress: SITE }),
   SITE, "nothing on file -> service address as last resort (legacy behaviour)");
eq(resolvePreparedForAddress({}, {}, {}), "", "nothing at all -> empty string");

// The core regression, stated directly.
ok(resolvePreparedForAddress({}, { billingAddress: OWN }, { serviceAddress: SITE }) !== SITE,
   "a site address never wins while the customer has an address on file");

// Tolerance + hygiene.
eq(resolvePreparedForAddress(null, null, undefined), "", "null args tolerated");
eq(resolvePreparedForAddress({ preparedForAddress: "   " }, { billingAddress: OWN }, {}),
   OWN, "whitespace-only override is not an override");
eq(resolvePreparedForAddress({ preparedForAddress: `  ${OVERRIDE}  ` }, {}, {}),
   OVERRIDE, "override is trimmed");
eq(resolvePreparedForAddress({ preparedForAddress: "x".repeat(500) }, {}, {}).length,
   200, "override capped at 200 chars");
eq(resolvePreparedForAddress({ preparedForAddress: 12345 }, {}, {}), "12345", "non-string override coerced");

// billingAddress is a string in the schema, but migrated/hand-edited records
// have carried an object — it must never print as "[object Object]".
eq(resolvePreparedForAddress({}, { billingAddress: { formatted: OWN } }, { serviceAddress: SITE }),
   OWN, "object-shaped billingAddress: .formatted read");
eq(resolvePreparedForAddress({}, { billingAddress: { address: OWN } }, { serviceAddress: SITE }),
   OWN, "object-shaped billingAddress: .address read");
eq(resolvePreparedForAddress({}, { billingAddress: {} }, { serviceAddress: SITE }),
   SITE, "empty object billingAddress falls through, not stringified");

// ---- draft-only lock --------------------------------------------------
ok(SCOPE_PROTECTED_FIELDS.includes("preparedForAddress"),
   "preparedForAddress is scope-protected (draft-only, like quoteNumberDisplay)");
eq(findProtectedFieldTouched({ preparedForAddress: OWN }), "preparedForAddress",
   "patching it on a sent proposal is refused");
eq(findProtectedFieldTouched({ scheduledServiceDate: "2026-09-01" }), null,
   "unrelated post-send fields still patch freely");

// ---- PDF cover blocks -------------------------------------------------
function renderToBuffer(render, quote, opts) {
  return new Promise((resolve, reject) => {
    const doc = render(quote, opts);
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

// Pull the visible text out of a pdfkit document. Content streams are Flate;
// the standard (non-subset) fonts write plain-ASCII hex inside TJ arrays, and
// the PREPARED FOR block uses Helvetica, so it round-trips readably.
function pdfText(buf) {
  const s = buf.toString("latin1");
  let i = 0, out = "";
  for (;;) {
    const a = s.indexOf("stream", i);
    if (a < 0) break;
    let b = a + "stream".length;
    if (s[b] === "\r") b++;
    if (s[b] === "\n") b++;
    const e = s.indexOf("endstream", b);
    if (e < 0) break;
    let raw = buf.subarray(b, e);
    try { raw = zlib.inflateSync(raw); } catch { i = e + 9; continue; }
    for (const m of raw.toString("latin1").matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      for (const h of m[1].matchAll(/<([0-9a-fA-F]+)>/g)) out += Buffer.from(h[1], "hex").toString("latin1");
      out += "\n";
    }
    i = e + 9;
  }
  return out;
}

const proposal = {
  id: "Q-2026-0067", version: 1, type: "project_proposal", branch: "gc_subcontract",
  status: "draft", createdAt: "2026-08-10T14:00:00.000Z", validUntil: "2026-11-08",
  scope: "Dundalk McDonald's — irrigation", customerEmail: "ap@greentree.example",
  subtotal: 10000, hst: 1300, total: 11300,
  lineItems: [{ label: "Zone 1", description: "Turf rotors", qty: 1, unitPrice: 10000, lineTotal: 10000 }],
  proposalSections: [], attachments: [], deposit: { enabled: false },
  pdfOptions: { lineItems: "itemized", showAttachments: true, showProjectMap: true }
};
const NAME = "GreenTree Construction Inc.";

// The reported defect, end to end.
const fixed = pdfText(await renderToBuffer(renderProjectProposalPdf, proposal, {
  customer: { name: NAME, preparedForAddress: OWN, address: SITE },
  property: { address: SITE }
}));
ok(fixed.includes("PREPARED FOR"), "proposal PDF still renders the PREPARED FOR block");
ok(fixed.includes(NAME), "customer name unchanged");
ok(fixed.includes(OWN), "PREPARED FOR shows the customer's own address");
ok(!fixed.includes("Norwood"), "the other project's SITE address is gone from the PDF");

// Totals and the rest of the document are untouched by this change.
ok(fixed.includes("Q-2026-0067"), "quote number unchanged");
// The money figures themselves are drawn in a subset font (glyph ids, not
// ASCII), so assert on the labels of the totals block instead.
ok(fixed.includes("Subtotal") && fixed.includes("Total CAD"), "totals block still renders");
ok(fixed.includes("GC SUBCONTRACT"), "branch tag unchanged");

// A caller that hands in bare {customer, property} — no resolver in front of
// it — must render exactly as it always did, or legacy call sites regress.
const legacy = pdfText(await renderToBuffer(renderProjectProposalPdf, proposal, {
  customer: { name: NAME }, property: { address: SITE }
}));
ok(legacy.includes(SITE), "direct callers with no preparedForAddress fall back to the old behaviour");

// Same block on the smart-controller document.
const smart = pdfText(await renderToBuffer(renderSmartControllerPdf, {
  ...proposal, type: "ai_repair_quote", narrativeKey: "smart-controller", branch: null
}, {
  customer: { name: NAME, preparedForAddress: OWN, address: SITE },
  property: { address: SITE }
}));
ok(smart.includes(OWN), "smart-controller PDF shows the prepared-for address");
ok(!smart.includes("Norwood"), "smart-controller PDF drops the site address too");

// ---- summary ----------------------------------------------------------
console.log(`\nprepared-for address: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
