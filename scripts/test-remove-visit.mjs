#!/usr/bin/env node
// Taking a visit off the day.
//
//   node scripts/test-remove-visit.mjs
//
// Patrick: "Customer calls throughout the day (or we go to house and
// already completed) we need a way on that Daily booking system to be able
// to 'Remove visit' an architecture that allows us to obviously skip the
// home (remove it from the path) but record it somewhere."
//
// RECORDING IT IS THE FEATURE. Dropping the stop is already automatic —
// a booking that stops holding its slot leaves the day and the driving
// order with no resequencing code at all. So what these assertions guard
// is the record, and four ways it can quietly be wrong:
//
//   1. THE TWO REASON LISTS DRIFT. The phone draws the sheet from its own
//      copy; the server validates against its own. A code in one and not
//      the other is a button that fails on a driveway.
//   2. THE PHONE PICKS THE STATUS. If the outcome came from the request,
//      anything could mark a booking a no-show. It is derived from the
//      reason, server-side, and never taken from the caller.
//   3. "ALREADY DONE" BECOMES `completed`. That fires the completion
//      cascade and drafts an invoice for work this crew did not do.
//   4. THE REMOVED STOP VANISHES. Dropping it from the route is right;
//      dropping it from the SCREEN is how a job disappears with nobody
//      able to say what happened to it.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
// A file that does not exist yet is a failed assertion, not a stack trace
// that hides every check below it.
const readOr = (rel) => { try { return read(rel); } catch { return ''; } };
const require2 = createRequire(path.join(ROOT, 'package.json'));

const bookingsLib = require2('./server/lib/bookings.js');
const SERVER = read('server/server.js');
const REASONS_SRC = readOr('pjl-field/src/removal-reasons.js');
const TODAY = read('pjl-field/src/screens/TodayScreen.js');
const API = read('pjl-field/src/api.js');
const UI = read('pjl-field/src/ui.js');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n').slice(0, 6).join('\n    ')}`); }
};

// The app's list, lifted out of its module.
function appReasons() {
  const at = REASONS_SRC.indexOf('export const REMOVAL_REASONS = [');
  if (at < 0) return [];
  const body = REASONS_SRC.slice(at, REASONS_SRC.indexOf('\n];', at) + 3)
    .replace('export const', 'const');
  return new Function(`${body}\nreturn REMOVAL_REASONS;`)();
}

// ---- 1. The two lists are the same list ---------------------------------

check('the phone and the server agree on every reason', () => {
  const app = appReasons().map((r) => r.code).sort();
  assert.ok(app.length, 'the app has no reason list — the sheet has nothing to draw');
  const server = Object.keys(bookingsLib.REMOVAL_REASONS).sort();
  assert.deepEqual(app, server,
    'a reason the phone can send that the server refuses, or one the server knows and nobody offers');
  // Five, because these are the five that happen.
  assert.equal(app.length, 5);
  for (const code of app) {
    assert.ok(bookingsLib.isRemovalReason(code), `${code} is not accepted`);
  }
  assert.ok(!bookingsLib.isRemovalReason('nonsense'));
  assert.ok(!bookingsLib.isRemovalReason(''));
});

check('every reason says something a person would say', () => {
  const list = appReasons();
  assert.ok(list.length, 'the app has no reason list');
  for (const r of list) {
    assert.ok(r.label && r.label.length > 2, `${r.code} has no label`);
    assert.ok(r.hint, `${r.code} has no hint — the sheet is a list of bare codes`);
    // Nothing on the sheet may be a field name or a status token.
    // "Customer cancelled" is what a person says and stays; `no_show` and
    // `already_done` are what the database says and do not.
    assert.ok(!/_|\bstatus\b|no_show/i.test(r.label),
      `"${r.label}" is vocabulary from the database`);
    assert.notEqual(r.label, r.code, `${r.code} is showing its own code`);
  }
});

// ---- 2. The server decides the outcome ----------------------------------

