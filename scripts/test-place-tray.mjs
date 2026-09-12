#!/usr/bin/env node
// scripts/test-place-tray.mjs
//
// Patrick, 2026-09-12: "can the 'not on the plan' be somewhere on this
// page and I can just drag and drop them into a day.. There's too many
// avenues that you have to go down when choosing this. It should be the
// same for the 'Open Bucket' as well."
//
// Both lists now live on the cockpit as chips; a chip dragged onto a rail
// day or a half-day block is placed there by the SAME calls the drawers
// make. This pins the tray, the two pure rules it leans on (which half-day
// a day-drop lands in, what a drag carries), the refusals, and that the
// drawers and the drops share one booking function.
//
// Run: node scripts/test-place-tray.mjs  (also in build:check)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const j = (v, n = 200) => String(JSON.stringify(v) ?? "(nothing)").slice(0, n);
const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; }
};

const page = read("server/season-plan.js");
const html = read("server/season-plan.html");
const css = read("server/season-plan.css");

// Lift a pure function out of the page. Absent → every assertion on it
// reports a reason, none crashes.
function lift(name, extra = "") {
  const m = page.match(new RegExp(`  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
  if (!m) return () => ({ missing: `(${name} is missing)` });
  try { return new Function(`${extra} ${m[0]} return ${name};`)(); }
  catch (err) { return () => ({ missing: `(${name} could not be lifted — ${err.message})` }); }
}
const lighterBucketOf = lift("lighterBucketOf");
const parseDragPayload = lift("parseDragPayload");
const dropRefusal = lift("dropRefusal", `
  const current = { days: [
    { date: "2026-10-06", bookedOnly: false }, { date: "2026-10-28", bookedOnly: true }
  ] };
  const todayKey = () => "2026-09-12";`);

// ---- 1. Which half-day a day-drop lands in: the server's rule, read here --
{
  ok("fewer planned stops wins", lighterBucketOf({ counts: { morning: 3, afternoon: 1 } }) === "afternoon", j(lighterBucketOf({ counts: { morning: 3, afternoon: 1 } })));
  ok("…and the other way", lighterBucketOf({ counts: { morning: 1, afternoon: 3 } }) === "morning", j(lighterBucketOf({ counts: { morning: 1, afternoon: 3 } })));
  ok("a tie is the morning (as assignments.lighterBucket)", lighterBucketOf({ counts: { morning: 2, afternoon: 2 } }) === "morning", j(lighterBucketOf({ counts: { morning: 2, afternoon: 2 } })));
  ok("no day at all → morning, not a crash", lighterBucketOf(null) === "morning", j(lighterBucketOf(null)));
}

// ---- 2. What a drag carries ------------------------------------------------
{
  ok("an unplanned chip's payload parses", j(parseDragPayload('{"kind":"unplanned","id":"A1"}')) === j({ kind: "unplanned", id: "A1" }), j(parseDragPayload('{"kind":"unplanned","id":"A1"}')));
  ok("…and a standby chip's", j(parseDragPayload('{"kind":"standby","id":"L-9"}')) === j({ kind: "standby", id: "L-9" }), j(parseDragPayload('{"kind":"standby","id":"L-9"}')));
  ok("an unknown kind is nobody's drop", parseDragPayload('{"kind":"file","id":"x"}') === null, j(parseDragPayload('{"kind":"file","id":"x"}')));
  ok("garbage is nobody's drop", parseDragPayload("not json") === null && parseDragPayload("") === null, j(parseDragPayload("not json")));
  ok("no id is nobody's drop", parseDragPayload('{"kind":"unplanned"}') === null, j(parseDragPayload('{"kind":"unplanned"}')));
}

// ---- 3. Refusals are said before and on the drop ---------------------------
{
  const u = { kind: "unplanned", id: "A1", row: {} };
  const s = { kind: "standby", id: "L-9", row: { resolved: true } };
  ok("a route day takes a property", dropRefusal(u, { date: "2026-10-06", bucket: null }) === "", j(dropRefusal(u, { date: "2026-10-06", bucket: null })));
  ok("…and a half-day", dropRefusal(u, { date: "2026-10-06", bucket: "morning" }) === "", j(dropRefusal(u, { date: "2026-10-06", bucket: "morning" })));
  ok("yesterday is refused", /already happened/.test(dropRefusal(u, { date: "2026-09-01", bucket: null }) || ""), j(dropRefusal(u, { date: "2026-09-01", bucket: null })));
  ok("a booked-only day refuses a plan stop", /booked-only/.test(dropRefusal(u, { date: "2026-10-28", bucket: null }) || ""), j(dropRefusal(u, { date: "2026-10-28", bucket: null })));
  ok("an open-bucket customer on a day → allowed (the afternoon is chosen)", dropRefusal(s, { date: "2026-10-06", bucket: null }) === "", j(dropRefusal(s, { date: "2026-10-06", bucket: null })));
  ok("…on the afternoon → allowed", dropRefusal(s, { date: "2026-10-06", bucket: "afternoon" }) === "", j(dropRefusal(s, { date: "2026-10-06", bucket: "afternoon" })));
  ok("…on the MORNING → refused, saying why", /afternoon/.test(dropRefusal(s, { date: "2026-10-06", bucket: "morning" }) || ""), j(dropRefusal(s, { date: "2026-10-06", bucket: "morning" })));
  ok("…with an unpinpointed address → refused", /pinpointed/.test(dropRefusal({ ...s, row: { resolved: false } }, { date: "2026-10-06", bucket: null }) || ""), j(dropRefusal({ ...s, row: { resolved: false } }, { date: "2026-10-06", bucket: null })));
  ok("no day → refused", dropRefusal(u, { date: "", bucket: null }) !== "", j(dropRefusal(u, { date: "", bucket: null })));
}

// ---- 4. The tray is on the cockpit, and the drops do what the drawers do ---
{
  ok("the tray sits inside the cockpit, after the stops pane",
    /sp-stops-pane[\s\S]{0,900}<section class="sp-tray" id="placeTray"/.test(html), "no tray in the cockpit");
  ok("…with a group for each list", /id="trayUnplannedChips"/.test(html) && /id="trayStandbyChips"/.test(html), "a group is missing");
  ok("the unplanned list feeds the tray", /lastUnplanned = placeable;\s*renderTray\(\);/.test(page), "loadUnplanned doesn't render the tray");
  ok("the open bucket feeds the tray", /lastStandby = data\.rows \|\| \[\];\s*renderTray\(\);/.test(page), "loadStandby doesn't render the tray");
  ok("chips are draggable and carry kind + id", /chip\.draggable = !stuck/.test(page) && /setData\("text\/plain", JSON\.stringify\(payload\)\)/.test(page), "chips don't drag");
  ok("an unpinpointed standby customer's chip can't be dragged", /if \(stuck\) \{ event\.preventDefault\(\); return; \}/.test(page), "stuck chips still drag");
  ok("rail rows are drop targets for a day", /wireDropTarget\(row, \(\) => \(\{ date: day\.date, bucket: null \}\)\)/.test(page), "rail rows don't take drops");
  ok("half-day blocks are drop targets for a bucket", /wireDropTarget\(wrap, \(\) => \(\{ date: day\.date, bucket \}\)\)/.test(page), "bucket blocks don't take drops");
  ok("while a chip is in the air, rail rows show its drive cost, best in green",
    /annotateRailForDrag\(\)/.test(page) && /badge\.textContent = `\+\$\{c\.addedDriveMinutes\} min`/.test(page) && /badge\.classList\.add\("is-best"\)/.test(page), "no costs on the rail");
  ok("a property drop adds through addToDay, the ONE plan write on this page",
    /await addToDay\(drag\.id, date, bucket \|\| lighterBucketOf\(day\)\)/.test(page) && (page.match(/\$\{base\(\)\}\/add`/g) || []).length === 1, "a second add path");
  ok("a standby drop books through bookStandby", /await bookStandby\(drag\.row, date\)/.test(page), "drops book some other way");
  ok("…and the drawer's button uses the SAME function", /const booked = await bookStandby\(row, select\.value\)/.test(page), "the drawer books its own way");
  ok("…which asks the slot resolver, never a hard-coded minute",
    (page.match(/\/api\/admin\/open-bucket\/slot/g) || []).length === 1 && (page.match(/\/api\/booking\/reserve/g) || []).length === 1, "slot/reserve called from more than one place");
  ok("a refused drop is said on the drop, not swallowed", /const why = dropRefusal\(drag, \{ date, bucket \}\);\s*if \(why\) \{ showToast\(why, "bad"\); return; \}/.test(page), "silent refusal");
  ok("the drop targets light up (and go red when refused)", /\.sp-railrow\.is-dropover/.test(css) && /is-droprefused/.test(css), "no drop styling");
  ok("the tray hides when nothing is waiting", /placeTray\.hidden = lastUnplanned\.length === 0 && lastStandby\.length === 0/.test(page), "an empty tray shows");
}

if (failures.length) {
  console.error(`\n✗ test-place-tray: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-place-tray: ${pass} assertions passed`);
