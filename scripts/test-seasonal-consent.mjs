// Seasonal outreach consent — regression cover.
//
// Two consent defects, both silent, both found 2026-08-25:
//
//   1. PATCH /api/properties/:id sanitized the body against an
//      allow-list that omitted `seasonalEligibility` and `commPrefs`.
//      The property page sent them on every Save profile; the route
//      dropped them, answered 200, and the page redrew the checkboxes
//      from the unchanged record. Opting a property out of spring/fall
//      reminders from the CRM was impossible.
//   2. properties.hydrate() rebuilt commPrefs key by key and omitted
//      `reviewRequestsEmail` + `optOutTokens.reviewEmail`. readAll()
//      writes hydrated records back, so a review-email unsubscribe was
//      erased on the next read and every already-sent unsubscribe link
//      went dead.
//
// What both have in common: `false` is the meaningful value. A consent
// flag that fails to store, or that a loose coercion reads as true,
// sends mail to someone who asked us not to. Assert both directions.
//
//   node scripts/test-seasonal-consent.mjs

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// The lib resolves its store as `__dirname/../data/properties.json`, so
// a sandbox copy of the module gets a sandbox store. Real data is never
// opened. properties.js pulls in only node builtins plus two siblings.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-consent-"));
fs.mkdirSync(path.join(SANDBOX, "lib"), { recursive: true });
for (const file of ["properties.js", "billing-parties.js", "customers.js"]) {
  fs.copyFileSync(path.join(ROOT, "server/lib", file), path.join(SANDBOX, "lib", file));
}
const properties = require(path.join(SANDBOX, "lib", "properties.js"));

// ---- 1. The sanitizer keeps `false`, and keeps out the secrets ------
{
  const clean = properties.sanitizeSeasonalConsent({
    seasonalEligibility: { springOpening: false, fallClosing: true },
    commPrefs: {
      seasonalRemindersSMS: false,
      seasonalRemindersEmail: false,
      reviewRequestsEmail: false,
      // Unsubscribe-link secrets. A request body must never set these.
      optOutTokens: { seasonalSMS: "attacker-chosen", reviewEmail: "attacker-chosen" }
    }
  });
  ok("eligibility false survives sanitation", clean.seasonalEligibility.springOpening === false);
  ok("eligibility true survives sanitation", clean.seasonalEligibility.fallClosing === true);
  ok("sms opt-out survives sanitation", clean.commPrefs.seasonalRemindersSMS === false);
  ok("email opt-out survives sanitation", clean.commPrefs.seasonalRemindersEmail === false);
  ok("review opt-out survives sanitation", clean.commPrefs.reviewRequestsEmail === false);
  ok("optOutTokens are not client-settable", !("optOutTokens" in clean.commPrefs));

  // A partial patch must stay partial — update() merges one level deep,
  // so a key invented here would overwrite a stored pref with a default.
  const partial = properties.sanitizeSeasonalConsent({ commPrefs: { seasonalRemindersSMS: false } });
  ok("partial patch stays partial", JSON.stringify(partial) === '{"commPrefs":{"seasonalRemindersSMS":false}}');
  ok("empty payload yields no keys", JSON.stringify(properties.sanitizeSeasonalConsent({})) === "{}");
  ok("non-object payload is safe", JSON.stringify(properties.sanitizeSeasonalConsent(null)) === "{}");
  ok(
    "unknown keys are dropped",
    JSON.stringify(properties.sanitizeSeasonalConsent({ seasonalEligibility: { springOpening: true, madeUp: true } }))
      === '{"seasonalEligibility":{"springOpening":true}}'
  );
}

// ---- 2. A consent flag is never guessed ----------------------------
{
  // Boolean("false") === true. If the coercion ever slips back to a
  // truthiness test, this is the assertion that catches it.
  const s = properties.sanitizeSeasonalConsent({ commPrefs: { seasonalRemindersEmail: "false" } });
  ok('string "false" reads as opted out', s.commPrefs.seasonalRemindersEmail === false);
  const t = properties.sanitizeSeasonalConsent({ commPrefs: { seasonalRemindersEmail: "true" } });
  ok('string "true" reads as opted in', t.commPrefs.seasonalRemindersEmail === true);

  for (const bad of [0, 1, "", "yes", "off", null, {}, []]) {
    let threw = null;
    try { properties.sanitizeSeasonalConsent({ commPrefs: { seasonalRemindersSMS: bad } }); }
    catch (err) { threw = err; }
    ok(`rejects ${JSON.stringify(bad)} rather than defaulting it`, threw?.code === "BAD_CONSENT_FLAG");
  }
}

