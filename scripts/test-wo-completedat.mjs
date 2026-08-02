#!/usr/bin/env node
// scripts/test-wo-completedat.mjs
//
// Integration tests for JOB-002 Part A — the completedAt foundation:
//
//   1. update() server-stamps completedAt on EVERY transition into
//      "completed", not just tech-UI ones (the gap that produced 10
//      timestamp-less completed records on Render). The stamp equals the
//      status_change history ts.
//   2. completedAt is NOT client-patchable — a patch carrying completedAt
//      is ignored (field is not in the update allow-list).
//   3. Preserve-if-set: an existing completedAt survives later patches.
//   4. departedAt is untouched by the server — still null unless the
//      caller (tech UI) supplies it, and still stored when supplied.
//   5. hydrate(): legacy records without the field read back as null.
//   6. lib/warranty.js: 36 months for build, 12 for everything else;
//      structured refusals for not-completed and no-completion-date;
//      expiry arithmetic matches completion-cascade's addMonths.
//   7. The backfill script: dry-run writes nothing; --apply backs up
//      first, promotes the EARLIEST history completion ts, touches
//      nothing else, and skips unrecoverable records.
//
// Isolation: work-orders.js requires only node builtins and resolves its
// store as `<lib dir>/../data/work-orders.json`, so the suite runs against
// copies in a temp directory — it can never touch real data. Same pattern
// as test-commercial-schema.mjs.
//
// Run: node scripts/test-wo-completedat.mjs   (also in `npm run build:check`)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

// ---- Sandbox A: work-orders lib + warranty lib -----------------------
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-wo-completedat-"));
fs.mkdirSync(path.join(SANDBOX, "lib"), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, "data"), { recursive: true });
for (const f of ["work-orders.js", "warranty.js"]) {
  fs.copyFileSync(path.join(ROOT, "server", "lib", f), path.join(SANDBOX, "lib", f));
}
const require = createRequire(import.meta.url);
const workOrders = require(path.join(SANDBOX, "lib", "work-orders.js"));
const warranty = require(path.join(SANDBOX, "lib", "warranty.js"));
const WO_JSON = path.join(SANDBOX, "data", "work-orders.json");
fs.writeFileSync(WO_JSON, "[]\n", "utf8");

const fakeLead = { id: "L-TEST", customerId: "1", contact: { name: "Test Customer", email: "t@example.com", phone: "", address: "1 Test St" } };

// 1. Admin-path completion (no departedAt in the patch) stamps completedAt.
{
  const wo = await workOrders.create({ type: "service_visit", lead: fakeLead });
  ok(wo.completedAt === null, "new WO starts with completedAt null");
  const done = await workOrders.update(wo.id, { status: "completed", __by: "admin" });
  ok(typeof done.completedAt === "string" && done.completedAt.length > 0, "admin completion stamps completedAt");
  const hist = done.history.find((h) => h.action === "status_change" && h.after === "completed");
  ok(hist && hist.ts === done.completedAt, "completedAt equals the status_change history ts");
  ok(done.departedAt === null, "server does not invent departedAt on admin completion");

  // 3. Preserve-if-set: later patches never move it.
  const before = done.completedAt;
  const patched = await workOrders.update(wo.id, { techNotes: "post-completion note" });
  ok(patched.completedAt === before, "completedAt survives later non-status patches");
}

// 2. completedAt is not client-patchable.
{
  const wo = await workOrders.create({ type: "service_visit", lead: fakeLead });
  const patched = await workOrders.update(wo.id, { completedAt: "2020-01-01T00:00:00.000Z" });
  ok(patched.completedAt === null, "client-supplied completedAt is ignored on a non-completed WO");
}

// 4. Tech-style completion (departedAt supplied by the client) keeps both.
{
  const wo = await workOrders.create({ type: "spring_opening", lead: fakeLead });
  const depTs = "2026-08-01T15:30:00.000Z";
  const done = await workOrders.update(wo.id, { status: "completed", departedAt: depTs });
  ok(done.departedAt === depTs, "tech-supplied departedAt stored unchanged");
  ok(typeof done.completedAt === "string", "tech completion also stamps completedAt");
}

// 5. hydrate() — legacy record with no completedAt key reads back null.
{
  const raw = JSON.parse(fs.readFileSync(WO_JSON, "utf8"));
  raw.push({ id: "WO-LEGACY1", type: "service_visit", status: "completed", history: [] });
  fs.writeFileSync(WO_JSON, JSON.stringify(raw, null, 2) + "\n", "utf8");
  const legacy = await workOrders.get("WO-LEGACY1");
  ok(legacy.completedAt === null, "legacy record hydrates completedAt to null");
  // 6b. Warranty refuses a completed WO with no completion date.
  const w = warranty.warrantyForWorkOrder(legacy);
  ok(w.ok === false && w.reason === "no_completion_date", "warranty refuses completed WO without completedAt");
}

