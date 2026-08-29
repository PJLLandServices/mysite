#!/usr/bin/env node
// scripts/test-branch-labels.mjs — proposal branch semantics (2026-08-29).
//
// Three things that must not drift:
//
//   1. LABELS. `PROPOSAL_BRANCH_LABELS` in server/lib/quotes.js is canonical.
//      Three browser surfaces carry their own copy because they cannot
//      require() a server module — the quote-folder card, the project page,
//      and the proposal-builder <select>. This pins all three to the
//      canonical map, so adding or rewording a branch fails the build until
//      every surface matches. (Centralizing found real drift already:
//      quote-folder said "Renovation" where everything else said "Renovation
//      Coordination".)
//
//   2. INSTALL vs REPAIR. `isInstallationQuote()` decides whether an accepted
//      quote sends the customer a "we'll be in touch to schedule" email. A
//      wrong answer here either emails repair customers who should get
//      nothing, or leaves an installation customer with silence after they
//      commit to a five-figure job.
//
//   3. THE APPROVE PAGE TITLE. What a texted link previews as. It read
//      "Approve repair quote" for every quote type, including residential
//      installation proposals.
//
// Run: node scripts/test-branch-labels.mjs   (also in `npm run build:check`)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let passed = 0, failed = 0;
const ok = (c, label) => { if (c) passed += 1; else { failed += 1; console.error("  FAIL:", label); } };

const require = createRequire(import.meta.url);
const quotes = require(path.join(ROOT, "server", "lib", "quotes.js"));
const CANON = quotes.PROPOSAL_BRANCH_LABELS;

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// Pull a `BRANCH_LABELS = { key: "value", ... }` literal out of a browser
// file as a plain object. Regex rather than eval — these are data literals,
// and the test must not execute page code.
function extractLabelMap(source, label) {
  const m = source.match(/BRANCH_LABELS\s*=\s*\{([\s\S]*?)\}/);
  if (!m) return null;
  const out = {};
  for (const pair of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"([^"]*)"/g)) {
    out[pair[1]] = pair[2];
  }
  return Object.keys(out).length ? out : null;
}

const sameMap = (a, b) => {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join("|") !== kb.join("|")) return false;
  return ka.every((k) => a[k] === b[k]);
};

// 1 — every branch the system accepts has a label
{
  const branches = quotes.PROPOSAL_BRANCHES || [];
  ok(branches.length > 0, "PROPOSAL_BRANCHES is exported and non-empty");
  for (const b of branches) {
    ok(typeof CANON[b] === "string" && CANON[b].length > 0, `branch "${b}" has a canonical label`);
  }
  const extra = Object.keys(CANON).filter((k) => !branches.includes(k));
  ok(extra.length === 0, `no labels for branches that don't exist (${extra.join(", ") || "none"})`);
}

// 2 — the change Patrick asked for
{
  ok(CANON.direct_residential === "Residential Install",
    'direct_residential reads "Residential Install", not bare "Residential"');
  ok(CANON.residential_repair === "Residential Repair",
    "residential_repair label is untouched (the two must stay distinguishable)");
}

// 3 — browser copies match the canonical map exactly
{
  const folder = extractLabelMap(read("server/quote-folder.js"), "quote-folder");
  ok(folder !== null, "quote-folder.js declares a BRANCH_LABELS map");
  ok(sameMap(folder, CANON), "quote-folder.js labels match the canonical map");

  const project = extractLabelMap(read("server/project.js"), "project");
  ok(project !== null, "project.js declares a BRANCH_LABELS map");
  ok(sameMap(project, CANON), "project.js labels match the canonical map");
}

// 4 — the proposal builder's <select> matches too (value AND visible text)
{
  const html = read("server/quote-proposal-builder.html");
  const sel = html.match(/<select id="pbBranch">([\s\S]*?)<\/select>/);
  ok(!!sel, "proposal builder has a #pbBranch <select>");
  if (sel) {
    const opts = {};
    for (const m of sel[1].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)) {
      if (m[1]) opts[m[1]] = m[2].replace(/&amp;/g, "&").trim();
    }
    ok(sameMap(opts, CANON), "builder <select> options match the canonical map");
    ok(sel[1].includes('value=""'), "builder keeps its (unset) option");
  }
}

