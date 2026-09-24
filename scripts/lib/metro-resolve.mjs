// scripts/lib/metro-resolve.mjs
//
// Resolve a field-app import THE WAY THE PHONE'S BUNDLER DOES, for any test
// that reasons about the app's modules.
//
// WHY. Node, the vm-based app tests and jest all try `.js` before `.mjs`.
// Metro, which builds what actually runs on the phone, tries `.mjs` FIRST
// (expo/metro-config sourceExts: ts, tsx, mjs, js, …). On 2026-09-24 that
// difference shipped a Today tab that crashed on every launch: two files
// were named clientVersion (.js and .mjs), every test resolved the .js,
// and the phone got the .mjs. See scripts/test-field-module-resolution.mjs.
//
// So the extension order is read from the app's OWN Metro config
// (pjl-field/node_modules/expo/metro-config), not typed here. If Metro's
// order ever changes, the tests follow it. If the app's dependencies are not
// installed, this refuses rather than guessing: CI installs them
// (.github/workflows/ci.yml, "npm ci" in pjl-field) before build:check.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const APP = path.join(ROOT, "pjl-field");

// What this project's Metro config said on 2026-09-24 (SDK 54). Only a
// cross-check: metroSourceExts() reads the live value.
export const EXPECTED_SOURCE_EXTS_PREFIX = ["ts", "tsx", "mjs", "js", "jsx", "json", "cjs"];

let cached = null;
export function metroSourceExts() {
  if (cached) return cached;
  let getDefaultConfig;
  try {
    ({ getDefaultConfig } = createRequire(path.join(APP, "package.json"))("expo/metro-config"));
  } catch (err) {
    throw new Error(`Can't read the app's Metro config (expo/metro-config): ${err.message}. Run "npm ci" in pjl-field first — these tests resolve imports the way the phone's bundler does, and won't guess.`);
  }
  const exts = getDefaultConfig(APP)?.resolver?.sourceExts;
  if (!Array.isArray(exts) || !exts.length) throw new Error("expo/metro-config returned no resolver.sourceExts");
  cached = exts.slice();
  return cached;
}

// A relative specifier from `fromFile`, resolved in Metro's order: the exact
// file, then <spec>.<ext> for each source extension in order, then
// <spec>/index.<ext>. Returns the absolute path, or null.
export function resolveAppImport(fromFile, spec, exts = metroSourceExts()) {
  const target = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  for (const ext of exts) if (fs.existsSync(`${target}.${ext}`)) return `${target}.${ext}`;
  for (const ext of exts) if (fs.existsSync(path.join(target, `index.${ext}`))) return path.join(target, `index.${ext}`);
  return null;
}

// The names a module exports, read from source (ESM export forms, plus
// CommonJS module.exports = { … } / exports.x =).
export function exportsOf(file) {
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
  for (const m of src.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  const cjs = src.match(/module\.exports\s*=\s*\{([^}]*)\}/);
  if (cjs) for (const part of cjs[1].split(",")) { const n = part.split(":")[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n); }
  return { names, default: /export\s+default\b/.test(src) || /module\.exports\s*=/.test(src) };
}

// Every app source file Metro can bundle: App.js, index.js and src/**.
export function appSourceFiles(exts = metroSourceExts()) {
  const code = new Set(exts.filter((e) => !["json", "scss", "sass", "css"].includes(e)));
  const out = [path.join(APP, "App.js"), path.join(APP, "index.js")];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (code.has(path.extname(e.name).slice(1))) out.push(p);
    }
  };
  walk(path.join(APP, "src"));
  return out.filter((f) => fs.existsSync(f));
}
