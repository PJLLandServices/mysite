// The fall closing's sign-off (2026-09-02).
//
//   node scripts/test-signoff-gates.mjs
//
// WHAT THIS PROTECTS. The server refuses to sign a work order until a
// fixed list of things are true, and it refuses with a 422 the tech can
// only read after the customer is already standing there. So the app has
// to know the same list, and the list has to be the SERVER'S — not a
// remembered copy that drifts.
//
// This suite reads computeServerSidePreSignFailures out of server.js and
// asserts two things about a fall closing specifically: which gates it
// must answer (payment and the return visit, which the app now asks as
// two buttons each), and which it satisfies or skips by its nature — the
// photo minimum is zero, materials auto-confirm because find-only work
// installs no parts, and the AI bonus only attaches to a work order
// raised from a quote that carries one.
//
// The bypass vocabulary is checked the same way: a reason the app can
// send that the server would reject is a refusal on a driveway.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const path = require("node:path");
const workOrders = require("../server/lib/work-orders.js");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", label); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const serverSrc = fs.readFileSync(path.join(process.cwd(), "server", "server.js"), "utf8");

// ---- 1. the gates the server actually enforces ------------------------
{
  const fn = serverSrc.slice(
    serverSrc.indexOf("function computeServerSidePreSignFailures"),
    serverSrc.indexOf("// Optimistic concurrency — If-Match check")
  );
  ok(fn.length > 0, "found the server's pre-sign check");

  const keys = [...new Set([...fn.matchAll(/key:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]))].sort();
  eq(keys.join(","), "bonus,customerNotes,materialsConfirm,payment,photos,returnVisit,zones",
    "the server's gate list is the seven the app was built against");

  // The two the app now asks outright. If either leaves this list the
  // app is asking a question nobody needs; if a new one arrives, the app
  // is missing a question and the tech meets it as a 422.
  ok(keys.includes("payment"), "payment is still gated — the app asks it as two buttons");
  ok(keys.includes("returnVisit"), "the return visit is still gated — likewise");
}

// ---- 2. what a fall closing does NOT have to answer -------------------
{
  // Photos: the minimum is zero for a closing. A winterized system often
  // has nothing left to photograph.
  eq(workOrders.PHOTO_REQUIREMENT_BY_TYPE.fall_closing, 0,
    "a fall closing needs no completion photo");
  ok(workOrders.PHOTO_REQUIREMENT_BY_TYPE.spring_opening > 0,
    "a spring opening still does — the app must not generalise from the closing");

  // Materials: hydrate() auto-confirms for fall_closing, so the gate is
  // met without the tech touching anything.
  const lib = fs.readFileSync(path.join(process.cwd(), "server", "lib", "work-orders.js"), "utf8");
  ok(/hydrated\.type === "fall_closing"/.test(lib),
    "materials auto-confirm for a fall closing — find-only work installs no parts");

  // The customer-facing note. Required on an opening or a service call,
  // where the work varies with what was found; not on a closing, whose
  // report is already the checklist plus the per-zone findings.
  eq(workOrders.CUSTOMER_NOTE_REQUIRED_BY_TYPE.fall_closing, false,
    "a fall closing does not demand a written narrative");
  eq(workOrders.CUSTOMER_NOTE_REQUIRED_BY_TYPE.spring_opening, true,
    "a spring opening still does — this is Patrick's distinction, not a blanket relaxation");
  eq(workOrders.CUSTOMER_NOTE_REQUIRED_BY_TYPE.service_visit, true,
    "so does a service call — the repair narrative is the reason for the visit");

  // An unknown type must stay REQUIRED. A new service mode should have to
  // opt out on purpose rather than lose the customer's narrative because
  // nobody added it to the map.
  eq(workOrders.CUSTOMER_NOTE_REQUIRED_BY_TYPE.some_future_service ?? true, true,
    "an unlisted type defaults to requiring the note");

  // FOUR copies of this rule now exist: the library, the server gate, tech
  // mode and the desk page. That is the shape the photo requirement already
  // has, and drift between copies is exactly how a tech gets blocked on a
  // surface nobody tested. Pin them together.
  {
    const canonical = workOrders.CUSTOMER_NOTE_REQUIRED_BY_TYPE;
    const sources = {
      "server.js": serverSrc,
      "work-order-tech.js": fs.readFileSync(path.join(process.cwd(), "server", "work-order-tech.js"), "utf8"),
      "work-order.js": fs.readFileSync(path.join(process.cwd(), "server", "work-order.js"), "utf8"),
    };
    for (const [name, src] of Object.entries(sources)) {
      // Find the map literal that carries fall_closing alongside a boolean.
      const m = src.match(/\{[^{}]*spring_opening:\s*(?:true|false)[^{}]*\}/);
      ok(!!m, `${name} carries a customer-note requirement map`);
      if (!m) continue;
      for (const [type, want] of Object.entries(canonical)) {
        const found = new RegExp(`${type}:\\s*(true|false)`).exec(m[0]);
        eq(found && found[1] === "true", want, `${name} agrees on ${type}`);
      }
    }
  }

  // And a closing never builds an on-site quote, so the app needs no
  // quote builder in this flow at all.
  ok(workOrders.canBuildOnSiteQuote({ type: "service_visit" }), "a service visit can quote on site");
  ok(!workOrders.canBuildOnSiteQuote({ type: "fall_closing" }), "a fall closing never does");
}

// ---- 3. the bypass reasons the app offers -----------------------------
{
  const reasons = workOrders.BYPASS_REASONS;
  ok(reasons instanceof Set, "the server keeps a closed set of bypass reasons");
  // Exactly what the app's three buttons send.
  for (const key of ["customer_not_home", "trusted_customer_verbal", "other"]) {
    ok(reasons.has(key), `the app can send "${key}"`);
  }
  ok(reasons.has("admin_override"),
    "admin_override exists but is the desk's, not the driveway's — the app does not offer it");
}

// ---- 4. signing is what freezes the scope -----------------------------
{
  const protectedFields = workOrders.SCOPE_PROTECTED_FIELDS;
  ok(Array.isArray(protectedFields) && protectedFields.length > 0, "scope-protected fields are listed");
  ok(protectedFields.includes("signature"),
    "the signature record itself is frozen — a signed document cannot be re-signed quietly");
  // These keep flowing after sign-off, which is what lets the invoice
  // screen do anything at all once the visit is complete.
  for (const open of ["status", "photos", "paidOnSite"]) {
    ok(!protectedFields.includes(open), `${open} is NOT frozen — the visit stays a live record`);
  }
}

console.log(`\nsignoff-gates: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
