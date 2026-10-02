#!/usr/bin/env node
// scripts/test-po-crash-recovery.mjs
//
// A REAL crash between the two writes of a purchase-order save (Patrick,
// 2026-10-02: "Throwing an exception is not the same as the server dying
// between two file writes").
//
// Each scenario starts the server as its own process with
// scripts/lib/crash-at.cjs preloaded, sends one real request, and has the
// process SIGKILLed at an exact point — no exception, no cleanup, no
// finally block. What it left on disk is then booted by a FRESH server
// process, and the test checks what that process made of it:
//
//   A  receive, killed right after the first data file changed
//   B  receive, killed in the middle of the second data file's write
//   C  send, killed in the middle of the second write of its outcome
//   D  killed after BOTH writes, just before the journal is removed —
//      the journal must still be there
//   E  send, killed just BEFORE the supplier email — not sent
//   F  send, killed just AFTER the supplier email — sent, nothing saved
//   G  recovery run again (twice, and with the journal put back) changes
//      nothing
//   H  a truncated, a corrupt and a missing journal: the server still
//      starts, applies nothing, changes no data, and reports the problem —
//      and FAILS CLOSED: the records it can't vouch for are held, every
//      later send / receive / cancel / re-order / edit / delete on them is
//      refused (423 recovery_required), so nothing can compound the split;
//      the rest of the website and unrelated purchasing keep working
//   I  the office's release: refused without a note, refused while the
//      records still disagree, accepted once they agree — then the PO
//      works again
//
// After every recovery: the PO and its list lines agree (read-only audit),
// unrelated lines and POs are byte-for-byte unchanged, and retrying the
// same request is safe — nothing counted twice, nobody emailed twice.
//
// Run: npm run test:po-crash-recovery

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { bootServer, j } from "./e2e/lib/journey.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { auditPurchasingLines } = require(path.join(ROOT, "server", "lib", "purchasing-audit.js"));
const CRASH_AT = path.join(ROOT, "scripts", "lib", "crash-at.cjs");
const NEW_CODE = fs.existsSync(path.join(ROOT, "server", "lib", "purchasing.js"));
const S = (v) => JSON.stringify(v);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

// ── The data every scenario starts from, written straight to disk so it is
// the same whatever code is under test.
const T = "2026-10-01T12:00:00.000Z";
const line = (id, sku, qty, status, poId = null, frozenPriceCents = null) => ({ id, sku, qty, status, poId, frozenPriceCents, notes: "" });
const poLine = (id, sku, qty, listId, lineId, price, receivedQty = 0) => ({
  id, sku, qty, sourceListId: listId, sourceLineId: lineId, description: "", unitPriceCents: price, lineTotalCents: price * qty, notes: "", receivedQty, receivedAt: null
});
const list = (id, name, lineItems, status) => ({
  id, name, status, parentType: "project", parentId: "PRJ-CRASH", customerName: "", customerEmail: "", address: "", notes: "",
  lineItems, createdAt: T, updatedAt: T, createdBy: "admin", history: [{ ts: T, action: "created", by: "admin", note: "" }], deletedAt: null
});
const po = (id, status, lineItems, sourceMaterialListIds, extra = {}) => ({
  id, status, supplierId: null, supplierName: "SiteOne", supplierEmail: "orders@siteone.test", supplierContactName: "", supplierPhone: "", supplierAddress: "",
  sourceMaterialListIds, lineItems, subtotalCents: lineItems.reduce((n, l) => n + l.lineTotalCents, 0), notes: "", internalNotes: "",
  emailedToEmail: status === "draft" ? "" : "orders@siteone.test", emailedToName: "", emailSubject: "",
  sentAt: status === "draft" ? null : T, receivedAt: null, cancelledAt: null, cancelReason: "",
  createdAt: T, updatedAt: T, createdBy: "admin", history: [{ ts: T, action: "created", by: "admin", note: "" }], deletedAt: null,
  pdfPath: null, csvPath: null, documentsGeneratedAt: null, ...extra
});
function seed(DATA) {
  const lists = [
    // On a sent PO, both lines ordered on it — to be received.
    list("ML-2026-0001", "Front yard", [line("li_x", "61146", 4, "ordered", "PO-2026-0001", 100), line("li_y", "61147", 2, "ordered", "PO-2026-0001", 200)], "in_progress"),
    // A fresh list with a draft PO — to be sent.
    list("ML-2026-0002", "Back yard", [line("li_z", "61148", 3, "need")], "draft"),
    // Unrelated and already bought from: received, ordered elsewhere, not yet ordered.
    list("ML-2026-0003", "Side yard", [line("li_u1", "61150", 5, "have", null, 300), line("li_u2", "61151", 2, "ordered", "PO-2026-0003", 400), line("li_u3", "61152", 1, "need")], "in_progress")
  ];
  const pos = [
    po("PO-2026-0001", "sent", [poLine("pl_x", "61146", 4, "ML-2026-0001", "li_x", 100), poLine("pl_y", "61147", 2, "ML-2026-0001", "li_y", 200)], ["ML-2026-0001"]),
    po("PO-2026-0002", "draft", [poLine("pl_z", "61148", 3, "ML-2026-0002", "li_z", 500)], ["ML-2026-0002"]),
    po("PO-2026-0003", "sent", [poLine("pl_u2", "61151", 2, "ML-2026-0003", "li_u2", 400)], ["ML-2026-0003"])
  ];
  fs.writeFileSync(path.join(DATA, "material-lists.json"), JSON.stringify(lists, null, 2) + "\n");
  fs.writeFileSync(path.join(DATA, "purchase-orders.json"), JSON.stringify(pos, null, 2) + "\n");
}