// 5 — quote-pdf.js must NOT keep its own copy; it requires the canonical one
{
  const pdf = read("server/lib/quote-pdf.js");
  ok(!/const BRANCH_LABELS\s*=\s*\{/.test(pdf),
    "quote-pdf.js no longer declares its own label copy");
  ok(/PROPOSAL_BRANCH_LABELS/.test(pdf),
    "quote-pdf.js sources labels from lib/quotes.js");
  ok(quotes.branchLabel("direct_residential") === "Residential Install", "branchLabel() resolves");
  ok(quotes.branchLabel("nope") === "nope", "branchLabel() falls back to the raw key");
  ok(quotes.branchLabel("") === "", "branchLabel() tolerates an unset branch");
}

// 6 — install vs repair
{
  const P = (branch) => ({ type: "project_proposal", branch });

  ok(quotes.isInstallationQuote(P("direct_residential")) === true, "residential install → installation");
  ok(quotes.isInstallationQuote(P("gc_subcontract")) === true, "GC subcontract → installation");
  ok(quotes.isInstallationQuote(P("lighting_design")) === true, "lighting design → installation");
  ok(quotes.isInstallationQuote(P("renovation_coordination")) === true, "renovation coordination → installation");
  ok(quotes.isInstallationQuote(P("change_order")) === true, "change order → installation");

  ok(quotes.isInstallationQuote(P("residential_repair")) === false, "residential repair → NOT installation");
  ok(quotes.isInstallationQuote(P("lighting_repair")) === false, "lighting repair → NOT installation");

  // The repair-side quote TYPES never count, whatever else is on them.
  ok(quotes.isInstallationQuote({ type: "on_site_quote" }) === false, "on-site quote → NOT installation");
  ok(quotes.isInstallationQuote({ type: "ai_repair_quote" }) === false, "AI repair quote → NOT installation");
  ok(quotes.isInstallationQuote({ type: "ai_repair_quote", narrativeKey: "smart-controller" }) === false,
    "smart-controller upgrade stays OUT (deliberate — see the note in quotes.js)");
  ok(quotes.isInstallationQuote({ type: "on_site_quote", branch: "direct_residential" }) === false,
    "a branch on a non-proposal type cannot make it an installation");

  // Degenerate inputs must not throw or accidentally qualify.
  ok(quotes.isInstallationQuote(null) === false, "null → false");
  ok(quotes.isInstallationQuote({}) === false, "empty object → false");
  // A proposal with no branch set at all: undefined is not in the repair set,
  // so it takes the installation path — same fail-toward-contact rule as an
  // unrecognized branch, asserted explicitly rather than left to chance.
  ok(quotes.isInstallationQuote({ type: "project_proposal" }) === true,
    "proposal with an unset branch → installation (fails toward contact)");
  ok(quotes.isInstallationQuote({ type: "project_proposal", branch: null }) === true,
    "proposal with a null branch → installation");

  // A proposal on an UNKNOWN branch counts as installation by design — the
  // exception list is the repair branches, so a new branch fails safe toward
  // telling the customer something rather than silence.
  ok(quotes.isInstallationQuote(P("some_future_branch")) === true,
    "an unrecognized branch defaults to installation (fails toward contact, not silence)");

  for (const b of quotes.REPAIR_BRANCHES) {
    ok((quotes.PROPOSAL_BRANCHES || []).includes(b), `repair branch "${b}" is a real branch`);
  }
}

// 7 — the approve page title / link preview
{
  const title = (q) => quotes.approvePageTitle(q);

  ok(title({ type: "project_proposal", branch: "direct_residential" }) === "Approve your installation proposal",
    "residential install previews as an installation proposal");
  ok(title({ type: "project_proposal", branch: "lighting_design" }) === "Approve your installation proposal",
    "lighting design previews as an installation proposal");
  ok(title({ type: "project_proposal", branch: "residential_repair" }) === "Approve your repair estimate",
    "residential repair keeps the estimate noun");
  ok(title({ type: "project_proposal", branch: "lighting_repair" }) === "Approve your repair proposal",
    "lighting repair reads as a repair");
  ok(title({ type: "on_site_quote" }) === "Approve your repair quote",
    "on-site quote wording is unchanged");
  ok(title({ type: "ai_repair_quote" }) === "Approve your repair quote",
    "AI repair quote wording is unchanged");
  ok(title(null) === "Approve your quote", "null quote gets a safe generic title");

  // The bug this was opened for: no install-side quote may preview as a repair.
  for (const b of ["direct_residential", "gc_subcontract", "lighting_design", "renovation_coordination", "change_order"]) {
    ok(!title({ type: "project_proposal", branch: b }).includes("repair"),
      `"${b}" never previews the word "repair"`);
  }

  // Nothing private may reach a link preview — these are fetched and cached
  // by Apple/Google/Meta servers.
  const loaded = title({
    type: "project_proposal", branch: "direct_residential",
    customerEmail: "jane@example.com", total: 24500,
    customerAddress: "123 Main St", quoteNumberDisplay: "Q-2026-0075"
  });
  for (const leak of ["jane", "example.com", "24500", "123 Main", "Q-2026-0075"]) {
    ok(!loaded.includes(leak), `title leaks no customer data (${leak})`);
  }
}

// 8 — approve.html itself must not carry a competing hardcoded title
{
  const html = read("server/approve.html");
  const titles = html.match(/<title>[\s\S]*?<\/title>/gi) || [];
  ok(titles.length === 1, "approve.html has exactly one <title> for the server to replace");
  // The static title is the BAD-TOKEN fallback. It must stay neutral: naming a
  // work type there is exactly the bug this change fixes, one layer down.
  ok(!/repair|install/i.test(titles[0] || ""),
    "approve.html's fallback <title> names no work type");
  ok(/<title>[\s\S]*?<\/title>/i.test(html), "the title tag matches the server's replace pattern");
}

console.log(`\nbranch labels + install/repair: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
