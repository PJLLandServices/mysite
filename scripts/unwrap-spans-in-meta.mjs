// One-time cleanup: unwrap <span data-price="...">$XX</span> tags accidentally
// injected INSIDE HTML attribute values (meta content, og:description, etc.)
// during the price-tokenization sweep. Attributes can't contain rendered HTML —
// crawlers see the literal span markup. Restores the bare price.
//
// Uses a character scanner that respects quoted attributes, so it correctly
// handles meta tags whose content attribute contains `>` characters from a
// nested span.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SKIP = new Set(["pricing.html", "diagnose.html"]);

// Find the END index of an HTML tag that starts at index `start` in `html`.
// Respects quoted attribute values so nested `>` characters don't terminate.
function findTagEnd(html, start) {
  let i = start + 1; // past the '<'
  let inQuote = null;
  while (i < html.length) {
    const c = html[i];
    if (inQuote) {
      if (c === inQuote) inQuote = null;
    } else {
      if (c === '"' || c === "'") inQuote = c;
      else if (c === ">") return i + 1;
    }
    i++;
  }
  return html.length;
}

function unwrapSpansInTag(tag) {
  return tag
    .replace(/<span\s+data-price="[^"]*"\s*>([^<]*)<\/span>/gi, "$1")
    .replace(/<span\s+data-pjl-quote-formula="[^"]*"\s*>([^<]*)<\/span>/gi, "$1");
}

function processFile(html) {
  // We need to walk through the HTML and process specific tags (meta, title)
  // and the BODY of <title>...</title> blocks.
  let out = "";
  let i = 0;
  while (i < html.length) {
    // Match <meta ...>
    if (html.substring(i, i + 5).toLowerCase() === "<meta" && /\s|>/.test(html[i + 5] || "")) {
      const end = findTagEnd(html, i);
      out += unwrapSpansInTag(html.substring(i, end));
      i = end;
      continue;
    }
    // Match <link ...>
    if (html.substring(i, i + 5).toLowerCase() === "<link" && /\s|>/.test(html[i + 5] || "")) {
      const end = findTagEnd(html, i);
      out += unwrapSpansInTag(html.substring(i, end));
      i = end;
      continue;
    }
    // Match <title>...</title>
    if (html.substring(i, i + 7).toLowerCase() === "<title>") {
      const closeIdx = html.toLowerCase().indexOf("</title>", i + 7);
      const block = closeIdx === -1 ? html.substring(i) : html.substring(i, closeIdx + 8);
      out += unwrapSpansInTag(block);
      i = closeIdx === -1 ? html.length : closeIdx + 8;
      continue;
    }
    out += html[i];
    i++;
  }
  return out;
}

const files = fs.readdirSync(ROOT).filter(f => f.endsWith(".html") && !SKIP.has(f));
let modified = 0;
for (const file of files) {
  const filepath = path.join(ROOT, file);
  const original = fs.readFileSync(filepath, "utf8");
  const updated = processFile(original);
  if (updated !== original) {
    fs.writeFileSync(filepath, updated);
    modified++;
    console.log(`  ✏ ${file}`);
  }
}
console.log(`\nDone. Cleaned ${modified} files.`);
