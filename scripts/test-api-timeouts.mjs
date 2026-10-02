#!/usr/bin/env node
// scripts/test-api-timeouts.mjs
//
// No field-app call waits forever on a driveway's signal (PJL-100 #3).
//
// Fix #4 put timeouts on completeWorkOrder, deferIssues and
// signatureBypass. But Finish's FIRST call is getWorkOrder (the re-read
// that decides where Finish picks up), and it goes through getJson, which
// had no timeout — a stalled connection hung Finish before any of the
// timed calls ran, bounded only by the phone's network stack.
//
// Executes the shipped pjl-field/src/api.js in a vm with a fetch that
// never answers (and a clock that fires timers at once), so a call that
// has a timeout fails fast and one that does not hangs:
//   A. getWorkOrder / getJson-backed reads give up with the app's
//      TimeoutError — never AuthRequiredError (that would say "sign in")
//   B. the Finish calls that already had timeouts still do
//   C. a normal answer still comes back (the wrapper changes nothing else)
//
// Run: node scripts/test-api-timeouts.mjs   (also in build:check)

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const src = fs.readFileSync(path.join(ROOT, "pjl-field/src/api.js"), "utf8")
  .replace(/^import .*;\r?\n/gm, "")
  .replace(/\bexport (async function|function|const|class|let)/g, "$1");

function load(fetchImpl) {
  const context = {
    fetch: fetchImpl, AbortController, URL, URLSearchParams, JSON, Promise, Error, TypeError, console,
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(src + "\n;globalThis.__api = { getWorkOrder, getInvoice, listProperties, completeWorkOrder, deferIssues, signatureBypass, AuthRequiredError, TimeoutError };", context);
  return context.__api;
}
// A connection that never answers — until aborted.
const hanging = (url, opts = {}) => new Promise((resolve, reject) => {
  opts.signal?.addEventListener?.("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
});
const race = (p) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), sleep(1500).then(() => ({ hung: true }))]);

{
  const api = load(hanging);
  for (const [name, call] of [
    ["getWorkOrder", () => api.getWorkOrder("WO-1")],
    ["getInvoice", () => api.getInvoice("I-1")],
    ["listProperties", () => api.listProperties()]
  ]) {
    const r = await race(call());
    ok(!r.hung, `A. ${name} gives up on a stalled connection instead of waiting`);
    ok(r.e instanceof api.TimeoutError && !(r.e instanceof api.AuthRequiredError),
      `A. ${name}: a stall is a TimeoutError, never "signed out" (got ${r.hung ? "hung" : r.e ? r.e.constructor?.name : "a value"})`);
  }
  for (const [name, call] of [
    ["completeWorkOrder", () => api.completeWorkOrder("WO-1", {})],
    ["deferIssues", () => api.deferIssues("WO-1")],
    ["signatureBypass", () => api.signatureBypass("WO-1", { reason: "customer_not_home", note: "" })]
  ]) {
    const r = await race(call());
    ok(!r.hung && r.e instanceof api.TimeoutError, `B. ${name} still times out`);
  }
}
{
  const api = load(async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ ok: true, workOrder: { id: "WO-1", status: "on_site" }, property: null, lead: null }) }));
  const r = await race(api.getWorkOrder("WO-1"));
  ok(r.v && r.v.id === "WO-1" && r.v.status === "on_site", "C. a normal answer still comes back");
}
{
  const api = load(async () => ({ status: 401, ok: false, text: async () => "{}" }));
  const r = await race(api.getWorkOrder("WO-1"));
  ok(r.e instanceof api.AuthRequiredError, "C. a 401 still means signed out");
}

console.log(`\napi-timeouts: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
