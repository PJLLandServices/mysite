// Customer migration — Brief 1 (dry-run) + Brief 2 (--apply commit).
//
// Walks every customer-bearing entity (leads, properties, bookings,
// work-orders, quotes, invoices, projects), synthesizes the customer
// list, derives status, and backfills `customerId` on every entity.
//
// Two modes:
//
//   DRY-RUN (default)
//     node scripts/migrate-customers.js
//     - No writes to production data.
//     - Generates a JSON report at server/data/migration-reports/.
//     - Patrick reviews the report before committing.
//
//   --apply (Brief 2 commit semantics)
//     node scripts/migrate-customers.js --apply
//     - Refuses if customers.json already has records (idempotency).
//     - Snapshots server/data/ to a timestamped backup folder.
//     - Writes customers.json + the leadId→customerId redirect map.
//     - Adds customerId to every record in leads / properties /
//       bookings / work-orders / quotes / invoices / projects.
//     - All-or-rollback: a write failure leaves the backup intact;
//       restore by replacing server/data/ with the backup folder.
//
// Inputs (all optional — missing/empty files are tolerated):
//   server/data/leads.json
//   server/data/properties.json
//   server/data/bookings.json
//   server/data/work-orders.json
//   server/data/quotes.json
//   server/data/invoices.json
//   server/data/projects.json
//
// Outputs (always):
//   server/data/migration-reports/customers-<timestamp>.json
//
// Additional outputs (--apply only):
//   server/data/customers.json
//   server/data/migration-leadId-map.json
//   server/data-backup-<timestamp>/...   (full snapshot)
//
// Status assignment rule (audit §7 + Patrick's §12 Q5):
//   - Has any completed WO                            → active
//   - Else has only "lost" / "cancelled" leads        → lost
//   - Else has any open lead                          → lead
//   - Else                                            → inactive
//
// Match order (audit §5.4, spec §3.1):
//   email (case-insensitive) → phone (digits-only) → create new

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

