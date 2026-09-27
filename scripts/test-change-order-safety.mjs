// scripts/test-change-order-safety.mjs
//
// Change-order safety (Patrick, 2026-09-27) — PR 2 of the Change Orders
// work. What it pins:
//
//   PERMISSIONS — the account's role decides, not the device.
//     A technician may capture a draft change request: notes, line items,
//     photos. Only the office (admin) may send it to the customer, record
//     the customer's decision, withdraw it, or generate the revised quote.
//     A technician trying any of those gets a real 403 and nothing moves.
//
//   ATTRIBUTION — the audit trail names the actual person, and says
//     whether a decision came from the customer directly or was recorded
//     by the office on the customer's behalf.
//
//   HONEST SEND — a change request becomes "sent" only when the email
//     actually went. No recipient, email not set up, or a failed delivery
//     leaves it unsent, and each attempt (with its reason) is kept.
//
//   ONE "OPEN" RULE — the Overview count, the completion check and the
//     customer's status email all ask one function which changes are still
//     open, so they cannot disagree. An approved fixed-price change still
//     waiting for its revised quote is open everywhere; an approved change
//     can always be withdrawn, so a job is never stuck on one.
//
// Old code (before this PR): see the PR description for the failure count.
//
// Run: node scripts/test-change-order-safety.mjs   (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const STUB = path.join(ROOT, "scripts", "lib", "stub-outbound.cjs");
const OUTBOX = path.join(DATA, `test-change-order-outbox-${process.pid}.jsonl`);
const PORT = 4863;
const PORT_NOMAIL = 4864;
const BASE = `http://127.0.0.1:${PORT}`;
const BASE_NOMAIL = `http://127.0.0.1:${PORT_NOMAIL}`;

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
const users = require(path.join(ROOT, "server", "lib", "users.js"));

const SIG = { customerName: "Adaeze Okonkwo-Hall", imageData: "data:image/png;base64,iVBORw0KGgo=", ip: "203.0.113.7", userAgent: "test" };
const TECH = "Tobias Vantol";
const OFFICE = "Odessa Brightwater";

// A signed fixed-price job, converted to a project.
async function signedJob({ email = "adaeze@example.test", billingMode = "fixed_price" } = {}) {
  let q = await quotes.create({
    type: "project_proposal", status: "sent", customerEmail: email,
    branch: "direct_residential", billingMode,
    lineItems: [{ label: "Base install", qty: 1, price: 5000 }]
  });
  q = await quotes.recordPortalSignAcceptance(q.id, SIG);
  return projects.createFromProposal(q, { customerName: "Adaeze Okonkwo-Hall", customerEmail: email });
}

const emails = () => {
  try {
    return fs.readFileSync(OUTBOX, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.channel === "email");
  } catch { return []; }
};

