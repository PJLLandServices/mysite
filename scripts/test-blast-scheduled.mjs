#!/usr/bin/env node
// scripts/test-blast-scheduled.mjs
//
// "Can we just do a scheduled send instead?" — Patrick, 2026-09-10, after
// the send window had closed on him twice in one day.
//
// THE PAIRING THAT FAILED. The blast is the one cadence step that waits
// for a human to press a button, and the button only works inside a
// nine-hour window. He pressed it at 7am and was refused; by the time the
// reason was found it was past close. Nothing about the SEND needs him
// present — the wording is approved and the recipients are assigned. What
// needs him is the DECISION.
//
// So arming is the decision, and the sweep that already dispatches steps
// 2–6 does the sending: it already runs every five minutes, already
// refuses outside the window, already honours the appointment-page
// interlock and the send lock. A scheduled blast is that same machinery
// asked one question earlier.
//
// THE PROPERTY THAT MATTERS MOST is that an armed blast fires ONCE. The
// sweep runs every five minutes; an arming that survived a half-failed
// send would message every customer again on the next tick. It is
// disarmed BEFORE the send, so the worst case is a send that must be
// re-armed — never a second copy in a customer's inbox.
//
// Run: node scripts/test-blast-scheduled.mjs  (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const LEDGER = path.join(DATA, "assignment-blasts.json");
const cadence = require(path.join(ROOT, "server", "lib", "assignment-cadence.js"));

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const j = (v, n = 180) => String(JSON.stringify(v) ?? "(nothing)").slice(0, n);
const at = (h, m = 0) => new Date(2026, 8, 11, h, m, 0);
const has = (k) => typeof cadence[k] === "function";

fs.mkdirSync(DATA, { recursive: true });
const backup = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER) : null;
const ledger = () => (fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8") || "{}") : {});

// One assignment booking, already messaged, so the send path runs to a
// real outcome without standing up a mail transport.
const booking = () => ({
  id: "BK-SCHED-PROBE", source: "assignment", status: "confirmed",
  assignment: {
    season: "fall", year: 2026, code: "P-001",
    outreach: { token: "t".repeat(24), steps: { "1": { at: "2026-09-10T13:00:00Z" } } }
  }
});
const deps = { listBookings: async () => [booking()] };

try {
  fs.rmSync(LEDGER, { force: true });
  ok("the scheduling API exists",
    has("armBlast") && has("disarmBlast") && has("armedBlastFor") && has("runArmedBlast"),
    ["armBlast", "disarmBlast", "armedBlastFor", "runArmedBlast"].filter((k) => !has(k)).join(", ") || "");

  if (has("armBlast")) {
    // ---- 1. Arming, and what it records ------------------------------
    ok("nothing is armed to begin with", (await cadence.armedBlastFor("fall", 2026)) === null);
    const armed = await cadence.armBlast("fall", 2026, { by: "patrick", now: at(20, 30) });
    ok("arming records who and when",
      armed?.by === "patrick" && !Number.isNaN(Date.parse(armed?.at || "")), j(armed));
    ok("…and it survives a read", (await cadence.armedBlastFor("fall", 2026))?.by === "patrick");
    ok("…and rides the status Patrick's screen already reads",
      (await cadence.status("fall", 2026, { deps }))?.armed?.by === "patrick");

    // ---- 2. It waits for the window ----------------------------------
    const early = await cadence.runArmedBlast("fall", 2026, { deps, now: at(7, 30), appointmentPageReady: true });
    ok("before the window opens it does not fire",
      early.armed === true && !early.fired && early.waiting === "send_window", j(early));
    ok("…and stays armed", (await cadence.armedBlastFor("fall", 2026))?.by === "patrick");

    const locked = await cadence.runArmedBlast("fall", 2026, { deps, now: at(10, 0), appointmentPageReady: false });
    ok("the appointment-page interlock still holds it",
      locked.waiting === "appointment_page" && !locked.fired, j(locked));
    ok("…and it is still armed", (await cadence.armedBlastFor("fall", 2026))?.by === "patrick");

    // ---- 3. The window opens ------------------------------------------
    const fired = await cadence.runArmedBlast("fall", 2026, { deps, now: at(9, 2), appointmentPageReady: true });
    ok("once the window opens it fires", fired.fired === true, j(fired));
    ok("…reporting what it did", fired.alreadyBlasted === 1, j(fired));
    ok("…recorded in the ledger as a send", ledger()["fall-2026"]?.last?.outcome === "sent",
      j(ledger()["fall-2026"]?.last));
    ok("…attributed to whoever scheduled it, marked scheduled",
      /patrick/.test(ledger()["fall-2026"]?.last?.by || "")
      && /scheduled/i.test(ledger()["fall-2026"]?.last?.by || ""),
      String(ledger()["fall-2026"]?.last?.by));

    // ---- 4. ONCE. The property the five-minute sweep depends on -------
    ok("it is disarmed by firing", (await cadence.armedBlastFor("fall", 2026)) === null,
      j(await cadence.armedBlastFor("fall", 2026)));
    const again = await cadence.runArmedBlast("fall", 2026, { deps, now: at(9, 7), appointmentPageReady: true });
    ok("the next sweep five minutes later does NOT send again",
      again.armed === false && !again.fired, j(again));

    // ---- 5. Cancelling -------------------------------------------------
    await cadence.armBlast("fall", 2026, { by: "patrick", now: at(20, 30) });
    const was = await cadence.disarmBlast("fall", 2026, { by: "patrick" });
    ok("a scheduled blast can be cancelled", was?.by === "patrick", j(was));
    ok("…and then nothing is pending", (await cadence.armedBlastFor("fall", 2026)) === null);
    const afterCancel = await cadence.runArmedBlast("fall", 2026, { deps, now: at(9, 2), appointmentPageReady: true });
    ok("…so the window opening sends nothing",
      afterCancel.armed === false && !afterCancel.fired, j(afterCancel));
    ok("…and the cancellation itself is on the record",
      ledger()["fall-2026"]?.lastDisarm?.by === "patrick", j(ledger()["fall-2026"]?.lastDisarm));

    // ---- 6. Arming is separate from the season next door ---------------
    await cadence.armBlast("fall", 2026, { by: "patrick", now: at(20, 30) });
    ok("arming fall does not arm spring", (await cadence.armedBlastFor("spring", 2026)) === null);
    ok("…nor next year's fall", (await cadence.armedBlastFor("fall", 2027)) === null);
  }
} finally {
  if (backup === null) fs.rmSync(LEDGER, { force: true });
  else fs.writeFileSync(LEDGER, backup);
}

if (failures.length) {
  console.error(`\n✗ test-blast-scheduled: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-blast-scheduled: ${pass} assertions passed`);
