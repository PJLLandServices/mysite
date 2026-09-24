#!/usr/bin/env node
// scripts/test-closing-header-spacing.mjs
//
// The closing screen's stage tabs must not touch the header above them.
//
// WHY. Patrick's screenshot (2026-09-24): the Start / Water / Zones /
// Close-out / Sign-off pills sat flush against the hairline under the
// "‹ Back · WO-… · Synced" bar. `styles.tabs` had paddingBottom and no
// paddingTop, directly under `styles.bar`'s bottom border, so the pills
// began on the divider itself.
//
// Read from source rather than rendered: the app's screens import React
// Native, which cannot load here. What is asserted is the one property
// that decides the gap, plus the order that makes it matter.
//
// Run: node scripts/test-closing-header-spacing.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "pjl-field/src/screens/ClosingScreen.js"), "utf8");
const THEME = fs.readFileSync(path.join(ROOT, "pjl-field/src/theme.js"), "utf8");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const space = Function(`${THEME.match(/export const space = \{[^}]*\};/)[0].replace("export ", "")} return space;`)();

// A style entry's literal, e.g. `  tabs: { ... },` or a multi-line `  bar: {\n ... },`.
function styleOf(name) {
  const m = SRC.match(new RegExp(`\\n  ${name}: \\{([\\s\\S]*?)\\n?\\s*\\},?\\n`));
  return m ? m[1] : null;
}
function numeric(style, prop) {
  const m = style && style.match(new RegExp(`\\b${prop}: (space\\.(\\w+)|\\d+)`));
  if (!m) return 0;
  return m[2] ? space[m[2]] : Number(m[1]);
}

const bar = styleOf("bar");
const tabs = styleOf("tabs");
ok(bar && tabs, "found styles.bar and styles.tabs in ClosingScreen.js");

// The premise: the bar draws a divider at its bottom edge.
ok(/borderBottomWidth/.test(bar || ""), "the header bar still draws a bottom divider (if not, revisit this test)");

// The fix: the tab row starts a gap below that divider.
const top = Math.max(numeric(tabs, "paddingTop"), numeric(tabs, "paddingVertical"), numeric(tabs, "marginTop"));
ok(top >= space.sm, `the tab row sits at least space.sm (${space.sm}) below the header divider (has ${top})`);

// And the gap is symmetric with the one already under the pills, so the
// row reads as a band of its own rather than hanging off the header.
ok(top === Math.max(numeric(tabs, "paddingBottom"), numeric(tabs, "paddingVertical")),
  "the tab row's top gap matches its bottom gap");

// The order that makes the gap matter: in the ready screen, the tabs are
// the first row after the bar (the sync notice only appears when there is
// something to say).
const ready = SRC.slice(SRC.indexOf("const shared = {"));
ok(ready.indexOf("styles.bar") > 0 && ready.indexOf("styles.bar") < ready.indexOf("styles.tabs"),
  "the ready screen renders the bar, then the tabs");

console.log(`closing-header-spacing: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
