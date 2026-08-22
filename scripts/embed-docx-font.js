#!/usr/bin/env node
// Embed a TrueType font into a .docx so the document carries its own
// typeface.
//
//   node scripts/embed-docx-font.js file.docx "Barlow Condensed" path/to.ttf [--bold]
//
// Word substitutes an unavailable font, and its substitution for an
// unknown condensed sans is often a serif — which is how the PJL
// letterhead came out looking like Times on a machine without Barlow
// Condensed installed. An embedded font travels with the file, so the
// template is correct on any machine it is emailed to.
//
// Word stores embedded fonts obfuscated (.odttf): the first 32 bytes are
// XORed with the 16 bytes of the font key GUID, read as hex pairs from
// the end. Everything else is the ordinary OOXML plumbing — a part, a
// relationship, a content-type default, a fontTable entry, and the
// embedTrueTypeFonts flag in settings.
//
// If any of this is malformed Word ignores the embedded font and falls
// back, rather than refusing the file — so the downside is the fallback
// we already have, not a broken document.

const fs = require("node:fs");
const path = require("node:path");
const JSZip = require(path.join(__dirname, "..", "node_modules", "jszip"));

// Fixed key — a stable GUID keeps rebuilds byte-comparable.
const FONT_KEY = "{B1C2D3E4-5F60-4A7B-8C9D-0E1F2A3B4C5D}";

function obfuscate(fontBuf, guid) {
  const hex = guid.replace(/[{}-]/g, "");
  // 16 key bytes, hex pairs read from the end.
  const key = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    key[i] = parseInt(hex.substr(30 - i * 2, 2), 16);
  }
  const out = Buffer.from(fontBuf);
  for (let i = 0; i < 32 && i < out.length; i++) out[i] ^= key[i % 16];
  return out;
}

(async () => {
  const [docxPath, fontName, ttfPath] = process.argv.slice(2);
  const bold = process.argv.includes("--bold");
  if (!docxPath || !fontName || !ttfPath) {
    console.error('Usage: node scripts/embed-docx-font.js <file.docx> "<Font Name>" <font.ttf> [--bold]');
    process.exit(1);
  }

  const zip = await JSZip.loadAsync(fs.readFileSync(docxPath));
  const obf = obfuscate(fs.readFileSync(ttfPath), FONT_KEY);
  const partName = "fonts/font1.odttf";
  zip.file("word/" + partName, obf);

  // 1. Content type for the .odttf extension.
  let ct = await zip.file("[Content_Types].xml").async("string");
  if (!ct.includes('Extension="odttf"')) {
    ct = ct.replace(
      /<Types([^>]*)>/,
      '<Types$1><Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/>'
    );
    zip.file("[Content_Types].xml", ct);
  }

  // 2. fontTable part + its relationship to the font file.
  const relId = "rIdEmbeddedFont1";
  const NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const NS_R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const slot = bold ? "embedBold" : "embedRegular";
  const fontEntry =
    `<w:font w:name="${fontName}">` +
    `<w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/>` +
    `<w:${slot} r:id="${relId}" w:fontKey="${FONT_KEY}"/>` +
    `</w:font>`;

  // docx-js emits an EMPTY, self-closing <w:fonts .../>. Appending before
  // a closing tag that does not exist silently does nothing — which is
  // how the first attempt produced a font part nothing referenced. Open
  // the element first when it is self-closing.
  const openSelfClosing = (xml, tag) => {
    const selfClosing = new RegExp(`(<${tag}\\b[^>]*?)\\s*/>`);
    if (selfClosing.test(xml)) return xml.replace(selfClosing, `$1></${tag}>`);
    return xml;
  };

  let ft = zip.file("word/fontTable.xml");
  if (ft) {
    let x = await ft.async("string");
    x = openSelfClosing(x, "w:fonts");
    x = x.replace("</w:fonts>", fontEntry + "</w:fonts>");
    zip.file("word/fontTable.xml", x);
  } else {
    zip.file("word/fontTable.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:fonts ${NS_W} ${NS_R}>${fontEntry}</w:fonts>`);
    ct = await zip.file("[Content_Types].xml").async("string");
    if (!ct.includes("fontTable+xml")) {
      ct = ct.replace("</Types>",
        '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/></Types>');
      zip.file("[Content_Types].xml", ct);
    }
    let dr = await zip.file("word/_rels/document.xml.rels").async("string");
    if (!dr.includes("fontTable.xml")) {
      dr = dr.replace("</Relationships>",
        '<Relationship Id="rIdFontTable" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/></Relationships>');
      zip.file("word/_rels/document.xml.rels", dr);
    }
  }

  const ftRelsPath = "word/_rels/fontTable.xml.rels";
  const existing = zip.file(ftRelsPath);
  const rel = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="${partName}"/>`;
  if (existing) {
    let x = await existing.async("string");
    x = openSelfClosing(x, "Relationships");
    zip.file(ftRelsPath, x.replace("</Relationships>", rel + "</Relationships>"));
  } else {
    zip.file(ftRelsPath,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>`);
  }

  // 3. Tell Word the document embeds fonts.
  const setPath = "word/settings.xml";
  const setFile = zip.file(setPath);
  if (setFile) {
    let x = await setFile.async("string");
    if (!x.includes("embedTrueTypeFonts")) {
      x = x.replace(/(<w:settings[^>]*>)/, "$1<w:embedTrueTypeFonts/><w:saveSubsetFonts w:val=\"false\"/>");
      zip.file(setPath, x);
    }
  } else {
    zip.file(setPath,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:settings ${NS_W}><w:embedTrueTypeFonts/><w:saveSubsetFonts w:val="false"/></w:settings>`);
    let ct2 = await zip.file("[Content_Types].xml").async("string");
    if (!ct2.includes("settings+xml")) {
      ct2 = ct2.replace("</Types>",
        '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>');
      zip.file("[Content_Types].xml", ct2);
    }
    let dr2 = await zip.file("word/_rels/document.xml.rels").async("string");
    if (!dr2.includes("settings.xml")) {
      dr2 = dr2.replace("</Relationships>",
        '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>');
      zip.file("word/_rels/document.xml.rels", dr2);
    }
  }

  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(docxPath, out);
  console.log(`✓  embedded "${fontName}" (${bold ? "bold" : "regular"} slot) into ${docxPath}`);
})();
