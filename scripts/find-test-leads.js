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
// for 30 days before purge. Records already in Trash are skipped by default.
//
// A LINKED column warns when a candidate carries a booking envelope or a
// customerId — those deserve a second look before deletion, because they
// were far enough along to touch other stores.
//
// ALWAYS prints what it read — absolute path, total records, how many are in
// Trash, how many live records were actually scanned — BEFORE any verdict.
// A bare "pipeline is clean" is ambiguous three ways and cost a round trip
// once already: it reads the same whether the records are genuinely gone,
// already sitting in Trash (skipped), or the file is empty because the wrong
// path was read. The header tells those three apart at a glance.
//
// Run on the Render shell:  node scripts/find-test-leads.js
//   --include-trashed   also list matches already in Trash (answers "did I
//                       already delete these?" without touching anything)

const path = require("path");
const fs = require("fs");

const FILE = path.join(__dirname, "..", "server", "data", "leads.json");

const INCLUDE_TRASHED = process.argv.includes("--include-trashed");

const TEST_NAMES = ["john charette", "jeff john"];

// A lead's display name can live in contact.name, or only as
// contact.firstName + contact.lastName (the self-intake path writes all
// three, older records may not). Collapse internal whitespace so "John
// Charette" still matches "John  Charette".
function displayName(lead) {
  const c = lead.contact || {};
  const composed = [c.firstName, c.lastName].filter(Boolean).join(" ");
  return String(c.name || c.fullName || composed || "").replace(/\s+/g, " ").trim();
}

