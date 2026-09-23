/* server/sitebuilder-help.js — the System Builder's help registry.
 *
 * WHY THIS FILE EXISTS
 *
 * On 2026-09-23 the Split tool told Patrick the two halves of a split are
 * "wired as one station". mpSetSplit() stores shareStation:false — TWO
 * stations. The description had been written before the shareStation
 * setting existed and was never updated when the default flipped. It was
 * wrong in THREE places at once: the tool's data-tip, the Help panel's
 * paragraph, and nowhere at all in between, while the button beside it
 * said the opposite. He drew a split believing it would share a station,
 * and only found out when a new header started printing station counts.
 *
 * So the rule here is the same one CLAUDE.md states for state tests:
 * DEFINE IT ONCE. Every tooltip, every aria-label and every help entry in
 * the builder is one string in this file, read at render time. There is no
 * second copy to drift, because there is no second copy.
 *
 * scripts/test-help-coverage.mjs enforces that: a tool with no entry, or a
 * help string still written inline in the page, fails the build.
 *
 * Served at /admin/sitebuilder-help.js, staff-gated and URL-stamped
 * exactly like sitebuilder-engine.js — page and registry must always be
 * the same deploy, or the toolbar renders with no labels at all.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SystemBuilderHelp = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ── Icons ────────────────────────────────────────────────────────────
     The glyph bodies, holding the SINGLE copy of each. The toolbar injects
     these and the help panel renders the same string, so the symbol beside
     an entry is provably the symbol on the button — which is the whole of
     what Patrick asked for: "that search button also has a symbol that's
     associated with this tool". Two copies of a path would drift the same
     way two copies of prose did. */
  var ICONS = {
    pan:       '<path d="M5 3l14 9-6.5 1.5L9 20z"/>',
    poc:       '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/><circle cx="12" cy="14" r="2"/>',
    manifold:  '<rect x="4" y="7" width="16" height="11" rx="2"/><path d="M8 7v11M12 7v11M16 7v11M2 12h2M20 12h2"/>',
    bend:      '<path d="M3 20L9 8l6 8 6-12"/><circle cx="9" cy="8" r="1.6"/><circle cx="15" cy="16" r="1.6"/>',
    lat:       '<path d="M4 19h6v-7h10"/><path d="M10 12V5h6"/><circle cx="10" cy="12" r="1.6"/>',
    split:     '<path d="M4 4l16 16"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="6.5" r="2.5"/><path d="M4 20l5-5M20 4l-5 5"/>',
    tree:      '<path d="M12 3l6 8h-3l4 6H5l4-6H6z"/><path d="M12 17v4"/>',
    autoroute: '<path d="M4 20l9-9"/><path d="M14 4l1.5 3 3 1.5-3 1.5L14 13l-1.5-3-3-1.5 3-1.5z"/><path d="M19 15l.8 1.7 1.7.8-1.7.8L19 20l-.8-1.7-1.7-.8 1.7-.8z"/>',
    undo:      '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    trash:     '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    latlayer:  '<path d="M3 12h7l2-5 2 10 2-5h5"/>',
    wire:      '<path d="M3 16c3 0 3-8 6-8s3 8 6 8 3-8 6-8"/>',
    help:      '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7"/><circle cx="12" cy="17" r=".6"/>',
    station:   '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M7 17v3M17 17v3M7 9h2M12 9h5M7 13h10"/>',
    valve:     '<circle cx="12" cy="12" r="4"/><path d="M12 3v5M12 16v5M3 12h5M16 12h5"/>',
    area:      '<path d="M4 18l3-11 7-3 6 6-4 9z"/>',
    flow:      '<path d="M4 8h10a4 4 0 0 1 0 8H8"/><path d="M11 13l-3 3 3 3"/>',
    sheet:     '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    keyboard:  '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    clock:     '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
  };

  /* ── Entries ──────────────────────────────────────────────────────────
     `tip` is THE tooltip: what the button renders on hover. `body` is the
     longer help-centre prose. `isNot` and `confusedWith` exist because
     every confusion in this tool so far has been between two things that
     sound alike — station and valve, split and share — so an entry that
     only says what a thing IS has not finished the job (PRD R7).

     `aliases` are the words Patrick actually reaches for, taken from the
     real transcript rather than guessed. */
  var ENTRIES = [
    /* ---- tools ------------------------------------------------------- */
    {
      id: "pan", kind: "tool", name: "Move", icon: "pan", el: "mpToolpan",
      tip: "Move — click a zone, head or pipe to work on it; drag any marker; Ctrl-drag or scroll to pan and zoom. Tap bare ground to show all.",
      body: "The default tool, and the one to come back to. Click an area, head or lateral pipe to work on that valve by itself. Drag any marker to move it. Ctrl-drag or scroll to get around the sheet. Click bare ground to clear the selection and show everything again.",
      isNot: "It does not place anything. Every other tool puts something on the plan; this one only selects and moves what is already there.",
      aliases: ["select", "pointer", "arrow", "cursor", "pan", "zoom", "get out of a tool", "nothing happens when i click"],
      seeAlso: ["zoom-pan"]
    },
    {
      id: "poc", kind: "tool", name: "Point of connection", icon: "poc", el: "mpToolpoc",
      tip: "Point of connection — click the meter or tap on the plan. The mainline starts here.",
      body: "Where the system takes its water — the meter, the tap, the stub the plumber left. Click it on the plan. Everything the mainline does afterwards is measured from this point, so place it before routing anything.",
      isNot: "It is not a valve and not a manifold. Nothing waters from here; it is only where the supply begins.",
      aliases: ["poc", "meter", "tap", "water source", "supply", "where the water comes from", "hookup", "connection"],
      seeAlso: ["mainline-concept", "manifold", "autoroute"]
    },
    {
      id: "manifold", kind: "tool", name: "Manifold", icon: "manifold", el: "mpToolmanifold",
      tip: "Manifold — click to drop a valve box. Zones go to the nearest box unless you put them somewhere else.",
      body: "A valve box in the ground, holding one or more valves. Click to drop one. Each zone is fed from the nearest box automatically, and you can send a zone to a different box from its panel when the nearest one is the wrong one.",
      isNot: "A manifold is not a station and not a valve. It is the box they sit in — several valves commonly share one.",
      aliases: ["valve box", "box", "manifold", "where the valves go", "m1", "m2"],
      seeAlso: ["valve-concept", "one-valve-per-box", "station-vs-valve-vs-area"]
    },
    {
      id: "bend", kind: "tool", name: "Mainline bend", icon: "bend", el: "mpToolbend",
      tip: "Mainline bend — click to run the mainline through a point. Select a node first to tee off it.",
      body: "Makes the mainline turn a corner or go around something. Click where it should bend. To branch the mainline rather than bend it, select the node you want to branch from first, then click — that tees off that exact point.",
      isNot: "This bends the MAINLINE, the pipe feeding the valve boxes. For the pipe from a valve out to its heads, use Lateral bend instead.",
      aliases: ["mainline", "corner", "turn", "elbow", "tee", "branch", "main pipe"],
      seeAlso: ["lat", "mainline-concept", "autoroute"]
    },
    {
      id: "lat", kind: "tool", name: "Lateral bend", icon: "lat", el: "mpToollat",
      tip: "Lateral bend — with a zone selected: click on the pipe to bend it, off the pipe to branch out, or select a bend first to tee from it. Drag bends; Delete removes one.",
      body: "Shapes the pipe running from one valve out to its heads. Select the zone first. Click ON the pipe to put a bend in that run. Click OFF the pipe to run a branch out to where you clicked. Select an existing bend first to tee off that exact point. Drag a bend to move it; Delete removes it and the run splices back together. Heads, beds and each tree attach themselves to the nearest point on the pipe.",
      isNot: "This is not the mainline. A lateral is downstream of one valve and only carries that valve's flow.",
      aliases: ["lateral", "branch", "pipe to the heads", "tee", "bend the pipe", "reroute"],
      seeAlso: ["bend", "lateral-concept", "back-to-auto"]
    },
    {
      id: "split", kind: "tool", name: "Split zone", icon: "split", el: "mpToolsplit",
      tip: "Split zone — with a zone selected, click two points to draw a line across it. Heads or trees on each side get their own valve AND their own controller station. Wire them back to one station afterwards if they should open together.",
      body: "For one area fed from two places — a lawn either side of a driveway, trees at both ends of a property. Select the zone, then click two points to draw a line across it. Whatever falls on each side becomes its own valve, A and B, each in whichever box you put it.\n\nA NEW SPLIT GIVES YOU TWO SEPARATE CONTROLLER STATIONS. That is deliberate: splitting usually means two runs that should water independently. If the two halves should instead open together on one terminal, use \"wire both valves to one station\" afterwards.",
      isNot: "It does not wire the halves together. It used to, and this description said so long after it stopped being true — which is why the help centre exists. Splitting SEPARATES; combining is a second, deliberate step.",
      tipPanel: "Draw a line across the driveway; each side gets its own valve and its own controller station. You can wire them to one station afterwards if they should open together.",
      aliases: ["split", "cut", "divide", "across the driveway", "two boxes", "both sides", "a and b", "separate a zone"],
      seeAlso: ["share-station", "what-splitting-does", "remove-split", "one-valve-per-box"]
    },
    {
      id: "tree", kind: "tool", name: "Tree", icon: "tree", el: "mpTool3tree",
      tip: "Tree — with a drip or tree zone selected, click to drop a tree. The lateral runs to each tree and tees. Drag to move, Delete to remove.",
      body: "Places a tree on a drip or tree zone. Select the zone first, then click where the tree stands. The lateral runs out to each tree and tees, and the pipe length is measured off the real distances on the sheet. Drag to move one, Delete to remove it.",
      isNot: "A tree is not a head. Tree zones are counted in trees, not head counts, and a tree zone's reports say \"trees\" where a lawn zone says \"heads\".",
      aliases: ["tree", "trees", "bubbler", "rws", "root watering", "add a tree", "plant"],
      seeAlso: ["lat", "head-concept", "split"]
    },
    /* ---- toolbar actions --------------------------------------------- */
    {
      id: "autoroute", kind: "tool", name: "Auto-route", icon: "autoroute", el: null, sel: "[onclick='mpAutoRoute()']",
      tip: "Auto-route — run the mainline from the point of connection to every manifold in one go.",
      body: "Draws the whole mainline for you, from the point of connection out to every valve box on the sheet. A good starting point that you then bend by hand where the real trench has to go around something.",
      isNot: "It does not touch laterals — only the mainline. And it will not run at all until a point of connection exists.",
      aliases: ["auto", "automatic", "route it for me", "draw the main", "do it for me"],
      seeAlso: ["poc", "bend", "mainline-concept"]
    },
    {
      id: "undo-point", kind: "tool", name: "Undo point", icon: "undo", el: null, sel: "[onclick='mpUndoPoint()']",
      tip: "Undo point — take back the last mainline node placed.",
      body: "Removes the last mainline node you placed. Useful mid-route when a click lands in the wrong spot.",
      isNot: "It is not a general undo. It only takes back mainline nodes — not laterals, splits, trees or anything else.",
      aliases: ["undo", "back", "oops", "take it back", "mistake"],
      seeAlso: ["bend", "clear-routing"]
    },
    {
      id: "clear-routing", kind: "tool", name: "Clear routing", icon: "trash", el: null, sel: "[onclick='mpClearRouting()']",
      tip: "Clear routing — remove the point of connection, mainline and manifolds on this sheet.",
      body: "Wipes the routing on this sheet and starts again: the point of connection, the whole mainline, and every manifold.",
      isNot: "It does not delete your traced areas, your heads or your zones — only the routing. But it is not a small undo either; everything routed on the sheet goes.",
      aliases: ["clear", "start over", "delete everything", "reset", "wipe"],
      seeAlso: ["undo-point", "autoroute"]
    },
    {
      id: "laterals-layer", kind: "tool", name: "Laterals layer", aria: "Toggle laterals", icon: "latlayer", el: "mpToolLat",
      tip: "Laterals layer — show or hide every zone's lateral pipe.",
      body: "Shows or hides the lateral pipe on every zone at once, for when the sheet is too busy to read.",
      isNot: "Hiding a layer changes only what you can see. Nothing is deleted and no measurement changes.",
      aliases: ["hide pipes", "show pipes", "too busy", "declutter", "laterals"],
      seeAlso: ["wire-layer", "layer-eye"]
    },
    {
      id: "wire-layer", kind: "tool", name: "Wire layer", aria: "Toggle wire", icon: "wire", el: "mpToolWire",
      tip: "Wire layer — show or hide the control wire runs.",
      body: "Shows or hides the control wire runs — the wire from the controller out to each valve.",
      isNot: "Not the water pipe. This is the electrical run that opens the valve.",
      aliases: ["wire", "wires", "electrical", "control wire", "common"],
      seeAlso: ["laterals-layer", "station-concept"]
    },
    {
      id: "help-button", kind: "tool", name: "Help", aria: "Help", icon: "help", el: null, sel: "[onclick='mpHelpOpen()']",
      wasTip: "How this editor works",   // the text this replaces, on purpose
      tip: "Help centre — what every tool does. Search by name or in your own words.",
      body: "Opens this help centre. Search by the tool's name, by its symbol, or in plain words describing the problem rather than the term — \"two valves one station\" finds the right entry without you knowing what it is called.",
      isNot: "It is not a tutorial or a walkthrough. It answers \"what does this do\", one control at a time.",
      aliases: ["help", "what does this do", "i don't know", "manual", "search"],
      seeAlso: []
    },
    /* ---- panel actions ----------------------------------------------- */
    {
      id: "share-station", kind: "action", name: "Wire both valves to one station", icon: "station",
      tip: "Each valve has its own controller station. Wire them to one terminal instead if they should open together.",
      // The same control reads the other way once the valves are combined.
      tipOn: "Both valves are on one controller terminal and open together. Give each its own station to run them separately.",
      labelOff: "wire both valves to one station",
      labelOn: "give each valve its own station",
      body: "Puts the two halves of a split onto ONE controller station. Both valves are wired to the same terminal, so they open at the same time and their flow adds up.\n\nUse it when a split was only ever about pipework — two valve boxes because the driveway is in the way — and the two halves are really one watering zone.\n\nIt appears on either half of a split, in the zone panel. Once wired together, the same link reads \"give each valve its own station\" and puts them back.",
      isNot: "It does NOT make them run one after the other. They open together, simultaneously, and the station's flow is the sum of both valves. If your supply is tight, check that total before wiring them.",
      aliases: ["consecutively", "together", "one station", "two valves one station", "combine", "join", "wired together", "same terminal", "at the same time", "run together", "share"],
      seeAlso: ["split", "shared-station", "station-vs-valve-vs-area", "peak-flow"]
    },
    {
      id: "one-valve-per-box", kind: "action", name: "One valve per box", icon: "manifold",
      tip: "One valve per valve box, wired as one station — then put each bed in the box it should be fed from",
      body: "For a grouped zone — several drip beds on one valve — this gives each box its own valve while keeping them on one controller station. You then send each bed to the box it should really be fed from.",
      isNot: "Not the same as Split zone. Splitting cuts one area in two and gives each half its own station; this keeps one station and separates the plumbing.",
      aliases: ["per box", "grouped", "drip beds", "separate the boxes", "one per box"],
      seeAlso: ["split", "share-station", "manifold", "drip-bed"]
    },
    {
      id: "remove-split", kind: "action", name: "Remove split", icon: "trash",
      tip: "Remove this split and put the zone back together as one valve.",
      body: "Undoes a split. The two halves become one valve again on one station.",
      isNot: "It does not delete heads, trees or the area — only the split line and the second valve.",
      aliases: ["undo split", "put it back", "unsplit", "remove split", "one valve again"],
      seeAlso: ["split", "share-station"]
    },
    {
      id: "print-zone-sheets", kind: "action", name: "Print all zone sheets", icon: "sheet",
      tip: "Every valve on this sheet, one page each, in station order — the pipe layout for the sub as one PDF",
      body: "One page per valve, in station order, as a single PDF — the box, the pipe with its sizes and lengths, and every head with its model and arc, over a faded plan. This is the set you hand a sub.",
      isNot: "Not the proposal and not the material list. This is the installation drawing.",
      aliases: ["print", "pdf", "for the sub", "installer", "drawings", "zone sheets", "hand off"],
      seeAlso: ["sheet-measurements", "layer-eye"]
    },
    {
      id: "layer-eye", kind: "action", name: "Show or hide a zone", icon: "latlayer",
      tip: "Show/hide this zone · Alt-click to solo",
      body: "The eye beside each valve in the Layers panel hides that zone from the drawing. Alt-click an eye to show that zone by itself and hide everything else.",
      isNot: "Hiding a zone does not remove it from the design, the counts or the material list. It only clears the view.",
      aliases: ["eye", "hide", "show", "solo", "only this zone", "too busy"],
      seeAlso: ["laterals-layer", "wire-layer"]
    },
    {
      id: "back-to-auto", kind: "action", name: "Back to auto route", icon: "autoroute",
      tip: "Discard the hand-drawn lateral and put this zone's pipe back the way the builder routes it.",
      body: "Throws away a hand-drawn lateral for this zone and returns it to the automatic route.",
      isNot: "Only affects the selected zone's lateral. The mainline and every other zone are untouched.",
      aliases: ["undo my pipe", "auto again", "reset the pipe", "start the pipe over"],
      seeAlso: ["lat", "lateral-concept"]
    },
    /* ---- concepts ---------------------------------------------------- */
    {
      id: "station-vs-valve-vs-area", kind: "concept", name: "Station vs valve vs area", icon: "station",
      tip: null,
      body: "Three different counts, and they are rarely the same number. The header prints all three.\n\nA CONTROLLER STATION is one programmed output — one terminal on the controller, one entry in the watering schedule.\n\nA PHYSICAL VALVE is a box, a solenoid and a lateral run. Two valves CAN share one station, and then they open together.\n\nA DESIGNED AREA is one traced piece of landscape. One area can end up as two valves if you split it, and several drip beds can end up grouped onto one valve.\n\nSo \"12 stations · 16 valves · 19 areas\" is not a contradiction. It means 19 traced areas, plumbed as 16 valves, running off 12 terminals on the controller.",
      isNot: "None of these is a \"zone\". That word gets used for all three on site, which is exactly why the builder stopped printing one number and calling it the zone count.",
      aliases: ["zone", "zines", "zone count", "13 stations", "why three numbers", "counts", "header numbers", "vowels", "valves", "stations", "areas", "doesn't add up"],
      seeAlso: ["shared-station", "header-counts", "split"]
    },
    {
      id: "what-splitting-does", kind: "concept", name: "What splitting does to your station count", icon: "split",
      tip: null,
      body: "A NEW SPLIT GIVES YOU TWO SEPARATE CONTROLLER STATIONS. One area becomes two valves AND two terminals, so your station count goes up by one and your valve count goes up by two.\n\nThat is the right default for most splits: a lawn either side of a driveway usually wants to water independently.\n\nIt is the wrong default when the split was only about pipework and the two halves are really one watering zone — trees at both ends of a property on one controller terminal. For those, wire both valves back to one station afterwards, and the station count drops by one again.\n\nOlder designs behave the opposite way. Anything drawn before this setting existed defaults to SHARING one station, because that was the only thing the builder could do.",
      isNot: "Splitting does not wire the halves together, whatever older help text said. That was wrong for months and is the reason this help centre was built.",
      aliases: ["why did my station count go up", "13 stations", "12 stations", "extra station", "split added a station", "count changed", "why two stations"],
      seeAlso: ["split", "share-station", "legacy-assumed", "station-vs-valve-vs-area"]
    },
    {
      id: "shared-station", kind: "concept", name: "Shared station — two valves, one terminal", icon: "station",
      tip: null,
      body: "Two valves wired to one controller terminal. The controller opens them together, at the same time, as a single station in the schedule.\n\nBecause they open together, THE STATION'S FLOW IS THE SUM OF BOTH VALVES. Two halves at 1.4 and 0.6 GPM make a 2.0 GPM station. Check that total against your available supply before combining anything substantial.\n\nOn the master plan the two show under one heading reading \"2 valves, one station\".",
      isNot: "Not the same as running back-to-back. Consecutive means one finishes and the next starts, and their flows never add. A shared station is simultaneous, and the flows do add.",
      aliases: ["consecutively", "together", "at the same time", "simultaneous", "one terminal", "two valves one station", "combine", "2 valves one station", "run together"],
      seeAlso: ["share-station", "peak-flow", "what-splitting-does"]
    },
    {
      id: "legacy-assumed", kind: "concept", name: "Legacy-assumed shared", icon: "clock",
      tip: null,
      body: "Before the one-station-or-two setting existed, EVERY split behaved as one shared station. There was no choice to record.\n\nSo a design drawn before that change still loads with its splits sharing a station — nothing about those jobs has moved. But \"unchanged\" there means \"still carrying an assumption nobody actually made\", which is why they are labelled LEGACY-ASSUMED rather than treated as decided.\n\nThe audit lists them: run it and confirm each one deliberately. Jobs with an accepted proposal are worth deciding carefully.",
      isNot: "It is not a fault and not a change to your job. It marks a question nobody was ever asked, not an error.",
      aliases: ["legacy", "old design", "old job", "assumed", "review required", "why is this flagged", "audit"],
      seeAlso: ["shared-station", "what-splitting-does"]
    },
    {
      id: "mainline-concept", kind: "concept", name: "Mainline", icon: "flow",
      tip: null,
      body: "The pipe from the point of connection out to the valve boxes. It is always under pressure, and it has to carry the flow of whichever station draws the most.",
      isNot: "Not a lateral. A lateral is downstream of one valve and carries only that valve's flow; the mainline carries whatever the busiest station needs.",
      aliases: ["main", "main line", "trunk", "supply pipe", "under pressure"],
      seeAlso: ["lateral-concept", "peak-flow", "mainline-held", "bend"]
    },
    {
      id: "lateral-concept", kind: "concept", name: "Lateral", icon: "lat",
      tip: null,
      body: "The pipe from one valve out to that valve's heads, beds or trees. Only under pressure while its valve is open, and only ever carries that valve's flow. Every segment is sized on the flow actually passing through it, and the route follows the inside of the traced outline.",
      isNot: "Not the mainline, and not shared with any other valve.",
      aliases: ["lateral", "pipe to the heads", "zone pipe", "downstream"],
      seeAlso: ["mainline-concept", "lat", "sheet-measurements"]
    },
    {
      id: "mainline-held", kind: "concept", name: "Why the mainline size stops changing", icon: "flow",
      tip: null,
      body: "Once a mainline has been purchased, its size is HELD rather than recalculated. Changing stations afterwards cannot quietly reprint a different pipe size on a job where the pipe is already in the ground or already paid for.",
      isNot: "Not a bug and not a stale number. It is deliberate: the recalculated size would be a lie about what was actually installed.",
      aliases: ["mainline size", "why didn't the size change", "pipe size stuck", "purchased", "held"],
      seeAlso: ["mainline-concept", "peak-flow"]
    },
    {
      id: "peak-flow", kind: "concept", name: "Peak station flow", icon: "flow",
      tip: null,
      body: "The most water the system draws at once — the flow of whichever single station is the largest, since the controller runs one station at a time. That figure is what the mainline has to carry.\n\nA SHARED station counts as one station, so its two valves SUM. A separated split is two stations and each stands on its own.",
      isNot: "Not the total of every zone added up. Stations run one at a time, so the total across the whole system is never what the pipe has to carry.",
      aliases: ["gpm", "flow", "peak", "how much water", "available water", "supply", "too much flow"],
      seeAlso: ["shared-station", "mainline-concept", "station-vs-valve-vs-area"]
    },
    {
      id: "valve-concept", kind: "concept", name: "Valve", icon: "valve",
      tip: null,
      body: "One solenoid in one box feeding one lateral run. Opening it waters everything on that lateral.",
      isNot: "Not a station. A valve is hardware in the ground; a station is a terminal on the controller. Usually one each, but two valves can share one station.",
      aliases: ["valve", "vowel", "vowels", "solenoid", "zone valve"],
      seeAlso: ["station-vs-valve-vs-area", "manifold", "shared-station"]
    },
    {
      id: "station-concept", kind: "concept", name: "Controller station", icon: "station",
      tip: null,
      body: "One programmed output on the controller — one terminal, one line in the watering schedule. The station count decides which controller the job needs.",
      isNot: "Not a valve and not an area. Two valves can run off one station, and one traced area can end up spread across two.",
      aliases: ["station", "terminal", "controller", "output", "program", "schedule"],
      seeAlso: ["station-vs-valve-vs-area", "shared-station", "wire-layer"]
    },
    {
      id: "drip-bed", kind: "concept", name: "Drip bed", icon: "area",
      tip: null,
      body: "A planted bed on dripline rather than heads. Beds are counted in beds and feet of dripline, not head counts, and several beds are commonly grouped onto one valve.",
      isNot: "A bed has no heads, so a head count of zero on a drip zone is correct, not a fault.",
      aliases: ["drip", "bed", "beds", "dripline", "planting", "garden", "no heads"],
      seeAlso: ["one-valve-per-box", "head-concept"]
    },
    {
      id: "head-concept", kind: "concept", name: "Head", icon: "valve",
      tip: null,
      body: "One sprinkler — rotor, spray or strip — with a model, an arc and a throw. Heads can be laid out automatically or placed by hand, and a hand-placed layout is kept exactly as you put it.",
      isNot: "A tree is not a head and a drip bed has none. Those are counted in trees and beds instead.",
      aliases: ["head", "heads", "sprinkler", "rotor", "spray", "nozzle", "arc", "hand placed"],
      seeAlso: ["tree", "drip-bed", "header-counts"]
    },
    /* ---- readouts ---------------------------------------------------- */
    {
      id: "master-plan", kind: "concept", name: "What the master plan shows", icon: "area",
      tip: null,
      body: "Every area you have traced onto this sheet, at its true position, coloured by the valve it runs on.\n\nPick a tool on the left, then click the plan to place a point of connection, a manifold or a mainline bend. Drag any marker to move it; Delete removes the selected one. Click an area, head or lateral pipe to work on that valve by itself.",
      isNot: "It shows what is TRACED on this sheet. An area in the design that you have not traced yet does not appear here and is not counted in the numbers across the top.",
      aliases: ["master plan", "the sheet", "the drawing", "what am i looking at", "colours", "nothing traced", "empty"],
      seeAlso: ["pan", "header-counts", "layer-eye", "zoom-pan"]
    },
    {
      id: "header-counts", kind: "readout", name: "The numbers across the top", icon: "sheet",
      tip: null,
      body: "Areas, heads, drip beds, feet of dripline, valves and stations, for what is drawn on THIS sheet.\n\nValves and stations are printed separately and deliberately. Printing only one of them is how nobody could tell whether a job was an 11 or a 12 station job.",
      isNot: "These count what is traced on this sheet, not the whole project. An area you have not traced yet contributes nothing here.",
      aliases: ["header", "top of the screen", "numbers", "counts", "16 valves", "13 stations", "what do these numbers mean"],
      seeAlso: ["station-vs-valve-vs-area", "sheet-measurements"]
    },
    {
      id: "sheet-measurements", kind: "readout", name: "Where the lengths come from", icon: "sheet",
      tip: null,
      body: "Mainline, lateral and wire lengths are all measured off the calibrated sheet — the real distances on your plan, not estimates. Laterals follow the inside of each traced outline, and every segment is sized on the flow passing through it.",
      isNot: "Not a rule of thumb or a per-zone allowance. If the sheet's scale is wrong, every length is wrong, so calibrate before trusting a takeoff.",
      aliases: ["length", "footage", "how long", "measured", "scale", "calibrate", "takeoff", "how does it know"],
      seeAlso: ["lateral-concept", "mainline-concept"]
    },
    {
      id: "zoom-pan", kind: "readout", name: "Getting around the sheet", icon: "keyboard",
      tip: null,
      body: "Scroll or pinch to zoom. Ctrl-drag to pan. Hold H to flash the drawing off and see the plan underneath. Click bare ground to clear the selection and show everything again.",
      isNot: "None of this changes the design. They are view controls only.",
      aliases: ["zoom", "pan", "scroll", "move around", "can't see", "keyboard", "shortcuts", "hold h", "hide the drawing"],
      seeAlso: ["pan", "layer-eye"]
    }
  ];

  /* ── Search ───────────────────────────────────────────────────────────
     Patrick dictates, and the transcript is the evidence: he said "zine"
     for zone, "vowels" for valves, and — the one that matters — he used
     "consecutively" to mean "at the same time", which is the OPPOSITE of
     what the word means in irrigation. A matcher reasoning from the
     dictionary sends him to the wrong entry with total confidence.

     So the map is explicit and auditable rather than fuzzy. When a word
     comes back wrong the fix is one line here, not a re-tuned algorithm,
     and the gate test can prove each one still lands. */
  var SYNONYMS = {
    zine: "zone", zines: "zone", zone: "zone", zones: "zone",
    vowel: "valve", vowels: "valve", valves: "valve",
    stations: "station", areas: "area", heads: "head", trees: "tree",
    consecutively: "together", consecutive: "together",
    simultaneous: "together", simultaneously: "together",
    conjunction: "together", tandem: "together",
    combined: "combine", combining: "combine",
    splitting: "split", splits: "split",
    laterals: "lateral", manifolds: "manifold", boxes: "box",
    sprinklers: "sprinkler", pipes: "pipe", wires: "wire"
  };

  function norm(s) {
    return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
  }
  function expand(word) { return Object.prototype.hasOwnProperty.call(SYNONYMS, word) ? SYNONYMS[word] : word; }
  function tokens(s) { return norm(s).split(" ").filter(Boolean).map(expand); }

  /* Everything an entry can be found by, synonym-expanded once so the
     query and the corpus meet in the same vocabulary. */
  function haystack(e) {
    var parts = [e.name, e.name, e.name, (e.aliases || []).join(" "), e.tip || "", e.body || "", e.isNot || ""];
    return tokens(parts.join(" "));
  }
  var INDEX = null;
  function index() {
    if (!INDEX) INDEX = ENTRIES.map(function (e) { return { entry: e, words: haystack(e), name: tokens(e.name) }; });
    return INDEX;
  }

  /* Rank by how many of the query's words an entry accounts for, with a
     whole-phrase hit and a name hit weighted up. Around forty entries, so
     a linear scan is correct and instant; no search library, which also
     keeps the builder working with no internet (PRD R6). */
  function search(query) {
    var q = tokens(query);
    if (!q.length) return [];
    // Compare exact hits in the EXPANDED vocabulary, not the raw string:
    // "zine" has to satisfy the alias "zone" or the synonym map only half
    // works — the tokens expand but the whole-phrase match never fires.
    var phrase = q.join(" ");
    return index().map(function (row) {
        var score = 0, i, j;
        for (i = 0; i < q.length; i++) {
          var hitName = false, hit = false;
          for (j = 0; j < row.name.length; j++) if (row.name[j] === q[i]) { hitName = true; break; }
          for (j = 0; j < row.words.length; j++) if (row.words[j] === q[i]) { hit = true; break; }
          if (hitName) score += 6; else if (hit) score += 2;
        }
        if (row.name.join(" ") === phrase) score += 40;
        (row.entry.aliases || []).forEach(function (a) { if (tokens(a).join(" ") === phrase) score += 20; });
        if (row.words.join(" ").indexOf(q.join(" ")) >= 0 && q.length > 1) score += 8;
        return { entry: row.entry, score: score };
      })
      .filter(function (r) { return r.score > 0; })
      .sort(function (a, b) { return b.score - a.score || a.entry.name.localeCompare(b.entry.name); })
      .map(function (r) { return r.entry; });
  }

  function byId(id) {
    for (var i = 0; i < ENTRIES.length; i++) if (ENTRIES[i].id === id) return ENTRIES[i];
    return null;
  }
  /* THE tooltip for a control. The page calls this instead of carrying a
     string of its own — that is the whole point of the file. */
  function tip(id) { var e = byId(id); return e && e.tip ? e.tip : ""; }
  function name(id) { var e = byId(id); return e ? e.name : ""; }
  /* What a screen reader announces. Defaults to the heading, but a control
     whose accessible name was already good keeps it verbatim. */
  function aria(id) { var e = byId(id); return e ? (e.aria || e.name) : ""; }
  function icon(key) { return ICONS[key] || ""; }
  function svg(key, cls) {
    return '<svg viewBox="0 0 24 24"' + (cls ? ' class="' + cls + '"' : "") + ">" + icon(key) + "</svg>";
  }
  function byKind(kind) { return ENTRIES.filter(function (e) { return e.kind === kind; }); }

  return {
    ENTRIES: ENTRIES, ICONS: ICONS, SYNONYMS: SYNONYMS,
    search: search, byId: byId, tip: tip, name: name, aria: aria,
    icon: icon, svg: svg, byKind: byKind
  };
}));