function boot(port, { mail }) {
  // An ALLOW-LISTED environment, never ...process.env (the E2E rule).
  const env = { PATH: process.env.PATH, TZ: "America/Toronto", PORT: String(port), HOST: "127.0.0.1",
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, PJL_STUB_OUTBOX: OUTBOX };
  if (mail) Object.assign(env, { GMAIL_USER: "stub@pjl.test", GMAIL_APP_PASSWORD: "stub" });
  const child = spawn("node", ["--require", STUB, path.join(ROOT, "server", "server.js")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  child.logs = "";
  child.stdout.on("data", (c) => { child.logs += c; });
  child.stderr.on("data", (c) => { child.logs += c; });
  return child;
}
async function waitUp(base, child) {
  for (let i = 0; i < 75; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`${base}/api/booking/services`); return; } catch {}
  }
  throw new Error("server never came up:\n" + child.logs.slice(-800));
}
async function login(base, email, password) {
  const r = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  return (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
}
function api(base, cookie) {
  return async (method, p, body) => {
    const r = await fetch(`${base}${p}`, {
      method, headers: { "content-type": "application/json", cookie },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  };
}
const scr = async (projId, id) => (await projects.get(projId)).scopeChangeRequests.find((s) => s.id === id);
const history = async (projId, action) => (await projects.get(projId)).history.filter((h) => h.action === action);

let server, nomail;
try {
  fs.writeFileSync(OUTBOX, "");
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  await users.create({ email: "tech@local.test", name: TECH, role: "tech", password: "tech-probe-12345" });
  await users.create({ email: "office@local.test", name: OFFICE, role: "admin", password: "office-probe-12345" });
  server = boot(PORT, { mail: true });
  await waitUp(BASE, server);
  const tech = api(BASE, await login(BASE, "tech@local.test", "tech-probe-12345"));
  const office = api(BASE, await login(BASE, "office@local.test", "office-probe-12345"));
  const base = (id) => `/api/projects/${encodeURIComponent(id)}/scope-changes`;

  // ====================================================================
  await scenario("1. a technician captures a draft change request: notes, items and photos", async () => {
    const proj = await signedJob();
    const r = await tech("POST", base(proj.id), {
      description: "Customer wants a drip zone along the south bed",
      suggestedLineItems: [{ label: "Drip zone", qty: 1, price: 400 }],
      photoIds: ["3", "4"], capturedFromWoId: null
    });
    ok("the technician can create the draft", r.status === 201 && r.data.scopeChange, String(r.status));
    const s = r.data.scopeChange || {};
    ok("...with its notes, line items and photos", s.description?.includes("drip zone") && s.suggestedLineItems?.length === 1 && s.photoIds?.join() === "3,4");
    ok("...captured by the technician's NAME (not an id, not 'admin')", s.capturedBy === TECH, String(s.capturedBy));
    const e = await tech("PATCH", `${base(proj.id)}/${s.id}`, { description: "Drip zone along the south bed, 12 emitters" });
    ok("the technician can edit their own draft's notes", e.status === 200, String(e.status));
    const em = await tech("PATCH", `${base(proj.id)}/${s.id}`, { draftEmail: { to: "someone-else@example.test", subject: "x", body: "y" } });
    ok("...but NOT the customer email (that is the office's)", em.status === 403, String(em.status));
    ok("...and the recipient is unchanged", (await scr(proj.id, s.id)).draftEmail.to === "adaeze@example.test", (await scr(proj.id, s.id)).draftEmail.to);
  });

  // ====================================================================
  await scenario("2. office-only actions refuse a technician with a real 403, and nothing moves", async () => {
    const proj = await signedJob();
    const s = (await tech("POST", base(proj.id), { description: "Add a zone", suggestedLineItems: [{ label: "Zone", qty: 1, price: 300 }] })).data.scopeChange;
    const before = emails().length;
    const send = await tech("POST", `${base(proj.id)}/${s.id}/send`);
    ok("send → 403", send.status === 403, String(send.status));
    ok("...still a draft, never sent, no email", (await scr(proj.id, s.id)).status === "pending_admin_review" && !(await scr(proj.id, s.id)).sentAt && emails().length === before);
    for (const resolution of ["approved", "rejected", "withdrawn"]) {
      const r = await tech("POST", `${base(proj.id)}/${s.id}/resolve`, { resolution });
      ok(`record "${resolution}" → 403`, r.status === 403, String(r.status));
    }
    ok("...and the change is untouched", (await scr(proj.id, s.id)).status === "pending_admin_review", (await scr(proj.id, s.id)).status);
    // The office approves it; the technician still cannot build the revision.
    await office("POST", `${base(proj.id)}/${s.id}/resolve`, { resolution: "approved" });
    const quotesBefore = (await quotes.list()).length;
    const rev = await tech("POST", `${base(proj.id)}/${s.id}/generate-revision`);
    ok("generate revised quote → 403", rev.status === 403, String(rev.status));
    ok("...and no quote was created", (await quotes.list()).length === quotesBefore);
  });

  // ====================================================================
  await scenario("3. the audit trail names the actual office person, and customer vs office", async () => {
    const proj = await signedJob();
    const s = (await office("POST", base(proj.id), { description: "Add a zone", suggestedLineItems: [{ label: "Zone", qty: 1, price: 300 }] })).data.scopeChange;
    ok("captured by the office person's name", s.capturedBy === OFFICE, String(s.capturedBy));
    const sent = await office("POST", `${base(proj.id)}/${s.id}/send`);
    ok("the office can send", sent.status === 200, `${sent.status} ${JSON.stringify(sent.data.errors || "")}`);
    ok("'sent' in history names the person", (await history(proj.id, "scope_change_sent")).at(-1)?.by === OFFICE, JSON.stringify((await history(proj.id, "scope_change_sent")).at(-1)));
    const res = await office("POST", `${base(proj.id)}/${s.id}/resolve`, { resolution: "approved", note: "Said yes on the phone" });
    ok("the office can record the customer's decision", res.status === 200, String(res.status));
    const r = await scr(proj.id, s.id);
    ok("the decision is the customer's", r.resolvedAs === "approved_by_customer", String(r.resolvedAs));
    ok("...recorded by the office, not given by the customer directly", r.decisionSource === "recorded_by_office", String(r.decisionSource));
    ok("...and names who recorded it", r.recordedBy === OFFICE, String(r.recordedBy));
    const h = (await history(proj.id, "scope_change_approved")).at(-1);
    ok("history: by the office person, saying it was recorded on the customer's behalf", h?.by === OFFICE && /recorded by the office/i.test(h?.note || ""), JSON.stringify(h));
    const gr = await office("POST", `${base(proj.id)}/${s.id}/generate-revision`);
    ok("the office can generate the revised quote", gr.status === 201 && gr.data.quote?.id, String(gr.status));
    ok("history: the revision names the office person", (await history(proj.id, "scope_change_executed")).at(-1)?.by === OFFICE);
    // The customer signs the revision THEMSELVES in the portal.
    await quotes.recordPortalSignAcceptance(gr.data.quote.id, SIG);
    const signed = (await history(proj.id, "revision_signed")).at(-1);
    ok("the customer's own signature stays attributed to the customer", signed?.by === "customer", JSON.stringify(signed));

    const s2 = (await office("POST", base(proj.id), { description: "Move a head" })).data.scopeChange;
    await office("POST", `${base(proj.id)}/${s2.id}/resolve`, { resolution: "withdrawn" });
    const w = await scr(proj.id, s2.id);
    ok("a withdrawal is the office's, by name", w.resolvedAs === "withdrawn_by_office" && w.recordedBy === OFFICE && w.decisionSource === "office",
      JSON.stringify({ as: w.resolvedAs, by: w.recordedBy, src: w.decisionSource }));
  });

  // ====================================================================
  await scenario("4. a send only counts when the email actually went", async () => {
    // (a) no email address for the customer
    const p1 = await signedJob({ email: "" });
    const a = (await office("POST", base(p1.id), { description: "Add a zone" })).data.scopeChange;
    const ra = await office("POST", `${base(p1.id)}/${a.id}/send`);
    const sa = await scr(p1.id, a.id);
    ok("(a) no recipient: the send is refused", ra.status >= 400 && ra.status < 500 && ra.data.ok === false, String(ra.status));
    ok("(a) ...and it is NOT marked sent", sa.status === "pending_admin_review" && !sa.sentAt, `${sa.status} ${sa.sentAt}`);
    ok("(a) ...the failed attempt is recorded with its reason", sa.sendAttempts?.length === 1 && sa.sendAttempts[0].ok === false && /email address/i.test(sa.sendAttempts[0].reason || ""),
      JSON.stringify(sa.sendAttempts));

    // (b) the delivery itself fails (a bounce, an SMTP outage)
    const p2 = await signedJob({ email: "bounces@example.test" });
    fs.writeFileSync(`${OUTBOX}.email-fail`, "bounces@example.test\n");
    const b = (await office("POST", base(p2.id), { description: "Add a zone" })).data.scopeChange;
    const rb = await office("POST", `${base(p2.id)}/${b.id}/send`);
    const sb = await scr(p2.id, b.id);
    ok("(b) delivery failure: the office is told it failed", rb.status >= 500 && rb.data.ok === false, String(rb.status));
    ok("(b) ...and it is NOT marked sent", sb.status === "pending_admin_review" && !sb.sentAt, `${sb.status} ${sb.sentAt}`);
    ok("(b) ...the attempt keeps the delivery error, and who tried", sb.sendAttempts?.[0]?.ok === false && /mailbox unavailable/.test(sb.sendAttempts[0].reason || "") && sb.sendAttempts[0].by === OFFICE,
      JSON.stringify(sb.sendAttempts));

    // (c) retry once the mailbox works: sent, and the failure is still on record
    fs.writeFileSync(`${OUTBOX}.email-fail`, "");
    const rc = await office("POST", `${base(p2.id)}/${b.id}/send`);
    const sc = await scr(p2.id, b.id);
    ok("(c) the retry sends", rc.status === 200 && sc.status === "pending_customer_approval" && Boolean(sc.sentAt), `${rc.status} ${sc.status}`);
    ok("(c) ...both attempts are kept, failed then sent", sc.sendAttempts?.length === 2 && sc.sendAttempts[0].ok === false && sc.sendAttempts[1].ok === true,
      JSON.stringify(sc.sendAttempts));
    ok("(c) ...and the email really went to the customer", emails().some((e) => e.to === "bounces@example.test"));

    // (d) a double click on Send emails the customer ONCE
    const p3 = await signedJob({ email: "twice@example.test" });
    const d = (await office("POST", base(p3.id), { description: "Add a zone" })).data.scopeChange;
    const [d1, d2] = await Promise.all([office("POST", `${base(p3.id)}/${d.id}/send`), office("POST", `${base(p3.id)}/${d.id}/send`)]);
    ok("(d) a double click on Send: one succeeds, one is refused", [d1.status, d2.status].sort().join() === "200,409", `${d1.status} ${d2.status}`);
    ok("(d) ...and the customer gets ONE email", emails().filter((e) => e.to === "twice@example.test").length === 1, String(emails().filter((e) => e.to === "twice@example.test").length));
  });

  // ====================================================================
  await scenario("5. email not set up on the server → never 'sent'", async () => {
    nomail = boot(PORT_NOMAIL, { mail: false });
    await waitUp(BASE_NOMAIL, nomail);
    const office2 = api(BASE_NOMAIL, await login(BASE_NOMAIL, "office@local.test", "office-probe-12345"));
    const p = await signedJob();
    const s = (await office2("POST", base(p.id), { description: "Add a zone" })).data.scopeChange;
    const before = emails().length;
    const r = await office2("POST", `${base(p.id)}/${s.id}/send`);
    const after = await scr(p.id, s.id);
    ok("the send reports it could not go", r.data.ok === false && r.status >= 500, String(r.status));
    ok("...and it is NOT marked sent", after.status === "pending_admin_review" && !after.sentAt, `${after.status} ${after.sentAt}`);
    ok("...the attempt says email is not set up", /not set up/i.test(after.sendAttempts?.[0]?.reason || ""), JSON.stringify(after.sendAttempts));
    ok("...and no email left the building", emails().length === before);
  });

  // ====================================================================
  await scenario("6. one 'open' rule: the Overview count, the completion check and the status email agree", async () => {
    // A legacy project with no billingMode recorded is billed as fixed price
    // (everything that isn't time & material is), so an approved change
    // without its revised quote is still open for it.
    const proj = await signedJob();
    const all = JSON.parse(fs.readFileSync(path.join(DATA, "projects.json"), "utf8"));
    all.find((p) => p.id === proj.id).billingMode = null;
    fs.writeFileSync(path.join(DATA, "projects.json"), JSON.stringify(all, null, 2));
    const draft = await projects.createScopeChangeRequest(proj.id, { description: "Still a draft" });
    const approved = await projects.createScopeChangeRequest(proj.id, { description: "Approved, no revised quote yet" });
    await projects.resolveScopeChangeRequest(proj.id, approved.id, { resolution: "approved" });
    const rejected = await projects.createScopeChangeRequest(proj.id, { description: "Customer said no" });
    await projects.resolveScopeChangeRequest(proj.id, rejected.id, { resolution: "rejected" });

    ok("there is one shared rule", typeof projects.openScopeChanges === "function");
    const open = projects.openScopeChanges ? projects.openScopeChanges(await projects.get(proj.id)).map((s) => s.id).sort() : [];
    ok("open = the draft and the approved-but-unrevised change (not the rejected one)", open.join() === [draft.id, approved.id].sort().join(), open.join());
    const metrics = await projects.computeProjectMetrics(proj.id);
    ok("the Overview count agrees (2)", metrics.pendingScopeChanges === 2, String(metrics.pendingScopeChanges));
    const keys = (await projects.completionPreflight(proj.id)).blockers.map((b) => b.key);
    ok("completion is blocked by the approved change, even with no billingMode recorded", keys.includes("approved_scr_no_revision"), JSON.stringify(keys));
    ok("...and by the draft", keys.includes("scope_changes_unresolved"), JSON.stringify(keys));
    const su = await projects.generateStatusUpdate(proj.id, { recipient: { email: "adaeze@example.test" } }, { by: OFFICE });
    const listed = (su.snapshot.pendingScopeChanges || []).map((s) => s.description).sort();
    ok("the customer's status email lists the same two", listed.join("|") === ["Approved, no revised quote yet", "Still a draft"].sort().join("|"), listed.join("|"));
    const appr = (su.snapshot.pendingScopeChanges || []).find((s) => s.description.startsWith("Approved"));
    ok("...and says the approved one is waiting on its revised quote", appr && appr.stage === "awaiting_revision", JSON.stringify(appr));

    // Time & material: an approved change is billed as hours, so it is closed.
    const tm = await signedJob({ billingMode: "time_and_material" });
    const t = await projects.createScopeChangeRequest(tm.id, { description: "Extra hours" });
    await projects.resolveScopeChangeRequest(tm.id, t.id, { resolution: "approved" });
    ok("time & material: an approved change is not open", projects.openScopeChanges && projects.openScopeChanges(await projects.get(tm.id)).length === 0);
    ok("...and the Overview count agrees (0)", (await projects.computeProjectMetrics(tm.id)).pendingScopeChanges === 0);
  });

  // ====================================================================
  await scenario("7. an approved change can be withdrawn, so a job is never stuck on one", async () => {
    const proj = await signedJob();
    const s = (await office("POST", base(proj.id), { description: "Add a zone" })).data.scopeChange;
    await office("POST", `${base(proj.id)}/${s.id}/resolve`, { resolution: "approved" });
    ok("setup: completion is blocked by the approved change", (await projects.completionPreflight(proj.id)).blockers.some((b) => b.key === "approved_scr_no_revision"));
    const w = await office("POST", `${base(proj.id)}/${s.id}/resolve`, { resolution: "withdrawn", note: "Customer changed their mind before the revision" });
    ok("the office can withdraw an approved change", w.status === 200 && (await scr(proj.id, s.id)).status === "withdrawn", `${w.status} ${(await scr(proj.id, s.id)).status}`);
    ok("...which lifts the block", !(await projects.completionPreflight(proj.id)).blockers.some((b) => b.key === "approved_scr_no_revision"));
  });
} finally {
  for (const c of [server, nomail]) { try { c?.kill("SIGTERM"); } catch {} }
  await new Promise((r) => setTimeout(r, 400));
  restore();
}

console.log(`\nchange-order safety: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
