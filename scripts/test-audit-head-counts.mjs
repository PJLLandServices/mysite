#!/usr/bin/env node
// scripts/test-audit-head-counts.mjs
//
// The head-count audit reads Patrick's real projects. "Read-only" is a
// claim, and a claim about a script that touches live data has to be
// provable — so this proves it the same way test-audit-split-zones does:
//
//   A. The source, with its own comments stripped so its prose cannot
//      satisfy the scan, contains no write call, no child process and no
//      network client.
//   B. It refuses to print at all when a field looks like contact data.
//   C. It reports what it claims: placed / planned / assigned per area,
//      the per-valve breakdown, and it does NOT cry wolf on an area that
//      is simply not traced on a sheet.
//   D. The data it read is byte-for-byte unchanged afterwards.
//
//   npm run test:audit-head-counts

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "audit-head-counts.mjs");

let pass = 0; const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.error("  FAIL " + name + (detail ? " — " + detail : "")); }
};

// ── A. It provably cannot write ──────────────────────────────────────
console.log("\nA. The script cannot write, spawn or reach the network");
{
  const src = fs.readFileSync(SCRIPT, "utf8");
  // Strip comments first: the file DESCRIBES what it does not do, and a
  // naive scan would match its own prose and pass for the wrong reason.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const FORBIDDEN = [
    [/\bwriteFile(Sync)?\s*\(/, "writeFile"],
    [/\bappendFile(Sync)?\s*\(/, "appendFile"],
    [/\bmkdir(Sync)?\s*\(/, "mkdir"],
    [/\brmdir(Sync)?\s*\(/, "rmdir"],
    [/\brm(Sync)?\s*\(/, "rm"],
    [/\bunlink(Sync)?\s*\(/, "unlink"],
    [/\brename(Sync)?\s*\(/, "rename"],
    [/\bcopyFile(Sync)?\s*\(/, "copyFile"],
    [/\bcreateWriteStream\s*\(/, "createWriteStream"],
    [/\btruncate(Sync)?\s*\(/, "truncate"],
    [/\bchmod(Sync)?\s*\(/, "chmod"],
    [/\bfetch\s*\(/, "fetch"],
    [/\bexecFile(Sync)?\s*\(|\bexecSync\s*\(|\bspawn(Sync)?\s*\(/, "a child process"],
    [/require\s*\(\s*["']node:child_process["']|from\s+["']node:child_process["']/, "child_process"],
    [/require\s*\(\s*["']node:https?["']|from\s+["']node:https?["']/, "http"]
  ];
  for (const [re, what] of FORBIDDEN) {
    check(`no ${what}`, !re.test(code), "found in audit-head-counts.mjs");
  }
  check("it only ever reads", /readFileSync/.test(code) && /existsSync/.test(code));
}

// ── Fixtures ─────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heads-"));
const clean = path.join(tmp, "clean"); fs.mkdirSync(clean);
const dirty = path.join(tmp, "dirty"); fs.mkdirSync(dirty);

const PAGE = "pg1";
const mh = (x, y) => ({ x, y, arc: 360, dir: 0, noz: "b40" });
const design = () => ({
  version: 9,
  inputs: { availGPM: "18", psi: "60", ceiling: "9.0", spacingFactor: "1" },
  areas: [
    // Traced, hand-placed: the shape Patrick's front rotors are in.
    { aid: "a_front", name: "Restaurant Front", family: "rotor", rotorNoz: "b40", mode: "custom",
      planRef: { pageId: PAGE },
      poly: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 40 }, { x: 0, y: 40 }],
      layout: "manual",
      manualHeads: [mh(10, 20), mh(25, 20), mh(40, 20), mh(55, 20),
                    mh(70, 20), mh(85, 20), mh(100, 20), mh(115, 20)] },
    // Auto, NOT traced: has planned heads and nothing drawable. Legitimate,
    // and must not be reported as a disagreement.
    { aid: "a_side", name: "Side strip", family: "rotor", rotorNoz: "b40",
      mode: "rect", L: 40, W: 10, sqft: 400, avgW: 10 },
    { aid: "a_bed", name: "Planters", family: "drip", mode: "custom", planRef: { pageId: PAGE },
      poly: [{ x: 0, y: 60 }, { x: 40, y: 60 }, { x: 40, y: 80 }, { x: 0, y: 80 }] },
    // HAND-PLACED but NOT traced: heads saved, no sheet to draw them on.
    // placed 3 / planned 3 / assigned 0 — legitimately, because nothing is
    // drawable. This is the ONLY area that exercises the `traced` guard:
    // an auto area is already excluded by `placed == null`, so without this
    // one the guard could be deleted and the suite would stay green.
    { aid: "a_orphan", name: "Orphan hand-placed", family: "rotor", rotorNoz: "b40",
      mode: "rect", L: 40, W: 10, sqft: 400, avgW: 10,
      layout: "manual", manualHeads: [mh(5, 5), mh(20, 5), mh(35, 5)] }
  ],
  routing: { [PAGE]: { poc: { x: 60, y: 100 }, main: [],
    manifolds: [{ x: 5, y: 50, id: "m1" }, { x: 118, y: 50, id: "m2" }], pins: {}, splits: {} } }
});

fs.writeFileSync(path.join(clean, "projects.json"), JSON.stringify([
  { id: "PROJ-2026-0008", name: "McDonalds Dundalk ON", systemDesign: design() }
]));
// A project whose NAME carries a phone number: the report must refuse.
const leaky = { id: "PROJ-2026-0009", name: "Jim Smith 905-555-0142", systemDesign: design() };
fs.writeFileSync(path.join(dirty, "projects.json"), JSON.stringify([leaky]));

function run(dir, extra = []) {
  try {
    return { code: 0, out: execFileSync("node", [SCRIPT, "--data", dir, ...extra],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || ""), err: String(e.stderr || "") };
  }
}

// ── B. It refuses to leak ────────────────────────────────────────────
console.log("\nB. A field that looks like contact data stops the report");
{
  const r = run(dirty);
  check("it exits 3 rather than printing", r.code === 3, `exit ${r.code}`);
  check("...and prints nothing at all", !r.out.trim(), r.out.slice(0, 80));
  check("...and says why on stderr", /contact data/i.test(r.err || ""), (r.err || "").slice(0, 80));
  check("the phone number is nowhere in the output", !/905-555-0142/.test(r.out));
}

// ── C. It reports what it claims ─────────────────────────────────────
console.log("\nC. The report says placed / planned / assigned, per area and per valve");
{
  const r = run(clean, ["--json"]);
  check("it runs clean and exits 0", r.code === 0, r.err || "");
  const rows = JSON.parse(r.out);
  const front = rows.find((x) => x.area === "Restaurant Front");
  const side = rows.find((x) => x.area === "Side strip");
  const bed = rows.find((x) => x.area === "Planters");

  check("the hand-placed area reports 8 placed", front && front.placed === 8, JSON.stringify(front && front.placed));
  check("...8 planned", front && front.planned === 8, JSON.stringify(front && front.planned));
  check("...and 8 assigned — no heads lost", front && front.assigned === 8, JSON.stringify(front && front.assigned));
  check("...and is marked as hand-placed", front && front.handPlaced === true);
  check("...and as traced", front && front.traced === true);
  check("...and breaks down per valve", front && front.valves.length >= 2, JSON.stringify(front && front.valves.length));
  check("...whose per-valve heads sum to the area's",
        front && front.valves.reduce((t, v) => t + v.drawn, 0) === front.assigned,
        JSON.stringify(front && front.valves.map((v) => v.drawn)));

  check("an UNTRACED area is marked untraced", side && side.traced === false);
  check("...reports planned heads it cannot draw", side && side.planned > 0 && side.assigned === 0,
        JSON.stringify(side && [side.planned, side.assigned]));
  check("a drip bed reports beds, not heads", bed && bed.placed === null && bed.beds === 1);

  // The `traced` guard: an area with hand-placed heads and no sheet reports
  // placed 3 / assigned 0, which is NOT a disagreement. Delete the guard and
  // the two --mismatches checks below go red.
  const orphan = rows.find((x) => x.area === "Orphan hand-placed");
  check("a hand-placed area with no sheet still reports its placed heads",
        orphan && orphan.placed === 3 && orphan.planned === 3,
        JSON.stringify(orphan && [orphan.placed, orphan.planned]));
  check("...assigns none of them, having nothing to draw on",
        orphan && orphan.assigned === 0 && orphan.traced === false,
        JSON.stringify(orphan && [orphan.assigned, orphan.traced]));

  // The report must not cry wolf on the untraced area.
  const human = run(clean, ["--mismatches"]);
  check("--mismatches reports nothing when everything adds up",
        /add up/.test(human.out), human.out.trim().slice(0, 100));
  check("...and specifically does NOT flag the untraced areas",
        !/Side strip/.test(human.out) && !/Orphan hand-placed/.test(human.out),
        human.out.slice(0, 160));

  const named = run(clean, ["--project", "PROJ-2026-0008"]);
  check("--project shows the per-valve lines", /station\s+\d+ · Restaurant Front/.test(named.out),
        named.out.slice(0, 160));
  check("...and says what the zone claims against what the sheet draws",
        /zone says \d+ hd, sheet draws \d+/.test(named.out));
}

// ── D. The data is untouched ─────────────────────────────────────────
console.log("\nD. The data it read is exactly as it was");
{
  const before = fs.readFileSync(path.join(clean, "projects.json"));
  run(clean); run(clean, ["--json"]); run(clean, ["--project", "PROJ-2026-0008"]);
  const after = fs.readFileSync(path.join(clean, "projects.json"));
  check("projects.json is unchanged after three runs", before.equals(after));
  check("no file was added to the data directory",
        fs.readdirSync(clean).sort().join(",") === "projects.json",
        fs.readdirSync(clean).join(","));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\naudit head counts: ${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error("  - " + f); process.exit(1); }
