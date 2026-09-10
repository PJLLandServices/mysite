// The property-merge admin route — its gate, its second factor, and the
// guarantee that it and the CLI are the same code.
//
//   node scripts/test-property-merge-route.mjs
//
// WHAT THIS COVERS. server/lib/property-merge.js is exercised in depth by
// scripts/test-merge-properties.mjs (110 assertions, mutation-tested).
// This file covers what that one cannot: that the route is wired to the
// same lib, that it is admin-only, that an apply needs a typed
// confirmation, and that the lib's refusals surface as refusals rather
// than as 500s.
//
// The route deletes a property record and rewrites which property every
// linked invoice and work order belongs to, so the gate and the second
// factor ARE the feature, not decoration.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const server = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
const cli = fs.readFileSync(path.join(ROOT, "scripts/merge-properties.mjs"), "utf8");

// ---- 1. One implementation, two callers ------------------------------

{
  const lib = require(path.join(ROOT, "server/lib/property-merge.js"));
  ok("the lib exports mergeProperties", typeof lib.mergeProperties === "function");
  ok("the lib exports findProperty", typeof lib.findProperty === "function");

  ok("the route calls the shared lib", server.includes('require("./lib/property-merge")'));
  ok("the CLI calls the shared lib", cli.includes("server/lib/property-merge.js"));

  // Neither caller may carry its own copy of the merge logic. The
  // distinctive internals live in exactly one file.
  // Internals distinctive to the merge implementation. `optOutTokens` is
  // deliberately NOT in this list — it's shared domain vocabulary that
  // server.js legitimately uses for seasonal-consent sanitizing, so it
  // would false-positive.
  for (const marker of ["_merge-backups", "REPORT_ONLY", "walkObjects", "mergedFrom"]) {
    ok(`the route holds no copy of ${marker}`, !server.includes(marker),
      `found "${marker}" in server.js`);
    ok(`the CLI holds no copy of ${marker}`, !cli.includes(marker),
      `found "${marker}" in the CLI`);
  }
}

// ---- 2. The gate ------------------------------------------------------

{
  ok("merge-into is admin in needsAuth",
    /if \(\/\^\\\/api\\\/properties\\\/\[\^\/\]\+\\\/merge-into\$\/\.test\(pathname\)\) return "admin";/.test(server)
    || server.includes('merge-into$/.test(pathname)) return "admin"'));

  // needsAuth returns on FIRST match, so the specific admin rule has to sit
  // above the generic /api/properties → "user" line. Below it, every tech
  // silently gets the ability to delete a property. Same trap the
  // service-fee-waiver rule documents.
  const mergeIdx = server.indexOf('merge-into$/.test(pathname)) return "admin"');
  const genericIdx = server.indexOf('if (pathname.startsWith("/api/properties")) return "user";');
  ok("the admin rule sits above the generic properties rule",
    mergeIdx !== -1 && genericIdx !== -1 && mergeIdx < genericIdx,
    `merge at ${mergeIdx}, generic at ${genericIdx}`);

  ok("the route re-checks requireAdmin",
    /propertyMergeMatch && req\.method === "POST"\)[\s\S]{0,200}requireAdmin\(req\)/.test(server));
  ok("a non-admin gets 403 from the route body",
    /Admin role required/.test(server.slice(server.indexOf("propertyMergeMatch && req.method"), server.indexOf("propertyMergeMatch && req.method") + 400)));
}

// ---- 3. The second factor --------------------------------------------

