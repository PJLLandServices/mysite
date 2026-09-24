#!/usr/bin/env node
// scripts/test-field-module-resolution.mjs
//
// Every import in the field app resolves the way METRO resolves it, to a
// file that exports what is imported. PERMANENT (Patrick, 2026-09-24):
// app tests resolve imports the way the phone's bundler does, so a
// .js / .mjs collision can't slip through again.
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
// The order comes from the app's own Metro config at test time
// (scripts/lib/metro-resolve.mjs), not from a list typed here. Any new test
// that needs to know which file an app import lands on should use
// resolveAppImport() from that helper.
//
//   0. the order really is read from Metro, and still puts .mjs before .js
//      (if it ever changes, this says so, instead of silently agreeing)
//   A. no two app files share a base name across Metro's extensions
//   B. every relative import, resolved in Metro's order, lands on a file
//      that exports each name imported from it
//   C. the same for relative require() calls (BootGuard loads App and
//      clientVersion lazily), including the property read off them
//
// Run: node scripts/test-field-module-resolution.mjs   (also in build:check)

import path from "node:path";
import fs from "node:fs";
import { APP, EXPECTED_SOURCE_EXTS_PREFIX, metroSourceExts, resolveAppImport, exportsOf, appSourceFiles } from "./lib/metro-resolve.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

let exts = null;
try { exts = metroSourceExts(); } catch (err) { ok(false, `0. read Metro's resolver order — ${err.message}`); }

if (exts) {
  // ---- 0. the order is Metro's, and we know what it implies ----------------
  ok(exts.indexOf("mjs") !== -1 && exts.indexOf("mjs") < exts.indexOf("js"),
    `0. Metro tries .mjs before .js (${exts.join(",")}) — the fact this suite exists for`);
  ok(JSON.stringify(exts.slice(0, EXPECTED_SOURCE_EXTS_PREFIX.length)) === JSON.stringify(EXPECTED_SOURCE_EXTS_PREFIX),
    `0. Metro's order is still ${EXPECTED_SOURCE_EXTS_PREFIX.join(",")} (now ${exts.join(",")}) — if this changed on purpose, update EXPECTED_SOURCE_EXTS_PREFIX in scripts/lib/metro-resolve.mjs after checking A–C still mean what they say`);

  const files = appSourceFiles(exts);

  // ---- A. no ambiguous base names ------------------------------------------
  {
    const byBase = new Map();
    for (const f of files) {
      const base = f.replace(/\.[^./]+$/, "");
      byBase.set(base, [...(byBase.get(base) || []), path.basename(f)]);
    }
    const clashes = [...byBase.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => `${path.relative(APP, k)}: ${v.join(" + ")}`);
    ok(clashes.length === 0, `A. no two app files share a base name Metro could confuse (${clashes.join("; ") || "none"})`);
  }

  // ---- B/C. imports and requires resolve, in Metro's order, to what they name
  let checked = 0;
  const problems = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/^import\s+([^'"]+?)\s+from\s+'(\.[^']+)';/gm)) {
      const [, clause, spec] = m;
      const target = resolveAppImport(f, spec, exts);
      const where = `${path.relative(APP, f)} → '${spec}'`;
      if (!target) { problems.push(`B. ${where}: does not resolve`); continue; }
      const ex = exportsOf(target);
      const named = (clause.match(/\{([^}]*)\}/) || [, ""])[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      const trimmed = clause.trim();
      const hasDefault = /^[A-Za-z_$][\w$]*/.test(trimmed) && !trimmed.startsWith("*") && !trimmed.startsWith("{");
      for (const n of named) {
        checked += 1;
        if (!ex.names.has(n)) problems.push(`B. ${where} (${path.basename(target)}): no export '${n}'`);
      }
      if (hasDefault) {
        checked += 1;
        if (!ex.default) problems.push(`B. ${where} (${path.basename(target)}): no default export`);
      }
    }
    for (const m of src.matchAll(/require\('(\.[^']+)'\)(?:\.([A-Za-z_$][\w$]*))?/g)) {
      const [, spec, prop] = m;
      const target = resolveAppImport(f, spec, exts);
      const where = `${path.relative(APP, f)} → require('${spec}')${prop ? "." + prop : ""}`;
      checked += 1;
      if (!target) { problems.push(`C. ${where}: does not resolve`); continue; }
      const ex = exportsOf(target);
      if (prop === "default" ? !ex.default : (prop && !ex.names.has(prop))) problems.push(`C. ${where} (${path.basename(target)}): no such export`);
    }
  }
  ok(checked > 50, `B. the check actually read the app's imports (${checked} names)`);
  ok(problems.length === 0, `B/C. every import and require resolves, Metro-first, to a file exporting it:\n    ${problems.join("\n    ") || "ok"}`);
}

console.log(`field-module-resolution: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
