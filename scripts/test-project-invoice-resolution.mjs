#!/usr/bin/env node
// scripts/test-project-invoice-resolution.mjs
//
// GET /api/projects/:id — resolving the deposit/balance invoice for the
// Job tabs Invoice link (2026-09-21).
//
// Patrick, live, on a real job (PROJ-2026-0008): "this invoice is part of
// the project. it has the deposit on it. I-2026-0067" — reporting that
// the Invoice tab wasn't finding it. Root cause: the field the job-tabs
// resolution read, quote.depositInvoiceId, is a schema placeholder — the
// REAL link lives the other way around, on the invoice record
// (invoice.quoteId), set by whatever actually creates a deposit/balance
// invoice. Nothing had ever written quote.depositInvoiceId, so it read
// null for every quote that ever existed.
//
// Fixed: invoices.listByQuote() looks up invoices the right way, and the
// GET /api/projects/:id route now checks the WHOLE revision chain (a
// deposit is usually raised against whichever version was actually
// accepted, not necessarily today's current one) and prefers a balance
// invoice over a deposit invoice when both exist (the deposit already
// paid, waiting on the balance is the more current story).
//
// This pins:
//   1. A deposit invoice raised against the quote a project links to
//      directly (sourceQuoteId) resolves correctly.
//   2. STALE anchor + revision: the deposit invoice was raised against
//      v1 (the version actually accepted); the project's pointer names
//      v1 but a later v2 now exists. linkedQuote.id resolves to v2
//      (current), while depositInvoiceId still finds the v1 invoice —
//      the whole point of checking the chain, not just the current id.
//   3. A balance invoice is preferred over a deposit invoice when both
//      exist for the same quote.
//   4. No invoice at all — depositInvoiceId stays null, no crash.
//   5. A bystander project's quote/invoice never leaks onto another
//      project's resolution.
//
// Drives the real endpoint against a booted server.
//
// Run: node scripts/test-project-invoice-resolution.mjs
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
const PORT = 4816;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["projects.json", "quotes.json", "invoices.json", "users.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}

function readJson(file) {
  const p = path.join(DATA, file);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8") || "[]");
}
function writeJson(file, records) {
  fs.writeFileSync(path.join(DATA, file), JSON.stringify(records, null, 2) + "\n", "utf8");
}
function patchProject(id, patch) {
  writeJson("projects.json", readJson("projects.json").map((r) => (r.id === id ? { ...r, ...patch } : r)));
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
  await users.create({ email: "invoice-resolve-probe@local.test", name: "Invoice Resolve Probe", role: "admin", password: "invoice-resolve-probe-12345" });
  const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "invoice-resolve-probe@local.test", password: "invoice-resolve-probe-12345" })
  });
  const cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0])
    .find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("admin can log in", login.ok && Boolean(cookie), `${login.status}`);

  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const quotes = require(path.join(ROOT, "server", "lib", "quotes.js"));
  const invoices = require(path.join(ROOT, "server", "lib", "invoices.js"));

  const getProjectApi = async (id) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/projects/${encodeURIComponent(id)}`, { headers: { cookie }, cache: "no-store" });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  const makeProposal = async () => quotes.create({
    type: "project_proposal",
    customerEmail: `invoice-resolve-${Math.random().toString(36).slice(2)}@example.com`,
    branch: "direct_residential",
    lineItems: [{ id: "li_1", label: "Install", qty: 1, unitPrice: 500000 }],
    subtotal: 500000, hst: 65000, total: 565000
  });

  // ---- 1. direct link — deposit invoice resolves ------------------------
  {
    const quote = await makeProposal();
    await quotes.markSentForApproval(quote.id, { token: "tok-1", confirmedPresentation: "itemized" });
    const proj = await projects.create({ name: "Invoice resolution — direct", sourceQuoteId: quote.id });
    const inv = await invoices.createDraft({ quoteId: quote.id, invoiceRole: "deposit", customerEmail: "x@example.com", lineItems: [] });

    const res = await getProjectApi(proj.id);
    ok("resolves the deposit invoice for a direct quote link", res.data.linkedQuote?.depositInvoiceId === inv.id, JSON.stringify(res.data.linkedQuote));
  }

  // ---- 2. stale anchor + revision chain ----------------------------------
  {
    const v1 = await makeProposal();
    await quotes.markSentForApproval(v1.id, { token: "tok-2", confirmedPresentation: "itemized" });
    const depositInv = await invoices.createDraft({ quoteId: v1.id, invoiceRole: "deposit", customerEmail: "x@example.com", lineItems: [] });
    const v2 = await quotes.createRevision(v1.id, { by: "admin" });

    const proj = await projects.create({ name: "Invoice resolution — stale anchor" });
    patchProject(proj.id, { systemDesign: { linkedQuoteId: v1.id } }); // stale — still names v1

    const res = await getProjectApi(proj.id);
    ok("linkedQuote.id resolves to the CURRENT revision (v2), not the stale anchor", res.data.linkedQuote?.id === v2.id, JSON.stringify(res.data.linkedQuote));
    ok("…but depositInvoiceId still finds the invoice raised against v1", res.data.linkedQuote?.depositInvoiceId === depositInv.id, JSON.stringify(res.data.linkedQuote));
  }

  // ---- 3. balance invoice preferred over deposit -------------------------
  {
    const quote = await makeProposal();
    await quotes.markSentForApproval(quote.id, { token: "tok-3", confirmedPresentation: "itemized" });
    const depositInv = await invoices.createDraft({ quoteId: quote.id, invoiceRole: "deposit", customerEmail: "x@example.com", lineItems: [] });
    // Ensure a distinct, later createdAt so ordering is unambiguous.
    await new Promise((r) => setTimeout(r, 5));
    const balanceInv = await invoices.createDraft({ quoteId: quote.id, invoiceRole: "balance", customerEmail: "x@example.com", lineItems: [], depositMeta: { quoteId: quote.id, depositInvoiceId: depositInv.id, depositAmount: 100, depositPaidAt: new Date().toISOString(), grandTotal: 565000 } });
    const proj = await projects.create({ name: "Invoice resolution — balance preferred", sourceQuoteId: quote.id });

    const res = await getProjectApi(proj.id);
    ok("balance invoice wins over deposit once it exists", res.data.linkedQuote?.depositInvoiceId === balanceInv.id, JSON.stringify(res.data.linkedQuote));
  }

  // ---- 4. no invoice at all — stays null, no crash -----------------------
  {
    const quote = await makeProposal();
    await quotes.markSentForApproval(quote.id, { token: "tok-4", confirmedPresentation: "itemized" });
    const proj = await projects.create({ name: "Invoice resolution — none yet", sourceQuoteId: quote.id });

    const res = await getProjectApi(proj.id);
    ok("no invoice yet → depositInvoiceId is null, not a crash", res.status === 200 && res.data.linkedQuote?.depositInvoiceId === null, JSON.stringify(res.data.linkedQuote));
  }

  // ---- 5. bystander isolation ---------------------------------------------
  {
    const quoteA = await makeProposal();
    await quotes.markSentForApproval(quoteA.id, { token: "tok-5a", confirmedPresentation: "itemized" });
    const invA = await invoices.createDraft({ quoteId: quoteA.id, invoiceRole: "deposit", customerEmail: "a@example.com", lineItems: [] });
    const projA = await projects.create({ name: "Invoice resolution — bystander A", sourceQuoteId: quoteA.id });

    const quoteB = await makeProposal();
    await quotes.markSentForApproval(quoteB.id, { token: "tok-5b", confirmedPresentation: "itemized" });
    const projB = await projects.create({ name: "Invoice resolution — bystander B (no invoice)", sourceQuoteId: quoteB.id });

    const resA = await getProjectApi(projA.id);
    const resB = await getProjectApi(projB.id);
    ok("project A resolves its own invoice", resA.data.linkedQuote?.depositInvoiceId === invA.id);
    ok("project B does NOT pick up project A's invoice", resB.data.linkedQuote?.depositInvoiceId === null, JSON.stringify(resB.data.linkedQuote));
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
  console.error(`\n✗ test-project-invoice-resolution: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-project-invoice-resolution: ${pass} assertions passed`);
