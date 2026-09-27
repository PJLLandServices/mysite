#!/usr/bin/env node
// scripts/test-photo-urls.mjs
//
// THE TWO PLACES THAT SHOWED A BROKEN IMAGE — AND WHY THEY NEEDED TWO
// DIFFERENT FIXES.
//
// Both pointed <img src> at /api/work-orders/:id/photos/:n. That is the
// DELETE route's path; the GET that serves the file is SINGULAR,
// /photo/:n. So both rendered a 404 placeholder.
//
// Fixing the spelling fixes only ONE of them:
//
//   1. THE STAFF PROJECT PAGE is admin-gated, so the office session
//      cookie rides along. The authenticated singular route is right.
//
//   2. THE CUSTOMER STATUS-UPDATE EMAIL lands in an inbox, where there is
//      no staff session and never will be. The singular route would turn
//      a 404 into a refusal — still a broken image, now for a customer.
//
// The email now carries a signed link to each photo (lib/photo-links.js),
// scoped to that ONE photo on that ONE work order, and expiring. Not the
// customer's portal token: that unlocks their whole property portal, and
// a status update goes to whatever address the office types. And never a
// public photo.
//
// Every URL below is REQUESTED off a booted server, and every response is
// checked for status AND content type — an HTML error page with a 200 is
// still a broken image. The email URL is pulled out of the email that was
// ACTUALLY SENT (captured by the #322 outbound stub), not rebuilt here.
//
// Run: node scripts/test-photo-urls.mjs   (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "server", "data");
const PORT = 4853;
const BASE = `http://127.0.0.1:${PORT}`;
const STUB = path.join(ROOT, "scripts", "lib", "stub-outbound.cjs");
const OUTBOX = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "photo-urls-")), "outbox.jsonl");

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.error("  FAIL " + name + (detail ? ` — ${detail}` : "")); }
};

// Real 1x1 PNGs, two different ones, so "which photo came back" is
// answerable by bytes, not just by status.
const PNG_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PNG_B = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

fs.mkdirSync(DATA, { recursive: true });
const TOUCHED = ["projects.json", "work-orders.json", "users.json", "properties.json", "customers.json"];
const backups = new Map();
for (const f of TOUCHED) {
  const p = path.join(DATA, f);
  backups.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}