check('the outcome comes from the reason, never from the caller', () => {
  const { removalOutcome, REMOVAL_REASONS } = bookingsLib;
  assert.equal(removalOutcome('customer_cancelled'), 'cancelled');
  assert.equal(removalOutcome('no_answer'), 'no_show');
  assert.equal(removalOutcome('no_access'), 'cancelled');
  assert.equal(removalOutcome('weather'), 'cancelled');
  // An unknown code still removes the visit — a tech on a driveway is not
  // the person to debug a vocabulary mismatch — but as a plain cancel.
  assert.equal(removalOutcome('nonsense'), 'cancelled');
  assert.equal(removalOutcome(''), 'cancelled');
  assert.equal(removalOutcome(undefined), 'cancelled');

  // The route reads the code and NOT a status from the body.
  const at = SERVER.indexOf('const cancelBookingMatch');
  const block = SERVER.slice(at, at + 3000);
  assert.match(block, /bookings\.isRemovalReason\(reasonCode\)/, 'an unknown reason is accepted');
  assert.ok(!/payload\?\.(status|outcome)/.test(block),
    'the request can name the status it wants — anything could mark a booking a no-show');
  assert.match(block, /reasonCode,/, 'the code never reaches the library');
});

check('"already done" is a cancellation, not a completion', () => {
  // Marking it complete fires the completion cascade and drafts an invoice
  // for work this crew did not do.
  assert.equal(bookingsLib.removalOutcome('already_done'), 'cancelled');
  const outcomes = Object.values(bookingsLib.REMOVAL_REASONS).map((r) => r.outcome);
  assert.ok(!outcomes.includes('completed'),
    'a reason resolves to completed — that drafts an invoice for work nobody did');
  for (const o of outcomes) {
    assert.ok(bookingsLib.DEAD_STATUSES.has(o), `${o} still holds its slot — the stop stays on the route`);
    assert.equal(bookingsLib.holdsItsSlot(o), false);
  }
});

check('the customer is not emailed that a finished job was cancelled', () => {
  assert.equal(bookingsLib.REMOVAL_REASONS.already_done.notify, false,
    'telling someone their visit was cancelled because it had already been done is a confusing email');
  assert.equal(bookingsLib.REMOVAL_REASONS.customer_cancelled.notify, true);
  // And an explicit flag from the caller still wins.
  const at = SERVER.indexOf('const cancelBookingMatch');
  const block = SERVER.slice(at, at + 3000);
  assert.match(block, /payload\?\.notifyCustomer === undefined/);
});

check('the reason and the note both survive onto the record', () => {
  const at = SERVER.indexOf('const cancelBookingMatch');
  const block = SERVER.slice(at, at + 3000);
  // "already done" asks what happened; that text is appended to the label,
  // not swapped for it.
  assert.match(block, /\[spec\.label, note\]\.filter\(Boolean\)\.join\(" — "\)/);
  // And the structured half is what a query groups by next February.
  assert.match(bookingsLib.cancel.toString(), /removalCode/);
});

check('the lead mirror carries the OUTCOME, not the word cancelled', () => {
  // The day list reads the lead's cached status. Mirrored as "cancelled",
  // a no-show is a no-show nothing downstream ever hears about.
  const at = SERVER.indexOf('[booking cancel] lead.booking mirror failed');
  const block = SERVER.slice(Math.max(0, at - 1200), at);
  assert.match(block, /lead\.booking\.status = cancelled\.status;/,
    'the mirror hardcodes cancelled — a no-show is lost on the way to the day list');
  assert.match(block, /lead\.booking\.removalCode = cancelled\.removalCode/);
});

// ---- 3. It leaves the route, and does not leave the screen --------------

