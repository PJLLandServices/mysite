#!/usr/bin/env node
// scripts/test-zone-pager-arrows.mjs
//
// The zone pager's arrows were "barely touchable" (Patrick, 2026-10-01,
// after a day of closings). They were the closing's text Button with a
// one-character label ("‹" / "›") and no width, so the target was the width
// of the glyph. This pins them as a real target: a fixed block of at least
// 56 × 56 pt with a large chevron, labelled for VoiceOver, greyed (not
// hidden) at the ends.
//
// Run: node scripts/test-zone-pager-arrows.mjs   (also in build:check)

import fs from "node:fs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const src = fs.readFileSync(new URL("../pjl-field/src/screens/closing/ZoneStage.js", import.meta.url), "utf8");
const num = (re) => { const m = src.match(re); return m ? Number(m[1]) : 0; };

ok(!/<Button label="[‹›]"/.test(src), "the arrows are no longer one-character text buttons");
ok(/<PagerArrow\s+direction="previous"/.test(src) && /<PagerArrow\s+direction="next"/.test(src), "both ends use the PagerArrow target");
const block = (src.match(/arrow:\s*\{[^}]*\}/) || [""])[0];
const w = Number((block.match(/width:\s*(\d+)/) || [])[1] || 0);
const h = Number((block.match(/height:\s*(\d+)/) || [])[1] || 0);
ok(w >= 56 && h >= 56, `the target is at least 56 × 56 pt (${w} × ${h})`);
ok(num(/arrowGlyph:\s*\{[^}]*fontSize:\s*(\d+)/) >= 32, `the chevron is large (fontSize ${num(/arrowGlyph:\s*\{[^}]*fontSize:\s*(\d+)/)})`);
ok(/accessibilityLabel=\{next \? 'Next zone' : 'Previous zone'\}/.test(src), "each arrow says what it does to VoiceOver");
ok(/disabled=\{zoneIndex === 0\}/.test(src) && /disabled=\{zoneIndex \+ 1 >= total\}/.test(src) && /arrowOff/.test(src), "greyed, not hidden, at the first and last zone");

console.log(`\nzone pager arrows: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
