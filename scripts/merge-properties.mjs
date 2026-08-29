// Merge one property into another — the fix for a customer who ended up
// with two property records for the same physical address.
//
//   node scripts/merge-properties.mjs --keep P-2026-0040 --delete P-2026-0056
//   node scripts/merge-properties.mjs --keep P-2026-0040 --delete P-2026-0056 --apply
//
// WHY THIS EXISTS. Dispatch-created invoices can mint a second property
// under the same customer when the address string it carries doesn't match
// the one already on file (properties.attachLead: same email + different
// address string + no geocode hit within 50m => new property, deliberately,
// per spec §3.1 "do NOT auto-merge"). The CRM has no way to undo that:
//
//   - DELETE /api/properties/:id clears `propertyId` on linked LEADS and
//     nothing else. Invoices, work orders, quotes, projects, bookings,
//     review requests and warranty claims all carry `propertyId` too, and
//     all of them would be left pointing at an id that no longer exists.
//   - POST /api/leads/:id/link-property moves one LEAD between properties.
//     It does not move the money records.
//   - customers.mergeCustomers() is the same operation one level up (two
//     CUSTOMER records for one person). This is its property-level twin and
//     is modelled on it, including the direct-JSON re-point pass: this is a
//     bulk cross-store id rewrite, not a granular per-entity patch.
//
// WHAT IT DOES NOT DO. Issued invoices keep their own snapshots. An
// invoice's `address` and `billTo` are the envelope it was ISSUED with —
// a financial record, frozen at send (Hard Rules 2 & 10; invoices.update()
// refuses a billTo patch once status !== "draft"). Merging re-points which
// property the invoice hangs off; it does not retro-edit an invoice the
// customer has already received. `--align-draft-invoice-addresses` will
// rewrite the service address on invoices still in DRAFT, and only those.
//
// SAFETY
//   - Dry run by default. Nothing is written without --apply.
//   - --apply backs up every file it touches to
//     server/data/_merge-backups/<timestamp>/ first, and prints the restore
//     command.
//   - Refuses when the two properties belong to different customers (that's
//     a customer merge, a different and larger operation) unless
//     --allow-different-customer.
//   - Opt-outs survive the merge: a `false` on either record wins for
//     seasonal eligibility and comm prefs. Never re-subscribe someone by
//     merging.
//   - Nothing is deleted until every re-point has been written.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DATA_DIR = path.join(ROOT, "server", "data");

// Stores that are append-only records of something that already happened.
// A tombstone or a send log describes the past; rewriting an id inside one
// would be falsifying it. Reported, never modified.
const REPORT_ONLY = new Set(["deleted-invoices.json", "email-log.json"]);

// Derived/rebuildable caches keyed by address or token, never by property
// id. Skipped entirely — they carry no reference to re-point.
const SKIP = new Set([
  "geocode-cache.json",
  "distance-cache.json",
  "properties.json",       // handled explicitly below
  "settings.json",
  "users.json",
  "quickbooks.json",
  "quickbooks-items.json",
  "parts-overrides.json",
  "project-rates.json",
  "town-water-rates.json"
]);

// ---- small helpers ---------------------------------------------------

function readJson(file) {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw || "null");
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function nowIso() {
  return new Date().toISOString();
}

function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === "";
}

// Walk any JSON value and hand every object to `visit`. Catches nested
// references — warranty claims carry theirs at `link.propertyId`, not at
// the top level, and a merge that only looked at top-level keys would
// silently orphan them.
function walkObjects(node, visit) {
  if (Array.isArray(node)) {
    for (const item of node) walkObjects(item, visit);
    return;
  }
  if (node && typeof node === "object") {
    visit(node);
    for (const key of Object.keys(node)) walkObjects(node[key], visit);
  }
}