fs.writeFileSync(OUTBOX, "");
const child = spawn("node", ["--require", STUB, path.join(ROOT, "server", "server.js")], {
  cwd: ROOT,
  // An ALLOW-LISTED environment, never ...process.env — the same rule as
  // the E2E harness (scripts/lib/field-server.mjs). This server really
  // sends email; inheriting the caller's environment on a machine with
  // real credentials would hand them to it. The stub's tripwires refuse
  // to boot if anything production-shaped gets through regardless.
  env: {
    PATH: process.env.PATH, TZ: "America/Toronto",
    PORT: String(PORT), HOST: "127.0.0.1", PUBLIC_BASE_URL: BASE,
    PJL_STUB_OUTBOX: OUTBOX, GMAIL_USER: "stub@pjl.test", GMAIL_APP_PASSWORD: "stub"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let logs = "";
child.stdout.on("data", (c) => { logs += c; });
child.stderr.on("data", (c) => { logs += c; });

const sentEmails = () => fs.readFileSync(OUTBOX, "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((e) => e && e.channel === "email");
const imgSrcsIn = (html) => [...String(html || "").matchAll(/<img[^>]*\ssrc="([^"]+)"/g)]
  .map((m) => m[1].replace(/&amp;/g, "&"));

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(`${BASE}/api/booking/services`); up = true; } catch { /* booting */ }
  }
  if (!up) throw new Error("server never came up:\n" + logs.slice(-1500));

  const users = require(path.join(ROOT, "server", "lib", "users.js"));
  fs.writeFileSync(path.join(DATA, "users.json"), "[]\n");
  await users.create({ email: "photo@local.test", name: "Marguerite Sowande", role: "admin", password: "photo-probe-12345" });
  const login = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "photo@local.test", password: "photo-probe-12345" })
  });
  const cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie") || ""])
    .map((c) => String(c).split(";")[0]).find((c) => c.startsWith("pjl_crm_session=")) || "";
  ok("the office can sign in", login.ok && Boolean(cookie), String(login.status));

  const customers = require(path.join(ROOT, "server", "lib", "customers.js"));
  const properties = require(path.join(ROOT, "server", "lib", "properties.js"));
  const projects = require(path.join(ROOT, "server", "lib", "projects.js"));
  const workOrders = require(path.join(ROOT, "server", "lib", "work-orders.js"));

  // Two customers, two properties, two jobs. The second exists to be the
  // photo a link must NEVER reach.
  const mkJob = async (name, email, address, png) => {
    const c = await customers.create({ name, email });
    const prop = await properties.create({ customerId: c.id, address, customerName: name });
    const proj = await projects.create({ name: `Photos — ${address}`, customerName: name, propertyId: prop.id });
    await projects.update(proj.id, { status: "active", buildTracking: true, propertyId: prop.id });
    const wo = await workOrders.create({ type: "build", project: await projects.get(proj.id), workDate: "2026-09-24" });
    await projects.attachWorkOrder(proj.id, wo.id);
    const up = await fetch(`${BASE}/api/work-orders/${encodeURIComponent(wo.id)}/photos`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ photos: [{ data: png.toString("base64"), mediaType: "image/png", category: "in_progress", label: "trench" }] })
    });
    const j = await up.json().catch(() => ({}));
    return { proj, wo, n: Number((j.added || [])[0]?.n), uploaded: up.ok };
  };
  const ours = await mkJob("Adaeze Okonkwo-Hall", "adaeze@example.test", "14 Kirby Ave, Newmarket ON", PNG_A);
  const theirs = await mkJob("Bartholomew Quist", "bart@example.test", "9 Millard St, Stouffville ON", PNG_B);
  ok("a photo is uploaded onto each job through the real route",
    ours.uploaded && theirs.uploaded && Number.isFinite(ours.n) && Number.isFinite(theirs.n));

  const isImage = (r) => String(r.headers.get("content-type") || "").startsWith("image/");
  const bytesOf = async (r) => Buffer.from(await r.arrayBuffer());

  // ================================================================
  // PATH 1 — the staff project page (authenticated route)
  // ================================================================
  console.log("\n  -- staff project page --");

  const pageJs = fs.readFileSync(path.join(ROOT, "server", "project.js"), "utf8");
  const stripSrc = pageJs.match(/proj-task-photos[\s\S]{0,400}?<img src="([^"]+)"/);
  ok("the task photo strip is built from the SINGULAR /photo/ route",
    Boolean(stripSrc) && stripSrc[1].includes("/photo/${") && !/\/photos\/\$\{/.test(stripSrc[1]),
    stripSrc ? stripSrc[1] : "no <img> in the strip");

  const staffUrl = `${BASE}/api/work-orders/${encodeURIComponent(ours.wo.id)}/photo/${ours.n}`;
  const staffRes = await fetch(staffUrl, { headers: { cookie } });
  ok("signed in, the staff photo URL returns 200", staffRes.status === 200, String(staffRes.status));
  ok("...with an image content type", isImage(staffRes), String(staffRes.headers.get("content-type")));
  ok("...and the right photo's bytes", (await bytesOf(staffRes)).equals(PNG_A));

  const oldStaff = await fetch(`${BASE}/api/work-orders/${encodeURIComponent(ours.wo.id)}/photos/${ours.n}`, { headers: { cookie } });
  ok("the OLD plural URL serves no image (this was the bug)",
    !(oldStaff.status === 200 && isImage(oldStaff)), `${oldStaff.status} ${oldStaff.headers.get("content-type")}`);

  const staffAnon = await fetch(staffUrl);
  ok("NEGATIVE signed out, the staff photo URL is refused",
    staffAnon.status >= 400 && !isImage(staffAnon), `${staffAnon.status}`);

  // ================================================================
  // PATH 2 — the customer status-update email (signed links)
  // ================================================================
  console.log("\n  -- customer status-update email --");

  const before = sentEmails().length;
  const send = await fetch(`${BASE}/api/projects/${encodeURIComponent(ours.proj.id)}/status-update`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ recipient: { email: "adaeze@example.test", name: "Adaeze" }, preamble: "Trenching done." })
  });
  const sendBody = await send.json().catch(() => ({}));
  ok("the status update sends", send.ok && sendBody.emailSent === true,
    `${send.status} emailSent=${sendBody.emailSent} ${sendBody.emailError || ""}`);

  const email = sentEmails().slice(before).find((e) => /adaeze@example\.test/.test(e.to));
  ok("the email that went out was captured", Boolean(email), `${sentEmails().length - before} new email(s)`);
  const srcs = imgSrcsIn(email?.html);
  ok("the sent email contains a photo", srcs.length > 0, `${srcs.length} <img>`);

  ok("every photo URL in the email is a signed single-photo link",
    srcs.length > 0 && srcs.every((u) => u.includes("/api/photo-link/") && /[?&]s=/.test(u)),
    srcs.join(" | "));
  ok("NO photo URL in the email is a staff (admin-gated) URL",
    !srcs.some((u) => u.includes("/api/work-orders/")), srcs.join(" | "));
  ok("NO photo URL in the email carries a portal token",
    !srcs.some((u) => u.includes("/api/portal/")) && !String(email?.html).includes("/portal/"),
    "a forwarded email must not grant portal access");

  // THE REAL TEST: fetch it with no cookie, exactly as an inbox does.
  const mailUrl = srcs[0];
  const mailRes = await fetch(mailUrl);
  ok("with NO session, the email's photo URL returns 200",
    mailRes.status === 200, `${mailRes.status} ${mailRes.headers.get("content-type")}`);
  ok("...with an image content type", isImage(mailRes), String(mailRes.headers.get("content-type")));
  ok("...and it is OUR photo's bytes", (await bytesOf(mailRes)).equals(PNG_A));
  ok("...served private, never to a shared cache",
    /private/.test(String(mailRes.headers.get("cache-control"))), String(mailRes.headers.get("cache-control")));

  // ================================================================
  // NEGATIVE AUTHORIZATION
  // ================================================================
  console.log("\n  -- negative authorization --");

  const u = new URL(mailUrl);
  const sig = u.searchParams.get("s");
  const linkFor = (woId, n, s) =>
    `${BASE}/api/photo-link/${encodeURIComponent(woId)}/${n}${s == null ? "" : `?s=${encodeURIComponent(s)}`}`;
  const refused = async (label, url) => {
    const r = await fetch(url);
    const body = await bytesOf(r);
    ok(`NEGATIVE ${label}`,
      r.status === 403 && !isImage(r) && !body.equals(PNG_A) && !body.equals(PNG_B),
      `${r.status} ${r.headers.get("content-type")}`);
  };

  await refused("no signature at all is refused", linkFor(ours.wo.id, ours.n, null));
  await refused("an empty signature is refused", linkFor(ours.wo.id, ours.n, ""));
  await refused("an invented signature is refused", linkFor(ours.wo.id, ours.n, "not.asignature"));

  // Tamper: flip one character of the signature.
  const flipped = sig.slice(0, -1) + (sig.slice(-1) === "A" ? "B" : "A");
  await refused("a tampered signature is refused", linkFor(ours.wo.id, ours.n, flipped));

  // Replay OUR valid signature onto ANOTHER CUSTOMER'S photo. This is the
  // one that matters: the credential is genuine, and it must still not
  // reach a photo it was not minted for.
  await refused("OUR valid link replayed onto ANOTHER customer's photo is refused",
    linkFor(theirs.wo.id, theirs.n, sig));
  // ...and onto a different photo number on our own job.
  await refused("our valid link replayed onto a different photo number is refused",
    linkFor(ours.wo.id, ours.n + 1, sig));

  // Rewrite the payload to name their photo, keep our signature.
  {
    const [encoded, mac] = sig.split(".");
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const forged = Buffer.from(JSON.stringify({ ...payload, woId: theirs.wo.id, n: theirs.n }), "utf8").toString("base64url");
    await refused("a payload rewritten to name another customer's photo is refused",
      linkFor(theirs.wo.id, theirs.n, `${forged}.${mac}`));
  }

  // Their photo is still perfectly reachable through the staff route —
  // the refusals above are about the link, not a broken photo.
  const theirsStaff = await fetch(`${BASE}/api/work-orders/${encodeURIComponent(theirs.wo.id)}/photo/${theirs.n}`, { headers: { cookie } });
  ok("(control) the other customer's photo itself is fine — only the link is refused",
    theirsStaff.status === 200 && (await bytesOf(theirsStaff)).equals(PNG_B));

  // ================================================================
  // THE SIGNING RULE ITSELF
  // ================================================================
  console.log("\n  -- the signing rule --");
  const photoLinks = require(path.join(ROOT, "server", "lib", "photo-links.js"));
  const secret = "test-secret-not-the-real-one";
  const t0 = Date.parse("2026-09-27T00:00:00Z");
  const v = photoLinks.mint("WO-1", 3, secret, { now: t0, ttlMs: 1000 });
  ok("a link verifies for exactly the photo it names", photoLinks.verify(v, "WO-1", 3, secret, { now: t0 }));
  ok("NEGATIVE ...not for another photo number", !photoLinks.verify(v, "WO-1", 4, secret, { now: t0 }));
  ok("NEGATIVE ...not for another work order", !photoLinks.verify(v, "WO-2", 3, secret, { now: t0 }));
  ok("NEGATIVE ...not under another secret", !photoLinks.verify(v, "WO-1", 3, "other-secret", { now: t0 }));
  ok("NEGATIVE ...not once it has expired", !photoLinks.verify(v, "WO-1", 3, secret, { now: t0 + 1001 }));
  ok("NEGATIVE malformed input is false, never a throw",
    [null, undefined, "", ".", "a.", ".b", "%%%", 42, {}].every((bad) => photoLinks.verify(bad, "WO-1", 3, secret) === false));
  ok("the default lifetime is bounded (a link is not permanent)",
    photoLinks.DEFAULT_TTL_MS > 0 && photoLinks.DEFAULT_TTL_MS <= 400 * 24 * 60 * 60 * 1000,
    `${photoLinks.DEFAULT_TTL_MS / 86400000} days`);

  // ================================================================
  // NOTHING ELSE WIDENED
  // ================================================================
  console.log("\n  -- nothing else widened --");
  const serverSrc = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  const tmpl = serverSrc.slice(serverSrc.indexOf("function renderStatusUpdateHtml"), serverSrc.indexOf("async function parseRequestBody"));
  const tmplCode = tmpl.replace(/^\s*\/\/.*$/gm, "");
  ok("the email template emits no /api/work-orders/ URL", !tmplCode.includes("/api/work-orders/"));
  ok("the email template emits no portal URL", !tmplCode.includes("/api/portal/"));
  ok("the public route is outside the admin-gated /api/work-orders/ prefix",
    /pathname\.startsWith\("\/api\/photo-link\/"\)\) return null/.test(serverSrc));
  const anonUpload = await fetch(`${BASE}/api/work-orders/${encodeURIComponent(ours.wo.id)}/photos`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ photos: [] })
  });
  ok("NEGATIVE the work-order photo API is still closed to the signed-out",
    anonUpload.status === 401 || anonUpload.status === 403, String(anonUpload.status));
} finally {
  child.kill("SIGTERM");
  for (const [f, buf] of backups) {
    const p = path.join(DATA, f);
    if (buf === null) { if (fs.existsSync(p)) fs.rmSync(p); }
    else fs.writeFileSync(p, buf);
  }
  try { fs.rmSync(path.dirname(OUTBOX), { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\nphoto urls: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
