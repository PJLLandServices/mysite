// Property merge — the re-point pass, the refusals, and the things the
// merge must never lose.
//
//   node scripts/test-merge-properties.mjs
//
// WHAT THIS COVERS. merge-properties.mjs deletes a property record, so the
// cost of a bug is a customer's history. This pins:
//
//   1. Every reference to the duplicate is re-pointed — including the ones
//      nested below the top level (warranty claims carry theirs at
//      link.propertyId), which is the class of miss that would silently
//      orphan a record.
//   2. A dry run writes NOTHING. The data directory is checksummed file by
//      file before and after.
//   3. Append-only records (the void-invoice tombstone log, the email log)
//      are reported and left alone.
//   4. Issued invoices keep the address they were issued with, and only an
//      explicit flag touches a DRAFT one.
//   5. Consent survives: an opt-out on either record wins, and a live
//      unsubscribe token is never dropped when the keeper has none.
//   6. The walked system record is never invented — two zone lists conflict
//      loudly instead of concatenating.
//   7. The refusals: unknown property, merging a record into itself, and
//      two different customers without the override.
//   8. --apply backs up every file it touches before writing.
//
// Fixtures reproduce the real case this was written for: one customer, two
// properties for one address, one invoice on each.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { mergeProperties } = await import(path.join(ROOT, "scripts/merge-properties.mjs"));

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const KEEP_ID = "prop-keeper-0040";
const DUP_ID = "prop-dupe-0056";
const CUSTOMER = "CUST-0311";

