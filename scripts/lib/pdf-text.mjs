// scripts/lib/pdf-text.mjs
//
// Read what a PDFKit document SAYS, for tests: its text (including text
// drawn in an embedded subset font, which is stored as glyph ids and is
// invisible to a plain search) and its clickable links.
//
// The invoice's status stamp ("DRAFT", "SENT", "PAID") is drawn in Barlow
// Condensed, an embedded subset: the content stream holds <0012 0007 …>,
// not "DRAFT". scripts/test-prepared-for-address.mjs's reader only decodes
// the standard fonts, so a test built on it would pass whatever the stamp
// said. This one maps each embedded font's glyph ids back to text through
// its ToUnicode CMap.
//
// Small and specific to what PDFKit writes (FlateDecode streams, one
// object per line, `/Fn size Tf` then `[…] TJ`). Not a general PDF parser.
//
//   const { text, links } = readPdf(buffer);
//   text   — every run of text, one per line, in drawing order
//   links  — [{ uri, rect: [x1, y1, x2, y2] }] for each /URI link annotation

import zlib from "node:zlib";

function objects(s) {
  const out = new Map();
  for (const m of s.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) out.set(Number(m[1]), m[2]);
  return out;
}

function streamOf(buf, s, body) {
  const at = body.indexOf("stream");
  if (at < 0) return null;
  const start = s.indexOf(body) + at + 6;
  let b = start;
  if (s[b] === "\r") b++;
  if (s[b] === "\n") b++;
  const e = s.indexOf("endstream", b);
  const raw = buf.subarray(b, e);
  try { return zlib.inflateSync(raw).toString("latin1"); } catch { return raw.toString("latin1"); }
}

// ToUnicode CMap → Map(glyphId → string)
function parseCmap(t) {
  const map = new Map();
  const hex = (h) => String.fromCodePoint(...(h.match(/.{1,4}/g) || []).map((x) => parseInt(x, 16)));
  for (const block of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(m[1], 16), hex(m[2]));
  }
  for (const block of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (m[3].startsWith("[")) {
        const dst = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => hex(x[1]));
        for (let g = lo; g <= hi; g++) map.set(g, dst[g - lo] ?? "");
      } else {
        const base = parseInt(m[3].slice(1, -1), 16);
        for (let g = lo; g <= hi; g++) map.set(g, String.fromCodePoint(base + g - lo));
      }
    }
  }
  return map;
}

export function readPdf(buf) {
  const s = buf.toString("latin1");
  const objs = objects(s);
  const ref = (body, key) => { const m = new RegExp(`/${key}\\s+(\\d+) 0 R`).exec(body || ""); return m ? Number(m[1]) : null; };

  // Font object number → glyph map (embedded fonts) or null (standard fonts).
  const fontMap = new Map();
  for (const [n, body] of objs) {
    if (!/\/Type\s*\/Font/.test(body)) continue;
    const tu = ref(body, "ToUnicode");
    fontMap.set(n, tu != null ? parseCmap(streamOf(buf, s, objs.get(tu)) || "") : null);
  }

  let text = "";
  const links = [];
  for (const [, body] of objs) {
    if (!/\/Type\s*\/Page\b/.test(body)) continue;
    // The page's font resources: /F1 5 0 R …
    const resN = ref(body, "Resources");
    const res = resN != null ? objs.get(resN) : body;
    const fontsN = ref(res, "Font");
    const fontsDict = fontsN != null ? objs.get(fontsN) : (/\/Font\s*<<([\s\S]*?)>>/.exec(res || "") || [])[1] || "";
    const names = new Map([...fontsDict.matchAll(/\/(\w+)\s+(\d+) 0 R/g)].map((m) => [m[1], Number(m[2])]));

    for (const cN of [...(/\/Contents\s+(?:\[([^\]]*)\]|(\d+) 0 R)/.exec(body) || [])].slice(1).filter(Boolean).join(" ").match(/\d+(?= 0 R)|^\d+$/g) || []) {
      const content = streamOf(buf, s, objs.get(Number(cN)) || "") || "";
      let glyphs = null;
      for (const op of content.matchAll(/\/(\w+)\s+[\d.]+\s+Tf|\[((?:[^\]\\]|\\.)*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
        if (op[1]) { glyphs = fontMap.get(names.get(op[1])) || null; continue; }
        const parts = op[2] != null ? [...op[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((m) => m[1]) : [op[3]];
        for (const h of parts) {
          if (glyphs) text += (h.match(/.{4}/g) || []).map((g) => glyphs.get(parseInt(g, 16)) ?? "").join("");
          else text += Buffer.from(h, "hex").toString("latin1");
        }
        text += "\n";
      }
    }

    // Link annotations.
    const annots = /\/Annots\s*\[([^\]]*)\]/.exec(body);
    for (const a of (annots ? annots[1].match(/\d+(?= 0 R)/g) : []) || []) {
      const ab = objs.get(Number(a)) || "";
      const uri = /\/URI\s*\(((?:[^)\\]|\\.)*)\)/.exec(ab);
      const rect = /\/Rect\s*\[([^\]]*)\]/.exec(ab);
      if (uri) links.push({ uri: uri[1].replace(/\\(.)/g, "$1"), rect: rect ? rect[1].trim().split(/\s+/).map(Number) : null });
    }
  }
  return { text, links };
}
