// scripts/test-change-orders-view.mjs
//
// The Change Orders tab (PR 3 of the Change Orders work, 2026-09-27):
// READ-ONLY, and every figure it shows is the server's.
//
// What this pins:
//
//   ONE ANSWER. The tab's "open" count is the shared rule
//   (projects.openScopeChanges) — the same number the Overview count and
//   the completion check give. Its signed agreement is the quote chain's
//   governing quote, the one the final invoice bills. Its holds are the
//   completion check's own blockers, word for word. A tab that re-derived
//   any of these could disagree with the invoice; this test runs both
//   sides over the same records.
//
//   EVERY STAGE, TOLD HONESTLY. Draft, not sent (with the reason), sent,
//   approved-needs-revision, in a revised quote waiting for a signature,
//   signed, revision declined, customer declined, withdrawn, and time &
//   material — each with the server's own "what happens next" line.
//
//   READ-ONLY. The screen calls one GET and nothing else, has no action
//   buttons, and does no arithmetic on money.
//
// Run: node scripts/test-change-orders-view.mjs   (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4867;
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

async function signedJob({ billingMode = "fixed_price" } = {}) {
  let q = await quotes.create({
    type: "project_proposal", status: "sent", customerEmail: "adaeze@example.test",
    branch: "direct_residential", billingMode,
    lineItems: [{ label: "Base install", qty: 1, price: 5000, lineTotal: 5000 }],
    // As the proposal builder stores them — the tab shows the quote's own totals.
    subtotal: 5000, hst: 650, total: 5650
  });
  q = await quotes.recordPortalSignAcceptance(q.id, SIG);
  return projects.createFromProposal(q, { customerName: "Adaeze Okonkwo-Hall", customerEmail: "adaeze@example.test" });
}
const raise = (projId, description, price = 0) => projects.createScopeChangeRequest(projId, {
  description, suggestedLineItems: price ? [{ label: description, qty: 1, price }] : []
}, { by: "Tobias Vantol" });
const approve = (projId, id) => projects.resolveScopeChangeRequest(projId, id, { resolution: "approved" }, { by: OFFICE });

