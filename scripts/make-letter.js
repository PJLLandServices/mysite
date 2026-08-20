#!/usr/bin/env node
// Turn a plain text file into a PJL letterhead PDF.
//
//   node scripts/make-letter.js my-letter.txt
//   node scripts/make-letter.js my-letter.txt -o ~/Desktop/letter.pdf
//
// The input file is headers, then a "---" line, then the letter body:
//
//   To: Jane Smith
//   Company: Maple Ridge Property Management
//   Address: 400 Davis Dr., Suite 210
//   Address: Newmarket, ON  L3Y 2N4
//   Subject: 2026 irrigation service agreement
//   Date: 2026-08-20
//   ---
//   Hi Jane,
//
//   Body text. Blank line starts a new paragraph.
//
//   - A line starting with "- " is a bullet.
//
// Every header is optional. Repeat "Address:" for each address line.
// Omit Date and it uses today. Recognized headers:
//   To, Company, Attn, Address, Email, Phone, Subject, Date, Heading,
//   Label, Reference, Closing, Signer, SignerTitle

const fs = require("node:fs");
const path = require("node:path");
const { generateLetterPdf } = require("../server/lib/letter-pdf");

const HEADER_KEYS = new Set([
  "to", "company", "attn", "address", "email", "subject", "date",
  "reference", "closing", "signer", "signertitle", "heading", "label", "phone"
]);

function parseLetterFile(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  const out = { to: { lines: [] } };

  // Split on the first "---" line. With no separator, treat any leading
  // run of "Key: value" lines as headers and the rest as body — so a
  // file that is nothing but body text still works.
  let headerPart = "";
  let bodyPart = "";
  const sep = text.match(/^---[ \t]*$/m);
  if (sep) {
    headerPart = text.slice(0, sep.index);
    bodyPart = text.slice(sep.index + sep[0].length).replace(/^\n/, "");
  } else {
    const lines = text.split("\n");
    let i = 0;
    while (i < lines.length) {
      const m = lines[i].match(/^([A-Za-z]+):\s?(.*)$/);
      if (!m || !HEADER_KEYS.has(m[1].toLowerCase())) break;
      i++;
    }
    headerPart = lines.slice(0, i).join("\n");
    bodyPart = lines.slice(i).join("\n").replace(/^\n+/, "");
  }

  for (const line of headerPart.split("\n")) {
    const m = line.match(/^([A-Za-z]+):\s?(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (!val) continue;
    switch (key) {
      case "to": out.to.name = val; break;
      case "company": out.to.company = val; break;
      case "attn": out.to.attn = val; break;
      case "email": out.to.email = val; break;
      case "address": out.to.lines.push(val); break;
      case "subject": out.subject = val; break;
      case "date": out.date = val; break;
      case "reference": out.reference = val; break;
      case "heading": out.heading = val; break;
      case "label": out.label = val; break;
      case "phone": out.to.phone = val; break;
      case "closing": out.closing = val; break;
      case "signer": out.signer = { ...(out.signer || {}), name: val }; break;
      case "signertitle": out.signer = { ...(out.signer || {}), title: val }; break;
    }
  }

  out.body = bodyPart.trim();
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const outFlag = args.findIndex((a) => a === "-o" || a === "--out");
  let outPath = null;
  if (outFlag !== -1) {
    outPath = args[outFlag + 1];
    args.splice(outFlag, 2);
  }
  const inPath = args[0];

  if (!inPath) {
    console.error("Usage: node scripts/make-letter.js <letter.txt> [-o out.pdf]");
    process.exit(1);
  }
  if (!fs.existsSync(inPath)) {
    console.error(`No such file: ${inPath}`);
    process.exit(1);
  }

  const opts = parseLetterFile(fs.readFileSync(inPath, "utf8"));
  if (!opts.body) {
    console.error(`${inPath} has no body text (nothing after the "---" line).`);
    process.exit(1);
  }

  const pdf = await generateLetterPdf(opts);
  const dest = outPath || inPath.replace(/\.(txt|md)$/i, "") + ".pdf";
  fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
  fs.writeFileSync(dest, pdf);

  const who = opts.to.name || opts.to.company || "unaddressed";
  console.log(`✓  ${dest}  (${(pdf.length / 1024).toFixed(1)} KB) — to ${who}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