function fixtures() {
  const properties = [
    {
      id: KEEP_ID,
      code: "P-2026-0040",
      customerId: CUSTOMER,
      customerEmail: "randy@example.invalid",
      customerName: "Randy State",
      customerPhone: "905-555-0102",
      address: "88 Kingsmere Avenue, Newmarket, ON L3Y 1M8, Canada",
      addressNormalized: "88 kingsmere avenue newmarket on l3y 1m8 canada",
      coords: { lat: 44.05, lng: -79.46, formattedAddress: "88 Kingsmere Avenue" },
      billingEntity: "",
      billingCcEmail: "",
      siteContacts: [],
      system: {
        controllerLocation: "Garage, north wall",
        controllerBrand: "",
        shutoffLocation: "",
        blowoutLocation: "",
        valveBoxes: [],
        zones: [{ number: 1, label: "Front lawn" }, { number: 2, label: "Side bed" }],
        zoneCount: null,
        notes: ""
      },
      photos: [{ id: "ph-1", slot: "controller", url: "/x.jpg" }],
      leadIds: ["lead-a"],
      workOrderIds: ["WO-A"],
      deferredIssues: [{ id: "def-1", type: "head", status: "open" }],
      serviceRecords: [{ id: "sr-1", woId: "WO-A", completedAt: "2026-05-01T00:00:00.000Z" }],
      history: [{ ts: "2026-04-01T00:00:00.000Z", action: "created", by: "system", note: "" }],
      ownerHistory: [],
      seasonalEligibility: { springOpening: true, fallClosing: true },
      seasonalPricing: {
        springOpeningPrice: 185,
        fallClosingPrice: null,
        hasAdditionalFallBlowout: false,
        additionalFallBlowoutPrice: null,
        additionalFallBlowoutDescription: ""
      },
      seasonalOutreach: {
        "2026:spring_opening": {
          touches: [{ ts: "2026-03-01T00:00:00.000Z", channels: ["email"], by: "patrick", messageBatchId: "b1" }],
          optOutThisSeason: false
        }
      },
      commPrefs: {
        seasonalRemindersSMS: true,
        seasonalRemindersEmail: true,
        reviewRequestsEmail: true,
        optOutTokens: { seasonalSMS: "tok-keep-sms", seasonalEmail: null, seasonalAll: null, reviewEmail: null }
      },
      deletedAt: null,
      archivedAt: null,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z"
    },
    {
      id: DUP_ID,
      code: "P-2026-0056",
      customerId: CUSTOMER,
      customerEmail: "randy@example.invalid",
      customerName: "Randy State",
      customerPhone: "",
      // Same house, the way Dispatch wrote it.
      address: "88 Kingsmere Ave, Newmarket",
      addressNormalized: "88 kingsmere ave newmarket",
      coords: null,
      billingEntity: "",
      billingCcEmail: "randy.bookkeeper@example.invalid",
      siteContacts: [],
      system: {
        controllerLocation: "",
        controllerBrand: "Hunter HPC-400",
        shutoffLocation: "Basement utility room",
        blowoutLocation: "",
        valveBoxes: [],
        // A second, thinner version of the SAME physical system.
        zones: [{ number: 1, label: "Front" }],
        zoneCount: 6,
        notes: ""
      },
      photos: [{ id: "ph-2", slot: "shutoff", url: "/y.jpg" }],
      leadIds: ["lead-b"],
      workOrderIds: ["WO-B"],
      deferredIssues: [{ id: "def-2", type: "valve", status: "open" }],
      serviceRecords: [{ id: "sr-2", woId: "WO-B", completedAt: "2026-08-01T00:00:00.000Z" }],
      history: [{ ts: "2026-07-01T00:00:00.000Z", action: "created", by: "system", note: "" }],
      ownerHistory: [],
      // The customer opted OUT of fall reminders on this record.
      seasonalEligibility: { springOpening: true, fallClosing: false },
      seasonalPricing: {
        springOpeningPrice: null,
        fallClosingPrice: 210,
        hasAdditionalFallBlowout: false,
        additionalFallBlowoutPrice: null,
        additionalFallBlowoutDescription: ""
      },
      seasonalOutreach: {
        "2026:spring_opening": {
          touches: [{ ts: "2026-03-14T00:00:00.000Z", channels: ["sms"], by: "patrick", messageBatchId: "b2" }],
          optOutThisSeason: true
        },
        "2026:fall_closing": { touches: [], optOutThisSeason: false }
      },
      commPrefs: {
        seasonalRemindersSMS: true,
        // Unsubscribed by email on this record.
        seasonalRemindersEmail: false,
        reviewRequestsEmail: true,
        optOutTokens: { seasonalSMS: "tok-dupe-sms", seasonalEmail: "tok-dupe-email", seasonalAll: null, reviewEmail: null }
      },
      deletedAt: null,
      archivedAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z"
    }
  ];

  const invoices = [
    {
      id: "I-2026-0071", propertyId: KEEP_ID, customerId: CUSTOMER, status: "paid", total: 185,
      address: "88 Kingsmere Avenue, Newmarket, ON L3Y 1M8, Canada",
      billTo: { name: "Randy State", careOf: "", address: "88 Kingsmere Avenue, Newmarket, ON L3Y 1M8, Canada", email: "randy@example.invalid", ccEmail: "" }
    },
    {
      id: "I-2026-0093", propertyId: DUP_ID, customerId: CUSTOMER, status: "sent", total: 210,
      address: "88 Kingsmere Ave, Newmarket",
      billTo: { name: "Randy State", careOf: "", address: "88 Kingsmere Ave, Newmarket", email: "randy@example.invalid", ccEmail: "" }
    },
    {
      id: "I-2026-0101", propertyId: DUP_ID, customerId: CUSTOMER, status: "draft", total: 95,
      address: "88 Kingsmere Ave, Newmarket",
      billTo: { name: "Randy State", careOf: "", address: "88 Kingsmere Ave, Newmarket", email: "randy@example.invalid", ccEmail: "" }
    }
  ];

  return {
    "properties.json": properties,
    "invoices.json": invoices,
    "leads.json": [
      { id: "lead-a", propertyId: KEEP_ID, name: "Randy State", address: "88 Kingsmere Avenue" },
      {
        id: "lead-b", propertyId: DUP_ID, name: "Randy State", address: "88 Kingsmere Ave",
        propertyLinkSuggestions: [{ id: KEEP_ID, address: "88 Kingsmere Avenue", bookingCount: 1 }]
      },
      {
        id: "lead-c", propertyId: KEEP_ID, name: "Randy State", address: "88 Kingsmere Avenue",
        propertyLinkSuggestions: [{ id: DUP_ID, address: "88 Kingsmere Ave", bookingCount: 1 }]
      }
    ],
    "work-orders.json": [
      { id: "WO-B", propertyId: DUP_ID, type: "service_visit", status: "complete", address: "88 Kingsmere Ave" }
    ],
    "quotes.json": [
      { id: "Q-2026-0088", propertyId: DUP_ID, type: "on_site_repair", status: "accepted" }
    ],
    "bookings.json": [
      { id: "bk-9", propertyId: DUP_ID, serviceType: "fall_closing", date: "2026-10-14" }
    ],
    "projects.json": [
      { id: "PRJ-4", propertyId: DUP_ID, title: "Drip retrofit", status: "active" }
    ],
    "review-requests.json": [
      { id: "rr-3", propertyId: DUP_ID, status: "pending" }
    ],
    // The nested one. A top-level-only rewrite misses this.
    "warranty-claims.json": [
      { id: "wc-2", claimNumber: "2026-08-01-00020260002", status: "open", link: { propertyId: DUP_ID, invoiceId: "I-2026-0093" } }
    ],
    // Append-only. Must survive untouched.
    "deleted-invoices.json": [
      { id: "I-2026-0044", propertyId: DUP_ID, status: "void", total: 95, address: "88 Kingsmere Ave" }
    ],
    "email-log.json": [
      { id: "log-1", propertyId: DUP_ID, to: "randy@example.invalid" }
    ],
    // Never referenced by property id — must be left alone and not crash
    // the directory walk.
    "geocode-cache.json": { "88 kingsmere ave": { lat: 44.05, lng: -79.46 } },
    "settings.json": { companyName: "PJL Land Services" }
  };
}

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-merge-"));
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  for (const [name, value] of Object.entries(fixtures())) {
    fs.writeFileSync(path.join(dataDir, name), JSON.stringify(value, null, 2) + "\n", "utf8");
  }
  return dataDir;
}