let child;
let get;
try {
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  await users.create({ email: "tech@local.test", name: "Tobias Vantol", role: "tech", password: "tech-probe-12345" });
  child = spawn("node", [path.join(ROOT, "server", "server.js")], {
    cwd: ROOT, env: { PATH: process.env.PATH, TZ: "America/Toronto", PORT: String(PORT), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = ""; child.stdout.on("data", (c) => { logs += c; }); child.stderr.on("data", (c) => { logs += c; });
  let up = false;
  for (let i = 0; i < 75 && !up; i++) { await new Promise((r) => setTimeout(r, 200)); try { await fetch(`${BASE}/api/booking/services`); up = true; } catch {} }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-800));
  const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "tech@local.test", password: "tech-probe-12345" }) });
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
  get = async (projId, withCookie = true) => {
    const r = await fetch(`${BASE}/api/projects/${encodeURIComponent(projId)}/change-orders`, { headers: withCookie ? { cookie } : {}, redirect: "manual" });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  // The one-answer checks every scenario runs.
  async function agreesWithTheServer(projId, view, label) {
    const proj = await projects.get(projId);
    ok(`${label}: "open" is the shared rule (openScopeChanges)`, view.summary.open === projects.openScopeChanges(proj).length,
      `${view.summary.open} vs ${projects.openScopeChanges(proj).length}`);
    ok(`${label}: ...and the Overview count agrees`, view.summary.open === (await projects.computeProjectMetrics(projId)).pendingScopeChanges);
    const openIds = view.changes.filter((c) => c.open).map((c) => c.id).sort().join();
    ok(`${label}: ...change by change`, openIds === projects.openScopeChanges(proj).map((s) => s.id).sort().join());
    const chain = await projects.resolveProjectQuote(proj);
    ok(`${label}: the agreement shown is the one the invoice bills`, (view.agreement.governing?.id || null) === (chain.governing?.id || null),
      `${view.agreement.governing?.id} vs ${chain.governing?.id}`);
    if (chain.governing) {
      ok(`${label}: ...at its own subtotal`, view.agreement.governing.subtotal === Number(chain.governing.subtotal), `${view.agreement.governing.subtotal} vs ${chain.governing.subtotal}`);
      const bill = await projects.fixedPriceBillingSource(proj);
      if (proj.billingMode !== "time_and_material") {
        ok(`${label}: ...and it matches the billing source`, view.agreement.governing.subtotal === Number(bill.subtotal), `${view.agreement.governing.subtotal} vs ${bill.subtotal}`);
      }
    }
    const want = (await projects.completionPreflight(projId)).blockers
      .filter((b) => ["scope_changes_unresolved", "approved_scr_no_revision", "revision_unsigned", "deposit_balance_predates_revision"].includes(b.key))
      .map((b) => `${b.key}:${b.message}`).join("|");
    ok(`${label}: holds are the completion check's own, word for word`, view.holds.map((h) => `${h.key}:${h.message}`).join("|") === want,
      `${view.holds.map((h) => h.key)} vs ${want}`);
  }
  const phaseOf = (view, id) => view.changes.find((c) => c.id === id);

  // ====================================================================
  await scenario("1. every open stage, and the ones that are settled", async () => {
    const proj = await signedJob();
    const draft = await raise(proj.id, "Drip zone along the south bed", 400);
    const notSent = await raise(proj.id, "Extra head by the gate", 90);
    try { await projects.sendScopeChangeRequest(proj.id, notSent.id, { by: OFFICE, deliver: async () => { throw new Error("550 mailbox unavailable"); } }); } catch {}
    const sent = await raise(proj.id, "Move the backflow", 250);
    await projects.sendScopeChangeRequest(proj.id, sent.id, DELIVERED);
    const approved = await raise(proj.id, "Second drip zone", 300);
    await approve(proj.id, approved.id);
    const declined = await raise(proj.id, "Lighting", 900);
    await projects.resolveScopeChangeRequest(proj.id, declined.id, { resolution: "rejected", note: "Next year" }, { by: OFFICE });
    const withdrawn = await raise(proj.id, "Duplicate entry");
    await projects.resolveScopeChangeRequest(proj.id, withdrawn.id, { resolution: "withdrawn" }, { by: OFFICE });

    const r = await get(proj.id);
    ok("a technician can read the tab", r.status === 200 && r.data.ok, String(r.status));
    const v = r.data;
    ok("draft → Draft, waiting on the office", phaseOf(v, draft.id)?.phase === "in_review" && phaseOf(v, draft.id)?.phaseLabel === "Draft");
    const ns = phaseOf(v, notSent.id);
    ok("failed send → Not sent, with the delivery error", ns?.phaseLabel === "Not sent" && /550 mailbox unavailable/.test(ns?.next || ""), JSON.stringify(ns?.next));
    ok("...and the failed attempt is listed with who tried", ns?.sendAttempts?.[0]?.ok === false && ns.sendAttempts[0].by === OFFICE);
    ok("sent → Awaiting customer, with when and who", phaseOf(v, sent.id)?.phase === "awaiting_customer" && phaseOf(v, sent.id)?.sent?.by === OFFICE);
    ok("approved, no revised quote → needs revised quote", phaseOf(v, approved.id)?.phase === "awaiting_revision");
    const d = phaseOf(v, declined.id);
    ok("customer declined → recorded by the office, by name, with the note", d?.phase === "rejected" && d.decision?.source === "recorded_by_office" && d.decision?.recordedBy === OFFICE && d.decision?.note === "Next year",
      JSON.stringify(d?.decision));
    ok("withdrawn → Withdrawn, not open", phaseOf(v, withdrawn.id)?.phase === "withdrawn" && phaseOf(v, withdrawn.id)?.open === false);
    ok("line items and the estimate are the server's", phaseOf(v, draft.id)?.lineItems?.[0]?.lineTotal === 400 && phaseOf(v, draft.id)?.estimatedTotal === 400);
    ok("summary counts: 4 open, 1 waiting on the customer, 0 signed", v.summary.open === 4 && v.summary.awaitingCustomer === 1 && v.summary.signed === 0, JSON.stringify(v.summary));
    await agreesWithTheServer(proj.id, v, "(1)");
    ok("(1) both change holds are shown", v.holds.some((h) => h.key === "scope_changes_unresolved") && v.holds.some((h) => h.key === "approved_scr_no_revision"));
  });

  // ====================================================================
  await scenario("2. in a revised quote → signed: the agreement moves, and so does the tab", async () => {
    const proj = await signedJob();
    const c = await raise(proj.id, "Drip zone", 400);
    await projects.sendScopeChangeRequest(proj.id, c.id, DELIVERED);
    await approve(proj.id, c.id);
    const rev = await projects.generateQuoteRevisionFromScopeChange(proj.id, c.id, { by: OFFICE });

    let v = (await get(proj.id)).data;
    ok("in a draft revision → waiting for signature, naming the quote", phaseOf(v, c.id)?.phase === "awaiting_signature" && (phaseOf(v, c.id)?.next || "").includes(rev.id));
    ok("...not counted open (the unsigned revision holds the job instead)", phaseOf(v, c.id)?.open === false && v.summary.awaitingSignature === 1);
    ok("the job is still billed on the $5,000 original", v.agreement.governing?.subtotal === 5000 && v.agreement.pending?.id === rev.id && v.agreement.pending?.subtotal === 5400,
      JSON.stringify({ g: v.agreement.governing?.subtotal, p: v.agreement.pending?.subtotal }));
    ok("the revision hold is shown", v.holds.some((h) => h.key === "revision_unsigned"));
    // The workspace header's "Contract value" reads linkedQuote.agreement:
    // the SIGNED $5,000 (+HST), not the $5,400 draft being worked on.
    const pr = await fetch(`${BASE}/api/projects/${encodeURIComponent(proj.id)}`, { headers: { cookie } });
    const pj = await pr.json().catch(() => ({}));
    ok("header: the quote panel shows the draft being worked on", pj.linkedQuote?.id === rev.id, String(pj.linkedQuote?.id));
    ok("header: ...but the contract value is the SIGNED agreement", pj.linkedQuote?.agreement?.id === v.agreement.governing?.id && pj.linkedQuote?.agreement?.total === 5650,
      JSON.stringify(pj.linkedQuote?.agreement));
    await agreesWithTheServer(proj.id, v, "(2 unsigned)");

    await quotes.recordPortalSignAcceptance(rev.id, SIG);
    v = (await get(proj.id)).data;
    ok("signed → Signed, in the agreement", phaseOf(v, c.id)?.phase === "signed" && (phaseOf(v, c.id)?.next || "").includes(rev.id));
    ok("the agreement is now $5,400, up $400 from the original", v.agreement.governing?.id === rev.id && v.agreement.governing?.subtotal === 5400 && v.agreement.original?.subtotal === 5000 && v.agreement.netChangeSubtotal === 400,
      JSON.stringify({ g: v.agreement.governing?.subtotal, o: v.agreement.original?.subtotal, n: v.agreement.netChangeSubtotal }));
    ok("no hold left", v.holds.length === 0, JSON.stringify(v.holds));
    ok("versions list both, original then current", v.agreement.versions.map((x) => x.role).join() === "original,governing", v.agreement.versions.map((x) => x.role).join());
    await agreesWithTheServer(proj.id, v, "(2 signed)");
  });

  // ====================================================================
  await scenario("3. revision declined → not in the price, the original still governs", async () => {
    const proj = await signedJob();
    const c = await raise(proj.id, "Drip zone", 400);
    await approve(proj.id, c.id);
    const rev = await projects.generateQuoteRevisionFromScopeChange(proj.id, c.id, { by: OFFICE });
    await quotes.decline(rev.id, { reason: "Not this year", by: "customer" });
    const v = (await get(proj.id)).data;
    ok("revision declined → Revision not signed, not in the price", phaseOf(v, c.id)?.phase === "revision_declined");
    ok("the $5,000 original governs, no net change", v.agreement.governing?.subtotal === 5000 && v.agreement.netChangeSubtotal === 0);
    await agreesWithTheServer(proj.id, v, "(3)");
  });

  // ====================================================================
  await scenario("4. time & material: an approved change is settled, billed as hours", async () => {
    const proj = await signedJob({ billingMode: "time_and_material" });
    const c = await raise(proj.id, "Extra afternoon", 0);
    await approve(proj.id, c.id);
    const v = (await get(proj.id)).data;
    ok("approved on T&M → Approved, not open", phaseOf(v, c.id)?.phase === "approved_tm" && phaseOf(v, c.id)?.open === false);
    await agreesWithTheServer(proj.id, v, "(4)");
  });

  // ====================================================================
  await scenario("5. the door", async () => {
    const proj = await signedJob();
    const anon = await get(proj.id, false);
    ok("signed out → refused", anon.status === 401 || anon.status === 302 || anon.status === 303, String(anon.status));
    const missing = await get("PROJ-9999-9999");
    ok("an unknown project → 404", missing.status === 404, String(missing.status));
  });
} finally {
  try { child?.kill("SIGTERM"); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  restore();
}

// ---- The screen: read-only, and no second calculation ----------------
{
  const tab = fs.readFileSync(path.join(ROOT, "admin-app", "src", "routes", "ChangeOrders.tsx"), "utf8");
  const code = tab.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok("the tab reads one endpoint and writes nothing", /changeOrdersApi\.get\(/.test(code) && !/api\.(post|patch|del)\b|method\s*:|fetch\(/.test(code));
  ok("...and has no action buttons", !/<button|<Button|onClick/.test(code));
  const MONEY_MATH = [
    /(subtotal|total|Total|lineTotal|price|estimatedTotal)\s*[-+*/]\s*[\w(]/, // subtotal - x, lineTotal + y
    /[*]\s*[\w.]*\b(qty|price)\b/,                                            // x * li.price
    /\.reduce\(/                                                               // summing a list
  ];
  ok("...and does no arithmetic on money", !MONEY_MATH.some((re) => re.test(code)),
    "found arithmetic on a money field, or a reduce");
  ok("...and decides nothing about 'open' itself (uses the server's flag)", /c\.open/.test(code) && !/pending_admin_review|pending_customer_approval/.test(code));
  const main = fs.readFileSync(path.join(ROOT, "admin-app", "src", "main.tsx"), "utf8");
  ok("the workspace's Change Orders tab is this screen, not the placeholder", /path="changes" element=\{<ChangeOrdersTab \/>\}/.test(main));
  const dist = fs.readdirSync(path.join(ROOT, "server", "app-dist", "assets")).filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(ROOT, "server", "app-dist", "assets", f), "utf8")).join("\n");
  ok("the committed app build includes it (rebuilt, not stale)", dist.includes("/change-orders"));
}

console.log(`\nchange orders view: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
