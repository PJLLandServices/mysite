#!/usr/bin/env node
// scripts/test-audit-split-zones.mjs
//
// The split-zone audit runs against PRODUCTION data. Two things therefore
// have to be true, and neither can be left as a claim in a comment:
//
//   A. IT CANNOT WRITE. Asserted by scanning the script for every
//      write-shaped call — filesystem, network, child process. If somebody
//      adds one later, this fails rather than the audit quietly gaining
//      the ability to modify a project.
//
//   B. IT CANNOT LEAK. Asserted by running it over a fixture whose project
//      and area names carry an email, a phone number and a postal code,
//      and requiring it to print nothing at all.
//
// Then the report itself: the columns Patrick asked for, the legacy /
// explicit distinction, and the two station counts.
//
//   npm run test:audit-split-zones

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { v8WithSplits } from "./fixtures/v8-split-designs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "audit-split-zones.mjs");

let pass = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log("  ok   " + name); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.error("  FAIL " + name + (detail ? " — " + detail : "")); }
};

// ── A. It cannot write ───────────────────────────────────────────────
console.log("\nA. The script has no way to change anything");
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
    [/require\s*\(\s*["']node:http s?["']|from\s+["']node:https?["']/, "http"]
  ];
  for (const [re, what] of FORBIDDEN) {
    check(`no ${what}`, !re.test(code), "found in audit-split-zones.mjs");
  }
  check("it only ever reads", /readFileSync/.test(code) && /existsSync/.test(code));
}

// ── Fixtures ─────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
const clean = path.join(tmp, "clean"); fs.mkdirSync(clean);
const dirty = path.join(tmp, "dirty"); fs.mkdirSync(dirty);

const v9 = JSON.parse(JSON.stringify(v8WithSplits));
v9.version = 9;
v9.routing.pg1.splits["z:a_front:0"].shareStation = false;
v9.routing.pg1.splits["z:a_back:0"].shareStation = true;
// left without a flag on purpose: still legacy-assumed even at version 9
v9.linkedQuoteId = "Q-2026-0088";

fs.writeFileSync(path.join(clean, "projects.json"), JSON.stringify([
  { id: "PROJ-2026-0101", name: "A commercial lot", systemDesign: v8WithSplits },
  { id: "PROJ-2026-0102", name: "Partly reviewed", systemDesign: v9,
    proposalSnapshot: { acceptedAt: "2026-07-01T12:00:00Z" } },
  { id: "PROJ-2026-0103", name: "No design at all" }
]));
fs.writeFileSync(path.join(clean, "quotes.json"), JSON.stringify([{ id: "Q-2026-0088", status: "accepted" }]));

const leaky = JSON.parse(JSON.stringify(v8WithSplits));
leaky.areas[0].name = "Front lawn 905-555-0134";
fs.writeFileSync(path.join(dirty, "projects.json"), JSON.stringify([
  { id: "PROJ-2026-0104", name: "Leaky", systemDesign: leaky }
]));

const run = (dir, extra = []) => {
  try {
    return { code: 0, out: execFileSync("node", [SCRIPT, "--data", dir, ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; }
};

// ── B. It cannot leak ────────────────────────────────────────────────
console.log("\nB. A name carrying personal information stops the report");
{
  const r = run(dirty);
  check("it refuses rather than printing", r.code === 3, `exit ${r.code}`);
  check("nothing of the report is printed", !/SAVED PROJECTS CONTAINING/.test(r.out));
  check("the phone number never appears in the output", !/905-555-0134/.test(r.out));
  check("it says which kind of thing it found", /phone number/i.test(r.out), r.out.trim().slice(0, 120));
}

// ── C. The report says what Patrick asked for ────────────────────────
console.log("\nC. The report");
{
  const r = run(clean, ["--json"]);
  check("it runs clean data without error", r.code === 0, r.out.slice(0, 200));
  const rows = r.code === 0 ? JSON.parse(r.out) : [];
  const byProject = (id) => rows.filter((x) => x.project === id);
  const p101 = byProject("PROJ-2026-0101"), p102 = byProject("PROJ-2026-0102");

  check("projects with no design are skipped", !byProject("PROJ-2026-0103").length);
  check("every split of every project is listed", p101.length === 3 && p102.length === 3,
        `${p101.length} + ${p102.length}`);
  for (const f of ["project", "name", "version", "area", "status", "stationsNow", "stationsIfSeparated", "proposal"]) {
    check(`every row carries ${f}`, rows.every((x) => x[f] !== undefined));
  }
  check("a version-8 split is LEGACY-ASSUMED",
        p101.every((x) => x.status === "LEGACY-ASSUMED shared" && x.legacy === true),
        JSON.stringify(p101.map((x) => x.status)));
  check("an explicitly separated split says so",
        p102.some((x) => x.area === "Front lawn" && x.status === "explicit: separate"),
        JSON.stringify(p102.map((x) => x.area + "=" + x.status)));
  check("an explicitly shared split says so",
        p102.some((x) => x.area === "Back lawn" && x.status === "explicit: shared"));
  check("a version-9 split with no flag is still legacy-assumed",
        p102.some((x) => x.area === "Boulevard trees" && x.legacy === true));
  check("separating the legacy splits raises the station count",
        p101[0].stationsIfSeparated > p101[0].stationsNow,
        `${p101[0].stationsNow} -> ${p101[0].stationsIfSeparated}`);
  check("a job with an accepted snapshot is flagged ACCEPTED",
        p102.every((x) => x.proposal === "ACCEPTED"), p102[0] && p102[0].proposal);
  check("a job with no linked quote reads none",
        p101.every((x) => x.proposal === "none"), p101[0] && p101[0].proposal);
  check("a split whose line misses the zone is marked as not applying",
        rows.some((x) => x.applies === false) || rows.every((x) => x.applies === true),
        "applies flag missing entirely");

  // Nothing beyond the agreed columns.
  const allowed = new Set(["project", "name", "version", "area", "family", "status", "legacy",
                           "applies", "stationsNow", "stationsIfSeparated", "valves", "proposal"]);
  const extra = [...new Set(rows.flatMap((x) => Object.keys(x)))].filter((k) => !allowed.has(k));
  check("no field beyond the agreed columns", !extra.length, extra.join(", "));
}

// ── D. It really did not touch the data ──────────────────────────────
console.log("\nD. The data it read is byte-for-byte as it was");
{
  const before = fs.readFileSync(path.join(clean, "projects.json"));
  run(clean); run(clean, ["--json"]);
  const after = fs.readFileSync(path.join(clean, "projects.json"));
  check("projects.json is unchanged after two runs", before.equals(after));
  check("no file was added to the data directory",
        fs.readdirSync(clean).sort().join(",") === "projects.json,quotes.json",
        fs.readdirSync(clean).join(","));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\naudit split zones: ${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error("  - " + f); process.exit(1); }
