// Quote narrative content blocks (Smart Controller Upgrade brief,
// 2026-06-12). A narrative block is an editable JSON file under
// server/lib/templates/ — git-tracked so copy edits ship with a normal
// deploy (server/data/ is gitignored + lives on Render's disk, so a
// seed there would never reach production).
//
// Hard rule: blocks contain NO literal prices. Dollar figures use
// {{dotted.path}} tokens resolved from pricing.json at render time —
// same pattern as worker/rebuild.mjs — so the canonical number lives in
// exactly one place. The quote's own price line comes from its
// snapshotted lineItems, never from the narrative.
//
// Consumers:
//   - quote-pdf.js renderSmartControllerPdf (rich PDF sections)
//   - GET /api/approve/:id/:token (rich customer e-sign page sections)

const fsSync = require("node:fs");
const path = require("node:path");

const TEMPLATES_DIR = path.join(__dirname, "templates");

// Narrative key → template filename. Add new blocks here.
const BLOCKS = {
  "smart-controller": "smart-controller-quote.json"
};

// pricing.json is loaded once per process — the same deploy-time
// freshness contract as server.js's PRICING global (pricing edits ship
// via git push → Render restart).
const PRICING = (() => {
  try {
    return JSON.parse(fsSync.readFileSync(path.resolve(__dirname, "..", "..", "pricing.json"), "utf8"));
  } catch {
    return {};
  }
})();

function resolveToken(dottedPath) {
  const parts = String(dottedPath || "").trim().split(".");
  let val = PRICING;
  for (const p of parts) {
    if (val && typeof val === "object" && p in val) val = val[p];
    else return null;
  }
  if (typeof val === "number" && Number.isFinite(val)) {
    // Whole dollars render without cents (580 → "580"), cents keep two
    // decimals — mirrors worker/rebuild.mjs formatting.
    const cents = Math.round(val * 100) % 100;
    return cents === 0
      ? val.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
      : val.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  return val == null ? null : String(val);
}

function resolveTokens(text) {
  return String(text || "").replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const v = resolveToken(key);
    if (v == null) {
      // Leave the token visible rather than silently dropping copy — an
      // unresolved token in a rendered PDF is a loud, fixable signal.
      console.warn(`[quote-narratives] unresolved token: ${key.trim()}`);
      return match;
    }
    return v;
  });
}

// Load a narrative block fresh from disk (cheap — small file; a copy
// edit applies on the next render without a restart in local dev).
// Returns null when the key is unknown or the file is unreadable.
function load(key) {
  const filename = BLOCKS[key];
  if (!filename) return null;
  try {
    return JSON.parse(fsSync.readFileSync(path.join(TEMPLATES_DIR, filename), "utf8"));
  } catch (err) {
    console.warn(`[quote-narratives] couldn't load block "${key}":`, err?.message);
    return null;
  }
}

// Resolved, render-ready sections for a narrative key — the shape the
// proposal section renderer + the approve page already consume:
// [{ title, body, order, attachmentIds: [] }]. Empty array when the
// block is missing so callers degrade to the plain one-page layout.
function sectionsFor(key) {
  const block = load(key);
  if (!block || !Array.isArray(block.sections)) return [];
  return block.sections.map((s, idx) => ({
    title: String(s.title || "").slice(0, 200),
    body: resolveTokens(s.body),
    order: idx,
    attachmentIds: []
  }));
}

// Resolved header copy (documentTitle / eyebrow / headline / intro) for
// the PDF cover + approve-page header. Null when the block is missing.
function headerFor(key) {
  const block = load(key);
  if (!block) return null;
  return {
    documentTitle: resolveTokens(block.documentTitle || "Quote"),
    eyebrow: resolveTokens(block.eyebrow || ""),
    headline: resolveTokens(block.headline || ""),
    intro: resolveTokens(block.intro || "")
  };
}

module.exports = { load, sectionsFor, headerFor, resolveTokens, BLOCKS };
