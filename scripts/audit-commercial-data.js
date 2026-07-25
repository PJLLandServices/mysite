#!/usr/bin/env node
// scripts/audit-commercial-data.js
//
// Step-0 audit for the commercial data model (Phase 0 brief, Jul 2026).
// READ-ONLY — this script never writes to customers.json or properties.json.
// Run it BEFORE the schema normalization lands so the "few messy" commercial
// records have a before-picture, and again after to confirm they conformed.
//
// Why it exists: some commercial records were hand-written into the JSON
// files to feed lib/billing-parties.js while the persistence schema was
// still incomplete, so they drift in shape. This reports that drift rather
// than silently fixing it — a couple of the findings (a billing entity that
// duplicates the customer name, contacts past the 10-per-record cap) need a
// human decision, not a normalizer.
//
// Usage:
//   node scripts/audit-commercial-data.js               # human-readable report
//   node scripts/audit-commercial-data.js --json        # machine-readable
//   node scripts/audit-commercial-data.js --data-dir X  # audit a copy/fixture
//   npm run audit:commercial

const fs = require("node:fs");
const path = require("node:path");

// --data-dir points the audit at a different pair of JSON files. Used by the
// test suite against fixtures, and handy for auditing a downloaded snapshot
// of production data without putting it in server/data/.
const dataDirArg = process.argv.indexOf("--data-dir");
const DATA_DIR = dataDirArg !== -1 && process.argv[dataDirArg + 1]
  ? path.resolve(process.argv[dataDirArg + 1])
  : path.join(__dirname, "..", "server", "data");
const CUSTOMERS_FILE = path.join(DATA_DIR, "customers.json");
const PROPERTIES_FILE = path.join(DATA_DIR, "properties.json");

const AS_JSON = process.argv.includes("--json");

// Kept in sync with customers.COMMERCIAL_ROLE_SET / properties.SITE_CONTACT_ROLES.
const KNOWN_ROLES = new Set([
  "site_contact", "property_manager", "accounts_payable", "owner_board", "other"
]);
// The canonical contact shape. Anything else on a contact is drift left over
// from a hand-edit or from an older lead.commercial passthrough.
const KNOWN_CONTACT_KEYS = new Set([
  "id", "name", "role", "email", "phone", "isSiteContact", "isAuthorizedSignatory"
]);
const KNOWN_COMMERCIAL_KEYS = new Set([
  "careOf", "poRequired", "paymentTerms", "contacts"
]);
const CONTACT_CAP = 10;
const CONTACT_ID_RE = /^con_[a-z0-9]{8}$/i;

function readJsonArray(file) {
  if (!fs.existsSync(file)) return { ok: false, reason: "missing", records: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8") || "[]");
    if (!Array.isArray(parsed)) return { ok: false, reason: "not-an-array", records: [] };
    return { ok: true, reason: null, records: parsed };
  } catch (err) {
    return { ok: false, reason: `unparseable: ${err.message}`, records: [] };
  }
}

// ---- Contact-level drift (shared by both entities) --------------------

function auditContact(contact, where) {
  const issues = [];
  if (!contact || typeof contact !== "object" || Array.isArray(contact)) {
    return [{ severity: "error", code: "contact_not_an_object", where,
      detail: `expected an object, got ${Array.isArray(contact) ? "array" : typeof contact}` }];
  }
  if (!contact.id) {
    issues.push({ severity: "info", code: "contact_missing_id", where,
      detail: "no con_ id — one is stamped on the next read (backfill)" });
  } else if (!CONTACT_ID_RE.test(String(contact.id))) {
    issues.push({ severity: "warn", code: "contact_bad_id", where,
      detail: `id ${JSON.stringify(contact.id)} is not con_xxxxxxxx — it will be re-minted` });
  }
  if (!String(contact.name || "").trim()) {
    issues.push({ severity: "warn", code: "contact_missing_name", where,
      detail: "contact has no name" });
  }
  const role = String(contact.role || "").trim();
  if (role && !KNOWN_ROLES.has(role)) {
    issues.push({ severity: "warn", code: "contact_unknown_role", where,
      detail: `role ${JSON.stringify(role)} is not in the enum — it coerces to "other"` });
  }
  // Phase 1 keys the portal magic-link off the contact's email. A signatory
  // or site contact without one can't be given a login later.
  const email = String(contact.email || "").trim();
  if (!email && (contact.isAuthorizedSignatory || contact.isSiteContact)) {
    issues.push({ severity: "warn", code: "role_contact_missing_email", where,
      detail: "flagged as signatory/site contact but has no email (blocks a Phase-1 login)" });
  }
  for (const key of Object.keys(contact)) {
    if (!KNOWN_CONTACT_KEYS.has(key)) {
      issues.push({ severity: "info", code: "contact_unknown_key", where,
        detail: `unrecognized key ${JSON.stringify(key)} — dropped on the next write` });
    }
  }
  for (const flag of ["isSiteContact", "isAuthorizedSignatory"]) {
    if (contact[flag] !== undefined && typeof contact[flag] !== "boolean") {
      issues.push({ severity: "warn", code: "contact_flag_not_boolean", where,
        detail: `${flag} is ${JSON.stringify(contact[flag])}, not a boolean` });
    }
  }
  return issues;
}