// \b keeps "seo" from matching inside ordinary words ("season").
//
// `label` names the matched signal in the WHY column, so a spam-bucket row can
// be judged without opening the record. Ordered weakest-signal-last: a bare URL
// is the one pattern a genuine customer trips ("saw your review page at
// https://…"), so it only wins when no SEO-pitch vocabulary matched.
const SPAM_PATTERNS = [
  { re: /\bbacklinks?\b/i,                       label: "backlinks" },
  { re: /\blink[- ]building\b/i,                  label: "link-building" },
  { re: /\bguest post/i,                          label: "guest-post" },
  { re: /\bgoogle rank/i,                         label: "google-rank" },
  { re: /\bfirst page of google\b/i,              label: "first-page-google" },
  { re: /\bsearch engine (optimization|ranking)/i, label: "search-engine" },
  { re: /\bweb(site)? (design|traffic)\b/i,        label: "website-design" },
  { re: /\bdigital marketing\b/i,                 label: "digital-marketing" },
  { re: /\bseo\b/i,                               label: "seo" },
  { re: /https?:\/\//i,                           label: "url-only" },
  { re: /\bwww\./i,                               label: "url-only" }
];

// A spam-bucket hit that ALSO looks like a real customer. The two SEO
// submissions CRM-05 is about are drive-by contact-form posts: no booking, no
// customer record, still sitting at "new". Anything else matched by a content
// heuristic is a customer who happened to type a link — LEAD "url-only" rows
// especially. Flagged, not filtered: the script's job is to make the judgement
// easy, not to make it for you.
const BENIGN_STATUSES = ["", "new", "spam"];

function realCustomerSignals(lead) {
  const signals = [];
  if (lead.booking) signals.push("booking");
  if (lead.customerId) signals.push("customer");
  const status = String(lead.crm?.status || lead.status || "").toLowerCase();
  if (!BENIGN_STATUSES.includes(status)) signals.push(`status=${status}`);
  return signals;
}

function bucketFor(lead) {
  const name = displayName(lead).toLowerCase();
  if (TEST_NAMES.includes(name)) return { bucket: "test-name", why: "known test record" };
  const email = String(lead.contact?.email || "");
  if (/\+[^@]*@/.test(email)) return { bucket: "plus-tag", why: "+tag in email" };
  const notes = String(lead.contact?.notes || "");
  const hit = SPAM_PATTERNS.find(({ re }) => re.test(notes));
  if (hit) return { bucket: "spam", why: hit.label };
  return null;
}

function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`leads.json not found at ${FILE} — run this on the server.`);
    process.exit(1);
  }
  const parsed = JSON.parse(fs.readFileSync(FILE, "utf8") || "[]");
  if (!Array.isArray(parsed)) {
    console.error(`${FILE} did not contain a JSON array (got ${typeof parsed}).`);
    console.error("The store shape changed — this script needs updating before you trust it.");
    process.exit(1);
  }
  const leads = parsed;
  const trashed = leads.filter((l) => l.deletedAt);
  const live = leads.filter((l) => !l.deletedAt);

  // Always say what was read, before any verdict. "Clean" means nothing
  // without these numbers.
  console.log(`file:    ${FILE}`);
  console.log(`records: ${leads.length} total — ${live.length} live, ${trashed.length} in Trash`);
  console.log(`scanned: ${INCLUDE_TRASHED ? leads.length : live.length}` +
    (INCLUDE_TRASHED ? " (including Trash)" : " live records (Trash skipped; --include-trashed to see them)"));
  console.log("");

  if (!leads.length) {
    console.log("!! leads.json is EMPTY — 0 records.");
    console.log("   That is almost certainly the wrong file, not an empty CRM. Check that the");
    console.log("   Render persistent disk is mounted at server/data, and that you are in the");
    console.log("   service's project root. Do NOT read this as 'nothing to delete'.");
    return;
  }

  const rows = [];
  for (const lead of INCLUDE_TRASHED ? leads : live) {
    const match = bucketFor(lead);
    if (!match) continue;
    const linked = [
      lead.booking ? "booking" : null,
      lead.customerId ? "customer" : null
    ].filter(Boolean).join("+") || "-";
    // Only the content-heuristic bucket can misfire on a real person — a name
    // match and a +tag are deliberate acts, not inference.
    const signals = match.bucket === "spam" ? realCustomerSignals(lead) : [];
    rows.push({
      keep: signals.length ? "KEEP?" : "",
      bucket: match.bucket,
      id: lead.id,
      trash: lead.deletedAt ? "TRASH" : "",
      name: displayName(lead).slice(0, 24),
      email: String(lead.contact?.email || "").slice(0, 32),
      source: String(lead.sourceLabel || lead.source || "").slice(0, 20),
      status: String(lead.crm?.status || lead.status || ""),
      created: String(lead.createdAt || "").slice(0, 10),
      linked,
      why: match.why,
      signals
    });
  }

  if (!rows.length) {
    console.log(`No test, plus-tagged, or spam-flagged leads among the ${INCLUDE_TRASHED ? leads.length : live.length} record(s) scanned.`);
    if (!INCLUDE_TRASHED && trashed.length) {
      console.log("");
      console.log(`NOTE: ${trashed.length} record(s) are in Trash and were NOT scanned. If you already`);
      console.log("      deleted the test records, they are in there and this is the expected result.");
      console.log("      Re-run with --include-trashed to confirm that rather than assume it.");
    } else if (!INCLUDE_TRASHED) {
      console.log("");
      console.log("Trash is empty too, so the records were not simply deleted earlier. If CRM-04/05");
      console.log("say they should be here, the mismatch is real — check the names in the CRM against");
      console.log(`TEST_NAMES in this script (${TEST_NAMES.join(", ")}); a record stored under a`);
      console.log("different spelling will not match.");
    }
    return;
  }

  rows.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.created.localeCompare(b.created));
  const cols = ["keep", "trash", "bucket", "id", "name", "email", "source", "status", "created", "linked", "why"];
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join("  ");
  console.log(line(cols));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));

  const flagged = rows.filter((r) => r.signals.length);
  console.log(`\n${rows.length} candidate(s). This script deleted nothing.`);

  if (flagged.length) {
    console.log(`\n!! ${flagged.length} row(s) marked KEEP? — matched a spam heuristic but look like`);
    console.log("   REAL CUSTOMERS. Do NOT bulk-delete these without opening the record:");
    for (const r of flagged) {
      console.log(`   - ${r.id}  ${r.name} <${r.email}>  [${r.signals.join(", ")}]  matched: ${r.why}`);
    }
    console.log("   A 'url-only' match is just a link in the message — customers paste links too.");
  }

  console.log("\nReview the list — anything you recognize as a real customer stays.");
  console.log("LINKED != '-' means the lead carries a booking/customer link: double-check before deleting.");
  console.log("Delete in the CRM (bulk delete) — records land in /admin/trash, recoverable for 30 days.");
}

main();
