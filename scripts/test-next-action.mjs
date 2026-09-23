#!/usr/bin/env node
// scripts/test-next-action.mjs
//
// "What do I need to do next?" — the Next action card on the rebuilt
// project overview, against the six situations Patrick named:
//
//   1. A brand-new project without a design
//   2. McDonald's Dundalk: accepted, paid, 0 of 16 tasks
//   3. An accepted project without an installation date
//   4. A scheduled project with partially completed tasks
//   5. A completed project with money outstanding
//   6. A completed and fully paid project
//
// admin-app/src/lib/nextAction.ts is pure logic over records the server
// already returns — no DOM, no fetch — so this runs it directly under
// Node's type stripping rather than through a browser. The browser-level
// integration is covered separately by test-app-shell-rebuild.mjs.
//
// Run: npm run test:next-action
//
// NOT in build:check, deliberately: type stripping needs Node 22+ and CI
// pins Node 20, so putting it in the gate would fail there for a reason
// that has nothing to do with the code under test. The same logic is
// also exercised end-to-end through the real built bundle by
// test-app-shell-rebuild.mjs; this file is the fast, precise version.

import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { nextAction } = await import(path.join(ROOT, "admin-app", "src", "lib", "nextAction.ts"));

let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.error("  FAIL " + name + (detail ? ` — ${detail}` : "")); }
}

// Dundalk's real shape: 12 programmed outputs across 16 physical valves,
// drawn from 19 traced areas. Three different numbers on purpose.
const design = { stationCount: 12, valveCount: 16, areaCount: 19, lastSavedAt: "2026-09-19T14:00:00Z" };
const acceptedQuote = { id: "Q-2026-0088", version: 5, status: "accepted", total: 24680.33 };
const snapshot = { quoteId: "Q-2026-0088", version: 5, total: 24680.33, acceptedAt: "2026-09-20T15:00:00Z" };
const tasks = (done, total) =>
  Array.from({ length: total }, (_, i) => ({ id: `t${i}`, status: i < done ? "done" : "pending" }));

// ── 1. brand-new, nothing designed ──────────────────────────────────
{
  const a = nextAction({ id: "P1", status: "planning", tasks: [] }, null, null, null);
  check("1. brand-new project is sent to the design", /start the system design/i.test(a.headline), a.headline);
  check("1. it says why", /no zones/i.test(a.detail), a.detail);
  check("1. it is an action, not a wait", a.tone === "act", a.tone);
}

// ── 2. McDonald's Dundalk: sold, deposit paid, no work started ──────
// The deposit being settled must NOT read as "nothing outstanding" —
// the job hasn't been built yet. With no visit booked, the next move is
// still to get a date in the calendar.
{
  const a = nextAction(
    { id: "P2", status: "active", tasks: tasks(0, 16), proposalSnapshot: snapshot, workOrderIds: [] },
    acceptedQuote,
    { id: "I-2026-0067", status: "paid", invoiceRole: "deposit", total: 9872.13, amountPaid: 9872.13, balanceDue: 0, paidAt: "2026-09-20T16:00:00Z" },
    design
  );
  check("2. a paid deposit does not read as 'nothing outstanding'", !/nothing outstanding/i.test(a.headline), a.headline);
  check("2. sold + paid deposit + no visit booked -> schedule it", /schedule installation/i.test(a.headline), a.headline);
  check("2. the detail names the missing date", /no installation date/i.test(a.detail), a.detail);
  check("2. sixteen tasks are still counted as outstanding", /16 tasks remaining/i.test(a.detail), a.detail);
  check("2. it is an action", a.tone === "act", a.tone);
}

// ── 3. accepted, no installation date ───────────────────────────────
{
  const a = nextAction(
    { id: "P3", status: "active", tasks: tasks(0, 16), proposalSnapshot: snapshot, workOrderIds: [] },
    acceptedQuote, null, design
  );
  check("3. accepted with no date -> schedule installation", /schedule installation/i.test(a.headline), a.headline);
  check("3. it points at the schedule", a.href === "/admin/schedule", String(a.href));
}

