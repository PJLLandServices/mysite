#!/usr/bin/env node
// scripts/find-test-leads.js — JOB-009 (CRM-04 / CRM-05).
//
// READ-ONLY. Scans server/data/leads.json and lists candidates for deletion:
//
//   test-name  — the known test records: "John Charette" (fake booking,
//                CRM-04) and "Jeff John" (VD-3 walk of /quote.html)
//   plus-tag   — "+"-tagged email addresses (JOB-001 acceptance-run leads)
//   spam       — SEO-pitch heuristics in contact.notes: a URL, or
//                link-building/SEO vocabulary (CRM-05's two submissions)
//
// This script deletes NOTHING. Review the table, then delete the records in
// the CRM UI (bulk delete → Trash) — they stay recoverable in /admin/trash
// for 30 days before purge. Records already in Trash are skipped here.
//
// A LINKED column warns when a candidate carries a booking envelope or a
// customerId — those deserve a second look before deletion, because they
// were far enough along to touch other stores.
//
// Run on the Render shell:  node scripts/find-test-leads.js

const path = require("path");
const fs = require("fs");

const FILE = path.join(__dirname, "..", "server", "data", "leads.json");

const TEST_NAMES = ["john charette", "jeff john"];

// \b keeps "seo" from matching inside ordinary words ("season").
const SPAM_PATTERNS = [
  /https?:\/\//i, /\bwww\./i,
  /\bseo\b/i, /\bbacklinks?\b/i, /\blink[- ]building\b/i,
  /\bguest post/i, /\bgoogle rank/i, /\bfirst page of google\b/i,
  /\bsearch engine (optimization|ranking)/i, /\bweb(site)? (design|traffic)\b/i,
  /\bdigital marketing\b/i
];

function bucketFor(lead) {
  const name = String(lead.contact?.name || "").trim().toLowerCase();
  if (TEST_NAMES.includes(name)) return "test-name";
  const email = String(lead.contact?.email || "");
  if (/\+[^@]*@/.test(email)) return "plus-tag";
  const notes = String(lead.contact?.notes || "");
  if (SPAM_PATTERNS.some((re) => re.test(notes))) return "spam";
  return null;
}

function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`leads.json not found at ${FILE} — run this on the server.`);
    process.exit(1);
  }
  const leads = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const rows = [];
  for (const lead of leads) {
    if (lead.deletedAt) continue; // already in Trash
    const bucket = bucketFor(lead);
    if (!bucket) continue;
    const linked = [
      lead.booking ? "booking" : null,
      lead.customerId ? "customer" : null
    ].filter(Boolean).join("+") || "-";
    rows.push({
      bucket,
      id: lead.id,
      name: String(lead.contact?.name || "").slice(0, 24),
      email: String(lead.contact?.email || "").slice(0, 32),
      source: String(lead.sourceLabel || lead.source || "").slice(0, 20),
      status: String(lead.crm?.status || lead.status || ""),
      created: String(lead.createdAt || "").slice(0, 10),
      linked
    });
  }

  if (!rows.length) {
    console.log("No test, plus-tagged, or spam-flagged leads found. Pipeline is clean.");
    return;
  }

  rows.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.created.localeCompare(b.created));
  const cols = ["bucket", "id", "name", "email", "source", "status", "created", "linked"];
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join("  ");
  console.log(line(cols));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));

  console.log(`\n${rows.length} candidate(s). This script deleted nothing.`);
  console.log("Review the list — anything you recognize as a real customer stays.");
  console.log("LINKED != '-' means the lead carries a booking/customer link: double-check before deleting.");
  console.log("Delete in the CRM (bulk delete) — records land in /admin/trash, recoverable for 30 days.");
}

main();
