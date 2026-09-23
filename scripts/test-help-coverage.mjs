#!/usr/bin/env node
// scripts/test-help-coverage.mjs
//
// The help centre's whole value is that its text and the builder's
// tooltips CANNOT disagree. That is a claim about the future — about the
// next person who adds a tool — so it has to be a gate, not a convention.
//
// What broke, and what each section here would have caught:
//
//   The Split tool's tooltip said the halves are "wired as one station".
//   mpSetSplit() stored shareStation:false — TWO stations — and had done
//   for months. The same wrong sentence sat in the Help panel's paragraph,
//   with the button between them saying the opposite. Three copies, two
//   wrong, no way to notice.
//
//   npm run test:help-coverage

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = fs.readFileSync(path.join(ROOT, "server", "sitebuilder.html"), "utf8");
const HELP = require(path.join(ROOT, "server", "sitebuilder-help.js"));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "fixtures", "help-tooltips-golden.json"), "utf8"));

let pass = 0; const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.error("  FAIL " + name + (detail ? " — " + detail : "")); }
};

// ── A. Every tool on screen has an entry ─────────────────────────────
console.log("\nA. No tool can ship without help");
{
  const tools = [...new Set([...PAGE.matchAll(/mpSetTool\('([a-z0-9]+)'\)/g)].map((m) => m[1]))].sort();
  check("the page still has tools to check", tools.length >= 7, tools.join(","));
  for (const t of tools) {
    const e = HELP.byId(t);
    check(`tool "${t}" has a registry entry`, !!e);
    if (e) check(`  ...with a tooltip`, !!e.tip && e.tip.length > 20);
  }

  // Every control carrying data-help must resolve. A typo in the id would
  // otherwise render a button with no label at all and nothing would say so.
  const ids = [...new Set([...PAGE.matchAll(/data-help="([^"]+)"/g)].map((m) => m[1]))];
  check("the page marks controls with data-help", ids.length >= 13, String(ids.length));
  const unknown = ids.filter((id) => !HELP.byId(id));
  check("every data-help id resolves to an entry", !unknown.length, unknown.join(", "));
}

// ── B. No help text written inline in the page ───────────────────────
console.log("\nB. The page carries no help text of its own");
{
  // The toolbar is the part that drifted, so it is held strictly: its
  // buttons may carry NO literal tooltip at all.
  const rail = PAGE.slice(PAGE.indexOf('id="mpTools"'), PAGE.indexOf('id="mpBody"'));
  check("no literal data-tip survives on a toolbar button", !/data-tip="/.test(rail),
        (rail.match(/data-tip="[^"]{0,40}/) || [""])[0]);
  // Only the BUTTONS. The rail itself keeps aria-label="Master plan tools",
  // which is a landmark name for the toolbar, not help text about a control.
  const railButtons = [...rail.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  const labelled = railButtons.filter((b) => /aria-label="/.test(b));
  check("no literal aria-label survives on a toolbar button", !labelled.length,
        labelled.map((b) => (b.match(/aria-label="([^"]*)"/) || [])[1]).join(", "));
  check("...and the rail itself keeps its landmark name", /id="mpTools"[^>]*aria-label="Master plan tools"/.test(rail));
  check("every toolbar button names an entry instead", (rail.match(/data-help="/g) || []).length >= 13);

  // The action buttons whose text was WRONG must read from the registry.
  for (const [what, re] of [
    ["the share-station toggle", /shr\.tipOn\s*:\s*shr\.tip/],
    ["its label", /shr\.labelOn\s*:\s*shr\.labelOff/],
    ["one valve per box", /HELP\.tip\('one-valve-per-box'\)/],
    ["the split panel link", /HELP\.byId\('split'\)\.tipPanel/]
  ]) check(`${what} reads from the registry`, re.test(PAGE));

  // The sentence that was wrong must not be anywhere as live copy.
  const live = PAGE.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  check("the retired wrong sentence is gone from live markup",
        !/heads on each side get their own valve \(A \/ B\)[^<]*wired together as one station/i.test(live));
  check("the long Help paragraph is retired", !/id="mpHint"/.test(PAGE));
}

// ── C. Nothing changed that users could see ──────────────────────────
console.log("\nC. Phase 1 renders what the page rendered before");
{
  const ORDER = ["pan", "poc", "manifold", "bend", "lat", "split", "tree",
                 "autoroute", "undo-point", "clear-routing", "laterals-layer", "wire-layer", "help-button"];
  check("the golden master still covers every toolbar control", GOLDEN.length === ORDER.length,
        `${GOLDEN.length} vs ${ORDER.length}`);
  let same = 0;
  ORDER.forEach((id, i) => {
    const g = GOLDEN[i]; if (!g) return;
    const e = HELP.byId(id); if (!e) return;
    // The Help button is the ONE intended text change: it used to toggle a
    // paragraph and now opens a searchable centre. It declares what it
    // replaced, so the change is recorded rather than merely allowed.
    if (id === "help-button") {
      check("the help button's old text is declared, not silently dropped", e.wasTip === g.tip, e.wasTip);
      check("...and its new text says what it now does", /search/i.test(e.tip));
      return;
    }
    const ok = HELP.tip(id) === g.tip && HELP.aria(id) === g.aria;
    if (ok) same += 1;
    else check(`"${g.aria}" is byte-identical to the live page`, false,
               `tip ${HELP.tip(id) === g.tip}, aria ${HELP.aria(id) === g.aria}`);
  });
  check("all 12 other tooltips are byte-identical to what shipped", same === 12, String(same));
}

// ── D. The symbol beside an entry is the symbol on the button ────────
console.log("\nD. Same glyph in the toolbar and in the help entry");
{
  let checked = 0, bad = [];
  for (const e of HELP.byKind("tool")) {
    if (!e.el) continue;                     // dynamic buttons have no id
    const i = PAGE.indexOf(`id="${e.el}"`);
    if (i < 0) { bad.push(`${e.id}: no #${e.el} in the page`); continue; }
    const svg = PAGE.slice(i, PAGE.indexOf("</button>", i));
    const inner = (svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/) || [])[1];
    checked += 1;
    if ((inner || "").trim() !== HELP.icon(e.icon).trim()) bad.push(e.id);
  }
  check("every tool's glyph was checked", checked >= 9, String(checked));
  check("the registry's glyph matches the button's exactly", !bad.length, bad.join(", "));
}

// ── E. Entries are complete and cross-linked ─────────────────────────
console.log("\nE. Every entry is finished");
{
  const ids = new Set(HELP.ENTRIES.map((e) => e.id));
  const dupes = HELP.ENTRIES.map((e) => e.id).filter((id, i, a) => a.indexOf(id) !== i);
  check("no duplicate ids", !dupes.length, dupes.join(", "));

  const noName = HELP.ENTRIES.filter((e) => !e.name);
  const noBody = HELP.ENTRIES.filter((e) => !e.body || e.body.length < 40);
  const noIcon = HELP.ENTRIES.filter((e) => !HELP.icon(e.icon));
  // PRD R7: an entry that only says what a thing IS has not finished the
  // job. Every confusion so far has been between two things that sound
  // alike, so "what it is not" is required, not decorative.
  const noIsNot = HELP.ENTRIES.filter((e) => !e.isNot);
  const noAlias = HELP.ENTRIES.filter((e) => !(e.aliases || []).length);
  check("every entry has a name", !noName.length, noName.map((e) => e.id).join(", "));
  check("every entry has a body", !noBody.length, noBody.map((e) => e.id).join(", "));
  check("every entry has a glyph that exists", !noIcon.length, noIcon.map((e) => e.id).join(", "));
  check("every entry says what it is NOT", !noIsNot.length, noIsNot.map((e) => e.id).join(", "));
  check("every entry has plain-word aliases", !noAlias.length, noAlias.map((e) => e.id).join(", "));

  const broken = [];
  for (const e of HELP.ENTRIES) for (const id of (e.seeAlso || [])) if (!ids.has(id)) broken.push(`${e.id}->${id}`);
  check("every see-also points at an entry that exists", !broken.length, broken.join(", "));

  check("tools and actions all carry a tooltip",
        HELP.ENTRIES.filter((e) => (e.kind === "tool" || e.kind === "action") && !e.tip).length === 0);
  check("concepts and readouts carry none (they have no button)",
        HELP.ENTRIES.filter((e) => (e.kind === "concept" || e.kind === "readout") && e.tip).length === 0);
}

// ── F. Search finds what Patrick would actually type ─────────────────
console.log("\nF. Search answers the words he uses, not the words we use");
{
  const missed = HELP.ENTRIES.filter((e) => { const r = HELP.search(e.name); return !r[0] || r[0].id !== e.id; });
  check("every entry is first for its own name", !missed.length, missed.map((e) => e.id).join(", "));

  // Straight from the transcript. "consecutively" is the load-bearing one:
  // he used it to mean SIMULTANEOUSLY, which is the opposite of what the
  // word means in irrigation, so a matcher reasoning from the dictionary
  // sends him confidently to the wrong entry.
  const REAL = [
    ["consecutively", "shared-station"],
    ["two valves one station", "shared-station"],
    ["together", "shared-station"],
    ["zine", "station-vs-valve-vs-area"],
    ["vowels", "valve-concept"],
    ["why did my station count go up", "what-splitting-does"],
    ["across the driveway", "split"],
    ["hold h", "zoom-pan"],
    ["what does this do", "help-button"]
  ];
  for (const [q, want] of REAL) {
    const top = HELP.search(q)[0];
    check(`"${q}" finds ${want}`, top && top.id === want, top ? top.id : "(nothing)");
  }
  check("a query matching nothing returns nothing", !HELP.search("qqzzxx").length);
  check("an empty query returns nothing rather than everything", !HELP.search("   ").length);
}

// ── G. The registry is generic, and says the right words ─────────────
console.log("\nG. No job data in the help, and the terminology is correct");
{
  // Everything a reader can SEE. Code comments are excluded on purpose —
  // they are not shipped to the screen and they explain the history.
  const shown = HELP.ENTRIES.map((e) => [e.name, e.tip || "", e.body, e.isNot || "",
    (e.aliases || []).join(" "), (e.alsoSearched || []).join(" ")].join("\n")).join("\n");

  const LEAK = [
    [/[\w.+-]+@[\w-]+\.\w+/, "an email address"],
    [/(\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}/, "a phone number"],
    [/\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/, "a postal code"],
    [/\bPROJ-\d{4}-\d{4}\b/, "a project id"],
    [/\bQ-\d{4}-\d{4}\b/, "a quote id"],
    [/\bI-\d{4}-\d{4}\b/, "an invoice number"],
    [/\$\s?\d/, "a dollar amount"],
    [/\b\d+\s+[A-Z][a-z]+\s+(St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Blvd|Cres|Way|Lane|Ln)\b/, "a street address"],
    // Real jobs and people this project has actually discussed.
    [/\bDundalk\b/i, "a customer site"],
    [/\bMcDonald'?s\b/i, "a customer name"],
    [/\bPatrick\b/i, "the owner by name"],
    [/\bPJL\b/, "the company by name"],
    [/\bEast Side Lawn\b/i, "a named zone from a real job"],
    [/\bRestaurant Front\b/i, "a named area from a real job"]
  ];
  for (const [re, what] of LEAK) {
    const hit = shown.match(re);
    check(`no ${what} in any entry`, !hit, hit ? `"${hit[0]}"` : "");
  }
  check("the help was actually scanned", shown.length > 4000, String(shown.length));

  // ── The word, at the registry level ────────────────────────────────
  // Patrick, 2026-09-23: keep "consecutively" as a SEARCH alias, but the
  // displayed text must not redefine it. Simultaneously = together from
  // one station; consecutively = one after another.
  const shared = HELP.byId("shared-station");
  check("shared-station defines simultaneously correctly",
        /simultaneously means the valves operate together from one controller station/i.test(shared.body));
  check("...and consecutively correctly",
        /consecutively means they operate one after another/i.test(shared.body));
  check("...and offers the word as a search term, not a definition",
        (shared.alsoSearched || []).indexOf("consecutively") >= 0);
  check("...while still routing the search there", HELP.search("consecutively")[0].id === "shared-station");

  // The specific mistake being guarded: text that reads "consecutively
  // means/= at the same time". A synonym ROW is fine; a sentence is not.
  const sentences = HELP.ENTRIES.map((e) => [e.name, e.tip || "", e.body, e.isNot || ""].join(" ")).join(" ");
  check("nothing in the displayed help says consecutively means together",
        !/consecutive(ly)?\s*(means|=|is)\s*[^.]{0,40}(same time|simultaneous|together)/i.test(sentences),
        (sentences.match(/consecutive[^.]{0,70}/i) || [])[0] || "");
  check("the synonym map still carries the routing", HELP.SYNONYMS.consecutively === "together");
}

console.log(`\nhelp coverage: ${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error("  - " + f); process.exit(1); }
