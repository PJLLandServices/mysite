#!/usr/bin/env node
// scripts/lint-qb-mappings.mjs
//
// Verifies the QuickBooks items map (server/data/quickbooks-items.json)
// against the source-of-truth catalogs (pricing.json, parts.json):
//
//   ERRORS (exit 1):
//     - A pricing.json item that should have a QB mapping (i.e. has a
//       fixed price — quoteType !== "custom") but doesn't appear in
//       quickbooks-items.json.services
//     - A parts.json SKU not in quickbooks-items.json.parts
//
//   WARNINGS (exit 0):
//     - A mapping in quickbooks-items.json whose key/SKU no longer exists
//       in pricing.json/parts.json. Stale mappings are intentionally
//       retained (the QB Item may sit on past invoices) so this is not
//       a hard error.
//
//   PERMISSIVE MODE (exit 0):
//     - quickbooks-items.json doesn't exist yet (sync hasn't been run).
//       This is the normal state in CI / on a fresh clone since the
//       file lives under server/data/ which is gitignored. Pass `--strict`
//       to require the file to exist.
//
// The pricing.json `quoteType: "custom"` items legitimately have no
// fixed price (e.g. "Cap 2+ sprinkler heads (labour only)") — pushing
// them as QB Items would mean a $0 item that drifts on every sync. They
// get an explicit pass.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const STRICT = process.argv.includes("--strict");
const VERBOSE = process.argv.includes("--verbose");

const PRICING_PATH = path.join(ROOT, "pricing.json");
const PARTS_PATH = path.join(ROOT, "parts.json");
const ITEMS_MAP_PATH = path.join(ROOT, "server", "data", "quickbooks-items.json");

function fail(msg) {
  console.error(`[31m✗[0m ${msg}`);
}
function warn(msg) {
  console.warn(`[33m⚠[0m ${msg}`);
}
function pass(msg) {
  if (VERBOSE) console.log(`[32m✓[0m ${msg}`);
}

const pricing = JSON.parse(fs.readFileSync(PRICING_PATH, "utf8"));
const parts = JSON.parse(fs.readFileSync(PARTS_PATH, "utf8"));

const services = pricing?.items || {};
const partsCatalog = parts?.parts || {};

if (!fs.existsSync(ITEMS_MAP_PATH)) {
  if (STRICT) {
    fail(`No quickbooks-items.json at ${ITEMS_MAP_PATH} — run an items sync first, or remove --strict.`);
    process.exit(1);
  }
  console.log("ℹ  quickbooks-items.json not found — sync hasn't been run. Lint pass (permissive mode).");
  console.log("   Run `npm run lint:qb-mappings -- --strict` to require the map.");
  process.exit(0);
}

const itemsMap = JSON.parse(fs.readFileSync(ITEMS_MAP_PATH, "utf8"));
const mappedServices = itemsMap?.services || {};
const mappedParts = itemsMap?.parts || {};

const errors = [];
const warnings = [];

// (1) Coverage — every service with a fixed price must be mapped.
for (const [key, source] of Object.entries(services)) {
  if (source.quoteType === "custom") {
    pass(`services/${key} skipped (quoteType: custom)`);
    continue;
  }
  if (!mappedServices[key]?.qbItemId) {
    errors.push(`services/${key} ("${source.label || key}", $${source.price}) has no QB mapping. Run /admin/settings → Sync items.`);
    continue;
  }
  pass(`services/${key} → QB Item ${mappedServices[key].qbItemId}`);
}

// (2) Coverage — every part SKU must be mapped.
for (const sku of Object.keys(partsCatalog)) {
  if (!mappedParts[sku]?.qbItemId) {
    errors.push(`parts/${sku} ("${partsCatalog[sku].description}") has no QB mapping. Run /admin/settings → Sync items.`);
    continue;
  }
  pass(`parts/${sku} → QB Item ${mappedParts[sku].qbItemId}`);
}

// (3) Stale mappings — warn but don't fail.
for (const key of Object.keys(mappedServices)) {
  if (!services[key]) {
    warnings.push(`services/${key} mapping is stale — key removed from pricing.json. QB Item ${mappedServices[key].qbItemId} retained for historical invoices.`);
  }
}
for (const sku of Object.keys(mappedParts)) {
  if (!partsCatalog[sku]) {
    warnings.push(`parts/${sku} mapping is stale — SKU removed from parts.json. QB Item ${mappedParts[sku].qbItemId} retained for historical invoices.`);
  }
}

if (warnings.length) {
  console.log("");
  for (const w of warnings) warn(w);
}
if (errors.length) {
  console.log("");
  for (const e of errors) fail(e);
  console.log("");
  console.log(`${errors.length} unmapped item${errors.length === 1 ? "" : "s"}. Sync via /admin/settings before pushing invoices.`);
  process.exit(1);
}

const totalServices = Object.keys(services).length;
const skippedServices = Object.values(services).filter((s) => s.quoteType === "custom").length;
const checkedServices = totalServices - skippedServices;
console.log(`✓ QB mappings clean: ${checkedServices}/${totalServices} services (${skippedServices} skipped as custom-priced) and ${Object.keys(partsCatalog).length} parts mapped.`);
if (warnings.length) {
  console.log(`  ${warnings.length} stale mapping${warnings.length === 1 ? "" : "s"} retained — see warnings above.`);
}