check('the day hands back what came off it, separately from the work', () => {
  const at = SERVER.indexOf('const removedToday = allLeads');
  assert.ok(at > 0, 'the day no longer reports its removals');
  const block = SERVER.slice(at, SERVER.indexOf('const dayBookings = allLeads', at));
  // A finished job is not a removed one.
  assert.match(block, /if \(lead\.booking\?\.status === "completed"\) return false;/);
  // Only ones actually taken off — not every dead record that ever
  // touched this date.
  assert.match(block, /return Boolean\(lead\.booking\?\.cancelledAt\);/);
  assert.match(block, /removalCode:/);
  assert.match(block, /removedBy:/);
  // Kept OUT of `bookings`, which is what drives, maps and counts the day.
  assert.match(SERVER, /removed: removedToday/);
  assert.ok(!/bookings: \[\.\.\.ordered, \.\.\.removedToday\]/.test(SERVER));
});

check('the row names the booking the phone will act on', () => {
  // The lead's embedded booking is a read cache with no id of its own, so
  // without this the button has nothing to call.
  assert.match(SERVER, /bookingId: bookingIdByLeadId\.get\(lead\.id\) \|\| null,/);
  assert.match(TODAY, /disabled=\{busy \|\| removingBusy \|\| !b\.bookingId\}/,
    'the button offers itself on a row it cannot act on');
});

check('the removed stop is shown, struck through, with why and who', () => {
  assert.match(TODAY, /const removed = payload\?\.removed \|\| \[\];/);
  assert.match(TODAY, /Removed today \(\{removed\.length\}\)/);
  assert.match(TODAY, /removalLabel\(r\)/);
  assert.match(TODAY, /removalNote\(r\)/);
  assert.match(TODAY, /textDecorationLine: 'line-through'/,
    'a removed stop reads like a live one');

  const reasons = REASONS_SRC;
  assert.ok(reasons.includes('export function removalNote'), 'nothing describes a removal');
  const note = new Function(
    `${reasons.slice(reasons.indexOf('export function removalNote'))
      .replace('export function', 'function')
      .split('\n}\n')[0]}\n}\nreturn removalNote;`,
  )();
  const line = note({ removedAt: '2026-10-06T12:41:00.000Z', removedBy: 'tech', status: 'no_show' });
  assert.match(line, /^Removed /);
  assert.match(line, /by tech/);
  assert.match(line, /no-show/, 'a no-show reads the same as a cancellation');
  assert.equal(note({}), 'Removed');
});

// ---- 4. The way it is asked ---------------------------------------------

check('the phone asks why, and asks what happened when it matters', () => {
  assert.match(API, /export const removeVisit/);
  assert.match(API, /\/api\/bookings\/\$\{encodeURIComponent\(bookingId\)\}\/cancel/);
  assert.match(TODAY, /label="Not today"/);
  // Last in the row, so a thumb reaching for "Work order" never finds it.
  assert.ok(TODAY.indexOf('label={workOrderActionLabel(b)}') < TODAY.indexOf('label="Not today"'),
    'the removal button sits before the one that starts the work');

  // Only "already done" asks for more, and it asks in a sheet.
  assert.ok(appReasons().length, 'the app has no reason list');
  const asks = appReasons().filter((r) => r.asksWhy).map((r) => r.code);
  assert.deepEqual(asks, ['already_done']);
  assert.match(UI, /export function PromptSheet\(/, 'there is nothing to ask with');
  // NOT Alert.prompt: iOS-only, and app.json declares an android target,
  // so on Android it would silently do nothing at all.
  assert.ok(!/Alert\.prompt\(/.test(TODAY), 'Alert.prompt is back — it does nothing on Android');
  assert.ok(!/Alert\.prompt\(/.test(UI));
});

check('the day is refetched, not guessed at', () => {
  const at = TODAY.indexOf('const applyRemoval = useCallback');
  const block = TODAY.slice(at, TODAY.indexOf('}, [load, selected]);', at));
  // Removing a stop changes the driving order of everything after it, and
  // the server owns that order. Patching the list here is how the map and
  // the list start disagreeing.
  assert.match(block, /await load\(selected\);/);
  assert.ok(!/setPayload\(\(prev\)/.test(block), 'the day is patched locally after a removal');
});

console.log(`\nremove-visit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
