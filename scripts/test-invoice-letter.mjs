// Accompanying invoice letter — regression cover.
//
// The letter is prose that rides along with an invoice email as a second
// PDF. It must never touch money. These assertions pin that, plus the
// renderer's markup handling and the guards that keep the invoice itself
// deliverable when a letter goes wrong.
//
//   node scripts/test-invoice-letter.mjs

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const { generateLetterPdf } = require(path.join(ROOT, "server/lib/letter-pdf.js"));
const { parseSectionBody } = require(path.join(ROOT, "server/lib/quote-pdf.js"));

// ---- 1. The renderer produces a real PDF ----------------------------
{
  const pdf = await generateLetterPdf({
    to: { name: "Dmitri Volkov", lines: ["95 Lyndhurst Ave", "Toronto, ON"] },
    subject: "95 Lyndhurst Ave — repair summary",
    body: "Hi Dmitri,\n\nHere is the record.\n\n- Excavated\n- Installed **two heads**\n\nDone.",
    reference: "Invoice I-2026-0060"
  });
  ok("renders a PDF", Buffer.isBuffer(pdf) && pdf.length > 1000);
  ok("has a %PDF header", pdf.subarray(0, 4).toString() === "%PDF");
}

// ---- 2. Degenerate bodies do not throw ------------------------------
for (const [label, body] of [
  ["empty body", ""],
  ["whitespace only", "   \n\n  "],
  ["no trailing newline", "One line"],
  ["windows line endings", "A\r\n\r\nB"],
  ["unmatched marker", "an **unclosed bold"],
  ["only a bullet", "- just one"],
  ["very long word", "x".repeat(500)]
]) {
  let threw = null;
  try { await generateLetterPdf({ to: { name: "T" }, subject: "S", body }); }
  catch (err) { threw = err; }
  ok(`survives ${label}`, threw === null, threw && threw.message);
}

// ---- 3. Markup vocabulary is the quote renderer's, not a second one --
{
  const blocks = parseSectionBody("- a\n1. b\n\n**c**");
  ok("bullet parsed", blocks.some((b) => b.type === "bullet"));
  ok("numbered parsed", blocks.some((b) => b.type === "numbered"));
  ok("bold parsed", JSON.stringify(blocks).includes('"bold":true'));

  const src = readFileSync(path.join(ROOT, "server/lib/letter-pdf.js"), "utf8");
  ok(
    "letter-pdf reuses parseSectionBody rather than carrying its own parser",
    src.includes('require("./quote-pdf")') && src.includes("parseSectionBody")
  );
}

// ---- 4. The letter never carries money ------------------------------
{
  const src = readFileSync(path.join(ROOT, "server/lib/letter-pdf.js"), "utf8");
  for (const forbidden of ["subtotal", "lineItems", "amountDue", "balanceDue", "quickbooks", "taxRate"]) {
    ok(`letter renderer has no ${forbidden}`, !new RegExp(forbidden, "i").test(src));
  }
  // "HST" appears once, in the GST/HST registration line — that is the
  // company's identity, not a tax calculation. Pin the distinction:
  // the renderer must do no currency work of any kind.
  ok("no currency formatter", !/Intl\.NumberFormat|toFixed\(2\)|\$" \+|currency/i.test(src));
  const hstHits = (src.match(/hst/gi) || []).length;
  const gstHstHits = (src.match(/GST\/HST/gi) || []).length;
  ok(
    "every HST mention is the GST/HST registration, never a tax calculation",
    hstHits > 0 && hstHits === gstHstHits,
    `${hstHits} HST vs ${gstHstHits} GST/HST`
  );
}

// ---- 5. Server guards -----------------------------------------------
{
  const src = readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  ok(
    "letter is only attached when enabled AND non-empty",
    /function invoiceHasLetter[\s\S]{0,320}letter\?\.enabled[\s\S]{0,200}trim\(\)\.length > 0/.test(src)
  );
  ok(
    "a failing letter render cannot block the invoice email",
    /catch \(letterErr\)[\s\S]{0,400}letterWarning =/.test(src)
  );
  ok("letter preview route exists", src.includes("letter\\.pdf$") || src.includes("/letter\\.pdf"));
  ok(
    "the letter is dated from the invoice, not from render time",
    /date: inv\?\.sentAt \|\| inv\?\.issuedAt \|\| inv\?\.createdAt/.test(src)
  );
}
{
  const src = readFileSync(path.join(ROOT, "server/lib/notify-customer.js"), "utf8");
  ok(
    "the invoice PDF is always the first attachment",
    /attachments: \[\s*\{\s*filename: `\$\{invoice\.id \|\| "invoice"\}\.pdf`/.test(src)
  );
  ok(
    "malformed extra attachments are dropped, not handed to nodemailer",
    /extraAttachments[\s\S]{0,200}Buffer\.isBuffer\(a\.content\)/.test(src)
  );
}
{
  const src = readFileSync(path.join(ROOT, "server/lib/invoices.js"), "utf8");
  ok("letter is hydrated through a normalizer", /letter: normalizeLetter\(/.test(src));
  ok("a void invoice refuses a letter edit", /Can't edit the letter on a void invoice/.test(src));
  ok(
    "letter is not in the blanket field allowlist (it has its own guarded branch)",
    !/const allowed = \[[^\]]*"letter"/.test(src)
  );
}

// ---- 6. Editor stores plain text, not a rich-text schema ------------
{
  const src = readFileSync(path.join(ROOT, "server/invoice.js"), "utf8");
  ok("editor serializes to markup on save", src.includes("letterHtmlToMarkup"));
  ok("editor rehydrates markup into HTML", src.includes("letterMarkupToHtml"));
  ok(
    "paste is taken as plain text",
    /addEventListener\("paste"[\s\S]{0,300}text\/plain/.test(src)
  );
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  FAIL " + f);
  process.exit(1);
}
