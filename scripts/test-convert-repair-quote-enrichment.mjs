#!/usr/bin/env node
// scripts/test-convert-repair-quote-enrichment.mjs
//
// POST /api/quotes/:id/convert-to-project — repair-type quotes (on_site
// quote / ai_repair_quote) now get the SAME enrichment project_proposal
// quotes always got, instead of a bare project.
//
// Patrick: "I believe I have scoped the quote so that we can also do
// 'repairs' which allow us to assess an entire project, and compose the
// repairs. I think it should remain." — he walks a property, bundles
// several repairs into one on_site_quote (built from a Work Order's
// "Issues → Draft Quote" tool), and expects to keep that as a Project
// after it's accepted. Before this change, convert-to-project only gave
// project_proposal quotes the rich path (projects.createFromProposal:
// tasks seeded from line items, proposalSnapshot with totals/accepted
// date, attachments) — every other type fell into a bare
// projects.create({name, ..., sourceQuoteId}) with NOTHING else. The
// project page's "Accepted proposal" panel is gated entirely on
// proposalSnapshot being non-null, so a converted repair-quote project
// showed no line items, no totals, nothing — the composed repair list
// was reachable only by clicking back into the original quote.
//
// This pins:
//   1. An on_site_quote-shaped quote with several line items, converted,
//      produces a project with tasks[] seeded (one per line item) AND a
//      populated proposalSnapshot (totals, quoteId, acceptedAt) — same
//      fidelity as a project_proposal conversion.
//   2. An ai_repair_quote gets the same treatment.
//   3. project_proposal conversion is unchanged (regression guard — this
//      is the ORIGINAL, already-working path).
//   4. A quote with NO line items still converts cleanly (empty
//      tasks[], no crash) — the common trivial case.
//
// Drives the real endpoint against a booted server.
//
// Run: node scripts/test-convert-repair-quote-enrichment.mjs
//      (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4812;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["projects.json", "quotes.json", "users.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
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
  await users.create({ email: "repair-convert-probe@local.test", name: "Repair Convert Probe", role: "admin", password: "repair-convert-probe-12345" });
  const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "repair-convert-probe@local.test", password: "repair-convert-probe-12345" })
  });
  const cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0])
    .find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("a throwaway admin can log in", login.ok && Boolean(cookie), `${login.status}`);

  const quotes = require(path.join(ROOT, "server", "lib", "quotes.js"));

  const convert = async (quoteId) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/quotes/${encodeURIComponent(quoteId)}/convert-to-project`, {
      method: "POST",
      headers: { cookie }
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  // ---- 1. on_site_quote — multi-repair, composed from a property visit
  {
    const quote = await quotes.create({
      type: "on_site_quote",
      customerEmail: "onsite-repair-probe@example.com",
      scope: "Spring assessment — repairs found",
      lineItems: [
        { id: "li_1", label: "Replace cracked valve, zone 3", qty: 1, unitPrice: 18500 },
        { id: "li_2", label: "Re-nozzle 6 heads, front bed", qty: 6, unitPrice: 4200 },
        { id: "li_3", label: "Repair mainline leak near driveway", qty: 1, unitPrice: 32000 }
      ],
      subtotal: 75700,
      hst: 9841,
      total: 85541
    });
    await quotes.accept(quote.id, { by: "customer" });

    const res = await convert(quote.id);
    ok("on_site_quote converts successfully", res.status === 201 && res.data.ok, `${res.status} ${JSON.stringify(res.data).slice(0, 150)}`);
    const proj = res.data.project;
    ok("…tasks[] seeded, one per line item", Array.isArray(proj?.tasks) && proj.tasks.length === 3, `got ${proj?.tasks?.length}`);
    ok("…task descriptions match the repair line labels", proj.tasks.map((t) => t.description).join("|") ===
      "Replace cracked valve, zone 3|Re-nozzle 6 heads, front bed|Repair mainline leak near driveway");
    ok("…every seeded task starts pending", proj.tasks.every((t) => t.status === "pending"));
    ok("…proposalSnapshot is populated (drives the Accepted panel)", proj.proposalSnapshot != null && proj.proposalSnapshot.quoteId === quote.id);
    ok("…snapshot totals match the quote", proj.proposalSnapshot.total === 85541 && proj.proposalSnapshot.subtotal === 75700);
    ok("…sourceQuoteId set", proj.sourceQuoteId === quote.id);
  }

  // ---- 2. ai_repair_quote — same treatment ------------------------------
  {
    const quote = await quotes.create({
      type: "ai_repair_quote",
      customerEmail: "ai-repair-probe@example.com",
      lineItems: [
        { id: "li_1", label: "Replace solenoid, zone 5", qty: 1, unitPrice: 9500 }
      ],
      subtotal: 9500,
      hst: 1235,
      total: 10735
    });
    await quotes.accept(quote.id, { by: "customer" });

    const res = await convert(quote.id);
    ok("ai_repair_quote converts with the same enrichment", res.status === 201 && res.data.ok);
    ok("…one task seeded", res.data.project?.tasks?.length === 1);
    ok("…proposalSnapshot populated", res.data.project?.proposalSnapshot?.quoteId === quote.id);
  }

  // ---- 3. project_proposal — unchanged (regression guard) --------------
  {
    const quote = await quotes.create({
      type: "project_proposal",
      customerEmail: "install-probe@example.com",
      branch: "direct_residential",
      lineItems: [{ id: "li_1", label: "Full 8-zone install", qty: 1, unitPrice: 850000 }],
      subtotal: 850000,
      hst: 110500,
      total: 960500
    });
    await quotes.accept(quote.id, { by: "customer" });

    const res = await convert(quote.id);
    ok("project_proposal still converts (unchanged path)", res.status === 201 && res.data.ok);
    ok("…still gets branch on the project", res.data.project?.branch === "direct_residential");
    ok("…still gets its task seeded", res.data.project?.tasks?.length === 1);
  }

  // ---- 4. no line items — clean, no crash -------------------------------
  {
    const quote = await quotes.create({
      type: "on_site_quote",
      customerEmail: "empty-repair-probe@example.com",
      lineItems: [],
      subtotal: 0,
      hst: 0,
      total: 0
    });
    await quotes.accept(quote.id, { by: "customer" });

    const res = await convert(quote.id);
    ok("an empty-line-item quote still converts cleanly", res.status === 201 && res.data.ok, `${res.status} ${JSON.stringify(res.data).slice(0, 150)}`);
    ok("…with an empty tasks array, not a crash", Array.isArray(res.data.project?.tasks) && res.data.project.tasks.length === 0);
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
  console.error(`\n✗ test-convert-repair-quote-enrichment: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-convert-repair-quote-enrichment: ${pass} assertions passed`);
