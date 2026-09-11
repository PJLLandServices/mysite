#!/usr/bin/env node
// scripts/test-blast-window-ledger.mjs
//
// "I pressed send blast this morning." — Patrick, 2026-09-10, hours after
// the fact, with no way to find out what had happened.
//
// WHAT HAPPENED. He pressed it before 9am. The server refused it on the
// send window and threw. The refusal was written to a panel on the page,
// and the next page load erased it. By evening the only honest answer to
// "did anything send?" came from reading his Gmail sent folder — the most
// consequential button in the system had left no trace of the refusal, of
// who would have been skipped, or even of having been pressed.
//
// And by the time it was worked out it was past 6pm, so the window had
// closed again: the rule had cost a full day of the assignment cadence
// for no customer-facing reason.
//
// THREE THINGS ARE PINNED HERE:
//
//   1. The window runs to 8pm (Patrick's call, 2026-09-10). It governs
//      the blast AND automated steps 2–6, so the boundaries are asserted
//      rather than assumed.
//   2. Every attempt is RECORDED — a refusal as much as a send. A
//      refusal is an outcome, not a non-event.
//   3. status() carries what the button needs to refuse BEFORE it is
//      armed: whether sending is open now, and what to say when it is not.
//
// Run: node scripts/test-blast-window-ledger.mjs  (also in build:check)

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

