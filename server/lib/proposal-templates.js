// Per-service proposal copy templates (Proposal HTML brief, 2026-07).
//
// A template is an editable JSON file under server/lib/templates/
// (proposal-<key>.json) — git-tracked, so copy edits ship with a normal
// deploy, same contract as quote-narratives.js. It holds ONLY the written
// copy: hero headline, how-it-works cards, section headings/leads, scope
// includes/excludes, fine-print clauses, close copy, and the payment-block
// prose. Every dynamic figure (customer, quote #, dates, line items,
// totals, deposit) is filled by the adapter (proposal-data.js) — the
// template never carries a price or a customer name.
//
// Copy may reference quote-specific values with {{tokens}}; resolveTokens()
// substitutes them from a context object the adapter builds. Unknown tokens
// are left visible (and warned) rather than silently dropped — a stray
// {{token}} in a customer-facing page is a loud, fixable signal.

const fsSync = require("node:fs");
const path = require("node:path");

const TEMPLATES_DIR = path.join(__dirname, "templates");

// Template key → filename. Add new services here (lighting, combined…).
const PROPOSAL_TEMPLATES = {
  irrigation: "proposal-irrigation.json",
  lighting: "proposal-lighting.json",
  combined: "proposal-combined.json",
  "smart-controller": "proposal-smart-controller.json"
};

// Templates NOT offered in a single project-proposal's Generate picker —
// combined merges two quotes, smart-controller is built from its own upgrade
// quote flow. Both remain valid for isKnownTemplate()/loadRaw().
const MULTI_QUOTE_TEMPLATES = new Set(["combined", "smart-controller"]);

function isKnownTemplate(key) {
  return Object.prototype.hasOwnProperty.call(PROPOSAL_TEMPLATES, key);
}

// Load the raw (unresolved) template object. Throws on unknown key or
// unreadable/invalid file — the caller (generate endpoint) surfaces that
// as a 4xx rather than emitting a half-populated page.
function loadRaw(key) {
  const filename = PROPOSAL_TEMPLATES[key];
  if (!filename) throw new Error(`Unknown proposal template: ${key}`);
  const raw = fsSync.readFileSync(path.join(TEMPLATES_DIR, filename), "utf8");
  return JSON.parse(raw);
}

// Replace {{token}} occurrences in a single string from `ctx`. Values are
// substituted verbatim (the adapter pre-formats money/dates); missing keys
// are left in place so they're visible during review.
function resolveTokens(text, ctx) {
  return String(text == null ? "" : text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(ctx, key) && ctx[key] != null) {
      return String(ctx[key]);
    }
    console.warn(`[proposal-templates] unresolved token: {{${key}}}`);
    return match;
  });
}

// Deep-resolve every string in a template value against ctx (recurses
// through objects + arrays; leaves numbers/booleans untouched).
function resolveDeep(value, ctx) {
  if (typeof value === "string") return resolveTokens(value, ctx);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, ctx));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveDeep(v, ctx);
    return out;
  }
  return value;
}

// Load a template and resolve all {{tokens}} against ctx in one call.
function loadResolved(key, ctx = {}) {
  return resolveDeep(loadRaw(key), ctx);
}

// The list the builder's single-quote template picker offers:
// [{ key, label, theme }]. Multi-quote templates (combined) are excluded —
// they're built from the quote list, not a single quote's Generate panel.
function listTemplates() {
  return Object.keys(PROPOSAL_TEMPLATES)
    .filter((key) => !MULTI_QUOTE_TEMPLATES.has(key))
    .map((key) => {
      try {
        const t = loadRaw(key);
        return { key, label: t.label || key, theme: t.theme || "sprinkler" };
      } catch {
        return { key, label: key, theme: "sprinkler" };
      }
    });
}

module.exports = {
  PROPOSAL_TEMPLATES,
  isKnownTemplate,
  loadRaw,
  loadResolved,
  resolveTokens,
  listTemplates
};