// Union two arrays of records by a stable key, keeping the keeper's copy
// when both sides carry the same key.
function unionById(keepArr, dupArr, keyOf = (r) => r?.id) {
  const out = Array.isArray(keepArr) ? keepArr.slice() : [];
  const seen = new Set(out.map(keyOf).filter((k) => k !== undefined && k !== null));
  let added = 0;
  for (const rec of Array.isArray(dupArr) ? dupArr : []) {
    const key = keyOf(rec);
    if (key !== undefined && key !== null && seen.has(key)) continue;
    if (key !== undefined && key !== null) seen.add(key);
    out.push(rec);
    added += 1;
  }
  return { out, added };
}

function unionScalars(keepArr, dupArr) {
  const out = Array.isArray(keepArr) ? keepArr.slice() : [];
  const seen = new Set(out);
  let added = 0;
  for (const v of Array.isArray(dupArr) ? dupArr : []) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    added += 1;
  }
  return { out, added };
}

function byTs(a, b) {
  return String(a?.ts || "").localeCompare(String(b?.ts || ""));
}

// A record is "the same" property whether it was named by its P-YYYY-NNNN
// code or its raw uuid — Patrick reads codes, the JSON stores ids.
function findProperty(records, needle) {
  const want = String(needle || "").trim();
  if (!want) return null;
  const lower = want.toLowerCase();
  return (
    records.find((p) => p && p.id === want) ||
    records.find((p) => p && String(p.code || "").toLowerCase() === lower) ||
    null
  );
}

function label(p) {
  return `${p.code || "(no code)"} [${p.id}]`;
}

// ---- the merge -------------------------------------------------------