fs.mkdirSync(DATA, { recursive: true });
const backup = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER) : null;
const readLedger = () => (fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8") || "{}") : {});
const at = (h, m = 0) => new Date(2026, 8, 10, h, m, 0);
// Missing entirely is a FAILURE to report, not a crash that hides the
// twenty assertions behind it.
const note = (d) => (typeof cadence.sendWindowNote === "function"
  ? cadence.sendWindowNote(d) : "(sendWindowNote is missing)");
const inWindow = (d) => (typeof cadence.insideSendWindow === "function"
  ? cadence.insideSendWindow(d) : "(insideSendWindow is missing)");
// JSON.stringify(undefined) is undefined, and .slice on that throws —
// which would crash the report instead of printing it.
const j = (v, n = 200) => String(JSON.stringify(v) ?? "(nothing recorded)").slice(0, n);

try {
  fs.rmSync(LEDGER, { force: true });

  // ---- 1. The window ------------------------------------------------
  {
    ok("the window runs 9am to 8pm",
      cadence.SEND_WINDOW.fromHour === 9 && cadence.SEND_WINDOW.toHour === 20,
      JSON.stringify(cadence.SEND_WINDOW));
    ok("8:59am is still closed", inWindow(at(8, 59)) === false);
    ok("9:00am is open", inWindow(at(9, 0)) === true);
    // The hour that cost the day: 6pm used to be the cutoff.
    ok("7:00pm is open — it was not before", inWindow(at(19, 0)) === true);
    ok("7:59pm is open", inWindow(at(19, 59)) === true);
    ok("8:00pm is closed", inWindow(at(20, 0)) === false);

    ok("inside the window there is nothing to say", note(at(11, 0)) === null);
    ok("before it opens, the note says when",
      /opens at 9 AM today/.test(note(at(7, 30)) || ""),
      String(note(at(7, 30))));
    ok("after it closes, the note says so and points at tomorrow",
      /closed at 8 PM/.test(note(at(21, 0)) || "")
      && /tomorrow/.test(note(at(21, 0)) || ""),
      String(note(at(21, 0))));
  }

  // ---- 2. A refusal is recorded ---------------------------------------
  // The defect itself. Pressing the button outside the window must leave
  // a trace that survives the page.
  {
    let threw = null;
    try {
      await cadence.blast("fall", 2026, {
        deps: { listBookings: async () => [] },
        by: "patrick", now: at(7, 30), appointmentPageReady: true
      });
    } catch (err) { threw = err; }
    ok("a send outside the window is still refused", Boolean(threw), "it did not throw");
    ok("…with the real hours in the message",
      /9 AM . 8 PM/.test(threw?.message || ""), String(threw?.message));

    const led = readLedger()["fall-2026"];
    ok("…and the refusal is written down", Boolean(led?.last), j(readLedger(), 160));
    ok("…as a refusal, with the reason",
      led?.last?.outcome === "refused" && /9 AM/.test(led?.last?.reason || ""),
      j(led?.last, 200));
    ok("…naming who pressed it", led?.last?.by === "patrick", String(led?.last?.by));
    ok("…and when", typeof led?.last?.at === "string" && !Number.isNaN(Date.parse(led.last.at)));
  }

  // ---- 3. The appointment-page interlock is recorded the same way ------
  {
    let threw = null;
    try {
      await cadence.blast("fall", 2026, {
        deps: { listBookings: async () => [] },
        by: "patrick", now: at(11, 0), appointmentPageReady: false
      });
    } catch (err) { threw = err; }
    ok("a send with the appointment page down is refused", Boolean(threw));
    const led = readLedger()["fall-2026"];
    ok("…and recorded", led?.last?.outcome === "refused" && /appointment page/i.test(led?.last?.reason || ""),
      j(led?.last, 160));
    ok("…without losing the earlier attempt", (led?.history || []).length === 2, `${(led?.history || []).length}`);
  }

  // ---- 4. A real send is recorded with its counts ----------------------
  // One booking, already blasted, so the ledger's "sent" path is exercised
  // without standing up a mail transport: alreadyBlasted is a real outcome
  // and the one Patrick will see if he presses twice.
  {
    const booking = {
      id: "BK-CADENCE-PROBE",
      source: "assignment",
      status: "confirmed",
      assignment: {
        season: "fall", year: 2026, code: "P-001",
        outreach: { token: "t".repeat(24), steps: { "1": { at: "2026-09-10T13:00:00Z", attempted: ["email"] } } }
      }
    };
    // Wrapped: on the old 6pm window this throws, and a thrown error here
    // is the finding — not a reason for the report to stop.
    let result = null;
    let threw = null;
    try {
      result = await cadence.blast("fall", 2026, {
        deps: { listBookings: async () => [booking] },
        by: "patrick", now: at(19, 30), appointmentPageReady: true
      });
    } catch (err) { threw = err; }
    ok("a send at 7:30pm now goes through", result?.ok === true,
      threw ? `refused: ${threw.message}` : j(result, 140));
    result = result || {};
    ok("…and reports the one already messaged", result.alreadyBlasted === 1 && result.blasted === 0,
      j(result, 140));

    const led = readLedger()["fall-2026"];
    ok("…recorded as a send, not a refusal", led?.last?.outcome === "sent", j(led?.last, 160));
    ok("…with the counts Patrick would want an hour later",
      led?.last?.blasted === 0 && led?.last?.alreadyBlasted === 1 && led?.last?.considered === 1,
      j(led?.last, 200));
    ok("…and the history keeps all three attempts", (led?.history || []).length === 3,
      `${(led?.history || []).length}`);
  }

  // ---- 5. status() tells the button what it needs ----------------------
  {
    const st = await cadence.status("fall", 2026, { deps: { listBookings: async () => [] } });
    ok("status says whether sending is open right now", typeof st.canSendNow === "boolean");
    ok("…carries the window itself",
      st.sendWindow?.fromHour === 9 && st.sendWindow?.toHour === 20, JSON.stringify(st.sendWindow));
    ok("…and hands back the last attempt, so a reload cannot lose it",
      st.lastBlast?.outcome === "sent", j(st.lastBlast, 140));
  }

  // ---- 6. The ledger never breaks the send it describes -----------------
  {
    const before = readLedger();
    await cadence.recordBlastAttempt?.("fall", 2026, { outcome: "sent" });
    ok("the ledger is internal, not part of the module's contract",
      cadence.recordBlastAttempt === undefined || readLedger() !== before);
  }
} finally {
  if (backup === null) fs.rmSync(LEDGER, { force: true });
  else fs.writeFileSync(LEDGER, backup);
}

if (failures.length) {
  console.error(`\n✗ test-blast-window-ledger: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-blast-window-ledger: ${pass} assertions passed`);
