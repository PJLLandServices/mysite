// Customer migration — Brief 1 (dry-run + report).
//
// Walks the existing leads.json + properties.json + work-orders.json
// and synthesizes the customer list that customers.json *would* hold
// if Brief 2 were applied today. Produces a review report Patrick reads
// before committing. NEVER writes to production data in dry-run mode.
//
// Usage:
//   node scripts/migrate-customers.js              (dry-run, default)
//   node scripts/migrate-customers.js --apply      (Brief 2 — actual commit; refuses for now)
//   node scripts/migrate-customers.js --json       (also emit machine-readable report)
//
// Inputs (all optional — missing/empty files yield empty customer set):
//   server/data/leads.json
//   server/data/properties.json
//   server/data/work-orders.json
//   server/data/quotes.json
//   server/data/invoices.json
//   server/data/bookings.json
//
// Outputs (dry-run):
//   stdout                        — summary report
//   server/data/migration-reports/customers-<timestamp>.json
//                                 — full detail (gitignored under server/data/)
//
// Status assignment rule (audit §7 + Patrick's §12 Q5 answer):
//   - Has any completed WO          → active
//   - Else has any "lost" lead, no won/open lead → lost
//   - Else has any open lead         → lead
//   - Else                           → inactive
//
// Match order (audit §5.4, spec §3.1):
//   email (case-insensitive) → phone (digits-only) → create new
//
// Brief 1 acceptance: this script runs cleanly to completion in
// dry-run mode and produces a report. No customers.json is written.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "server", "data");
const REPORT_DIR = path.join(DATA_DIR, "migration-reports");

const ARGS = new Set(process.argv.slice(2));
const APPLY_MODE = ARGS.has("--apply") || ARGS.has("--commit");
const EMIT_JSON = ARGS.has("--json") || true; // Always emit JSON for now.

// ---- File helpers ----------------------------------------------------