{
  const block = server.slice(
    server.indexOf("const propertyMergeMatch"),
    server.indexOf("const propertyMergeMatch") + 3000
  );
  ok("dry run is the default", block.includes("const apply = payload?.apply === true;"));
  ok("an apply requires the typed confirmation",
    block.includes('String(payload?.confirm || "") !== "MERGE"'));
  ok("the confirmation is only demanded on apply",
    /if \(apply && String\(payload\?\.confirm/.test(block));
  ok("duplicateId is required", block.includes("duplicateId is required."));
  ok("the lib's refusals come back as 422, not 500",
    /sendJson\(res, 422, \{ ok: false, errors: result\.problems \}\)/.test(block));
  ok("the merge is attributed to the operator", block.includes("by: await actorLabel(req)"));
  ok("the keeper is the URL and the duplicate is the body",
    block.includes("keep: keepId") && block.includes("remove: duplicateId"));
}

// ---- 4. Behaviour of the lib through the route's own arguments --------
//
// A tiny end-to-end of the exact call shape the route makes, so a change
// to the lib's signature breaks this file rather than only production.

{
  const os = require("node:os");
  const { mergeProperties } = require(path.join(ROOT, "server/lib/property-merge.js"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-merge-route-"));
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const mk = (id, code, extra) => Object.assign({
    id, code, customerId: "CUST-1", customerEmail: "r@x.invalid", customerName: "Randy State",
    customerPhone: "", address: "1 Test Lane", system: { zones: [], valveBoxes: [] },
    leadIds: [], workOrderIds: [], photos: [], deferredIssues: [], serviceRecords: [],
    history: [], ownerHistory: [],
    seasonalEligibility: { springOpening: true, fallClosing: true },
    seasonalPricing: { springOpeningPrice: null, fallClosingPrice: null, hasAdditionalFallBlowout: false, additionalFallBlowoutPrice: null, additionalFallBlowoutDescription: "" },
    seasonalOutreach: {},
    commPrefs: { seasonalRemindersSMS: true, seasonalRemindersEmail: true, reviewRequestsEmail: true, optOutTokens: { seasonalSMS: null, seasonalEmail: null, seasonalAll: null, reviewEmail: null } }
  }, extra);

  const w = (n, v) => fs.writeFileSync(path.join(dataDir, n), JSON.stringify(v, null, 2) + "\n");
  w("properties.json", [mk("keep-1", "P-2026-0056"), mk("dup-1", "P-2026-0040")]);
  w("invoices.json", [{ id: "I-1", propertyId: "dup-1", status: "paid", total: 339, address: "1 Test Lane" }]);

  // The route's dry-run call shape.
  const dry = mergeProperties({
    dataDir, keep: "P-2026-0056", remove: "P-2026-0040",
    apply: false, allowDifferentCustomer: false, alignDraftInvoiceAddresses: false,
    by: "Claude"
  });
  ok("route-shaped dry run succeeds", dry.ok === true && dry.applied === false);
  ok("route-shaped dry run plans the invoice move", dry.plan.totalRepointed === 1);
  ok("route-shaped dry run writes nothing",
    JSON.parse(fs.readFileSync(path.join(dataDir, "invoices.json"), "utf8"))[0].propertyId === "dup-1");

  // The route's apply call shape.
  const applied = mergeProperties({
    dataDir, keep: "P-2026-0056", remove: "P-2026-0040",
    apply: true, allowDifferentCustomer: false, alignDraftInvoiceAddresses: false,
    by: "Claude"
  });
  ok("route-shaped apply succeeds", applied.ok === true && applied.applied === true);
  ok("route-shaped apply re-points the paid invoice",
    JSON.parse(fs.readFileSync(path.join(dataDir, "invoices.json"), "utf8"))[0].propertyId === "keep-1");
  ok("route-shaped apply deletes the duplicate",
    JSON.parse(fs.readFileSync(path.join(dataDir, "properties.json"), "utf8")).length === 1);
  ok("route-shaped apply attributes the operator",
    JSON.parse(fs.readFileSync(path.join(dataDir, "properties.json"), "utf8"))[0]
      .history.some((h) => h.action === "property_merged" && h.by === "Claude"));
  ok("route-shaped apply returns a backup dir", Boolean(applied.backupDir) && fs.existsSync(applied.backupDir));

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- Result -----------------------------------------------------------

if (failures.length) {
  console.error(`\nproperty-merge-route: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("");
  process.exit(1);
}
console.log(`property-merge-route: ${pass} assertions passed`);
