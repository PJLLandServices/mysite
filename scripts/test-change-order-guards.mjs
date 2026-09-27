// scripts/test-change-order-guards.mjs
//
// Follow-up to #338 (Patrick, 2026-09-27), before the first manual deploy:
//
//   "verify #338 does not allow withdrawal after the revised quote has
//    been signed or invoiced. At that point, reversing the change requires
//    another revision — not rewriting history. If an unsigned revision
//    draft exists when a change is withdrawn, its cancellation behavior
//    must also be explicit."
//
//   "'Send once' is protected by the persisted project lock/state, not
//    merely an in-memory flag. A server restart between sending and saving
//    must produce 'delivery uncertain', not silently allow duplicate
//    email."
//
// Pinned here:
//   A. In a SIGNED revision → withdraw refused, saying a new change order
//      is needed; nothing moves.
//   B. In an UNSIGNED revision → that revision is cancelled (retired as
//      superseded, so the customer's link refuses it), the change is
//      withdrawn, any other change in the same revision returns to
//      "approved — needs revised quote", the signed agreement stands.
//   C. The customer signs first → the withdrawal is refused (race).
//   D. Revision already declined → the change can simply be withdrawn.
//   E. Completed, invoiced job → every decision on its changes refused.
//   F. A trashed draft revision holds nothing and collects nothing.
//   G. A REAL crash between the email leaving and the result being saved →
//      the next send is refused as delivery_uncertain with no second email,
//      until the office records whether it arrived.
//
// Run: node scripts/test-change-order-guards.mjs   (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const STUB = path.join(ROOT, "scripts", "lib", "stub-outbound.cjs");
const OUTBOX = path.join(DATA, `test-co-guards-outbox-${process.pid}.jsonl`);
const PORT = 4869;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.error("  FAIL " + name + (detail ? ` — ${detail}` : "")); }
};
async function scenario(title, fn) {
  console.log(`\n  -- ${title} --`);
  try { await fn(); }
  catch (err) { ok(`${title}: runs without throwing`, false, String(err && err.message || err).slice(0, 200)); }
}

fs.mkdirSync(DATA, { recursive: true });
const before = new Set(fs.readdirSync(DATA));
const backups = new Map([...before].filter((f) => f.endsWith(".json")).map((f) => [f, fs.readFileSync(path.join(DATA, f))]));
const restore = () => {
  for (const f of fs.readdirSync(DATA)) if (!before.has(f)) fs.rmSync(path.join(DATA, f), { recursive: true, force: true });
  for (const [f, b] of backups) fs.writeFileSync(path.join(DATA, f), b);
};

const quotes = require(path.join(ROOT, "server", "lib", "quotes.js"));
const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
const users = require(path.join(ROOT, "server", "lib", "users.js"));

const SIG = { customerName: "Adaeze Okonkwo-Hall", imageData: "data:image/png;base64,iVBORw0KGgo=", ip: "203.0.113.7", userAgent: "test" };
const OFFICE = "Odessa Brightwater";
const DELIVERED = { by: OFFICE, deliver: async () => {} };

async function signedJob({ billingMode = "fixed_price", email = "adaeze@example.test" } = {}) {
  let q = await quotes.create({
    type: "project_proposal", status: "sent", customerEmail: email, branch: "direct_residential", billingMode,
    lineItems: [{ label: "Base install", qty: 1, price: 5000, lineTotal: 5000 }], subtotal: 5000, hst: 650, total: 5650
  });
  q = await quotes.recordPortalSignAcceptance(q.id, SIG);
  return { q1: q, proj: await projects.createFromProposal(q, { customerName: "Adaeze Okonkwo-Hall", customerEmail: email }) };
}
async function approvedChange(projId, description, price) {
  const s = await projects.createScopeChangeRequest(projId, { description, suggestedLineItems: [{ label: description, qty: 1, price }] }, { by: "Tobias Vantol" });
  await projects.resolveScopeChangeRequest(projId, s.id, { resolution: "approved" }, { by: OFFICE });
  return s;
}
const scr = async (projId, id) => (await projects.get(projId)).scopeChangeRequests.find((s) => s.id === id);
const blockers = async (projId) => (await projects.completionPreflight(projId)).blockers.map((b) => b.key);
const labels = (q) => (q.lineItems || []).map((l) => l.label);
async function refusal(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}
const emails = () => {
  try {
    return fs.readFileSync(OUTBOX, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.channel === "email");
  } catch { return []; }
};