// ---- Customers --------------------------------------------------------

function auditCustomers(records) {
  const rows = [];
  for (const c of records) {
    if (!c || typeof c !== "object") continue;
    const label = `${c.id || "(no id)"} ${c.name || "(unnamed)"}`;
    const issues = [];
    const isCommercialType = c.accountType === "commercial";
    const block = c.commercial;
    const hasBlock = block != null;

    if (c.accountType !== undefined && c.accountType !== "commercial" && c.accountType !== "residential") {
      issues.push({ severity: "warn", code: "bad_account_type",
        detail: `accountType ${JSON.stringify(c.accountType)} is neither "commercial" nor "residential"` });
    }
    // The two halves of "is this a commercial account" disagreeing is the
    // single most useful thing this audit surfaces: it's what makes the
    // portal render a commercial account as residential (or vice versa).
    if (isCommercialType && !hasBlock) {
      issues.push({ severity: "warn", code: "commercial_type_no_block",
        detail: 'accountType is "commercial" but there is no commercial block' });
    }
    if (!isCommercialType && hasBlock) {
      issues.push({ severity: "warn", code: "block_without_commercial_type",
        detail: `has a commercial block but accountType is ${JSON.stringify(c.accountType ?? "(absent)")}` });
    }

    let contactCount = 0;
    let signatoryCount = 0;
    if (hasBlock) {
      if (typeof block !== "object" || Array.isArray(block)) {
        issues.push({ severity: "error", code: "commercial_not_an_object",
          detail: `commercial is ${Array.isArray(block) ? "an array" : typeof block} — it normalizes to null on the next write` });
      } else {
        for (const key of Object.keys(block)) {
          if (!KNOWN_COMMERCIAL_KEYS.has(key)) {
            issues.push({ severity: "info", code: "commercial_unknown_key",
              detail: `unrecognized key commercial.${key} — dropped on the next write` });
          }
        }
        if (block.contacts !== undefined && !Array.isArray(block.contacts)) {
          issues.push({ severity: "error", code: "contacts_not_an_array",
            detail: `commercial.contacts is ${typeof block.contacts}, not an array — it reads as []` });
        }
        const contacts = Array.isArray(block.contacts) ? block.contacts : [];
        contactCount = contacts.length;
        if (contacts.length > CONTACT_CAP) {
          // Deliberately loud: the normalizer truncates, so this is data
          // loss on the next write unless a human moves the extras first.
          issues.push({ severity: "error", code: "contacts_over_cap",
            detail: `${contacts.length} contacts exceeds the ${CONTACT_CAP}-contact cap — the extras are DROPPED on the next write` });
        }
        contacts.forEach((contact, i) => {
          issues.push(...auditContact(contact, `commercial.contacts[${i}]`));
          if (contact && contact.isAuthorizedSignatory) signatoryCount++;
        });
        // Signatories are the org-wide authority; a commercial account with
        // none has no default quote acceptor (customers.resolveAcceptor
        // returns null and the quote falls back to manual entry).
        if (isCommercialType && contacts.length && signatoryCount === 0) {
          issues.push({ severity: "info", code: "no_signatory",
            detail: "no contact flagged isAuthorizedSignatory — quotes have no default acceptor" });
        }
        if (signatoryCount > 1) {
          issues.push({ severity: "info", code: "ambiguous_signatory",
            detail: `${signatoryCount} signatories — resolveAcceptor returns ambiguous:true and asks Patrick to pick` });
        }
      }
    }
    if (issues.length || hasBlock || isCommercialType) {
      rows.push({ id: c.id || null, label, accountType: c.accountType ?? null,
        hasBlock, contactCount, signatoryCount, issues });
    }
  }
  return rows;
}

