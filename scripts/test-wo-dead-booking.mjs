#!/usr/bin/env node
// scripts/test-wo-dead-booking.mjs
//
// A dead appointment must not put a job on a tech's day.
//
// POST /api/work-orders refused to build a work order behind a CANCELLED
// booking — "creating a WO behind it would put a 'ghost' tech run on the
// calendar with no real visit" (Brief B §3.4). Correct, and it named one
// state where there are three:
//
//   cancelled  — refused, correctly, since 2026-08
//   completed  — allowed. The job is finished and ALREADY has its work
//                order (the completion cascade made it), so a second one
//                is a duplicate job for a visit that already happened.
//   no_show    — allowed. A visit that did not happen and is not going
//                to. The ghost run the guard exists to prevent, exactly.
//
// Patrick, 2026-09-09, asked for all three blocked. The guard now asks
// bookingHoldsItsSlot() instead of naming a state, so a fourth dead state
// is covered the day it is added (CLAUDE.md: define the rule once).
//
// THE ESCAPE HATCH IS THE POINT, and is asserted here too. A genuine
// extra visit on a finished job — a callback, a warranty return — is
// created against the PROPERTY, which this route already accepts and
// which is the more honest record: it is a new visit, not a second sheet
// for the old one. If that ever stopped working, this change would have
// taken away a real workflow instead of a phantom one.
//
// Drives the real endpoint against a booted server.
//
// Run: node scripts/test-wo-dead-booking.mjs  (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4803;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["leads.json", "bookings.json", "work-orders.json", "properties.json", "customers.json", "users.json", "auth.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}

const LEAD_ID = "lead-wo-deadbooking-probe";
const START = "2026-10-06T12:00:00.000Z";

function writeLead(status) {
  const lead = {
    id: LEAD_ID,
    createdAt: "2026-09-06T18:00:00Z",
    status: "won",
    contact: { name: "Ghost Run", email: "ghost@example.com", address: "100 Main St, Newmarket, ON" },
    booking: {
      start: START,
      end: "2026-10-06T12:30:00.000Z",
      serviceKey: "fall_close_4z",
      serviceLabel: "Fall winterization (1-4 zones residential)"
    }
  };
  if (status !== "live") lead.booking.status = status;
  fs.writeFileSync(path.join(DATA, "leads.json"), JSON.stringify([lead], null, 2));
  fs.writeFileSync(path.join(DATA, "work-orders.json"), JSON.stringify([], null, 2));
}

const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`http://127.0.0.1:${PORT}/api/booking/services`); up = true; } catch {}
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-1500));

  const users = require(path.join(ROOT, "server", "lib", "users.js"));
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  await users.create({ email: "wo-probe@local.test", name: "WO Probe", role: "admin", password: "wo-probe-12345" });
  const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "wo-probe@local.test", password: "wo-probe-12345" })
  });
  const cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0])
    .find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("a throwaway admin can log in", login.ok && Boolean(cookie), `${login.status}`);

  const createWO = async (body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/work-orders`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body)
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  // ---- 1. A live booking still builds its work order -----------------
  // The control. Without it, "everything is refused" would pass every
  // assertion below and the endpoint would be broken rather than fixed.
  for (const live of ["live", "tentative"]) {
    writeLead(live);
    const res = await createWO({ type: "fall_closing", leadId: LEAD_ID });
    ok(`a ${live.toUpperCase()} booking still builds a work order`,
      res.status === 200 && res.data.ok && res.data.workOrder?.id,
      `${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
  }

  // ---- 2. No dead booking builds one ---------------------------------
  for (const dead of ["cancelled", "completed", "no_show"]) {
    writeLead(dead);
    const res = await createWO({ type: "fall_closing", leadId: LEAD_ID });
    ok(`a ${dead.toUpperCase()} booking is refused`,
      res.status === 409, `${res.status} ${JSON.stringify(res.data).slice(0, 140)}`);
    ok(`…naming the state, so the CRM can say why`,
      res.data.code === `booking_${dead}`, JSON.stringify(res.data.code));
    ok(`…and nothing was written`,
      JSON.parse(fs.readFileSync(path.join(DATA, "work-orders.json"), "utf8")).length === 0,
      "a work order was created anyway");
    ok(`…with a message a human can act on`,
      typeof res.data.errors?.[0] === "string" && /re-book|another visit/i.test(res.data.errors[0]),
      JSON.stringify(res.data.errors));
  }

  // ---- 3. The escape hatch still works -------------------------------
  // A callback on a finished job is a NEW visit against the property, not
  // a second sheet on the old appointment. If this breaks, the change
  // above has removed a real workflow.
  {
    const customers = require(path.join(ROOT, "server", "lib", "customers.js"));
    const properties = require(path.join(ROOT, "server", "lib", "properties.js"));
    const cust = await customers.create({ name: "Ghost Run", email: "ghost-prop@example.com" });
    const prop = await properties.create({
      customerId: cust.id,
      customerName: "Ghost Run",
      address: "100 Main St, Newmarket, ON"
    });
    writeLead("completed");
    const res = await createWO({ type: "service_visit", propertyId: prop.id });
    ok("a genuine extra visit is still created against the PROPERTY",
      res.status === 200 && res.data.ok && res.data.workOrder?.id,
      `${res.status} ${JSON.stringify(res.data).slice(0, 140)}`);
    ok("…and it is not attached to the dead booking's lead",
      res.data.workOrder && res.data.workOrder.leadId !== LEAD_ID,
      String(res.data.workOrder?.leadId));
  }
} finally {
  child.kill("SIGKILL");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, buf);
  }
}

if (failures.length) {
  console.error(`\n✗ test-wo-dead-booking: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-wo-dead-booking: ${pass} assertions passed`);
