// Retry safety for POST /api/booking/reserve (lib/reserve-receipts.js, PJL-87).
//
// A caller that lost the reply sends the identical request again with the
// same clientRequestId. On the old code that booked twice. Now the second
// request gets the original reply (replayed: true) and nothing is written.
// Fails on the old code at "a retry with the same id does not book twice".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- unit: the receipt store on its own ----------------------------------
{
  const { createReceipts } = require("../server/lib/reserve-receipts.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-"));
  let t = 1_000_000;
  const rc = createReceipts({ dataDir: dir, now: () => t });
  assert.equal(rc.lookup("abc"), null, "unknown id → null");
  assert.equal(await rc.file("abc", 409, { ok: false }), false, "refusals are not filed (retry may succeed)");
  assert.equal(await rc.file("abc", 201, { ok: true, leadId: "L1" }), true);
  assert.deepEqual(rc.lookup("abc"), { status: 201, body: { ok: true, leadId: "L1" } });
  t += rc.TTL_MS + 1;
  assert.equal(rc.lookup("abc"), null, "expired on read");
  assert.equal(rc.normalizeId("x".repeat(81)), "", "over-long id ignored");
  assert.equal(rc.normalizeId(""), "", "empty id ignored");
}

// ---- end to end: two identical reserves, one booking ---------------------
const PORT = 4400 + Math.floor(Math.random() * 400);
const DATA = path.join(ROOT, "server", "data");
fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["leads.json", "bookings.json", "customers.json", "properties.json", "work-orders.json", "holds.json", "reserve-receipts.json"];
const backups = new Map(TOUCHED.map((f) => [f, fs.existsSync(path.join(DATA, f)) ? fs.readFileSync(path.join(DATA, f)) : null]));
for (const f of TOUCHED) fs.writeFileSync(path.join(DATA, f), "[]\n");
const TEST_KEY = "receipts-suite-key";
const child = spawn(process.execPath, [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", PJL_TEST_KEY: TEST_KEY },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });
const base = `http://127.0.0.1:${PORT}`;
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, `${f}.json`), "utf8") || "[]");

try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`${base}/api/booking/services`); up = true; } catch {}
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-2000));

  const ADDRESS = "851 Hilton Blvd, Newmarket, ON L3X 2H7, Canada";
  const SERVICE = "fall_close_4z";
  const av = await (await fetch(`${base}/api/booking/availability?service=${SERVICE}&address=${encodeURIComponent(ADDRESS)}&zoneCount=4&days=45`)).json();
  const slot = (av.days || []).flatMap((d) => d.slots || [])[0];
  assert.ok(slot, "a slot to book");

  // Admin-free path: the load-test key skips Turnstile/rate limit/hold like
  // Patrick's bot, so the suite needs no admin session.
  const reserve = (clientRequestId) => fetch(`${base}/api/booking/reserve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pjl-test-key": TEST_KEY },
    body: JSON.stringify({
      serviceKey: SERVICE, slotStart: slot.start, zoneCount: 4, clientRequestId,
      contact: { name: "Retry Tester", firstName: "Retry", lastName: "Tester", email: "retry@example.com",
        phone: "9055551234", address: ADDRESS, notes: "PJLTEST-RECEIPTS — retry suite" },
    }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  const first = await reserve("op-1");
  assert.ok(first.status === 201 && first.body.ok, `first reserve books: ${first.status} ${JSON.stringify(first.body).slice(0, 200)}`);
  assert.equal(read("leads").length, 1, "one lead after the first reserve");

  const second = await reserve("op-1");
  assert.equal(second.status, 201, "a retry with the same id gets the original 201 back");
  assert.equal(second.body.leadId, first.body.leadId, "…with the SAME lead id");
  assert.equal(second.body.replayed, true, "…and is marked as a replay");
  assert.equal(read("leads").length, 1, "a retry with the same id does not book twice");
  assert.equal(read("bookings").length, 1, "…one canonical booking");

  // A DIFFERENT id is judged on its own merits, never replayed. Whether it
  // books depends on the slot: a timed slot is now taken (4xx), but a
  // morning/afternoon bucket legitimately holds several bookings (201).
  // The first offered slot is date-driven, so accept either outcome and
  // assert what the receipt store is responsible for.
  const third = await reserve("op-2");
  assert.notEqual(third.body.replayed, true, `a DIFFERENT id is never answered with a replay: ${third.status}`);
  if (third.status === 201) {
    assert.notEqual(third.body.leadId, first.body.leadId, "…a different id that books gets its own lead");
    assert.equal(read("leads").length, 2, "…and adds exactly one lead");
  } else {
    assert.ok(third.status >= 400, `…or is refused on its own merits (slot taken): ${third.status}`);
    assert.equal(read("leads").length, 1, "…and a refusal writes nothing");
  }

  const receipts = JSON.parse(fs.readFileSync(path.join(DATA, "reserve-receipts.json"), "utf8"));
  assert.equal(receipts.length, third.status === 201 ? 2 : 1, "only successes are filed, one per id");

  console.log("test-reserve-receipts: all checks passed");
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) fs.rmSync(p, { force: true }); else fs.writeFileSync(p, buf);
  }
}
