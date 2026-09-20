// The probe → booking handoff: "probe an address" flows into booking it.
//
//   node scripts/test-probe-book.mjs
//
// WHAT THIS PROTECTS. Patrick, 2026-09-20: "we still can't book a
// customer from the 'probe an address' like we can on the mobile field
// app." The probe answered "which day" and stopped; booking meant
// re-typing the address into the Schedule page's +Book modal. The fix is
// a handoff, not a second booking form: the probe result links to
// /admin/schedule?book=<address>, and schedule.js opens its existing
// modal with the address in place and the existing-property typeahead
// seeded. One booking flow, reached from one more place — the reserve
// path's customer record, slot rules and automatic confirmation all
// come along for free.
//
// These are source guards on the wiring: the pieces live in two
// browser-side files, so what a refactor can silently break is the
// contract between them — the param name, the prefill, and the URL
// strip that keeps a refresh from re-opening the modal.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const plan = fs.readFileSync(path.join(ROOT, "server/season-plan.js"), "utf8");
const sched = fs.readFileSync(path.join(ROOT, "server/schedule.js"), "utf8");

// ---- The probe side --------------------------------------------------
ok("the probe result links to the Schedule page's book param",
  plan.includes("/admin/schedule?book="));
ok("the address is URL-encoded — a probed address always contains spaces and commas",
  /\/admin\/schedule\?book=\$\{encodeURIComponent\(/.test(plan));
ok("the handoff opens in a new tab so the plan stays put",
  plan.slice(plan.indexOf("/admin/schedule?book=") - 400, plan.indexOf("/admin/schedule?book=") + 400)
    .includes('"_blank"'));

// ---- The schedule side -----------------------------------------------
const handoff = sched.slice(sched.indexOf('get("book")') - 200);
ok("schedule.js reads the book param", sched.includes('get("book")'));
ok("…opens the booking dialog", handoff.includes("openBookingDialog()"));
ok("…prefills the address field", handoff.includes("bookingAddress.value = bookParam"));
ok("…seeds the existing-property typeahead so a known customer is one click away",
  handoff.includes("bookingPropertySearch.value = bookParam")
  && handoff.includes('dispatchEvent(new Event("input"))'));
ok("…and kicks the availability lookup", handoff.includes("scheduleAvailLookup()"));

// The strip must come BEFORE the modal work: a refresh mid-booking must
// land on the plain schedule page, never a surprise re-opened modal.
const stripAt = handoff.indexOf("history.replaceState");
const openAt = handoff.indexOf("openBookingDialog()");
ok("the URL is stripped before the modal opens",
  stripAt !== -1 && openAt !== -1 && stripAt < openAt,
  `stripAt=${stripAt} openAt=${openAt}`);

// The +Book button and the handoff share ONE open path — a second copy
// of the reset/load/show sequence is how the two drift.
ok("the button and the handoff share openBookingDialog",
  sched.includes('addBookingBtn?.addEventListener("click", openBookingDialog)'));

if (failures.length) {
  console.error(`FAIL test-probe-book: ${failures.length} failing`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`ok test-probe-book — ${pass} assertions`);
