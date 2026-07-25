#!/usr/bin/env node
// scripts/test-commercial-schema.mjs
//
// Integration tests for the commercial data model (Phase 0 brief, Jul 2026) —
// the schema that lib/billing-parties.js reads. Covers the brief's §4
// testing list and §5 acceptance checklist:
//
//   1. resolveBillTo — managed site / self-billed commercial / residential
//      (residential must stay byte-identical: it is the pre-existing branch)
//   2. resolveContactRoles — a customer-level signatory surfaces across every
//      site; a property-level site contact surfaces only on its own property
//   3. API round-trip — create a commercial customer, PATCH its contacts, and
//      re-read them. This is the regression guard for the silent-drop bug
//      class: a field missing from update()'s allow-list vanishes with no error
//   4. property.billingEntity + siteContacts survive a PARTIAL update() patch
//   5. con_ contact ids are stable across saves and backfilled onto legacy rows
//   6. Residential records are untouched — no commercial block, no new keys
//
// Isolation: the entity libs resolve their JSON store as
// `<lib dir>/../data/<file>.json`, so the whole suite runs against COPIES of
// the three libs in a temp directory. It can never read or write real
// customer data, which matters because these tests create and mutate records.
//
// Run: node scripts/test-commercial-schema.mjs   (also in `npm run build:check`)
//      node scripts/test-commercial-schema.mjs --verbose

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes("--verbose");

// ---- Sandbox ----------------------------------------------------------
// billing-parties.js requires nothing; customers.js and properties.js
// lazily require each other by relative path. Copying the three together
// gives a self-contained store rooted at <sandbox>/data.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-commercial-test-"));
const SANDBOX_LIB = path.join(SANDBOX, "lib");
fs.mkdirSync(SANDBOX_LIB, { recursive: true });
fs.mkdirSync(path.join(SANDBOX, "data"), { recursive: true });
// invoices.js is here for the billTo.ccEmail snapshot test; like the other
// three it requires only node builtins plus lazy relative siblings.
for (const file of ["customers.js", "properties.js", "billing-parties.js", "invoices.js"]) {
  fs.copyFileSync(path.join(__dirname, "..", "server", "lib", file), path.join(SANDBOX_LIB, file));
}

const require = createRequire(import.meta.url);
const customers = require(path.join(SANDBOX_LIB, "customers.js"));
const properties = require(path.join(SANDBOX_LIB, "properties.js"));
const billingParties = require(path.join(SANDBOX_LIB, "billing-parties.js"));
const invoices = require(path.join(SANDBOX_LIB, "invoices.js"));

const CUSTOMERS_JSON = path.join(SANDBOX, "data", "customers.json");
const PROPERTIES_JSON = path.join(SANDBOX, "data", "properties.json");
const INVOICES_JSON = path.join(SANDBOX, "data", "invoices.json");

function resetStore() {
  fs.writeFileSync(CUSTOMERS_JSON, "[]\n", "utf8");
  fs.writeFileSync(PROPERTIES_JSON, "[]\n", "utf8");
  fs.writeFileSync(INVOICES_JSON, "[]\n", "utf8");
}

// Assert that `fn` throws, and that the error carries `code`.
async function throwsWithCode(fn, code, label) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  if (!err) { ok(false, `${label} (expected a throw, got none)`); return null; }
  ok(err.code === code, `${label} (got code ${JSON.stringify(err.code)}, want ${JSON.stringify(code)})`);
  return err;
}

function manyContacts(n, prefix) {
  return Array.from({ length: n }, (_, i) => ({
    name: `${prefix} ${i + 1}`, role: "site_contact", email: `${prefix.toLowerCase()}${i + 1}@example.com`
  }));
}

// ---- Assertions -------------------------------------------------------

let passed = 0;
const failures = [];
let section = "";

