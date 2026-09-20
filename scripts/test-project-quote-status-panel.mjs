#!/usr/bin/env node
// scripts/test-project-quote-status-panel.mjs
//
// GET /api/projects/:id — the revision/lock status panel's data (PJL-54).
//
// The Job Portal wants a project page that shows "Quote v3 — sent,
// Summary total, confirmed" without opening the Proposal Builder. The
// project's only pointer to its quote can be STALE: a System-Builder
// project's systemDesign.linkedQuoteId names whichever quote the design
// generated, and nothing updates it when that quote gets revised — so a
// naive reader following that id straight would show the ORIGINAL
// version's status forever, even after two newer revisions replaced it.
//
// quotes.resolveRevisionChain() walks the whole chain from any id in it
// (backward via revisionOf to the root, forward via supersededBy to
// current) so the panel always shows the actually-current version. This
// suite pins the route that wires it into GET /api/projects/:id.
//
// This pins:
//   1. No sourceQuoteId and no systemDesign.linkedQuoteId — linkedQuote
//      is null, no crash (the ordinary hand-created project).
//   2. A direct link (project.sourceQuoteId, the post-acceptance case) —
//      resolves the quote's version/status/presentation mode/confirmed
//      correctly, chain of length 1.
//   3. A STALE link (systemDesign.linkedQuoteId names v1, but v1 has
//      since been revised to v2 and v3) — resolves to v3 as current,
//      full 3-entry chain, in order.
//   4. A non-project_proposal quote (on_site_quote) — presentationMode
//      and confirmed are both null (not applicable), status/version
//      still resolve.
//   5. A dangling anchor (systemDesign.linkedQuoteId names a quote that
//      no longer exists) — linkedQuote is null, not a 500.
//
// Drives the real endpoint against a booted server.
//
// Run: node scripts/test-project-quote-status-panel.mjs
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
const PORT = 4814;

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
  await users.create({ email: "quote-status-probe@local.test", name: "Quote Status Probe", role: "admin", password: "quote-status-probe-12345" });
  const login = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "quote-status-probe@local.test", password: "quote-status-probe-12345" })
  });
  const cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0])
    .find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("admin can log in", login.ok && Boolean(cookie), `${login.status}`);

  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const quotes = require(path.join(ROOT, "server", "lib", "quotes.js"));

  const getProjectApi = async (id) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/projects/${encodeURIComponent(id)}`, { headers: { cookie }, cache: "no-store" });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  // ---- 1. No quote link at all -------------------------------------------
  {
    const proj = await projects.create({ name: "Hand-created, no quote" });
    const res = await getProjectApi(proj.id);
    ok("no anchor → linkedQuote is null", res.status === 200 && res.data.linkedQuote === null, JSON.stringify(res.data.linkedQuote));
  }

  // ---- 2. Direct link (post-acceptance sourceQuoteId) --------------------
  {
    const quote = await quotes.create({
      type: "project_proposal",
      customerEmail: "quote-status-direct@example.com",
      branch: "direct_residential",
      lineItems: [{ id: "li_1", label: "Install", qty: 1, unitPrice: 500000 }],
      subtotal: 500000, hst: 65000, total: 565000
    });
    await quotes.markSentForApproval(quote.id, { token: "test-token-1", confirmedPresentation: "itemized" });
    const proj = await projects.create({ name: "Direct link probe", sourceQuoteId: quote.id });

    const res = await getProjectApi(proj.id);
    const lq = res.data.linkedQuote;
    ok("direct link resolves", res.status === 200 && lq != null, JSON.stringify(lq));
    ok("…correct id/version/status", lq.id === quote.id && lq.version === 1 && lq.status === "sent");
    ok("…presentation mode surfaced", lq.presentationMode === "itemized");
    ok("…confirmed is true (it made it past draft)", lq.confirmed === true);
    ok("…chain is just itself", Array.isArray(lq.chain) && lq.chain.length === 1 && lq.chain[0].id === quote.id);
  }

  // ---- 3. Stale anchor — resolves through 2 revisions to current --------
  {
    const v1 = await quotes.create({
      type: "project_proposal",
      customerEmail: "quote-status-stale@example.com",
      branch: "direct_residential",
      lineItems: [{ id: "li_1", label: "Install", qty: 1, unitPrice: 500000 }],
      subtotal: 500000, hst: 65000, total: 565000
    });
    await quotes.markSentForApproval(v1.id, { token: "test-token-2", confirmedPresentation: "itemized" });
    const v2 = await quotes.createRevision(v1.id, { by: "admin" });
    await quotes.markSentForApproval(v2.id, { token: "test-token-3", confirmedPresentation: "itemized" });
    const v3 = await quotes.createRevision(v2.id, { by: "admin" });
    // v3 is left in draft — never sent — to also pin the "not yet sent" case.

    const proj = await projects.create({ name: "Stale System-Builder link probe" });
    // The project's pointer names the ORIGINAL — exactly the real-world
    // staleness (nothing updates systemDesign.linkedQuoteId on revision).
    patchProject(proj.id, { systemDesign: { linkedQuoteId: v1.id } });

    const res = await getProjectApi(proj.id);
    const lq = res.data.linkedQuote;
    ok("stale anchor still resolves", res.status === 200 && lq != null, JSON.stringify(lq));
    ok("…resolves to v3, NOT the stale v1 it's pointed at", lq.id === v3.id && lq.version === 3, `got id=${lq?.id} version=${lq?.version}`);
    ok("…v3's real status (draft, never sent)", lq.status === "draft");
    ok("…confirmed is false — it never made it past draft", lq.confirmed === false);
    ok("…full 3-entry chain, in order v1→v2→v3", Array.isArray(lq.chain) && lq.chain.length === 3 &&
      lq.chain[0].id === v1.id && lq.chain[1].id === v2.id && lq.chain[2].id === v3.id,
      JSON.stringify(lq.chain));
    ok("…v1 and v2 in the chain are correctly marked superseded", lq.chain[0].status === "superseded" && lq.chain[1].status === "superseded");
  }

  // ---- 4. Non-proposal quote type — presentation fields not applicable --
  {
    const quote = await quotes.create({
      type: "on_site_quote",
      customerEmail: "quote-status-repair@example.com",
      lineItems: [{ id: "li_1", label: "Replace valve", qty: 1, unitPrice: 18500 }],
      subtotal: 18500, hst: 2405, total: 20905
    });
    await quotes.accept(quote.id, { by: "customer" });
    const proj = await projects.create({ name: "Repair quote link probe", sourceQuoteId: quote.id });

    const res = await getProjectApi(proj.id);
    const lq = res.data.linkedQuote;
    ok("on_site_quote still resolves", res.status === 200 && lq != null && lq.id === quote.id);
    ok("…presentationMode is null (doesn't apply to this type)", lq.presentationMode === null);
    ok("…confirmed is null (doesn't apply to this type)", lq.confirmed === null);
    ok("…status still correct", lq.status === "accepted");
  }

  // ---- 5. Dangling anchor — quote no longer exists -----------------------
  {
    const proj = await projects.create({ name: "Dangling anchor probe" });
    patchProject(proj.id, { systemDesign: { linkedQuoteId: "Q-DOES-NOT-EXIST-STATUS" } });
    const res = await getProjectApi(proj.id);
    ok("dangling anchor → linkedQuote is null, not a crash", res.status === 200 && res.data.ok && res.data.linkedQuote === null, JSON.stringify(res.data));
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
  console.error(`\n✗ test-project-quote-status-panel: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-project-quote-status-panel: ${pass} assertions passed`);
