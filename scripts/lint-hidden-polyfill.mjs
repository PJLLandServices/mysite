// Every CRM/customer page whose script hides things with `.hidden = …`
// must also carry a `[hidden] { display: none }` rule.
//
//   node scripts/lint-hidden-polyfill.mjs      (in build:check)
//
// WHY. The `hidden` attribute is only a browser default. The moment a
// stylesheet gives an element an explicit `display` (a button styled
// `display: block`, a badge `display: inline-block`), that element can no
// longer be hidden by the attribute — the JS sets it and nothing happens.
// 2026-09-25: the customer appointment page lacked the rule, so tapping
// "Confirm this appointment" left the button on screen and the success
// badge off-screen; customers phoned to say it was broken. Twenty-odd
// other stylesheets already carried the polyfill — this one had been
// missed, and nothing checked. Now something does.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "server");
const HIDDEN_RULE = /\[hidden\][^{]*\{[^}]*display\s*:\s*none/;
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");

const problems = [];
for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith(".html")).sort()) {
  const html = read(path.join(DIR, file));
  const cssFiles = [...html.matchAll(/href="\/crm\/([\w.-]+\.css)/g)].map((m) => m[1]);
  const jsFiles = [...html.matchAll(/src="\/crm\/([\w.-]+\.js)/g)].map((m) => m[1]);
  const inlineJs = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  const inlineCss = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");

  const togglesHidden = /\.hidden\s*=/.test(inlineJs)
    || jsFiles.some((j) => /\.hidden\s*=/.test(read(path.join(DIR, j))));
  if (!togglesHidden) continue;

  const hasRule = HIDDEN_RULE.test(inlineCss)
    || cssFiles.some((c) => HIDDEN_RULE.test(read(path.join(DIR, c))));
  if (!hasRule) {
    problems.push(`server/${file} toggles .hidden but none of its styles (${cssFiles.join(", ") || "inline"}) `
      + `carry "[hidden] { display: none !important; }"`);
  }
}

if (problems.length) {
  console.error("✗ lint-hidden-polyfill:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("✓ lint-hidden-polyfill — every page that hides things can");