// ── 4. scheduled, partly done ───────────────────────────────────────
{
  const a = nextAction(
    { id: "P4", status: "active", tasks: tasks(7, 16), proposalSnapshot: snapshot, workOrderIds: ["WO-1", "WO-2"] },
    acceptedQuote, null, design
  );
  check("4. booked and part-done -> finish the install", /finish the install/i.test(a.headline), a.headline);
  check("4. it counts what is left, not what is done", /9 of 16 tasks/i.test(a.detail), a.detail);
  check("4. it names the visits", /2 visits/i.test(a.detail), a.detail);
}

// ── 5. complete, money outstanding ──────────────────────────────────
// Money owed outranks everything: it is the only thing left that costs
// something to forget.
{
  const a = nextAction(
    { id: "P5", status: "complete", tasks: tasks(16, 16), proposalSnapshot: snapshot, workOrderIds: ["WO-1"] },
    acceptedQuote,
    { id: "I-2026-0090", status: "sent", invoiceRole: "balance", total: 24680.33, amountPaid: 9872.13, balanceDue: 14808.2, paidAt: null },
    design
  );
  check("5. complete with a balance -> collect payment", /collect payment/i.test(a.headline), a.headline);
  check("5. the amount owed is named", /\$14,808\.20/.test(a.detail), a.detail);
  check("5. the invoice is named", /I-2026-0090/.test(a.detail), a.detail);
  check("5. a sent invoice is waiting on the customer, not on Patrick", a.tone === "waiting", a.tone);
  check("5. it opens the invoice", String(a.href).includes("/admin/invoice/"), String(a.href));
}

// A balance still sitting in draft IS Patrick's move — it hasn't been
// sent yet, so nobody is waiting on the customer.
{
  const a = nextAction(
    { id: "P5b", status: "complete", tasks: tasks(16, 16), proposalSnapshot: snapshot, workOrderIds: ["WO-1"] },
    acceptedQuote,
    { id: "I-2026-0091", status: "draft", invoiceRole: "balance", total: 24680.33, amountPaid: 0, balanceDue: 24680.33, paidAt: null },
    design
  );
  check("5b. an unsent invoice is Patrick's action, not a wait", a.tone === "act", a.tone);
  check("5b. it says the invoice hasn't gone out", /not sent yet/i.test(a.detail), a.detail);
}

// ── 6. complete and fully paid ──────────────────────────────────────
{
  const a = nextAction(
    { id: "P6", status: "complete", tasks: tasks(16, 16), proposalSnapshot: snapshot, workOrderIds: ["WO-1"] },
    acceptedQuote,
    { id: "I-2026-0090", status: "paid", invoiceRole: "balance", total: 24680.33, amountPaid: 24680.33, balanceDue: 0, paidAt: "2026-09-25T10:00:00Z" },
    design
  );
  check("6. complete and paid -> done", a.tone === "done", `${a.tone} / ${a.headline}`);
  check("6. it says so plainly", /complete/i.test(a.headline), a.headline);
  check("6. no action is offered on a finished job", !a.href, String(a.href));
}

// ── the sold-job regression (PR #286) ───────────────────────────────
// A revision raised after acceptance puts the linked quote back to
// draft. Reading only that status told a crew mid-install to go and
// "send the proposal" on a job they were already building.
{
  const a = nextAction(
    { id: "P7", status: "active", tasks: tasks(3, 16), proposalSnapshot: snapshot, workOrderIds: ["WO-1"] },
    { id: "Q-2026-0088-r2", version: 6, status: "draft", total: 25900 },
    null,
    design
  );
  check("sold job with a draft revision is never told to send the proposal", !/send the proposal/i.test(a.headline), a.headline);
  check("sold job with a draft revision keeps building", /finish the install/i.test(a.headline), a.headline);
}

console.log(`\nnext action: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