function checksumDir(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    out[name] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
  }
  return out;
}

const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));

// ---- 1. Dry run: full plan, zero writes ------------------------------

{
  const dataDir = makeSandbox();
  const before = checksumDir(dataDir);
  const result = mergeProperties({ dataDir, keep: "P-2026-0040", remove: "P-2026-0056" });
  const after = checksumDir(dataDir);

  ok("dry run succeeds", result.ok === true, JSON.stringify(result.problems));
  ok("dry run reports itself as not applied", result.applied === false);
  ok("dry run writes nothing", JSON.stringify(before) === JSON.stringify(after));
  ok("dry run creates no backup dir", !fs.existsSync(path.join(dataDir, "_merge-backups")));

  const filesInPlan = result.plan.repoints.map((r) => r.file).sort();
  for (const expected of [
    "bookings.json", "invoices.json", "leads.json", "projects.json",
    "quotes.json", "review-requests.json", "warranty-claims.json", "work-orders.json"
  ]) {
    ok(`plan names ${expected}`, filesInPlan.includes(expected), filesInPlan.join(","));
  }
  ok("plan excludes the tombstone log from re-points", !filesInPlan.includes("deleted-invoices.json"));
  ok("plan excludes the email log from re-points", !filesInPlan.includes("email-log.json"));
  ok("plan reports the tombstone log as report-only",
    result.plan.reportOnly.some((r) => r.file === "deleted-invoices.json"));
  ok("plan reports the email log as report-only",
    result.plan.reportOnly.some((r) => r.file === "email-log.json"));

  // 2 invoices + 1 each of lead/wo/quote/booking/project/review + 1 nested claim
  ok("plan counts every reference", result.plan.totalRepointed === 9, String(result.plan.totalRepointed));
  const invPlan = result.plan.repoints.find((r) => r.file === "invoices.json");
  ok("plan names the moving invoices by id",
    invPlan.records.join(" ").includes("I-2026-0093") && invPlan.records.join(" ").includes("I-2026-0101"));
  ok("plan leaves the keeper's own invoice out",
    !invPlan.records.join(" ").includes("I-2026-0071"));
  ok("plan flags the stale duplicate-suggestion on a lead",
    result.plan.leadSuggestionFix && result.plan.leadSuggestionFix.leadIds.includes("lead-c"));
  ok("plan reports the zone conflict",
    result.plan.conflicts.some((c) => c.includes("system.zones")));
  ok("plan does not align draft invoices unasked", result.plan.draftInvoiceAligns.length === 0);

  // The answer to "this customer has two invoices with two addresses".
  const invoicesAfter = result.plan.invoicesAfter;
  ok("plan lists every invoice the keeper ends up with", invoicesAfter.length === 3);
  ok("plan marks which invoices are moving",
    invoicesAfter.filter((i) => i.moving).map((i) => i.id).sort().join(",") === "I-2026-0093,I-2026-0101");
  ok("plan shows the keeper's own invoice as staying",
    invoicesAfter.find((i) => i.id === "I-2026-0071").moving === false);
  ok("plan shows each invoice's issued address",
    invoicesAfter.find((i) => i.id === "I-2026-0093").address === "88 Kingsmere Ave, Newmarket");
}

