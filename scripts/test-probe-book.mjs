// Booking from the probe — inline on the Season Plan, like the phone.
//
//   node scripts/test-probe-book.mjs
//
// WHAT THIS PROTECTS. Patrick, 2026-09-20, on the first cut (a link to
// the Schedule page's modal): "that doesn't do anything special but go
// to the book day." Right — a handoff is navigation, not booking. The
// probe now books IN PLACE: each offered day carries a Book button that
// opens an inline form — that day's real slots, an existing-customer
// search, contact fields — and books through the same hold → reserve
// path as the app and the public page, so slot re-validation, the
// customer record and the automatic email+text confirmation are
// identical. The Schedule page's ?book= handoff stays for anywhere else
// that wants it.
//
// These are source guards: the flow is browser DOM code, so what a
// refactor can silently break is the contract with the server — the
// endpoints, the hold-before-reserve order, and the payload fields the
// reserve route actually reads.
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

// ---- The inline booking ----------------------------------------------
const book = plan.slice(plan.indexOf("async function openProbeBook"));
ok("the probe renders a per-day Book button, gated on the day being offered",
  plan.includes("if (day.offered) {") && plan.includes("openProbeBook(bookHost"));
ok("the inline form exists", plan.includes("async function openProbeBook"));

// The server contract, in order: availability (this one day, admin
// bypass past the gate) → hold → reserve carrying the hold's token.
ok("slots come from the availability engine for exactly the probed day",
  book.includes("/api/booking/availability")
  && book.includes("&from=${encodeURIComponent(day.date)}&to=${encodeURIComponent(day.date)}")
  && book.includes("adminBypass=1"));
const holdAt = book.indexOf('"/api/booking/hold"');
const reserveAt = book.indexOf("reserveBooking({");
ok("the hold is taken before the reserve — two callers can't finish on one slot",
  holdAt !== -1 && reserveAt !== -1 && holdAt < reserveAt, `holdAt=${holdAt} reserveAt=${reserveAt}`);
ok("the reserve carries the hold's token", book.includes("holdToken: hold.holdToken"));
ok("the form books through the page's ONE reserve write (test-place-tray pins the URL to one call site)",
  (plan.match(/\/api\/booking\/reserve/g) || []).length === 1);

// The payload fields the reserve route reads. contact.name is what
// validateLead checks — the split fields alone fail server-side.
ok("the reserve books a grid slot, not a custom time", book.includes('source: "slot"'));
ok("contact.name is the combined name validateLead reads",
  /name: `\$\{firstName\.value\.trim\(\)\} \$\{lastName\.value\.trim\(\)\}`\.trim\(\)/.test(book));
ok("the probed address is the booking's address", book.includes("address,") || book.includes("address\n"));

// The aftermath: the board refreshes (the day just gained a booking),
// and a failed attempt reloads the slots (the slot is the usual reason).
const successAt = book.indexOf("Confirmation email + text");
ok("success says the confirmation went out and refreshes the board",
  successAt !== -1 && book.slice(successAt, successAt + 400).includes("load()"));
ok("a failed booking re-reads the slots instead of trusting the stale list",
  book.slice(book.indexOf("catch (error)", reserveAt)).includes("loadSlots()"));

// ---- The schedule handoff stays for other callers ---------------------
ok("schedule.js still honors ?book= for any page that links it",
  sched.includes('get("book")') && sched.includes("bookingAddress.value = bookParam"));

if (failures.length) {
  console.error(`FAIL test-probe-book: ${failures.length} failing`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`ok test-probe-book — ${pass} assertions`);
