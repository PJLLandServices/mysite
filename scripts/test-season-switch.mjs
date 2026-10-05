// The wrong season, caught on the booking page.
//
//   node scripts/test-season-switch.mjs
//
// WHAT THIS PROTECTS. Patrick, 2026-10-02, after a customer tapped "Spring
// opening" in October, chose First available, and was placed — and emailed
// — a spring opening on October 10: "I believe the webpage should prompt
// the client: 'Oops — it looks like you may be looking for a season in the
// past. We are currently booking for (upcoming season). Confirm fall
// closing is what you are looking for?'"
//
// The catalog already says which seasons are open (`season.open` on each
// service, from seasons.publicBookingStatus). This pins that the page
// reads it at the moment of the tap: a service whose season is not open,
// when the same band exists in an open season, is a question before it is
// a step; Yes swaps to that band and carries on, No keeps the customer's
// choice; a service in the open season (or a non-seasonal one) asks
// nothing. Source guards — the page is browser DOM code.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const js = fs.readFileSync(path.join(ROOT, "js/booking.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "book.html"), "utf8");

// ---- The rule -----------------------------------------------------------
ok("the page can name the same band in an open season", /function sameBandInOpenSeason\(key\)/.test(js));
ok("...and asks only when the tapped service's season is NOT open",
  /meta\.season\.open !== false\) return null/.test(js));
ok("...and only when the other season's band IS open",
  /target\.season\.open === true \? candidate : null/.test(js));
ok("the band is carried across by key prefix, spring_open_ <-> fall_close_",
  /spring_opening: "spring_open_", fall_closing: "fall_close_"/.test(js));

// ---- The moment of the tap ------------------------------------------------
const tap = js.slice(js.indexOf('serviceGrid.addEventListener("click"'), js.indexOf("buildZoneOptions"));
ok("a tap consults the rule before the page moves on",
  /const swap = sameBandInOpenSeason\(state\.serviceKey\);\s*if \(swap\) \{ showSeasonSwitch\(state\.serviceKey, swap\); return; \}/.test(tap), "the tap advances without asking");
ok("...and otherwise advances exactly as before", /advanceFromService\(\);\s*\}\);/.test(tap));

// ---- The question, in Patrick's words ---------------------------------------
const prompt = js.slice(js.indexOf("function showSeasonSwitch"), js.indexOf('serviceGrid.addEventListener("click"'));
ok("it opens with Oops", /<strong>Oops<\/strong>/.test(prompt));
ok("it says which season we are currently booking", /We're currently booking <strong>\$\{escapeHtml\(wanted\)\}s<\/strong>/.test(prompt));
ok("it asks the customer to confirm", /Is a \$\{escapeHtml\(wanted\)\} what you're looking for\?/.test(prompt));
ok("Yes swaps the service to the open season's band and carries on",
  /season-yes[\s\S]*state\.serviceKey = swapKey;[\s\S]*advanceFromService\(\);/.test(prompt));
ok("...following a deep-link filter into the new season", /if \(state\.familyFilter\) state\.familyFilter = swap\.family;/.test(prompt));
ok("No keeps the customer's choice and carries on",
  /season-no[\s\S]*hideSeasonSwitch\(\);\s*advanceFromService\(\);/.test(prompt));
ok("No names when the asked-for season's dates begin", /first dates \$\{escapeHtml\(startsOn\)\}/.test(prompt));
ok("nothing in the prompt is unescaped", !/\$\{wanted\}|\$\{asked\}|\$\{startsOn\}/.test(prompt));

// ---- The page ---------------------------------------------------------------
ok("the callout lives under the service cards", /id="serviceGrid"><\/div>\s*<div class="book-season-switch" id="seasonSwitch"/.test(html));
ok("...styled, and hidden until it has something to say",
  /\.book-season-switch \{/.test(html) && /\.book-season-switch\[hidden\] \{ display: none; \}/.test(html));
ok("a deep link never locks in a season that isn't open",
  /\(fromSessionHandoff \|\| familyMembers\.length === 1\) && !sameBandInOpenSeason\(preselect\)/.test(js));
ok("backing out of a deep link clears the question too",
  /state\.serviceMeta = null;\s*hideSeasonSwitch\(\);/.test(js));

if (failures.length) {
  console.error(`FAIL test-season-switch: ${failures.length} failing`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`ok test-season-switch — ${pass} assertions`);