// ---- 2. Apply: everything re-points, duplicate goes -------------------

{
  const dataDir = makeSandbox();
  const result = mergeProperties({
    dataDir, keep: "P-2026-0040", remove: "P-2026-0056", apply: true, by: "patrick"
  });
  ok("apply succeeds", result.ok === true && result.applied === true, JSON.stringify(result.problems));

  const props = read(dataDir, "properties.json");
  ok("duplicate is gone", !props.some((p) => p.id === DUP_ID));
  ok("keeper survives", props.some((p) => p.id === KEEP_ID));
  ok("no other property was removed", props.length === 1);
  const keeper = props.find((p) => p.id === KEEP_ID);

  // Re-points, including the nested one.
  const invoices = read(dataDir, "invoices.json");
  ok("both of the customer's invoices now hang off one property",
    invoices.filter((i) => i.propertyId === KEEP_ID).length === 3);
  ok("no invoice still points at the duplicate",
    !invoices.some((i) => i.propertyId === DUP_ID));
  ok("nested warranty-claim link re-pointed",
    read(dataDir, "warranty-claims.json")[0].link.propertyId === KEEP_ID);
  for (const [file, id] of [
    ["work-orders.json", "WO-B"], ["quotes.json", "Q-2026-0088"],
    ["bookings.json", "bk-9"], ["projects.json", "PRJ-4"], ["review-requests.json", "rr-3"]
  ]) {
    const rec = read(dataDir, file).find((r) => r.id === id);
    ok(`${file} re-pointed`, rec.propertyId === KEEP_ID, String(rec.propertyId));
  }
  const leads = read(dataDir, "leads.json");
  ok("lead re-pointed", leads.find((l) => l.id === "lead-b").propertyId === KEEP_ID);
  ok("stale suggestion for the deleted property dropped",
    !("propertyLinkSuggestions" in leads.find((l) => l.id === "lead-c")));
  ok("suggestion that did not name the duplicate is left alone",
    Array.isArray(leads.find((l) => l.id === "lead-b").propertyLinkSuggestions));

  // Frozen records.
  ok("tombstone log untouched", read(dataDir, "deleted-invoices.json")[0].propertyId === DUP_ID);
  ok("email log untouched", read(dataDir, "email-log.json")[0].propertyId === DUP_ID);
  ok("issued invoice keeps the address it was issued with",
    invoices.find((i) => i.id === "I-2026-0093").address === "88 Kingsmere Ave, Newmarket");
  ok("issued invoice keeps its billTo snapshot",
    invoices.find((i) => i.id === "I-2026-0093").billTo.address === "88 Kingsmere Ave, Newmarket");
  ok("draft invoice address untouched without the flag",
    invoices.find((i) => i.id === "I-2026-0101").address === "88 Kingsmere Ave, Newmarket");

  // Property content.
  ok("keeper's address wins", keeper.address.startsWith("88 Kingsmere Avenue"));
  ok("blank phone left as it was (keeper had one)", keeper.customerPhone === "905-555-0102");
  ok("blank billingCcEmail filled from the duplicate",
    keeper.billingCcEmail === "randy.bookkeeper@example.invalid");
  ok("blank system field filled from the duplicate",
    keeper.system.controllerBrand === "Hunter HPC-400" && keeper.system.shutoffLocation === "Basement utility room");
  ok("populated system field not overwritten",
    keeper.system.controllerLocation === "Garage, north wall");
  ok("zones NOT concatenated", keeper.system.zones.length === 2);
  ok("null zoneCount filled from the duplicate", keeper.system.zoneCount === 6);
  ok("lead back-refs unioned",
    keeper.leadIds.includes("lead-a") && keeper.leadIds.includes("lead-b") && keeper.leadIds.length === 2);
  ok("work-order back-refs unioned",
    keeper.workOrderIds.includes("WO-A") && keeper.workOrderIds.includes("WO-B"));
  ok("photos unioned", keeper.photos.length === 2);
  ok("deferred issues unioned", keeper.deferredIssues.length === 2);
  ok("service records unioned", keeper.serviceRecords.length === 2);
  ok("null seasonal price filled from the duplicate", keeper.seasonalPricing.fallClosingPrice === 210);
  ok("set seasonal price not overwritten", keeper.seasonalPricing.springOpeningPrice === 185);

  // Consent.
  ok("opt-out on the deleted record wins (eligibility)",
    keeper.seasonalEligibility.fallClosing === false);
  ok("opt-out on the deleted record wins (comm pref)",
    keeper.commPrefs.seasonalRemindersEmail === false);
  ok("a preference the customer never turned off stays on",
    keeper.commPrefs.reviewRequestsEmail === true && keeper.commPrefs.seasonalRemindersSMS === true);
  ok("keeper's live unsubscribe token kept",
    keeper.commPrefs.optOutTokens.seasonalSMS === "tok-keep-sms");
  ok("duplicate's token adopted where the keeper had none",
    keeper.commPrefs.optOutTokens.seasonalEmail === "tok-dupe-email");
  ok("the dropped-token consequence is stated out loud",
    result.notes.some((n) => n.includes("seasonalSMS") && n.includes("no longer work")));
  ok("commPrefs carries only the slots hydrate() rebuilds",
    JSON.stringify(Object.keys(keeper.commPrefs.optOutTokens).sort()) ===
    JSON.stringify(["reviewEmail", "seasonalAll", "seasonalEmail", "seasonalSMS"]));

  // Outreach history.
  const spring = keeper.seasonalOutreach["2026:spring_opening"];
  ok("outreach touches merged for a shared season", spring.touches.length === 2);
  ok("outreach touches sorted by time", spring.touches[0].ts < spring.touches[1].ts);
  ok("season opt-out wins on merge", spring.optOutThisSeason === true);
  ok("season only the duplicate had is carried over",
    Boolean(keeper.seasonalOutreach["2026:fall_closing"]));

  // Provenance.
  ok("history records the merge",
    keeper.history.some((h) => h.action === "property_merged" && h.by === "patrick"));
  ok("history note names the deleted property",
    keeper.history.some((h) => String(h.note || "").includes("P-2026-0056")));
  ok("both properties' histories survive", keeper.history.filter((h) => h.action === "created").length === 2);
  ok("mergedFrom records the deleted id and code",
    keeper.mergedFrom.length === 1 && keeper.mergedFrom[0].id === DUP_ID && keeper.mergedFrom[0].code === "P-2026-0056");

  // Backups.
  ok("backup directory created", fs.existsSync(result.backupDir));
  ok("backup holds the pre-merge properties.json",
    JSON.parse(fs.readFileSync(path.join(result.backupDir, "properties.json"), "utf8"))
      .some((p) => p.id === DUP_ID));
  ok("backup holds the pre-merge invoices.json",
    JSON.parse(fs.readFileSync(path.join(result.backupDir, "invoices.json"), "utf8"))
      .some((i) => i.propertyId === DUP_ID));
  for (const f of ["leads.json", "work-orders.json", "warranty-claims.json"]) {
    ok(`backup holds ${f}`, fs.existsSync(path.join(result.backupDir, f)));
  }
  ok("backup does not copy files the merge never touched",
    !fs.existsSync(path.join(result.backupDir, "deleted-invoices.json")));
}