async function readJsonArray(file) {
  const full = path.join(DATA_DIR, file);
  if (!fsSync.existsSync(full)) return { records: [], path: full, missing: true };
  try {
    const raw = await fs.readFile(full, "utf8");
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return { records: [], path: full, malformed: true };
    return { records: parsed, path: full };
  } catch (err) {
    return { records: [], path: full, error: err.message };
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function nowIso() { return new Date().toISOString(); }

// ---- Build the synthetic customer list ------------------------------

function newCustomerSeed(seq) {
  const created = nowIso();
  return {
    id: `CUST-${String(seq).padStart(4, "0")}`,
    name: "",
    spouseName: "",
    phone: "",
    spousePhone: "",
    email: "",
    spouseEmail: "",
    billingAddress: null,
    customerSince: null,
    source: "",
    status: "lead",
    quickbooksId: null,
    internalNotes: "",
    notificationPrefs: {
      textReminders: true,
      emailOnly: false,
      noMarketingTexts: false,
      overrides: {}
    },
    communicationRecords: [],
    history: [{ ts: created, action: "migrated", by: "migration-brief-1", note: "" }],
    createdAt: created,
    updatedAt: created,
    // Migration-only scratch fields, stripped before final write:
    _sourceLeadIds: [],
    _sourcePropertyIds: [],
    _earliestTs: null
  };
}

// Find an in-progress customer that matches by email first, phone
// second. Returns null when nothing matches (caller creates new).
function matchCustomer(customers, { email, phone }) {
  const targetEmail = normalizeEmail(email);
  const targetPhone = normalizePhone(phone);
  if (targetEmail) {
    const byEmail = customers.find(
      (c) => c.email === targetEmail || c.spouseEmail === targetEmail
    );
    if (byEmail) return { customer: byEmail, via: "email" };
  }
  if (targetPhone) {
    const byPhone = customers.find(
      (c) =>
        normalizePhone(c.phone) === targetPhone ||
        normalizePhone(c.spousePhone) === targetPhone
    );
    if (byPhone) return { customer: byPhone, via: "phone" };
  }
  return null;
}

// Merge fact about a lead into an existing customer record. Lighter
// fields win: don't overwrite a populated name with an empty one,
// don't overwrite a known phone with a different one (flag the
// conflict instead).
function applyLeadFacts(customer, lead, conflicts) {
  const contact = lead.contact || {};
  const email = normalizeEmail(contact.email);
  const phone = normalizePhone(contact.phone);
  const name = String(contact.name || "").trim();
  const address = String(contact.address || "").trim();

  if (name && !customer.name) customer.name = name;

  if (email) {
    if (!customer.email) {
      customer.email = email;
    } else if (customer.email !== email) {
      // Phone-matched but email differs. Could be married couple
      // sharing a phone — record the second email as spouseEmail when
      // empty, otherwise flag a conflict.
      if (!customer.spouseEmail) {
        customer.spouseEmail = email;
      } else {
        conflicts.push({
          type: "email_collision",
          customerId: customer.id,
          existing: customer.email,
          spouse: customer.spouseEmail,
          additional: email,
          sourceLeadId: lead.id
        });
      }
    }
  }

  if (phone) {
    const existingDigits = normalizePhone(customer.phone);
    if (!customer.phone) {
      customer.phone = contact.phone;
    } else if (existingDigits !== phone) {
      if (!customer.spousePhone) {
        customer.spousePhone = contact.phone;
      } else if (normalizePhone(customer.spousePhone) !== phone) {
        conflicts.push({
          type: "phone_collision",
          customerId: customer.id,
          existing: customer.phone,
          spouse: customer.spousePhone,
          additional: contact.phone,
          sourceLeadId: lead.id
        });
      }
    }
  }

  if (address && !customer.billingAddress) {
    // Address from a lead is a *service* address, not a billing
    // address — leave billingAddress null unless we see a billing
    // address explicitly. Stored here as a migration hint so Brief 2
    // can decide.
  }

  if (!customer.source && lead.source) customer.source = lead.source;

  const leadTs = lead.createdAt || lead.created || null;
  if (leadTs) {
    if (!customer._earliestTs || leadTs < customer._earliestTs) {
      customer._earliestTs = leadTs;
    }
  }

  customer._sourceLeadIds.push(lead.id);

  // Append a communication record for the original intake.
  customer.communicationRecords.push({
    ts: leadTs || nowIso(),
    source: lead.source || "lead",
    summary: "Initial intake (migrated)",
    notes: contact.notes ? String(contact.notes).slice(0, 4000) : "",
    logId: lead.id
  });
}

// Status derivation per audit §7 + Patrick's §12 Q5 confirmation
// (first completed WO is the active threshold).
function assignStatus(customer, leadsByCustomer, workOrders) {
  const targetEmail = customer.email;
  const targetPhone = normalizePhone(customer.phone);
  const sourceLeadSet = new Set(customer._sourceLeadIds);

  const hasCompletedWO = workOrders.some((wo) => {
    if (wo.status !== "completed") return false;
    if (sourceLeadSet.has(wo.leadId)) return true;
    const wEmail = normalizeEmail(wo.customerEmail);
    const wPhone = normalizePhone(wo.customerPhone);
    if (targetEmail && wEmail && wEmail === targetEmail) return true;
    if (targetPhone && wPhone && wPhone === targetPhone) return true;
    return false;
  });
  if (hasCompletedWO) return "active";

  const myLeads = leadsByCustomer[customer.id] || [];
  if (!myLeads.length) return "inactive";

  const stageOf = (l) => l?.crm?.status || l?.status || "new";
  const isLost = (l) => {
    const s = stageOf(l);
    return s === "lost" || s === "cancelled";
  };
  const isOpen = (l) => !isLost(l);

  if (myLeads.some(isOpen)) return "lead";
  if (myLeads.every(isLost)) return "lost";
  return "inactive";
}

// ---- Main migration walk --------------------------------------------

async function run() {
  const banner = [
    "",
    "============================================================",
    ` PJL — Customer migration ${APPLY_MODE ? "(APPLY)" : "(dry-run)"}`,
    "============================================================",
    ""
  ];
  console.log(banner.join("\n"));

  if (APPLY_MODE) {
    console.error(" ❌ Apply mode is out of scope for Brief 1.");
    console.error("    Brief 2 will wire commit semantics. Refusing to write.");
    process.exit(2);
  }

  // Load inputs.
  const leadsRes = await readJsonArray("leads.json");
  const propsRes = await readJsonArray("properties.json");
  const wosRes = await readJsonArray("work-orders.json");
  const quotesRes = await readJsonArray("quotes.json");
  const invoicesRes = await readJsonArray("invoices.json");

  const inputs = [
    ["leads.json", leadsRes],
    ["properties.json", propsRes],
    ["work-orders.json", wosRes],
    ["quotes.json", quotesRes],
    ["invoices.json", invoicesRes]
  ];

  console.log(" Inputs:");
  for (const [name, res] of inputs) {
    const tag = res.missing
      ? "MISSING"
      : res.malformed
        ? "MALFORMED"
        : res.error
          ? `ERROR — ${res.error}`
          : `${res.records.length} records`;
    console.log(`   ${name.padEnd(22)} ${tag}`);
  }
  console.log("");

  const leads = leadsRes.records;
  const properties = propsRes.records;
  const workOrders = wosRes.records;

  // Pass 1: walk leads, build the customer set.
  const customers = [];
  const conflicts = [];
  const leadToCustomer = {};   // leadId → customerId — for portal redirect map
  let seq = 1;

  for (const lead of leads) {
    if (!lead || typeof lead !== "object") continue;
    const contact = lead.contact || {};
    const matched = matchCustomer(customers, {
      email: contact.email,
      phone: contact.phone
    });
    let customer;
    if (matched) {
      customer = matched.customer;
    } else {
      customer = newCustomerSeed(seq++);
      customers.push(customer);
    }
    applyLeadFacts(customer, lead, conflicts);
    leadToCustomer[lead.id] = customer.id;
  }

  // Pass 2: walk properties, link to customer or create placeholder.
  const orphanedProperties = [];
  const propertyToCustomer = {};   // propertyId → customerId

  for (const property of properties) {
    if (!property || typeof property !== "object") continue;
    const matched = matchCustomer(customers, {
      email: property.customerEmail,
      phone: property.customerPhone
    });
    if (matched) {
      matched.customer._sourcePropertyIds.push(property.id);
      propertyToCustomer[property.id] = matched.customer.id;
      // Backfill name if the property has it and the customer doesn't.
      if (property.customerName && !matched.customer.name) {
        matched.customer.name = property.customerName;
      }
      const propTs = property.createdAt;
      if (propTs && (!matched.customer._earliestTs || propTs < matched.customer._earliestTs)) {
        matched.customer._earliestTs = propTs;
      }
      continue;
    }
    // Orphan: property has customer info but no matching lead.
    const placeholder = newCustomerSeed(seq++);
    placeholder.name = property.customerName || `Unknown — see property ${property.code || property.id}`;
    placeholder.email = normalizeEmail(property.customerEmail);
    placeholder.phone = property.customerPhone || "";
    placeholder.source = "import";
    placeholder.status = "inactive";
    placeholder._sourcePropertyIds.push(property.id);
    placeholder._earliestTs = property.createdAt || nowIso();
    customers.push(placeholder);
    propertyToCustomer[property.id] = placeholder.id;
    orphanedProperties.push({
      propertyId: property.id,
      propertyCode: property.code || null,
      placeholderCustomerId: placeholder.id,
      reason: placeholder.email ? "no_matching_lead_email" : "no_email_on_property"
    });
  }

  // Pass 3: assign customerSince + status.
  const leadsByCustomer = {};
  for (const lead of leads) {
    if (!lead) continue;
    const cid = leadToCustomer[lead.id];
    if (!cid) continue;
    (leadsByCustomer[cid] = leadsByCustomer[cid] || []).push(lead);
  }

  for (const customer of customers) {
    customer.customerSince = customer._earliestTs
      ? customer._earliestTs.slice(0, 10)
      : nowIso().slice(0, 10);
    customer.status = customer._sourcePropertyIds.length && !customer._sourceLeadIds.length
      ? customer.status                     // import-only placeholders stay inactive
      : assignStatus(customer, leadsByCustomer, workOrders);
    if (!customer.source) {
      customer.source = customer._sourceLeadIds.length ? "lead" : "import";
    }
  }

  // ---- Report ------------------------------------------------------

  const byStatus = { lead: 0, active: 0, inactive: 0, lost: 0 };
  for (const c of customers) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  }

  const noEmail = customers.filter((c) => !c.email).length;
  const noPhone = customers.filter((c) => !c.phone).length;

  console.log(" Synthesized customers:");
  console.log(`   Total ............... ${customers.length}`);
  for (const status of ["lead", "active", "inactive", "lost"]) {
    console.log(`     ${status.padEnd(10)} ........ ${byStatus[status] || 0}`);
  }
  console.log("");
  console.log(" Coverage:");
  console.log(`   Customers without email ....... ${noEmail}`);
  console.log(`   Customers without phone ....... ${noPhone}`);
  console.log("");

  if (orphanedProperties.length) {
    console.log(` Orphaned properties (no matching lead): ${orphanedProperties.length}`);
    for (const o of orphanedProperties.slice(0, 10)) {
      console.log(`   ${o.propertyCode || o.propertyId} → ${o.placeholderCustomerId} (${o.reason})`);
    }
    if (orphanedProperties.length > 10) {
      console.log(`   ... ${orphanedProperties.length - 10} more`);
    }
    console.log("");
  }

  if (conflicts.length) {
    console.log(` Conflicts flagged for review: ${conflicts.length}`);
    for (const c of conflicts.slice(0, 10)) {
      console.log(`   ${c.customerId} ${c.type}`);
      if (c.type === "email_collision") {
        console.log(`     existing=${c.existing}  spouse=${c.spouse}  additional=${c.additional}  (lead ${c.sourceLeadId})`);
      } else if (c.type === "phone_collision") {
        console.log(`     existing=${c.existing}  spouse=${c.spouse}  additional=${c.additional}  (lead ${c.sourceLeadId})`);
      }
    }
    if (conflicts.length > 10) {
      console.log(`   ... ${conflicts.length - 10} more`);
    }
    console.log("");
  }

  // ---- Persist the detail report ---------------------------------

  await fs.mkdir(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportFile = path.join(REPORT_DIR, `customers-${stamp}.json`);

  const cleanedCustomers = customers.map((c) => {
    const { _sourceLeadIds, _sourcePropertyIds, _earliestTs, ...rest } = c;
    return {
      ...rest,
      _migration: {
        sourceLeadIds: _sourceLeadIds,
        sourcePropertyIds: _sourcePropertyIds,
        earliestTs: _earliestTs
      }
    };
  });

  const report = {
    mode: "dry-run",
    generatedAt: nowIso(),
    inputs: {
      leads: leads.length,
      properties: properties.length,
      workOrders: workOrders.length,
      quotes: quotesRes.records.length,
      invoices: invoicesRes.records.length
    },
    summary: {
      totalCustomers: customers.length,
      byStatus,
      withoutEmail: noEmail,
      withoutPhone: noPhone,
      orphanedProperties: orphanedProperties.length,
      conflicts: conflicts.length
    },
    customers: cleanedCustomers,
    conflicts,
    orphanedProperties,
    leadToCustomer,
    propertyToCustomer
  };

  await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(` Full report written: ${path.relative(REPO_ROOT, reportFile)}`);
  console.log("");
  console.log(" Next step: Patrick reviews the report. When approved,");
  console.log(" Brief 2 lands and re-runs this script with --apply.");
  console.log("");
}

run().catch((err) => {
  console.error("");
  console.error(" ❌ Migration dry-run failed:");
  console.error("    " + (err.stack || err.message || String(err)));
  console.error("");
  process.exit(1);
});
