#!/usr/bin/env node
// scripts/test-proposal-gutter.mjs
//
// PROPOSAL-GUTTER — the customer-facing proposal page must keep its side
// margin on a phone.
//
// The defect (reported from a phone screenshot of Q-2026-0074, 2026-08-28):
// every section on the generated proposal ran flush to the left screen edge
// — "HOW THE SYSTEM WORKS", its lead paragraph and the card stack all
// started at x=0 — while the green hero above them kept a proper gutter.
//
// The cause was a plain cascade collision, not a missing rule. The page's
// one layout wrapper is
//
//     .wrap { max-width:1180px; margin:0 auto; padding:0 var(--gut); }
//
// and the sections are emitted as `class="sec wrap"` (proposal-html.js).
// `.sec` is declared LATER in the same stylesheet at equal specificity and
// used the `padding` SHORTHAND:
//
//     .sec { padding:clamp(52px,8vw,100px) 0; }   /* ← wipes the gutter */
//
// so its `0` horizontal component silently overwrote `.wrap`'s gutter on
// every section. Measured in headless Chromium before the fix, the section
// heading sat at x=0 at 320/360/390/430/768/900/1180px viewports.
//
// Why nobody caught it on a desktop: at 1440px `.wrap`'s max-width + auto
// margins still leave ~130px of empty page on each side, so the section
// looked fine — it was merely 64px out of alignment with the hero, which
// reads as a design choice rather than a bug. The gutter only becomes
// load-bearing once the viewport is narrower than 1180px, i.e. on a phone.
//
// The fix is to keep `.sec` / `.close` on padding LONGHANDS
// (`padding-top` / `padding-bottom`) so they can never touch the inline
// axis. This test pins that invariant generally rather than naming the two
// rules: it reads which classes the generator actually pairs with `wrap`,
// and fails if any of them carries a `padding` shorthand declared after
// `.wrap`. A future theme or section that reintroduces the collision fails
// here instead of shipping to a customer's phone.
//
// Source-level on purpose: proving the rendered geometry needs a browser,
// and `build:check` is node-only (same call made by
// test-crm-mobile-layout.mjs). The rendered proof for this fix was a
// headless-Chromium pass over the sprinkler, lighting and smart-controller
// proposals at 320-1440px, with the hero, sections and closing block all
// landing on the same left edge at every width.
//
// Run: node scripts/test-proposal-gutter.mjs  (also in `npm run build:check`)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(ROOT, "server", "lib", "proposal-assets");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

// ---- which classes does the generator put alongside `wrap`? ----------
// Read them from the markup rather than hard-coding "sec"/"close", so a new
// wrapper combination is covered the day it is written.
const generator = await fs.readFile(path.join(ROOT, "server", "lib", "proposal-html.js"), "utf8");
const companions = new Set();
for (const m of generator.matchAll(/class="([^"]*\bwrap\b[^"]*)"/g)) {
  for (const cls of m[1].trim().split(/\s+/)) if (cls !== "wrap") companions.add(cls);
}
ok(companions.size > 0, "found classes paired with .wrap in the generated markup");
ok(companions.has("sec"),
  "`sec` is still paired with `wrap` (the combination this regression is about)");

// A `padding` shorthand is dangerous only when it sets the horizontal axis.
// One value (`padding:20px`) and every 2/3/4-value form specify it, so any
// shorthand at all on a `.wrap` companion is a defect — there is no form of
// the shorthand that leaves the inline axis untouched.
// Anchored to the start of a declaration so `padding-top:` / `padding-bottom:`
// — the fix — are not mistaken for the shorthand.
const SHORTHAND = /(^|[;{])\s*padding\s*:/;

for (const file of ["sprinkler-theme.css", "lighting-theme.css", "combined-theme.css"]) {
  const css = await fs.readFile(path.join(ASSETS, file), "utf8");

  // ---- the wrapper itself still carries the gutter -------------------
  const wrapMatch = css.match(/(^|\n)\s*\.wrap\s*\{[^}]*\}/);
  ok(Boolean(wrapMatch), `${file}: defines a .wrap rule`);
  const wrapRule = wrapMatch ? wrapMatch[0] : "";
  const wrapIndex = wrapMatch ? wrapMatch.index : -1;
  ok(/padding:\s*0\s+var\(--gut\)/.test(wrapRule),
    `${file}: .wrap still sets the horizontal gutter (padding:0 var(--gut))`);
  ok(/--gut:\s*clamp\(/.test(css),
    `${file}: --gut is a clamp() so the gutter shrinks with the viewport but never reaches 0`);

  // ---- no companion of .wrap may use the padding shorthand ----------
  for (const cls of companions) {
    // Top-level rules only — a nested/compound selector like `.sec.band .pr`
    // targets a descendant, not the wrapper element itself.
    const ruleRe = new RegExp(`(^|\\n)\\s*\\.${cls}\\s*\\{([^}]*)\\}`, "g");
    let m;
    while ((m = ruleRe.exec(css)) !== null) {
      const [rule, , body] = [m[0], m[1], m[2]];
      if (!SHORTHAND.test(body)) continue;
      // Declared BEFORE .wrap it would lose the cascade and be harmless;
      // after it, at equal specificity, source order hands it the win.
      ok(m.index < wrapIndex,
        `${file}: .${cls} is emitted as class="${cls} wrap" and uses a \`padding\` ` +
        `shorthand declared after .wrap — that zeroes the horizontal gutter and the ` +
        `section runs flush to the screen edge on a phone. Use padding-top/padding-bottom ` +
        `longhands instead. Offending rule: ${rule.trim().slice(0, 90)}…`);
    }
  }

  // ---- and the vertical padding survived the conversion --------------
  const secMatch = css.match(/(^|\n)\s*\.sec\s*\{([^}]*)\}/);
  ok(Boolean(secMatch), `${file}: defines a .sec rule`);
  const secBody = secMatch ? secMatch[2] : "";
  ok(/padding-top:\s*clamp\(/.test(secBody) && /padding-bottom:\s*clamp\(/.test(secBody),
    `${file}: .sec still has its top and bottom breathing room as longhands`);
}

console.log(`\ntest-proposal-gutter: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
