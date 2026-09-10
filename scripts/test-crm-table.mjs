#!/usr/bin/env node
// scripts/test-crm-table.mjs
//
// CRM-18 — the Customers and Properties indexes are data tables built on
// one shared primitive (.crm-table in crm.css). The header row and every
// data row are separate grids that read the SAME column template from a
// custom property, --crm-cols, set per page.
//
// That is the whole load-bearing idea, and it has exactly one way to
// break: someone adds a column to the header and not to the track list
// (or the reverse). Nothing errors — the header simply stops sitting
// above its own data, and every value shifts one column over. It looks
// like a rendering glitch, not a typo, so it is worth a build-time check.
//
// Asserted per page:
//   1. --crm-cols exists and its track count matches the number of header
//      cells in the page's markup.
//   2. The header lives inside the same .crm-table element as the list
//      container the renderer fills — two sibling grids under one parent
//      is what makes them share the template.
//   3. Every column has a label except the ones that are deliberately
//      blank (checkbox, row action), so no column is unexplained.
//
// Run: node scripts/test-crm-table.mjs   (also in `npm run build:check`)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

// Count grid tracks, treating minmax(a, b) / clamp(...) as ONE track —
// splitting on whitespace alone would count "minmax(180px," and "1.8fr)"
// as two and quietly pass a mismatched table.
function countTracks(value) {
  const flattened = value.replace(/\([^()]*\)/g, "()");
  return flattened.trim().split(/\s+/).filter(Boolean).length;
}

const PAGES = [
  {
    label: "customers",
    css: "customers.css",
    html: "customers.html",
    tableClass: "customers-table",
    listId: "customersList",
    // Checkbox column and the row-action column carry no header label.
    blankColumns: 2
  },
  {
    label: "properties",
    css: "property.css",
    html: "properties.html",
    tableClass: "properties-table",
    listId: "propertiesGrid",
    blankColumns: 0
  },
  // The rest of the CRM's record lists, whose templates live in crm.css
  // alongside the primitive itself.
  { label: "bookings",   css: "crm.css", html: "bookings.html",       tableClass: "bookings-table",  listId: "bookingsList",      blankColumns: 0 },
  { label: "projects",   css: "crm.css", html: "projects.html",       tableClass: "projects-table",  listId: "projectsContainer", blankColumns: 0 },
  { label: "materials",  css: "crm.css", html: "material-lists.html", tableClass: "mllists-table",   listId: "listsContainer",    blankColumns: 0 },
  // Suppliers act on the record in place; work orders carry a recovery
  // action on two of their filters. Both keep one deliberately unlabelled
  // action column.
  { label: "suppliers",  css: "crm.css", html: "suppliers.html",      tableClass: "suppliers-table", listId: "suppliersList",     blankColumns: 1 },
  { label: "workorders", css: "crm.css", html: "work-orders.html",    tableClass: "wo-table",        listId: "woContainer",       blankColumns: 1 }
];

for (const page of PAGES) {
  const css = await fs.readFile(path.join(ROOT, "server", page.css), "utf8");
  const html = await fs.readFile(path.join(ROOT, "server", page.html), "utf8");

  const rule = css.match(new RegExp(`\\.${page.tableClass}\\s*\\{([^}]*)\\}`));
  ok(Boolean(rule), `${page.label}: .${page.tableClass} rule exists in ${page.css}`);
  const colsMatch = rule && rule[1].match(/--crm-cols:\s*([^;]+);/);
  ok(Boolean(colsMatch), `${page.label}: .${page.tableClass} defines --crm-cols`);
  if (!colsMatch) continue;
  const trackCount = countTracks(colsMatch[1]);

  const head = html.match(/<div class="crm-table-head"[^>]*>([\s\S]*?)<\/div>/);
  ok(Boolean(head), `${page.label}: ${page.html} has a .crm-table-head row`);
  if (!head) continue;
  const cells = [...head[1].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) => m[1].trim());

  ok(cells.length === trackCount,
    `${page.label}: ${cells.length} header cells vs ${trackCount} columns in --crm-cols — ` +
    "a mismatch shifts every value one column away from its heading");

  const blanks = cells.filter((c) => c === "").length;
  ok(blanks === page.blankColumns,
    `${page.label}: ${blanks} unlabelled columns, expected ${page.blankColumns} ` +
    "(checkbox / row action) — any other blank heading is a column nothing explains");

  // The header and the list must sit inside the SAME .crm-table element.
  // Two grids in different containers can carry the same template and
  // still not line up, because padding and scrollbars land differently.
  const table = html.match(new RegExp(`<section class="crm-table ${page.tableClass}"[^>]*>([\\s\\S]*?)</section>`));
  ok(Boolean(table), `${page.label}: the table is one <section class="crm-table ${page.tableClass}">`);
  if (table) {
    ok(table[1].includes('class="crm-table-head"'), `${page.label}: header row is inside that section`);
    ok(table[1].includes(`id="${page.listId}"`), `${page.label}: #${page.listId} is inside that section`);
  }
}

// The shared primitive itself must keep reading the per-page template
// rather than hardcoding a column list of its own.
const crm = await fs.readFile(path.join(ROOT, "server", "crm.css"), "utf8");
const shared = crm.match(/\.crm-table-head,\s*\.crm-table-row\s*\{([^}]*)\}/);
ok(Boolean(shared), "crm.css styles .crm-table-head and .crm-table-row together");
ok(shared && /grid-template-columns:\s*var\(--crm-cols\)/.test(shared[1]),
  "crm.css: header and rows both read grid-template-columns: var(--crm-cols) — " +
  "the single definition is what keeps them aligned");

console.log(`\ntest-crm-table: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