// ---- 3. Draft invoice alignment is opt-in and draft-only --------------

{
  const dataDir = makeSandbox();
  const result = mergeProperties({
    dataDir, keep: "P-2026-0040", remove: "P-2026-0056",
    apply: true, alignDraftInvoiceAddresses: true
  });
  const invoices = read(dataDir, "invoices.json");
  ok("draft invoice address realigned with the flag",
    invoices.find((i) => i.id === "I-2026-0101").address.startsWith("88 Kingsmere Avenue"));
  ok("sent invoice address still untouched with the flag",
    invoices.find((i) => i.id === "I-2026-0093").address === "88 Kingsmere Ave, Newmarket");
  ok("paid invoice address still untouched with the flag",
    invoices.find((i) => i.id === "I-2026-0071").address === "88 Kingsmere Avenue, Newmarket, ON L3Y 1M8, Canada");
  ok("realignment is reported", result.plan.draftInvoiceAligns.length === 1);
  ok("realigned draft keeps its billTo snapshot",
    invoices.find((i) => i.id === "I-2026-0101").billTo.address === "88 Kingsmere Ave, Newmarket");
}

// ---- 4. Addressing a property by uuid works too ----------------------

{
  const dataDir = makeSandbox();
  const result = mergeProperties({ dataDir, keep: KEEP_ID, remove: DUP_ID, apply: true });
  ok("properties resolvable by raw id", result.ok && result.applied);
  ok("merge by id removed the duplicate",
    !read(dataDir, "properties.json").some((p) => p.id === DUP_ID));
}

