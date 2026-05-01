// Final hand-targeted cleanup for the last 18 ambiguous prices that the
// generic sweep couldn't disambiguate. Each fix uses a long-context regex
// keyed to specific surrounding text so it matches exactly one place.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const FIXES = [
  // sprinkler-fall-winterization.html + sprinkler-spring-opening.html:
  // "for 3-valve manifold or $285 for 6-valve" — the $285 here is manifold_6valve.
  { files: ["sprinkler-fall-winterization.html", "sprinkler-spring-opening.html", "blog-when-to-turn-on-sprinklers-ontario.html"],
    re: /\$285\s+for\s+6-valve/g,
    repl: '<span data-price="manifold_6valve">$285</span> for 6-valve' },

  // blog-sprinkler-system-cost-ontario.html: pricing table cells
  { files: ["blog-sprinkler-system-cost-ontario.html"],
    re: /<td class="cell-price">\$285<\/td>/,
    repl: '<td class="cell-price"><span data-price="manifold_6valve">$285</span></td>' },
  { files: ["blog-sprinkler-system-cost-ontario.html"],
    re: /<td class="cell-price">\$120<\/td>/,
    repl: '<td class="cell-price"><span data-price="pipe_break_3ft">$120</span></td>' },

  // blog-spring-sprinkler-opening.html: "Residential, 7-8 zones: $120" → spring_open_8z
  { files: ["blog-spring-sprinkler-opening.html"],
    re: /(Residential, 7[-–]8 zones:[^$]*?<\/strong>\s*)\$120/,
    repl: '$1<span data-price="spring_open_8z">$120</span>' },

  // blog-sprinkler-maintenance-checklist.html: "$120 winterization visit" → fall_close_8z
  { files: ["blog-sprinkler-maintenance-checklist.html"],
    re: /\$120 winterization visit/,
    repl: '<span data-price="fall_close_8z">$120</span> winterization visit' },

  // commercial-irrigation.html: "From $285" — this is on a commercial-services
  // page so the $285 is the spring_open_commercial price.
  { files: ["commercial-irrigation.html"],
    re: /<span class="cm-svc__price">From \$285<\/span>/,
    repl: '<span class="cm-svc__price">From <span data-price="spring_open_commercial">$285</span></span>' }
];

// Run each fix against each listed file
let changes = 0;
const seen = new Set();
for (const fix of FIXES) {
  for (const file of fix.files) {
    const filepath = path.join(ROOT, file);
    if (!fs.existsSync(filepath)) continue;
    const original = fs.readFileSync(filepath, "utf8");
    const updated = original.replace(fix.re, fix.repl);
    if (updated !== original) {
      fs.writeFileSync(filepath, updated);
      changes++;
      seen.add(file);
      console.log(`  ✏ ${file}: ${fix.re.source.slice(0, 50)}...`);
    }
  }
}
console.log(`\nDone. ${changes} fixes across ${seen.size} files.`);
