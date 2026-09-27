#!/usr/bin/env node
// scripts/test-quote-lifecycle-billing.mjs
//
// A SIGNED CHANGE ORDER MUST BE BILLED, AND AN UNSIGNED ONE MUST NOT
// DISPLACE THE AGREEMENT THAT GOVERNS THE JOB.
//
// Proven on main before this change (2026-09-27): original $5,000 accepted
// → change order approved → revision Q-v2 generated → customer SIGNED it at
// $5,400 → project completed → final invoice $5,000 "from proposal Q-v1".
// The $400 vanished. Three causes, one lifecycle:
//
//   1. Billing read proposalSnapshot, frozen once at conversion and never
//      updated, so a signed revision was never billed.
//   2. createRevision flipped the ACCEPTED original to "superseded" the
//      moment an unsigned DRAFT existed — so a draft the customer never
//      signed erased the agreement governing the job.
//   3. Every change order revised project.sourceQuoteId — the ORIGINAL —
//      so the second change order failed ("already superseded"), and on a
//      fixed-price job the project could never complete.
//
// Patrick's lifecycle (2026-09-27):
//   draft created             → original stays Accepted
//   customer rejects/abandons → original stays Accepted
//   customer signs revision   → atomically: previous → Superseded,
//                               revision → Accepted, project → revision,
//                               billing snapshot → revision, hold clears
//   final invoice             → newest accepted/signed quote in the chain;
//                               on-site additions still added exactly once
//
// Every scenario runs through the real library functions and, for billing,
// the real completion cascade that writes the real invoice.
//
// Run: node scripts/test-quote-lifecycle-billing.mjs   (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4857;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.error("  FAIL " + name + (detail ? ` — ${detail}` : "")); }
};
// One scenario throwing (e.g. on the old code) must not hide the others.
async function scenario(title, fn) {
  console.log(`\n  -- ${title} --`);
  try { await fn(); }
  catch (err) { ok(`${title}: runs without throwing`, false, String(err && err.message || err).slice(0, 200)); }
}

// Everything this file writes lives in server/data; snapshot it all and
// put it back, including files the run creates.
fs.mkdirSync(DATA, { recursive: true });
const before = new Set(fs.readdirSync(DATA));
const backups = new Map([...before].filter((f) => f.endsWith(".json")).map((f) => [f, fs.readFileSync(path.join(DATA, f))]));
const restore = () => {
  for (const f of fs.readdirSync(DATA)) if (!before.has(f)) fs.rmSync(path.join(DATA, f), { recursive: true, force: true });
  for (const [f, b] of backups) fs.writeFileSync(path.join(DATA, f), b);
};

const quotes = require(path.join(ROOT, "server", "lib", "quotes.js"));
const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
const invoices = require(path.join(ROOT, "server", "lib", "invoices.js"));
const workOrders = require(path.join(ROOT, "server", "lib", "work-orders.js"));

const SIG = { customerName: "Adaeze Okonkwo-Hall", imageData: "data:image/png;base64,iVBORw0KGgo=", ip: "203.0.113.7", userAgent: "test" };
const money = (n) => Math.round(Number(n || 0) * 100) / 100;
const invoiceSubtotal = (inv) => money((inv.lineItems || []).reduce((s, l) => s + Number(l.qty || 1) * Number(l.price ?? l.unitPrice ?? 0), 0));
const invoiceLabels = (inv) => (inv.lineItems || []).map((l) => l.label);
const rawQuotes = () => JSON.parse(fs.readFileSync(path.join(DATA, "quotes.json"), "utf8"));
const writeRawQuotes = (all) => fs.writeFileSync(path.join(DATA, "quotes.json"), JSON.stringify(all, null, 2));
const rawProjects = () => JSON.parse(fs.readFileSync(path.join(DATA, "projects.json"), "utf8"));
const writeRawProjects = (all) => fs.writeFileSync(path.join(DATA, "projects.json"), JSON.stringify(all, null, 2));