const readText = (DATA, name) => { try { return fs.readFileSync(path.join(DATA, name), "utf8"); } catch { return null; } };
const readJson = (DATA, name) => { try { return JSON.parse(readText(DATA, name)); } catch { return null; } };
const unrelated = (DATA) => S({
  list: (readJson(DATA, "material-lists.json") || []).find((l) => l.id === "ML-2026-0003") || null,
  po: (readJson(DATA, "purchase-orders.json") || []).find((p) => p.id === "PO-2026-0003") || null
});
const auditOf = (DATA) => {
  const pos = readJson(DATA, "purchase-orders.json"), lists = readJson(DATA, "material-lists.json");
  if (!Array.isArray(pos) || !Array.isArray(lists)) return { unreadable: true, findings: [{ kind: "data file unreadable" }] };
  return auditPurchasingLines({ purchaseOrders: pos, materialLists: lists });
};
const poEmails = (srv) => srv.outbox().filter((m) => m.channel === "email" && /PO-2026-0002/.test(S(m))).length;

// Boot a server on the seeded data with the crash hook armed, make one
// request, and return what the dead process left on disk.
async function crashRun(label, crashAt, request, { prepare = null } = {}) {
  const srv = await bootServer({ port: 4969, preload: [CRASH_AT], env: { PJL_CRASH_AT: crashAt } });
  try {
    await srv.login();
    seed(srv.DATA);
    if (prepare) await prepare(srv);
    const before = { unrelated: unrelated(srv.DATA) };
    fs.writeFileSync(`${srv.OUTBOX}.arm`, "");
    const res = await request(srv).catch((e) => ({ status: "no response", error: String(e.message || e) }));
    const how = await Promise.race([srv.exited(), new Promise((r) => setTimeout(() => r(null), 3000))]);
    const trace = (readText(srv.TMP, "outbox.jsonl.crash") || "").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const killed = trace.find((t) => t.killed);
    ok(how === "SIGKILL" && killed, `${label}: the server process was killed at ${crashAt} (${how}; ${killed ? killed.detail : "not killed — answered " + S(res.status)})`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-crashed-"));
    fs.cpSync(srv.DATA, dir, { recursive: true });
    return { dir, before, emailsSent: poEmails(srv), killed: Boolean(killed) };
  } finally {
    await srv.stop();
  }
}

// A fresh server process on what the crashed one left.
async function restart(dir, port = 4970) {
  const srv = await bootServer({ port, seedData: dir });
  try { await srv.login(); } catch (err) { await srv.stop(); throw err; }
  return srv;
}

const receiveAll = (srv) => srv.api("POST", "/api/purchase-orders/PO-2026-0001/receive", {});
const sendPo = (srv) => srv.api("POST", "/api/purchase-orders/PO-2026-0002/send", { toEmail: "orders@siteone.test" });

// The nth write to a data file, counted from the request: the new code
// saves send as  mark (PO) → outcome (list, PO);  the old code as  PO → list.
const WRITE = NEW_CODE
  ? { receiveFirst: 1, receiveSecond: 2, sendSecond: 3 }
  : { receiveFirst: 1, receiveSecond: 2, sendSecond: 2 };

try {
  // ── A. Receive: killed right after the first data file changed.
  {
    const c = await crashRun("A", `data-written:${WRITE.receiveFirst}`, receiveAll);
    const midway = auditOf(c.dir);
    ok(!NEW_CODE || fs.existsSync(path.join(c.dir, "purchasing-journal.json")), "A: at the moment of death the journal is on disk (not removed with only one write done)");
    {
      // The list file changed first: its lines say "have" while the PO file
      // still says nothing arrived.
      const p = (readJson(c.dir, "purchase-orders.json") || []).find((x) => x.id === "PO-2026-0001");
      const l = (readJson(c.dir, "material-lists.json") || []).find((x) => x.id === "ML-2026-0001");
      const listMoved = (l?.lineItems || []).some((x) => x.status === "have");
      const poMoved = p?.status === "received";
      ok(listMoved !== poMoved || midway.findings.length > 0, `A: …and the two files really did disagree at that moment (list moved: ${listMoved}, PO moved: ${poMoved})`);
    }
    const srv = await restart(c.dir);
    try {
      ok(!fs.existsSync(path.join(srv.DATA, "purchasing-journal.json")), "A: the fresh process finished the interrupted save at boot");
      const a = auditOf(srv.DATA);
      ok(a.findings.length === 0, `A: the PO and its list lines agree (${S(a.findings.map((f) => [f.kind, f.sku]))})`);
      const p = (readJson(srv.DATA, "purchase-orders.json") || []).find((x) => x.id === "PO-2026-0001");
      const l = (readJson(srv.DATA, "material-lists.json") || []).find((x) => x.id === "ML-2026-0001");
      ok(p?.status === "received" && (l?.lineItems || []).every((x) => x.status === "have" && x.poId === null),
        `A: deterministically completed — PO received, both lines have it (${p?.status}, ${S((l?.lineItems || []).map((x) => x.status))})`);
      ok(unrelated(srv.DATA) === c.before.unrelated, "A: unrelated lines and PO byte-for-byte unchanged");
      const log = readJson(srv.DATA, "purchasing-recovery-log.json") || [];
      ok(log.some((e) => e.kind === "completed"), `A: the recovery is recorded (${S(log.map((e) => e.kind))})`);
      const bytes = readText(srv.DATA, "purchase-orders.json") + readText(srv.DATA, "material-lists.json");
      const r = await receiveAll(srv);
      ok(r.status === 200 && readText(srv.DATA, "purchase-orders.json") + readText(srv.DATA, "material-lists.json") === bytes,
        `A: retrying the receive is accepted and changes nothing (${r.status} ${j(r.body?.errors)})`);
      const pl = (readJson(srv.DATA, "purchase-orders.json") || []).find((x) => x.id === "PO-2026-0001")?.lineItems || [];
      ok(S(pl.map((x) => x.receivedQty)) === S([4, 2]), `A: received quantities counted once (${S(pl.map((x) => x.receivedQty))})`);
    } finally { await srv.stop(); }
    fs.rmSync(c.dir, { recursive: true, force: true });
  }

  // ── B. Receive: killed in the middle of the second data file's write.
  {
    const c = await crashRun("B", `data-torn:${WRITE.receiveSecond}`, receiveAll);
    const srv = await restart(c.dir);
    try {
      const a = auditOf(srv.DATA);
      ok(!a.unreadable, "B: both data files are readable after the restart (no half-written file)");
      ok(a.findings.length === 0, `B: the PO and its list lines agree (${S(a.findings.map((f) => [f.kind, f.sku]))})`);
      ok((readJson(srv.DATA, "purchase-orders.json") || []).find((x) => x.id === "PO-2026-0001")?.status === "received", "B: completed — PO received");
      ok(!fs.readdirSync(srv.DATA).some((n) => /\.tmp-/.test(n)), "B: the cut-off temp file was cleaned up");
      ok(unrelated(srv.DATA) === c.before.unrelated, "B: unrelated lines and PO byte-for-byte unchanged");
      const r = await receiveAll(srv);
      ok(r.status === 200 && auditOf(srv.DATA).findings.length === 0, `B: retrying the receive is safe (${r.status})`);
    } finally { await srv.stop(); }
    fs.rmSync(c.dir, { recursive: true, force: true });
  }

  // ── C. Send: killed in the middle of the second write of its outcome.
  {
    const c = await crashRun("C", `data-torn:${WRITE.sendSecond}`, sendPo);
    ok(c.emailsSent === 1, `C: the supplier email had gone before the crash (${c.emailsSent})`);
    const srv = await restart(c.dir);
    try {
      const a = auditOf(srv.DATA);
      ok(!a.unreadable && a.findings.length === 0, `C: the PO and its list line agree (${S(a.findings.map((f) => [f.kind, f.sku]))})`);
      const p = (readJson(srv.DATA, "purchase-orders.json") || []).find((x) => x.id === "PO-2026-0002");
      const z = (readJson(srv.DATA, "material-lists.json") || []).find((x) => x.id === "ML-2026-0002")?.lineItems?.[0];
      ok(p?.status === "sent" && !p?.sendInFlight && z?.status === "ordered" && z?.poId === "PO-2026-0002",
        `C: completed — PO sent, its line ordered on it (${p?.status}, ${z?.status})`);
      ok(unrelated(srv.DATA) === c.before.unrelated, "C: unrelated lines and PO byte-for-byte unchanged");
      const r = await sendPo(srv);
      ok(r.status === 409 && poEmails(srv) === 0, `C: retrying the send is refused and emails nobody (${r.status}, ${poEmails(srv)} more)`);
    } finally { await srv.stop(); }
    fs.rmSync(c.dir, { recursive: true, force: true });
  }

  // ── D. Killed after BOTH writes, just before the journal is removed.
  {
    const c = await crashRun("D", "journal-unlink:1", receiveAll);
    ok(c.killed && fs.existsSync(path.join(c.dir, "purchasing-journal.json")), "D: both writes done and the journal still on disk when the process died");
    const crashedBytes = readText(c.dir, "purchase-orders.json") + readText(c.dir, "material-lists.json");
    const srv = await restart(c.dir);
    try {
      ok(!fs.existsSync(path.join(srv.DATA, "purchasing-journal.json")), "D: the fresh process removed it");
      ok(readText(srv.DATA, "purchase-orders.json") + readText(srv.DATA, "material-lists.json") === crashedBytes, "D: …without changing either data file");
      ok(auditOf(srv.DATA).findings.length === 0, "D: the PO and its list lines agree");
    } finally { await srv.stop(); }
    fs.rmSync(c.dir, { recursive: true, force: true });
  }

  // ── E. Send: killed just BEFORE the supplier email.
  {
    const c = await crashRun("E", "email-before:1", sendPo);
    ok(c.emailsSent === 0, `E: nothing was emailed before the crash (${c.emailsSent})`);
    const srv = await restart(c.dir);
    try {
      const p = (readJson(srv.DATA, "purchase-orders.json") || []).find((x) => x.id === "PO-2026-0002");
      ok(p?.status === "draft" && p?.sendInFlight, `E: the PO is a draft marked as a send in flight (${p?.status}, ${S(p?.sendInFlight)})`);
      ok(auditOf(srv.DATA).findings.length === 0, "E: the PO and its list line agree");
      let r = await sendPo(srv);
      ok(r.status === 409 && r.body?.code === "delivery_uncertain" && poEmails(srv) === 0,
        `E: a retry is refused as delivery uncertain — the server cannot know the email never left (${r.status} ${r.body?.code}, ${poEmails(srv)} emails)`);
      r = await srv.api("POST", "/api/purchase-orders/PO-2026-0002/send-outcome", { outcome: "not_sent" });
      ok(r.status === 200 && r.body?.purchaseOrder?.status === "draft" && !r.body?.purchaseOrder?.sendInFlight, `E: the office records it did not go (${r.status})`);
      r = await sendPo(srv);
      ok(r.status === 200 && poEmails(srv) === 1, `E: then it sends — once (${r.status}, ${poEmails(srv)} email)`);
      ok(auditOf(srv.DATA).findings.length === 0 && unrelated(srv.DATA) === c.before.unrelated, "E: PO and list agree; unrelated records unchanged");
    } finally { await srv.stop(); }
    fs.rmSync(c.dir, { recursive: true, force: true });
  }

  // ── F. Send: killed just AFTER the supplier email.
  {
    const c = await crashRun("F", "email-after:1", sendPo);
    ok(c.emailsSent === 1, `F: the email went before the crash (${c.emailsSent})`);
    const srv = await restart(c.dir);
    try {
      let r = await sendPo(srv);
      ok(r.status === 409 && r.body?.code === "delivery_uncertain", `F: a retry is refused as delivery uncertain (${r.status} ${r.body?.code})`);
      ok(poEmails(srv) === 0, `F: …so the supplier is NOT emailed a second time (${poEmails(srv)})`);
      ok(/interrupted before its result was saved/.test(r.body?.errors?.[0] || ""), "F: …and the office is told why and what to do");
      r = await srv.api("POST", "/api/purchase-orders/PO-2026-0002/send-outcome", { outcome: "sent" });
      const p = r.body?.purchaseOrder;
      const z = (readJson(srv.DATA, "material-lists.json") || []).find((x) => x.id === "ML-2026-0002")?.lineItems?.[0];
      ok(r.status === 200 && p?.status === "sent" && !p?.sendInFlight && z?.status === "ordered" && z?.poId === "PO-2026-0002",
        `F: recording that it went saves the PO sent and its line ordered, together (${r.status} ${p?.status} ${z?.status})`);
      ok(poEmails(srv) === 0, "F: …without emailing anyone");
      ok((p?.sendAttempts || []).some((x) => x.outcome === "confirmed_delivered"), "F: …and the interrupted attempt is kept on record");
      ok(auditOf(srv.DATA).findings.length === 0 && unrelated(srv.DATA) === c.before.unrelated, "F: PO and list agree; unrelated records unchanged");
    } finally { await srv.stop(); }
    fs.rmSync(c.dir, { recursive: true, force: true });
  }

  // ── G. Recovery can run more than once without changing the result.
  {
    const c = await crashRun("G", `data-written:${WRITE.receiveFirst}`, receiveAll);
    const journal = readText(c.dir, "purchasing-journal.json");
    const once = await restart(c.dir);
    // Stop the process first, then copy what it left — never copy files a
    // running server may be renaming.
    const onceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-once-"));
    try {
      once.child.kill();
      await once.exited();
      fs.cpSync(once.DATA, onceDir, { recursive: true });
    } finally { await once.stop(); }
    const files = (d) => readText(d, "purchase-orders.json") + readText(d, "material-lists.json");
    const twice = await restart(onceDir, 4971);
    try {
      ok(files(twice.DATA) === files(onceDir), "G: a second boot on recovered data changes nothing");
      ok(S(readJson(twice.DATA, "purchasing-recovery-log.json")) === S(readJson(onceDir, "purchasing-recovery-log.json")), "G: …and records no second recovery");
    } finally { await twice.stop(); }
    if (journal) {
      // As if the first recovery died after rewriting the files but before
      // removing the journal: put the journal back and boot again.
      fs.writeFileSync(path.join(onceDir, "purchasing-journal.json"), journal);
      const again = await restart(onceDir, 4971);
      try {
        ok(files(again.DATA) === files(onceDir) && !fs.existsSync(path.join(again.DATA, "purchasing-journal.json")),
          "G: recovery replayed with the journal put back gives byte-identical files");
      } finally { await again.stop(); }
    } else ok(false, "G: there was a journal to replay");
    fs.rmSync(onceDir, { recursive: true, force: true });
    fs.rmSync(c.dir, { recursive: true, force: true });
  }

  // ── H. A truncated, a corrupt and a missing journal.
  for (const [kind, damage] of [
    ["truncated", (t) => t.slice(0, Math.floor(t.length / 2))],
    ["corrupt", () => '{"state":"commit","files":[{"name":"purchase-orders.json","before":5}]}'],
    ["missing", () => null]
  ]) {
    const c = await crashRun(`H-${kind}`, `data-written:${WRITE.receiveFirst}`, receiveAll);
    const journal = readText(c.dir, "purchasing-journal.json");
    const damaged = journal == null ? null : damage(journal);
    if (damaged == null) fs.rmSync(path.join(c.dir, "purchasing-journal.json"), { force: true });
    else fs.writeFileSync(path.join(c.dir, "purchasing-journal.json"), damaged);
    const files = (d) => readText(d, "purchase-orders.json") + readText(d, "material-lists.json");
    const crashedFiles = files(c.dir);
    const srv = await restart(c.dir);
    try {
      const up = await srv.api("GET", "/api/purchase-orders");
      ok(up.status === 200, `H-${kind}: the server still starts and serves purchase orders (${up.status})`);
      ok(files(srv.DATA) === crashedFiles, `H-${kind}: nothing was applied — both data files exactly as the crash left them`);
      ok(!fs.existsSync(path.join(srv.DATA, "purchasing-journal.json")), `H-${kind}: the damaged journal is no longer in the way`);
      if (kind !== "missing") {
        ok(fs.readdirSync(srv.DATA).some((n) => /^purchasing-journal\.corrupt-\d+\.json$/.test(n) && fs.readFileSync(path.join(srv.DATA, n), "utf8") === damaged),
          `H-${kind}: …it is kept, unchanged, for a person to look at`);
      }
      const problems = up.body?.purchasingRecovery;
      const reported = kind === "missing"
        ? (problems?.disagreements || 0) > 0
        : (problems?.problems || []).some((p) => p.kind === "journal_unreadable");
      ok(reported, `H-${kind}: the problem is reported by GET /api/purchase-orders (${S(problems)})`);
      ok(/RECOVERY PROBLEM|disagree/i.test(srv.logs()), `H-${kind}: …and in the server log`);

      // ── Fail closed. The truncated journal still names its records in
      // its header; the corrupt one names nothing, so everything is held;
      // the missing one is found by the boot check's disagreement.
      const holds = problems?.holds || [];
      const scoped = kind === "corrupt" ? holds.some((h) => h.scope === "all")
        : holds.some((h) => h.scope === "purchase_order" && h.id === "PO-2026-0001") && holds.some((h) => h.scope === "material_list" && h.id === "ML-2026-0001") && !holds.some((h) => h.scope === "all");
      ok(scoped, `H-${kind}: the records recovery can't vouch for are held — ${kind === "corrupt" ? "everything (the journal doesn't say which)" : "PO-2026-0001 and ML-2026-0001 only"} (${S(holds.map((h) => [h.scope, h.id]))})`);
      const page = await srv.api("GET", "/api/purchase-orders/PO-2026-0001");
      ok(/^Recovery required: .*locked/.test(page.body?.purchaseOrder?.recoveryHold?.message || ""), `H-${kind}: the PO itself carries the office's recovery-required message (${(page.body?.purchaseOrder?.recoveryHold?.message || "").slice(0, 80)})`);
      const listPage = await srv.api("GET", "/api/material-lists/ML-2026-0001");
      ok(/^Recovery required/.test(listPage.body?.list?.recoveryHold?.message || ""), `H-${kind}: …and so does its material list`);

      // Every later action on the held records is refused, and none of
      // them changes a byte.
      const held = [
        ["receive", () => srv.api("POST", "/api/purchase-orders/PO-2026-0001/receive", {})],
        ["receive one line", () => srv.api("POST", "/api/purchase-orders/PO-2026-0001/receive", { lineUpdates: { pl_x: 4 } })],
        ["cancel", () => srv.api("POST", "/api/purchase-orders/PO-2026-0001/cancel", { reason: "x" })],
        ["re-order", () => srv.api("POST", "/api/purchase-orders/PO-2026-0001/reorder")],
        ["re-send", () => srv.api("POST", "/api/purchase-orders/PO-2026-0001/resend", { toEmail: "orders@siteone.test" })],
        ["edit the PO", () => srv.api("PATCH", "/api/purchase-orders/PO-2026-0001", { notes: "edited" })],
        ["edit the list", () => srv.api("PATCH", "/api/material-lists/ML-2026-0001", { notes: "edited" })],
        ["delete the list", () => srv.api("DELETE", "/api/material-lists/ML-2026-0001")],
        ["order more from the list", () => srv.api("POST", "/api/purchase-orders", { supplierName: "Ewing", sourceMaterialListIds: ["ML-2026-0001"], lineItems: [{ sku: "61146", qty: 1, unitPriceCents: 100, sourceListId: "ML-2026-0001", sourceLineId: "li_x" }] })]
      ];
      for (const [what, act] of held) {
        const r = await act();
        ok(r.status === 423 && r.body?.code === "recovery_required" && /^Recovery required/.test(r.body?.errors?.[0] || ""),
          `H-${kind}: ${what} is refused as recovery required (${r.status} ${r.body?.code || ""})`);
      }
      ok(files(srv.DATA) === crashedFiles, `H-${kind}: after every one of those attempts both data files are still exactly as the crash left them — nothing compounded`);
      ok(poEmails(srv) === 0, `H-${kind}: …and nobody was emailed`);

      // The rest of the website keeps working; so does unrelated purchasing
      // (unless the journal named nothing and everything is held).
      const site = await srv.api("GET", "/api/booking/services");
      ok(site.status === 200, `H-${kind}: the rest of the website still serves (${site.status})`);
      const other = await sendPo(srv);
      if (kind === "corrupt") ok(other.status === 423, `H-${kind}: with everything held, an unrelated send is refused too (${other.status})`);
      else ok(other.status === 200 && poEmails(srv) === 1, `H-${kind}: an unrelated PO on another list still sends (${other.status})`);

      // No code picks a side: the office can't release while they disagree.
      const rel = await srv.api("POST", "/api/purchasing/recovery-holds/release", { scope: kind === "corrupt" ? "all" : "purchase_order", id: kind === "corrupt" ? null : "PO-2026-0001", note: "Checked the supplier invoice." });
      ok(rel.status === 409 && rel.body?.code === "still_disagrees", `H-${kind}: releasing the hold is refused while the records still disagree (${rel.status} ${rel.body?.code})`);
    } finally { await srv.stop(); }
    fs.rmSync(c.dir, { recursive: true, force: true });
  }
  // ── I. The office's release, once the records agree. Killed after BOTH
  // writes (D), then the journal damaged: the files agree, but recovery
  // can't prove it, so the records are held until a person releases them.
  {
    const c = await crashRun("I", "journal-unlink:1", receiveAll);
    const journal = readText(c.dir, "purchasing-journal.json");
    fs.writeFileSync(path.join(c.dir, "purchasing-journal.json"), journal ? journal.slice(0, Math.floor(journal.length / 3)) : "");
    const srv = await restart(c.dir);
    try {
      let r = await receiveAll(srv);
      ok(r.status === 423, `I: the held PO refuses a receive (${r.status})`);
      r = await srv.api("POST", "/api/purchasing/recovery-holds/release", { scope: "purchase_order", id: "PO-2026-0001", note: "" });
      ok(r.status === 400 && r.body?.code === "note_required", `I: a release needs a note saying what was checked (${r.status} ${r.body?.code})`);
      await srv.login({ role: "tech" });
      r = await srv.api("POST", "/api/purchasing/recovery-holds/release", { scope: "purchase_order", id: "PO-2026-0001", note: "x" });
      ok(r.status === 403, `I: a technician can't release a hold (${r.status})`);
      await srv.login();
      for (const [scope, id] of [["purchase_order", "PO-2026-0001"], ["material_list", "ML-2026-0001"]]) {
        r = await srv.api("POST", "/api/purchasing/recovery-holds/release", { scope, id, note: "Checked PO-2026-0001 against the delivery slip: both lines arrived." });
        ok(r.status === 200, `I: with the records agreeing, the office releases the ${scope} hold (${r.status} ${S(r.body?.errors)})`);
      }
      const log = readJson(srv.DATA, "purchasing-recovery-log.json") || [];
      ok(log.filter((e) => e.kind === "hold_released").length === 2 && log.every((e) => e.kind !== "hold_released" || /delivery slip/.test(e.note)), "I: each release is logged with who and what they checked");
      const before = readText(srv.DATA, "purchase-orders.json") + readText(srv.DATA, "material-lists.json");
      r = await receiveAll(srv);
      ok(r.status === 200 && readText(srv.DATA, "purchase-orders.json") + readText(srv.DATA, "material-lists.json") === before,
        `I: the PO works again — a repeat receive is accepted and changes nothing (${r.status})`);
    } finally { await srv.stop(); }
    fs.rmSync(c.dir, { recursive: true, force: true });
  }
} catch (err) {
  failed += 1;
  console.error("  FAIL: crashed —", err && err.stack || err);
}

console.log(`\npo crash recovery (${NEW_CODE ? "new" : "old"} code): ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
