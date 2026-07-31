// Lead → Customer resolution. Which canonical customer record does an
// intake lead belong to, and when do we create a new one?
//
// Lifted out of server.js by the commercial-matching brief (Phase 0.5) so
// the rule can be tested at an integration boundary. It is the single most
// consequential decision in intake: get it wrong and PJL ends up with two
// customer records for one account, which then diverge in billing details
// and push conflicting identities into QuickBooks. It depends only on the
// customers and properties libs, so it runs standalone.
//
// The rule, in order:
//
//   1. COMMERCIAL ADDRESS ANCHOR. If the lead's address resolves to a
//      building already owned by a commercial account, that account is the
//      customer. Full stop — no identifier match, no create.
//
//      This exists because commercial and residential have OPPOSITE stable
//      identities. Residential: the person is the customer. Commercial: the
//      BUILDING and its billing entity are the customer, and the person is
//      a property manager who churns year to year. Anchoring commercial
//      intake on the submitter's email meant a new PM contacting PJL about
//      an existing managed site matched nothing and a duplicate
//      management-company record was created right here.
//
//   2. IDENTIFIER MATCH — email first, then phone (spec §3.1). Unchanged.
//
//   3. CREATE. Unchanged, including the commercial block carried from the
//      lead for a genuinely new commercial account.
//
// Residential intake never produces an anchor (step 1 returns null for a
// residential-owned building, and also when the submitter already owns a
// property at the address), so residential resolution is byte-identical to
// what it was before this module existed.

const customers = require("./customers");
const properties = require("./properties");

// Resolve (or create) the canonical customer for an intake lead. Returns
// the customer id, or null if resolution produced nothing.
//
// `coords` is optional; pass the geocoded lead address when the caller
// already has it so this and properties.attachLead resolve the SAME anchor.
// Without it the anchor still matches on the exact normalized address.
async function resolveCustomerForLead(lead, { coords = null } = {}) {
  const contact = lead.contact || {};
  const email = contact.email || "";
  const phone = contact.phone || "";
  const address = contact.address || "";

  // Step 1 — address anchor. Soft-failure: a lookup error must not block
  // intake, it just falls through to the identifier rule.
  let anchor = null;
  try {
    anchor = await properties.findCommercialAnchor(address, coords, { submitterEmail: email });
  } catch (err) {
    console.warn("[customers] commercial anchor lookup failed:", err?.message || err);
  }

  // Step 2 — identifier match.
  let match = null;
  if (email) match = await customers.findByEmail(email);
  if (!match && phone) match = await customers.findByPhone(phone);

  if (anchor) {
    // The address wins even when the submitter resolves to some other
    // customer record — that's a person who moved companies or serves two
    // accounts, not a different building. properties.attachLead surfaces
    // the mismatch for Patrick; here we simply refuse to create a duplicate
    // or pick the wrong payer.
    if (match && match.id !== anchor.customerId) {
      console.warn(
        `[customers] commercial address anchor ${anchor.customerId} overrides submitter match ${match.id} for lead ${lead.id}`
      );
    }
    return finishCustomerForLead(anchor.customerId, lead, contact);
  }

  // Step 3 — create.
  let customerId = match?.id || null;
  if (!customerId) {
    try {
      // Commercial intake carries the account type + commercial block
      // (contacts[] with role + function flags, PO/terms) onto the canonical
      // customer record, so quotes later default their acceptor from the
      // isAuthorizedSignatory contact. lead.commercial.additionalContacts maps
      // to customer.commercial.contacts (normalizeCommercialBlock accepts
      // either key). Residential leads pass neither (create() defaults
      // accountType="residential", commercial=null).
      const isCommercial = lead.accountType === "commercial";
      const created = await customers.create({
        name: contact.name || "",
        email,
        phone,
        source: lead.source || "lead",
        customerSince: lead.createdAt,
        status: "lead",
        ...(isCommercial ? {
          accountType: "commercial",
          // careOf lives on lead.billing (the bill-to envelope) but belongs
          // on the customer's commercial block, where invoices and the
          // acceptor resolve it from. Merge it in at conversion.
          commercial: {
            ...(lead.commercial || {}),
            ...(lead.billing && lead.billing.careOf ? { careOf: lead.billing.careOf } : {})
          }
        } : {})
      }, { by: "intake", note: `Auto-created from lead ${lead.id}` });
      customerId = created.id;
    } catch (err) {
      if (err.code === "DUPLICATE_EMAIL") {
        // Race condition or normalization edge case — fall back to the
        // existing record rather than re-throwing.
        customerId = err.existingId;
      } else {
        throw err;
      }
    }
  }
  return finishCustomerForLead(customerId, lead, contact);
}

// Shared tail: log the outreach on the customer and seed empty billing
// fields from the lead's structured bill-to. Split out so the
// commercial-anchor path and the residential path run exactly the same
// follow-up — the anchor short-circuits customer RESOLUTION, not the
// record-keeping. Patrick still sees that someone reached out, and a
// managed account still gains its c/o party from the intake.
async function finishCustomerForLead(customerId, lead, contact) {
  if (customerId) {
    try {
      await customers.addCommunication(customerId, {
        ts: lead.createdAt,
        source: lead.source || "lead",
        summary: `New ${lead.source || "lead"} intake`,
        notes: contact.notes || "",
        logId: lead.id
      });
    } catch (err) {
      console.warn("[customers] addCommunication failed:", err?.message || err);
    }
    // Billing-party brief §3.7 — seed the customer's billing fields from
    // the lead's structured bill-to, but ONLY into empty fields. A
    // hand-curated billingName/billingAddress/billingEmail on the
    // customer record is never overwritten by a later intake. This is also
    // what keeps a transient submitter from redefining a stable account's
    // billing identity on the commercial-anchor path.
    if (lead.billing && lead.billing.billTo === "other") {
      try {
        const existing = await customers.get(customerId, { withProperties: false });
        const patch = {};
        if (existing && !existing.billingName && lead.billing.name) patch.billingName = lead.billing.name;
        if (existing && !existing.billingAddress && lead.billing.address) patch.billingAddress = lead.billing.address;
        if (existing && !existing.billingEmail && lead.billing.email) patch.billingEmail = lead.billing.email;
        // Seed careOf onto the commercial block too (same fill-empty-only
        // rule) so a matched existing customer still gains the c/o party.
        if (existing && lead.billing.careOf && !(existing.commercial && existing.commercial.careOf)) {
          patch.commercial = { ...(existing.commercial || {}), careOf: lead.billing.careOf };
        }
        if (Object.keys(patch).length) {
          await customers.update(customerId, patch, {
            by: "intake",
            note: `Billing party from lead ${lead.id}: ${lead.billing.name}`
          });
        }
      } catch (err) {
        console.warn("[customers] billing seed failed:", err?.message || err);
      }
    }
  }
  return customerId;
}

module.exports = { resolveCustomerForLead, finishCustomerForLead };
