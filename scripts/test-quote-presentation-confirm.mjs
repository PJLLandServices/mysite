#!/usr/bin/env node
// scripts/test-quote-presentation-confirm.mjs — pins the 2026-09-20 PJL-48
// fix: markSentForApproval() must refuse to send a project_proposal unless
// the caller explicitly confirms the presentation mode it's about to send,
// and that confirmation must match the quote's LIVE pdfOptions.lineItems.
//
// Before this fix, markSentForApproval() sent whatever pdfOptions.lineItems
// happened to be on the record with no gate at all — the UI could open a
// confirmation dialog, but nothing on the server actually required it, so
// a stale page or a direct API call could route around it. Each assertion
// below is written to FAIL on the pre-fix code, per CLAUDE.md's rule.
//
// Run: node scripts/test-quote-presentation-confirm.mjs  (also in build:check)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let passed = 0, failed = 0;
const ok = (c, label) => { if (c) passed += 1; else { failed += 1; console.error("  FAIL:", label); } };

// Same isolation pattern as test-quote-revision-presentation.mjs.
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-quote-confirm-"));
fs.mkdirSync(path.join(SB, "lib"), { recursive: true });
fs.mkdirSync(path.join(SB, "data"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "server", "lib", "quotes.js"), path.join(SB, "lib", "quotes.js"));
fs.copyFileSync(path.join(ROOT, "server", "lib", "atomic-json.js"), path.join(SB, "lib", "atomic-json.js"));

const require = createRequire(import.meta.url);
const quotes = require(path.join(SB, "lib", "quotes.js"));

async function throws(fn, label) {
  try { await fn(); ok(false, `${label} (did not throw)`); }
  catch (err) { ok(true, label); return err; }
}

// ---- 1: sending a project_proposal with no confirmation is refused ----
{
  const q = await quotes.create({ type: "project_proposal", branch: null });
  const err = await throws(
    () => quotes.markSentForApproval(q.id, { token: "1".repeat(32), channels: [], toEmail: "" }),
    "send refused with no confirmedPresentation at all — FAILS on unfixed code, which sends unconditionally"
  );
  ok(err && err.code === "presentation_not_confirmed", "refusal carries code presentation_not_confirmed");
  const after = await quotes.get(q.id);
  ok(after.status === "draft", "quote stays draft — the refused send did not silently go through");
}

// ---- 2: an invalid mode string is refused (not just "missing") ----
{
  const q = await quotes.create({ type: "project_proposal", branch: null });
  await throws(
    () => quotes.markSentForApproval(q.id, { token: "2".repeat(32), channels: [], toEmail: "", confirmedPresentation: "not_a_real_mode" }),
    "an unrecognized confirmedPresentation value is refused, not coerced to a default"
  );
}

// ---- 3: confirming a DIFFERENT mode than what's actually set is refused ----
{
  const q = await quotes.create({ type: "project_proposal", branch: null });
  await quotes.updateProposal(q.id, { pdfOptions: { lineItems: "summary" } });
  const err = await throws(
    () => quotes.markSentForApproval(q.id, { token: "3".repeat(32), channels: [], toEmail: "", confirmedPresentation: "itemized" }),
    'confirming "itemized" when the record is actually set to "summary" is refused — catches a stale dialog / a second tab changing it first'
  );
  ok(err && err.code === "presentation_confirmation_stale", "refusal carries code presentation_confirmation_stale");
}

// ---- 4: confirming the mode that's actually set succeeds ----
{
  const q = await quotes.create({ type: "project_proposal", branch: null });
  await quotes.updateProposal(q.id, { pdfOptions: { lineItems: "descriptions_only" } });
  const sent = await quotes.markSentForApproval(q.id, {
    token: "4".repeat(32), channels: ["email"], toEmail: "customer@example.com", confirmedPresentation: "descriptions_only"
  });
  ok(sent.status === "sent", "matching confirmation sends successfully");
}

// ---- 5: a revision must be re-confirmed — carrying pdfOptions forward ----
// ----    (PJL-46) is not the same as confirming it for THIS send (PJL-48) ----
{
  const v1 = await quotes.create({ type: "project_proposal", branch: null });
  await quotes.updateProposal(v1.id, { pdfOptions: { lineItems: "summary" } });
  await quotes.markSentForApproval(v1.id, { token: "5".repeat(32), channels: [], toEmail: "", confirmedPresentation: "summary" });
  const v2 = await quotes.createRevision(v1.id, { by: "admin" });
  ok(v2.pdfOptions.lineItems === "summary", "v2 carries v1's presentation forward (PJL-46, sanity check)");
  await throws(
    () => quotes.markSentForApproval(v2.id, { token: "6".repeat(32), channels: [], toEmail: "" }),
    "v2 still requires its OWN explicit confirmation before it can send, even though the mode carried over"
  );
  const sentV2 = await quotes.markSentForApproval(v2.id, {
    token: "6".repeat(32), channels: [], toEmail: "", confirmedPresentation: "summary"
  });
  ok(sentV2.status === "sent", "v2 sends once explicitly confirmed");
}

// ---- 6: non-proposal quote types are unaffected (no confirmation needed) ----
{
  const repair = await quotes.create({ type: "on_site_quote", customerId: null });
  const sent = await quotes.markSentForApproval(repair.id, { token: "7".repeat(32), channels: [], toEmail: "" });
  ok(sent.status === "sent", "an on_site_quote sends with no confirmedPresentation — the gate is project_proposal-only");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