// 6. Warranty policy table + arithmetic.
{
  const base = { status: "completed", completedAt: "2026-06-15T12:00:00.000Z" };
  const build = warranty.warrantyForWorkOrder({ ...base, type: "build" });
  ok(build.ok && build.months === 36 && build.expiresAt === "2029-06-15T12:00:00.000Z", "build → 3 years");
  for (const t of ["service_visit", "spring_opening", "fall_closing"]) {
    const r = warranty.warrantyForWorkOrder({ ...base, type: t });
    ok(r.ok && r.months === 12 && r.expiresAt === "2027-06-15T12:00:00.000Z", `${t} → 1 year`);
  }
  const unknownType = warranty.warrantyForWorkOrder({ ...base, type: "mystery" });
  ok(unknownType.ok && unknownType.months === 12, "unknown type falls back to 1 year, never throws");
  const notDone = warranty.warrantyForWorkOrder({ status: "scheduled", type: "build" });
  ok(notDone.ok === false && notDone.reason === "not_completed", "warranty refuses non-completed WO");
  ok(warranty.WARRANTY_MONTHS.install === 36, "project-cascade install key preserved at 36");
}

// ---- Sandbox B: the backfill script ----------------------------------
{
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-wo-backfill-"));
  fs.mkdirSync(path.join(SB, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(SB, "server", "data"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "scripts", "backfill-wo-completedat.js"), path.join(SB, "scripts", "backfill-wo-completedat.js"));
  const seed = [
    { id: "WO-AAA11111", type: "service_visit", status: "completed", completedAt: null, techNotes: "keep me",
      history: [
        { ts: "2026-06-03T10:00:00.000Z", action: "status_change", before: "on_site", after: "completed" },
        { ts: "2026-06-04T09:00:00.000Z", action: "status_change", before: "on_site", after: "completed" }
      ] },
    { id: "WO-BBB22222", type: "spring_opening", status: "completed", completedAt: "2026-07-01T08:00:00.000Z", history: [] },
    { id: "WO-CCC33333", type: "service_visit", status: "completed", history: [] },
    { id: "WO-DDD44444", type: "fall_closing", status: "scheduled", history: [] }
  ];
  const seedJson = JSON.stringify(seed, null, 2) + "\n";
  const dataFile = path.join(SB, "server", "data", "work-orders.json");
  fs.writeFileSync(dataFile, seedJson, "utf8");

  // Dry run: prints the plan, writes nothing.
  const dry = execFileSync("node", [path.join(SB, "scripts", "backfill-wo-completedat.js")], { encoding: "utf8" });
  ok(fs.readFileSync(dataFile, "utf8") === seedJson, "dry run writes nothing");
  ok(dry.includes("WO-AAA11111") && dry.includes("null -> 2026-06-03T10:00:00.000Z"), "dry run lists the earliest-ts backfill");
  ok(dry.includes("WO-CCC33333") && dry.includes("UNRECOVERABLE"), "dry run flags unrecoverable record");

  // Apply: backup first, then promote — earliest ts, nothing else changed.
  const applied = execFileSync("node", [path.join(SB, "scripts", "backfill-wo-completedat.js"), "--apply"], { encoding: "utf8" });
  const backupDirs = fs.readdirSync(path.join(SB, "server")).filter((d) => d.startsWith("data-backup-") && d.endsWith("-wo-completedat"));
  ok(backupDirs.length === 1, "apply creates exactly one backup dir");
  ok(backupDirs.length === 1 && fs.readFileSync(path.join(SB, "server", backupDirs[0], "work-orders.json"), "utf8") === seedJson, "backup is byte-identical to the pre-write file");
  const after = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const a = after.find((w) => w.id === "WO-AAA11111");
  ok(a.completedAt === "2026-06-03T10:00:00.000Z", "apply writes the EARLIEST completion ts");
  ok(a.techNotes === "keep me" && a.history.length === 2, "apply changes nothing else on the record");
  ok(after.find((w) => w.id === "WO-BBB22222").completedAt === "2026-07-01T08:00:00.000Z", "already-stamped record untouched");
  ok(!("completedAt" in after.find((w) => w.id === "WO-CCC33333")), "unrecoverable record left untouched");
  ok(!("completedAt" in after.find((w) => w.id === "WO-DDD44444")), "non-completed record left untouched");
  ok(applied.includes("Backup written:"), "apply reports the backup path");
  fs.rmSync(SB, { recursive: true, force: true });
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\nwo-completedat: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