let child;
try {
  // ====================================================================
  await scenario("A. in a SIGNED revision → withdraw refused; a new change order is the way out", async () => {
    const { q1, proj } = await signedJob();
    const c = await approvedChange(proj.id, "Drip zone", 400);
    const rev = await projects.generateQuoteRevisionFromScopeChange(proj.id, c.id, { by: OFFICE });
    await quotes.recordPortalSignAcceptance(rev.id, SIG);
    const e = await refusal(() => projects.resolveScopeChangeRequest(proj.id, c.id, { resolution: "withdrawn" }, { by: OFFICE }));
    ok("refused with scr_in_signed_agreement", e && e.code === "scr_in_signed_agreement", e ? e.code : "allowed");
    ok("...saying a new change order and a new signed revision are needed", e && /new change order/i.test(e.message) && e.message.includes(rev.id), e?.message);
    ok("the change is untouched", (await scr(proj.id, c.id)).status === "executed_under_revision");
    ok("the signed revision is untouched", (await quotes.get(rev.id)).status === "accepted");
    ok("the original stays superseded by it", (await quotes.get(q1.id)).supersededBy === rev.id);
  });

  // ====================================================================
  await scenario("B. in an UNSIGNED revision → that revision is cancelled, explicitly, and nothing else is lost", async () => {
    const { q1, proj } = await signedJob();
    const a = await approvedChange(proj.id, "Drip zone", 400);
    const rev = await projects.generateQuoteRevisionFromScopeChange(proj.id, a.id, { by: OFFICE });
    const b = await approvedChange(proj.id, "Extra head", 90);
    const same = await projects.generateQuoteRevisionFromScopeChange(proj.id, b.id, { by: OFFICE });
    ok("setup: both changes share one draft revision", same.id === rev.id && labels(await quotes.get(rev.id)).join("|") === "Base install|Drip zone|Extra head",
      labels(await quotes.get(rev.id)).join("|"));

    const w = await projects.resolveScopeChangeRequest(proj.id, a.id, { resolution: "withdrawn", note: "Customer changed their mind" }, { by: OFFICE });
    ok("the change is withdrawn, by the office, by name", w.status === "withdrawn" && w.resolvedAs === "withdrawn_by_office" && w.recordedBy === OFFICE);
    ok("...and remembers which revised quote it was pulled from", w.withdrawnFromRevisionQuoteId === rev.id);
    const r = await quotes.get(rev.id);
    ok("the unsigned revision is retired — the customer can no longer sign it", quotes.isSuperseded(r), r.status);
    ok("...its history says why", (r.history || []).some((h) => h.action === "revision_withdrawn" && h.note.includes(a.id)));
    ok("...its lines and totals are kept as they were (record, not rewrite)", labels(r).join("|") === "Base install|Drip zone|Extra head");
    ok("the signed original still governs", (await quotes.get(q1.id)).status === "accepted" && (await projects.resolveProjectQuote(await projects.get(proj.id))).governing?.id === q1.id);
    const other = await scr(proj.id, b.id);
    ok("the OTHER change in that revision goes back to approved — needs revised quote", other.status === "approved" && !other.linkedRevisionQuoteId, `${other.status} ${other.linkedRevisionQuoteId}`);
    ok("...and the project history says so", (await projects.get(proj.id)).history.some((h) => h.action === "scope_change_revision_cancelled" && h.note.includes(b.id)));
    const k = await blockers(proj.id);
    ok("no revision hold any more; the other change's hold is explicit", !k.includes("revision_unsigned") && k.includes("approved_scr_no_revision"), JSON.stringify(k));
    const again = await projects.generateQuoteRevisionFromScopeChange(proj.id, b.id, { by: OFFICE });
    ok("a fresh revision for the other change carries it — and not the withdrawn one", again.id !== rev.id && labels(again).join("|") === "Base install|Extra head", labels(again).join("|"));
  });

  // ====================================================================
  await scenario("C. the customer signs first → the withdrawal is refused", async () => {
    const { proj } = await signedJob();
    const c = await approvedChange(proj.id, "Drip zone", 400);
    const rev = await projects.generateQuoteRevisionFromScopeChange(proj.id, c.id, { by: OFFICE });
    await quotes.recordPortalSignAcceptance(rev.id, SIG);
    const e = await refusal(() => quotes.retireUnsignedRevision(rev.id, { by: OFFICE }));
    ok("retiring a signed revision is refused (revision_signed)", e && e.code === "revision_signed", e ? e.code : "allowed");
    ok("...and it stays signed", (await quotes.get(rev.id)).status === "accepted");
  });

  // ====================================================================
  await scenario("D. revision already declined → the change can simply be withdrawn", async () => {
    const { proj } = await signedJob();
    const c = await approvedChange(proj.id, "Drip zone", 400);
    const rev = await projects.generateQuoteRevisionFromScopeChange(proj.id, c.id, { by: OFFICE });
    await quotes.decline(rev.id, { reason: "Not this year", by: "customer" });
    const w = await projects.resolveScopeChangeRequest(proj.id, c.id, { resolution: "withdrawn" }, { by: OFFICE });
    ok("withdrawn", w.status === "withdrawn");
    ok("...the declined quote is left as the customer left it", (await quotes.get(rev.id)).status === "declined");
  });

  // ====================================================================
  await scenario("E. a completed, invoiced job: its change orders are closed", async () => {
    // Time & material: an approved change is not open, so the job completes.
    const { proj } = await signedJob({ billingMode: "time_and_material" });
    const all = JSON.parse(fs.readFileSync(path.join(DATA, "projects.json"), "utf8"));
    all.find((p) => p.id === proj.id).labourRateLocked = 95;
    fs.writeFileSync(path.join(DATA, "projects.json"), JSON.stringify(all, null, 2));
    const c = await approvedChange(proj.id, "Extra afternoon", 0);
    const pending = await projects.createScopeChangeRequest(proj.id, { description: "Late idea" }, { by: "Tobias Vantol" });
    await projects.completeProject(proj.id, { by: OFFICE, deps: {}, allowOverride: true, overrideReason: "Test: close the job" });
    ok("setup: the job is complete", (await projects.get(proj.id)).status === "complete");
    const e1 = await refusal(() => projects.resolveScopeChangeRequest(proj.id, c.id, { resolution: "withdrawn" }, { by: OFFICE }));
    ok("withdrawing an approved change after completion → project_closed", e1 && e1.code === "project_closed", e1 ? e1.code : "allowed");
    const e2 = await refusal(() => projects.resolveScopeChangeRequest(proj.id, pending.id, { resolution: "approved" }, { by: OFFICE }));
    ok("recording an approval after completion → project_closed", e2 && e2.code === "project_closed", e2 ? e2.code : "allowed");
    ok("...and nothing moved", (await scr(proj.id, c.id)).status === "approved" && (await scr(proj.id, pending.id)).status === "pending_admin_review");

    // Fixed price, in a signed revision, completed and invoiced.
    const j = await signedJob();
    const d = await approvedChange(j.proj.id, "Drip zone", 400);
    const rev = await projects.generateQuoteRevisionFromScopeChange(j.proj.id, d.id, { by: OFFICE });
    await quotes.recordPortalSignAcceptance(rev.id, SIG);
    await projects.completeProject(j.proj.id, { by: OFFICE, deps: {}, allowOverride: true, overrideReason: "Test: close the job" });
    const e3 = await refusal(() => projects.resolveScopeChangeRequest(j.proj.id, d.id, { resolution: "withdrawn" }, { by: OFFICE }));
    ok("an invoiced, signed change cannot be withdrawn", e3 && (e3.code === "project_closed" || e3.code === "scr_in_signed_agreement"), e3 ? e3.code : "allowed");
  });

  // ====================================================================
  await scenario("F. a trashed draft revision holds nothing and collects nothing", async () => {
    const { proj } = await signedJob();
    const a = await approvedChange(proj.id, "Drip zone", 400);
    const rev = await projects.generateQuoteRevisionFromScopeChange(proj.id, a.id, { by: OFFICE });
    await quotes.softDelete(rev.id, { adminId: OFFICE });
    ok("no revision hold for a trashed draft", !(await blockers(proj.id)).includes("revision_unsigned"), JSON.stringify(await blockers(proj.id)));
    const b = await approvedChange(proj.id, "Extra head", 90);
    const next = await projects.generateQuoteRevisionFromScopeChange(proj.id, b.id, { by: OFFICE });
    ok("the next change gets a new revision, not the trashed one", next.id !== rev.id && !labels(await quotes.get(rev.id)).includes("Extra head"));
  });

  // ====================================================================
  await scenario("G. a real crash between the email leaving and the result being saved", async () => {
    const { proj } = await signedJob({ email: "crash@example.test" });
    const s = await projects.createScopeChangeRequest(proj.id, { description: "Move the backflow", suggestedLineItems: [{ label: "Move", qty: 1, price: 250 }] }, { by: OFFICE });

    // A separate process sends — the email "goes" (written to the outbox) —
    // and the process dies before it can save the outcome.
    const crash = spawnSync(process.execPath, ["-e", `
      const fs = require("node:fs");
      const projects = require(${JSON.stringify(path.join(ROOT, "server", "lib", "projects.js"))});
      projects.sendScopeChangeRequest(${JSON.stringify(proj.id)}, ${JSON.stringify(s.id)}, {
        by: ${JSON.stringify(OFFICE)},
        deliver: async (email) => {
          fs.appendFileSync(${JSON.stringify(OUTBOX)}, JSON.stringify({ channel: "email", to: email.to, subject: email.subject }) + "\\n");
          process.exit(1); // the server stops here — the email is out, nothing saved
        }
      });
    `], { cwd: ROOT, env: { PATH: process.env.PATH, TZ: "America/Toronto" }, encoding: "utf8" });
    ok("setup: the sending process died", crash.status === 1, `${crash.status} ${crash.stderr?.slice(-200)}`);
    ok("setup: one email went out", emails().filter((e) => e.to === "crash@example.test").length === 1);
    const after = await scr(proj.id, s.id);
    ok("the interrupted send is on disk (not just in memory)", Boolean(after.sendInFlight) && after.sendInFlight.to === "crash@example.test", JSON.stringify(after.sendInFlight));
    ok("...and the change is not marked sent", after.status === "pending_admin_review" && !after.sentAt);

    // The server restarts; the office presses Send again.
    fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
    await users.create({ email: "office@local.test", name: OFFICE, role: "admin", password: "office-probe-12345" });
    await users.create({ email: "tech@local.test", name: "Tobias Vantol", role: "tech", password: "tech-probe-12345" });
    child = spawn("node", ["--require", STUB, path.join(ROOT, "server", "server.js")], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, TZ: "America/Toronto", PORT: String(PORT), HOST: "127.0.0.1", PUBLIC_BASE_URL: BASE,
        PJL_STUB_OUTBOX: OUTBOX, GMAIL_USER: "stub@pjl.test", GMAIL_APP_PASSWORD: "stub" }
    });
    let logs = ""; child.stdout.on("data", (c) => { logs += c; }); child.stderr.on("data", (c) => { logs += c; });
    let up = false;
    for (let i = 0; i < 75 && !up; i++) { await new Promise((r) => setTimeout(r, 200)); try { await fetch(`${BASE}/api/booking/services`); up = true; } catch {} }
    if (!up) throw new Error("server never came up:\n" + logs.slice(-800));
    const login = async (email, pw) => {
      const r = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: pw }) });
      return (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
    };
    const office = await login("office@local.test", "office-probe-12345");
    const tech = await login("tech@local.test", "tech-probe-12345");
    const post = async (cookie, p, body) => {
      const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}/scope-changes/${encodeURIComponent(s.id)}${p}`, {
        method: "POST", headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };

    const r1 = await post(office, "/send");
    ok("after the restart, Send is refused as delivery_uncertain", r1.status === 409 && r1.data.code === "delivery_uncertain", `${r1.status} ${r1.data.code}`);
    ok("...telling the office to check and record whether it arrived", /can't tell whether the email arrived/i.test(r1.data.errors?.[0] || ""), r1.data.errors?.[0]);
    ok("...and NO second email went", emails().filter((e) => e.to === "crash@example.test").length === 1, String(emails().filter((e) => e.to === "crash@example.test").length));

    const rt = await post(tech, "/send-outcome", { outcome: "sent" });
    ok("a technician cannot settle it (403)", rt.status === 403, String(rt.status));

    const r2 = await post(office, "/send-outcome", { outcome: "not_sent" });
    ok("the office records it did not arrive", r2.status === 200 && !r2.data.scopeChange?.sendInFlight && r2.data.scopeChange?.status === "pending_admin_review", `${r2.status} ${JSON.stringify(r2.data.errors || "")}`);
    const settledAttempt = (r2.data.scopeChange?.sendAttempts || []).find((a) => a.interrupted);
    ok("...the interrupted attempt is kept on record", settledAttempt && settledAttempt.ok === false && /Interrupted send/.test(settledAttempt.reason || ""));
    ok("...with who started it and when", settledAttempt?.by === OFFICE && settledAttempt?.at === after.sendInFlight.at, JSON.stringify(settledAttempt));
    ok("...and who settled it, when, and the outcome", settledAttempt?.settledBy === OFFICE && Boolean(Date.parse(settledAttempt?.settledAt)) && settledAttempt?.outcome === "confirmed_not_delivered",
      JSON.stringify(settledAttempt));
    const r3 = await post(office, "/send");
    ok("now it can be sent — once", r3.status === 200 && r3.data.scopeChange?.status === "pending_customer_approval", `${r3.status} ${JSON.stringify(r3.data.errors || "")}`);
    ok("...two emails in total: the crashed one and this one", emails().filter((e) => e.to === "crash@example.test").length === 2);

    // The other answer: it DID arrive.
    const { proj: p2 } = await signedJob({ email: "arrived@example.test" });
    const s2 = await projects.createScopeChangeRequest(p2.id, { description: "Add a zone" }, { by: OFFICE });
    const all = JSON.parse(fs.readFileSync(path.join(DATA, "projects.json"), "utf8"));
    all.find((p) => p.id === p2.id).scopeChangeRequests.find((x) => x.id === s2.id).sendInFlight = { at: "2026-09-27T12:00:00.000Z", by: OFFICE, to: "arrived@example.test" };
    fs.writeFileSync(path.join(DATA, "projects.json"), JSON.stringify(all, null, 2));
    const settled = await projects.resolveUncertainScopeSend(p2.id, s2.id, { outcome: "sent", by: OFFICE });
    ok("'it arrived' → awaiting the customer, dated when it went", settled.status === "pending_customer_approval" && settled.sentAt === "2026-09-27T12:00:00.000Z" && !settled.sendInFlight,
      `${settled.status} ${settled.sentAt}`);
    const arrived = settled.sendAttempts.find((a) => a.interrupted);
    ok("...recorded as confirmed delivered, by whom and when", arrived?.ok === true && arrived.outcome === "confirmed_delivered" && arrived.settledBy === OFFICE && Boolean(Date.parse(arrived.settledAt)),
      JSON.stringify(arrived));
  });
  // ====================================================================
  // Patrick: "Every acceptance function must, inside the same lock used by
  // withdrawal: confirm the quote is still signable; confirm it is the
  // active revision the customer is allowed to sign; reject cancelled,
  // trashed, superseded or replaced quotes."
  const SIGNERS = {
    accept: (id) => quotes.accept(id, { by: "customer" }),
    acceptWithSignature: (id) => quotes.acceptWithSignature(id, { customerName: "Adaeze", imageData: SIG.imageData, ip: SIG.ip, userAgent: "t" }),
    recordOfflineAcceptance: (id) => quotes.recordOfflineAcceptance(id, { customerName: "Adaeze", recordedBy: OFFICE }),
    recordPortalSignAcceptance: (id) => quotes.recordPortalSignAcceptance(id, SIG),
    recordPdfReturnAcceptance: (id) => quotes.recordPdfReturnAcceptance(id, { adminUser: OFFICE })
  };
  const rawQuotes = () => JSON.parse(fs.readFileSync(path.join(DATA, "quotes.json"), "utf8"));
  const writeRawQuotes = (all) => fs.writeFileSync(path.join(DATA, "quotes.json"), JSON.stringify(all, null, 2));
  // A fresh unsigned, sendable quote — with a staged PDF return, so the
  // PDF-return writer has something to attest.
  async function offer() {
    const q = await quotes.create({ type: "project_proposal", status: "sent", customerEmail: "adaeze@example.test", branch: "direct_residential", billingMode: "fixed_price",
      lineItems: [{ label: "Base install", qty: 1, price: 5000, lineTotal: 5000 }], subtotal: 5000, hst: 650, total: 5650 });
    const all = rawQuotes();
    all.find((x) => x.id === q.id).acceptanceEvidence = { method: "pdf_return", stagedAt: new Date().toISOString() };
    writeRawQuotes(all);
    return q;
  }
  const setRaw = (id, patch) => { const all = rawQuotes(); Object.assign(all.find((x) => x.id === id), patch); writeRawQuotes(all); };

  await scenario("H. every signing function refuses a quote that is no longer the offer", async () => {
    for (const [name, sign] of Object.entries(SIGNERS)) {
      // trashed
      const t = await offer();
      await quotes.softDelete(t.id, { adminId: OFFICE });
      let e = await refusal(() => sign(t.id));
      ok(`${name}: refuses a TRASHED quote`, e?.code === "quote_not_signable" && !(await quotes.get(t.id)).acceptedAt, e ? e.code : "signed");
      // cancelled
      const c = await offer(); setRaw(c.id, { status: "cancelled" });
      e = await refusal(() => sign(c.id));
      ok(`${name}: refuses a CANCELLED quote`, e?.code === "quote_not_signable" && (await quotes.get(c.id)).status === "cancelled", e ? e.code : "signed");
      // superseded — a withdrawn revision (retireUnsignedRevision)
      const { proj } = await signedJob();
      const ch = await approvedChange(proj.id, "Drip zone", 400);
      const rev = await projects.generateQuoteRevisionFromScopeChange(proj.id, ch.id, { by: OFFICE });
      setRaw(rev.id, { acceptanceEvidence: { method: "pdf_return", stagedAt: new Date().toISOString() } });
      await projects.resolveScopeChangeRequest(proj.id, ch.id, { resolution: "withdrawn" }, { by: OFFICE });
      e = await refusal(() => sign(rev.id));
      ok(`${name}: refuses a SUPERSEDED (withdrawn) revision`, e?.code === "quote_not_signable" && (await quotes.get(rev.id)).status === "superseded" && !(await quotes.get(rev.id)).acceptedAt,
        e ? e.code : "signed");
      ok(`${name}: ...and the job stays on its signed agreement`, (await projects.resolveProjectQuote(await projects.get(proj.id))).governing?.id !== rev.id);
      // replaced — an older unsigned version while a newer one is the offer
      const old = await offer();
      const newer = await offer();
      setRaw(newer.id, { revisionOf: old.id, version: 2 });
      e = await refusal(() => sign(old.id));
      ok(`${name}: refuses a REPLACED version (a newer offer exists)`, e?.code === "quote_not_signable" && /replaced by/.test(e.message) && !(await quotes.get(old.id)).acceptedAt,
        e ? `${e.code} ${e.message}` : "signed");
      // …while the current offer still signs normally.
      const good = await sign(newer.id);
      ok(`${name}: the current offer still signs`, good && quotes.hasAcceptanceRecord(good), good ? good.status : "null");
    }
  });

  // ====================================================================
  await scenario("H2. a customer's uploaded PDF is not a signature until the office attests it", async () => {
    const { q1, proj } = await signedJob();
    const ch = await approvedChange(proj.id, "Drip zone", 400);
    const rev = await projects.generateQuoteRevisionFromScopeChange(proj.id, ch.id, { by: OFFICE });
    await quotes.stagePdfReturn(rev.id, { buffer: Buffer.from("%PDF-1.4 test"), filename: "signed.pdf", senderEmail: "adaeze@example.test" });
    const staged = await quotes.get(rev.id);
    ok("setup: the revision is waiting for the office to attest the PDF", staged.status === "pending_admin_attestation", staged.status);
    ok("a staged PDF is not a signature", !quotes.hasAcceptanceRecord(staged));
    const chain = await projects.resolveProjectQuote(await projects.get(proj.id));
    ok("the job is still billed on the signed original, not the unattested revision", chain.governing?.id === q1.id, chain.governing?.id);
    ok("...and completion is still held for the revision", (await blockers(proj.id)).includes("revision_unsigned"));
    await quotes.recordPdfReturnAcceptance(rev.id, { adminUser: OFFICE });
    ok("once the office attests it, it is the signed agreement", (await projects.resolveProjectQuote(await projects.get(proj.id))).governing?.id === rev.id);
  });

  // ====================================================================
  await scenario("I. a withdrawal racing a signature ends in exactly ONE outcome", async () => {
    const outcomeOf = async (proj, ch, rev) => {
      const q = await quotes.get(rev.id), s = await scr(proj.id, ch.id);
      const gov = (await projects.resolveProjectQuote(await projects.get(proj.id))).governing;
      const signed = quotes.hasAcceptanceRecord(q) && q.status === "accepted" && gov?.id === rev.id && s.status === "executed_under_revision";
      const withdrawn = q.status === "superseded" && !quotes.hasAcceptanceRecord(q) && gov?.id !== rev.id && s.status === "withdrawn";
      return { signed, withdrawn };
    };
    const setup = async () => {
      const { proj } = await signedJob();
      const ch = await approvedChange(proj.id, "Drip zone", 400);
      const rev = await projects.generateQuoteRevisionFromScopeChange(proj.id, ch.id, { by: OFFICE });
      return { proj, ch, rev };
    };

    // 1. Forced worst case: the withdrawal has already decided "unsigned"
    //    when the customer's signature lands, just before it cancels.
    {
      const { proj, ch, rev } = await setup();
      const real = quotes.retireUnsignedRevision;
      quotes.retireUnsignedRevision = async (id, opts) => { await quotes.recordPortalSignAcceptance(id, SIG); return real(id, opts); };
      let e;
      try { e = await refusal(() => projects.resolveScopeChangeRequest(proj.id, ch.id, { resolution: "withdrawn" }, { by: OFFICE })); }
      finally { quotes.retireUnsignedRevision = real; }
      const o = await outcomeOf(proj, ch, rev);
      ok("signature lands mid-withdrawal → the signature wins, the withdrawal is refused", e?.code === "scr_in_signed_agreement" && o.signed && !o.withdrawn, `${e?.code} ${JSON.stringify(o)}`);
    }
    // 2. Forced the other way: the revision is cancelled, THEN the customer signs.
    {
      const { proj, ch, rev } = await setup();
      await projects.resolveScopeChangeRequest(proj.id, ch.id, { resolution: "withdrawn" }, { by: OFFICE });
      const e = await refusal(() => quotes.recordPortalSignAcceptance(rev.id, SIG));
      const o = await outcomeOf(proj, ch, rev);
      ok("cancelled first → the signature is refused", e?.code === "quote_not_signable" && o.withdrawn && !o.signed, `${e?.code} ${JSON.stringify(o)}`);
    }
    // 3. Truly simultaneous, both orders of issue, repeated: never both, never neither.
    let bothOrNeither = 0, signedWins = 0, withdrawWins = 0;
    for (let i = 0; i < 12; i++) {
      const { proj, ch, rev } = await setup();
      const withdraw = () => projects.resolveScopeChangeRequest(proj.id, ch.id, { resolution: "withdrawn" }, { by: OFFICE });
      const sign = () => quotes.recordPortalSignAcceptance(rev.id, SIG);
      const res = await Promise.allSettled(i % 2 ? [withdraw(), sign()] : [sign(), withdraw()]);
      const fulfilled = res.filter((r) => r.status === "fulfilled").length;
      const o = await outcomeOf(proj, ch, rev);
      if (fulfilled !== 1 || o.signed === o.withdrawn) bothOrNeither += 1;
      if (o.signed) signedWins += 1;
      if (o.withdrawn) withdrawWins += 1;
    }
    ok("12 simultaneous races: every one ends with exactly one outcome", bothOrNeither === 0, `${bothOrNeither} ended with both or neither (signed ${signedWins}, withdrawn ${withdrawWins})`);
    // Straight at the quote lock, both orders.
    for (const order of ["retire-first", "sign-first"]) {
      const { rev } = await setup();
      const retire = () => quotes.retireUnsignedRevision(rev.id, { by: OFFICE });
      const sign = () => quotes.recordPortalSignAcceptance(rev.id, SIG);
      const res = await Promise.allSettled(order === "retire-first" ? [retire(), sign()] : [sign(), retire()]);
      const q = await quotes.get(rev.id);
      const oneWon = res.filter((r) => r.status === "fulfilled").length === 1;
      const consistent = (q.status === "superseded" && !quotes.hasAcceptanceRecord(q)) || (q.status === "accepted" && quotes.hasAcceptanceRecord(q));
      ok(`quote lock, ${order}: exactly one wins, and the quote says which`, oneWon && consistent && res[0].status === "fulfilled",
        `${res.map((r) => r.status)} → ${q.status}`);
    }
  });
} finally {
  try { child?.kill("SIGTERM"); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  restore();
}

console.log(`\nchange-order guards: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
