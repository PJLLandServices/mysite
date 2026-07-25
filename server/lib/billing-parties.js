// Billing parties — resolves WHO is billed and THROUGH WHOM, from the
// (property, customer) pair. One place, so invoices, quote PDFs and the
// admin UI can never disagree about the envelope.
//
// The management-company model (Jul 2026): one CUSTOMER can manage MANY
// properties, and each property is owned by its own legal entity that gets
// billed. So the payer's legal name lives on the PROPERTY
// (property.billingEntity) and the managing company is the CUSTOMER.
//
//   Commercial, managed (property HAS its own billing entity):
//     name    = property.billingEntity        "YRSCC No. 1233 — Lewis Honey…"
//     careOf  = customer.name                 "c/o RMSCO Management Services Ltd."
//     address = customer.billingAddress       where the invoice is mailed
//
//   Everything else (residential, or a commercial account that bills itself):
//     name    = customer.billingName || customer.name
//     careOf  = customer.commercial.careOf    (manual override, usually empty)
//     address = customer.billingAddress || the service address
//
// The second branch is byte-identical to the pre-existing behaviour, so
// residential invoices are untouched.

function s(v, n = 400) {
  return String(v == null ? "" : v).trim().slice(0, n);
}

// Resolve the bill-to envelope. Both args tolerate null.
// Returns { name, careOf, address, email, managed }
//   managed — true when the c/o was derived from a managing customer, i.e.
//             this is a property-level billing entity. Lets callers label
//             the UI ("Managed billing") without re-deriving the rule.
function resolveBillTo(property, customer, { fallbackAddress = "" } = {}) {
  const prop = property && typeof property === "object" ? property : {};
  const cust = customer && typeof customer === "object" ? customer : {};

  const entity = s(prop.billingEntity, 200);
  const custName = s(cust.name, 200);
  const custBillingName = s(cust.billingName, 200);
  const manualCareOf = s(cust.commercial && cust.commercial.careOf, 200);
  const custAddress = s(cust.billingAddress, 400);
  const email = s(cust.billingEmail, 254).toLowerCase() || s(cust.email, 254).toLowerCase();

  // Managed: the property names its own payer AND a managing customer exists
  // to bill it through. A property whose entity matches the customer's own
  // name is self-billed, not managed — don't print "c/o <itself>".
  const managed = Boolean(entity && custName && entity !== custName);

  if (managed) {
    return {
      name: entity,
      careOf: custName,
      address: custAddress || s(fallbackAddress, 400),
      email,
      managed: true
    };
  }

  return {
    name: entity || custBillingName || custName,
    careOf: manualCareOf,
    address: custAddress || s(fallbackAddress, 400),
    email,
    managed: false
  };
}

// Who signs the quote, and who do we call to get on site?
// Signatories come from the CUSTOMER (the management company signs across
// all its sites); a site-specific signatory on the property also counts.
// Site contacts come from the PROPERTY (each site has its own president /
// super), falling back to any customer contact flagged as a site contact.
// Returns { signatories: [...], siteContacts: [...] } — each entry carries
// `from: "customer" | "property"` so the UI can show where it came from.
function resolveContactRoles(property, customer) {
  const prop = property && typeof property === "object" ? property : {};
  const cust = customer && typeof customer === "object" ? customer : {};
  const custContacts = (cust.commercial && Array.isArray(cust.commercial.contacts))
    ? cust.commercial.contacts : [];
  const propContacts = Array.isArray(prop.siteContacts) ? prop.siteContacts : [];

  const tag = (list, from) => list.filter(Boolean).map((c) => ({ ...c, from }));
  const all = [...tag(custContacts, "customer"), ...tag(propContacts, "property")];

  return {
    signatories: all.filter((c) => c.isAuthorizedSignatory),
    siteContacts: all.filter((c) => c.isSiteContact)
  };
}

module.exports = { resolveBillTo, resolveContactRoles };