// ---- 5. Refusals ------------------------------------------------------

{
  const dataDir = makeSandbox();
  const before = checksumDir(dataDir);

  const unknown = mergeProperties({ dataDir, keep: "P-2026-9999", remove: "P-2026-0056", apply: true });
  ok("refuses an unknown keeper", unknown.ok === false);
  ok("unknown keeper names the reference",
    unknown.problems.join(" ").includes("P-2026-9999"));

  const unknownDup = mergeProperties({ dataDir, keep: "P-2026-0040", remove: "P-2026-9999", apply: true });
  ok("refuses an unknown duplicate", unknownDup.ok === false);

  const self = mergeProperties({ dataDir, keep: "P-2026-0040", remove: "P-2026-0040", apply: true });
  ok("refuses merging a property into itself", self.ok === false);
  ok("self-merge says why", self.problems.join(" ").toLowerCase().includes("same record"));

  ok("no refusal wrote anything", JSON.stringify(checksumDir(dataDir)) === JSON.stringify(before));
}

// ---- 6. Different customers: refused by default, overridable ----------

{
  const dataDir = makeSandbox();
  const props = read(dataDir, "properties.json");
  props.find((p) => p.id === DUP_ID).customerId = "CUST-0412";
  props.find((p) => p.id === DUP_ID).customerEmail = "randy.state@example.invalid";
  fs.writeFileSync(path.join(dataDir, "properties.json"), JSON.stringify(props, null, 2) + "\n", "utf8");
  const before = checksumDir(dataDir);

  const refused = mergeProperties({ dataDir, keep: "P-2026-0040", remove: "P-2026-0056", apply: true });
  ok("refuses two different customers", refused.ok === false);
  ok("refusal points at the customer merge",
    refused.problems.join(" ").includes("CUSTOMER"));
  ok("refusal wrote nothing", JSON.stringify(checksumDir(dataDir)) === JSON.stringify(before));

  const forced = mergeProperties({
    dataDir, keep: "P-2026-0040", remove: "P-2026-0056", apply: true, allowDifferentCustomer: true
  });
  ok("override lets it through", forced.ok === true && forced.applied === true);
  ok("override is recorded in the notes",
    forced.notes.some((n) => n.includes("different customers")));
  ok("keeper's customerId is not changed by the override",
    read(dataDir, "properties.json").find((p) => p.id === KEEP_ID).customerId === CUSTOMER);
}