export function mergeProperties({
  dataDir = DEFAULT_DATA_DIR,
  keep: keepRef,
  remove: removeRef,
  apply = false,
  allowDifferentCustomer = false,
  alignDraftInvoiceAddresses = false,
  by = "admin",
  now = nowIso()
} = {}) {
  const problems = [];
  const notes = [];
  const conflicts = [];

  const propertiesFile = path.join(dataDir, "properties.json");
  if (!fs.existsSync(propertiesFile)) {
    throw new Error(`No properties.json in ${dataDir}`);
  }
  const properties = readJson(propertiesFile);
  if (!Array.isArray(properties)) throw new Error("properties.json is not an array.");

  const keep = findProperty(properties, keepRef);
  const dup = findProperty(properties, removeRef);
  if (!keep) problems.push(`Keeper property not found: ${keepRef}`);
  if (!dup) problems.push(`Duplicate property not found: ${removeRef}`);
  if (keep && dup && keep.id === dup.id) {
    problems.push("Keeper and duplicate are the same record — nothing to merge.");
  }
  if (problems.length) return { ok: false, problems, notes, conflicts, applied: false };

  // Merging INTO a record that is in the Trash or archived would move the
  // customer's whole history somewhere the CRM hides by default —
  // properties.list() filters both unless asked. Restore it first.
  if (keep.deletedAt || keep.archivedAt) {
    problems.push(
      `The keeper ${label(keep)} is ${keep.deletedAt ? "in the Trash" : "archived"}. ` +
      "Restore it in the CRM first — merging into it would hide every record you just moved."
    );
    return { ok: false, problems, notes, conflicts, applied: false };
  }
  if (dup.deletedAt || dup.archivedAt) {
    notes.push(
      `The duplicate ${label(dup)} is ${dup.deletedAt ? "in the Trash" : "archived"} — ` +
      "its linked records still point at it, so this merge is still the right move."
    );
  }

  // Same customer, or this is a different (and much larger) operation.
  const sameCustomerId =
    keep.customerId && dup.customerId && keep.customerId === dup.customerId;
  const sameCustomerEmail =
    String(keep.customerEmail || "").trim().toLowerCase() ===
    String(dup.customerEmail || "").trim().toLowerCase();
  if (!sameCustomerId && !(!keep.customerId && !dup.customerId && sameCustomerEmail)) {
    const detail =
      `keeper customerId=${keep.customerId || "(none)"} email=${keep.customerEmail || "(none)"} / ` +
      `duplicate customerId=${dup.customerId || "(none)"} email=${dup.customerEmail || "(none)"}`;
    if (!allowDifferentCustomer) {
      problems.push(
        `These two properties are on different customers (${detail}). ` +
        "Merge the CUSTOMER records first (Merge on the customer page / " +
        "customers.mergeCustomers), then re-run this. " +
        "Pass --allow-different-customer only if you are certain."
      );
      return { ok: false, problems, notes, conflicts, applied: false };
    }
    notes.push(`Proceeding across different customers on --allow-different-customer (${detail}).`);
  }

  // ---- 1. find every reference to the duplicate ----------------------

  const repoints = [];      // { file, records: [{ id, summary }] , mutate() }
  const reportOnly = [];    // { file, records: [...] }
  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".json"));

  for (const file of files.sort()) {
    if (SKIP.has(file)) continue;
    const full = path.join(dataDir, file);
    let parsed;
    try {
      parsed = readJson(full);
    } catch (err) {
      notes.push(`Skipped ${file} — couldn't parse it (${err.message}).`);
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    const hits = [];
    walkObjects(parsed, (obj) => {
      if (obj.propertyId === dup.id) hits.push(obj);
    });
    if (!hits.length) continue;

    // Summarise for the plan by walking the top-level records, so the
    // report names the invoice / work order, not the nested sub-object.
    const owners = parsed.filter((rec) => {
      let found = false;
      walkObjects(rec, (obj) => { if (obj.propertyId === dup.id) found = true; });
      return found;
    });
    const summary = owners.map((rec) => describeRecord(file, rec));

    if (REPORT_ONLY.has(file)) {
      reportOnly.push({ file, count: hits.length, records: summary });
      continue;
    }
    repoints.push({ file, full, parsed, hits, count: hits.length, records: summary });
  }

  // Stale "is this a duplicate?" suggestions on leads point at properties
  // by a bare `id`, not by `propertyId`, so the walk above misses them.
  // Once the duplicate is gone the entry is a dangling row in the CRM's
  // link picker; drop it.
  const leadsFile = path.join(dataDir, "leads.json");
  let leadSuggestionFix = null;
  if (fs.existsSync(leadsFile)) {
    let leads = null;
    try { leads = readJson(leadsFile); } catch (_) { leads = null; }
    if (Array.isArray(leads)) {
      const touched = [];
      for (const lead of leads) {
        if (!lead || !Array.isArray(lead.propertyLinkSuggestions)) continue;
        if (!lead.propertyLinkSuggestions.some((s) => s && s.id === dup.id)) continue;
        touched.push(lead.id);
      }
      if (touched.length) leadSuggestionFix = { file: "leads.json", full: leadsFile, leadIds: touched };
    }
  }

  // ---- 2. build the merged keeper ------------------------------------

  const merged = JSON.parse(JSON.stringify(keep));
  const changes = [];

  // Scalars: the keeper is authoritative; the duplicate only fills blanks.
  for (const field of [
    "customerId", "customerEmail", "customerName", "customerPhone",
    "address", "addressNormalized", "billingEntity", "billingCcEmail"
  ]) {
    if (isBlank(merged[field]) && !isBlank(dup[field])) {
      merged[field] = dup[field];
      changes.push(`filled blank ${field} from the duplicate ("${String(dup[field]).slice(0, 60)}")`);
    }
  }
  if (!merged.coords && dup.coords) {
    merged.coords = dup.coords;
    changes.push("took the duplicate's geocoded coords (keeper had none)");
  }

  // System profile — same rule, one level deeper.
  merged.system = { ...(keep.system || {}) };
  const dupSystem = dup.system || {};
  for (const field of ["controllerLocation", "controllerBrand", "shutoffLocation", "blowoutLocation", "notes"]) {
    if (isBlank(merged.system[field]) && !isBlank(dupSystem[field])) {
      merged.system[field] = dupSystem[field];
      changes.push(`filled blank system.${field} from the duplicate`);
    }
  }
  if (merged.system.zoneCount == null && dupSystem.zoneCount != null) {
    merged.system.zoneCount = dupSystem.zoneCount;
    changes.push(`took the duplicate's system.zoneCount (${dupSystem.zoneCount})`);
  }
  // Zones and valve boxes are a WALKED record of one physical system.
  // Concatenating two versions of the same system would invent hardware,
  // so the keeper wins outright and any second version is reported for a
  // human to reconcile.
  for (const field of ["zones", "valveBoxes"]) {
    const keepList = Array.isArray(merged.system[field]) ? merged.system[field] : [];
    const dupList = Array.isArray(dupSystem[field]) ? dupSystem[field] : [];
    if (!keepList.length && dupList.length) {
      merged.system[field] = dupList;
      changes.push(`took the duplicate's system.${field} (${dupList.length}) — keeper had none`);
    } else if (keepList.length && dupList.length) {
      conflicts.push(
        `system.${field}: keeper has ${keepList.length}, duplicate has ${dupList.length}. ` +
        `Kept the keeper's. Check the property page after the merge and re-enter anything the duplicate had that the keeper doesn't.`
      );
    }
  }

  // Back-references and append-only lists: union, keeper's copy wins on a
  // shared id.
  const leadIds = unionScalars(merged.leadIds, dup.leadIds);
  merged.leadIds = leadIds.out;
  if (leadIds.added) changes.push(`moved ${leadIds.added} lead back-reference(s)`);

  const woIds = unionScalars(merged.workOrderIds, dup.workOrderIds);
  merged.workOrderIds = woIds.out;
  if (woIds.added) changes.push(`moved ${woIds.added} work-order back-reference(s)`);

  for (const field of ["photos", "deferredIssues", "serviceRecords", "siteContacts"]) {
    const res = unionById(merged[field], dup[field]);
    merged[field] = res.out;
    if (res.added) changes.push(`moved ${res.added} ${field} entr${res.added === 1 ? "y" : "ies"}`);
  }

  merged.history = [...(keep.history || []), ...(dup.history || [])].sort(byTs);
  merged.ownerHistory = [...(keep.ownerHistory || []), ...(dup.ownerHistory || [])].sort(byTs);

  // Seasonal pricing: fill nulls only. The additional-blowout flag travels
  // with its price and description as one unit — hydrateSeasonalPricing()
  // nulls the dependents when the flag is off, so taking the flag alone
  // would seed a $0 line and attach the disclaimer to invoices.
  const keepSP = keep.seasonalPricing || {};
  const dupSP = dup.seasonalPricing || {};
  merged.seasonalPricing = { ...keepSP };
  for (const field of ["springOpeningPrice", "fallClosingPrice"]) {
    if (merged.seasonalPricing[field] == null && dupSP[field] != null) {
      merged.seasonalPricing[field] = dupSP[field];
      changes.push(`took the duplicate's seasonalPricing.${field} ($${dupSP[field]})`);
    }
  }
  if (keepSP.hasAdditionalFallBlowout !== true && dupSP.hasAdditionalFallBlowout === true) {
    merged.seasonalPricing.hasAdditionalFallBlowout = true;
    merged.seasonalPricing.additionalFallBlowoutPrice = dupSP.additionalFallBlowoutPrice ?? null;
    merged.seasonalPricing.additionalFallBlowoutDescription = dupSP.additionalFallBlowoutDescription || "";
    changes.push("took the duplicate's additional fall blow-out (flag + price + description)");
    if (merged.seasonalPricing.additionalFallBlowoutPrice == null) {
      conflicts.push(
        "The duplicate had the additional fall blow-out turned ON with no price. " +
        "Set a dollar amount on the property page or turn the toggle back off — " +
        "the CRM refuses to save it priceless, and a $0 line would still attach the disclaimer to invoices."
      );
    }
  }

  // Consent: a `false` on EITHER record wins. Merging must never
  // re-subscribe someone who opted out on the record being deleted.
  merged.seasonalEligibility = { ...(keep.seasonalEligibility || {}) };
  for (const field of ["springOpening", "fallClosing"]) {
    const dupVal = dup.seasonalEligibility?.[field];
    if (dupVal === false && merged.seasonalEligibility[field] !== false) {
      merged.seasonalEligibility[field] = false;
      changes.push(`carried the duplicate's seasonalEligibility.${field} = false (opt-outs win)`);
    }
  }

  merged.commPrefs = {
    ...(keep.commPrefs || {}),
    optOutTokens: { ...((keep.commPrefs || {}).optOutTokens || {}) }
  };
  for (const field of ["seasonalRemindersSMS", "seasonalRemindersEmail", "reviewRequestsEmail"]) {
    const dupVal = dup.commPrefs?.[field];
    if (dupVal === false && merged.commPrefs[field] !== false) {
      merged.commPrefs[field] = false;
      changes.push(`carried the duplicate's commPrefs.${field} = false (opt-outs win)`);
    }
  }
  // Unsubscribe tokens: the keeper's live links stay live. Where the
  // keeper never minted one, adopt the duplicate's so any unsubscribe link
  // already in a customer's inbox keeps resolving. Where both have one,
  // the duplicate's dies with the record — say so out loud.
  const dupTokens = dup.commPrefs?.optOutTokens || {};
  for (const slot of ["seasonalSMS", "seasonalEmail", "seasonalAll", "reviewEmail"]) {
    const keepTok = merged.commPrefs.optOutTokens[slot] || null;
    const dupTok = dupTokens[slot] || null;
    if (!dupTok) continue;
    if (!keepTok) {
      merged.commPrefs.optOutTokens[slot] = dupTok;
      changes.push(`adopted the duplicate's ${slot} unsubscribe token (keeper had none)`);
    } else {
      notes.push(
        `Both properties had a ${slot} unsubscribe token. The keeper's stays live; ` +
        "the duplicate's stops resolving, so an unsubscribe link in an email already sent " +
        "for the duplicate property will no longer work. The customer's preference itself is preserved."
      );
    }
  }

  // Outreach history: merge per season key, concatenate touches, and let an
  // opt-out for that season win.
  merged.seasonalOutreach = { ...(keep.seasonalOutreach || {}) };
  for (const [key, dupState] of Object.entries(dup.seasonalOutreach || {})) {
    const keepState = merged.seasonalOutreach[key];
    if (!keepState) {
      merged.seasonalOutreach[key] = dupState;
      changes.push(`took the duplicate's outreach history for ${key}`);
      continue;
    }
    const seen = new Set(
      (keepState.touches || []).map((t) => `${t?.ts}|${t?.messageBatchId || ""}`)
    );
    const extra = (dupState.touches || []).filter(
      (t) => !seen.has(`${t?.ts}|${t?.messageBatchId || ""}`)
    );
    merged.seasonalOutreach[key] = {
      ...keepState,
      touches: [...(keepState.touches || []), ...extra].sort(byTs),
      optOutThisSeason: keepState.optOutThisSeason === true || dupState.optOutThisSeason === true
    };
    if (extra.length) changes.push(`merged ${extra.length} outreach touch(es) into ${key}`);
  }

  // Provenance. The history entry is what Patrick reads on the property
  // page; mergedFrom is the machine-readable trail. hydrate() spreads the
  // stored record over its blank, so an extra top-level key survives reads.
  const noteText =
    `Merged property ${label(dup)}${dup.address ? ` — ${dup.address}` : ""} into this record. ` +
    `${repoints.reduce((a, r) => a + r.count, 0)} linked record(s) re-pointed. Duplicate deleted.`;
  merged.history = [...merged.history, { ts: now, action: "property_merged", by, note: noteText }];
  merged.mergedFrom = [
    ...(Array.isArray(keep.mergedFrom) ? keep.mergedFrom : []),
    {
      ts: now,
      id: dup.id,
      code: dup.code || "",
      address: dup.address || "",
      customerId: dup.customerId || null,
      by
    }
  ];
  merged.updatedAt = now;

  // ---- 3. draft invoice addresses (opt-in) ---------------------------

  const draftInvoiceAligns = [];
  if (alignDraftInvoiceAddresses) {
    const invEntry = repoints.find((r) => r.file === "invoices.json");
    if (invEntry) {
      for (const inv of invEntry.parsed) {
        if (!inv || inv.propertyId !== dup.id) continue;
        if (inv.status !== "draft") continue;
        const target = merged.address || "";
        if (!target || inv.address === target) continue;
        draftInvoiceAligns.push({ id: inv.id, from: inv.address || "", to: target });
      }
    }
  }

  // ---- 4. report ------------------------------------------------------

  // The whole point of the merge, stated plainly: every invoice that will
  // hang off the surviving property once this runs, with the address each
  // one was issued with. Two invoices showing two addresses for one house
  // is what sends someone looking for a duplicate in the first place.
  const invoicesAfter = [];
  {
    const invFile = path.join(dataDir, "invoices.json");
    if (fs.existsSync(invFile)) {
      try {
        const all = readJson(invFile);
        if (Array.isArray(all)) {
          for (const inv of all) {
            if (!inv || (inv.propertyId !== keep.id && inv.propertyId !== dup.id)) continue;
            invoicesAfter.push({
              id: inv.id,
              status: inv.status || "?",
              total: inv.total ?? null,
              address: inv.address || "",
              moving: inv.propertyId === dup.id
            });
          }
        }
      } catch (_) { /* already reported by the scan above */ }
    }
  }

  const plan = {
    keep: { id: keep.id, code: keep.code, address: keep.address, customerId: keep.customerId },
    dup: { id: dup.id, code: dup.code, address: dup.address, customerId: dup.customerId },
    repoints: repoints.map((r) => ({ file: r.file, count: r.count, records: r.records })),
    reportOnly,
    leadSuggestionFix: leadSuggestionFix ? { ...leadSuggestionFix, full: undefined } : null,
    changes,
    conflicts,
    notes,
    draftInvoiceAligns,
    invoicesAfter,
    totalRepointed: repoints.reduce((a, r) => a + r.count, 0)
  };

  if (!apply) return { ok: true, applied: false, plan, problems, notes, conflicts };

  // ---- 5. write -------------------------------------------------------
  //
  // Back up everything first. Re-points are written BEFORE the duplicate is
  // removed, so an interruption leaves records pointing at a property that
  // still exists (recoverable) rather than at one that doesn't.

  const stamp = now.replace(/[:.]/g, "-");
  const backupDir = path.join(dataDir, "_merge-backups", stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  const backedUp = [];
  const toBackUp = new Set([propertiesFile, ...repoints.map((r) => r.full)]);
  if (leadSuggestionFix) toBackUp.add(leadSuggestionFix.full);
  for (const full of toBackUp) {
    const dest = path.join(backupDir, path.basename(full));
    fs.copyFileSync(full, dest);
    backedUp.push(path.basename(full));
  }

  let repointed = 0;
  for (const entry of repoints) {
    walkObjects(entry.parsed, (obj) => {
      if (obj.propertyId === dup.id) {
        obj.propertyId = keep.id;
        repointed += 1;
      }
    });
    if (entry.file === "invoices.json" && draftInvoiceAligns.length) {
      const alignById = new Map(draftInvoiceAligns.map((a) => [a.id, a.to]));
      for (const inv of entry.parsed) {
        if (inv && alignById.has(inv.id) && inv.status === "draft") {
          inv.address = alignById.get(inv.id);
          inv.updatedAt = now;
        }
      }
    }
    writeJson(entry.full, entry.parsed);
  }

  if (leadSuggestionFix) {
    const leads = readJson(leadSuggestionFix.full);
    for (const lead of leads) {
      if (!lead || !Array.isArray(lead.propertyLinkSuggestions)) continue;
      const kept = lead.propertyLinkSuggestions.filter((s) => s && s.id !== dup.id);
      if (kept.length === lead.propertyLinkSuggestions.length) continue;
      if (kept.length) lead.propertyLinkSuggestions = kept;
      else delete lead.propertyLinkSuggestions;
    }
    writeJson(leadSuggestionFix.full, leads);
  }

  // Duplicate goes last.
  const nextProperties = properties
    .map((p) => (p.id === keep.id ? merged : p))
    .filter((p) => p.id !== dup.id);
  writeJson(propertiesFile, nextProperties);

  return {
    ok: true,
    applied: true,
    plan: { ...plan, totalRepointed: repointed },
    backupDir,
    backedUp,
    problems,
    notes,
    conflicts
  };
}

// One line per linked record in the plan, so the operator can recognise
// what is moving rather than reading a bare count.
function describeRecord(file, rec) {
  const id = rec?.id || "(no id)";
  switch (file) {
    case "invoices.json":
      return `${id} — ${rec.status || "?"} — $${rec.total ?? "?"} — "${rec.address || ""}"`;
    case "work-orders.json":
      return `${id} — ${rec.type || "?"} — ${rec.status || "?"} — "${rec.address || ""}"`;
    case "quotes.json":
      return `${id} — ${rec.type || "?"} — ${rec.status || "?"}`;
    case "leads.json":
      return `${id} — ${rec.name || rec.customerName || ""} — "${rec.address || ""}"`;
    case "bookings.json":
      return `${id} — ${rec.serviceType || rec.type || "?"} — ${rec.date || rec.start || "?"}`;
    case "projects.json":
      return `${id} — ${rec.title || rec.name || "?"} — ${rec.status || "?"}`;
    case "review-requests.json":
      return `${id} — ${rec.status || "?"}`;
    case "warranty-claims.json":
      return `${id} — ${rec.status || "?"} — ${rec.claimNumber || ""}`;
    default:
      return `${id}`;
  }
}

// ---- CLI -------------------------------------------------------------

function parseArgs(argv) {
  const args = { apply: false, allowDifferentCustomer: false, alignDraftInvoiceAddresses: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--allow-different-customer") args.allowDifferentCustomer = true;
    else if (a === "--align-draft-invoice-addresses") args.alignDraftInvoiceAddresses = true;
    else if (a === "--keep") args.keep = argv[++i];
    else if (a === "--delete") args.remove = argv[++i];
    else if (a === "--data") args.dataDir = argv[++i];
    else if (a === "--by") args.by = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("--")) throw new Error(`Unknown option: ${a}`);
  }
  return args;
}

