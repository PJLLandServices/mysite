// One-time cleanup: collapse multiple <script src="js/pricing-injector.js">
// tags to a single instance per file (an earlier sweep pass inserted the
// tag twice on some pages).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const RE = /[ \t]*<script\s+src="js\/pricing-injector\.js"[^>]*><\/script>\s*\n?/gi;

const files = fs.readdirSync(ROOT).filter(f => f.endsWith(".html"));
let fixed = 0;
for (const file of files) {
  const filepath = path.join(ROOT, file);
  const original = fs.readFileSync(filepath, "utf8");
  const matches = original.match(RE) || [];
  if (matches.length <= 1) continue;
  // Keep the FIRST occurrence, remove the rest
  let seen = false;
  const updated = original.replace(RE, (m) => {
    if (!seen) { seen = true; return m; }
    return "";
  });
  fs.writeFileSync(filepath, updated);
  fixed++;
  console.log(`  ✏ ${file} (had ${matches.length}, now 1)`);
}
console.log(`\nDone. Fixed ${fixed} files.`);