function group(title) {
  section = title;
  if (VERBOSE) console.log(`\n${title}`);
}
function ok(cond, label) {
  if (cond) {
    passed++;
    if (VERBOSE) console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${section} — ${label}`);
    console.error(`  ✗ FAIL: ${section} — ${label}`);
  }
}
function eq(actual, expected, label) {
  ok(Object.is(actual, expected), `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${label}\n      got  ${a}\n      want ${b}`);
}

// ---- Fixtures ---------------------------------------------------------

const MANAGER = {
  name: "RMSCO Management Services Ltd.",
  email: "ap@rmsco.example",
  billingAddress: "1 Manager Way, Newmarket ON",
  accountType: "commercial",
  commercial: {
    careOf: "",
    poRequired: true,
    paymentTerms: "net_30",
    contacts: [
      { name: "Gurdip", role: "property_manager", email: "gurdip@rmsco.example",
        phone: "(905) 555-0100", isAuthorizedSignatory: true }
    ]
  }
};
const ENTITY_1233 = "YRSCC No. 1233 — Lewis Honey Condominiums";
const ENTITY_0987 = "YRSCC No. 987 — Maple Court";

// =======================================================================
// 1. resolveBillTo — the three branches
// =======================================================================
group("resolveBillTo — managed site (per-site legal payer, billed c/o the manager)");
{
  const envelope = billingParties.resolveBillTo(
    { billingEntity: ENTITY_1233 },
    { name: MANAGER.name, billingAddress: MANAGER.billingAddress, email: MANAGER.email }
  );
  eq(envelope.name, ENTITY_1233, "name is the site's own legal entity");
  eq(envelope.careOf, MANAGER.name, "careOf is the managing company");
  eq(envelope.address, MANAGER.billingAddress, "address is where the manager receives mail");
  eq(envelope.managed, true, "flagged managed");
}

group("resolveBillTo — self-billed commercial (entity === the customer itself)");
{
  const envelope = billingParties.resolveBillTo(
    { billingEntity: MANAGER.name },
    { name: MANAGER.name, billingAddress: MANAGER.billingAddress, email: MANAGER.email }
  );
  eq(envelope.name, MANAGER.name, "billed in its own name");
  eq(envelope.careOf, "", 'no "c/o itself" line');
  eq(envelope.managed, false, "not flagged managed");
}

group("resolveBillTo — residential (must stay byte-identical to pre-Phase-0)");
{
  // No billingEntity, no commercial block — the fallback branch, which is the
  // behaviour that existed before any of this landed. Asserted as a whole
  // object so an added or renamed key fails the test.
  //
  // `ccEmail: ""` is the ONE key added since (addendum, Jul 2026) and it is
  // always "" unless someone deliberately sets a billing CC. Every
  // pre-existing key — name, careOf, address, email, managed — is unchanged,
  // so residential invoices still address and send exactly as before.
  deepEq(
    billingParties.resolveBillTo(
      { billingEntity: "" },
      { name: "Jane Homeowner", billingAddress: null, email: "jane@example.com" },
      { fallbackAddress: "12 Residential Rd" }
    ),
    { name: "Jane Homeowner", careOf: "", address: "12 Residential Rd",
      email: "jane@example.com", ccEmail: "", managed: false },
    "plain residential envelope"
  );
  deepEq(
    billingParties.resolveBillTo(
      {},
      { name: "Jane Homeowner", billingName: "LCIG Investment Inc.",
        billingEmail: "AP@LCIG.example", billingAddress: "88 Bay St, Toronto ON" }
    ),
    { name: "LCIG Investment Inc.", careOf: "", address: "88 Bay St, Toronto ON",
      email: "ap@lcig.example", ccEmail: "", managed: false },
    "residential with an alternate payer (billingName wins, email lower-cased)"
  );
  // A property that has never been near the commercial schema.
  deepEq(
    billingParties.resolveBillTo(null, { name: "Jane Homeowner" }),
    { name: "Jane Homeowner", careOf: "", address: "", email: "", ccEmail: "", managed: false },
    "null property tolerated"
  );
}

// =======================================================================
// 1b. resolveBillTo — ccEmail (addendum, Jul 2026)
// =======================================================================
group("resolveBillTo — ccEmail precedence: per-site beats account-level");
{
  const cust = { name: MANAGER.name, email: MANAGER.email, billingCcEmail: "bookkeeper@rmsco.example" };

  eq(billingParties.resolveBillTo({ billingEntity: ENTITY_1233 }, cust).ccEmail,
    "bookkeeper@rmsco.example", "account-level CC applies when the site sets none");

  eq(billingParties.resolveBillTo(
    { billingEntity: ENTITY_1233, billingCcEmail: "ap@yrscc1233.example" }, cust).ccEmail,
    "ap@yrscc1233.example", "per-site CC overrides the account-level one");

  eq(billingParties.resolveBillTo({ billingCcEmail: "  AP@Site.Example  " }, { name: "X" }).ccEmail,
    "ap@site.example", "ccEmail is trimmed and lower-cased");

  eq(billingParties.resolveBillTo({}, { name: "X", email: "x@example.com" }).ccEmail,
    "", "no CC configured anywhere → empty string");

  // Self-billed and residential are not special-cased: the CC is orthogonal
  // to the managed/self-billed split.
  const selfBilled = billingParties.resolveBillTo(
    { billingEntity: MANAGER.name, billingCcEmail: "ap@site.example" }, cust);
  eq(selfBilled.managed, false, "still self-billed");
  eq(selfBilled.ccEmail, "ap@site.example", "CC resolves on the self-billed branch too");

  // The CC must never be folded into the primary recipient.
  const both = billingParties.resolveBillTo(
    { billingEntity: ENTITY_1233, billingCcEmail: "ap@site.example" },
    { name: MANAGER.name, billingEmail: "primary@rmsco.example" });
  eq(both.email, "primary@rmsco.example", "primary email untouched by the CC");
  eq(both.ccEmail, "ap@site.example", "CC kept distinct from the primary");
}

// =======================================================================
// 2. resolveContactRoles — signatory scope vs site scope
// =======================================================================
group("resolveContactRoles — Gurdip org-wide, Faramarz site-only");
{
  const customer = {
    name: MANAGER.name,
    commercial: { contacts: [
      { id: "con_aaaaaaaa", name: "Gurdip", email: "gurdip@rmsco.example", isAuthorizedSignatory: true }
    ] }
  };
  const faramarzSite = { billingEntity: ENTITY_1233, siteContacts: [
    { id: "con_bbbbbbbb", name: "Faramarz", email: "faramarz@example.com", isSiteContact: true }
  ] };
  const otherSite = { billingEntity: ENTITY_0987, siteContacts: [] };

  const atFaramarz = billingParties.resolveContactRoles(faramarzSite, customer);
  const atOther = billingParties.resolveContactRoles(otherSite, customer);

  deepEq(atFaramarz.signatories.map((c) => c.name), ["Gurdip"], "Gurdip signs at his site");
  deepEq(atOther.signatories.map((c) => c.name), ["Gurdip"], "Gurdip signs at every other site too");
  eq(atFaramarz.signatories?.[0]?.from, "customer", "signatory tagged as coming from the customer");

  deepEq(atFaramarz.siteContacts.map((c) => c.name), ["Faramarz"], "Faramarz is the contact at his site");
  deepEq(atOther.siteContacts.map((c) => c.name), [], "Faramarz does NOT appear at the other site");
  eq(atFaramarz.siteContacts?.[0]?.from, "property", "site contact tagged as coming from the property");
  eq(atFaramarz.siteContacts?.[0]?.id, "con_bbbbbbbb", "contact id survives into the resolved role list");
}

// =======================================================================
// 3. API round-trip — the silent-drop regression guard
// =======================================================================
group("customer round-trip — create commercial, PATCH contacts, re-read");
let managerId = null;
{
  resetStore();
  const created = await customers.create(MANAGER, { by: "test" });
  managerId = created.id;

  eq(created.accountType, "commercial", "accountType persisted on create");
  ok(created.commercial != null, "commercial block persisted on create");
  eq(created.commercial?.contacts?.length, 1, "one contact on create");
  eq(created.commercial?.contacts?.[0]?.name, "Gurdip", "contact name persisted");
  eq(created.commercial?.contacts?.[0]?.isAuthorizedSignatory, true, "signatory flag persisted");
  eq(created.commercial?.poRequired, true, "poRequired persisted");

  // Re-read from disk — proves it was written, not just returned.
  const fetched = await customers.get(managerId, { withProperties: false });
  eq(fetched.commercial?.contacts?.length, 1, "contact survives a re-read");

  // The bug class this guards: a PATCH whose key isn't in update()'s allow-list
  // is dropped with NO error, so the UI shows success and the data is gone.
  const gurdip = fetched.commercial.contacts[0];
  const patched = await customers.update(managerId, {
    commercial: {
      ...fetched.commercial,
      careOf: "Attn: Accounts Payable",
      contacts: [
        { ...gurdip, phone: "(905) 555-0199" },
        { name: "Sandeep", role: "accounts_payable", email: "ap2@rmsco.example" }
      ]
    }
  }, { by: "test" });

  eq(patched.commercial?.contacts?.length, 2, "PATCH added a second contact — no silent drop");
  eq(patched.commercial?.careOf, "Attn: Accounts Payable", "careOf updated by PATCH");
  eq(patched.commercial?.contacts?.[0]?.phone, "(905) 555-0199", "existing contact edited by PATCH");

  const reread = await customers.get(managerId, { withProperties: false });
  eq(reread.commercial?.contacts?.length, 2, "both contacts survive a re-read");
  eq(reread.commercial?.contacts?.[1]?.name, "Sandeep", "the new contact is on disk");
  eq(reread.commercial?.contacts?.[1]?.role, "accounts_payable", "role persisted through the enum");

  // accountType is allow-listed too.
  const flipped = await customers.update(managerId, { accountType: "residential" }, { by: "test" });
  eq(flipped.accountType, "residential", "accountType is patchable");
  await customers.update(managerId, { accountType: "commercial" }, { by: "test" });
}

group("customer contact ids — minted, stable across saves, new rows get new ids");
{
  const before = await customers.get(managerId, { withProperties: false });
  // Default to {} so a dropped contact reports as a clean assertion failure
  // rather than a TypeError that hides the rest of the suite.
  const [gurdip = {}, sandeep = {}] = before.commercial?.contacts || [];
  ok(billingParties.isContactId(gurdip.id), `Gurdip has a con_ id (${gurdip.id})`);
  ok(billingParties.isContactId(sandeep.id), `Sandeep has a con_ id (${sandeep.id})`);
  ok(gurdip.id !== sandeep.id, "the two contacts have distinct ids");

  // The editor round-trips data-cid, so an edit that sends the id back must
  // keep it — otherwise a Phase-1 login would follow a dangling reference.
  const after = await customers.update(managerId, {
    commercial: { ...before.commercial, contacts: [
      { ...gurdip, name: "Gurdip Singh" },
      sandeep
    ] }
  }, { by: "test" });
  eq(after.commercial?.contacts?.[0]?.id, gurdip.id, "id survives renaming the contact");
  eq(after.commercial?.contacts?.[1]?.id, sandeep.id, "untouched contact keeps its id");

  // A row submitted without an id is, by definition, a new contact.
  const withNew = await customers.update(managerId, {
    commercial: { ...before.commercial, contacts: [
      { ...gurdip, name: "Gurdip Singh" },
      sandeep,
      { name: "Brand New", email: "new@rmsco.example" }
    ] }
  }, { by: "test" });
  const newContact = withNew.commercial?.contacts?.[2] || {};
  ok(billingParties.isContactId(newContact.id), "a contact added without an id gets one minted");
  ok(![gurdip.id, sandeep.id].includes(newContact.id), "the minted id doesn't collide");

  // Restore the two-contact shape for later assertions.
  await customers.update(managerId, {
    commercial: { ...before.commercial, contacts: [gurdip, sandeep] }
  }, { by: "test" });
}

group("customer hydrate — a hand-edited record is normalized on READ");
{
  // Simulates the "few messy" records: written straight into the JSON to feed
  // the resolver while the schema was incomplete. None of this is a shape the
  // API could produce.
  resetStore();
  fs.writeFileSync(CUSTOMERS_JSON, JSON.stringify([{
    id: "9001", name: "Hand Edited Condo Corp", email: "hand@example.com",
    accountType: "commercial",
    commercial: {
      careOf: "   Spaces Around   ",
      submitterRole: "pm",
      contacts: [
        { name: "Messy", role: "boss", email: "MESSY@Example.COM",
          isSiteContact: "true", isAuthorizedSignatory: "true", stray: "drop me" }
      ]
    }
  }], null, 2), "utf8");

  const loaded = await customers.get("9001", { withProperties: false });
  const contact = loaded.commercial.contacts[0];
  eq(loaded.commercial?.careOf, "Spaces Around", "careOf trimmed on read");
  eq(loaded.commercial?.submitterRole, undefined, "unknown block key dropped");
  eq(contact.role, "other", "unknown role coerced into the enum");
  eq(contact.email, "messy@example.com", "email lower-cased");
  eq(contact.isSiteContact, true, 'string "true" coerced to a boolean');
  eq(contact.isAuthorizedSignatory, true, 'string "true" coerced on the signatory flag too');
  eq(contact.stray, undefined, "unknown contact key dropped");
  ok(billingParties.isContactId(contact.id), "id minted for the hand-written contact");

  // The backfill must PERSIST the minted id, or it would be re-rolled on
  // every read and nothing could reference the contact.
  const onDisk = JSON.parse(fs.readFileSync(CUSTOMERS_JSON, "utf8"));
  eq(onDisk[0].commercial?.contacts?.[0]?.id, contact.id, "minted id was written back to disk");
  const second = await customers.get("9001", { withProperties: false });
  eq(second.commercial?.contacts?.[0]?.id, contact.id, "id is identical on a second read");
}

group("customer hydrate — malformed blocks degrade safely, residential untouched");
{
  resetStore();
  fs.writeFileSync(CUSTOMERS_JSON, JSON.stringify([
    { id: "9002", name: "Contacts Not An Array", commercial: { contacts: "nope" } },
    { id: "9003", name: "Commercial Is A String", commercial: "totally wrong" },
    { id: "9004", name: "Jane Homeowner", email: "jane@example.com", accountType: "residential" }
  ], null, 2), "utf8");

  const bad1 = await customers.get("9002", { withProperties: false });
  eq(bad1.commercial, null, "contacts-as-a-string normalizes the whole block to null");
  const bad2 = await customers.get("9003", { withProperties: false });
  eq(bad2.commercial, null, "commercial-as-a-string normalizes to null");

  const residential = await customers.get("9004", { withProperties: false });
  eq(residential.accountType, "residential", "residential accountType preserved");
  eq(residential.commercial, null, "residential record gains no commercial block");
  deepEq(
    billingParties.resolveBillTo({}, residential),
    { name: "Jane Homeowner", careOf: "", address: "", email: "jane@example.com",
      ccEmail: "", managed: false },
    "residential envelope unchanged after a full hydrate round-trip"
  );
}

// =======================================================================
// 4. Property — billingEntity + siteContacts survive a partial patch
// =======================================================================
group("property — billingEntity + siteContacts persist and survive a PARTIAL patch");
{
  resetStore();
  const manager = await customers.create(MANAGER, { by: "test" });
  const site = await properties.create({
    customerId: manager.id, address: "50 Lewis Honey Dr, Aurora ON",
    customerName: manager.name, customerEmail: manager.email
  });

  eq(site.billingEntity, "", "new property starts with a blank billingEntity");
  deepEq(site.siteContacts, [], "new property starts with no site contacts");

  const withCommercial = await properties.update(site.id, {
    billingEntity: `  ${ENTITY_1233}  `,
    siteContacts: [
      { name: "Faramarz", role: "owner_board", email: "faramarz@example.com", phone: "(416) 555-0123" }
    ]
  });
  eq(withCommercial.billingEntity, ENTITY_1233, "billingEntity trimmed on write");
  eq(withCommercial.siteContacts?.length, 1, "site contact persisted");
  eq(withCommercial.siteContacts?.[0]?.isSiteContact, true, "a property contact defaults to isSiteContact");
  const faramarzId = withCommercial.siteContacts?.[0]?.id;
  ok(billingParties.isContactId(faramarzId), `site contact has a con_ id (${faramarzId})`);

  // The core of acceptance item 2: a patch that mentions NEITHER key must
  // leave both alone. "Empty patch value ≠ delete intent."
  const partial = await properties.update(site.id, { customerPhone: "(905) 555-0100" });
  eq(partial.billingEntity, ENTITY_1233, "billingEntity survives a patch that doesn't mention it");
  eq(partial.siteContacts?.length, 1, "siteContacts survive a patch that doesn't mention them");
  eq(partial.siteContacts?.[0]?.id, faramarzId, "site contact id is stable across the partial patch");

  // And a patch that touches only one of the pair leaves the other alone.
  const entityOnly = await properties.update(site.id, { billingEntity: ENTITY_0987 });
  eq(entityOnly.billingEntity, ENTITY_0987, "billingEntity updated");
  eq(entityOnly.siteContacts?.length, 1, "siteContacts untouched when only the entity is patched");
  eq(entityOnly.siteContacts?.[0]?.id, faramarzId, "site contact id still stable");

  const contactsOnly = await properties.update(site.id, {
    siteContacts: [{ id: faramarzId, name: "Faramarz K.", role: "owner_board", email: "faramarz@example.com" }]
  });
  eq(contactsOnly.billingEntity, ENTITY_0987, "billingEntity untouched when only contacts are patched");
  eq(contactsOnly.siteContacts?.[0]?.id, faramarzId, "id round-tripped through the editor is preserved");
  eq(contactsOnly.siteContacts?.[0]?.name, "Faramarz K.", "the rename actually applied");

  // Re-read from disk.
  const reread = await properties.get(site.id);
  eq(reread.billingEntity, ENTITY_0987, "billingEntity is on disk");
  eq(reread.siteContacts?.[0]?.id, faramarzId, "site contact id is on disk");

  // End-to-end: the resolver reading real stored records.
  const custRecord = await customers.get(manager.id, { withProperties: false });
  const envelope = billingParties.resolveBillTo(reread, custRecord);
  eq(envelope.name, ENTITY_0987, "stored property drives the bill-to name");
  eq(envelope.careOf, MANAGER.name, "stored customer drives the c/o line");
  eq(envelope.managed, true, "end-to-end managed envelope");

  const roles = billingParties.resolveContactRoles(reread, custRecord);
  deepEq(roles.signatories.map((c) => c.name), ["Gurdip"], "stored signatory resolves");
  deepEq(roles.siteContacts.map((c) => c.name), ["Faramarz K."], "stored site contact resolves");
}

group("property hydrate — legacy site contacts are backfilled with ids");
{
  resetStore();
  fs.writeFileSync(PROPERTIES_JSON, JSON.stringify([{
    id: "prop-legacy", code: "P-2026-0001", address: "9 Legacy Ln",
    customerName: "Legacy Condo Corp", createdAt: "2026-01-01T00:00:00.000Z",
    billingEntity: "  Legacy Condo Corp  ",
    siteContacts: [{ name: "Old Contact", role: "super", email: "OLD@Example.com" }]
  }], null, 2), "utf8");

  const loaded = await properties.get("prop-legacy");
  eq(loaded.billingEntity, "Legacy Condo Corp", "legacy billingEntity trimmed on read");
  eq(loaded.siteContacts?.[0]?.role, "other", "unknown legacy role coerced");
  eq(loaded.siteContacts?.[0]?.email, "old@example.com", "legacy email lower-cased");
  const backfilledId = loaded.siteContacts?.[0]?.id;
  ok(billingParties.isContactId(backfilledId), "legacy site contact got a con_ id");

  const onDisk = JSON.parse(fs.readFileSync(PROPERTIES_JSON, "utf8"));
  eq(onDisk[0].siteContacts?.[0]?.id, backfilledId, "backfilled id was written to disk");
  const second = await properties.get("prop-legacy");
  eq(second.siteContacts?.[0]?.id, backfilledId, "id is identical on a second read");
}

group("property — siteContacts as a non-array degrades to []");
{
  resetStore();
  fs.writeFileSync(PROPERTIES_JSON, JSON.stringify([{
    id: "prop-bad", code: "P-2026-0002", address: "1 Bad Shape Rd",
    customerName: "Bad Shape", createdAt: "2026-01-01T00:00:00.000Z",
    billingEntity: 12345, siteContacts: { nope: true }
  }], null, 2), "utf8");
  const loaded = await properties.get("prop-bad");
  deepEq(loaded.siteContacts, [], "object siteContacts reads as an empty array");
  eq(loaded.billingEntity, "12345", "numeric billingEntity coerces to a string");
}

// =======================================================================
// 4b. billingCcEmail persistence + the invoice billTo snapshot
// =======================================================================
group("billingCcEmail — persists on customer and property, per-site overrides");
{
  resetStore();
  const manager = await customers.create(
    { ...MANAGER, billingCcEmail: "  BookKeeper@RMSCO.example  " }, { by: "test" });
  eq(manager.billingCcEmail, "bookkeeper@rmsco.example", "customer CC trimmed + lower-cased on create");

  const reread = await customers.get(manager.id, { withProperties: false });
  eq(reread.billingCcEmail, "bookkeeper@rmsco.example", "customer CC survives a re-read");

  // Patchable, and clearable with an empty string.
  const patched = await customers.update(manager.id, { billingCcEmail: "NEW@Books.example" }, { by: "test" });
  eq(patched.billingCcEmail, "new@books.example", "customer CC patchable + normalized");
  const cleared = await customers.update(manager.id, { billingCcEmail: "" }, { by: "test" });
  eq(cleared.billingCcEmail, "", "customer CC clearable with an empty string");
  await customers.update(manager.id, { billingCcEmail: "bookkeeper@rmsco.example" }, { by: "test" });

  const site = await properties.create({
    customerId: manager.id, address: "50 Lewis Honey Dr, Aurora ON",
    customerName: manager.name, customerEmail: manager.email
  });
  eq(site.billingCcEmail, "", "new property starts with a blank CC");

  const withCc = await properties.update(site.id, {
    billingEntity: ENTITY_1233, billingCcEmail: "  AP@YRSCC1233.Example  "
  });
  eq(withCc.billingCcEmail, "ap@yrscc1233.example", "property CC trimmed + lower-cased");

  // Same partial-patch guarantee as billingEntity/siteContacts.
  const partial = await properties.update(site.id, { customerPhone: "(905) 555-0100" });
  eq(partial.billingCcEmail, "ap@yrscc1233.example", "property CC survives a patch that doesn't mention it");

  // End-to-end precedence against stored records.
  const storedSite = await properties.get(site.id);
  const storedCust = await customers.get(manager.id, { withProperties: false });
  eq(billingParties.resolveBillTo(storedSite, storedCust).ccEmail,
    "ap@yrscc1233.example", "stored per-site CC wins over the stored account CC");

  // Clearing the site CC falls back to the account-level one.
  const noSiteCc = await properties.update(site.id, { billingCcEmail: "" });
  eq(billingParties.resolveBillTo(noSiteCc, storedCust).ccEmail,
    "bookkeeper@rmsco.example", "clearing the site CC falls back to the account CC");
}

group("invoice billTo — snapshots ccEmail and locks it after send");
{
  resetStore();
  const manager = await customers.create(
    { ...MANAGER, billingCcEmail: "bookkeeper@rmsco.example" }, { by: "test" });
  const site = await properties.create({
    customerId: manager.id, address: "50 Lewis Honey Dr, Aurora ON",
    customerName: manager.name, customerEmail: manager.email
  });
  await properties.update(site.id, {
    billingEntity: ENTITY_1233, billingCcEmail: "ap@yrscc1233.example"
  });

  const draft = await invoices.createDraft({
    propertyId: site.id, customerId: manager.id,
    customerName: manager.name, customerEmail: manager.email,
    address: "50 Lewis Honey Dr, Aurora ON",
    lineItems: [{ description: "Spring opening", price: 100, qty: 1 }]
  });
  eq(draft.billTo.name, ENTITY_1233, "draft bills the site's legal entity");
  eq(draft.billTo.careOf, MANAGER.name, "draft carries the c/o line");
  eq(draft.billTo.ccEmail, "ap@yrscc1233.example", "draft snapshots the per-site CC");

  // The whole point of a snapshot: changing the source afterwards must not
  // rewrite an invoice that has already been issued.
  await properties.update(site.id, { billingCcEmail: "someone-else@example.com" });
  const afterEdit = await invoices.get(draft.id);
  eq(afterEdit.billTo.ccEmail, "ap@yrscc1233.example",
    "editing the property CC does NOT retro-rewrite the invoice snapshot");

  // A billTo patch that omits ccEmail (the invoice edit UI only exposes
  // name/address/email) must not silently drop the bookkeeper.
  const edited = await invoices.update(draft.id, {
    billTo: { name: ENTITY_1233, careOf: MANAGER.name, address: "1 Manager Way", email: "ap@rmsco.example" }
  });
  eq(edited.billTo.ccEmail, "ap@yrscc1233.example", "a billTo patch without ccEmail preserves it");

  // ...but an explicit empty string clears it.
  const clearedCc = await invoices.update(draft.id, {
    billTo: { name: ENTITY_1233, careOf: MANAGER.name, address: "1 Manager Way",
      email: "ap@rmsco.example", ccEmail: "" }
  });
  eq(clearedCc.billTo.ccEmail, "", "an explicit empty ccEmail clears it while still a draft");

  // Residential: no CC anywhere → empty, and nothing else changes.
  const jane = await customers.create(
    { name: "Jane Homeowner", email: "jane@example.com" }, { by: "test" });
  const janeDraft = await invoices.createDraft({
    customerId: jane.id, customerName: "Jane Homeowner", customerEmail: "jane@example.com",
    address: "12 Residential Rd", lineItems: [{ description: "Repair", price: 50, qty: 1 }]
  });
  eq(janeDraft.billTo.ccEmail, "", "residential invoice snapshots an empty CC");
  eq(janeDraft.billTo.name, "Jane Homeowner", "residential bill-to name unchanged");
  eq(janeDraft.billTo.email, "jane@example.com", "residential bill-to email unchanged");
}

group("buildInvoiceCcList — the send path's CC assembly");
{
  const build = billingParties.buildInvoiceCcList;
  deepEq(build({ to: "owner@example.com" }), [], "no CC sources → empty list");
  deepEq(build({ to: "owner@example.com", spouseEmail: "spouse@example.com" }),
    ["spouse@example.com"], "spouse only — unchanged pre-addendum behaviour");
  deepEq(build({ to: "owner@example.com", billingCcEmail: "books@example.com" }),
    ["books@example.com"], "billing CC only");
  deepEq(build({ to: "owner@example.com", spouseEmail: "spouse@example.com", billingCcEmail: "books@example.com" }),
    ["spouse@example.com", "books@example.com"], "both, spouse first");

  // Dedupe — a customer seeing their own address in the CC line reads as a bug.
  deepEq(build({ to: "owner@example.com", billingCcEmail: "OWNER@example.com" }),
    [], "billing CC equal to the primary recipient is dropped (case-insensitive)");
  deepEq(build({ to: "owner@example.com", spouseEmail: "books@example.com", billingCcEmail: "Books@Example.com" }),
    ["books@example.com"], "one address serving two roles is listed once");
  deepEq(build({ to: "owner@example.com", spouseEmail: "  Spouse@Example.com  " }),
    ["spouse@example.com"], "addresses are trimmed + lower-cased");
  deepEq(build(), [], "no arguments tolerated");
}

// =======================================================================
// 4c. Contact cap — reject on write, lossless on read (addendum §3)
// =======================================================================
group("contact cap — a write past 10 is REJECTED, not silently trimmed");
{
  resetStore();
  // create()
  await throwsWithCode(
    () => customers.create(
      { name: "Too Many Co", email: "toomany@example.com", accountType: "commercial",
        commercial: { contacts: manyContacts(11, "Contact") } }, { by: "test" }),
    "CONTACT_CAP_EXCEEDED", "create() rejects 11 customer contacts");
  const afterFailedCreate = await customers.list();
  eq(afterFailedCreate.length, 0, "the rejected create wrote nothing");

  // Exactly 10 is fine.
  const okCust = await customers.create(
    { name: "Exactly Ten Co", email: "ten@example.com", accountType: "commercial",
      commercial: { contacts: manyContacts(10, "Contact") } }, { by: "test" });
  eq(okCust.commercial?.contacts?.length, 10, "exactly 10 contacts is accepted");

  // update()
  await throwsWithCode(
    () => customers.update(okCust.id,
      { commercial: { contacts: manyContacts(11, "Contact") } }, { by: "test" }),
    "CONTACT_CAP_EXCEEDED", "update() rejects 11 customer contacts");
  const unchanged = await customers.get(okCust.id, { withProperties: false });
  eq(unchanged.commercial?.contacts?.length, 10, "the rejected PATCH left the record untouched");

  // Empty rows don't count toward the cap — 10 real + 2 blank is fine.
  const withBlanks = await customers.update(okCust.id, {
    commercial: { contacts: [...manyContacts(10, "Contact"), {}, { name: "", email: "" }] }
  }, { by: "test" });
  eq(withBlanks.commercial?.contacts?.length, 10, "blank rows are dropped, not counted against the cap");

  // Property side.
  const prop = await properties.create({
    customerId: okCust.id, address: "1 Cap Test Rd",
    customerName: "Exactly Ten Co", customerEmail: "ten@example.com"
  });
  await properties.update(prop.id, { siteContacts: manyContacts(10, "Site") });
  const propTen = await properties.get(prop.id);
  eq(propTen.siteContacts.length, 10, "exactly 10 site contacts is accepted");

  await throwsWithCode(
    () => properties.update(prop.id, { siteContacts: manyContacts(11, "Site") }),
    "CONTACT_CAP_EXCEEDED", "property update() rejects 11 site contacts");
  const propUnchanged = await properties.get(prop.id);
  eq(propUnchanged.siteContacts.length, 10, "the rejected property PATCH left the list untouched");
}

group("contact cap — reading an already-over-cap record is lossless and never throws");
{
  // The failure mode that matters most: readAll() swallows exceptions, so a
  // throw on read would return an EMPTY list and look like total data loss.
  resetStore();
  fs.writeFileSync(CUSTOMERS_JSON, JSON.stringify([{
    id: "7001", name: "Over Cap Co", email: "over@example.com", accountType: "commercial",
    commercial: { contacts: manyContacts(13, "Legacy") }
  }], null, 2), "utf8");

  const all = await customers.list();
  eq(all.length, 1, "the over-cap record still loads (read did not throw)");
  const loaded = await customers.get("7001", { withProperties: false });
  eq(loaded.commercial?.contacts?.length, 13, "all 13 contacts survive the read — nothing trimmed");
  eq(loaded.commercial?.contacts?.[12]?.name, "Legacy 13", "the 13th contact is intact");

  // An unrelated PATCH still works — only writes that touch `commercial` fail.
  const renamed = await customers.update("7001", { phone: "(905) 555-0100" }, { by: "test" });
  eq(renamed.commercial?.contacts?.length, 13, "an unrelated PATCH neither fails nor trims");

  // Touching the contacts is what's blocked, until a human trims the list.
  await throwsWithCode(
    () => customers.update("7001", { commercial: { contacts: manyContacts(13, "Legacy") } }, { by: "test" }),
    "CONTACT_CAP_EXCEEDED", "re-saving the over-cap list is rejected");
  const fixed = await customers.update("7001",
    { commercial: { contacts: manyContacts(10, "Legacy") } }, { by: "test" });
  eq(fixed.commercial?.contacts?.length, 10, "trimming to 10 saves cleanly");

  // Same on the property side.
  resetStore();
  fs.writeFileSync(PROPERTIES_JSON, JSON.stringify([{
    id: "prop-overcap", code: "P-2026-0003", address: "2 Over Cap Rd",
    customerName: "Over Cap Co", createdAt: "2026-01-01T00:00:00.000Z",
    siteContacts: manyContacts(12, "Legacy")
  }], null, 2), "utf8");
  const loadedProp = await properties.get("prop-overcap");
  eq(loadedProp.siteContacts.length, 12, "all 12 site contacts survive the read");
}

// =======================================================================
// 5. The audit script agrees with the libs
// =======================================================================
group("audit script — reports the drift these fixtures contain, and mutates nothing");
{
  resetStore();
  fs.writeFileSync(CUSTOMERS_JSON, JSON.stringify([
    { id: "8001", name: "Manager Co", accountType: "commercial",
      commercial: { contacts: [{ name: "Sig", email: "sig@example.com", isAuthorizedSignatory: true }] } },
    { id: "8002", name: "Mismatch Co", accountType: "commercial" }
  ], null, 2), "utf8");
  fs.writeFileSync(PROPERTIES_JSON, JSON.stringify([
    { id: "q1", address: "1 Self Bill Rd", customerId: "8001", billingEntity: "Manager Co" }
  ], null, 2), "utf8");

  const customersBefore = fs.readFileSync(CUSTOMERS_JSON, "utf8");
  const propertiesBefore = fs.readFileSync(PROPERTIES_JSON, "utf8");

  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, [
    path.join(__dirname, "audit-commercial-data.js"), "--json",
    "--data-dir", path.join(SANDBOX, "data")
  ], { encoding: "utf8" });
  const report = JSON.parse(out);

  const codes = [...report.customers, ...report.properties].flatMap((r) => r.issues.map((i) => i.code));
  ok(codes.includes("commercial_type_no_block"), "flags a commercial account with no block");
  ok(codes.includes("entity_duplicates_customer_name"), "flags a billingEntity that self-bills");
  ok(codes.includes("contact_missing_id"), "flags contacts still awaiting an id backfill");

  eq(fs.readFileSync(CUSTOMERS_JSON, "utf8"), customersBefore, "audit did not touch customers.json");
  eq(fs.readFileSync(PROPERTIES_JSON, "utf8"), propertiesBefore, "audit did not touch properties.json");
}

// ---- Teardown ---------------------------------------------------------

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\ncommercial schema: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("\nFailures:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