// ---- Properties -------------------------------------------------------

function auditProperties(records, customersById, customerNames) {
  const rows = [];
  for (const p of records) {
    if (!p || typeof p !== "object") continue;
    const entity = typeof p.billingEntity === "string" ? p.billingEntity.trim() : "";
    const hasEntity = Boolean(entity);
    const rawContacts = p.siteContacts;
    const hasContacts = Array.isArray(rawContacts) && rawContacts.length > 0;
    if (!hasEntity && !hasContacts && p.billingEntity === undefined && rawContacts === undefined) continue;

    const label = `${p.code || p.id || "(no id)"} ${p.address || "(no address)"}`;
    const issues = [];

    if (p.billingEntity !== undefined && typeof p.billingEntity !== "string") {
      issues.push({ severity: "error", code: "billing_entity_not_a_string",
        detail: `billingEntity is ${typeof p.billingEntity} — it coerces to a string on the next read` });
    }
    if (typeof p.billingEntity === "string" && p.billingEntity !== entity) {
      issues.push({ severity: "info", code: "billing_entity_untrimmed",
        detail: "billingEntity has leading/trailing whitespace — trimmed on the next read" });
    }
    if (entity.length > 200) {
      issues.push({ severity: "warn", code: "billing_entity_too_long",
        detail: `billingEntity is ${entity.length} chars — truncated to 200 on the next read` });
    }

    const owner = p.customerId ? customersById.get(p.customerId) : null;
    if (hasEntity && !p.customerId) {
      issues.push({ severity: "warn", code: "entity_without_customer",
        detail: "has a billingEntity but no customerId — resolveBillTo can't produce a c/o line, so it self-bills" });
    }
    if (hasEntity && owner && entity === String(owner.name || "").trim()) {
      // Not a bug in the resolver (it correctly returns managed:false), but
      // the record is redundant: blank the entity and let the customer be
      // the payer, per the brief's self-billed guidance.
      issues.push({ severity: "warn", code: "entity_duplicates_customer_name",
        detail: `billingEntity equals the customer's own name (${owner.name}) — this self-bills; blank the entity instead` });
    }
    if (hasEntity && owner && owner.accountType !== "commercial") {
      issues.push({ severity: "warn", code: "entity_on_residential_customer",
        detail: `billingEntity is set but customer ${owner.id} has accountType ${JSON.stringify(owner.accountType ?? "(absent)")}` });
    }
    if (hasEntity && !owner && p.customerId) {
      issues.push({ severity: "error", code: "dangling_customer_id",
        detail: `customerId ${p.customerId} does not resolve to a customer record` });
    }
    // A near-match against a known customer name usually means someone typed
    // the management company into the entity slot instead of the site's own
    // legal payer — which prints "X c/o X" nowhere but bills the wrong party.
    if (hasEntity && customerNames.has(entity.toLowerCase()) &&
        (!owner || entity !== String(owner.name || "").trim())) {
      issues.push({ severity: "warn", code: "entity_matches_other_customer",
        detail: `billingEntity matches a DIFFERENT customer's name — confirm this is the site's legal payer, not the manager` });
    }

    if (rawContacts !== undefined && !Array.isArray(rawContacts)) {
      issues.push({ severity: "error", code: "site_contacts_not_an_array",
        detail: `siteContacts is ${typeof rawContacts}, not an array — it reads as []` });
    }
    const contacts = Array.isArray(rawContacts) ? rawContacts : [];
    if (contacts.length > CONTACT_CAP) {
      issues.push({ severity: "error", code: "site_contacts_over_cap",
        detail: `${contacts.length} site contacts exceeds the ${CONTACT_CAP}-contact cap — the extras are DROPPED on the next write` });
    }
    contacts.forEach((contact, i) => {
      issues.push(...auditContact(contact, `siteContacts[${i}]`));
    });
    if (hasEntity && !contacts.length) {
      issues.push({ severity: "info", code: "managed_site_no_contacts",
        detail: "billed as its own entity but has no site contacts — nobody to call to get on site" });
    }

    rows.push({
      id: p.id || null, code: p.code || null, label,
      customerId: p.customerId || null,
      billingEntity: entity, contactCount: contacts.length, issues
    });
  }
  return rows;
}

