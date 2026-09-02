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

// ---- 4b. Sign-off falls back field by field --------------------------
{
  const src = readFileSync(path.join(ROOT, "server/lib/letter-pdf.js"), "utf8");
  ok(
    "signer name and title fall back independently",
    /const name = signer\.name \|\| SIGNER\.name/.test(src) &&
    /const title = signer\.title === undefined \? SIGNER\.title : signer\.title/.test(src)
  );
  ok(
    "the canonical business name carries no Inc.",
    !/Land Services,? Inc/i.test(src) && src.includes('title: "PJL Land Services"')
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
  // Still the FLOW-22 invariant "the invoice always wins" — only the
  // spelling of the filename changed. DOC-01 routed every customer-facing
  // document through the shared naming convention, so the first
  // attachment is now named by invoiceAttachmentName() rather than by a
  // bare id. What is asserted is unchanged: the invoice PDF is the first
  // entry in the array, ahead of the letter and the report.
  ok(
    "the invoice PDF is always the first attachment",
    /attachments: \[\s*\{\s*filename: invoiceAttachmentName\(invoice\)/.test(src)
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

// ---- 7. The send path cannot silently drop a letter -----------------
// A ticked-but-unsaved "Attach to this invoice" box sent the invoice with
// no letter and said nothing. Three guards now stand between that and a
// customer; all three are pinned here.
{
  const src = readFileSync(path.join(ROOT, "server/invoice.js"), "utf8");
  ok(
    "the attach switch saves itself on change",
    /el\.enabled\.addEventListener\("change"[\s\S]{0,120}saveLetter\("toggle"\)/.test(src)
  );
  ok(
    "a failed toggle save reverts the switch to what the record says",
    /el\.enabled\.checked = Boolean\(currentInvoice && currentInvoice\.letter && currentInvoice\.letter\.enabled\)/.test(src)
  );
  ok(
    "send is blocked while the letter has unsaved changes",
    /const dirty = editorBody !== String\(savedLetter\.body/.test(src) &&
    /if \(dirty\) \{[\s\S]{0,400}return;/.test(src)
  );
  ok(
    "the send confirmation states whether a letter is attached",
    /willAttachLetter[\s\S]{0,300}No accompanying letter will be attached/.test(src)
  );
  ok(
    "what shipped is reported from the server's answer, not the editor",
    /data\.letterAttached \? " Letter attached\."/.test(src)
  );
  ok(
    "the button and the switch share one save path",
    /async function saveLetter\(reason\)/.test(src) &&
    /el\.save\.addEventListener\("click", function \(\) \{ saveLetter\("button"\); \}\)/.test(src)
  );
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  FAIL " + f);
  process.exit(1);
}