// A signed $5,000 fixed-price job, converted to a project.
async function signedJob(label = "Base install", price = 5000) {
  let q = await quotes.create({
    type: "project_proposal", status: "sent", customerEmail: "adaeze@example.test",
    branch: "direct_residential", billingMode: "fixed_price",
    lineItems: [{ label, qty: 1, price }]
  });
  q = await quotes.recordPortalSignAcceptance(q.id, SIG);
  const proj = await projects.createFromProposal(q, { customerName: "Adaeze Okonkwo-Hall", customerEmail: "adaeze@example.test" });
  return { q1: q, proj };
}
// Raise, send and approve one change order, then generate its revision.
async function changeOrder(projId, description, price) {
  const s = await projects.createScopeChangeRequest(projId, { description, suggestedLineItems: [{ label: description, qty: 1, price }] });
  await projects.sendScopeChangeRequest(projId, s.id, { deliver: async () => {} }); // email "delivered"
  await projects.resolveScopeChangeRequest(projId, s.id, { resolution: "approved" });
  const rev = await projects.generateQuoteRevisionFromScopeChange(projId, s.id);
  return { scrId: s.id, rev };
}
const blockers = async (projId) => (await projects.completionPreflight(projId)).blockers.map((b) => b.key);
async function complete(projId, opts = {}) {
  const result = await projects.completeProject(projId, { by: "Marguerite Sowande", deps: {}, ...opts });
  return result.invoiceId ? invoices.get(result.invoiceId) : null;
}

