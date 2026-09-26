#!/usr/bin/env node
// scripts/test-field-reopen-finished.mjs
//
// Reopening a FINISHED fall closing lands on its invoice, not the legacy
// web work-order page.
//
// WHY. Patrick, live app, 2026-09-24: reopening a closing that had been
// finished dropped him into the old W/O web layout. jobForWorkOrder()
// sends every terminal work order to /admin/work-order/:id/tech — right
// for keeping a finished visit out of the editable closing flow (the
// server refuses edits on a locked WO), but it meant the only native
// screen a finished closing has, InvoiceScreen, was reachable solely from
// the Finish button in the moment, never again from the day.
//
// The rule, in one place (pjl-field/src/workorder-routing.js):
//   - a COMPLETED fall_closing with an invoice that still counts (any
//     status but void — the same test as the server's
//     activeInvoiceForWorkOrder) opens that invoice;
//   - no such invoice, or the lookup fails (no signal), falls back to the
//     web record exactly as before — never a dead end;
//   - cancelled / no_show have no invoice to show and are not looked up;
//   - a live closing still opens the native closing flow, untouched.
//
// Deliberately left alone: a no-charge closing has no invoice, so it still
// reopens to the web record. Telling it apart from a failed invoice draft
// needs a server field the app does not get today.
//
// Run: node scripts/test-field-reopen-finished.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const APP = read("pjl-field/App.js");
const API = read("pjl-field/src/api.js");
const SERVER = read("server/server.js");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

// Lift an exported (possibly async) function out of App.js and run it.
function lift(source, name, deps = "") {
  let start = source.indexOf(`export async function ${name}(`);
  if (start < 0) start = source.indexOf(`export function ${name}(`);
  if (start < 0) return null;
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end + 3).replace(/^export /, "");
  return new Function(`${deps}\n${body}\nreturn ${name};`)();
}

const routing = await import(pathToFileURL(path.join(ROOT, "pjl-field/src/workorder-routing.js")).href);
const { activeInvoiceFor, reopensToInvoice } = routing;

// ---- the rule ------------------------------------------------------------
ok(typeof activeInvoiceFor === "function", "workorder-routing exports activeInvoiceFor");
ok(typeof reopensToInvoice === "function", "workorder-routing exports reopensToInvoice");

if (typeof activeInvoiceFor === "function") {
  const list = [
    { id: "INV-new-void", woId: "WO-1", status: "void" },
    { id: "INV-sent", woId: "WO-1", status: "sent" },
    { id: "INV-other", woId: "WO-2", status: "draft" },
  ];
  ok(activeInvoiceFor(list, "WO-1")?.id === "INV-sent", "a void invoice is skipped for the live one behind it");
  ok(activeInvoiceFor(list, "WO-3") === null, "another work order's invoice is never picked");
  ok(activeInvoiceFor([{ id: "I", woId: "WO-1", status: "void" }], "WO-1") === null, "only void → none");
  for (const status of ["draft", "sent", "partially_paid", "paid"]) {
    ok(activeInvoiceFor([{ id: "I", woId: "WO-1", status }], "WO-1")?.id === "I", `a ${status} invoice counts`);
  }
  ok(activeInvoiceFor(null, "WO-1") === null && activeInvoiceFor(list, "") === null, "junk in, null out");
}
if (typeof reopensToInvoice === "function") {
  ok(reopensToInvoice({ id: "W", type: "fall_closing", status: "completed" }) === true, "a completed closing looks for its invoice");
  for (const status of ["cancelled", "no_show", "scheduled", "in_progress", undefined]) {
    ok(reopensToInvoice({ id: "W", type: "fall_closing", status }) === false, `a ${status} closing does not`);
  }
  ok(reopensToInvoice({ id: "W", type: "service_visit", status: "completed" }) === false, "other work-order types are unchanged");
}

