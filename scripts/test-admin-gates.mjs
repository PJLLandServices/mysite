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

check('the System Builder\'s calculation engine is gated like the page it serves', () => {
  // Split out of sitebuilder.html on 2026-09-21. The file carries Patrick\'s
  // default SKUs, the zone-packing rules and the BOM maths, all of which
  // were behind staff auth while they were inline. Moving code into its own
  // file must not be how it becomes public.
  assert.equal(needsAuth('GET', '/admin/sitebuilder'), 'user');
  assert.equal(needsAuth('GET', '/admin/sitebuilder-engine.js'), 'user');

  // And a gate on a URL that serves nothing is not a gate, it is a 404
  // waiting to break the builder. The static resolver has to map it too.
  const start = SRC.indexOf('function resolveStaticTarget(pathname) {');
  assert.ok(start > 0, 'resolveStaticTarget not found in server.js');
  const end = SRC.indexOf('\n}\n', start);
  const resolveStaticTarget = new Function(
    'SERVER_DIR', 'SITE_DIR',
    `${SRC.slice(start, end + 3)}; return resolveStaticTarget;`
  )('/server', '/site');
  assert.equal(
    resolveStaticTarget('/admin/sitebuilder-engine.js').relative,
    '/sitebuilder-engine.js',
    'the engine URL is fenced but serves nothing — the builder would refuse to start',
  );
});

check('part photos are fenced — images, overview, writes and the admin page', () => {
  // P-PJL-35. Every one of these would fall through to "open" if the
  // prefix rule were missing. Writes additionally require requireAdmin()
  // in the handler (the lock checks below cover that shape).
  const hash = 'a'.repeat(64);
  assert.equal(needsAuth('GET', `/api/part-photos/${hash}/160.webp`), 'user');
  assert.equal(needsAuth('GET', '/api/part-photos'), 'user');
  assert.equal(needsAuth('POST', '/api/part-photos/405010/photo'), 'user');
  assert.equal(needsAuth('POST', '/api/part-photos/405010/link'), 'user');
  assert.equal(needsAuth('DELETE', '/api/part-photo-groups/PG-0001/photo'), 'user');
  assert.equal(needsAuth('GET', '/admin/part-photos'), 'user');
  // M2a: the fitting default and supplier logos.
  assert.equal(needsAuth('POST', '/api/part-photo-groups/PG-0001/default'), 'user');
  // M3b: the Photo Review queue and its actions.
  assert.equal(needsAuth('GET', '/api/part-photo-review'), 'user');
  assert.equal(needsAuth('POST', '/api/part-photo-review/405010/approve'), 'user');
  assert.equal(needsAuth('POST', '/api/part-photo-review/405010/reject'), 'user');
  assert.equal(needsAuth('POST', '/api/part-photo-review/fittings/A%7CB'), 'user');
  // M3c: the calibration run's plan and its start / pause / resume.
  assert.equal(needsAuth('GET', '/api/part-photo-backfill/plan'), 'user');
  assert.equal(needsAuth('POST', '/api/part-photo-backfill/calibration'), 'user');
  assert.equal(needsAuth('POST', '/api/part-photo-backfill/pause'), 'user');
  assert.equal(needsAuth('POST', '/api/part-photo-backfill/resume'), 'user');
  assert.equal(needsAuth('POST', '/api/part-photo-backfill/probe'), 'user');
  assert.equal(needsAuth('GET', '/api/part-photo-backfill/wave-plan'), 'user');
  assert.equal(needsAuth('POST', '/api/part-photo-backfill/wave'), 'user');
  assert.equal(needsAuth('GET', `/api/supplier-logos/${hash}.png`), 'user');
  assert.equal(needsAuth('POST', '/api/suppliers/SUP-001/logo'), 'user');
  assert.equal(needsAuth('DELETE', '/api/suppliers/SUP-001/logo'), 'user');
});