// ---- Report -----------------------------------------------------------

function severityRank(s) {
  return s === "error" ? 0 : s === "warn" ? 1 : 2;
}

function printRows(title, rows) {
  const withIssues = rows.filter((r) => r.issues.length);
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
  if (!rows.length) {
    console.log("  (none found)");
    return;
  }
  console.log(`  ${rows.length} record(s) inspected, ${withIssues.length} with findings.`);
  for (const row of rows) {
    const summary = row.billingEntity !== undefined
      ? `entity=${row.billingEntity ? JSON.stringify(row.billingEntity) : "(none)"} contacts=${row.contactCount}`
      : `accountType=${row.accountType ?? "(absent)"} block=${row.hasBlock ? "yes" : "no"} contacts=${row.contactCount} signatories=${row.signatoryCount}`;
    const marker = row.issues.some((i) => i.severity === "error") ? "✗"
      : row.issues.some((i) => i.severity === "warn") ? "!" : " ";
    console.log(`\n  ${marker} ${row.label}`);
    console.log(`      ${summary}`);
    const sorted = [...row.issues].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    for (const issue of sorted) {
      const tag = issue.severity.toUpperCase().padEnd(5);
      const where = issue.where ? `${issue.where}: ` : "";
      console.log(`      [${tag}] ${where}${issue.detail}`);
    }
  }
}

function main() {
  const custFile = readJsonArray(CUSTOMERS_FILE);
  const propFile = readJsonArray(PROPERTIES_FILE);

  const customersById = new Map();
  const customerNames = new Set();
  for (const c of custFile.records) {
    if (!c || typeof c !== "object") continue;
    if (c.id) customersById.set(c.id, c);
    const n = String(c.name || "").trim();
    if (n) customerNames.add(n.toLowerCase());
  }

  const customerRows = auditCustomers(custFile.records);
  const propertyRows = auditProperties(propFile.records, customersById, customerNames);

  const allIssues = [...customerRows, ...propertyRows].flatMap((r) => r.issues);
  const counts = {
    error: allIssues.filter((i) => i.severity === "error").length,
    warn: allIssues.filter((i) => i.severity === "warn").length,
    info: allIssues.filter((i) => i.severity === "info").length
  };

  if (AS_JSON) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      files: {
        customers: { path: CUSTOMERS_FILE, ok: custFile.ok, reason: custFile.reason, count: custFile.records.length },
        properties: { path: PROPERTIES_FILE, ok: propFile.ok, reason: propFile.reason, count: propFile.records.length }
      },
      counts, customers: customerRows, properties: propertyRows
    }, null, 2));
    return;
  }

  console.log("Commercial data audit (read-only) — Phase 0 step 0");
  console.log("=================================================");
  for (const [name, file] of [["customers.json", custFile], ["properties.json", propFile]]) {
    console.log(file.ok
      ? `  ${name}: ${file.records.length} record(s)`
      : `  ${name}: NOT READ (${file.reason})`);
  }

  printRows("Customers with a commercial block or accountType", customerRows);
  printRows("Properties with a billingEntity or siteContacts", propertyRows);

  console.log("\nSummary");
  console.log("-------");
  console.log(`  errors: ${counts.error}   warnings: ${counts.warn}   info: ${counts.info}`);
  if (counts.error) {
    console.log("\n  Errors are shapes the normalizer cannot preserve — fix these by hand");
    console.log("  in the JSON before the next write, or the data is lost.");
  }
  if (!counts.error && !counts.warn) {
    console.log("\n  No drift needing a human decision. Info items conform automatically.");
  }
  console.log("\nThis script made no changes.");
}

main();