// ---- 6b. Trashed / archived records ----------------------------------

{
  const dataDir = makeSandbox();
  const props = read(dataDir, "properties.json");
  props.find((p) => p.id === KEEP_ID).deletedAt = "2026-08-20T00:00:00.000Z";
  fs.writeFileSync(path.join(dataDir, "properties.json"), JSON.stringify(props, null, 2) + "\n", "utf8");
  const before = checksumDir(dataDir);

  const refused = mergeProperties({ dataDir, keep: "P-2026-0040", remove: "P-2026-0056", apply: true });
  ok("refuses to merge into a trashed keeper", refused.ok === false);
  ok("trashed-keeper refusal says to restore it first",
    refused.problems.join(" ").toLowerCase().includes("restore it"));
  ok("trashed-keeper refusal wrote nothing",
    JSON.stringify(checksumDir(dataDir)) === JSON.stringify(before));
}

{
  const dataDir = makeSandbox();
  const props = read(dataDir, "properties.json");
  props.find((p) => p.id === DUP_ID).deletedAt = "2026-08-20T00:00:00.000Z";
  fs.writeFileSync(path.join(dataDir, "properties.json"), JSON.stringify(props, null, 2) + "\n", "utf8");

  const result = mergeProperties({ dataDir, keep: "P-2026-0040", remove: "P-2026-0056", apply: true });
  ok("a trashed duplicate still merges", result.ok === true && result.applied === true);
  ok("the trashed duplicate is called out", result.notes.some((n) => n.includes("in the Trash")));
  ok("its invoice still moved",
    read(dataDir, "invoices.json").find((i) => i.id === "I-2026-0093").propertyId === KEEP_ID);
}

// ---- 7. A duplicate nothing links to still merges ---------------------

{
  const dataDir = makeSandbox();
  for (const f of ["invoices.json", "leads.json", "work-orders.json", "quotes.json",
    "bookings.json", "projects.json", "review-requests.json", "warranty-claims.json"]) {
    fs.writeFileSync(path.join(dataDir, f), "[]\n", "utf8");
  }
  const result = mergeProperties({ dataDir, keep: "P-2026-0040", remove: "P-2026-0056", apply: true });
  ok("merges with no linked records", result.ok === true && result.applied === true);
  ok("nothing to re-point is reported as zero", result.plan.totalRepointed === 0);
  ok("duplicate still deleted", !read(dataDir, "properties.json").some((p) => p.id === DUP_ID));
}

// ---- Result -----------------------------------------------------------

if (failures.length) {
  console.error(`\nmerge-properties: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("");
  process.exit(1);
}
console.log(`merge-properties: ${pass} assertions passed`);