// Resolve `customerId` for an arbitrary entity record. Walk the
// reference chain in priority order:
//   1. If the entity already has customerId, keep it.
//   2. Via leadId → leadToCustomer map.
//   3. Via propertyId → propertyToCustomer map.
//   4. Via direct customerEmail / customerPhone match against the
//      synthesized customer set.
// Returns null if no match (entity has no customer linkage at all —
// shouldn't happen in normal data, but the script tolerates it).
function resolveEntityCustomerId(entity, ctx) {
  if (entity?.customerId) return entity.customerId;
  if (entity?.leadId && ctx.leadToCustomer[entity.leadId]) {
    return ctx.leadToCustomer[entity.leadId];
  }
  if (entity?.propertyId && ctx.propertyToCustomer[entity.propertyId]) {
    return ctx.propertyToCustomer[entity.propertyId];
  }
  const matched = matchCustomer(ctx.customers, {
    email: entity?.customerEmail,
    phone: entity?.customerPhone
  });
  return matched ? matched.customer.id : null;
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

  // Load inputs.
  const leadsRes = await readJsonArray("leads.json");
  const propsRes = await readJsonArray("properties.json");
  const bookingsRes = await readJsonArray("bookings.json");
  const wosRes = await readJsonArray("work-orders.json");
  const quotesRes = await readJsonArray("quotes.json");
  const invoicesRes = await readJsonArray("invoices.json");
  const projectsRes = await readJsonArray("projects.json");

  const inputs = [
    ["leads.json", leadsRes],
    ["properties.json", propsRes],
    ["bookings.json", bookingsRes],
    ["work-orders.json", wosRes],
    ["quotes.json", quotesRes],
    ["invoices.json", invoicesRes],
    ["projects.json", projectsRes]
  ];

  // --apply guardrails: refuse if customers.json already has records.
  // The migration is one-shot by design; re-running on top of a
  // populated customers.json would create duplicates. To re-run,
  // delete customers.json + migration-leadId-map.json first (or
  // restore from a backup folder).
  if (APPLY_MODE) {
    const existingCustomers = await readJsonArray("customers.json");
    if (!existingCustomers.missing && existingCustomers.records.length > 0) {
      console.error(" ❌ customers.json already has " + existingCustomers.records.length + " records.");
      console.error("    Refusing to apply on top of an existing customer set.");
      console.error("    To re-run: delete server/data/customers.json and");
      console.error("    server/data/migration-leadId-map.json, then re-run.");
      process.exit(2);
    }
  }

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
  const bookings = bookingsRes.records;
  const workOrders = wosRes.records;
  const quoteRecords = quotesRes.records;
  const invoiceRecords = invoicesRes.records;
  const projectRecords = projectsRes.records;

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

  // ---- Pass 4-8: backfill customerId on every entity --------------
  // For each entity type, compute the customerId that should be
  // written. The entity records remain untouched in memory unless
  // --apply runs (which then writes the modified arrays to disk).

  const ctx = { customers, leadToCustomer, propertyToCustomer };

  const entityResolutions = {
    leads: 0,
    properties: 0,
    bookings: 0,
    workOrders: 0,
    quotes: 0,
    invoices: 0,
    projects: 0,
    unresolved: { leads: 0, properties: 0, bookings: 0, workOrders: 0, quotes: 0, invoices: 0, projects: 0 }
  };

  for (const lead of leads) {
    const cid = leadToCustomer[lead.id] || resolveEntityCustomerId(lead, ctx);
    if (cid) { lead.customerId = cid; entityResolutions.leads++; }
    else entityResolutions.unresolved.leads++;
  }

  for (const property of properties) {
    const cid = propertyToCustomer[property.id] || resolveEntityCustomerId(property, ctx);
    if (cid) { property.customerId = cid; entityResolutions.properties++; }
    else entityResolutions.unresolved.properties++;
  }

  for (const booking of bookings) {
    const cid = resolveEntityCustomerId(booking, ctx);
    if (cid) { booking.customerId = cid; entityResolutions.bookings++; }
    else entityResolutions.unresolved.bookings++;
  }

  for (const wo of workOrders) {
    const cid = resolveEntityCustomerId(wo, ctx);
    if (cid) { wo.customerId = cid; entityResolutions.workOrders++; }
    else entityResolutions.unresolved.workOrders++;
  }

  for (const quote of quoteRecords) {
    const cid = resolveEntityCustomerId(quote, ctx);
    if (cid) { quote.customerId = cid; entityResolutions.quotes++; }
    else entityResolutions.unresolved.quotes++;
  }

  // Invoices: try via woId first, since the WO already has customerId.
  const woById = new Map(workOrders.map((w) => [w.id, w]));
  for (const invoice of invoiceRecords) {
    let cid = invoice.customerId || null;
    if (!cid && invoice.woId && woById.get(invoice.woId)?.customerId) {
      cid = woById.get(invoice.woId).customerId;
    }
    if (!cid) cid = resolveEntityCustomerId(invoice, ctx);
    if (cid) { invoice.customerId = cid; entityResolutions.invoices++; }
    else entityResolutions.unresolved.invoices++;
  }

  // Projects: try via sourceQuoteId first.
  const quoteById = new Map(quoteRecords.map((q) => [q.id, q]));
  for (const project of projectRecords) {
    let cid = project.customerId || null;
    if (!cid && project.sourceQuoteId && quoteById.get(project.sourceQuoteId)?.customerId) {
      cid = quoteById.get(project.sourceQuoteId).customerId;
    }
    if (!cid) cid = resolveEntityCustomerId(project, ctx);
    if (cid) { project.customerId = cid; entityResolutions.projects++; }
    else entityResolutions.unresolved.projects++;
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
  console.log(" Entity customerId backfill:");
  const entityLabels = [
    ["leads", leads.length],
    ["properties", properties.length],
    ["bookings", bookings.length],
    ["workOrders", workOrders.length],
    ["quotes", quoteRecords.length],
    ["invoices", invoiceRecords.length],
    ["projects", projectRecords.length]
  ];
  for (const [key, total] of entityLabels) {
    const resolved = entityResolutions[key];
    const unresolved = entityResolutions.unresolved[key];
    const pad = key.padEnd(12);
    console.log(`   ${pad} ${resolved}/${total} resolved` + (unresolved ? ` (${unresolved} unresolved)` : ""));
  }
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
    mode: APPLY_MODE ? "apply" : "dry-run",
    generatedAt: nowIso(),
    inputs: {
      leads: leads.length,
      properties: properties.length,
      bookings: bookings.length,
      workOrders: workOrders.length,
      quotes: quoteRecords.length,
      invoices: invoiceRecords.length,
      projects: projectRecords.length
    },
    summary: {
      totalCustomers: customers.length,
      byStatus,
      withoutEmail: noEmail,
      withoutPhone: noPhone,
      orphanedProperties: orphanedProperties.length,
      conflicts: conflicts.length,
      entityResolutions
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

  // ---- Apply mode: backup + write all updated files ---------------

  if (!APPLY_MODE) {
    console.log(" Next step: Patrick reviews the report. When approved,");
    console.log(" re-run with --apply to commit.");
    console.log("");
    return;
  }

  console.log(" --apply mode — committing migration to disk.");
  console.log("");

  // 1. Backup.
  const backupDir = path.join(REPO_ROOT, "server", `data-backup-${stamp}`);
  console.log(`   Backing up server/data/ → ${path.relative(REPO_ROOT, backupDir)} ...`);
  await fs.cp(DATA_DIR, backupDir, { recursive: true });
  console.log(`   ✓ Backup complete.`);

  // 2. Prepare the customers payload (strip the migration scratch fields).
  const finalCustomers = cleanedCustomers.map((c) => {
    const { _migration, ...rest } = c;
    return rest;
  });

  // 3. Write every touched file. The order is intentional: customers
  //    first (the foundation), then entities. If any write fails the
  //    backup remains intact for rollback.
  async function writeArray(name, records) {
    const full = path.join(DATA_DIR, name);
    await fs.writeFile(full, JSON.stringify(records, null, 2) + "\n", "utf8");
    console.log(`   ✓ ${name.padEnd(22)} ${records.length} records`);
  }

  await writeArray("customers.json", finalCustomers);
  await writeArray("leads.json", leads);
  await writeArray("properties.json", properties);
  await writeArray("bookings.json", bookings);
  await writeArray("work-orders.json", workOrders);
  await writeArray("quotes.json", quoteRecords);
  await writeArray("invoices.json", invoiceRecords);
  await writeArray("projects.json", projectRecords);

  // 4. Write the leadId → customerId redirect map (server.js reads
  //    this on boot to redirect legacy /portal/<leadId> URLs).
  await fs.writeFile(
    path.join(DATA_DIR, "migration-leadId-map.json"),
    JSON.stringify(leadToCustomer, null, 2) + "\n",
    "utf8"
  );
  console.log(`   ✓ migration-leadId-map.json (${Object.keys(leadToCustomer).length} entries)`);

  console.log("");
  console.log(" ✓ Migration applied. Restart the server to pick up the");
  console.log("   leadId redirect map.");
  console.log("");
  console.log(` Rollback: rm -r server/data && mv ${path.relative(REPO_ROOT, backupDir)} server/data`);
  console.log("");
}

run().catch((err) => {
  console.error("");
  console.error(" ❌ Migration dry-run failed:");
  console.error("    " + (err.stack || err.message || String(err)));
  console.error("");
  process.exit(1);
});