const USAGE = `
Merge one property into another, then delete the duplicate.

  node scripts/merge-properties.mjs --keep <code|id> --delete <code|id> [options]

  --keep <code|id>    The property that survives (e.g. P-2026-0040)
  --delete <code|id>  The duplicate, deleted once everything is re-pointed
  --apply             Actually write. Without it this is a dry run.
  --data <dir>        Data directory (default server/data)
  --by <name>         Who to record in the property history (default "admin")
  --allow-different-customer
                      Proceed even though the two properties sit on
                      different customers. Merge the CUSTOMERS first if you
                      can — this is an override, not a shortcut.
  --align-draft-invoice-addresses
                      Also rewrite the service address on any DRAFT invoice
                      that moves. Sent, paid and void invoices are never
                      touched: their address is the envelope they were
                      issued with.

Run it once with no --apply, read the plan, then run it again with --apply.
`.trim();

function printPlan(result) {
  const { plan } = result;
  const out = [];
  out.push("");
  out.push(result.applied ? "MERGE APPLIED" : "DRY RUN — nothing written");
  out.push("");
  out.push(`  Keep    ${plan.keep.code || "(no code)"}  ${plan.keep.id}`);
  out.push(`          "${plan.keep.address || ""}"`);
  out.push(`  Delete  ${plan.dup.code || "(no code)"}  ${plan.dup.id}`);
  out.push(`          "${plan.dup.address || ""}"`);
  out.push("");

  if (!plan.repoints.length) {
    out.push("  Nothing links to the duplicate — it only needs deleting.");
  } else {
    out.push(`  Re-point ${plan.totalRepointed} reference(s) to the keeper:`);
    for (const r of plan.repoints) {
      out.push(`    ${r.file} (${r.count})`);
      for (const line of r.records) out.push(`      - ${line}`);
    }
  }
  out.push("");

  if (plan.leadSuggestionFix) {
    out.push(`  Drop the stale duplicate-suggestion on ${plan.leadSuggestionFix.leadIds.length} lead(s).`);
    out.push("");
  }

  if (plan.invoicesAfter.length) {
    out.push(`  Invoices on the surviving property afterwards (${plan.invoicesAfter.length}):`);
    for (const i of plan.invoicesAfter) {
      out.push(`    ${i.moving ? "→" : " "} ${i.id} — ${i.status} — $${i.total ?? "?"} — "${i.address}"`);
    }
    out.push("    Each keeps the address it was ISSUED with — that is the record of what");
    out.push("    the customer received, and it is not rewritten by the merge.");
    out.push("");
  }

  if (plan.reportOnly.length) {
    out.push("  Append-only records that mention the duplicate and are LEFT AS THEY ARE");
    out.push("  (they describe what already happened; rewriting them would falsify them):");
    for (const r of plan.reportOnly) {
      out.push(`    ${r.file} (${r.count})`);
      for (const line of r.records) out.push(`      - ${line}`);
    }
    out.push("");
  }

  if (plan.draftInvoiceAligns.length) {
    out.push("  Draft invoices whose service address will be re-written:");
    for (const a of plan.draftInvoiceAligns) {
      out.push(`    ${a.id}`);
      out.push(`      from "${a.from}"`);
      out.push(`      to   "${a.to}"`);
    }
    out.push("");
  }

  out.push(plan.changes.length ? "  Property record changes:" : "  Property record: keeper's fields already cover everything.");
  for (const c of plan.changes) out.push(`    - ${c}`);
  out.push("");

  if (plan.conflicts.length) {
    out.push("  NEEDS A LOOK AFTERWARDS:");
    for (const c of plan.conflicts) out.push(`    ! ${c}`);
    out.push("");
  }
  if (plan.notes.length) {
    out.push("  Notes:");
    for (const n of plan.notes) out.push(`    - ${n}`);
    out.push("");
  }
  return out.join("\n");
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(`\n${USAGE}`);
    process.exit(2);
  }
  if (args.help || !args.keep || !args.remove) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }

  let result;
  try {
    result = mergeProperties({
      dataDir: args.dataDir ? path.resolve(args.dataDir) : DEFAULT_DATA_DIR,
      keep: args.keep,
      remove: args.remove,
      apply: args.apply,
      allowDifferentCustomer: args.allowDifferentCustomer,
      alignDraftInvoiceAddresses: args.alignDraftInvoiceAddresses,
      by: args.by || "admin"
    });
  } catch (err) {
    console.error(`\nMerge failed: ${err.message}\n`);
    process.exit(1);
  }

  if (!result.ok) {
    console.error("\nRefused:\n");
    for (const p of result.problems) console.error(`  ! ${p}`);
    console.error("");
    process.exit(1);
  }

  console.log(printPlan(result));

  if (result.applied) {
    console.log(`  Backup of every file touched, before the merge:`);
    console.log(`    ${result.backupDir}`);
    console.log(`    (${result.backedUp.join(", ")})`);
    console.log("");
    console.log("  To undo, copy those files back over server/data/ and restart the service.");
    console.log("");
  } else {
    console.log("  Re-run with --apply to write it.");
    console.log("");
    console.log("  The app reads and writes these files on every request, so run --apply");
    console.log("  when nothing else is touching the CRM.");
    console.log("");
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