try {
  // ====================================================================
  await scenario("1. unsigned $5,400 revision → the job stays on the $5,000 agreement and completion is held", async () => {
    const { q1, proj } = await signedJob();
    const { rev } = await changeOrder(proj.id, "Add drip zone", 400);
    ok("the revision is a draft at $5,400", rev.status === "draft" && money((await quotes.get(rev.id)).subtotal) === 5400,
      `${rev.status} ${(await quotes.get(rev.id)).subtotal}`);
    const orig = await quotes.get(q1.id);
    ok("creating the draft leaves the ORIGINAL Accepted (not superseded)", orig.status === "accepted", orig.status);
    ok("...and the original has no supersededBy yet", !orig.supersededBy, String(orig.supersededBy));
    // The project page's quote panel reads resolveRevisionChain. With no
    // supersededBy to follow, it must still find the revision in progress.
    const panel = await quotes.resolveRevisionChain(q1.id);
    ok("the project's quote panel shows the revision in progress", panel && panel.current.id === rev.id && panel.chain.length === 2,
      panel ? `${panel.current.id} of ${panel.chain.map((q) => q.id)}` : "null");
    const b = await blockers(proj.id);
    ok("completion is BLOCKED while the $5,400 revision is unsigned", b.includes("revision_unsigned"), JSON.stringify(b));
    let threw = null;
    try { await complete(proj.id); } catch (e) { threw = e; }
    ok("...and completeProject refuses (no invoice written)", threw && threw.code === "preflight_blockers", threw ? threw.code : "completed");
  });

  // ====================================================================
  await scenario("2. customer rejects the revision → the $5,000 original still governs", async () => {
    const { q1, proj } = await signedJob();
    const { rev } = await changeOrder(proj.id, "Add drip zone", 400);
    await quotes.decline(rev.id, { reason: "Not this year", by: "customer" });
    ok("the original is still Accepted after the rejection", (await quotes.get(q1.id)).status === "accepted");
    ok("the rejection lifts the hold", !(await blockers(proj.id)).includes("revision_unsigned"), JSON.stringify(await blockers(proj.id)));
    const inv = await complete(proj.id);
    const panel = await quotes.resolveRevisionChain(q1.id);
    ok("the quote panel shows the $5,000 agreement, not the rejected draft", panel && panel.current.id === q1.id, panel ? panel.current.id : "null");
    ok("the final invoice bills the $5,000 original", inv && invoiceSubtotal(inv) === 5000, inv ? `${invoiceSubtotal(inv)} ${invoiceLabels(inv)}` : "no invoice");
    ok("...and none of the rejected change order", inv && !invoiceLabels(inv).includes("Add drip zone"));
  });

  // ====================================================================
  await scenario("3. customer signs the revision → one atomic switch, and the invoice bills $5,400", async () => {
    const { q1, proj } = await signedJob();
    const { rev } = await changeOrder(proj.id, "Add drip zone", 400);
    await quotes.recordPortalSignAcceptance(rev.id, SIG);
    const o = await quotes.get(q1.id), r = await quotes.get(rev.id), p = await projects.get(proj.id);
    ok("the previous quote is now Superseded, by the signed revision", o.status === "superseded" && o.supersededBy === rev.id, `${o.status} → ${o.supersededBy}`);
    ok("the revision is Accepted", r.status === "accepted", r.status);
    ok("the project points to the revision", p.currentQuoteId === rev.id, String(p.currentQuoteId));
    ok("...while keeping the original as its source (deposits and history key on it)", p.sourceQuoteId === q1.id, String(p.sourceQuoteId));
    ok("the billing snapshot is the revision's", p.proposalSnapshot && p.proposalSnapshot.quoteId === rev.id && money(p.proposalSnapshot.subtotal) === 5400,
      JSON.stringify({ id: p.proposalSnapshot?.quoteId, sub: p.proposalSnapshot?.subtotal }));
    ok("the hold has cleared", !(await blockers(proj.id)).includes("revision_unsigned"), JSON.stringify(await blockers(proj.id)));
    const inv = await complete(proj.id);
    ok("the final invoice bills $5,400", inv && invoiceSubtotal(inv) === 5400, inv ? `${invoiceSubtotal(inv)} ${invoiceLabels(inv)}` : "no invoice");
  });

  // ====================================================================
  await scenario("4. a second signed change → the invoice bills the newest cumulative total", async () => {
    const { proj } = await signedJob();
    const a = await changeOrder(proj.id, "Add drip zone", 400);
    await quotes.recordPortalSignAcceptance(a.rev.id, SIG);
    const b = await changeOrder(proj.id, "Two extra heads", 150);
    ok("the second change order DOES produce a revision", Boolean(b.rev && b.rev.id), String(b.rev && b.rev.id));
    ok("...built on the first revision, not the original", (await quotes.get(b.rev.id)).revisionOf === a.rev.id, (await quotes.get(b.rev.id)).revisionOf);
    const lines = (await quotes.get(b.rev.id)).lineItems.map((l) => l.label);
    ok("every earlier line appears EXACTLY once", ["Base install", "Add drip zone", "Two extra heads"].every((x) => lines.filter((y) => y === x).length === 1),
      JSON.stringify(lines));
    await quotes.recordPortalSignAcceptance(b.rev.id, SIG);
    const inv = await complete(proj.id);
    ok("the final invoice bills $5,550 (5,000 + 400 + 150)", inv && invoiceSubtotal(inv) === 5550, inv ? `${invoiceSubtotal(inv)} ${invoiceLabels(inv)}` : "no invoice");
  });

  // ====================================================================
  await scenario("5. the original's lines, signature and PDF never change", async () => {
    const { q1, proj } = await signedJob();
    // Freeze a PDF on the original, as a real send does.
    const all = rawQuotes(); const r0 = all.find((x) => x.id === q1.id);
    r0.pdfPath = `server/data/quote-pdfs/${q1.id}.pdf`; r0.pdfSha256 = "a".repeat(64); writeRawQuotes(all);
    const frozen = (q) => JSON.stringify({
      lineItems: q.lineItems, subtotal: q.subtotal, hst: q.hst, total: q.total,
      signature: q.signature, acceptanceEvidence: q.acceptanceEvidence, acceptanceMethod: q.acceptanceMethod,
      acceptedAt: q.acceptedAt, pdfPath: q.pdfPath, pdfSha256: q.pdfSha256, proposalSections: q.proposalSections
    });
    const before1 = frozen(await quotes.get(q1.id));
    const { rev } = await changeOrder(proj.id, "Add drip zone", 400);
    ok("unchanged after the revision is drafted", frozen(await quotes.get(q1.id)) === before1);
    await quotes.recordPortalSignAcceptance(rev.id, SIG);
    ok("unchanged after the revision is signed (only its status/lineage move)", frozen(await quotes.get(q1.id)) === before1);
  });

  // ====================================================================
  await scenario("6. double-clicking or retrying Generate revision creates ONE quote", async () => {
    const { proj } = await signedJob();
    const s = await projects.createScopeChangeRequest(proj.id, { description: "Add drip zone", suggestedLineItems: [{ label: "Add drip zone", qty: 1, price: 400 }] });
    await projects.sendScopeChangeRequest(proj.id, s.id, { deliver: async () => {} });
    await projects.resolveScopeChangeRequest(proj.id, s.id, { resolution: "approved" });
    const countBefore = rawQuotes().length;
    // Force the collision instead of hoping for it: hold every revision
    // write open for 60 ms, so the second click is guaranteed to arrive
    // while the first is still in flight. Without this the two calls
    // happened not to overlap and the check passed on the unfixed code.
    const realCreateRevision = quotes.createRevision;
    let revisionsCreated = 0;
    quotes.createRevision = async (...args) => { await new Promise((r) => setTimeout(r, 60)); revisionsCreated += 1; return realCreateRevision(...args); };
    let settled;
    try {
      settled = await Promise.allSettled([
        projects.generateQuoteRevisionFromScopeChange(proj.id, s.id),
        projects.generateQuoteRevisionFromScopeChange(proj.id, s.id)
      ]);
    } finally { quotes.createRevision = realCreateRevision; }
    const ids = settled.filter((x) => x.status === "fulfilled").map((x) => x.value.id);
    // Counting quotes in the file is NOT enough: on the unfixed code both
    // clicks built a revision, both took the SAME next quote number, and
    // the second write silently overwrote the first — so the file showed
    // "one". Count how many revisions were actually built.
    ok("a simultaneous double click builds exactly ONE revision", revisionsCreated === 1, `${revisionsCreated} built`);
    ok("...and exactly one new quote is on file", rawQuotes().length === countBefore + 1, `${rawQuotes().length - countBefore} on file`);
    ok("...and both clicks get that same quote back", ids.length === 2 && ids[0] === ids[1], JSON.stringify(settled.map((x) => x.status === "fulfilled" ? x.value.id : x.reason.message)));
    const retry = await projects.generateQuoteRevisionFromScopeChange(proj.id, s.id);
    ok("a later retry returns the same quote, not a new one", retry.id === ids[0] && rawQuotes().length === countBefore + 1, retry.id);
    const lines = (await quotes.get(retry.id)).lineItems.map((l) => l.label);
    ok("...and its lines are not duplicated", lines.filter((x) => x === "Add drip zone").length === 1, JSON.stringify(lines));
  });

  // ====================================================================
  await scenario("7. legacy chains (original superseded too early, by the OLD code) resolve to the newest valid signed quote", async () => {
    // (a) Old code superseded the signed original when an unsigned draft
    //     was created. The signed original must still govern.
    {
      const { q1, proj } = await signedJob();
      const { rev } = await changeOrder(proj.id, "Add drip zone", 400);
      const all = rawQuotes(); const o = all.find((x) => x.id === q1.id);
      o.status = "superseded"; o.supersededBy = rev.id; writeRawQuotes(all);
      ok("(a) an unsigned draft on a legacy chain still holds completion", (await blockers(proj.id)).includes("revision_unsigned"), JSON.stringify(await blockers(proj.id)));
      await quotes.decline(rev.id, { reason: "no", by: "customer" });
      const inv = await complete(proj.id);
      ok("(a) with the draft rejected, the signed original governs: $5,000", inv && invoiceSubtotal(inv) === 5000, inv ? String(invoiceSubtotal(inv)) : "no invoice");
    }
    // (b) Old code, revision signed: the project's snapshot is still the
    //     original's. Billing must follow the chain, not the stale snapshot.
    {
      const { q1, proj } = await signedJob();
      const { rev } = await changeOrder(proj.id, "Add drip zone", 400);
      const all = rawQuotes();
      const o = all.find((x) => x.id === q1.id); o.status = "superseded"; o.supersededBy = rev.id;
      const r = all.find((x) => x.id === rev.id); r.status = "accepted"; r.acceptedAt = new Date().toISOString(); r.acceptanceMethod = "portal_esign";
      r.acceptanceEvidence = { method: "portal_esign", signedAt: r.acceptedAt };
      writeRawQuotes(all);
      const p = rawProjects().find((x) => x.id === proj.id);
      ok("(b) setup: the stale snapshot still names the original", p.proposalSnapshot.quoteId === q1.id);
      // The Complete dialog's preview and the invoice share one source.
      const preview = await projects.fixedPriceBillingSource(await projects.get(proj.id));
      const previewSum = money(preview.lineItems.reduce((s, l) => s + Number(l.qty || 1) * Number(l.price || 0), 0));
      ok("(b) the Complete dialog's preview shows $5,400 too", previewSum === 5400, String(previewSum));
      const inv = await complete(proj.id);
      ok("(b) billing follows the chain to the signed revision: $5,400", inv && invoiceSubtotal(inv) === 5400, inv ? String(invoiceSubtotal(inv)) : "no invoice");
    }
  });

  // ====================================================================
  await scenario("8. a manual completion override needs a reason, and is audited", async () => {
    const { proj } = await signedJob();
    await changeOrder(proj.id, "Add drip zone", 400); // leaves an unsigned revision → blocked
    let threw = null;
    try { await complete(proj.id, { allowOverride: true }); } catch (e) { threw = e; }
    ok("override WITHOUT a reason is refused", threw && threw.code === "override_reason_required", threw ? threw.code : "completed");
    threw = null;
    try { await complete(proj.id, { allowOverride: true, overrideReason: "   " }); } catch (e) { threw = e; }
    ok("...a blank reason counts as no reason", threw && threw.code === "override_reason_required", threw ? threw.code : "completed");
    const inv = await complete(proj.id, { allowOverride: true, overrideReason: "Customer signed on paper; uploading later" });
    ok("override WITH a reason completes", Boolean(inv));
    const p = await projects.get(proj.id);
    const entry = (p.history || []).find((h) => h.action === "completion_override");
    ok("the override is in the project's audit history", Boolean(entry), JSON.stringify((p.history || []).slice(-3)));
    ok("...naming who, why, and which blockers were overridden",
      entry && entry.by === "Marguerite Sowande" && /paper/.test(entry.note || entry.reason || "") && /revision_unsigned/.test(JSON.stringify(entry)),
      JSON.stringify(entry));
  });

  // ====================================================================
  await scenario("9. separate on-site additions are still billed exactly once", async () => {
    const { proj } = await signedJob();
    const { rev } = await changeOrder(proj.id, "Add drip zone", 400);
    await quotes.recordPortalSignAcceptance(rev.id, SIG);
    // An on-site quote accepted on a build work order (the other add-on path).
    const onsite = await quotes.create({ type: "on_site_quote", status: "accepted", customerEmail: "adaeze@example.test",
      lineItems: [{ label: "Replace cracked valve box", qty: 1, price: 200 }] });
    const wo = await workOrders.create({ type: "build", project: await projects.get(proj.id), workDate: "2026-09-24" });
    await projects.attachWorkOrder(proj.id, wo.id);
    const store = path.join(DATA, "work-orders.json");
    const all = JSON.parse(fs.readFileSync(store, "utf8")); all.find((w) => w.id === wo.id).onSiteQuote = { quoteId: onsite.id, status: "accepted" };
    fs.writeFileSync(store, JSON.stringify(all, null, 2));
    const inv = await complete(proj.id);
    const labels = inv ? invoiceLabels(inv) : [];
    ok("the on-site addition appears once", labels.filter((l) => /valve box/i.test(l)).length === 1, JSON.stringify(labels));
    ok("the signed change order appears once", labels.filter((l) => l === "Add drip zone").length === 1, JSON.stringify(labels));
    ok("total = $5,400 revision + $200 on-site = $5,600", inv && invoiceSubtotal(inv) === 5600, inv ? String(invoiceSubtotal(inv)) : "no invoice");
  });

  // ====================================================================
  await scenario("10. a deposit job whose balance invoice predates a signed revision is held, not under-billed", async () => {
    const { q1, proj } = await signedJob();
    const bal = await invoices.createDraft({ quoteId: q1.id, lineItems: [{ key: "balance", label: "Balance of Q", qty: 1, price: 2500 }], invoiceRole: "balance" });
    const all = rawQuotes(); all.find((x) => x.id === q1.id).deposit = { enabled: true, mode: "percent", value: 50, balanceInvoiceId: bal.id }; writeRawQuotes(all);
    const { rev } = await changeOrder(proj.id, "Add drip zone", 400);
    await quotes.recordPortalSignAcceptance(rev.id, SIG);
    const b = await blockers(proj.id);
    ok("completion is blocked with an explicit deposit-balance reason", b.includes("deposit_balance_predates_revision"), JSON.stringify(b));
  });

  // ====================================================================
  // The override is a money gate: only the office may use it.
  await scenario("11. a technician cannot override the completion hold; converting a signed revision makes no second project", async () => {
    const child = spawn("node", [path.join(ROOT, "server", "server.js")], {
      cwd: ROOT, env: { PATH: process.env.PATH, TZ: "America/Toronto", PORT: String(PORT), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"]
    });
    let logs = ""; child.stdout.on("data", (c) => { logs += c; }); child.stderr.on("data", (c) => { logs += c; });
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) { await new Promise((r) => setTimeout(r, 200)); try { await fetch(`${BASE}/api/booking/services`); up = true; } catch {} }
      if (!up) throw new Error("server never came up:\n" + logs.slice(-800));
      const users = require(path.join(ROOT, "server", "lib", "users.js"));
      fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
      await users.create({ email: "tech@local.test", name: "Tobias Vantol", role: "tech", password: "tech-probe-12345" });
      const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "tech@local.test", password: "tech-probe-12345" }) });
      const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
      ok("(setup) a technician can sign in", login.ok && Boolean(cookie), String(login.status));
      const { proj } = await signedJob();
      await changeOrder(proj.id, "Add drip zone", 400);
      const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/complete`, {
        method: "POST", headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ allowOverride: true, overrideReason: "tech says fine" })
      });
      ok("a technician's override is refused with 403", r.status === 403, String(r.status));
      ok("...and the project is not completed", (await projects.get(proj.id)).status !== "complete", (await projects.get(proj.id)).status);

      // "Convert to project" on the signed revision of a job that already
      // has a project: the same job, so the same project — never a second
      // one to bill.
      await users.create({ email: "office@local.test", name: "Odessa Brightwater", role: "admin", password: "office-probe-12345" });
      const olog = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "office@local.test", password: "office-probe-12345" }) });
      const ocookie = (olog.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
      ok("(setup) the office can sign in", olog.ok && Boolean(ocookie), String(olog.status));
      const revId = (await projects.get(proj.id)).scopeChangeRequests.find((x) => x.linkedRevisionQuoteId).linkedRevisionQuoteId;
      await quotes.recordPortalSignAcceptance(revId, SIG);
      const before = (await projects.list({ includeArchived: true })).length;
      const cv = await fetch(`${BASE}/api/quotes/${encodeURIComponent(revId)}/convert-to-project`, { method: "POST", headers: { "content-type": "application/json", cookie: ocookie }, body: "{}" });
      const cj = await cv.json().catch(() => ({}));
      ok("converting the signed revision returns the job's existing project", cv.ok && cj.alreadyExisted === true && cj.project?.id === proj.id,
        `${cv.status} ${JSON.stringify({ existed: cj.alreadyExisted, id: cj.project?.id })}`);
      ok("...and no second project exists", (await projects.list({ includeArchived: true })).length === before);
    } finally { child.kill("SIGTERM"); }
  });
} finally {
  restore();
}

console.log(`\nquote lifecycle + billing: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
