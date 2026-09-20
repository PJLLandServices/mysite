#!/usr/bin/env node
// scripts/test-quote-revision-presentation.mjs — pins the 2026-09-20 fix for
// the quote-revision incident (see docs/FLOW_REGISTER.md, FLOW-20).
//
// The bug: createRevision() built every new revision from blankQuote(),
// which hardcodes pdfOptions.lineItems to "itemized" — so a revision always
// silently reverted to fully-itemized pricing regardless of what the
// superseded quote actually showed the customer. A related defect: the
// customer-facing /approve/:id/:token link for a superseded quote kept
// resolving to the live record forever, with nothing distinguishing "this
// quote moved on" from "this token is still current."
//
// This file tests the quotes.js lib functions directly (createRevision,
// isSuperseded) — the actual HTTP route gating in server.js is exercised
// by Patrick's own walk-through per FLOW_REGISTER's PASS convention, not by
// an automated test here (server.js isn't unit-testable in isolation).
//
// Each assertion below is written to FAIL on the pre-fix code and PASS
// after it, per CLAUDE.md's lifecycle-state rule ("pin it with a test that
// fails on the OLD code").
//
// Run: node scripts/test-quote-revision-presentation.mjs  (also in build:check)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let passed = 0, failed = 0;
const ok = (c, label) => { if (c) passed += 1; else { failed += 1; console.error("  FAIL:", label); } };

// Isolation: quotes.js resolves its store as `<lib>/../data/quotes.json`
// (same pattern as quote-views.js in test-quote-views.mjs), so a temp
// sandbox with lib/ + data/ is the whole fixture. quotes.js requires only
// ./atomic-json at module load — customers.js is required lazily, and only
// on code paths this test never takes (no customerEmail is passed).
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-quote-revision-"));
fs.mkdirSync(path.join(SB, "lib"), { recursive: true });
fs.mkdirSync(path.join(SB, "data"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "server", "lib", "quotes.js"), path.join(SB, "lib", "quotes.js"));
fs.copyFileSync(path.join(ROOT, "server", "lib", "atomic-json.js"), path.join(SB, "lib", "atomic-json.js"));

const require = createRequire(import.meta.url);
const quotes = require(path.join(SB, "lib", "quotes.js"));

const TOKEN_V1 = "a".repeat(32);

// ---- 1: a revision carries the superseded quote's presentation forward ----
{
  const v1 = await quotes.create({ type: "project_proposal", branch: null });
  ok(v1.status === "draft", "v1 created as draft");

  await quotes.updateProposal(v1.id, { pdfOptions: { lineItems: "summary" } });
  const sent = await quotes.markSentForApproval(v1.id, {
    token: TOKEN_V1, channels: ["email"], toEmail: "customer@example.com", confirmedPresentation: "summary"
  });
  ok(sent.status === "sent", "v1 sent");
  ok(sent.pdfOptions.lineItems === "summary", "v1 sent as summary (sanity)");

  const v2 = await quotes.createRevision(v1.id, { by: "admin" });
  ok(v2.status === "draft", "v2 starts as draft");
  ok(v2.revisionOf === v1.id, "v2.revisionOf points at v1");
  ok(
    v2.pdfOptions.lineItems === "summary",
    'v2 carries "summary" forward as its starting presentation — FAILS on unfixed code, which defaults to "itemized"'
  );

  const original = await quotes.get(v1.id);
  ok(original.status === "superseded", "v1 flips to superseded");
  ok(original.supersededBy === v2.id, "v1.supersededBy points at v2");
}

// ---- 2: the chain extends (v3 carries v2's presentation, not v1's) ----
{
  const v1 = await quotes.create({ type: "project_proposal", branch: null });
  await quotes.updateProposal(v1.id, { pdfOptions: { lineItems: "descriptions_only" } });
  await quotes.markSentForApproval(v1.id, { token: "b".repeat(32), channels: [], toEmail: "", confirmedPresentation: "descriptions_only" });

  const v2 = await quotes.createRevision(v1.id, { by: "admin" });
  await quotes.updateProposal(v2.id, { pdfOptions: { lineItems: "itemized" } }); // Patrick deliberately changed it on v2
  await quotes.markSentForApproval(v2.id, { token: "c".repeat(32), channels: [], toEmail: "", confirmedPresentation: "itemized" });

  const v3 = await quotes.createRevision(v2.id, { by: "admin" });
  ok(
    v3.pdfOptions.lineItems === "itemized",
    "v3 carries v2's (the immediately-superseded quote's) presentation forward, not v1's original choice"
  );
}

// ---- 3: isSuperseded() is the one shared check every reader can use ----
{
  const v1 = await quotes.create({ type: "project_proposal", branch: null });
  ok(quotes.isSuperseded(v1) === false, "a draft is not superseded");

  await quotes.markSentForApproval(v1.id, { token: "d".repeat(32), channels: [], toEmail: "", confirmedPresentation: "itemized" });
  const sent = await quotes.get(v1.id);
  ok(quotes.isSuperseded(sent) === false, "a sent quote is not superseded");

  await quotes.createRevision(v1.id, { by: "admin" });
  const original = await quotes.get(v1.id);
  ok(quotes.isSuperseded(original) === true, "the superseded original reads true");

  ok(quotes.isSuperseded(null) === false, "null is tolerated, never throws");
  ok(quotes.isSuperseded(undefined) === false, "undefined is tolerated, never throws");
}

// ---- 4: the token still resolves a superseded quote (so a reader CAN show ----
// ----    Patrick's specific message) — but isSuperseded(q) on the result   ----
// ----    is how every reader must decide whether to actually show it       ----
{
  const v1 = await quotes.create({ type: "project_proposal", branch: null });
  const token = "e".repeat(32);
  await quotes.markSentForApproval(v1.id, { token, channels: [], toEmail: "", confirmedPresentation: "itemized" });
  await quotes.createRevision(v1.id, { by: "admin" });

  const byToken = await quotes.getByApprovalToken(v1.id, token);
  ok(byToken !== null, "the old token still resolves the record (needed to identify WHICH quote moved on)");
  ok(byToken.status === "superseded", "and its status says why the caller must refuse to serve it");
  ok(quotes.isSuperseded(byToken) === true, "quotes.isSuperseded(byToken) is how every /approve route reader gates on this");

  const wrongToken = await quotes.getByApprovalToken(v1.id, "f".repeat(32));
  ok(wrongToken === null, "a genuinely wrong token still resolves to nothing, same as before this fix");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
