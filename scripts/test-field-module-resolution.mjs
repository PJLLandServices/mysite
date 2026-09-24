#!/usr/bin/env node
// scripts/test-field-module-resolution.mjs
//
// Every import in the field app resolves the way METRO resolves it, to a
// file that exports what is imported.
//
// WHY. OTA run #28 (2026-09-24) showed the phone's own error: "TypeError:
// undefined is not a function" while drawing the Today screen. TodayScreen
// imported clientVersionText from './clientVersion', and there were TWO
// files with that name: clientVersion.js (which exports it) and
// clientVersion.mjs (which does not). Metro tries extensions in the order
// ts, tsx, mjs, js, … — .mjs BEFORE .js — so the phone got the .mjs file
// and an undefined function. Node, the vm tests and a jest harness all try
// .js first, so everything passed off the phone.
//
//   A. no two app files share a base name across the extensions Metro
//      tries (the ambiguity itself)
//   B. every relative import, resolved in Metro's order, lands on a file
//      that exports each name imported from it
//
// Run: node scripts/test-field-module-resolution.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "pjl-field");
// expo/metro-config's resolver.sourceExts for this project (SDK 54), in order.
const METRO_EXTS = ["ts", "tsx", "mjs", "js", "jsx", "json", "cjs"];
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(m?js|jsx|cjs|ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = [path.join(APP, "App.js"), path.join(APP, "index.js"), ...walk(path.join(APP, "src"))];

// ---- A. no ambiguous base names ------------------------------------------------
{
  const byBase = new Map();
  for (const f of files) {
    const base = f.replace(/\.[^./]+$/, "");
    byBase.set(base, [...(byBase.get(base) || []), path.basename(f)]);
  }
  const clashes = [...byBase.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => `${path.relative(APP, k)}: ${v.join(" + ")}`);
  ok(clashes.length === 0, `A. no two app files share a base name Metro could confuse (${clashes.join("; ") || "none"})`);
}

// ---- B. imports resolve, in Metro's order, to what they name --------------------
function resolve(fromFile, spec) {
  const target = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  for (const ext of METRO_EXTS) if (fs.existsSync(`${target}.${ext}`)) return `${target}.${ext}`;
  for (const ext of METRO_EXTS) if (fs.existsSync(path.join(target, `index.${ext}`))) return path.join(target, `index.${ext}`);
  return null;
}
function exportsOf(file) {
  const src = fs.readFileSync(file, "utf8");
  if (file.endsWith(".json")) return { names: new Set(), default: true };
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) names.add(n);
    }
  }
  return { names, default: /export\s+default\b/.test(src) };
}
let checked = 0;
const problems = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/^import\s+([^'"]+?)\s+from\s+'(\.[^']+)';/gm)) {
    const [, clause, spec] = m;
    const target = resolve(f, spec);
    const where = `${path.relative(APP, f)} → '${spec}'`;
    if (!target) { problems.push(`${where}: does not resolve`); continue; }
    const ex = exportsOf(target);
    const named = (clause.match(/\{([^}]*)\}/) || [, ""])[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const hasDefault = /^[A-Za-z_$][\w$]*/.test(clause.trim()) && !clause.trim().startsWith("*") && !clause.trim().startsWith("{");
    for (const n of named) {
      checked += 1;
      if (!ex.names.has(n)) problems.push(`${where} (${path.basename(target)}): no export '${n}'`);
    }
    if (hasDefault) {
      checked += 1;
      if (!ex.default && !target.endsWith(".json")) problems.push(`${where} (${path.basename(target)}): no default export`);
    }
  }
}
ok(checked > 50, `B. the check actually read the app's imports (${checked} names)`);
ok(problems.length === 0, `B. every import resolves, Metro-first, to a file exporting it:\n    ${problems.join("\n    ") || "ok"}`);

console.log(`field-module-resolution: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
