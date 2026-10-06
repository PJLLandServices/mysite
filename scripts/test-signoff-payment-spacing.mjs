#!/usr/bin/env node
// scripts/test-signoff-payment-spacing.mjs
//
// Sign-off's "How are they paying?" answers each get their own line.
//
// WHY. Patrick, 2026-10-06: on the last question before Finish, "Collect
// payment now" / "Send invoice / bill later" / "Paid in full (prepaid)"
// were "all bunched together". ChoiceRow laid every answer side by side,
// flex: 1 each, so three phrases shared one row at a third of the width and
// wrapped into one another.
//
// Read from source rather than rendered (the screens import React Native,
// which cannot load here), like test-closing-header-spacing.mjs: what is
// asserted is the layout that decides it.
//
// Run: node scripts/test-signoff-payment-spacing.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PARTS = fs.readFileSync(path.join(ROOT, "pjl-field/src/screens/closing/parts.js"), "utf8");
const SIGNOFF = fs.readFileSync(path.join(ROOT, "pjl-field/src/screens/closing/SignOffStage.js"), "utf8");
const THEME = fs.readFileSync(path.join(ROOT, "pjl-field/src/theme.js"), "utf8");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const space = Function(`${THEME.match(/export const space = \{[^}]*\};/)[0].replace("export ", "")} return space;`)();
const styleOf = (name) => (PARTS.match(new RegExp(`\\n  ${name}: \\{([^}]*)\\}`)) || [])[1] ?? null;
const num = (style, prop) => {
  const m = style && style.match(new RegExp(`\\b${prop}: (space\\.(\\w+)|\\d+)`));
  return m ? (m[2] ? space[m[2]] : Number(m[1])) : 0;
};

// Every <ChoiceRow …> in SignOffStage, with its props.
const rows = [...SIGNOFF.matchAll(/<ChoiceRow([\s\S]*?)\/>/g)].map((m) => m[1]);
const payment = rows.find((r) => /label="How are they paying\?"/.test(r));
ok(Boolean(payment), "found the \"How are they paying?\" question");
ok(payment && /\n\s*stacked\b|\sstacked=\{true\}/.test(payment), "the payment answers are stacked, one per line");
ok(payment && /Collect payment now/.test(payment) && /Send invoice \/ bill later/.test(payment) && /Paid in full \(prepaid\)/.test(payment),
  "…the three answers are still the three labels Patrick approved");
// Short answers stay side by side.
const others = rows.filter((r) => r !== payment);
ok(others.length >= 1 && others.every((r) => !/\bstacked\b/.test(r)), "short Yes/No-style questions keep their side-by-side row");

// ChoiceRow honours `stacked`.
ok(/export function ChoiceRow\(\{[^)]*\bstacked\b/.test(PARTS), "ChoiceRow takes a `stacked` prop");
ok(/stacked && styles\.choiceStacked/.test(PARTS), "…which switches the answer row to the stacked layout");
ok(/stacked && styles\.optStacked/.test(PARTS), "…and each answer to the full-width style");
const col = styleOf("choiceStacked");
ok(col && /flexDirection: 'column'/.test(col), "stacked answers sit in a column");
ok(num(col, "gap") >= space.sm, `…at least space.sm (${space.sm}) apart (has ${num(col, "gap")})`);
const opt = styleOf("optStacked");
ok(opt && /alignSelf: 'stretch'/.test(opt) && /flex: 0/.test(opt), "each stacked answer is full width, not a flex share of a row");
ok(num(opt, "paddingVertical") >= num(styleOf("opt"), "paddingVertical"), "…and at least as tall a tap target as before");

console.log(`test-signoff-payment-spacing: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
