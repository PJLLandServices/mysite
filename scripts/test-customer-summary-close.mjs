#!/usr/bin/env node
// scripts/test-customer-summary-close.mjs
//
// "PJL Field could not start — TypeError: Cannot read property 'source' of
// null … at CustomerSummary" (Patrick's phone, 2026-10-01, minutes after the
// PJL-106 update). Opening the summary and tapping Done cleared the summary
// but left the state 'ready'; iOS keeps drawing a Modal's children while it
// slides away, so the 'ready' branch rendered with no summary and read
// `s.source` of null — and the error took the whole app down.
//
// This drives the REAL CustomerSummary.js (compiled with the app's own Babel)
// through a minimal hooks runtime: open → load → ready → Done, rendering at
// every step the way iOS does during the dismiss animation (children drawn
// even with visible=false). It must never throw.
//
// Run: node scripts/test-customer-summary-close.mjs   (also in build:check)

import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../pjl-field/package.json", import.meta.url));
const babel = require("@babel/core");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const file = new URL("../pjl-field/src/screens/CustomerSummary.js", import.meta.url);
const { code } = babel.transformSync(fs.readFileSync(file, "utf8"), {
  filename: file.pathname, babelrc: false, configFile: false,
  plugins: [
    [require.resolve("@babel/plugin-transform-react-jsx"), { runtime: "classic" }],
    require.resolve("@babel/plugin-transform-modules-commonjs"),
  ],
});

// ---- a one-component hooks runtime ---------------------------------------
const slots = []; let cursor = 0; let effects = []; let dirty = false;
const hooks = {
  useState(init) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { v: typeof init === "function" ? init() : init };
    return [slots[i].v, (next) => { slots[i].v = typeof next === "function" ? next(slots[i].v) : next; dirty = true; }];
  },
  useCallback(fn, deps) {
    const i = cursor++;
    if (!(i in slots) || !same(slots[i].deps, deps)) slots[i] = { v: fn, deps };
    return slots[i].v;
  },
  useEffect(fn, deps) {
    const i = cursor++;
    if (!(i in slots) || !same(slots[i].deps, deps)) { slots[i] = { deps }; effects.push(fn); }
  },
};
const same = (a, b) => a && b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
const React = { createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }), Fragment: "Fragment" };

let summaryReply = null;
const mod = { exports: {} };
const fakeRequire = (name) => {
  if (name === "react") return { ...hooks, default: React, __esModule: true };
  if (name === "react-native") {
    const host = (n) => n;
    return { ActivityIndicator: host("ActivityIndicator"), Modal: host("Modal"), Pressable: host("Pressable"), ScrollView: host("ScrollView"), Text: host("Text"), View: host("View"), StyleSheet: { create: (s) => s, hairlineWidth: 1 } };
  }
  if (name === "../api") return { AuthRequiredError: class extends Error {}, getCustomerSummary: async () => summaryReply };
  if (name === "../format") return { money: (n) => (n == null ? null : `$${Number(n).toFixed(2)}`) };
  if (name === "../theme") return { colors: new Proxy({}, { get: () => "#000" }), radius: { card: 12, pill: 999 }, space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 }, type: new Proxy({}, { get: () => ({}) }) };
  throw new Error(`unexpected import ${name}`);
};
vm.runInNewContext(code, { module: mod, exports: mod.exports, require: fakeRequire, React, console });
const CustomerSummary = mod.exports.default;

// Render the way iOS does: the Modal's children are drawn whatever `visible`
// says (they stay on screen through the dismiss animation). Walk the tree so
// every expression in it is evaluated.
function walk(node) {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach(walk);
  if (typeof node.type === "function") return walk(node.type(node.props));
  walk(node.props?.children);
}
async function render(props) {
  for (let pass = 0; pass < 10; pass += 1) {
    cursor = 0; dirty = false; effects = [];
    walk(CustomerSummary(props));
    const run = effects; effects = [];
    for (const fn of run) fn();
    await new Promise((r) => setTimeout(r, 5));
    if (!dirty) return;
  }
}
const attempt = async (label, props) => {
  try { await render(props); ok(true, label); }
  catch (err) { ok(false, `${label} — threw: ${err.message}`); }
};

summaryReply = {
  source: "preview", invoiceId: null, serviceLabel: "Fall Closing", customerName: "Debra Calandra",
  address: "111 Tanners Dr, Acton", visitDate: null, pricePending: false, amountPaid: 0,
  zones: [{ number: 1, location: "Front", statusLabel: "Checked — working", repairs: [] }],
  lines: [{ label: "Fall closing", qty: 1, unitPrice: 1, lineTotal: 1 }], subtotal: 1, hst: 0.13, total: 1.13,
  authorization: "By signing…",
};
const props = { workOrderId: "WO-1", onClose: () => {} };

await attempt("closed before ever opening", { ...props, visible: false });
await attempt("open: loads and shows the summary", { ...props, visible: true });
ok(slots.some((s) => s && s.v === "ready"), "…reached the ready state");
await attempt("Done: the sheet closes without throwing (iOS still drawing it)", { ...props, visible: false });
await attempt("open again", { ...props, visible: true });
await attempt("Done again", { ...props, visible: false });
summaryReply = null;
await attempt("an empty reply shows the error state, not a crash", { ...props, visible: true });

console.log(`\ncustomer summary close: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