check('M2a writes require the admin role in the handler, not just a session', () => {
  // The fence above lets any staff session reach these; the handler must
  // then insist on admin. Shape check on the real source: the handler's
  // first statement is requireAdmin with its result checked.
  for (const marker of ['partPhotoDefaultMatch && req.method === "POST"', 'supplierLogoMatch && (req.method === "POST" || req.method === "DELETE")']) {
    const at = SRC.indexOf(marker);
    assert.ok(at > 0, `handler not found: ${marker}`);
    const head = SRC.slice(at, at + 400);
    assert.match(head, /const session = await requireAdmin\(req\);\s*\n\s*if \(!session\) return sendJson\(res, 403/, `${marker} must reject non-admins`);
  }
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

check('Photo Review writes (M3b) and backfill actions (M3c) check the admin answer', () => {
  for (const marker of [
    'photoReviewSkuMatch && req.method === "POST"',
    'photoReviewFittingMatch && req.method === "POST"',
    'backfillActionMatch && req.method === "POST"',
    'pathname === "/api/part-photo-backfill/probe"',
    'pathname === "/api/part-photo-backfill/wave"',
  ]) {
    const at = SRC.indexOf(marker);
    assert.ok(at > 0, `route not found: ${marker}`);
    const block = SRC.slice(at, at + 600);
    assert.match(block, /const session = await requireAdmin\(req\);/, `${marker}: binds the result`);
    assert.match(block, /if \(!session\) return sendJson\(res, 403/, `${marker}: rejects when it is null`);
  }
});

check('the only start door is the hard-limited calibration (M3c): no general start, no full catalog, nothing at boot', () => {
  // startCalibration() fixes the SKU list (the approved 15-part sample),
  // forces auto-approve OFF and refuses while a run is active. The general
  // start()/kick()/retry() must never be reachable from a route.
  assert.ok(!/photoBackfill\.(start|kick|retry)\(/.test(SRC), 'server.js calls the general start/kick/retry');
  assert.equal((SRC.match(/photoBackfill\.startCalibration\(/g) || []).length, 1, 'exactly one startCalibration call site');
  // The re-run door (approved 2026-09-27) is limited by the engine to the
  // last calibration's parts that still have no live photo.
  assert.equal((SRC.match(/photoBackfill\.startCalibrationRerun\(/g) || []).length, 1, 'exactly one startCalibrationRerun call site');
  assert.equal(needsAuth('POST', '/api/part-photo-backfill/rerun-unresolved'), 'user');
  const at = SRC.indexOf('backfillActionMatch && req.method === "POST"');
  const block = SRC.slice(at, at + 2500);
  assert.ok(!/autoApprove\s*:\s*true/.test(block), 'the route must never pass autoApprove: true');
  assert.ok(!/skus\s*:/.test(block), 'the route must never choose its own SKU list');
  // The re-run may narrow to a subset (`only`), but the engine intersects it
  // with the unresolved calibration parts and refuses anything outside.
  assert.match(block, /startCalibrationRerun\(\{ by, only \}\)/, 'the re-run passes only a subset request, never a SKU list of its own');
  assert.ok(!/part-photo-backfill\/(full|catalog|all|run)/.test(SRC), 'a full-catalog route exists');
  // The wave (≤30 unprocessed parts): exactly one start site, and the route
  // only relays the list Patrick confirmed — the engine refuses any list
  // that isn't the plan it would run now.
  assert.equal((SRC.match(/photoBackfill\.startWave\(/g) || []).length, 1, 'exactly one startWave call site');
  const wat = SRC.indexOf('pathname === "/api/part-photo-backfill/wave"');
  const wblock = SRC.slice(wat, wat + 1800);
  assert.ok(!/autoApprove\s*:\s*true/.test(wblock), 'the wave route must never pass autoApprove: true');
  assert.match(wblock, /startWave\(\{ by, skus: Array\.isArray\(payload && payload\.skus\)/, 'the wave route passes only the confirmed list');
  assert.ok(!/size\s*:/.test(wblock), 'the wave route must not widen the size');
  // Nothing starts when the process boots: the client is created lazily and
  // the runner is only ever kicked from startCalibration()/resume().
  const boot = SRC.slice(SRC.indexOf('const photoAi = (() => {'), SRC.indexOf('const { buildReviewQueues }'));
  assert.match(boot, /real \|\|= photoAiLib\.createPhotoAI\(\{ client: photoAiLib\.createAnthropicClient\(\) \}\)/, 'the Claude client is created lazily, not at boot');
  assert.ok(!/photoBackfill\.(resume|startCalibration|load)\(\)/.test(boot), 'the backfill is touched at boot');
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