// ---- 3. Round trip: opted out stays opted out through a read -------
{
  const created = await properties.create({
    customerId: "cus_consent_test",
    customerName: "Consent Test",
    customerEmail: "consent-test@example.com",
    address: "1 Test Lane, Newmarket, ON"
  });
  ok("new property defaults to opted in", created.seasonalEligibility.springOpening === true
    && created.commPrefs.seasonalRemindersEmail === true
    && created.commPrefs.reviewRequestsEmail === true);

  // Exactly what the property page sends on Save profile, through the
  // same sanitizer the route uses.
  const patch = properties.sanitizeSeasonalConsent({
    seasonalEligibility: { springOpening: false, fallClosing: false },
    commPrefs: { seasonalRemindersSMS: false, seasonalRemindersEmail: false }
  });
  await properties.update(created.id, patch);

  const reread = await properties.get(created.id);
  ok("spring eligibility stays off after a read", reread.seasonalEligibility.springOpening === false);
  ok("fall eligibility stays off after a read", reread.seasonalEligibility.fallClosing === false);
  ok("sms opt-out stays off after a read", reread.commPrefs.seasonalRemindersSMS === false);
  ok("email opt-out stays off after a read", reread.commPrefs.seasonalRemindersEmail === false);
  ok("an unpatched pref is left alone", reread.commPrefs.reviewRequestsEmail === true);

  // The gate the outreach engine actually applies (lib/outreach.js reads
  // `seasonalEligibility?.[key] !== false` and the same for each channel).
  ok("outreach would skip this property in spring", reread.seasonalEligibility.springOpening === false);
  ok("outreach would skip both channels", reread.commPrefs.seasonalRemindersSMS === false
    && reread.commPrefs.seasonalRemindersEmail === false);
}

// ---- 4. Tokens: stable across reads, untouched by a profile save ----
{
  const created = await properties.create({
    customerId: "cus_token_test",
    customerName: "Token Test",
    customerEmail: "token-test@example.com",
    address: "2 Test Lane, Newmarket, ON"
  });
  const minted = await properties.mintOptOutTokensIfMissing(created.id);
  const first = { ...minted.commPrefs.optOutTokens };
  ok("all four token slots mint", ["seasonalSMS", "seasonalEmail", "seasonalAll", "reviewEmail"]
    .every((slot) => typeof first[slot] === "string" && first[slot].length === 32));

  // Re-minting is idempotent. Before the hydrate fix the review slot was
  // wiped on every read, so this call rolled a fresh reviewEmail token
  // and every unsubscribe link already in a customer's inbox went dead.
  const again = await properties.mintOptOutTokensIfMissing(created.id);
  ok("re-mint is idempotent for every slot",
    JSON.stringify(again.commPrefs.optOutTokens) === JSON.stringify(first));

  // A profile save must not disturb them.
  await properties.update(created.id, properties.sanitizeSeasonalConsent({
    commPrefs: { seasonalRemindersSMS: false }
  }));
  const afterSave = await properties.get(created.id);
  ok("a profile save preserves the tokens",
    JSON.stringify(afterSave.commPrefs.optOutTokens) === JSON.stringify(first));

  // The unsubscribe path resolves by token — including the review slot.
  const byReview = await properties.findByOptOutToken(first.reviewEmail, "review");
  ok("review token still resolves to its property", byReview?.id === created.id);

  // The customer clicks unsubscribe in a review email.
  await properties.setSeasonalCommPref(created.id, "review", false);
  const afterUnsub = await properties.get(created.id);
  ok("review opt-out survives the read that follows it",
    afterUnsub.commPrefs.reviewRequestsEmail === false);
  ok("review opt-out leaves seasonal email alone",
    afterUnsub.commPrefs.seasonalRemindersEmail === true);
}

// ---- 5. Source guards ----------------------------------------------
{
  const serverSrc = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  ok(
    "the property PATCH route runs the consent sanitizer",
    serverSrc.includes("properties.sanitizeSeasonalConsent(payload)"),
    "without it the allow-list silently drops the toggles again"
  );

  const libSrc = fs.readFileSync(path.join(ROOT, "server/lib/properties.js"), "utf8");
  const hydrateBlock = libSrc.slice(libSrc.indexOf("function hydrate(p)"));
  const commPrefsBlock = hydrateBlock.slice(
    hydrateBlock.indexOf("commPrefs: {"),
    hydrateBlock.indexOf("deletedAt:")
  );
  for (const key of ["seasonalRemindersSMS", "seasonalRemindersEmail", "reviewRequestsEmail"]) {
    ok(`hydrate() carries ${key}`, commPrefsBlock.includes(key),
      "hydrate rebuilds commPrefs key by key; an omitted key is deleted on read");
  }
  for (const slot of ["seasonalSMS", "seasonalEmail", "seasonalAll", "reviewEmail"]) {
    ok(`hydrate() carries the ${slot} token slot`, commPrefsBlock.includes(slot));
  }

  const propertyJs = fs.readFileSync(path.join(ROOT, "server/property.js"), "utf8");
  ok(
    "the property page still sends both consent blocks",
    propertyJs.includes("seasonalEligibility:") && propertyJs.includes("commPrefs:")
  );
}

fs.rmSync(SANDBOX, { recursive: true, force: true });

if (failures.length) {
  console.error(`\nseasonal consent: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`seasonal consent: ${pass} assertions passed`);
