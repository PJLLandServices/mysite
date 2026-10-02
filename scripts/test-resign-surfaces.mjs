#!/usr/bin/env node
// scripts/test-resign-surfaces.mjs
//
// Re-signing after a priced-scope change (Patrick, 2026-09-26): the places
// a person sees it. The server rule and its gates are pinned by
// test-resign-scope.mjs. This pins that each surface asks for the NEW
// signature instead of treating the old one as final:
//
//   A. the web sign-off (work-order-tech.js): renderSignoff shows the form
//      and the "New signature needed" notice when the server says one is
//      owed, even with a signature or bypass on file (run here with a stub
//      DOM); otherwise the signed / bypassed card as before
//   B. the phone (pjl-field): Finish sends the customer's new signature,
//      or a new bypass, when resignature.required, and the sign-off stage
//      says why
//   C. the office work-order page: a banner while it is owed, and the
//      re-lock prompt says the price freezes now and the customer still signs
//   D. the tech page's cache version is bumped with the page (tech-sw.js)
//
// Run: node scripts/test-resign-surfaces.mjs   (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
function lift(src, name) {
  const at = src.indexOf(`function ${name}(`);
  return at < 0 ? "" : src.slice(at, src.indexOf("\n}\n", at) + 3);
}

// ---- A. the web sign-off, run -----------------------------------------------
{
  const TECH = read("server/work-order-tech.js");
  const HTML = read("server/work-order-tech.html");
  ok(/id="techResignNotice"[^>]*hidden/.test(HTML), "A. the sign-off has a hidden \"New signature needed\" notice");
  const body = ["awaitsNewSignature", "renderSignoff"].map((n) => lift(TECH, n)).join("\n");
  ok(body.includes("function renderSignoff("), "A. renderSignoff found");
  const run = (state) => {
    const els = {};
    const el = (id) => (els[id] ||= { id, hidden: true, textContent: "", src: "" });
    const document = { getElementById: (id) => el(id) };
    const fn = new Function("state", "document", "createSignaturePad", "updateSignoffSubmitState", "formatDateTime", "bypassReasonLabel", "formatMoney",
      `${body}\nrenderSignoff();`);
    // The markup starts with the form showing and the cards hidden.
    el("techSignoffForm").hidden = false;
    el("techResignNotice").hidden = true;
    fn(state, document, () => ({ isDirty: () => false }), () => {}, (v) => String(v), (v) => String(v), (v) => String(v));
    return els;
  };
  const signed = { signature: { signed: true, customerName: "Jane", imageData: "x", signedAt: "2026-09-26" }, signatureBypass: null };
  let els = run({ ...signed, resignature: null });
  ok(els.techSignoffForm.hidden === true && els.techSignoffSigned.hidden === false, "A. a signed WO shows the signed card, as before");
  ok(els.techResignNotice.hidden === true, "A. …with no notice");
  els = run({ ...signed, resignature: { required: true } });
  ok(els.techSignoffForm.hidden === false && els.techSignoffSigned.hidden === true, "A. a new signature owed: the signing form comes back");
  ok(els.techResignNotice.hidden === false, "A. …with the \"New signature needed\" notice");
  els = run({ signature: null, signatureBypass: { reason: "customer_not_home", ts: "2026-09-26" }, resignature: { required: true } });
  ok(els.techSignoffForm.hidden === false && els.techResignNotice.hidden === false, "A. a bypass-accepted WO owing a new acceptance shows the form too");
  ok(/submit\.disabled = state\.locked === true && !awaitsNewSignature\(\)/.test(TECH), "A. the Sign button works on a re-locked WO that owes a signature");
  ok(/if \(state\.locked && !awaitsNewSignature\(\)\) return;/.test(lift(TECH, "openBypassSheet").replace(/\s+/g, " ")) || /!awaitsNewSignature\(\) && \(state\.locked/.test(lift(TECH, "openBypassSheet")),
    "A. the bypass sheet opens for a revised scope");
  ok(/state\.resignature = wo\.resignature \|\| null;/.test(TECH), "A. the page reads resignature from the work order");
}

// ---- B. the phone -------------------------------------------------------------
{
  const CLOSING = read("pjl-field/src/screens/ClosingScreen.js");
  const SIGNOFF = read("pjl-field/src/screens/closing/SignOffStage.js");
  ok(/signature: freshBeforeFinish\?\.signature\?\.signed && freshBeforeFinish\?\.resignature\?\.required !== true \? null : result\.signature/.test(CLOSING),
    "B. Finish sends the new signature when one is owed (not the 'already signed' shortcut)");
  ok(/if \(!current\.signatureBypass \|\| current\.resignature\?\.required === true\) await signatureBypass\(/.test(CLOSING),
    "B. …and a new bypass when nobody is home");
  ok(/wo\?\.resignature\?\.required === true \? \(/.test(SIGNOFF) && /New signature needed/.test(SIGNOFF), "B. the sign-off stage says a new signature is needed");
}

// ---- C. the office page ---------------------------------------------------------
{
  const PAGE = read("server/work-order.html");
  const JS = read("server/work-order.js");
  ok(/id="woResignBanner"[^>]*hidden/.test(PAGE), "C. the office page has a \"New customer signature needed\" banner");
  ok(/resignBanner\.hidden = wo\.resignature\?\.required !== true/.test(JS), "C. …shown exactly while one is owed");
  ok(/price is set and frozen now, and the customer still has to sign/.test(JS), "C. the re-lock prompt says the price freezes now and the customer still signs");
}

// ---- D. the tech page cache -------------------------------------------------------
{
  const SW = read("server/tech-sw.js");
  const TECH = read("server/work-order-tech.js");
  const v = (SW.match(/const CACHE_VERSION = "pjl-tech-v(\d+)"/) || [])[1];
  const b = (TECH.match(/const TECH_BUILD_VERSION = "tech-v(\d+)"/) || [])[1];
  ok(v && v === b && Number(v) >= 53, `D. the tech page cache is bumped with the page (sw v${v}, page v${b})`);
}

console.log(`resign-surfaces: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