// ---- the shell uses it ---------------------------------------------------
const deps = `
  const JOB = { CLOSING: 'closing', WEB: 'web', INVOICE: 'invoice' };
  const TERMINAL_WO = new Set(['completed', 'cancelled', 'no_show']);
  const activeInvoiceFor = ${activeInvoiceFor};
  const reopensToInvoice = ${reopensToInvoice};
  ${(() => { const s = APP.indexOf("export function jobForWorkOrder("); return APP.slice(s, APP.indexOf("\n}\n", s) + 3).replace("export ", ""); })()}
`;
const jobForOpening = typeof activeInvoiceFor === "function" ? lift(APP, "jobForOpening", deps) : null;
ok(typeof jobForOpening === "function", "App.js exports jobForOpening(workOrder, listInvoices)");

if (typeof jobForOpening === "function") {
  const web = (id) => ({ kind: "web", url: `/admin/work-order/${id}/tech`, title: "Work order" });
  let calls = 0;
  const lister = (rows) => async (woId) => { calls += 1; return rows.map((r) => ({ woId, ...r })); };

  const done = { id: "WO-1", type: "fall_closing", status: "completed" };
  let job = await jobForOpening(done, lister([{ id: "INV-void", status: "void" }, { id: "INV-1", status: "sent" }]));
  ok(JSON.stringify(job) === JSON.stringify({ kind: "invoice", invoiceId: "INV-1" }), `a finished closing opens its invoice (got ${JSON.stringify(job)})`);

  job = await jobForOpening(done, lister([{ id: "INV-void", status: "void" }]));
  ok(JSON.stringify(job) === JSON.stringify(web("WO-1")), "no live invoice → the web record, as before");

  job = await jobForOpening(done, async () => { throw new Error("offline"); });
  ok(JSON.stringify(job) === JSON.stringify(web("WO-1")), "a failed lookup (no signal) → the web record, never a dead end");

  job = await jobForOpening(done, async () => [{ id: "INV-x", woId: "WO-OTHER", status: "sent" }]);
  ok(JSON.stringify(job) === JSON.stringify(web("WO-1")), "an invoice for a different work order is not opened");

  calls = 0;
  for (const status of ["cancelled", "no_show"]) {
    job = await jobForOpening({ id: "WO-2", type: "fall_closing", status }, lister([{ id: "I", status: "sent" }]));
    ok(job?.kind === "web", `a ${status} closing still opens the web record`);
  }
  job = await jobForOpening({ id: "WO-3", type: "fall_closing", status: "in_progress" }, lister([{ id: "I", status: "sent" }]));
  ok(JSON.stringify(job) === JSON.stringify({ kind: "closing", workOrderId: "WO-3" }), "a live closing still opens the closing flow");
  job = await jobForOpening({ id: "WO-4", type: "service_visit", status: "completed" }, lister([{ id: "I", status: "sent" }]));
  ok(job?.kind === "web", "a completed service visit is unchanged");
  ok(calls === 0, `nothing but a completed closing asks the server for invoices (${calls} calls)`);
  ok(await jobForOpening(null, lister([])) === null, "nothing to open is still not a job");
}

// ---- wiring --------------------------------------------------------------
const open = APP.slice(APP.indexOf("const openWorkOrder = useCallback("), APP.indexOf("const closeJob = useCallback("));
ok(/jobForOpening\(workOrder, listWorkOrderInvoices\)/.test(open), "the shell's openWorkOrder routes through jobForOpening with the real lookup");
ok(/opening\.current/.test(open), "a slow lookup cannot open over a later tap");
ok(/export const listWorkOrderInvoices = \(woId\) =>\s*\n?\s*getJson\(`\/api\/invoices\?woId=\$\{encodeURIComponent\(woId\)\}`\)/.test(API),
  "api.listWorkOrderInvoices asks /api/invoices?woId=");
ok(/const woId = url\.searchParams\.get\("woId"\);[\s\S]{0,900}if \(woId\) all = all\.filter\(\(i\) => i\.woId === woId\);/.test(SERVER),
  "the server's GET /api/invoices filters by woId (what the lookup relies on)");

console.log(`field-reopen-finished: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
