#!/usr/bin/env node
// scripts/test-crm-mobile-layout.mjs
//
// CRM-17 — the customer profile's summary card must not stay `position:
// sticky` once the profile grid collapses to one column.
//
// The defect: `.customer-summary` is sticky so that on desktop it stays in
// view beside a long tab column. Stacked into one column on a phone it is
// ~1760px tall against an ~840px viewport, so the browser pinned a box
// taller than the screen and everything below it — properties, bookings,
// work orders — scrolled straight through it. The visible symptom was the
// property addresses' map pins painting on top of the Delete button and
// through the danger-zone text.
//
// Two things are asserted, and the second is the one that actually bit:
//
//   1. The un-stick override exists, at the SAME breakpoint as the grid
//      collapse. If someone moves the collapse to 900px and leaves the
//      un-stick at 800px, there is a 100px band where the columns are
//      stacked and the summary is still pinned — the bug, reopened.
//   2. The override appears AFTER the rule it overrides. Both are plain
//      class selectors of equal specificity, so source order decides. The
//      first attempt at this fix put the override in the earlier media
//      block and `position: sticky` simply won — the page rendered exactly
//      as broken as before, with the fix "in".
//
// This is a source-level check on purpose: proving the rendered geometry
// needs a browser and a booted server, and `build:check` is node-only (the
// same call made for the CRM-15 booking-delete work). The rendered proof
// was a headless-Chromium pass over all 23 CRM pages at 390px, recorded in
// the register entry.
//
// Run: node scripts/test-crm-mobile-layout.mjs  (also in `npm run build:check`)

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

const css = await fs.readFile(path.join(ROOT, "server", "customers.css"), "utf8");

// ---- The base rule: sticky, for desktop ------------------------------
const baseMatch = css.match(/\.customer-summary\s*\{[^}]*\}/);
ok(Boolean(baseMatch), "customers.css defines a .customer-summary rule");
const baseRule = baseMatch ? baseMatch[0] : "";
ok(/position:\s*sticky/.test(baseRule), ".customer-summary is sticky at desktop width");
const baseIndex = baseMatch ? baseMatch.index : -1;

// ---- The grid collapse breakpoint ------------------------------------
const collapse = css.match(/@media\s*\(max-width:\s*(\d+)px\)\s*\{[^}]*\.customer-profile\s*\{[^}]*grid-template-columns:\s*1fr/);
ok(Boolean(collapse), "a media query collapses .customer-profile to one column");
const collapseWidth = collapse ? collapse[1] : null;

// ---- The un-stick override -------------------------------------------
// Find every media block that sets .customer-summary back to static, and
// keep the ones that come after the base rule — those are the ones that can
// actually win.
const overrides = [];
const mediaRe = /@media\s*\(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/g;
let m;
while ((m = mediaRe.exec(css)) !== null) {
  const body = m[2];
  const rule = body.match(/\.customer-summary\s*\{[^}]*\}/);
  if (rule && /position:\s*static/.test(rule[0])) {
    overrides.push({ width: m[1], index: m.index });
  }
}

ok(overrides.length > 0, ".customer-summary is set back to static in a media query");
const effective = overrides.filter((o) => o.index > baseIndex);
ok(effective.length > 0,
  "the un-stick override comes AFTER the base rule (equal specificity — source order decides, " +
  "and an override placed earlier in the file loses silently)");
ok(effective.some((o) => o.width === collapseWidth),
  `the un-stick breakpoint (${effective.map((o) => o.width).join("/") || "none"}px) matches the ` +
  `grid-collapse breakpoint (${collapseWidth}px) — a gap between them is a band of widths where ` +
  "the columns are stacked and the summary is still pinned");

// ---- No competing rule re-sticks it below the override ---------------
const lastEffective = effective.length ? Math.max(...effective.map((o) => o.index)) : -1;
const after = lastEffective >= 0 ? css.slice(lastEffective) : "";
const reSticks = /\.customer-summary\s*\{[^}]*position:\s*sticky/.test(after.slice(1));
ok(!reSticks, "nothing later in the file sets .customer-summary back to sticky");

console.log(`\ntest-crm-mobile-layout: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
