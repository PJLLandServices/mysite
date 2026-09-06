// The two ways an admin-only route is actually protected, tested by
// running the code rather than by looking for words in it.
//
// On 2026-09-06 `POST /api/terminal/connection-token` handed a LIVE Stripe
// Terminal token (`pst_live_…`) to an unauthenticated curl, in production.
// Two independent defects had to line up, and both were invisible to the
// test that was supposed to cover it:
//
//   1. THE FENCE. `needsAuth(method, pathname)` decides whether a request
//      is challenged at all, and it ends in `return null` — NO AUTH — for
//      any path it does not name. The route was never added to it.
//
//   2. THE LOCK. `requireAdmin(req)` RETURNS NULL on failure. It does not
//      throw. So `await requireAdmin(req);` on its own is not a gate; it
//      is a no-op with the shape of one, and it reads exactly like the
//      real thing.
//
// The old assertion was `/requireAdmin\(req\)/.test(routeBlock)` — the
// route's source contains that call. It did. It passed. It was green while
// the endpoint was open, and deleting the line failed it, which made the
// check look verified. A source-text assertion cannot tell a gate from a
// no-op, so this file does not use one.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(path.join(ROOT, 'server/server.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (err) { fail++; console.log(`  FAIL: ${name}\n    ${err.message.split('\n')[0]}`); }
};

// ---- The fence, actually executed --------------------------------------
//
// needsAuth is a pure function of (method, pathname) with no dependencies,
// so it can be lifted out and RUN. That is the whole point: a rule that is
// present but unreachable, or shadowed by an earlier `startsWith`, fails
// here the way it would fail in production.

function extractNeedsAuth() {
  const start = SRC.indexOf('function needsAuth(method, pathname) {');
  assert.ok(start > 0, 'needsAuth not found in server.js');
  // Ends at the first `}` in column 0 after the start — the file's own
  // top-level function style.
  const end = SRC.indexOf('\n}\n', start);
  assert.ok(end > start, 'could not find the end of needsAuth');
  const body = SRC.slice(start, end + 3);
  return new Function(`${body}; return needsAuth;`)();
}

const needsAuth = extractNeedsAuth();

check('needsAuth can be lifted out and run', () => {
  assert.equal(typeof needsAuth, 'function');
});

check('the Terminal connection-token route is fenced as admin', () => {
  // The actual bug. Not "is it mentioned" — what does the function RETURN.
  assert.equal(
    needsAuth('POST', '/api/terminal/connection-token'), 'admin',
    'an unfenced route is reachable with no session at all',
  );
});

check('a route nobody listed still defaults to open, as it always has', () => {
  // Recorded, not fixed here. Changing the default to "deny" would be the
  // stronger design, but it would silently fence every public endpoint in
  // the file — the pay pages, the iCal feed, the unsubscribe link — and
  // that is a change to make deliberately, with each one walked, not as a
  // side effect of a security fix. This assertion exists so the default is
  // a decision somebody made rather than a thing nobody noticed.
  assert.equal(needsAuth('POST', '/api/not-a-real-route-xyz'), null);
});

check('the public routes that must stay public still are', () => {
  // The reason the default above was not simply flipped.
  assert.equal(needsAuth('GET', '/api/outreach/unsubscribe'), null);
  assert.equal(needsAuth('POST', '/api/warranty-claims'), null);
});

check('the admin surfaces around it did not move', () => {
  assert.equal(needsAuth('GET', '/api/users'), 'admin');
  assert.equal(needsAuth('GET', '/api/admin/territory-export'), 'admin');
  assert.equal(needsAuth('POST', '/api/work-orders/WO-1/unlock'), 'admin');
  assert.equal(needsAuth('GET', '/api/invoices'), 'user');
  assert.equal(needsAuth('GET', '/api/properties'), 'user');
});

// ---- The lock, as a structural invariant --------------------------------
//
// requireAdmin's return value is the answer. DISCARDING it is the bug, and
// it was a class of bug: three routes had it.
//
// The rule is deliberately narrow — a bare call whose result goes nowhere.
// That can never be right, for gating or anything else. It is not extended
// to "bound but not tested", because eighteen routes legitimately bind it
// only for attribution (`by: session?.uid`) on surfaces `needsAuth` fences
// at "user" so techs can reach them. Flagging those would make this suite
// cry wolf on correct code, and a guard people learn to ignore is worse
// than no guard.

check('requireAdmin is still the return-null-on-failure shape this assumes', () => {
  // If requireAdmin is ever changed to throw, the rule below stops being
  // the right one, and this is what should say so.
  const fn = SRC.slice(SRC.indexOf('async function requireAdmin(req) {'), SRC.indexOf('async function actorLabel'));
  assert.match(fn, /return null;/, 'requireAdmin no longer returns null — revisit the rule below');
  assert.ok(!/throw /.test(fn), 'requireAdmin now throws — the bare-call rule may no longer apply');
});

check('no route calls requireAdmin and throws the answer away', () => {
  const lines = SRC.split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!/requireAdmin\(req\)/.test(trimmed)) return;
    // Not call sites: the declaration, prose about it, and the central
    // gate's own ternary, which tests what it binds.
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    if (/^async function requireAdmin/.test(trimmed)) return;
    if (/^\? await requireAdmin\(req\)$/.test(trimmed)) return;
    if (/=\s*await requireAdmin\(req\)/.test(trimmed)) return;
    offenders.push(`line ${i + 1}: ${trimmed}`);
  });
  assert.equal(
    offenders.length, 0,
    `a bare requireAdmin call is a no-op with the shape of a gate: ${offenders.join(' | ')}`,
  );
});

check('the three routes that had the no-op gate now check the answer', () => {
  // Named, so that re-introducing the bug on exactly these routes fails
  // loudly rather than relying on the general rule above.
  for (const marker of [
    'pathname === "/api/terminal/connection-token" && req.method === "POST"',
    'invoicePayLinkMatch && req.method === "POST"',
    'zoneRemoveMatch && req.method === "DELETE"',
  ]) {
    const at = SRC.indexOf(marker);
    assert.ok(at > 0, `route not found: ${marker}`);
    const block = SRC.slice(at, at + 1400);
    assert.match(block, /const session = await requireAdmin\(req\);/, `${marker}: binds the result`);
    assert.match(block, /if \(!session\) return sendJson\(res, 403/, `${marker}: rejects when it is null`);
  }
});

check('the check catches the exact bug it was written for', () => {
  // Without this, a green run could mean the matcher never fires.
  const bare = ['  try {', '    await requireAdmin(req);', '    doTheThing();']
    .map((l) => l.trim())
    .filter((l) => /requireAdmin\(req\)/.test(l) && !/=\s*await requireAdmin\(req\)/.test(l));
  assert.equal(bare.length, 1, 'the matcher missed a bare requireAdmin call');
});

console.log(`\nadmin-gates: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
